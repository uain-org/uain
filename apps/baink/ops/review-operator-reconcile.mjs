#!/usr/bin/env node
/** Audited operator reconciliation of dead public-review gateway jobs.
 *
 * The gateway README says running/uncertain jobs "need explicit operator
 * reconciliation; no automated reset is provided". This is that explicit,
 * offline step. It mirrors the code's own owner abandon path
 * (review-service/gateway.mjs `abandon`): a pending operation becomes
 * status 'cancelled' with cancelledAt, and the job becomes phase 'abandoned'
 * with pending null and abandonedAt. It adds one note, job.operatorReconciliation,
 * with the time, reason, prior phase/pending and evidence digests. Nothing is
 * deleted; the adapter store, vault and root custody records are untouched.
 *
 * It opens the store through the DEPLOYED release's openReviewStore, so it
 * takes the same flock on writer.lock and commits through the same group-commit
 * transaction (atomic rename + fsync). While baink.service runs it holds that
 * lock and caches the store in memory, so this refuses with review_store_busy:
 * stop the service, run this as the store owner (baink), then start it.
 *
 * Usage (dry run unless --apply):
 *   node review-operator-reconcile.mjs --release /opt/baink/current \
 *     --store /var/lib/baink/public-review/gateway --plan plan.json [--apply]
 * plan.json: {"owner":"uain1…","reason":"…","jobs":[{"id":"<32 hex>",
 *   "expectPhase":"…","expectPending":"<32 hex>|null",
 *   "expectPendingStatus":"…|null","evidence":{"name":"<64 hex>",…}}]}
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

const TERMINAL = ['reconciled', 'refused', 'owned-approved', 'abandoned'];
const ID = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/, OWNER = /^uain1[a-f0-9]{40}$/;
const fail = message => { throw Error('operator_reconcile_' + message); };
const check = (ok, message) => { if (!ok) fail(message); };
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function args(argv) {
  const out = {apply: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (['--release', '--store', '--plan'].includes(a)) out[a.slice(2)] = argv[++i];
    else fail('argument ' + a);
  }
  check(isAbsolute(out.release ?? '') && isAbsolute(out.store ?? '') && isAbsolute(out.plan ?? ''), 'paths');
  return out;
}

export function validatePlan(plan) {
  check(plan && OWNER.test(plan.owner ?? '') && typeof plan.reason === 'string' && plan.reason.length >= 10 && plan.reason.length <= 2000, 'plan');
  check(Array.isArray(plan.jobs) && plan.jobs.length >= 1 && plan.jobs.length <= 8, 'plan_jobs');
  check(new Set(plan.jobs.map(j => j.id)).size === plan.jobs.length, 'plan_duplicate');
  for (const j of plan.jobs) {
    check(ID.test(j.id ?? '') && typeof j.expectPhase === 'string' && !TERMINAL.includes(j.expectPhase), 'plan_job');
    check(j.expectPending === null || ID.test(j.expectPending ?? ''), 'plan_pending');
    check((j.expectPending === null) === (j.expectPendingStatus === null), 'plan_pending_status');
    check(j.evidence && typeof j.evidence === 'object' && Object.keys(j.evidence).length >= 1 && Object.values(j.evidence).every(v => HASH.test(v)), 'plan_evidence');
  }
  return plan;
}

export const activeFor = (db, owner) => Object.values(db.jobs ?? {}).filter(j => j.owner === owner && !TERMINAL.includes(j.phase)).map(j => j.id);

/** Mutates db exactly like gateway.abandon, after checking every expectation. */
export function reconcile(db, plan, now) {
  validatePlan(plan);
  check(db.jobs && db.operations, 'store_shape');
  const changes = [];
  for (const want of plan.jobs) {
    const job = db.jobs[want.id];
    check(job && job.id === want.id && job.owner === plan.owner, 'job_missing ' + want.id);
    check(job.phase === want.expectPhase, 'phase_changed ' + want.id + ' ' + job.phase);
    check(job.pending === want.expectPending, 'pending_changed ' + want.id);
    const ops = Object.values(db.operations).filter(o => o.jobId === want.id);
    // A relay request or any live executor work means this is not a dead job.
    check(!ops.some(o => o.action === 'relay' || o.action === 'reconcile'), 'relay_present ' + want.id);
    check(!ops.some(o => ['staging', 'queued', 'running'].includes(o.status) && o.id !== job.pending), 'live_operation ' + want.id);
    const op = job.pending ? db.operations[job.pending] : null;
    if (job.pending) check(op && op.jobId === want.id && op.status === want.expectPendingStatus && ['uncertain', 'queued', 'staging'].includes(op.status), 'pending_status ' + want.id);
    const before = {job: structuredClone(job), op: op ? structuredClone(op) : null};
    if (op) { op.status = 'cancelled'; op.cancelledAt = now; }
    job.phase = 'abandoned'; job.pending = null; job.abandonedAt = now;
    job.operatorReconciliation = {
      at: new Date(now).toISOString(),
      reason: plan.reason,
      previousPhase: before.job.phase,
      previousPending: before.job.pending,
      settledOperation: op ? {id: op.id, action: op.action, previousStatus: before.op.status, status: 'cancelled'} : null,
      evidence: structuredClone(want.evidence),
    };
    changes.push({jobId: want.id, beforeDigest: sha(before), afterDigest: sha({job, op})});
  }
  return changes;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const plan = validatePlan(JSON.parse(await readFile(opts.plan, 'utf8')));
  const {openReviewStore} = await import(pathToFileURL(join(opts.release, 'server', 'review-store.mjs')).href);
  // Takes writer.lock exactly as the service does; refuses while it runs.
  const store = await openReviewStore(opts.store);
  try {
    const initial = store.read();
    const report = {schema: 'baink-review-operator-reconcile-v1', apply: opts.apply, store: opts.store,
      storeDigestBefore: sha(initial), activeBefore: activeFor(initial, plan.owner)};
    if (!opts.apply) {
      const draft = structuredClone(initial);
      report.changes = reconcile(draft, plan, Date.now());
      report.activeAfter = activeFor(draft, plan.owner);
    } else {
      report.changes = await store.transact(db => reconcile(db, plan, Date.now()));
      const after = store.read();
      report.storeDigestAfter = sha(after);
      report.activeAfter = activeFor(after, plan.owner);
    }
    process.stdout.write(JSON.stringify(report, null, 1) + '\n');
  } finally {
    await store.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
