import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as pricing from '../src/pricing.mjs';
import { PRIOR_ART_SCHEMA, SUPPLY_CAP_UNITS, applyReservation, budgetAccounting, validatePricedTask } from '../src/pricing.mjs';
import { SELECTION_PATH, validateSelection } from '../src/selection.mjs';
import { digest, sha256 } from '../src/common.mjs';
import { CENTRAL_POLICY, centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';

const AID = 1_000_000n;
const aid = (n) => (BigInt(n) * AID).toString();
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const NATIVE_TASK_OPEN_FIELDS = ['id', 'project', 'title', 'criteria', 'acceptance_digest', 'eligibility', 'eligibility_digest',
  'solver_amount', 'reviewer_amount', 'evidence_digest'];
/** Cumulative ceilings in AI$ from the plan; native central-budget must agree. */
const CEILINGS_AID = [10_000, 110_000, 1_110_000, 11_110_000, 111_110_000, 1_000_000_000];

const task = (overrides = {}) => ({
  id: 'T-OPP-00002-r1-001',
  projectId: 'OPP-00002',
  milestoneRound: 1,
  planRevision: 1,
  title: 'Reproduce senolytic clearance assay on the pinned dataset',
  criteria: 'Independent rerun of the pinned analysis driver reproduces the reported clearance ratio within 1%.',
  eligibility: 'unresolved',
  solverAmount: aid(4000),
  reviewerAmount: aid(1000),
  rationale: {
    effort: 'About three days of bounded analysis on a pinned public dataset.',
    difficulty: 'Requires a new estimator; no published method covers this cohort.',
    novelty: 'No open analysis of this cohort exists; see the prior-art searches.',
    verificationCost: 'One independent rerun of the fixed driver, roughly one hour.',
  },
  evidenceDigest: 'a'.repeat(64),
  ...overrides,
});
const stages = () => [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Stage ${round}: an independently verifiable sub-KPI result.` }));
const plan = (overrides = {}) => ({ projectId: 'OPP-00002', revision: 1, approved: true, stages: stages(), currentRound: 1, mainKpiAchieved: false, ...overrides });
const priorArt = (overrides = {}) => ({
  basis: 'No open-source implementation or published result answers this question for the pinned cohort.',
  searches: [
    { query: 'senolytic clearance ratio cohort estimator', source: 'https://scholar.google.com', observedAt: '2026-11-05T10:00:00Z', resultSummary: 'No matching method or dataset analysis found.' },
    { query: 'senolytic clearance estimator', source: 'https://github.com', observedAt: '2026-11-05T10:05:00Z', resultSummary: 'No repository implements this estimator.' },
  ],
  knownAnswer: false,
  openSolutionFound: false,
  ...overrides,
});
const budget = (round = 1, overrides = {}) => ({
  project: 'P-OPP-00002',
  manager: 'uain1' + 'c'.repeat(40),
  policy: CENTRAL_POLICY,
  allocation: centralUnlockedUnits(round),
  reserved: '0',
  paid: '0',
  round,
  lifetime_ceiling: '1000000000000000',
  height: '120',
  evidence_digest: 'b'.repeat(64),
  ...overrides,
});
const supply = (overrides = {}) => ({ cap: SUPPLY_CAP_UNITS.toString(), issued: '0', reserved: '1100000', ...overrides });
const input = (overrides = {}) => ({ task: task(), approvedPlan: plan(), priorArt: priorArt(), budget: budget(), supply: supply(), existingTaskIds: [], ...overrides });
/** A task/plan/budget triple for a given milestone round. */
const atRound = (round, taskOverrides = {}, budgetOverrides = {}) => input({
  task: task({ milestoneRound: round, ...taskOverrides }),
  approvedPlan: plan({ currentRound: round }),
  budget: budget(round, budgetOverrides),
});

test('the six cumulative ceilings are exactly the plan values and increments', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(centralUnlockedUnits), CEILINGS_AID.map(aid));
  const increments = CEILINGS_AID.map((c, i) => c - (CEILINGS_AID[i - 1] ?? 0));
  assert.deepEqual(increments, [10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 888_890_000]);
  assert.equal(centralUnlockedUnits(0), null);
  assert.equal(centralUnlockedUnits(7), null);
});

test('a priced task within the 10,000 AI$ opening allowance yields the exact native central_task_open payload', () => {
  const result = validatePricedTask(input());
  const p = result.nativePayload;
  assert.deepEqual(Object.keys(p).sort(), [...NATIVE_TASK_OPEN_FIELDS].sort());
  assert.deepEqual(centralPayload('central_task_open', { ...p }), p, 'native validator accepts it unchanged');
  assert.ok(Object.isFrozen(p));
  assert.equal(p.id, 'T-OPP-00002-r1-001');
  assert.equal(p.project, 'P-OPP-00002');
  assert.equal(p.title, task().title);
  assert.equal(p.criteria, task().criteria);
  assert.equal(p.acceptance_digest, sha256(task().criteria));
  assert.equal(p.eligibility, 'unresolved');
  assert.equal(p.eligibility_digest, digest({ schema: PRIOR_ART_SCHEMA, ...priorArt() }));
  assert.equal(p.solver_amount, aid(4000));
  assert.equal(p.reviewer_amount, aid(1000));
  assert.equal(p.evidence_digest, result.priceDigest);
  assert.equal(result.priceDigest, digest(result.priceEvidence));
  assert.equal(result.totalUnits, aid(5000));
  assert.equal(result.availableUnits, aid(10_000));
});

test('price evidence retains the rationale, criteria, plan revision, prior art and the budget it was priced against', () => {
  const { priceEvidence } = validatePricedTask(input());
  assert.deepEqual(priceEvidence.task, task());
  assert.equal(priceEvidence.plan.revision, 1);
  assert.equal(priceEvidence.plan.currentRound, 1);
  assert.equal(priceEvidence.plan.stagesDigest, digest(stages()));
  assert.deepEqual(priceEvidence.priorArt.searches, priorArt().searches);
  assert.deepEqual(priceEvidence.budget, budget());
  assert.deepEqual(priceEvidence.supply, supply());
});

test('the price digest is deterministic and bound to every input', () => {
  const base = validatePricedTask(input()).priceDigest;
  assert.equal(validatePricedTask(input()).priceDigest, base);
  for (const changed of [
    input({ task: task({ rationale: { ...task().rationale, effort: 'About five days of bounded analysis instead.' } }) }),
    input({ task: task({ evidenceDigest: 'd'.repeat(64) }) }),
    input({ budget: budget(1, { reserved: aid(1) }) }),
    input({ supply: supply({ issued: '5' }) }),
    input({ priorArt: priorArt({ basis: 'A different documented prior-art basis for this task.' }) }),
    input({ approvedPlan: plan({ stages: stages().map((s) => ({ ...s, criteria: s.criteria + ' (revised)' })) }) }),
  ]) assert.notEqual(validatePricedTask(changed).priceDigest, base);
});

test('there is no fixed stars-to-money conversion: the manager-set amounts pass through unchanged', () => {
  assert.ok(!Object.keys(pricing).some((name) => /star|rate|convert/i.test(name)));
  const cheap = validatePricedTask(input({ task: task({ solverAmount: '1', reviewerAmount: '1' }) }));
  const dear = validatePricedTask(input({ task: task({ solverAmount: aid(9999), reviewerAmount: '1000000' }) }));
  assert.equal(cheap.nativePayload.solver_amount, '1');
  assert.equal(cheap.totalUnits, '2');
  assert.equal(dear.totalUnits, aid(10_000));
  refuses(() => validatePricedTask(input({ task: { ...task(), stars: 5 } })), 'invalid_task');
});

test('exactly the opening allowance is accepted; one micro-unit more is refused', () => {
  assert.equal(validatePricedTask(input({ task: task({ solverAmount: aid(9000), reviewerAmount: aid(1000) }) })).totalUnits, aid(10_000));
  refuses(() => validatePricedTask(input({ task: task({ solverAmount: aid(9000), reviewerAmount: (BigInt(aid(1000)) + 1n).toString() }) })),
    'insufficient_project_allowance');
});

test('exact tier boundaries: each of the five spendable cumulative ceilings', () => {
  for (let round = 1; round <= 5; round++) {
    const ceiling = BigInt(centralUnlockedUnits(round));
    const reviewer = 1_000_000n;
    const exact = atRound(round, { solverAmount: (ceiling - reviewer).toString(), reviewerAmount: reviewer.toString() });
    const r = validatePricedTask(exact);
    assert.equal(r.totalUnits, ceiling.toString(), `round ${round} ceiling accepted`);
    assert.equal(r.availableUnits, ceiling.toString());
    refuses(() => validatePricedTask(atRound(round, { solverAmount: (ceiling - reviewer + 1n).toString(), reviewerAmount: reviewer.toString() })),
      'insufficient_project_allowance');
    // After spending everything unlocked by the earlier rounds, only the new increment remains.
    const prior = round === 1 ? 0n : BigInt(centralUnlockedUnits(round - 1));
    const increment = ceiling - prior;
    const spent = { paid: (prior / 2n).toString(), reserved: (prior - prior / 2n).toString() };
    const fresh = validatePricedTask(atRound(round, { solverAmount: (increment - reviewer).toString(), reviewerAmount: reviewer.toString() }, spent));
    assert.equal(fresh.availableUnits, increment.toString(), `round ${round} increment available`);
    refuses(() => validatePricedTask(atRound(round, { solverAmount: (increment - reviewer + 1n).toString(), reviewerAmount: reviewer.toString() }, spent)),
      'insufficient_project_allowance');
  }
});

test('the sixth ceiling exists only after Main KPI achievement, when native refuses new tasks', () => {
  refuses(() => validatePricedTask(atRound(5, {}, { round: 6, allocation: centralUnlockedUnits(6), main_kpi_achieved: true })), 'project_main_kpi_achieved');
  refuses(() => validatePricedTask(atRound(5, {}, { round: 6, allocation: centralUnlockedUnits(6) })), 'invalid_budget');
  assert.equal(budgetAccounting(budget(6, { main_kpi_achieved: true })).available, BigInt(aid(1_000_000_000)));
});

test('an allocation that is not the cumulative ceiling for its round is refused', () => {
  refuses(() => validatePricedTask(input({ budget: budget(1, { allocation: centralUnlockedUnits(2) }) })), 'budget_allocation_mismatch');
  refuses(() => validatePricedTask(input({ budget: budget(1, { allocation: '10000000001' }) })), 'budget_allocation_mismatch');
  refuses(() => validatePricedTask(atRound(2, {}, { allocation: centralUnlockedUnits(1) })), 'budget_allocation_mismatch');
  for (const round of [0, 7, 1.5, '1']) refuses(() => validatePricedTask(input({ budget: budget(1, { round }) })), 'invalid_budget');
});

test('competing reservations: each fits a fresh snapshot alone, but after the first reserves the second is refused', () => {
  const snapshot = budget(1, { paid: aid(1000), reserved: aid(1000) });
  const first = input({ task: task({ id: 'T-a', solverAmount: aid(4000), reviewerAmount: aid(1000) }), budget: snapshot });
  const second = input({ task: task({ id: 'T-b', solverAmount: aid(3500), reviewerAmount: aid(500) }), budget: snapshot });
  const a = validatePricedTask(first);
  const b = validatePricedTask(second);
  assert.equal(a.availableUnits, aid(8000));
  assert.equal(b.availableUnits, aid(8000));
  assert.ok(BigInt(a.totalUnits) + BigInt(b.totalUnits) > BigInt(a.availableUnits), 'jointly they overspend');
  const after = applyReservation(snapshot, a.totalUnits);
  assert.equal(after.reserved, aid(6000));
  assert.equal(snapshot.reserved, aid(1000), 'the original snapshot is not mutated');
  refuses(() => validatePricedTask({ ...second, budget: after, existingTaskIds: ['T-a'] }), 'insufficient_project_allowance');
  refuses(() => applyReservation(after, b.totalUnits), 'insufficient_project_allowance');
  // The second task still fits whatever genuinely remains if it is repriced.
  const repriced = validatePricedTask({ ...second, task: task({ id: 'T-b', solverAmount: aid(2500), reviewerAmount: aid(500) }), budget: after, existingTaskIds: ['T-a'] });
  assert.equal(repriced.availableUnits, aid(3000));
  const full = applyReservation(after, BigInt(repriced.totalUnits));
  assert.equal(budgetAccounting(full).available, 0n);
  refuses(() => validatePricedTask({ ...second, task: task({ id: 'T-c', solverAmount: '1', reviewerAmount: '1' }), budget: full }), 'insufficient_project_allowance');
});

test('applyReservation refuses malformed amounts, closed and achieved projects', () => {
  for (const bad of ['0', '-1', '1.0', 0, 0n, -5n, '01']) refuses(() => applyReservation(budget(), bad), 'invalid_amount');
  refuses(() => applyReservation(budget(1, { closed: true }), '1'), 'project_closed');
  refuses(() => applyReservation(budget(6, { main_kpi_achieved: true }), '1'), 'project_main_kpi_achieved');
  refuses(() => applyReservation(budget(1, { allocation: '1' }), '1'), 'budget_allocation_mismatch');
  assert.ok(Object.isFrozen(applyReservation(budget(), '1')));
});

test('malformed, floating, exponent, zero and overflowing amounts are refused', () => {
  const bad = ['1.5', '1.0', '1e6', '1E6', '01', '00', '0', '', ' 1', '1 ', '-1', '+1', '0x10', '١٢', '1_000',
    '10000000000000001', '1000000000000001', 1000, 1000n, null, undefined, {}];
  for (const amount of bad) {
    refuses(() => validatePricedTask(input({ task: task({ solverAmount: amount }) })), 'invalid_amount');
    refuses(() => validatePricedTask(input({ task: task({ reviewerAmount: amount }) })), 'invalid_amount');
  }
  refuses(() => validatePricedTask(input({ task: task({ solverAmount: '1000000000000000', reviewerAmount: '1' }) })), 'invalid_amount');
  // The lifetime itself is a valid amount, but no single round can afford it.
  refuses(() => validatePricedTask(atRound(5, { solverAmount: '999999999999999', reviewerAmount: '1' })), 'insufficient_project_allowance');
});

test('a task without an approved plan, or not bound to its current revision and round, is refused', () => {
  refuses(() => validatePricedTask(input({ approvedPlan: undefined })), 'plan_not_approved');
  refuses(() => validatePricedTask(input({ approvedPlan: null })), 'plan_not_approved');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ approved: false }) })), 'plan_not_approved');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ approved: 'true' }) })), 'plan_not_approved');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ stages: stages().slice(0, 4) }) })), 'invalid_plan');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ stages: [...stages(), { round: 6, criteria: 'A sixth sub-KPI is never allowed.' }] }) })), 'invalid_plan');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ stages: stages().reverse() }) })), 'invalid_plan');
  refuses(() => validatePricedTask(input({ approvedPlan: { ...plan(), reviewer: 'self' } })), 'invalid_plan');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ revision: 2 }) })), 'plan_revision_mismatch');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ currentRound: 2 }) })), 'milestone_round_mismatch');
  refuses(() => validatePricedTask(input({ task: task({ milestoneRound: 2 }), approvedPlan: plan({ currentRound: 2 }) })), 'milestone_round_mismatch');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ projectId: 'OPP-00003' }) })), 'plan_project_mismatch');
  refuses(() => validatePricedTask(input({ approvedPlan: plan({ mainKpiAchieved: true }) })), 'project_main_kpi_achieved');
});

test('a duplicate task id is refused', () => {
  refuses(() => validatePricedTask(input({ existingTaskIds: ['T-OPP-00002-r1-001'] })), 'duplicate_task');
  refuses(() => validatePricedTask(input({ existingTaskIds: new Set(['x', 'T-OPP-00002-r1-001']) })), 'duplicate_task');
  assert.ok(validatePricedTask(input({ existingTaskIds: undefined })));
  refuses(() => validatePricedTask(input({ existingTaskIds: 'T-OPP-00002-r1-001' })), 'invalid_existing_task_ids');
  refuses(() => validatePricedTask(input({ existingTaskIds: [1] })), 'invalid_existing_task_ids');
});

test('known answers, discoverable open solutions and unsupported novelty are not rewardable', () => {
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ knownAnswer: true }) })), 'known_answer_not_rewardable');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ openSolutionFound: true }) })), 'open_solution_found');
  refuses(() => validatePricedTask(input({ priorArt: undefined })), 'prior_art_basis_missing');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ basis: '' }) })), 'prior_art_basis_missing');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ basis: '   novel, trust me   ' }) })), 'prior_art_basis_missing');
  const { basis, ...noBasis } = priorArt();
  assert.ok(basis);
  refuses(() => validatePricedTask(input({ priorArt: noBasis })), 'prior_art_basis_missing');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ searches: [] }) })), 'insufficient_prior_art_searches');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ searches: priorArt().searches.slice(0, 1) }) })), 'insufficient_prior_art_searches');
  const one = priorArt().searches[0];
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ searches: [one, { ...one, observedAt: '2026-11-05T11:00:00Z' }] }) })),
    'insufficient_prior_art_searches');
  refuses(() => validatePricedTask(input({ priorArt: priorArt({ knownAnswer: 'no' }) })), 'invalid_prior_art');
  refuses(() => validatePricedTask(input({ priorArt: { ...priorArt(), verdict: 'novel' } })), 'invalid_prior_art');
  for (const search of [{ ...one, observedAt: 'yesterday' }, { ...one, query: '' }, { ...one, resultSummary: 'none' }, { ...one, extra: 1 }, 'search'])
    refuses(() => validatePricedTask(input({ priorArt: priorArt({ searches: [search, priorArt().searches[1]] }) })), 'invalid_prior_art_search');
});

test('source mismatches are refused: the budget, plan and selection must all be the task project', () => {
  refuses(() => validatePricedTask(input({ budget: budget(1, { project: 'P-OPP-00003' }) })), 'budget_project_mismatch');
  refuses(() => validatePricedTask(input({ budget: budget(1, { project: 'P-service-integrity-20261105' }) })), 'budget_project_mismatch');
  const selection = validateSelection(JSON.parse(readFileSync(SELECTION_PATH, 'utf8')));
  assert.ok(validatePricedTask(input({ selection })));
  const outside = { task: task({ projectId: 'OPP-00001' }), approvedPlan: plan({ projectId: 'OPP-00001' }), budget: budget(1, { project: 'P-OPP-00001' }) };
  refuses(() => validatePricedTask(input({ ...outside, selection })), 'project_not_selected');
  assert.ok(validatePricedTask(input(outside)), 'without a selection the caller has scoped the project itself');
  const held = { task: task({ projectId: 'OPP-08881' }), approvedPlan: plan({ projectId: 'OPP-08881' }), budget: budget(1, { project: 'P-OPP-08881' }) };
  refuses(() => validatePricedTask(input({ ...held, selection })), 'project_held');
});

test('closed, achieved and non-v2 budgets are refused', () => {
  refuses(() => validatePricedTask(input({ budget: budget(1, { closed: true }) })), 'project_closed');
  refuses(() => validatePricedTask(input({ budget: budget(1, { main_kpi_achieved: true }) })), 'project_main_kpi_achieved');
  refuses(() => validatePricedTask(input({ budget: budget(1, { policy: 'central-earning-v1' }) })), 'unsupported_budget_policy');
  const { policy, ...noPolicy } = budget();
  assert.ok(policy);
  refuses(() => validatePricedTask(input({ budget: noPolicy })), 'invalid_budget');
  assert.ok(validatePricedTask(input({ budget: budget(1, { closed: false, main_kpi_achieved: false }) })));
});

test('malformed or inconsistent budget snapshots are refused', () => {
  refuses(() => validatePricedTask(input({ budget: budget(1, { paid: aid(6000), reserved: aid(4001) }) })), 'budget_overspent');
  refuses(() => validatePricedTask(input({ budget: budget(1, { reserved: '01' }) })), 'invalid_amount');
  refuses(() => validatePricedTask(input({ budget: budget(1, { paid: '-1' }) })), 'invalid_amount');
  refuses(() => validatePricedTask(input({ budget: budget(1, { paid: 0 }) })), 'invalid_amount');
  for (const change of [{ extra: 1 }, { lifetime_ceiling: '1' }, { manager: 'nobody' }, { height: 120 }, { evidence_digest: 'x' }, { closed: 'yes' }])
    refuses(() => validatePricedTask(input({ budget: budget(1, change) })), 'invalid_budget');
  refuses(() => validatePricedTask(input({ budget: null })), 'invalid_budget');
  // The minimal native shape (omitempty fields absent) is accepted.
  const minimal = { project: 'P-OPP-00002', allocation: centralUnlockedUnits(1), reserved: '0', paid: '0', round: 1, policy: CENTRAL_POLICY };
  assert.ok(validatePricedTask(input({ budget: minimal })));
});

test('the global supply cap is enforced exactly', () => {
  const cap = SUPPLY_CAP_UNITS;
  const total = BigInt(aid(5000));
  assert.ok(validatePricedTask(input({ supply: supply({ issued: (cap - total).toString(), reserved: '0' }) })));
  refuses(() => validatePricedTask(input({ supply: supply({ issued: (cap - total).toString(), reserved: '1' }) })), 'supply_cap_exceeded');
  refuses(() => validatePricedTask(input({ supply: supply({ cap: '1000', issued: '0', reserved: '0' }) })), 'supply_cap_exceeded');
  for (const bad of [
    supply({ cap: (cap + 1n).toString() }), supply({ cap: '0' }), supply({ issued: '1.5' }), supply({ reserved: 5 }),
    supply({ issued: cap.toString(), reserved: '1' }), { ...supply(), minted: '0' }, null,
  ]) refuses(() => validatePricedTask(input({ supply: bad })), 'invalid_supply');
});

test('malformed tasks and rationale are refused', () => {
  const cases = [
    [{ id: 'has space' }, 'invalid_task'],
    [{ id: '-x' }, 'invalid_task'],
    [{ projectId: 'P-OPP-00002' }, 'invalid_task'],
    [{ milestoneRound: 0 }, 'invalid_task'],
    [{ milestoneRound: 6 }, 'invalid_task'],
    [{ planRevision: 0 }, 'invalid_task'],
    [{ planRevision: '1' }, 'invalid_task'],
    [{ title: 'ab' }, 'invalid_task'],
    [{ title: '  ab  ' }, 'invalid_task'],
    [{ title: 'x'.repeat(241) }, 'invalid_task'],
    [{ criteria: 'too short' }, 'invalid_task'],
    [{ criteria: 'x'.repeat(4097) }, 'invalid_task'],
    [{ criteria: 'Criteria with a hidden \u0007 control character in it.' }, 'invalid_task'],
    [{ eligibility: 'easy' }, 'invalid_task'],
    [{ evidenceDigest: 'A'.repeat(64) }, 'invalid_task'],
    [{ rationale: undefined }, 'invalid_price_rationale'],
    [{ rationale: { ...task().rationale, stars: '5' } }, 'invalid_price_rationale'],
    [{ rationale: { ...task().rationale, effort: 'short' } }, 'invalid_price_rationale'],
    [{ rationale: { ...task().rationale, novelty: 7 } }, 'invalid_price_rationale'],
  ];
  for (const [change, code] of cases) refuses(() => validatePricedTask(input({ task: task(change) })), code);
  const { rationale, ...noRationale } = task();
  assert.ok(rationale);
  refuses(() => validatePricedTask(input({ task: noRationale })), 'invalid_task');
  refuses(() => validatePricedTask(input({ task: null })), 'invalid_task');
  for (const eligibility of ['hard', 'new', 'unresolved']) assert.equal(validatePricedTask(input({ task: task({ eligibility }) })).nativePayload.eligibility, eligibility);
});

test('native validation is authoritative: a payload native would reject is refused', () => {
  refuses(() => validatePricedTask(input({ task: task({ title: 'Lone surrogate \uD800 title' }) })), 'native_payload_rejected');
});

test('unknown pricing inputs are refused', () => {
  refuses(() => validatePricedTask({ ...input(), stars: 3 }), 'invalid_pricing_input');
  refuses(() => validatePricedTask(null), 'invalid_pricing_input');
});
