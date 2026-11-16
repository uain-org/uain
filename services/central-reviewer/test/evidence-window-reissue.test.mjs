// FICTIONAL local worker fixtures only: no native node, keys, signing or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorker, canonical, digest } from '../src/worker.mjs';
import { evidenceWindowReissue, reissue, validatePlan, REISSUE_REASON } from '../ops/evidence-window-reissue.mjs';
import { sha } from '../ops/operator-release.mjs';
import { acquireTestLock } from './test-lock.mjs';

const evidence = Buffer.from('FICTIONAL fixed submission evidence');
const assignment = { submission: 'S-reissue', task: 'T-reissue', reviewer: 'reviewer', author: 'solver', criteria: 'Check the fixed fictional evidence',
  criteria_digest: digest(Buffer.from('Check the fixed fictional evidence')), evidence_digest: digest(evidence), proof: { verified: true }, state: 'under_review' };
const lockOpt = process.platform === 'linux' ? {} : { acquireLock: acquireTestLock };
const activation = { height: '1500000', evidenceDigest: 'b'.repeat(64) };

async function fixture(t, verdicts) {
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-reissue-fixture-'));
  let providerCalls = 0, custodyCalls = 0; const inputs = [], commands = [], record = { ...assignment };
  const deps = { directory, reviewer: 'reviewer', ...lockOpt,
    source: { read: async () => structuredClone(record), fetchEvidence: async () => ({ bytes: evidence, owner: 'solver', digest: assignment.evidence_digest, immutable: true, authenticated: true }) },
    provider: { assess: async (input) => { inputs.push(structuredClone(input)); return { verdict: verdicts[providerCalls++], findings: ['FICTIONAL finding'] }; } },
    custody: { submitCentralReview: async (body) => { custodyCalls++; commands.push(structuredClone(body.command));
      return { verified: true, status: 'finalized', executionId: body.executionId, commandDigest: digest(Buffer.from(canonical(body.command))), decisionDigest: body.command.payload.verification_digest }; } } };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, deps, record, inputs, commands, counts: () => ({ providerCalls, custodyCalls }) };
}
const planFor = (job) => ({ reason: 'FICTIONAL re-review of a needs_evidence recorded before the evidence window', activation, jobs: [{ submission: job.submission, expectExecutionId: job.execution_id, evidence: { store: 'a'.repeat(64) } }] });

test('a pre-window needs_evidence is re-queued once, re-reviewed with a new execution, and reassessment still works', async (t) => {
  const f = await fixture(t, ['needs_evidence', 'needs_evidence', 'accept']);
  let worker = await openWorker(f.deps);
  await worker.enqueue(assignment.submission);
  const asked = await worker.run(assignment.submission);
  assert.equal(asked.state, 'awaiting_evidence');
  // The worker alone never reviews it again.
  assert.equal((await worker.run(assignment.submission)).state, 'awaiting_evidence');
  assert.equal(f.counts().providerCalls, 1);
  await assert.rejects(evidenceWindowReissue({ store: f.directory, plan: planFor(asked), ...lockOpt }), /store_busy/);
  await worker.close();

  const before = await readFile(join(f.directory, 'jobs.json'), 'utf8');
  const dry = await evidenceWindowReissue({ store: f.directory, plan: planFor(asked), ...lockOpt });
  assert.equal(dry.apply, false); assert.equal(dry.changes.length, 1);
  assert.equal(await readFile(join(f.directory, 'jobs.json'), 'utf8'), before);
  const backup = join(f.directory, '..', 'reissue-backup-' + process.pid + '-' + Date.now() + '.json');
  t.after(() => rm(backup, { force: true }));
  const applied = await evidenceWindowReissue({ store: f.directory, plan: planFor(asked), apply: true, backup, ...lockOpt });
  assert.equal(applied.backupDigest, sha(before));
  await assert.rejects(evidenceWindowReissue({ store: f.directory, plan: planFor(asked), apply: true, backup: backup + '.2', ...lockOpt }), /state_changed/);

  worker = await openWorker(f.deps);
  t.after(() => worker.close());
  const queued = worker.status(assignment.submission);
  assert.equal(queued.state, 'queued'); assert.notEqual(queued.execution_id, asked.execution_id);
  assert.equal(queued.history.length, 1); assert.equal(queued.history[0].reason, REISSUE_REASON);
  assert.equal(queued.history[0].execution_id, asked.execution_id); assert.deepEqual(queued.history[0].receipt, asked.receipt);
  // The fresh review may ask again: a new central_review with a new execution id (on chain it now gets a deadline).
  const again = await worker.run(assignment.submission);
  assert.equal(again.state, 'awaiting_evidence'); assert.equal(again.decision.execution_id, queued.execution_id);
  assert.equal(f.commands[1].payload.execution_id, queued.execution_id); assert.equal(f.commands[1].payload.verdict, 'needs_evidence');
  assert.notEqual(f.commands[1].payload.execution_id, f.commands[0].payload.execution_id);
  // The author asks for one reassessment: the worker's own S6 path reviews once more and must decide.
  f.record.reassess = true;
  const decided = await worker.run(assignment.submission);
  assert.equal(decided.state, 'completed'); assert.equal(decided.decision.verdict, 'accept');
  assert.equal(decided.history.length, 2); assert.equal(decided.history[1].reason, 'reassessment');
  assert.deepEqual(f.counts(), { providerCalls: 3, custodyCalls: 3 });
});

test('only a finalized, never re-reviewed needs_evidence job with the expected execution is re-queued', async (t) => {
  const f = await fixture(t, ['needs_evidence']);
  const worker = await openWorker(f.deps);
  await worker.enqueue(assignment.submission);
  const asked = await worker.run(assignment.submission);
  await worker.close();
  const db = JSON.parse(await readFile(join(f.directory, 'jobs.json'), 'utf8'));
  const mutate = (fn) => { const copy = structuredClone(db); fn(copy.jobs[asked.submission]); return copy; };
  assert.throws(() => reissue(structuredClone(db), { ...planFor(asked), jobs: [{ ...planFor(asked).jobs[0], expectExecutionId: '00000000-0000-4000-8000-000000000000' }] }), /execution_changed/);
  assert.throws(() => reissue(mutate((j) => { j.state = 'completed'; }), planFor(asked)), /state_changed/);
  assert.throws(() => reissue(mutate((j) => { j.decision.verdict = 'reject'; }), planFor(asked)), /not_needs_evidence/);
  assert.throws(() => reissue(mutate((j) => { delete j.receipt; }), planFor(asked)), /receipt_missing/);
  for (const field of [['history', [{}]], ['rereview_count', 1], ['reassessed', true], ['evidence_window_reissue', {}], ['required_attestation_digest', 'c'.repeat(64)]])
    assert.throws(() => reissue(mutate((j) => { j[field[0]] = field[1]; }), planFor(asked)), /already_re_reviewed/, field[0]);
  assert.throws(() => reissue(structuredClone(db), { ...planFor(asked), jobs: [{ ...planFor(asked).jobs[0], submission: 'S-other' }] }), /job_missing/);
  const ok = structuredClone(db);
  const [change] = reissue(ok, planFor(asked), { newId: () => '11111111-1111-4111-8111-111111111111', now: '2026-11-10T12:00:00.000Z' });
  assert.equal(change.newExecution, '11111111-1111-4111-8111-111111111111');
  const job = ok.jobs[asked.submission];
  assert.equal(job.decision, undefined); assert.equal(job.command, undefined); assert.equal(job.receipt, undefined);
  assert.deepEqual(job.evidence_window_reissue.activation, activation);
});

test('plans are bounded and name the activation and evidence digests', () => {
  const job = { submission: 'S', expectExecutionId: '00000000-0000-4000-8000-000000000000', evidence: { a: 'a'.repeat(64) } };
  assert.throws(() => validatePlan({ reason: 'short', activation, jobs: [job] }), /plan/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', jobs: [job] }), /plan_activation/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', activation: { height: '0', evidenceDigest: 'b'.repeat(64) }, jobs: [job] }), /plan_activation/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', activation, jobs: [{ ...job, evidence: {} }] }), /plan_evidence/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', activation, jobs: [job, job] }), /plan_duplicate/);
  assert.equal(validatePlan({ reason: 'a long enough reason', activation, jobs: [job] }).jobs.length, 1);
});
