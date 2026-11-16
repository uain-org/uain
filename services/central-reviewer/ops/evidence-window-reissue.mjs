#!/usr/bin/env node
/**
 * Audited one-off re-review of central-review jobs whose needs_evidence verdict
 * was recorded before the S6 evidence window was active (10 November 2026).
 *
 * A needs_evidence recorded before `central_evidence_activation` carries no
 * native `evidence_deadline`, and the chain gives it none afterwards. Without a
 * deadline the author can neither revise nor ask for a reassessment, and nobody
 * can expire the request, so the task and its reservation stay locked
 * (remaining_work.md, "Four native submissions wait on a signed needs-evidence
 * answer with no deadline"). The chain itself allows the way out: once the
 * window is active, a NEW central_review (new execution id) on the same
 * submission may record needs_evidence again, and that one gets a deadline,
 * because the submission still has none, is not a revision and asked for no
 * reassessment (chain/federation/central_earning.go, central_review). It may
 * equally record accept or reject.
 *
 * This tool only re-queues each planned job for a fresh review of the same,
 * unchanged evidence, exactly like the worker's own re-review paths: the
 * decided execution (decision, command, receipt) moves into `history` with
 * reason `evidence-window-reissue`, the job gets a new execution id and
 * `state: queued`, `phase: provider`. The next worker cycle reviews it within
 * its normal attempt budget and custody checks. Nothing is deleted.
 *
 * Run it only after the activation height has passed, or the new review would
 * again carry no deadline. It takes the worker's own flock, so it refuses while
 * uain-central-reviewer.service runs. Procedure: stop the service, dry run,
 * apply (with --backup), start the service, then read each submission's
 * native record for a review with a deadline (or a final verdict).
 *
 *   node evidence-window-reissue.mjs --store /var/lib/uain-central-reviewer --plan plan.json
 *   node evidence-window-reissue.mjs --store ... --plan plan.json --apply --backup /root/<audit>/jobs.json.before
 *
 * Run it as the store owner (uain-central-reviewer). plan.json:
 *   {"reason":"…","activation":{"height":"<decimal>","evidenceDigest":"<64 hex>"},
 *    "jobs":[{"submission":"CS-…","expectExecutionId":"<uuid>","evidence":{"name":"<64 hex>"}}]}
 */
import { constants, realpathSync } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWorkerLock } from '../src/lock.mjs';
import { readStore, saveStore, sha, writeExclusive } from './operator-release.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[a-f0-9]{64}$/, HEIGHT = /^[1-9][0-9]{0,18}$/;
export const REISSUE_REASON = 'evidence-window-reissue';
const fail = (message) => { throw Object.assign(new Error('evidence_reissue_' + message), { code: 'evidence_reissue_refused' }); };
const check = (ok, message) => { if (!ok) fail(message); };

export function validatePlan(plan) {
  check(plan && typeof plan.reason === 'string' && plan.reason.length >= 10 && plan.reason.length <= 2000, 'plan');
  check(plan.activation && HEIGHT.test(plan.activation.height ?? '') && HASH.test(plan.activation.evidenceDigest ?? ''), 'plan_activation');
  check(Array.isArray(plan.jobs) && plan.jobs.length >= 1 && plan.jobs.length <= 16, 'plan_jobs');
  check(new Set(plan.jobs.map((j) => j.submission)).size === plan.jobs.length, 'plan_duplicate');
  for (const j of plan.jobs) {
    check(ID.test(j.submission ?? '') && UUID.test(j.expectExecutionId ?? ''), 'plan_job');
    check(j.evidence && typeof j.evidence === 'object' && Object.keys(j.evidence).length >= 1 && Object.values(j.evidence).every((v) => HASH.test(v)), 'plan_evidence');
  }
  return plan;
}

/** Mutates db like the worker's own re-review paths, after checking every expectation. */
export function reissue(db, plan, { now = new Date().toISOString(), newId = randomUUID } = {}) {
  validatePlan(plan);
  check(db && db.version === 1 && db.jobs && typeof db.jobs === 'object', 'store_shape');
  const changes = [];
  for (const want of plan.jobs) {
    const job = db.jobs[want.submission];
    check(job && job.submission === want.submission, 'job_missing ' + want.submission);
    check(job.state === 'awaiting_evidence', 'state_changed ' + want.submission + ' ' + job.state);
    check(job.execution_id === want.expectExecutionId, 'execution_changed ' + want.submission);
    // Exactly one decided needs_evidence execution, finalized on chain, never re-reviewed or reassessed.
    check(job.decision?.verdict === 'needs_evidence' && job.command?.payload?.verdict === 'needs_evidence' && job.decision.execution_id === job.execution_id && job.command.payload.execution_id === job.execution_id, 'not_needs_evidence ' + want.submission);
    check(job.receipt?.verified === true && job.assignment?.submission === want.submission, 'receipt_missing ' + want.submission);
    check(!job.history?.length && !job.rereview_count && !job.reassessed && !job.evidence_window_reissue && !job.required_attestation_digest, 'already_re_reviewed ' + want.submission);
    const before = structuredClone(job);
    const history = { execution_id: job.execution_id, decision: structuredClone(job.decision), command: structuredClone(job.command), receipt: structuredClone(job.receipt), assignment: structuredClone(job.assignment), attestation_digest: job.attestation_digest ?? null, trusted_reproduction: job.trusted_reproduction ?? null, ...(job.trusted_verification ? { trusted_verification: structuredClone(job.trusted_verification) } : {}), reason: REISSUE_REASON };
    job.history = [history];
    job.evidence_window_reissue = { at: now, operator_reason: plan.reason, activation: structuredClone(plan.activation), evidence: structuredClone(want.evidence) };
    job.execution_id = newId();
    job.state = 'queued';
    job.phase = 'provider';
    delete job.decision; delete job.command; delete job.receipt; delete job.reason; delete job.blocked_reason; delete job.operational_error;
    changes.push({ submission: want.submission, reissuedFrom: history.execution_id, newExecution: job.execution_id, beforeDigest: sha(before), afterDigest: sha(job) });
  }
  return changes;
}

export async function evidenceWindowReissue({ store, plan, apply = false, backup = null, acquireLock = acquireWorkerLock, now, newId } = {}) {
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
    const report = { schema: 'uain-central-review-evidence-reissue-v1', apply, store, storeDigestBefore: sha(raw) };
    const draft = structuredClone(db);
    report.changes = reissue(draft, plan, { now, newId });
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
  return evidenceWindowReissue({ store: o.store, plan, apply: o.apply, backup: o.backup ?? null });
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((r) => process.stdout.write(JSON.stringify(r, null, 1) + '\n'),
    (e) => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
}
