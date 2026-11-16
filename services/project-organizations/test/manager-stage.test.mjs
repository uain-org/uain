/** Manager stage (ops/manager-stage.mjs). Every provider, retriever and native state here is a
 * FIXTURE: no model was called, no search was run and no native state was read. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY, centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { openLeadershipStore } from '../src/leadership.mjs';
import { NATIVE_ROLE_OPERATIONS } from '../src/native.mjs';
import { createPriorArtSearch } from '../src/prior-art.mjs';
import { GUARDIAN } from '../src/bootstrap.mjs';
import { sha256 } from '../src/common.mjs';
import { acceptedSurvey } from './fixtures/survey-fixture.mjs';
import { FENCE } from '../../fund-manager/src/planner.mjs';
import {
  CONFIG_SCHEMA, FENCE_MODEL, FENCE_USER, checkFenceUser, createFencedProvider, runManagerStage, stepFunds,
} from '../ops/manager-stage.mjs';

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const ID = 'OPP-00002';
const P = 'P-' + ID;
const KPI = selection.get(ID).mainKpi;
const FUND_MANAGER = 'uain1a62e7d2841e34473b98a5fb8395019d1ca02b15c';
const T0 = Date.parse('2026-11-06T12:00:00Z');
const AID = 1000000n;
const pad = (n) => String(n).padStart(20, '0');
const jsonl = (value) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n';

const policy = (maxTaskUnits = '2000000000') => ({
  schema: 'uain-project-organization-fleet-policy-v1', revision: 2, selection_digest: selection.digest,
  projects: { [ID]: { native_project: P, source_digest: selection.get(ID).sourceDigest, paperclip_company: null, manager: GUARDIAN,
    evaluator: FUND_MANAGER, max_task_units: maxTaskUnits, max_plan_revision: 3 } },
  roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])), solvers: [],
});
const config = (extra = {}) => ({ schema: CONFIG_SCHEMA, projects: [ID], max_projects_per_run: 1, cooldown_minutes: 360, max_executions_per_day: 40, ...extra });

const stages = () => Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `Independently verify immutable stage ${i + 1} evidence for the unchanged Main KPI.` }));
const RATIONALE = {
  effort: 'Two days of bounded analysis on the pinned dataset.', difficulty: 'Requires reconciling two assay normalizations.',
  novelty: 'Builds on a gap the accepted survey names.', verificationCost: 'One independent verification rerun of the retained data.',
};
const task = (title, criteria, solver, reviewer, basis) => ({
  title, criteria, eligibility: 'unresolved', eligibility_basis: basis,
  proposed_price: { solver_amount: String(BigInt(solver) * AID), reviewer_amount: String(BigInt(reviewer) * AID), rationale: RATIONALE },
});
const TASKS = [
  task('Senolytic clearance assay rerun at pinned tolerance', 'An independent rerun reproduces the senolytic clearance ratio within the pinned tolerance from the retained raw assay data.', 400, 100,
    'Manager claim A: the clearance assay was never rerun at this tolerance.'),
  task('Biomarker panel calibration across two cohorts', 'A calibration report aligns the biomarker panel across both pinned cohorts with stated residuals under the fixed threshold.', 800, 200,
    'Manager claim B: no calibrated panel exists for these two cohorts.'),
  task('Openly solved reference pipeline replication', 'A replication of the reference pipeline output matches the published figure values within one percent.', 300, 50,
    'Manager claim C: the pipeline replication is unresolved anywhere.'),
];

/* -------------------------------------------------------------- FIXTURE native */

function nativeRecords({ survey = 'accepted', meetsMainKpi = false, budget = {}, fund = {}, tasks = [] } = {}) {
  const s = acceptedSurvey(ID, { meetsMainKpi });
  const surveyTask = survey === 'accepted' ? s.task : { ...s.task, state: survey, winner: '', paid: '0', reserved: '250000000' };
  const all = survey === 'absent' ? tasks : [surveyTask, ...tasks];
  const r = {
    [`project/${P}`]: { id: P, state: 'active', lead: GUARDIAN, safety_halted: false },
    [`central_project_budget/${P}`]: {
      project: P, manager: GUARDIAN, policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(1), round: 1, lifetime_ceiling: '1000000000000000',
      reserved: all.reduce((a, t) => a + BigInt(t.reserved ?? '0'), 0n).toString(), paid: all.reduce((a, t) => a + BigInt(t.paid ?? '0'), 0n).toString(),
      height: '100', evidence_digest: 'b'.repeat(64), ...budget,
    },
    [`central_fund_config/${P}`]: { project: P, evaluator: FUND_MANAGER },
    [`central_fund_state/${P}`]: { project: P, revision: 1, approved_revision: 1, completed: 0, pending: '', ...fund },
    [`central_fund_plan/${P}/${pad(1)}`]: { project: P, revision: 1, state: 'accept', main_kpi: KPI, stages: stages() },
    coin_supply: { minted: '0', reserved: '750000000', transparent: '0', shielded: '0' },
    // One foreign task first, so the index really is filtered by project.
    central_task_count: String(all.length + 1),
    [`central_task_index/${pad(1)}`]: { id: 'T-foreign-1', project: 'P-service-integrity-20261105' },
  };
  all.forEach((t, i) => {
    r[`central_task_index/${pad(i + 2)}`] = { id: t.id, project: P };
    r[`central_task/${t.id}`] = t;
  });
  if (survey === 'accepted') Object.assign(r, s.records);
  return r;
}
function fakeStatus(records) {
  const calls = [];
  const status = async (keys) => {
    calls.push(keys);
    assert.ok(keys.length >= 1 && keys.length <= 64);
    return { status: 'read', height: '120', app_hash: 'a'.repeat(64), records: Object.fromEntries(keys.map((k) => [k, records[k] ?? null])) };
  };
  return Object.assign(status, { calls });
}

/* ----------------------------------------------------------- FIXTURE provider */

function fakeProvider({ tasks = TASKS, open = [], known = [], ceo = null } = {}) {
  const calls = [];
  return {
    calls, fixture: false, model: 'fixture-model',
    async execute({ role, executionId, prompt }) {
      calls.push({ role, executionId, prompt });
      let answer;
      if (role === 'ceo') answer = ceo ?? { main_kpi: KPI, strategy: 'FIXTURE strategy: build on the gaps the accepted survey names.', blockers: [] };
      else if (role === 'manager') answer = { main_kpi: KPI, round: 1, tasks };
      else {
        const title = tasks.find((t) => prompt.includes(JSON.stringify(t.title)))?.title;
        answer = { openSolutionFound: open.includes(title), knownAnswer: known.includes(title),
          rationale: 'FIXTURE assessment: weighed every listed result against the acceptance criteria.' };
      }
      return { raw: jsonl(answer), receipt: { executionId, model: 'fixture-model', startedAt: '2026-11-06T11:00:00.000Z', finishedAt: '2026-11-06T11:00:05.000Z', actual: true } };
    },
  };
}

/* ---------------------------------------------------------- FIXTURE retriever */

const BODIES = {
  'api.github.com': () => JSON.stringify({ total_count: 1, items: [{ full_name: 'lab/tools', description: 'FIXTURE helpers' }] }),
  'export.arxiv.org': () => '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.00001v1</id><title>FIXTURE</title></entry></feed>',
  'api.crossref.org': () => JSON.stringify({ message: { 'total-results': 1, items: [{ DOI: '10.1000/xyz1', title: ['FIXTURE work'] }] } }),
  'api.semanticscholar.org': () => JSON.stringify({ total: 0, data: [] }),
};
const retriever = { async observe(url) {
  const bytes = Buffer.from(BODIES[new URL(url).hostname]());
  return { url, bytes, sha256: sha256(bytes) };
} };

/* --------------------------------------------------------------------- harness */

/** FIXTURE pre-open admission: a compiled verification contract per priced task. */
const fixtureCompile = ({ task }) => ({ contract: { schema: 'FIXTURE-verification-contract', taskId: task.id }, contractDigest: sha256('FIXTURE contract ' + task.id) });

function harness({ records = nativeRecords(), provider = fakeProvider(), maxTaskUnits, now = T0 } = {}) {
  const stageRoot = mkdtempSync(join(tmpdir(), 'manager-stage-'));
  let clock = now;
  let n = 0;
  const h = {
    stageRoot, provider, status: fakeStatus(records),
    store: openLeadershipStore({ directory: join(stageRoot, 'leadership') }),
    priorArt: createPriorArtSearch({ retriever, clock: () => clock - 60e3 }),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    setNow(ms) { clock = ms; },
    resetIds() { n = 0; },
    run(extra = {}) {
      return runManagerStage({ config: config(), projects: [ID], selection, catalogue, policy: maxTaskUnits ? policy(maxTaskUnits) : policy(),
        status: h.status, provider: h.provider, priorArt: h.priorArt, store: h.store, stageRoot, now: () => clock, newId: h.newId,
        preOpen: { compile: fixtureCompile }, ...extra });
    },
    batches() {
      const dir = join(stageRoot, 'batches', ID);
      try {
        return readdirSync(dir).filter((f) => !f.endsWith('.refused.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
      } catch {
        return [];
      }
    },
    runs() {
      const dir = join(stageRoot, 'runs', ID);
      try {
        return readdirSync(dir).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
      } catch {
        return [];
      }
    },
    close() { rmSync(stageRoot, { recursive: true, force: true }); },
  };
  return h;
}
const skippedFor = (summary) => summary.skipped.find((s) => s.project === ID)?.reason;

/* ----------------------------------------------------------------------- tests */

test('survey not accepted: nothing runs, no model call, no batch', async () => {
  for (const survey of ['absent', 'open', 'under_review']) {
    const h = harness({ records: nativeRecords({ survey }) });
    const summary = await h.run();
    assert.equal(skippedFor(summary), 'prior_art_survey_required', survey);
    assert.equal(h.provider.calls.length, 0);
    assert.deepEqual(h.batches(), []);
    assert.deepEqual(h.runs(), [], 'a gate refusal before any model call writes no run record');
    h.close();
  }
});

test('a held project (survey found the Main KPI met) gets no tasks', async () => {
  const h = harness({ records: nativeRecords({ meetsMainKpi: true }) });
  const summary = await h.run();
  assert.equal(skippedFor(summary), 'prior_art_survey_found_solution');
  assert.equal(h.provider.calls.length, 0);
  assert.deepEqual(h.batches(), []);
  h.close();
});

test('accepted survey: CEO, manager and independent assessments yield priced requests within the round-1 allowance', async () => {
  const h = harness({ provider: fakeProvider({ open: [TASKS[2].title] }) });
  const summary = await h.run();
  assert.deepEqual(summary.skipped, []);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].status, 'batched');
  assert.deepEqual(h.provider.calls.map((c) => c.role), ['ceo', 'manager', 'assessor', 'assessor', 'assessor']);
  // Each execution is separate; the assessor never sees the manager's eligibility claim or rationale.
  assert.equal(new Set(h.provider.calls.map((c) => c.executionId)).size, 5);
  for (const c of h.provider.calls.filter((x) => x.role === 'assessor')) {
    for (const t of TASKS) {
      assert.ok(!c.prompt.includes(t.eligibility_basis), 'no eligibility claim reaches the assessor');
      assert.ok(!c.prompt.includes(RATIONALE.novelty), 'no price rationale reaches the assessor');
    }
  }
  assert.ok(h.provider.calls[1].prompt.includes('prior_art_survey'), 'the manager sees the accepted survey');
  const [batch] = h.batches();
  assert.equal(batch.round, 1);
  assert.equal(batch.requests.length, 2, 'the task with an open solution is dropped');
  let total = 0n;
  for (const r of batch.requests) {
    assert.equal(r.operation, 'central_task_open');
    assert.equal(r.member, GUARDIAN, 'the starter budget manager signs');
    assert.match(r.id, /^T-OPP-00002-1-[a-f0-9]{16}$/);
    assert.equal(r.payload.id, r.id);
    assert.equal(r.payload.project, P);
    assert.deepEqual(centralPayload('central_task_open', r.payload), r.payload);
    const units = BigInt(r.payload.solver_amount) + BigInt(r.payload.reviewer_amount);
    assert.ok(units <= 2000n * AID, 'never above max_task_units');
    total += units;
  }
  assert.equal(batch.totalUnits, total.toString());
  assert.ok(total <= 9750n * AID, 'within the remaining round-1 allowance (10,000 minus the 250 AI$ survey)');
  assert.equal(batch.availableUnits, String(9750n * AID));
  const [run] = h.runs();
  assert.equal(run.executions, 5);
  assert.deepEqual(run.tasks.map((t) => [t.outcome, t.reason]), [['priced', null], ['priced', null], ['dropped', 'open_solution_found']]);
  for (const t of run.tasks) {
    assert.equal(t.priorArt.status, 'assessment_required');
    assert.ok(t.priorArt.searches.length >= 2 && t.priorArt.retrievals.length >= 2, 'searches are bound to retrieved bytes');
    assert.match(t.priorArtRecord.basis, /^Independent review by uain-fenced-prior-art-assessor-v1:/);
  }
  assert.equal(run.tasks[0].pricing.priceEvidence.priorArt.openSolutionFound, false);
  assert.equal(run.tasks[0].pricing.priceDigest, batch.requests[0].payload.evidence_digest);
  // The second task was priced against the first one's reservation.
  assert.equal(run.tasks[1].pricing.availableUnits, String(9750n * AID - 500n * AID));
  assert.deepEqual(h.store.list({ projectId: ID }).map((r) => [r.role, r.status, r.actual]), [['ceo', 'completed', true], ['manager', 'completed', true]]);
  h.close();
});

test('an assessment that finds an open solution or a known answer drops the task; none left means no batch', async () => {
  const h = harness({ provider: fakeProvider({ open: [TASKS[0].title, TASKS[2].title], known: [TASKS[1].title] }) });
  const summary = await h.run();
  assert.equal(summary.runs[0].status, 'no_rewardable_tasks');
  assert.deepEqual(summary.runs[0].dropped, ['open_solution_found', 'known_answer_not_rewardable', 'open_solution_found']);
  assert.deepEqual(h.batches(), []);
  assert.equal(h.runs().length, 1, 'the run is still recorded');
  h.close();
});

test('funds by step: exhausted allowance, a locked round, a pending step or inconsistent accounting refuse before any model call', async () => {
  const cases = [
    [{ budget: { reserved: String(9750n * AID) } }, 'budget_tasks_inconsistent'],
    [{ tasks: [{ id: `T-${ID}-1-${'f'.repeat(16)}`, project: P, state: 'accepted', reserved: '0', paid: String(9750n * AID) }] }, 'allowance_exhausted'],
    [{ fund: { completed: 1 } }, 'round_not_unlocked'],
    [{ fund: { pending: 'A-1' } }, 'fund_step_pending'],
    [{ budget: { main_kpi_achieved: true } }, 'project_main_kpi_achieved'],
    [{ budget: { closed: true } }, 'project_closed'],
    [{ budget: { manager: 'uain1' + 'c'.repeat(40) } }, 'native_manager_mismatch'],
    [{ tasks: [{ id: `T-${ID}-1-${'e'.repeat(16)}`, project: P, state: 'open', reserved: '500000000', paid: '0' }] }, 'open_task_exists'],
    [{ tasks: [{ id: `T-${ID}-1-${'e'.repeat(16)}`, project: P, state: 'under_review', reserved: '500000000', paid: '0' }] }, 'open_task_exists'],
    [{ tasks: [{ id: `T-${ID}-1-${'e'.repeat(16)}`, project: P, state: 'open_unfunded', reserved: '0', paid: '100000000' }] }, 'open_task_exists'],
  ];
  for (const [native, code] of cases) {
    const h = harness({ records: nativeRecords(native) });
    const summary = await h.run();
    assert.equal(skippedFor(summary), code, JSON.stringify(native));
    assert.equal(h.provider.calls.length, 0);
    assert.deepEqual(h.batches(), []);
    h.close();
  }
});

test('round 2 runs only once native unlocked it, against round 2 allowance', () => {
  const s = (budget, fund, tasks = []) => ({ nativeProjectId: P, budget: { project: P, manager: GUARDIAN, policy: CENTRAL_POLICY, round: 1, allocation: centralUnlockedUnits(1),
    reserved: '0', paid: '0', lifetime_ceiling: '1000000000000000', ...budget }, fundState: { approved_revision: 1, revision: 1, completed: 0, pending: '', ...fund }, tasks });
  const bound = policy('9750000000').projects[ID];
  const paid = [{ id: 'T-x', paid: String(9000n * AID), reserved: '0' }];
  assert.throws(() => stepFunds(s({ paid: String(9000n * AID) }, { completed: 1 }, paid), bound), (e) => e.code === 'round_not_unlocked');
  const f = stepFunds(s({ round: 2, allocation: centralUnlockedUnits(2), paid: String(9000n * AID) }, { completed: 1 }, paid), bound);
  assert.equal(f.round, 2);
  assert.equal(f.available, 101000n * AID);
  assert.equal(f.cap, 9750n * AID, 'still capped by max_task_units');
  assert.throws(() => stepFunds(s({ round: 2, allocation: centralUnlockedUnits(1) }, { completed: 1 }), bound), (e) => e.code === 'budget_allocation_mismatch');
});

test('the batch total never exceeds the remaining allowance, and prices above max_task_units are not proposed', async () => {
  // 1,000 AI$ left: the manager price bound is 1,000 AI$ for the whole batch.
  const tasks = [{ id: `T-${ID}-1-${'a'.repeat(16)}`, project: P, state: 'accepted', reserved: '0', paid: String(8750n * AID) }];
  const h = harness({ records: nativeRecords({ tasks }), maxTaskUnits: '9750000000' });
  const summary = await h.run();
  assert.equal(summary.runs[0].status, 'batched');
  const [batch] = h.batches();
  assert.equal(batch.availableUnits, String(1000n * AID));
  assert.ok(BigInt(batch.totalUnits) <= 1000n * AID);
  assert.ok(h.provider.calls[1].prompt.includes(`"price_bound_units":"${1000n * AID}"`));
  const [run] = h.runs();
  // 500 + 350 AI$ fit the 1,000 AI$ bound; the 1,000 AI$ task would exceed it and leadership strips its price.
  assert.deepEqual(run.tasks.map((t) => t.reason), [null, 'task_price_missing', null]);
  assert.equal(batch.totalUnits, String(850n * AID));
  h.close();

  const h2 = harness({ maxTaskUnits: '250000000' });
  await h2.run();
  assert.deepEqual(h2.runs()[0].tasks.map((t) => t.reason), ['task_price_missing', 'task_price_missing', 'task_price_missing'],
    'with revision 1 (250 AI$ per task) the proposed tasks cannot be priced');
  assert.deepEqual(h2.batches(), []);
  h2.close();
});

test('reruns: cooldown, then reused durable run identity refuses before redispatch', async () => {
  const h = harness();
  await h.run();
  const [first] = h.batches();
  assert.equal(first.requests.length, 3);
  const calls = h.provider.calls.length;
  // Same state again: the project is cooling down; no model call.
  assert.equal(skippedFor(await h.run()), 'cooldown');
  assert.equal(h.provider.calls.length, calls);
  // A reused run UUID is now a stronger pre-dispatch refusal; no call or batch is repeated.
  h.setNow(T0 + 7 * 3600e3);
  h.resetIds();
  await assert.rejects(h.run(), { code: 'execution_claim_invalid' });
  assert.equal(h.provider.calls.length, calls);
  assert.equal(h.batches().length, 1);
  h.close();
});

test('check mode and limits: no model call in check mode; daily execution budget and run limit hold', async () => {
  const h = harness();
  const checked = await h.run({ check: true });
  assert.deepEqual(checked.ready.map((r) => [r.project, r.round, r.availableUnits]), [[ID, 1, String(9750n * AID)]]);
  assert.equal(h.provider.calls.length, 0);
  const tight = await h.run({ config: config({ max_executions_per_day: 10 }) });
  assert.equal(tight.runs.length, 1, 'exactly one run fits ten executions');
  h.setNow(T0 + 7 * 3600e3);
  const over = await h.run({ config: config({ max_executions_per_day: 10 }) });
  assert.equal(skippedFor(over), 'daily_execution_budget');
  await assert.rejects(h.run({ config: config({ max_executions_per_day: 5 }) }), (e) => e.code === 'invalid_manager_stage_config');
  await assert.rejects(h.run({ projects: ['OPP-00003'] }), (e) => e.code === 'project_not_configured');
  h.close();
});

test('a CEO or manager refusal ends the run without assessments', async () => {
  const h = harness({ provider: fakeProvider({ ceo: { main_kpi: 'A different Main KPI than the frozen one', strategy: 'x'.repeat(30), blockers: [] } }) });
  const summary = await h.run();
  assert.equal(summary.runs[0].status, 'ceo_refused');
  assert.equal(summary.runs[0].reason, 'main_kpi_changed');
  assert.deepEqual(h.provider.calls.map((c) => c.role), ['ceo']);
  h.close();
});

test('fenced provider: spawns the pinned fence as uid 987/gid 980 with the planner environment', async () => {
  const spawned = [];
  const spawnImpl = (cmd, args, options) => {
    spawned.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(prompt) {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(jsonl({ seen: prompt.length })));
        child.emit('close', options.exitCode ?? 0);
      });
    } });
    child.kill = () => {};
    return child;
  };
  const provider = createFencedProvider({ spawnImpl, checkUser: () => {}, now: () => new Date(T0) });
  const out = await provider.execute({ executionId: 'e-1', prompt: 'hello' });
  assert.deepEqual([spawned[0].cmd, spawned[0].args], ['/usr/bin/python3', [FENCE, '--review']]);
  assert.equal(spawned[0].options.uid, 987);
  assert.equal(spawned[0].options.gid, 980);
  assert.equal(spawned[0].options.shell, false);
  assert.deepEqual(spawned[0].options.env, { HOME: '/var/lib/uain-central-reviewer', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.equal(spawned[0].options.cwd, '/var/lib/uain-central-reviewer');
  assert.deepEqual(out.receipt, { executionId: 'e-1', model: FENCE_MODEL, startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0).toISOString(), actual: true });
  assert.match(FENCE_MODEL, /^uain-provider-fence:fc00eabf[a-f0-9]{56}$/);
  const failing = createFencedProvider({ spawnImpl: (c, a, o) => spawnImpl(c, a, { ...o, exitCode: 1 }), checkUser: () => {} });
  await assert.rejects(failing.execute({ executionId: 'e-2', prompt: 'x' }), (e) => e.code === 'provider_outcome_unknown');
  await assert.rejects(provider.execute({ executionId: 'e-3', prompt: 'x'.repeat(65537) }), (e) => e.code === 'provider_prompt_too_large');
});

test('fence user check: root only, and the user must be exactly the qualified one', () => {
  const passwd = () => `root:x:0:0:root:/root:/bin/bash\n${FENCE_USER.name}:x:987:980::/var/lib/uain-central-reviewer:/usr/sbin/nologin\n`;
  checkFenceUser({ euid: 0, passwd });
  assert.throws(() => checkFenceUser({ euid: 987, passwd }), (e) => e.code === 'root_required');
  assert.throws(() => checkFenceUser({ euid: 0, passwd: () => `${FENCE_USER.name}:x:988:980::/var/lib/uain-central-reviewer:/bin/false\n` }), (e) => e.code === 'fence_user_mismatch');
  assert.throws(() => checkFenceUser({ euid: 0, passwd: () => 'root:x:0:0::/root:/bin/sh\n' }), (e) => e.code === 'fence_user_mismatch');
});

/* ------------------------------------------- reviewed candidate tasks (7 Nov) */

const CRATIONALE = {
  effort: 'FICTIONAL: under an hour of registry reading.', difficulty: 'FICTIONAL: verbatim extraction and one rule per row.',
  novelty: 'FICTIONAL: the reviewer found no open audit of this exact set.', verificationCost: 'FICTIONAL: one rerun of a fixed query.',
};
const cand = (project, slug, title, basis) => ({
  id: `${project.toLowerCase()}-${slug}`, title, criteria: `FICTIONAL criteria: submit one JSON artifact for ${slug} that passes every listed check.`,
  eligibility: 'new', eligibility_basis: basis, proposed_price: { solver_amount: String(200n * AID), reviewer_amount: String(50n * AID), rationale: CRATIONALE },
});
const CAND_A = cand(ID, 'fictional-outcome-audit', 'FICTIONAL senolytic outcome audit', 'FICTIONAL candidate basis A: no open audit of this set.');
const CAND_B = cand(ID, 'fictional-dosing-census', 'FICTIONAL senolytic dosing census', 'FICTIONAL candidate basis B: no open census of this set.');
const CAND_OTHER = cand('OPP-00003', 'fictional-clock-audit', 'FICTIONAL clock outcome audit', 'FICTIONAL candidate basis C: belongs to another project.');
const candidatesFile = (projects = { [ID]: [CAND_A, CAND_B], 'OPP-00003': [CAND_OTHER] }) => ({
  schema: 'uain-manager-candidates-v1', reviewed: { by: 'FICTIONAL reviewer', at: '2026-11-07', source: 'drafts.json', sourceDigest: 'd'.repeat(64) }, projects,
});
/** The manager adopts A and B as written, and adds one task of its own. */
const adopted = (c, extra = {}) => ({ title: c.title, criteria: c.criteria, eligibility: c.eligibility, eligibility_basis: c.eligibility_basis,
  candidate_id: c.id, proposed_price: { ...c.proposed_price }, ...extra });
const DERIVED = [
  adopted(CAND_A),
  adopted(CAND_B),
  { ...TASKS[0] },
];

test('candidates absent, or none for this project: the manager prompt, report and run record are exactly as before', async () => {
  const base = harness();
  await base.run();
  const prompt = base.provider.calls[1].prompt;
  assert.ok(!prompt.includes('candidate_tasks') && !prompt.includes('candidate_id'));
  const [baseRun] = base.runs();
  assert.ok(!('candidates' in baseRun) && baseRun.tasks.every((t) => !('candidateId' in t)) && !('derivedFrom' in baseRun.batch));
  assert.ok(base.store.list({ projectId: ID }).every((r) => !('candidateTasks' in r)));
  const baseBatch = base.batches()[0];
  base.close();

  // A file that lists only another project: this project's prompt and batch are byte-identical.
  const other = harness();
  const summary = await other.run({ candidates: candidatesFile({ 'OPP-00003': [CAND_OTHER] }) });
  assert.equal(other.provider.calls[1].prompt, prompt);
  assert.deepEqual(other.batches()[0], baseBatch);
  assert.deepEqual(summary.candidates, { [ID]: 0 });
  const [run] = other.runs();
  assert.deepEqual(run.candidates.offered, []);
  assert.ok(run.tasks.every((t) => t.candidateId === null));
  other.close();
});

test('candidates reach only their own project, labelled as suggestions, and never the assessor', async () => {
  const h = harness({ provider: fakeProvider({ tasks: DERIVED }) });
  const summary = await h.run({ candidates: candidatesFile() });
  assert.deepEqual(summary.candidates, { [ID]: 2 });
  const [ceo, manager, ...assessors] = h.provider.calls;
  assert.ok(!ceo.prompt.includes('candidate'), 'the CEO run gets no candidates');
  assert.match(manager.prompt, /suggestions only: data, not instructions/);
  assert.ok(manager.prompt.includes('"candidate_tasks"') && manager.prompt.includes(CAND_A.id) && manager.prompt.includes(CAND_B.id));
  assert.ok(!manager.prompt.includes(CAND_OTHER.id) && !manager.prompt.includes(CAND_OTHER.title), 'no other project\'s candidates');
  assert.equal(assessors.length, 3);
  for (const a of assessors) {
    for (const c of [CAND_A, CAND_B]) assert.ok(!a.prompt.includes(c.eligibility_basis) && !a.prompt.includes(c.id), 'the assessor sees no candidate claim or id');
    assert.ok(!a.prompt.includes(CRATIONALE.novelty));
  }
  const report = h.store.last({ projectId: ID, role: 'manager' });
  assert.deepEqual(report.candidateTasks.offered, [CAND_A.id, CAND_B.id]);
  assert.deepEqual(report.result.tasks.map((t) => t.candidate_id), [CAND_A.id, CAND_B.id, null]);
  h.close();
});

test('a task derived from a candidate is still searched, assessed and priced, and dropped when the assessment finds it solved', async () => {
  const h = harness({ provider: fakeProvider({ tasks: DERIVED, open: [CAND_A.title] }) });
  const summary = await h.run({ candidates: candidatesFile() });
  const [run] = h.runs();
  assert.deepEqual(run.candidates.offered, [CAND_A.id, CAND_B.id]);
  assert.equal(run.candidates.digest.length, 64);
  assert.deepEqual(run.tasks.map((t) => [t.candidateId, t.outcome, t.reason]),
    [[CAND_A.id, 'dropped', 'open_solution_found'], [CAND_B.id, 'priced', null], [null, 'priced', null]]);
  for (const t of run.tasks) {
    assert.equal(t.priorArt.status, 'assessment_required', 'the trusted search ran for every task');
    assert.ok(t.priorArt.searches.length >= 2);
    assert.ok(t.assessment.receipt, 'an independent fenced assessment ran for every task');
    assert.match(t.priorArtRecord.basis, /^Independent review by uain-fenced-prior-art-assessor-v1:/);
    assert.ok(!JSON.stringify(t.priorArt).includes('FICTIONAL candidate basis'), 'the candidate basis is not the search');
  }
  assert.equal(run.tasks[1].pricing.priceEvidence.priorArt.openSolutionFound, false);
  const [batch] = h.batches();
  assert.deepEqual(batch.requests.map((r) => r.id), [run.tasks[1].taskId, run.tasks[2].taskId]);
  assert.ok(!JSON.stringify(batch).includes(CAND_B.id), 'the signed requests carry no candidate id');
  assert.deepEqual(run.batch.derivedFrom, { [run.tasks[1].taskId]: CAND_B.id, [run.tasks[2].taskId]: null });
  assert.deepEqual(summary.runs[0].derived, [[CAND_A.id, 'dropped', 'open_solution_found'], [CAND_B.id, 'priced', null]]);
  h.close();

  // All derived tasks solved or known: no batch.
  const h2 = harness({ provider: fakeProvider({ tasks: DERIVED.slice(0, 2), open: [CAND_A.title], known: [DERIVED[1].title] }) });
  await h2.run({ candidates: candidatesFile() });
  assert.deepEqual(h2.runs()[0].tasks.map((t) => t.reason), ['open_solution_found', 'known_answer_not_rewardable']);
  assert.deepEqual(h2.batches(), []);
  h2.close();
});

test('candidate ids the manager was not offered are stripped; the task stays and is checked as its own', async () => {
  const tasks = [{ ...DERIVED[0], candidate_id: CAND_OTHER.id }, { ...DERIVED[2], candidate_id: 'opp-00002-never-offered' }];
  const h = harness({ provider: fakeProvider({ tasks }) });
  await h.run({ candidates: candidatesFile() });
  const report = h.store.last({ projectId: ID, role: 'manager' });
  assert.deepEqual(report.findings.filter((f) => f.code === 'unknown_candidate_stripped').map((f) => f.path), ['tasks.0.candidate_id', 'tasks.1.candidate_id']);
  assert.deepEqual(h.runs()[0].tasks.map((t) => [t.candidateId, t.outcome]), [[null, 'priced'], [null, 'priced']]);
  h.close();
  // Without a candidates file the field is unknown and stripped as before.
  const h2 = harness({ provider: fakeProvider({ tasks: [{ ...TASKS[0], candidate_id: CAND_A.id }] }) });
  await h2.run();
  const r2 = h2.store.last({ projectId: ID, role: 'manager' });
  assert.ok(r2.findings.some((f) => f.code === 'unexpected_field_stripped' && f.path === 'tasks.0.candidate_id'));
  assert.ok(!('candidate_id' in r2.result.tasks[0]));
  h2.close();
});

test('an invalid candidates file refuses the whole run before any native read or model call; check reports counts', async () => {
  const h = harness();
  for (const bad of [
    { ...candidatesFile(), extra: true },
    candidatesFile({ [ID]: [{ ...CAND_A, priorArt: { searches: [] } }] }),
    candidatesFile({ [ID]: [CAND_OTHER] }),
    candidatesFile({ [ID]: [{ ...CAND_A, criteria: CAND_A.criteria + ' Compare with OPP-00003 results.' }] }),
  ]) {
    await assert.rejects(h.run({ candidates: bad }), (e) => e.code === 'invalid_manager_candidates');
  }
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.status.calls.length, 0);
  const checked = await h.run({ check: true, candidates: candidatesFile() });
  assert.deepEqual(checked.candidates, { [ID]: 2 });
  assert.equal(h.provider.calls.length, 0);
  const without = await h.run({ check: true });
  assert.ok(!('candidates' in without));
  h.close();
});


test('candidate attribution rejects semantic mutation before search while unchanged selections keep independent checks', async () => {
  for (const [field, value] of Object.entries({
    title: 'Generic milestone evidence extraction',
    criteria: 'Submit a generic extraction artifact with no intervention or population scope.',
    eligibility: 'hard',
    eligibility_basis: 'An unrelated generic workflow eligibility claim.',
  })) {
    const h = harness({ provider: fakeProvider({ tasks: [adopted(CAND_A, { [field]: value }), adopted(CAND_B)] }) });
    await h.run({ candidates: candidatesFile() });
    const report = h.store.last({ projectId: ID, role: 'manager' });
    assert.ok(report.findings.some((f) => f.code === 'candidate_content_changed' && f.path === `tasks.0.${field}`), field);
    assert.deepEqual(report.result.tasks.map((t) => t.candidate_id), [CAND_B.id]);
    const [run] = h.runs();
    assert.deepEqual(run.tasks.map((t) => t.title), [CAND_B.title]);
    assert.equal(run.tasks[0].priorArt.status, 'assessment_required');
    assert.ok(run.tasks[0].assessment.receipt);
    assert.equal(run.tasks[0].outcome, 'priced');
    assert.equal(h.provider.calls.filter((c) => c.role === 'assessor').length, 1);
    h.close();
  }
});


test('candidate selection and prices remain manager proposals; ignoring all candidates is permitted', async () => {
  const selected = adopted(CAND_A, { proposed_price: { ...CAND_A.proposed_price, solver_amount: String(100n * AID) } });
  const h = harness({ provider: fakeProvider({ tasks: [selected] }) });
  await h.run({ candidates: candidatesFile() });
  const report = h.store.last({ projectId: ID, role: 'manager' });
  assert.equal(report.result.tasks[0].proposed_price.solver_amount, String(100n * AID));
  assert.equal(h.runs()[0].tasks[0].outcome, 'priced');
  h.close();
  const ignored = harness({ provider: fakeProvider({ tasks: [{ ...TASKS[0] }] }) });
  await ignored.run({ candidates: candidatesFile() });
  assert.deepEqual(ignored.runs()[0].tasks.map((t) => [t.candidateId, t.outcome]), [[null, 'priced']]);
  ignored.close();
});


function fairnessHarness() {
  const ids = ['OPP-00002', 'OPP-00003', 'OPP-00009'];
  const records = { coin_supply: { minted: '0', reserved: '0', transparent: '0', shielded: '0' }, central_task_count: String(ids.length) };
  const configuredPolicy = policy(); configuredPolicy.projects = {};
  for (const [i, id] of ids.entries()) {
    const project = 'P-' + id, survey = acceptedSurvey(id);
    Object.assign(records, survey.records, {
      ['project/' + project]: { id: project, state: 'active', lead: GUARDIAN, safety_halted: false },
      ['central_project_budget/' + project]: { project, manager: GUARDIAN, policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(1), round: 1, lifetime_ceiling: '1000000000000000', reserved: '0', paid: '250000000', height: '100', evidence_digest: 'b'.repeat(64) },
      ['central_fund_config/' + project]: { project, evaluator: FUND_MANAGER },
      ['central_fund_state/' + project]: { project, revision: 1, approved_revision: 1, completed: 0, pending: '' },
      ['central_fund_plan/' + project + '/' + pad(1)]: { project, revision: 1, state: 'accept', main_kpi: selection.get(id).mainKpi, stages: stages() },
      ['central_task_index/' + pad(i + 1)]: { id: survey.task.id, project },
      ['central_task/' + survey.task.id]: survey.task,
    });
    configuredPolicy.projects[id] = { ...policy().projects[ID], native_project: project, source_digest: selection.get(id).sourceDigest };
  }
  const attempted = [], provider = { fixture: false, model: 'fixture-refusal', async execute(input) { attempted.push(input.projectId); throw Error('FIXTURE deliberate refusal; no scientific work or external call'); } };
  const h = harness({ records, provider });
  return { h, ids, records, configuredPolicy, attempted };
}

function seedAttempt(h, id, hours, executions = 10, suffix = '') {
  const dir = join(h.stageRoot, 'runs', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture-history' + suffix + '.json'), JSON.stringify({ project: id, startedAt: new Date(T0 - hours * 3600e3).toISOString(), executions, status: 'no_rewardable_tasks' }));
}
async function fairRun(f, extra = {}) {
  const requested = [...f.ids], cfg = config({ projects: [...f.ids], max_executions_per_day: 30 }), before = JSON.stringify({ requested, cfg });
  const result = await f.h.run({ projects: requested, config: cfg, policy: f.configuredPolicy, ...extra });
  assert.equal(JSON.stringify({ requested, cfg }), before, 'priority must not mutate configuration or requested order');
  assert.equal(result.batches.length, 0);
  return result;
}
test('fairness: a never-run eligible project precedes earlier configured recently-attempted projects', async t => {
  const f = fairnessHarness(); t.after(() => f.h.close()); seedAttempt(f.h, f.ids[0], 7); seedAttempt(f.h, f.ids[1], 8);
  const result = await fairRun(f); assert.equal(result.executionsLast24h, 20); assert.equal(result.runs[0]?.project, 'OPP-00009'); assert.deepEqual(f.attempted, ['OPP-00009']);
});
test('fairness: least-recent attempt wins after every eligible project was tried', async t => {
  const f = fairnessHarness(); t.after(() => f.h.close()); seedAttempt(f.h, f.ids[0], 7, 1); seedAttempt(f.h, f.ids[1], 9, 1); seedAttempt(f.h, f.ids[2], 8, 1);
  assert.equal((await fairRun(f)).runs[0]?.project, 'OPP-00003'); assert.deepEqual(f.attempted, ['OPP-00003']);
});
test('fairness: configured order breaks never-run and equal-attempt ties, including reversed requested order', async t => {
  for (const tried of [false, true]) { const f = fairnessHarness(); t.after(() => f.h.close()); if (tried) for (const id of f.ids) seedAttempt(f.h, id, 7, 1);
    const requested = [...f.ids].reverse(), before = [...requested]; const result = await fairRun(f, { projects: requested }); assert.equal(result.runs[0]?.project, 'OPP-00002'); assert.deepEqual(requested, before); }
});
test('fairness: cooldown and accepted-survey eligibility still prevent priority from calling a provider', async t => {
  for (const held of ['cooldown', 'survey']) { const f = fairnessHarness(); t.after(() => f.h.close()); seedAttempt(f.h, f.ids[0], 7, 1); seedAttempt(f.h, f.ids[1], 8, 1);
    if (held === 'cooldown') seedAttempt(f.h, f.ids[2], 1, 1); else { const task = f.records['central_task/T-OPP-00009-1-prior-art-survey']; task.state = 'under_review'; task.winner = ''; }
    const result = await fairRun(f); assert.equal(result.runs[0]?.project, 'OPP-00003'); assert.deepEqual(f.attempted, ['OPP-00003']); assert.equal(result.skipped.find(x => x.project === 'OPP-00009').reason, held === 'cooldown' ? 'execution_outcome_unknown' : 'prior_art_survey_required'); }
});
test('fairness: 22 rolling executions still hold every eligible project at the unchanged 30/worst-case10 admission', async t => {
  const f = fairnessHarness(); t.after(() => f.h.close()); seedAttempt(f.h, f.ids[0], 7); seedAttempt(f.h, f.ids[0], 20, 2, '-older'); seedAttempt(f.h, f.ids[1], 8);
  const result = await fairRun(f); assert.equal(result.executionsLast24h, 22); assert.deepEqual(result.runs, []); assert.deepEqual(f.attempted, []); assert(result.skipped.every(x => x.reason === 'daily_execution_budget'));
});


const boundedConfig = () => config({ max_executions_per_day: 30, max_tasks_per_project_run: 1 });
test('bounded planning: explicit one-task mode fits 22+3 within unchanged30 and records its pre-dispatch claim', async t => {
  const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close());
  seedAttempt(h, ID, 7, 10); seedAttempt(h, ID, 15, 10, '-2'); seedAttempt(h, ID, 22, 2, '-3');
  const result = await h.run({ config: boundedConfig() }); assert.equal(result.executionsLast24h, 22); assert.equal(result.runs.length, 1); assert.equal(h.provider.calls.length, 3);
  const run = h.runs().find(r => r.runId); assert.equal(run.executions, 3); assert.match(run.executionClaimDigest, /^[a-f0-9]{64}$/);
  const dir = join(h.stageRoot, 'execution-claims', ID), claims = readdirSync(dir).filter(n => n.endsWith('.json')); assert.equal(claims.length, 1);
  const claim = JSON.parse(readFileSync(join(dir, claims[0]), 'utf8')); assert.equal(claim.maxProviderCalls, 3); assert.equal(claim.maxTasks, 1); assert.equal(claim.runId, run.runId);
});
test('bounded planning: oversized raw task array refuses before any search or assessor and charges both leadership calls', async t => {
  const h = harness(); t.after(() => h.close()); let searches = 0; h.priorArt = { async run() { searches++; throw Error('Fixture must never reach retrieval'); } };
  const result = await h.run({ config: boundedConfig() }); assert.equal(result.runs[0].status, 'manager_refused'); assert.equal(result.runs[0].reason, 'task_execution_bound_exceeded'); assert.equal(searches, 0); assert.equal(h.provider.calls.length, 2); assert.equal(h.runs()[0].executions, 2); assert.deepEqual(result.batches, []);
});
test('bounded planning: unknown provider outcome charges full bound and cannot resume with a new ID', async t => {
  let calls = 0; const h = harness({ provider: { fixture: false, model: 'fixture', async execute() { calls++; throw Error('FICTIONAL unknown'); } } }); t.after(() => h.close());
  await h.run({ config: boundedConfig() }); h.setNow(T0 + 7 * 3600e3);
  const held = await h.run({ config: boundedConfig() }); assert.equal(held.executionsLast24h, 3); assert.deepEqual(held.runs, []); assert.equal(held.skipped[0].reason, 'execution_outcome_unknown'); assert.equal(calls, 1);
  h.setNow(T0 + 25 * 3600e3); const older = await h.run({ config: boundedConfig() }); assert.deepEqual(older.runs, []); assert.equal(calls, 1);
});
test('bounded planning: missing terminal after a retained claim stays charged/held without another provider call', async t => {
  const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close()); await h.run({ config: boundedConfig() });
  const runDir = join(h.stageRoot, 'runs', ID); for (const n of readdirSync(runDir)) unlinkSync(join(runDir, n)); const calls = h.provider.calls.length; h.setNow(T0 + 7 * 3600e3);
  const held = await h.run({ config: boundedConfig() }); assert.equal(held.executionsLast24h, 3); assert.equal(held.skipped[0].reason, 'execution_outcome_unknown'); assert.equal(h.provider.calls.length, calls);
});
test('bounded planning: corrupt/duplicate/foreign claims and missing terminal binding fail closed before dispatch', async t => {
  for (const mode of ['corrupt', 'duplicate', 'foreign', 'missing']) { const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close()); await h.run({ config: boundedConfig() }); const d = join(h.stageRoot, 'execution-claims', ID), p = join(d, readdirSync(d).find(n => n.endsWith('.json'))), claim = JSON.parse(readFileSync(p, 'utf8'));
    if (mode === 'missing') unlinkSync(p); else if (mode === 'duplicate') copyFileSync(p, join(d, 'duplicate.json')); else { claim[mode === 'foreign' ? 'project' : 'maxProviderCalls'] = mode === 'foreign' ? 'OPP-00009' : 2; writeFileSync(p, JSON.stringify(claim), { mode: 0o600 }); }
    const calls = h.provider.calls.length; h.setNow(T0 + 7 * 3600e3); await assert.rejects(h.run({ config: boundedConfig() }), e => /execution_claim/.test(e.code)); assert.equal(h.provider.calls.length, calls);
  }
});

test('bounded planning: all limits1..8 validate and default8 keeps the exact legacy provider prompts', async t => {
  for (const limit of [undefined, ...Array.from({ length: 8 }, (_, i) => i + 1)]) {
    const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close());
    await h.run({ config: config(limit === undefined ? {} : { max_tasks_per_project_run: limit }) });
    assert.equal(h.provider.calls.length, 3);
    if (limit === undefined) t.defaultPrompts = h.provider.calls.map(c => c.prompt);
    if (limit === 8) assert.deepEqual(h.provider.calls.map(c => c.prompt), t.defaultPrompts);
  }
  for (const limit of [0, 9, true, '1', 1.5, null]) {
    const h = harness(); t.after(() => h.close()); await assert.rejects(h.run({ config: config({ max_tasks_per_project_run: limit }) }), { code: 'invalid_manager_stage_config' }); assert.equal(h.provider.calls.length, 0);
  }
});

test('bounded planning: exact27+3 admission fits and28+3 holds without lifting30', async t => {
  for (const used of [27, 28]) {
    const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close()); seedAttempt(h, ID, 7, 10); seedAttempt(h, ID, 8, 10, '-2'); seedAttempt(h, ID, 9, used - 20, '-3');
    const result = await h.run({ config: boundedConfig() }); assert.equal(result.runs.length, used === 27 ? 1 : 0); assert.equal(h.provider.calls.length, used === 27 ? 3 : 0);
    if (used === 28) assert.equal(result.skipped[0].reason, 'daily_execution_budget');
  }
});

test('bounded planning: claim and exact attempt are already durable before each provider callback', async t => {
  const original = fakeProvider({ tasks: [TASKS[0]] }); let h;
  const provider = { ...original, async execute(input) {
    const d = join(h.stageRoot, 'execution-claims', ID), claimFile = readdirSync(d).find(n => n.endsWith('.json'));
    assert(claimFile); const claim = JSON.parse(readFileSync(join(d, claimFile), 'utf8'));
    const attempts = readdirSync(join(d, claimFile + '.attempts')).sort().map(n => JSON.parse(readFileSync(join(d, claimFile + '.attempts', n), 'utf8')));
    assert.equal(attempts.at(-1).id, input.executionId); assert.equal(attempts.at(-1).claimDigest, claim.claimDigest); assert.equal(attempts.length, original.calls.length + 1);
    return original.execute(input);
  } };
  h = harness({ provider }); t.after(() => h.close()); await h.run({ config: boundedConfig() }); assert.equal(original.calls.length, 3);
});

test('bounded planning: legacy unknown assessor outcomes remain held instead of assumed unused', async t => {
  const h = harness(); t.after(() => h.close()); const d = join(h.stageRoot, 'runs', ID); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'legacy.json'), JSON.stringify({ project: ID, startedAt: new Date(T0 - 7 * 3600e3).toISOString(), status: 'no_rewardable_tasks', executions: 3, tasks: [{ assessment: { reason: 'provider_outcome_unknown' } }] }));
  await assert.rejects(h.run({ config: boundedConfig() }), { code: 'legacy_run_unresolved' }); assert.equal(h.provider.calls.length, 0);
});

test('bounded planning: unknown attempt with deleted claim AND terminal cannot become unused', async t => {
  const h = harness({ provider: { fixture: false, model: 'fixture', async execute() { throw Error('FICTIONAL unknown'); } } }); t.after(() => h.close());
  await h.run({ config: boundedConfig() });
  for (const dir of [join(h.stageRoot, 'execution-claims', ID), join(h.stageRoot, 'runs', ID)]) for (const name of readdirSync(dir)) if (name.endsWith('.json')) unlinkSync(join(dir, name));
  h.setNow(T0 + 7 * 3600e3); await assert.rejects(h.run({ config: boundedConfig() }), { code: 'execution_claim_invalid' });
});

test('bounded planning: malformed present legacy counts cannot subtract or free execution allowance', async t => {
  for (const count of [-1, 1.5, '1', null]) {
    const h = harness(); t.after(() => h.close()); seedAttempt(h, ID, 7, count);
    await assert.rejects(h.run({ config: boundedConfig() }), { code: 'execution_claim_invalid' }); assert.equal(h.provider.calls.length, 0);
  }
});

test('bounded planning: protected claim symlinks/hardlinks and unrecognized inventory hold', async t => {
  for (const mode of ['symlink', 'hardlink', 'unknown']) {
    const h = harness({ provider: fakeProvider({ tasks: [TASKS[0]] }) }); t.after(() => h.close()); await h.run({ config: boundedConfig() });
    const dir = join(h.stageRoot, 'execution-claims', ID), p = join(dir, readdirSync(dir).find(n => n.endsWith('.json'))), saved = join(h.stageRoot, 'retained-claim');
    if (mode === 'unknown') writeFileSync(join(dir, 'unexpected'), 'fixture');
    else if (mode === 'hardlink') linkSync(p, saved);
    else { copyFileSync(p, saved); unlinkSync(p); symlinkSync(saved,p); }
    h.setNow(T0 + 7 * 3600e3); const before = h.provider.calls.length;
    await assert.rejects(h.run({ config: boundedConfig() }), { code: 'execution_claim_invalid' }); assert.equal(h.provider.calls.length,before);
  }
});

test('bounded planning: concurrent identical reservation publishes one immutable claim without overwrite', async t => {
  const h = harness(); t.after(() => h.close());
  const moduleURL = new URL('../src/manager-execution-claims.mjs', import.meta.url).href;
  const code = `import {reserveExecutionClaim} from ${JSON.stringify(moduleURL)};process.send('ready');process.on('message',()=>{try{reserveExecutionClaim(JSON.parse(process.argv[1]));process.send('accepted');process.exit(0)}catch{process.send('refused');process.exit(1)}});`;
  const request = {stageRoot:h.stageRoot,project:ID,runId:'00000000-0000-4000-8000-000000009999',startedAt:new Date(T0).toISOString(),configDigest:'d'.repeat(64),maxTasks:1};
  const children = [0,1].map(() => spawn(process.execPath,['--input-type=module','-e',code,JSON.stringify(request)],{stdio:['ignore','ignore','ignore','ipc']}));
  const results = children.map(child => new Promise(resolve => child.on('exit',resolve)));
  await Promise.all(children.map(child => new Promise(resolve => child.once('message',resolve))));
  for (const child of children) child.send('go');
  assert.deepEqual((await Promise.all(results)).sort(),[0,1]);
  const dir=join(h.stageRoot,'execution-claims',ID), names=readdirSync(dir).filter(n=>n.endsWith('.json')); assert.equal(names.length,1);
  const stored=JSON.parse(readFileSync(join(dir,names[0]),'utf8')); assert.equal(stored.runId,request.runId); assert.equal(stored.maxProviderCalls,3);
});

test('bounded planning: contradictory known terminal cannot hide retained provider uncertainty', async t => {
  const h=harness({provider:{fixture:false,model:'fixture',async execute(){throw Error('FICTIONAL unknown');}}});t.after(()=>h.close());
  await h.run({config:boundedConfig()});const dir=join(h.stageRoot,'runs',ID),p=join(dir,readdirSync(dir)[0]),r=JSON.parse(readFileSync(p,'utf8'));r.executionOutcomeUnknown=false;writeFileSync(p,JSON.stringify(r));h.setNow(T0+7*3600e3);
  await assert.rejects(h.run({config:boundedConfig()}),{code:'execution_claim_invalid'});
});

test('bounded planning: reused execution ID in a fresh run immediately holds without another provider call', async t => {
  const h=harness({provider:fakeProvider({tasks:[TASKS[0]]})});t.after(()=>h.close());await h.run({config:boundedConfig()});
  const reused=h.runs()[0].executionAttempts[0].id,before=h.provider.calls.length;h.setNow(T0+7*3600e3);let n=0;
  await h.run({config:boundedConfig(),newId:()=>++n===1?'00000000-0000-4000-8000-000000008888':reused});
  assert.equal(h.provider.calls.length,before);const run=h.runs().find(r=>r.runId.endsWith('008888'));assert.equal(run.reason,'provider_outcome_unknown');assert.equal(run.executionOutcomeUnknown,true);assert.equal(run.executions,0);
  const held=await h.run({config:boundedConfig()});assert.equal(held.executionsLast24h,6);assert.equal(held.skipped[0].reason,'execution_outcome_unknown');assert.equal(h.provider.calls.length,before);
});

test('bounded planning: unknown pre-dispatch assessor stops before a later unique assessor', async t => {
  const h=harness({provider:fakeProvider({tasks:TASKS.slice(0,2)})});t.after(()=>h.close());let n=0;
  const newId=()=>`00000000-0000-4000-8000-${String(++n===6?3:n).padStart(12,'0')}`;
  await h.run({config:config({max_executions_per_day:30,max_tasks_per_project_run:2}),newId});
  assert.equal(h.provider.calls.length,2,'duplicate first assessor must not continue to a fresh second assessor');
  const run=h.runs()[0];assert.equal(run.executionOutcomeUnknown,true);assert.equal(run.executions,2);assert.equal(run.status,'manager_refused');assert.equal(run.reason,'provider_outcome_unknown');assert.equal(run.batch,null);
});

test('bounded planning: default eight-task ten-call terminal remains readable without replay', async t => {
  const tasks=Array.from({length:8},(_,i)=>({...structuredClone(TASKS[0]),title:TASKS[0].title+' variant '+(i+1),proposed_price:{...structuredClone(TASKS[0].proposed_price),solver_amount:'100000000',reviewer_amount:'10000000'}}));
  const h=harness({provider:fakeProvider({tasks})});t.after(()=>h.close());
  await h.run();assert.equal(h.provider.calls.length,10);assert.equal(h.runs()[0].executions,10);
  const retained=await h.run();assert.equal(retained.executionsLast24h,10);assert.equal(skippedFor(retained),'cooldown');assert.equal(h.provider.calls.length,10);
});
test('an unresolved provider outcome in one project does not hold another project (9 Nov 2026)', async t => {
  const { reserveExecutionClaim, executionHistory } = await import('../src/manager-execution-claims.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { randomUUID } = await import('node:crypto');
  const root = mkdtempSync(join(tmpdir(), 'claims-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = '2026-11-09T10:00:00.000Z', config = 'a'.repeat(64);
  reserveExecutionClaim({ stageRoot: root, project: 'OPP-00003', runId: randomUUID(), startedAt: at, configDigest: config, maxTasks: 1 });
  assert.deepEqual(executionHistory(root, [], Date.parse(at)).unresolved.map(u => u.project), ['OPP-00003']);
  assert.doesNotThrow(() => reserveExecutionClaim({ stageRoot: root, project: 'OPP-00009', runId: randomUUID(), startedAt: '2026-11-09T10:00:01.000Z', configDigest: config, maxTasks: 1 }));
  assert.throws(() => reserveExecutionClaim({ stageRoot: root, project: 'OPP-00003', runId: randomUUID(), startedAt: '2026-11-09T10:00:02.000Z', configDigest: config, maxTasks: 1 }), { code: 'execution_outcome_unknown' });
});
