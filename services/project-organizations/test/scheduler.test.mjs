import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { openComputeBudget } from '../src/compute-budget.mjs';
import { createScheduler, fundingEpochOf } from '../src/scheduler.mjs';
import { sha256 } from '../src/common.mjs';
import { centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';

const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const CRITERIA = 'c'.repeat(64);
const SOLVER = 'uain1' + 'a'.repeat(40);
const ids = Array.from({ length: 120 }, (_, i) => `OPP-${String(i + 1).padStart(5, '0')}`);
const selection = validateSelection({
  schema: 'uain-project-organization-selection-v1',
  observedAt: '2026-11-05T00:00:00.000Z',
  count: 120,
  selection: 'test fixture',
  authority: 'test fixture',
  projects: ids.map((id) => ({
    id, sourceDigest: sha256('source ' + id), modelPlanDigest: sha256('plan ' + id),
    kpi: { statement: `Main KPI statement for ${id}`, threshold: null, unit: null, comparator: null, qualification: 'fixture' },
  })),
});
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Fake budget that never pauses; records reservations and settlements. */
function fakeBudget() {
  const reserved = [];
  const settled = [];
  return {
    reserved, settled,
    reserve(r) { const id = 'cb-' + String(reserved.length).padStart(36, '0'); reserved.push({ id, ...r }); return { id }; },
    settle(id, u) { settled.push({ id, ...u }); },
    status: () => ({ paused: null }),
  };
}

async function fixture(t, { budget, clock: initial = T0, jobsFor } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'scheduler-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = {
    base, now: initial, selection,
    registry: openRegistry({ directory: join(base, 'registry'), selection }),
    sourceOverride: new Map(),
    criteria: new Map(),
    epochs: new Map(),
    runs: [],
    prepared: [],
    nativeFails: 0,
    budget: budget ?? fakeBudget(),
  };
  env.clock = () => env.now;
  env.journal = openJournal({ directory: join(base, 'journal'), now: env.clock });
  t.after(() => { env.journal.close(); env.registry.close(); });
  env.done = new Map();
  env.jobs = {
    next: jobsFor ?? ((projectId) => ({ projectId, taskId: `T-${projectId}-${env.done.get(projectId) ?? 0}`, kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA })),
    criteriaDigest: (projectId, taskId) => env.criteria.get(taskId) ?? CRITERIA,
    // Native funding epoch (`fundingEpochOf` of the task record); '0' = the opening funding.
    fundingEpoch: (projectId, taskId) => (env.epochs.has(taskId) ? env.epochs.get(taskId) : '0'),
  };
  env.sources = { digest: (projectId) => env.sourceOverride.get(projectId) ?? selection.get(projectId).sourceDigest };
  env.native = {
    // Same contract as native.mjs prepare(projectId, operation, payload, {id, signer}).
    prepare(projectId, operation, payload, { id, signer }) {
      if (env.nativeFails > 0) {
        env.nativeFails--;
        throw Object.assign(Error('custody unavailable'), { code: 'custody_unavailable' });
      }
      const exact = centralPayload(operation, payload); // the native field set and evidence digest
      env.prepared.push({ projectId, operation, payload: exact, id, signer });
      return env.journal.prepare({
        id, projectId, kind: 'native', operation, payload: exact,
        selectionDigest: selection.digest, sourceDigest: selection.get(projectId).sourceDigest, signer,
      });
    },
  };
  env.behaviour = async ({ projectId }) => {
    env.done.set(projectId, (env.done.get(projectId) ?? 0) + 1);
    return { outcome: 'completed', evidenceArtifact: { result: 'witness', projectId }, usage: { costUsd: 0.25, stopReason: 'end_turn' } };
  };
  env.executor = {
    model: 'claude-sonnet-5-5',
    capabilities: ['python3'],
    run: async (input, options) => {
      env.runs.push(input);
      return env.behaviour(input, options);
    },
  };
  env.make = (overrides = {}) => createScheduler({
    selection, registry: env.registry, journal: overrides.journal ?? env.journal, executor: env.executor, native: env.native,
    budget: env.budget, jobs: env.jobs, sources: env.sources, workspaceRoot: join(base, 'workspaces'),
    stateDirectory: join(base, 'state'), clock: env.clock, limits: { concurrency: 1, leaseMs: 60000 }, ...overrides,
  });
  return env;
}

test('round-robin is fair across all 120 organizations and survives restart', async (t) => {
  const env = await fixture(t);
  const first = env.make({ owner: 'worker-a' });
  for (let i = 0; i < 130; i++) assert.equal((await first.tick()).state, 'submission_prepared');
  const second = env.make({ owner: 'worker-b' });
  for (let i = 0; i < 110; i++) await second.tick();
  assert.deepEqual(env.runs.map((r) => r.projectId), [...ids, ...ids]);
  for (const id of ids) assert.equal(env.done.get(id), 2);
  assert.equal(env.prepared.length, 240);
  assert.equal(env.budget.reserved.length, 240);
  assert.equal(env.budget.settled[0].costUsd, 0.25);
});

test('projects without jobs are skipped without starving the rest; idle when none have work', async (t) => {
  const busy = new Set([ids[3], ids[77]]);
  const env = await fixture(t, {
    jobsFor: (projectId) => (busy.has(projectId) ? { projectId, taskId: `T-${projectId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, kind: 'leadership', criteriaDigest: CRITERIA } : null),
  });
  const s = env.make();
  for (let i = 0; i < 4; i++) assert.equal((await s.tick()).state, 'completed');
  assert.deepEqual(env.runs.map((r) => r.projectId), [ids[3], ids[77], ids[3], ids[77]]);
  assert.equal(env.prepared.length, 0, 'leadership reports are retained, never submitted as solver work');
  busy.clear();
  assert.deepEqual(await s.tick(), { state: 'idle' });
});

test('an expired lease from a dead worker is taken over on restart without a stale overwrite', async (t) => {
  const env = await fixture(t, { jobsFor: (projectId) => (projectId === ids[0] ? { projectId, taskId: 'T-only', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA } : null) });
  env.behaviour = () => new Promise(() => {}); // the first worker hangs and ignores its signal
  const dead = env.make({ owner: 'worker-dead', limits: { concurrency: 1, leaseMs: 1000, abortGraceMs: 100 } });
  const abandoned = dead.tick();
  while (env.runs.length === 0) await tick();
  assert.equal(dead.status(ids[0]).state, 'running');
  const successor = env.make({ owner: 'worker-next', limits: { concurrency: 1, leaseMs: 1000 } });
  assert.equal((await successor.tick()).state, 'busy', 'the slot lease is still held');
  env.now += 62000;
  assert.equal(successor.status(ids[0]).state, 'interrupted');
  env.behaviour = async () => ({ outcome: 'completed', evidenceArtifact: { ok: true }, usage: { costUsd: 1 } });
  const result = await successor.tick();
  assert.equal(result.state, 'submission_prepared');
  assert.equal(env.runs.length, 2);
  assert.equal(env.journal.lease('job:T-only'), null);
  await abandoned; // its 1s lease-deadline timer fires; it no longer owns the lease
  assert.equal(successor.status(ids[0]).state, 'submission_prepared');
  assert.equal(env.prepared.length, 1);
});

test('two schedulers sharing the journal and state never run the same task twice', async (t) => {
  const env = await fixture(t, { jobsFor: (projectId) => (projectId === ids[0] ? { projectId, taskId: 'T-shared', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA } : null) });
  const gate = deferred();
  env.behaviour = async () => { await gate.promise; return { outcome: 'completed', evidenceArtifact: { ok: 1 }, usage: {} }; };
  const otherJournal = openJournal({ directory: join(env.base, 'journal'), now: env.clock });
  t.after(() => otherJournal.close());
  const a = env.make({ owner: 'worker-a' });
  const b = env.make({ owner: 'worker-b', journal: otherJournal });
  const running = a.tick();
  while (env.runs.length === 0) await tick();
  assert.equal((await b.tick()).state, 'busy');
  gate.resolve();
  assert.equal((await running).state, 'submission_prepared');
  assert.deepEqual(await b.tick(), { state: 'idle' });
  assert.deepEqual(await a.tick(), { state: 'idle' });
  assert.equal(env.runs.length, 1);
  assert.equal(env.prepared.length, 1);
});

test('stop aborts the running job, keeps its unknown cost reserved and its turn', async (t) => {
  const env = await fixture(t);
  env.behaviour = (input, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const s = env.make();
  const pending = s.tick();
  while (env.runs.length === 0) await tick();
  s.stop();
  const result = await pending;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.reason, 'stopped');
  assert.equal(env.budget.reserved.length, 1);
  assert.equal(env.budget.settled.length, 0, 'a cancelled run is never settled as zero cost');
  assert.deepEqual(await s.tick(), { state: 'stopped' });
  env.behaviour = async () => ({ outcome: 'completed', evidenceArtifact: { ok: true }, usage: {} });
  await env.make().tick();
  assert.deepEqual(env.runs.map((r) => r.projectId), [ids[0], ids[0]], 'the cancelled project keeps its turn');
});

test('source or criteria changes before or during a run hold the job and discard the result', async (t) => {
  const env = await fixture(t);
  const s = env.make();
  env.sourceOverride.set(ids[0], 'f'.repeat(64));
  assert.equal((await s.tick()).reason, 'source_changed');
  assert.equal(env.runs.length, 0);
  assert.equal(env.budget.reserved.length, 0, 'no compute is reserved for a drifted source');
  env.sourceOverride.clear();

  env.behaviour = async ({ projectId }) => {
    env.sourceOverride.set(projectId, 'e'.repeat(64));
    return { outcome: 'completed', evidenceArtifact: { claim: 'x' }, usage: { costUsd: 1 } };
  };
  const changedSource = await s.tick();
  assert.deepEqual([changedSource.projectId, changedSource.state, changedSource.reason, changedSource.discarded], [ids[1], 'held', 'source_changed', true]);
  assert.equal(env.prepared.length, 0);
  env.sourceOverride.clear();

  env.behaviour = async ({ taskId }) => {
    env.criteria.set(taskId, 'd'.repeat(64));
    return { outcome: 'completed', evidenceArtifact: { claim: 'y' }, usage: {} };
  };
  const changedCriteria = await s.tick();
  assert.deepEqual([changedCriteria.projectId, changedCriteria.reason, changedCriteria.discarded], [ids[2], 'criteria_changed', true]);
  assert.equal(env.prepared.length, 0);
  assert.equal(s.status(ids[2]).state, 'held');
  // The stale-criteria job is held durably; it is not rerun on the next round.
  env.behaviour = async () => ({ outcome: 'completed', evidenceArtifact: { ok: true }, usage: {} });
  const runsBefore = env.runs.length;
  for (let i = 0; i < 120; i++) await s.tick();
  assert.ok(env.runs.slice(runsBefore).every((r) => r.projectId !== ids[2]));
  assert.ok(env.runs.slice(runsBefore).some((r) => r.projectId === ids[1]), 'a restored source runs again');
});

test('workspaces stay inside their project; escapes are refused before any spend', async (t) => {
  const env = await fixture(t);
  const s = env.make();
  await s.tick();
  assert.equal(env.runs[0].workspace, join(await realpath(join(env.base, 'workspaces')), ids[0], 'tasks', `T-${ids[0]}-0`));
  const root = join(env.base, 'workspaces');
  await mkdir(join(root, ids[2], 'tasks'), { recursive: true });
  await symlink(join(root, ids[2]), join(root, ids[1]));
  const escaped = await s.tick();
  assert.deepEqual([escaped.projectId, escaped.state, escaped.reason], [ids[1], 'held', 'workspace_escape']);
  await mkdir(join(root, ids[3]), { recursive: true });
  await symlink(join(root, ids[2], 'tasks'), join(root, ids[3], 'tasks'));
  await s.tick(); // ids[2] runs normally
  const nested = await s.tick();
  assert.deepEqual([nested.projectId, nested.reason], [ids[3], 'workspace_escape']);
  assert.deepEqual(env.runs.map((r) => r.projectId), [ids[0], ids[2]]);
  assert.equal(env.budget.reserved.length, 2);

  env.jobs.next = (projectId) => ({ projectId, taskId: '../OPP-00002', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA });
  const traversal = await s.tick();
  assert.deepEqual([traversal.state, traversal.reason], ['failed', 'invalid_task_id']);
  env.jobs.next = () => ({ projectId: ids[0], taskId: 'T-foreign', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA });
  assert.equal((await s.tick()).reason, 'job_project_mismatch');
  env.jobs.next = (projectId) => ({ projectId, taskId: 'T-unsigned', kind: 'solver', criteriaDigest: CRITERIA });
  assert.equal((await s.tick()).reason, 'invalid_solver');
  assert.equal(env.runs.length, 2);
});

test('hostile evidence and malformed executor results are refused and never submitted', async (t) => {
  const env = await fixture(t);
  const s = env.make();
  const cases = [
    [{ outcome: 'completed', evidenceArtifact: 'a string claim' }, 'evidence_not_object'],
    [{ outcome: 'completed', evidenceArtifact: ['array'] }, 'evidence_not_object'],
    [{ outcome: 'completed', evidenceArtifact: null }, 'evidence_not_object'],
    [{ outcome: 'completed', evidenceArtifact: { score: 0.5 } }, 'evidence_not_canonical'],
    [{ outcome: 'completed', evidenceArtifact: { blob: 'a'.repeat(300 * 1024) } }, 'evidence_oversize'],
    [{ outcome: 'completed', evidenceArtifact: { blob: 'a'.repeat(16380) } }, 'evidence_oversize'],
    [{ outcome: 'completed', evidenceArtifact: Object.assign(Object.create({ inherited: 1 }), { x: 1 }) }, 'evidence_not_object'],
    [42, 'invalid_executor_result'],
    [{ outcome: 'submitted', evidenceArtifact: {} }, 'invalid_executor_result'],
    [{ outcome: 'blocked', missingCapability: '\u0000rm -rf' }, 'invalid_executor_result'],
  ];
  for (const [result, reason] of cases) {
    env.behaviour = async () => result;
    const r = await s.tick();
    assert.deepEqual([r.state, r.reason], ['failed', reason], JSON.stringify(result)?.slice(0, 80));
  }
  env.behaviour = async () => { throw Error('provider crashed'); };
  assert.equal((await s.tick()).reason, 'executor_error');
  assert.equal(env.prepared.length, 0);
  assert.equal(env.budget.settled.length, cases.length, 'returned runs settle; a crashed run keeps its reservation');
  assert.deepEqual(await readdir(join(env.base, 'state', 'evidence')), []);
});

test('compute exhaustion pauses all work, keeps the turn and resumes on the next UTC day', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'scheduler-budget-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  let now = T0;
  const budget = openComputeBudget({ directory: base, now: () => now });
  const env = await fixture(t, { budget });
  Object.defineProperty(env, 'now', { get: () => now, set: (v) => { now = v; } });
  env.behaviour = async ({ projectId }) => {
    env.done.set(projectId, 1);
    return { outcome: 'completed', evidenceArtifact: { ok: true }, usage: { costUsd: 2 } };
  };
  const s = env.make();
  await s.tick();
  await s.tick();
  const paused = await s.tick();
  assert.deepEqual([paused.paused, paused.projectId, paused.state], ['daily', ids[2], 'paused']);
  assert.equal(s.status(ids[5]).computePaused, 'daily');
  assert.equal(env.runs.length, 2);
  now = Date.parse('2026-11-07T00:00:01.000Z');
  await s.tick();
  assert.deepEqual(env.runs.map((r) => r.projectId), [ids[0], ids[1], ids[2]]);
});

test('unavailable tools block with the exact missing capability', async (t) => {
  const env = await fixture(t);
  env.jobs.next = (projectId) => ({ projectId, taskId: `T-${projectId}`, kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA, requiredCapabilities: ['python3', 'lean4', 'gpu:cuda'] });
  const s = env.make();
  const r = await s.tick();
  assert.deepEqual([r.state, r.missingCapabilities], ['blocked', ['lean4', 'gpu:cuda']]);
  assert.equal(env.runs.length, 0);
  assert.equal(env.budget.reserved.length, 0);
  env.jobs.next = (projectId) => ({ projectId, taskId: `U-${projectId}`, kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA });
  env.behaviour = async () => ({ outcome: 'blocked', missingCapability: 'dataset:pinned-genbank' });
  const runtime = await s.tick();
  assert.deepEqual([runtime.state, runtime.missingCapabilities], ['blocked', ['dataset:pinned-genbank']]);
  assert.equal(env.prepared.length, 0);
});

test('submission reads prepared until a native proof confirms it; a failed prepare is retried without rerunning', async (t) => {
  const env = await fixture(t, { jobsFor: (projectId) => (projectId === ids[0] ? { projectId, taskId: 'T-submit', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA } : null) });
  env.nativeFails = 1;
  const s = env.make();
  const first = await s.tick();
  assert.deepEqual([first.state, first.reason], ['submission_pending', 'custody_unavailable']);
  const restarted = env.make({ owner: 'after-restart' });
  assert.equal((await restarted.tick()).state, 'submission_prepared');
  assert.equal(env.runs.length, 1, 'the retained outcome is resubmitted, not recomputed');
  assert.equal(env.prepared.length, 1);
  const [submission] = env.prepared;
  assert.deepEqual([submission.operation, submission.signer, submission.payload.task], ['central_submit', SOLVER, 'T-submit']);
  assert.equal(submission.payload.evidence_digest, first.evidenceDigest);
  assert.equal(sha256(submission.payload.evidence), first.evidenceDigest);
  const status = restarted.status(ids[0]);
  assert.deepEqual([status.state, status.intentId], ['submission_prepared', submission.id]);
  env.journal.claim(submission.id, 'custody');
  env.journal.recordEnvelope(submission.id, { signed: 'envelope' });
  assert.equal(restarted.status(ids[0]).state, 'submission_prepared');
  env.journal.recordReceipt(submission.id, { height: 10, finalized: true });
  assert.equal(restarted.status(ids[0]).state, 'submitted');
  assert.deepEqual(await restarted.tick(), { state: 'idle' });
});

test('funding epoch from the native task record', () => {
  const open = { state: 'open', pending: '', winner: '', paid: '0', reserved: '6000', solver_amount: '5000', reviewer_amount: '1000' };
  assert.equal(fundingEpochOf(open), '0');
  assert.equal(fundingEpochOf({ ...open, paid: '1000' }), '1000', 'a re-funded task after one reject');
  for (const change of [{ state: 'open_unfunded', reserved: '0' }, { state: 'under_review', pending: 'S-1' }, { state: 'accepted', winner: 'S-1' },
    { pending: 'S-1' }, { reserved: '0' }, { reserved: '5000' }, { paid: '01' }, { paid: 7 }])
    assert.equal(fundingEpochOf({ ...open, ...change }), null, JSON.stringify(change));
  assert.equal(fundingEpochOf(null), null);
});

test('attempt key: another solver, or a re-funded epoch, may attempt; one solver never runs twice on one epoch', async (t) => {
  const SOLVER_B = 'uain1' + 'b'.repeat(40);
  let solver = SOLVER;
  const env = await fixture(t, { jobsFor: (projectId) => (projectId === ids[0] ? { projectId, taskId: 'T-epoch', kind: 'solver', solver, criteriaDigest: CRITERIA } : null) });
  const s = env.make();
  // Solver A, opening funding (epoch 0).
  assert.equal((await s.tick()).state, 'submission_prepared');
  assert.deepEqual(await s.tick(), { state: 'idle' }, 'the same solver on the same epoch never runs again');
  // Solver B, same epoch (only native decides which submission is first).
  solver = SOLVER_B;
  const b0 = await s.tick();
  assert.deepEqual([b0.state, b0.solver, b0.fundingEpoch], ['submission_prepared', SOLVER_B, '0']);
  // Under review: no solver work at all, and the status row is not overwritten.
  env.epochs.set('T-epoch', null);
  assert.deepEqual(await s.tick(), { state: 'idle' });
  assert.equal(s.status(ids[0]).state, 'submission_prepared');
  // Rejected and re-funded: a new epoch, so both solvers may attempt once more.
  env.epochs.set('T-epoch', '1000');
  const b1 = await s.tick();
  assert.deepEqual([b1.state, b1.fundingEpoch], ['submission_prepared', '1000']);
  solver = SOLVER;
  assert.equal((await s.tick()).state, 'submission_prepared');
  assert.deepEqual(await s.tick(), { state: 'idle' });
  // Four runs, four distinct submissions and intents; each names its solver.
  assert.equal(env.runs.length, 4);
  assert.equal(new Set(env.prepared.map((p) => p.payload.id)).size, 4);
  assert.equal(new Set(env.prepared.map((p) => p.id)).size, 4);
  assert.deepEqual(env.prepared.map((p) => p.signer), [SOLVER, SOLVER_B, SOLVER_B, SOLVER]);
  assert.equal(s.attempts(ids[0]).length, 4);
});

test('a run whose funding epoch moves on is discarded and never rerun on that key', async (t) => {
  const env = await fixture(t, { jobsFor: (projectId) => (projectId === ids[0] ? { projectId, taskId: 'T-moved', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA } : null) });
  env.behaviour = async ({ taskId }) => {
    env.epochs.set(taskId, null); // another submission went under review meanwhile
    return { outcome: 'completed', evidenceArtifact: { claim: 'late' }, usage: {} };
  };
  const s = env.make();
  const moved = await s.tick();
  assert.deepEqual([moved.state, moved.reason, moved.discarded], ['held', 'funding_epoch_changed', true]);
  assert.equal(env.prepared.length, 0);
  env.epochs.delete('T-moved'); // back to epoch 0 (cannot happen on native; still never rerun)
  env.behaviour = async () => ({ outcome: 'completed', evidenceArtifact: { ok: true }, usage: {} });
  assert.deepEqual(await s.tick(), { state: 'idle' });
  assert.equal(env.runs.length, 1);
  // A provider cannot set the epoch itself; a malformed or unavailable epoch is refused.
  env.jobs.next = (projectId) => (projectId === ids[1] ? { projectId, taskId: 'T-x', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA, fundingEpoch: '5' } : null);
  assert.equal((await s.tick()).reason, 'job_sets_funding_epoch');
  env.jobs.next = (projectId) => (projectId === ids[1] ? { projectId, taskId: 'T-x', kind: 'solver', solver: SOLVER, criteriaDigest: CRITERIA } : null);
  env.epochs.set('T-x', '01');
  assert.equal((await s.tick()).reason, 'invalid_funding_epoch');
  delete env.jobs.fundingEpoch;
  assert.equal((await s.tick()).reason, 'funding_epoch_unavailable');
  assert.equal(env.runs.length, 1);
});

test('refuses unsupported concurrency and incomplete wiring', async (t) => {
  const env = await fixture(t);
  assert.throws(() => env.make({ limits: { concurrency: 2, leaseMs: 60000 } }), { code: 'unsupported_concurrency' });
  assert.throws(() => env.make({ native: {} }), { code: 'invalid_scheduler_configuration' });
});
