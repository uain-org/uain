// FICTIONAL local worker fixtures only: no native node, keys, signing or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorker, canonical, digest } from '../src/worker.mjs';
import { operatorRelease, release, validatePlan, sha } from '../ops/operator-release.mjs';
import { acquireTestLock } from './test-lock.mjs';

const evidence = Buffer.from('FICTIONAL fixed submission evidence');
const assignment = { submission: 'S-release', task: 'T-release', reviewer: 'reviewer', author: 'solver', criteria: 'Check the fixed fictional evidence',
  criteria_digest: digest(Buffer.from('Check the fixed fictional evidence')), evidence_digest: digest(evidence), proof: { verified: true }, state: 'under_review' };
const lockOpt = process.platform === 'linux' ? {} : { acquireLock: acquireTestLock };

async function fixture(t, { failFirst = 'throw' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-release-fixture-'));
  let providerCalls = 0, custodyCalls = 0; const inputs = [];
  const deps = { directory, reviewer: 'reviewer', ...lockOpt,
    source: { read: async () => structuredClone(assignment), fetchEvidence: async () => ({ bytes: evidence, owner: 'solver', digest: assignment.evidence_digest, immutable: true, authenticated: true }) },
    provider: { assess: async (input) => { inputs.push(structuredClone(input)); providerCalls++;
      if (providerCalls === 1 && failFirst === 'throw') throw Error('FICTIONAL lost provider answer');
      if (providerCalls === 1 && failFirst === 'invalid') return { verdict: 'maybe', findings: [] };
      return { verdict: 'accept', findings: ['FICTIONAL finding'] }; } },
    custody: { submitCentralReview: async (body) => { custodyCalls++;
      return { verified: true, status: 'finalized', executionId: body.executionId, commandDigest: digest(Buffer.from(canonical(body.command))), decisionDigest: body.command.payload.verification_digest }; } } };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, deps, counts: () => ({ providerCalls, custodyCalls }), inputs };
}

const planFor = (job, reason) => ({ reason: 'FICTIONAL test release of a provider-phase uncertain job', jobs: [{ submission: job.submission, expectExecutionId: job.execution_id, expectReason: reason, evidence: { store: 'a'.repeat(64) } }] });

test('a provider-phase uncertain job is released once and then reviewed with a new execution', async (t) => {
  const f = await fixture(t);
  let worker = await openWorker(f.deps);
  await worker.enqueue(assignment.submission);
  const stuck = await worker.run(assignment.submission);
  assert.equal(stuck.state, 'uncertain'); assert.equal(stuck.phase, 'provider'); assert.equal(stuck.reason, 'provider_outcome_unknown');
  assert.equal(f.counts().custodyCalls, 0);
  // While the worker holds the store, the release refuses.
  await assert.rejects(operatorRelease({ store: f.directory, plan: planFor(stuck, 'provider_outcome_unknown'), ...lockOpt }), /store_busy/);
  // The worker itself never retries it.
  assert.equal((await worker.run(assignment.submission)).state, 'uncertain');
  await worker.close();

  const before = await readFile(join(f.directory, 'jobs.json'), 'utf8');
  const dry = await operatorRelease({ store: f.directory, plan: planFor(stuck, 'provider_outcome_unknown'), ...lockOpt });
  assert.equal(dry.apply, false); assert.equal(dry.changes.length, 1);
  assert.equal(await readFile(join(f.directory, 'jobs.json'), 'utf8'), before);
  await assert.rejects(operatorRelease({ store: f.directory, plan: planFor(stuck, 'provider_outcome_unknown'), apply: true, ...lockOpt }), /paths/);
  const backup = join(f.directory, '..', 'backup-' + process.pid + '-' + Date.now() + '.json');
  t.after(() => rm(backup, { force: true }));
  const applied = await operatorRelease({ store: f.directory, plan: planFor(stuck, 'provider_outcome_unknown'), apply: true, backup, ...lockOpt });
  assert.equal(applied.backupDigest, sha(before));
  assert.equal(await readFile(backup, 'utf8'), before);
  // A second apply with the same plan refuses: the job is no longer uncertain.
  await assert.rejects(operatorRelease({ store: f.directory, plan: planFor(stuck, 'provider_outcome_unknown'), apply: true, backup: backup + '.2', ...lockOpt }), /state_changed/);

  worker = await openWorker(f.deps);
  t.after(() => worker.close());
  const queued = worker.status(assignment.submission);
  assert.equal(queued.state, 'queued'); assert.notEqual(queued.execution_id, stuck.execution_id);
  assert.equal(queued.operator_releases.length, 1); assert.equal(queued.operator_releases[0].execution_id, stuck.execution_id);
  assert.equal(queued.history, undefined);
  const done = await worker.run(assignment.submission);
  assert.equal(done.state, 'completed'); assert.equal(done.decision.verdict, 'accept');
  assert.equal(done.decision.execution_id, queued.execution_id);
  assert.deepEqual(f.counts(), { providerCalls: 2, custodyCalls: 1 });
  assert.equal(f.inputs[1].execution_id, queued.execution_id);
});

test('an invalid provider decision is releasable; a custody-phase job and changed expectations are refused', async (t) => {
  const f = await fixture(t, { failFirst: 'invalid' });
  const worker = await openWorker(f.deps);
  await worker.enqueue(assignment.submission);
  const stuck = await worker.run(assignment.submission);
  await worker.close();
  assert.equal(stuck.reason, 'invalid_provider_decision');
  const db = JSON.parse(await readFile(join(f.directory, 'jobs.json'), 'utf8'));
  assert.throws(() => release(structuredClone(db), planFor(stuck, 'provider_outcome_unknown')), /reason_changed/);
  assert.throws(() => release(structuredClone(db), { ...planFor(stuck, 'invalid_provider_decision'), jobs: [{ ...planFor(stuck, 'invalid_provider_decision').jobs[0], expectExecutionId: '00000000-0000-4000-8000-000000000000' }] }), /execution_changed/);
  const custody = structuredClone(db); custody.jobs[stuck.submission].phase = 'custody';
  assert.throws(() => release(custody, planFor(stuck, 'invalid_provider_decision')), /not_provider_phase/);
  const decided = structuredClone(db); decided.jobs[stuck.submission].decision = { verdict: 'accept' };
  assert.throws(() => release(decided, planFor(stuck, 'invalid_provider_decision')), /custody_material_present/);
  const ok = structuredClone(db);
  const [change] = release(ok, planFor(stuck, 'invalid_provider_decision'), { newId: () => '11111111-1111-4111-8111-111111111111' });
  assert.equal(change.newExecution, '11111111-1111-4111-8111-111111111111');
  assert.equal(ok.jobs[stuck.submission].reason, undefined);
});

test('plans are bounded and need evidence digests', () => {
  assert.throws(() => validatePlan({ reason: 'short', jobs: [] }), /plan/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', jobs: [{ submission: 'S', expectExecutionId: '00000000-0000-4000-8000-000000000000', expectReason: 'custody_outcome_unknown', evidence: { a: 'a'.repeat(64) } }] }), /plan_job/);
  assert.throws(() => validatePlan({ reason: 'a long enough reason', jobs: [{ submission: 'S', expectExecutionId: '00000000-0000-4000-8000-000000000000', expectReason: 'process_interrupted', evidence: {} }] }), /plan_evidence/);
});

test('a group-readable store is refused', async (t) => {
  const f = await fixture(t);
  const worker = await openWorker(f.deps);
  await worker.close();
  await writeFile(join(f.directory, 'jobs.json'), JSON.stringify({ version: 1, jobs: {}, attempts: {} }), { mode: 0o640 });
  const { chmod } = await import('node:fs/promises');
  await chmod(join(f.directory, 'jobs.json'), 0o640);
  await assert.rejects(operatorRelease({ store: f.directory, plan: { reason: 'FICTIONAL test reason', jobs: [{ submission: 'S', expectExecutionId: '00000000-0000-4000-8000-000000000000', expectReason: 'process_interrupted', evidence: { a: 'a'.repeat(64) } }] }, ...lockOpt }), /store_file/);
});

test('a job that used its whole attempt bound after timeouts is released once with a fresh count and reviewed (12 November 2026)', async (t) => {
  let providerCalls = 0, now = Date.parse('2026-11-12T00:00:00.000Z');
  const directory = await mkdtemp(join(tmpdir(), 'reviewer-release-exhausted-'));t.after(() => rm(directory, { recursive: true, force: true }));
  const deps = { directory, reviewer: 'reviewer', ...lockOpt, timeoutMs: 5, clock: () => new Date(now).toISOString(),
    source: { read: async () => structuredClone(assignment), fetchEvidence: async () => ({ bytes: evidence, owner: 'solver', digest: assignment.evidence_digest, immutable: true, authenticated: true }) },
    provider: { assess: async () => { providerCalls++; if (providerCalls <= 24) return new Promise(() => {}); return { verdict: 'accept', findings: ['FICTIONAL finding'] }; } },
    custody: { submitCentralReview: async (body) => ({ verified: true, status: 'finalized', executionId: body.executionId, commandDigest: digest(Buffer.from(canonical(body.command))), decisionDigest: body.command.payload.verification_digest }) } };
  let worker = await openWorker(deps);await worker.enqueue('S-release');
  for (let i = 0; i < 4 * 24 * 4; i++) { await worker.run('S-release'); now += 15 * 60000; }
  const stuck = worker.status('S-release');
  assert.equal(stuck.state, 'uncertain');assert.equal(stuck.reason, 'provider_attempts_exhausted');assert.equal(providerCalls, 24);
  await worker.close();
  const plan = { reason: 'FICTIONAL provider outage over, release the exhausted job', jobs: [{ submission: 'S-release', expectExecutionId: stuck.execution_id, expectReason: 'provider_attempts_exhausted', evidence: { outage: 'a'.repeat(64) } }] };
  const report = await operatorRelease({ store: directory, plan, apply: true, backup: join(directory, 'jobs.before'), acquireLock: lockOpt.acquireLock });
  assert.equal(report.changes.length, 1);
  const db = JSON.parse(await readFile(join(directory, 'jobs.json'), 'utf8')), job = db.jobs['S-release'];
  assert.equal(job.state, 'queued');assert.equal(job.provider_attempts.total, 0);assert.equal(job.operator_releases[0].provider_attempts.total, 24);assert.equal(job.timeouts, undefined);
  worker = await openWorker(deps);t.after(() => worker.close().catch(() => {}));
  assert.equal((await worker.run('S-release')).state, 'completed');assert.equal(providerCalls, 25);
});
