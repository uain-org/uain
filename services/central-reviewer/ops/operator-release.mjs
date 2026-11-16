#!/usr/bin/env node
/**
 * Audited operator release of a provider-phase uncertain central-review job.
 *
 * The worker (src/worker.mjs) never retries a job that ended `uncertain` while
 * its phase was `provider` (`provider_outcome_unknown`, `invalid_provider_decision`,
 * or `process_interrupted` before the provider answered). Such a job made no
 * custody call: `phase` becomes `custody` and is saved before custody is called.
 * Its native submission therefore stays `under_review` with no verdict, and the
 * task and its reservation stay locked (audit 9 November 2026, 08, defect 5).
 *
 * This is the explicit, offline release. For each planned job it checks the exact
 * state, phase, reason and execution id, and that no decision, command or receipt
 * exists; then it re-queues the job with a fresh execution id, exactly like the
 * worker's own re-queue paths, and records the released execution in
 * `operator_releases` (never in `history`, which the worker reserves for decided
 * executions). The next worker cycle reviews it again within its normal attempt
 * budget. Nothing is deleted; a custody-phase job is refused (the worker reconciles
 * those itself from the custody receipt).
 *
 * It takes the worker's own flock on `<store>/lock`, so it refuses while
 * uain-central-reviewer.service runs. Procedure: stop the service, back up,
 * dry run, apply (with --backup), start the service, check review health.
 *
 *   node operator-release.mjs --store /var/lib/uain-central-reviewer --plan plan.json
 *   node operator-release.mjs --store ... --plan plan.json --apply --backup /root/<audit>/jobs.json.before
 *
 * Run it as the store owner (uain-central-reviewer). plan.json:
 *   {"reason":"…","jobs":[{"submission":"CS-…","expectExecutionId":"<uuid>",
 *     "expectReason":"provider_outcome_unknown","evidence":{"name":"<64 hex>"}}]}
 */
import { constants } from 'node:fs';
import { lstat, open, readFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { acquireWorkerLock } from '../src/lock.mjs';

// provider_attempts_exhausted (12 November 2026): a job that used its whole attempt bound after
// repeated provider timeouts. Releasing it starts a fresh attempt count; the lineage's daily bound
// still applies, so it is tried again within that day's remaining share or the next UTC day.
export const PROVIDER_REASONS = Object.freeze(['provider_outcome_unknown', 'invalid_provider_decision', 'process_interrupted', 'provider_attempts_exhausted']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[a-f0-9]{64}$/;
const MAX_RELEASES = 4;
const fail = (message) => { throw Object.assign(new Error('operator_release_' + message), { code: 'operator_release_refused' }); };
const check = (ok, message) => { if (!ok) fail(message); };
export const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function validatePlan(plan) {
  check(plan && typeof plan.reason === 'string' && plan.reason.length >= 10 && plan.reason.length <= 2000, 'plan');
  check(Array.isArray(plan.jobs) && plan.jobs.length >= 1 && plan.jobs.length <= 8, 'plan_jobs');
  check(new Set(plan.jobs.map((j) => j.submission)).size === plan.jobs.length, 'plan_duplicate');
  for (const j of plan.jobs) {
    check(ID.test(j.submission ?? '') && UUID.test(j.expectExecutionId ?? '') && PROVIDER_REASONS.includes(j.expectReason), 'plan_job');
    check(j.evidence && typeof j.evidence === 'object' && Object.keys(j.evidence).length >= 1 && Object.values(j.evidence).every((v) => HASH.test(v)), 'plan_evidence');
  }
  return plan;
}

/** Mutates db like the worker's own re-queue, after checking every expectation. */
export function release(db, plan, { now = new Date().toISOString(), newId = randomUUID } = {}) {
  validatePlan(plan);
  check(db && db.version === 1 && db.jobs && typeof db.jobs === 'object', 'store_shape');
  const changes = [];
  for (const want of plan.jobs) {
    const job = db.jobs[want.submission];
    check(job && job.submission === want.submission, 'job_missing ' + want.submission);
    check(job.state === 'uncertain', 'state_changed ' + want.submission + ' ' + job.state);
    check(job.phase === 'provider', 'not_provider_phase ' + want.submission + ' ' + job.phase);
    check(job.reason === want.expectReason, 'reason_changed ' + want.submission + ' ' + job.reason);
    check(job.execution_id === want.expectExecutionId, 'execution_changed ' + want.submission);
    // Provider phase means custody was never called; a decision, command or receipt would contradict that.
    check(!job.decision && !job.command && !job.receipt, 'custody_material_present ' + want.submission);
    const prior = job.operator_releases ?? [];
    check(Array.isArray(prior) && prior.length < MAX_RELEASES, 'release_limit ' + want.submission);
    const before = structuredClone(job);
    const entry = { execution_id: job.execution_id, reason: job.reason, released_at: now, operator_reason: plan.reason, evidence: structuredClone(want.evidence), ...(job.provider_attempts ? { provider_attempts: structuredClone(job.provider_attempts) } : {}) };
    job.operator_releases = [...prior, entry];
    if (job.provider_attempts) job.provider_attempts = { ...job.provider_attempts, total: 0 };
    delete job.timeouts; delete job.last_timeout_at;
    job.execution_id = newId();
    job.state = 'queued';
    job.phase = 'provider';
    delete job.reason; delete job.blocked_reason; delete job.operational_error;
    changes.push({ submission: want.submission, releasedExecution: entry.execution_id, newExecution: job.execution_id, beforeDigest: sha(before), afterDigest: sha(job) });
  }
  return changes;
}

export async function readStore(file) {
  const st = await lstat(file);
  check(st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077) && st.size <= 64 * 1024 * 1024, 'store_file');
  const raw = await readFile(file, 'utf8');
  return { raw, db: JSON.parse(raw) };
}

export async function writeExclusive(path, text) {
  const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await f.writeFile(text); await f.sync(); } finally { await f.close(); }
}

/** The worker's own save: temp file, fsync, rename, directory fsync. */
export async function saveStore(directory, db) {
  const temp = join(directory, 'jobs.' + randomUUID() + '.tmp');
  await writeExclusive(temp, JSON.stringify(db));
  await rename(temp, join(directory, 'jobs.json'));
  const d = await open(directory, 'r');
  try { await d.sync(); } finally { await d.close(); }
}

export async function operatorRelease({ store, plan, apply = false, backup = null, acquireLock = acquireWorkerLock, now, newId } = {}) {
  check(isAbsolute(store ?? '') && (!apply || isAbsolute(backup ?? '')), 'paths');
  validatePlan(plan);
  const dir = await lstat(store);
  check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid() && !(dir.mode & 0o077), 'store_directory');
  const lockPath = join(store, 'lock');
  const lock = await open(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
  let unlock;
  try {
    try { unlock = await acquireLock(lock, lockPath); } catch { fail('store_busy (stop uain-central-reviewer.service first)'); }
    const file = join(store, 'jobs.json');
    const { raw, db } = await readStore(file);
    const report = { schema: 'uain-central-review-operator-release-v1', apply, store, storeDigestBefore: sha(raw) };
    const draft = structuredClone(db);
    report.changes = release(draft, plan, { now, newId });
    if (apply) {
      await writeExclusive(backup, raw);
      report.backup = backup; report.backupDigest = sha(await readFile(backup, 'utf8'));
      check(report.backupDigest === report.storeDigestBefore, 'backup_mismatch');
      await saveStore(store, draft);
      report.storeDigestAfter = sha(await readFile(file, 'utf8'));
    }
    return report;
  } finally {
    await unlock?.();
    await lock.close();
  }
}

async function main(argv) {
  const o = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (['--store', '--plan', '--backup'].includes(a)) { check(argv[i + 1] && !o[a.slice(2)], 'argument ' + a); o[a.slice(2)] = argv[++i]; }
    else fail('argument ' + a);
  }
  check(isAbsolute(o.plan ?? ''), 'plan path');
  const plan = JSON.parse(await readFile(o.plan, 'utf8'));
  return operatorRelease({ store: o.store, plan, apply: o.apply, backup: o.backup ?? null });
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((r) => process.stdout.write(JSON.stringify(r, null, 1) + '\n'),
    (e) => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
}
