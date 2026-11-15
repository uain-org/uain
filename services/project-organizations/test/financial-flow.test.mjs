/** SEMANTIC FIXTURE, NOT CHAIN QUALIFICATION.
 * Pins the native fund/review/award semantics the organization adapter consumes,
 * against a pure-JS mirror (src/fund-model.mjs) of chain/federation/central_fund.go
 * and central_earning.go. No daemon or Go toolchain is used here; passing these
 * tests proves nothing about a running chain or production earning. The Go tests
 * (`cd chain && go test ./federation/ -run Central`) remain authoritative. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CUMULATIVE_UNITS, OPENING_UNITS, allocationForRound, createFundModel } from '../src/fund-model.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const AID = 1000000n;
const addr = (n) => 'uain1' + n.toString(16).padStart(40, '0');
const GUARDIAN = addr(1), REVIEWER = addr(2), MANAGER = addr(3), EVALUATOR = addr(4), SOLVER = addr(5), OTHER = addr(6);
const PROJECT = 'P-OPP-00002';
const MAIN_KPI = 'Reach the predefined, unchanged Main KPI for this project';
const stages = (tag = 'v1') => [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Stage ${round} measurable criterion (${tag}) with evidence` }));
const refuses = (fn, code) => assert.throws(fn, (e) => (code ? e.code === code : typeof e.code === 'string'), code);

function started({ approve = true } = {}) {
  const m = createFundModel({ guardian: GUARDIAN, reviewer: REVIEWER });
  for (const x of [MANAGER, EVALUATOR, SOLVER, OTHER]) m.enroll(x);
  m.createProject({ project: PROJECT, lead: GUARDIAN });
  for (const x of [MANAGER, SOLVER, OTHER]) m.join({ project: PROJECT, member: x });
  m.start({ actor: GUARDIAN, project: PROJECT, manager: MANAGER });
  m.configure({ actor: GUARDIAN, project: PROJECT, evaluator: EVALUATOR });
  if (approve) {
    m.plan({ actor: EVALUATOR, project: PROJECT, revision: 1, mainKpi: MAIN_KPI, stages: stages(), reason: 'Independent five-stage plan' });
    m.reviewPlan({ actor: EVALUATOR, project: PROJECT, revision: 1, verdict: 'accept' });
  }
  return m;
}
let seq = 0;
function decideRound(m, verdict = 'accept') {
  const b = m.budget(PROJECT), st = m.fundState(PROJECT);
  const id = `app-${++seq}`;
  m.apply({ actor: MANAGER, id, project: PROJECT, round: b.round, revision: st.approvedRevision, evidenceDigest: sha(id) });
  m.decide({ actor: EVALUATOR, application: id, verdict, mainKpiAchieved: b.round === 5 && verdict === 'accept', feedback: 'Independent verification feedback recorded' });
  return id;
}
function taskAndSubmission(m, { id = `task-${++seq}`, solver = '400' + '000000', reviewer = '100' + '000000', author = SOLVER } = {}) {
  const t = m.openTask({ actor: MANAGER, id, project: PROJECT, criteria: `Criteria for ${id}`, solverAmount: solver, reviewerAmount: reviewer });
  const sub = `sub-${id}`;
  m.submit({ actor: author, id: sub, task: id, evidence: `evidence ${id}` });
  return { task: t, submission: sub, review: (verdict, executionId = `exec-${sub}-${verdict}`, actor = REVIEWER) =>
    m.review({ actor, submission: sub, verdict, executionId, criteriaDigest: t.acceptanceDigest, evidenceDigest: sha(`evidence ${id}`) }) };
}

test('label: this file is a semantic fixture, not chain qualification', () => {
  const snap = started().snapshot(PROJECT);
  assert.equal(snap.fixture, true);
  assert.equal(snap.proof.fixture, true);
});

test('all six cumulative ceilings unlock in order, ending at exactly 1,000,000,000 AI$', () => {
  const expected = [10000n, 110000n, 1110000n, 11110000n, 111110000n, 1000000000n].map((n) => (n * AID).toString());
  assert.deepEqual([...CUMULATIVE_UNITS], expected);
  assert.equal(OPENING_UNITS, expected[0]);
  assert.equal(allocationForRound(0), null);
  assert.equal(allocationForRound(7), null);
  const m = started();
  assert.equal(m.budget(PROJECT).allocation, expected[0]);
  for (let round = 1; round <= 5; round++) {
    decideRound(m, 'accept');
    assert.equal(m.budget(PROJECT).allocation, expected[round]);
    assert.equal(m.budget(PROJECT).round, round + 1);
  }
  // Increments: 10,000; 100,000; 1,000,000; 10,000,000; 100,000,000; 888,890,000 AI$.
  const increments = expected.map((v, i) => BigInt(v) - (i ? BigInt(expected[i - 1]) : 0n));
  assert.deepEqual(increments.map((v) => v / AID), [10000n, 100000n, 1000000n, 10000000n, 100000000n, 888890000n]);
  assert.equal(m.budget(PROJECT).achieved, true);
  // No sixth sub-KPI: applying beyond round 5 is refused.
  refuses(() => m.apply({ actor: MANAGER, id: 'app-6', project: PROJECT, round: 6, revision: 1, evidenceDigest: sha('6') }));
});

test('a rejected KPI application unlocks nothing; the round stays and may be re-applied', () => {
  const m = started();
  decideRound(m, 'reject');
  assert.equal(m.budget(PROJECT).allocation, OPENING_UNITS);
  assert.equal(m.budget(PROJECT).round, 1);
  assert.equal(m.fundState(PROJECT).completed, 0);
  decideRound(m, 'accept');
  assert.equal(m.budget(PROJECT).allocation, CUMULATIVE_UNITS[1]);
});

test('the final increment requires main_kpi_achieved exactly on the round-five accept', () => {
  const m = started();
  for (let i = 0; i < 4; i++) decideRound(m);
  const st = m.fundState(PROJECT);
  m.apply({ actor: MANAGER, id: 'final', project: PROJECT, round: 5, revision: st.approvedRevision, evidenceDigest: sha('final') });
  const feedback = 'Independent verification feedback recorded';
  refuses(() => m.decide({ actor: EVALUATOR, application: 'final', verdict: 'accept', mainKpiAchieved: false, feedback }), 'invalid_central_fund_decide');
  refuses(() => m.decide({ actor: EVALUATOR, application: 'final', verdict: 'reject', mainKpiAchieved: true, feedback }), 'invalid_central_fund_decide');
  assert.equal(m.budget(PROJECT).allocation, CUMULATIVE_UNITS[4]);
  m.decide({ actor: EVALUATOR, application: 'final', verdict: 'accept', mainKpiAchieved: true, feedback });
  assert.equal(m.budget(PROJECT).allocation, CUMULATIVE_UNITS[5]);
  // An earlier round can never claim the Main KPI.
  const m2 = started();
  m2.apply({ actor: MANAGER, id: 'early', project: PROJECT, round: 1, revision: 1, evidenceDigest: sha('early') });
  refuses(() => m2.decide({ actor: EVALUATOR, application: 'early', verdict: 'accept', mainKpiAchieved: true, feedback }), 'invalid_central_fund_decide');
});

test('the manager can never decide its own application or approve its plan', () => {
  const m = started({ approve: false });
  refuses(() => m.plan({ actor: MANAGER, project: PROJECT, revision: 1, mainKpi: MAIN_KPI, stages: stages(), reason: 'Self-approved plan' }));
  refuses(() => m.configure({ actor: GUARDIAN, project: PROJECT, evaluator: MANAGER }), 'invalid_central_fund_configure');
  const ok = started();
  ok.apply({ actor: MANAGER, id: 'a1', project: PROJECT, round: 1, revision: 1, evidenceDigest: sha('a1') });
  refuses(() => ok.decide({ actor: MANAGER, application: 'a1', verdict: 'accept', mainKpiAchieved: false, feedback: 'Manager trying to self approve here' }), 'invalid_central_fund_decide');
});

test('achieved stage criteria are immutable and the Main KPI cannot change in an amendment', () => {
  const m = started();
  decideRound(m);
  decideRound(m);
  const changedFirst = stages('v2');
  refuses(() => m.plan({ actor: EVALUATOR, project: PROJECT, revision: 2, mainKpi: MAIN_KPI, stages: changedFirst, reason: 'Rewrites achieved stages' }), 'achieved_stage_immutable');
  refuses(() => m.plan({ actor: EVALUATOR, project: PROJECT, revision: 2, mainKpi: MAIN_KPI + ' (relaxed)', stages: stages(), reason: 'Changes the Main KPI' }), 'main_kpi_changed');
  const prospective = stages();
  prospective[2] = { round: 3, criteria: 'Stage 3 prospective amendment with evidence' };
  m.plan({ actor: EVALUATOR, project: PROJECT, revision: 2, mainKpi: MAIN_KPI, stages: prospective, reason: 'Prospective amendment' });
  // A pending amendment pauses new paid obligations until decided.
  refuses(() => m.openTask({ actor: MANAGER, id: 'paused', project: PROJECT, criteria: 'c', solverAmount: '1', reviewerAmount: '1' }), 'pending_plan_amendment');
  // Main KPI under 20 bytes is refused natively (the OPP-08881 hold).
  const short = started({ approve: false });
  refuses(() => short.plan({ actor: EVALUATOR, project: PROJECT, revision: 1, mainKpi: '1,000 bridges built', stages: stages(), reason: 'Short Main KPI' }), 'invalid_main_kpi');
});

test('no paid task before an approved plan; reservations never exceed allocation - paid - reserved', () => {
  const m = started({ approve: false });
  refuses(() => m.openTask({ actor: MANAGER, id: 't0', project: PROJECT, criteria: 'c', solverAmount: '1', reviewerAmount: '1' }), 'fund_manager_plan_not_approved');
  const ok = started();
  const sixK = (6000n * AID).toString(), oneK = (1000n * AID).toString();
  ok.openTask({ actor: MANAGER, id: 't1', project: PROJECT, criteria: 'c1', solverAmount: sixK, reviewerAmount: oneK });
  // 7,000 reserved; another 7,000 would exceed 10,000.
  refuses(() => ok.openTask({ actor: MANAGER, id: 't2', project: PROJECT, criteria: 'c2', solverAmount: sixK, reviewerAmount: oneK }), 'central_project_allocation_exceeded');
  ok.openTask({ actor: MANAGER, id: 't3', project: PROJECT, criteria: 'c3', solverAmount: (2000n * AID).toString(), reviewerAmount: oneK });
  assert.equal(ok.budget(PROJECT).reserved, (10000n * AID).toString());
  refuses(() => ok.openTask({ actor: MANAGER, id: 't4', project: PROJECT, criteria: 'c4', solverAmount: '1', reviewerAmount: '1' }), 'central_project_allocation_exceeded');
  refuses(() => ok.openTask({ actor: OTHER, id: 't5', project: PROJECT, criteria: 'c5', solverAmount: '1', reviewerAmount: '1' }));
  for (const bad of ['0', '-1', '1.5', '01', '1e6', 'abc', '1' + '0'.repeat(30)])
    refuses(() => ok.openTask({ actor: MANAGER, id: 'tb', project: PROJECT, criteria: 'cb', solverAmount: bad, reviewerAmount: '1' }));
});

test('review accept pays exactly two awards: solver and reviewer, consuming the reservation', () => {
  const m = started();
  const { submission, review } = taskAndSubmission(m);
  const { awards } = review('accept');
  assert.equal(awards.length, 2);
  assert.deepEqual(awards.map((a) => [a.role, a.member, a.amount]).sort(), [['reviewer', REVIEWER, '100000000'], ['solver', SOLVER, '400000000']]);
  const b = m.budget(PROJECT);
  assert.equal(b.reserved, '0');
  assert.equal(b.paid, '500000000');
  assert.equal(m.earnings(SOLVER).total, '400000000');
  assert.equal(m.earnings(REVIEWER).total, '100000000');
  assert.deepEqual(m.ledger(), { minted: '500000000', reserved: '0', transparent: '500000000', shielded: '0' });
  const snap = m.snapshot(PROJECT);
  assert.ok(snap.records['central_award/solver/' + submission]);
  assert.ok(snap.records['central_award/reviewer/' + submission]);
});

test('review reject pays the reviewer only, releases the solver reservation and reopens unfunded', () => {
  const m = started();
  const { task, submission, review } = taskAndSubmission(m);
  const { awards } = review('reject');
  assert.deepEqual(awards.map((a) => [a.role, a.member, a.amount]), [['reviewer', REVIEWER, '100000000']]);
  assert.equal(m.earnings(SOLVER), null);
  const b = m.budget(PROJECT);
  assert.equal(b.reserved, '0');
  assert.equal(b.paid, '100000000');
  assert.deepEqual(m.ledger(), { minted: '100000000', reserved: '0', transparent: '100000000', shielded: '0' });
  assert.equal(m.task(task.id).state, 'open_unfunded');
  assert.equal(m.snapshot(PROJECT).records['central_award/solver/' + submission], undefined);
  // The manager may re-fund the same task; the paid reviewer amount stays consumed.
  m.fundTask({ actor: MANAGER, task: task.id });
  assert.equal(m.budget(PROJECT).reserved, '500000000');
});

test('needs_evidence records a review but pays nothing and is not final', () => {
  const m = started();
  const { task, review } = taskAndSubmission(m);
  assert.deepEqual(review('needs_evidence').awards, []);
  assert.equal(m.task(task.id).state, 'under_review');
  assert.equal(m.budget(PROJECT).paid, '0');
  assert.equal(m.budget(PROJECT).reserved, '500000000');
  assert.equal(m.ledger().minted, '0');
  // A later final review (distinct execution) still settles it.
  assert.equal(review('accept', 'exec-second').awards.length, 2);
});

test('duplicate reviews are refused: same execution, and any review after a final verdict', () => {
  const m = started();
  const { review } = taskAndSubmission(m);
  review('needs_evidence', 'exec-1');
  refuses(() => review('needs_evidence', 'exec-1'), 'duplicate_central_review');
  review('accept', 'exec-2');
  refuses(() => review('accept', 'exec-3'), 'invalid_central_review');
  refuses(() => review('reject', 'exec-4'), 'invalid_central_review');
  assert.equal(m.budget(PROJECT).paid, '500000000');
});

test('author and reviewer must be distinct; only the configured central reviewer reviews', () => {
  const m = started();
  // The central reviewer cannot submit work.
  m.join({ project: PROJECT, member: REVIEWER });
  const t = m.openTask({ actor: MANAGER, id: 'self', project: PROJECT, criteria: 'self review', solverAmount: '2', reviewerAmount: '1' });
  refuses(() => m.submit({ actor: REVIEWER, id: 'self-sub', task: t.id, evidence: 'mine' }), 'invalid_central_submit');
  // Another member (including the manager or solver) cannot review.
  const { review } = taskAndSubmission(m);
  refuses(() => review('accept', 'exec-x', SOLVER), 'invalid_central_review');
  refuses(() => review('accept', 'exec-y', MANAGER), 'invalid_central_review');
  // A revoked author can be rejected (reviewer paid) but never accepted.
  const m2 = started();
  const flow = taskAndSubmission(m2);
  m2.revoke(SOLVER);
  refuses(() => flow.review('accept'), 'invalid_central_review');
  assert.equal(flow.review('reject').awards.length, 1);
});

test('reserved obligations must settle before close; close needs the Main KPI and round six', () => {
  const m = started();
  for (let i = 0; i < 4; i++) decideRound(m);
  const pending = taskAndSubmission(m, { solver: '7', reviewer: '3' });
  decideRound(m);
  assert.equal(m.budget(PROJECT).achieved, true);
  // No new tasks after the Main KPI is achieved (central_earning.go:262).
  refuses(() => m.openTask({ actor: MANAGER, id: 'late', project: PROJECT, criteria: 'late', solverAmount: '1', reviewerAmount: '1' }), 'invalid_central_task_open');
  refuses(() => m.close({ actor: EVALUATOR, project: PROJECT }), 'invalid_central_fund_close');
  pending.review('accept');
  assert.equal(m.budget(PROJECT).reserved, '0');
  refuses(() => m.close({ actor: MANAGER, project: PROJECT }), 'invalid_central_fund_close');
  m.close({ actor: EVALUATOR, project: PROJECT });
  assert.equal(m.budget(PROJECT).closed, true);
  const early = started();
  refuses(() => early.close({ actor: EVALUATOR, project: PROJECT }), 'invalid_central_fund_close');
});

test('refused transitions leave state unchanged (atomic like a rejected native transaction)', () => {
  const m = started();
  const before = JSON.stringify([m.budget(PROJECT), m.ledger()]);
  refuses(() => m.openTask({ actor: MANAGER, id: 'huge', project: PROJECT, criteria: 'huge', solverAmount: (10001n * AID).toString(), reviewerAmount: '1' }));
  assert.equal(JSON.stringify([m.budget(PROJECT), m.ledger()]), before);
});
