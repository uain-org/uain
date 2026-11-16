import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY, centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { ROUND_CEILING_UNITS, openLeadershipStore, runLeadership } from '../src/leadership.mjs';
import { SUPPLY_CAP_UNITS, validatePricedTask } from '../src/pricing.mjs';
import { TRUSTED_PRIOR_ART_SCHEMA, buildTaskProposal, proposeTask } from '../src/task-proposal.mjs';
import { digest, sha256 } from '../src/common.mjs';
import { surveyStatus } from '../src/survey.mjs';
import { withAcceptedSurvey } from './fixtures/survey-fixture.mjs';

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
// Without the recorded KPI amendments, so OPP-08881 still exercises the native-minimum hold.
const selection = await loadSelection({ amendmentsPath: null });
const ID = 'OPP-00002';
const HELD = 'OPP-08881';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const refuses = (fn, code) => assert.throws(fn, (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true));
const jsonl = (value) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n';
const stages = () => Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `Independently verify immutable stage ${i + 1} evidence for the unchanged Main KPI.` }));
const nativePlan = (id = ID, extra = {}) => ({ project: 'P-' + id, revision: 1, state: 'accept', main_kpi: selection.get(id).kpi.statement, stages: stages(), ...extra });
const fundState = (extra = {}) => ({ revision: 1, approved_revision: 1, completed: 0, pending: '', ...extra });
const BASIS = 'Manager claim: the pinned assay has never been rerun at this tolerance.';
const CRITERIA = 'Independent rerun reproduces the clearance ratio within the pinned tolerance from the retained raw data.';
const proposedTask = (extra = {}) => ({
  title: 'Reproduce the senolytic clearance assay on the pinned public dataset', criteria: CRITERIA, eligibility: 'unresolved', eligibility_basis: BASIS,
  proposed_price: {
    solver_amount: '400000000', reviewer_amount: '100000000',
    rationale: {
      effort: 'Two days of bounded analysis on the pinned dataset.', difficulty: 'Requires reconciling two assay normalizations.',
      novelty: 'No published rerun at the pinned tolerance.', verificationCost: 'One independent verification rerun of the retained data.',
    },
  },
  ...extra,
});

/** FIXTURE manager provider; `actual` receipts are a test stand-in, never a real model run. */
function provider(answer, { actual = true } = {}) {
  return {
    fixture: !actual, model: 'fixture-model',
    async execute({ executionId }) {
      return { raw: jsonl(answer), receipt: { executionId, model: 'fixture-model', startedAt: '2026-11-06T10:00:00.000Z', finishedAt: '2026-11-06T10:00:05.000Z', actual } };
    },
  };
}
const SURVEY = surveyStatus(withAcceptedSurvey({ projectId: ID, tasks: [] }));
const dir = mkdtempSync(join(tmpdir(), 'task-proposal-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const store = openLeadershipStore({ directory: dir });
async function managerReport({ id = ID, tasks = [proposedTask()], actual = true, plan = nativePlan(id), state = fundState() } = {}) {
  return runLeadership({
    projectId: id, role: 'manager', source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) },
    approvedPlan: plan, fundState: state, provider: provider({ main_kpi: selection.get(id).kpi.statement, round: state.completed + 1, tasks }, { actual }),
    selection, store, now: () => new Date(NOW), survey: id === ID ? SURVEY : surveyStatus(withAcceptedSurvey({ projectId: id, tasks: [] })),
  });
}
const budget = (round = 1, extra = {}) => ({
  project: 'P-' + ID, manager: 'uain1' + 'c'.repeat(40), policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(round), reserved: '0', paid: '0', round,
  lifetime_ceiling: '1000000000000000', height: '120', evidence_digest: 'b'.repeat(64), ...extra,
});
/** FIXTURE native snapshot in the `native.snapshot(projectId)` shape. */
const snapshot = (extra = {}, survey) => withAcceptedSurvey({
  projectId: ID, nativeProjectId: 'P-' + ID, available: true, height: '120', budget: budget(), fundState: fundState(),
  plan: nativePlan(), approvedPlan: nativePlan(), tasks: [], ...extra,
}, survey);
/** FIXTURE trusted search record; no real search was run by this test. */
const priorArtRecord = (extra = {}) => ({
  schema: TRUSTED_PRIOR_ART_SCHEMA,
  producer: { kind: 'trusted_search', id: 'search-run-0001', recordedAt: '2026-11-06T11:00:00.000Z' },
  subject: { projectId: ID, criteriaDigest: sha256(CRITERIA) },
  basis: 'FIXTURE: two registry searches found no open rerun of this assay at the pinned tolerance.',
  searches: [
    { query: 'senolytic clearance ratio rerun', source: 'https://scholar.google.com', observedAt: '2026-11-06T10:30:00.000Z', resultSummary: 'FIXTURE: no matching rerun found.' },
    { query: 'senolytic clearance assay code', source: 'https://github.com', observedAt: '2026-11-06T10:35:00.000Z', resultSummary: 'FIXTURE: no repository implements it.' },
  ],
  knownAnswer: false, openSolutionFound: false, ...extra,
});
const pricingSnapshot = { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: '0', reserved: '0' }, height: '120' };
const report = await managerReport();
const args = (extra = {}) => ({ managerReport: report, priorArtRecord: priorArtRecord(), approvedPlan: snapshot(), selection, pricingSnapshot, now: () => NOW, ...extra });
/** Re-seals a modified report as a store would hold it (bridge defence in depth). */
const resealed = (r, mutate) => {
  const copy = structuredClone(r);
  mutate(copy.result);
  copy.resultDigest = digest(copy.result);
  return copy;
};

test('a manager proposal plus a trusted search record yields a central_task_open payload pricing and native accept', () => {
  assert.equal(report.status, 'completed');
  const { input, evidence } = buildTaskProposal(args());
  assert.deepEqual(Object.keys(input).sort(), ['approvedPlan', 'budget', 'existingTaskIds', 'priorArt', 'selection', 'supply', 'task']);
  assert.deepEqual([input.task.solverAmount, input.task.reviewerAmount], ['400000000', '100000000'], 'amounts are the manager strings, verbatim');
  assert.deepEqual(input.task.rationale, proposedTask().proposed_price.rationale);
  assert.equal(input.task.evidenceDigest, digest(evidence));
  assert.equal(evidence.priorArt.producer.id, 'search-run-0001');
  assert.equal(evidence.managerReport.resultDigest, report.resultDigest);
  assert.match(input.task.id, /^T-OPP-00002-1-[a-f0-9]{16}$/);
  assert.equal(proposeTask(args()).task.id, input.task.id, 'the default task id is deterministic');
  const priced = validatePricedTask(input);
  assert.deepEqual(centralPayload('central_task_open', priced.nativePayload), priced.nativePayload);
  assert.equal(priced.nativePayload.project, 'P-' + ID);
  assert.equal(priced.nativePayload.acceptance_digest, sha256(CRITERIA));
  assert.equal(priced.totalUnits, '500000000');
  // a second open of the same proposal is a duplicate once native lists it
  refuses(() => validatePricedTask(proposeTask(args({ approvedPlan: snapshot({ tasks: [{ id: input.task.id, project: 'P-' + ID }] }) }))), 'duplicate_task');
});

test('prior art must be a separate trusted search record: missing, legacy or model-supplied records refuse', () => {
  refuses(() => proposeTask(args({ priorArtRecord: undefined })), 'prior_art_record_required');
  const { basis, searches, knownAnswer, openSolutionFound } = priorArtRecord();
  const legacy = { basis, searches, knownAnswer, openSolutionFound };
  refuses(() => proposeTask(args({ priorArtRecord: legacy })), 'invalid_prior_art_record');
  refuses(() => proposeTask(args({ priorArtRecord: { ...priorArtRecord(), extra: true } })), 'invalid_prior_art_record');
  for (const kind of ['model', 'manager', 'leadership'])
    refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ producer: { ...priorArtRecord().producer, kind } }) })), 'prior_art_model_supplied');
  for (const id of [report.id, report.execution.id])
    refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ producer: { ...priorArtRecord().producer, id } }) })), 'prior_art_model_supplied');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ basis: BASIS }) })), 'prior_art_model_supplied');
  const s = priorArtRecord().searches;
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ searches: [s[0], { ...s[1], source: 'model memory' }] }) })), 'prior_art_model_supplied');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ searches: [s[0], { ...s[1], resultSummary: BASIS }] }) })), 'prior_art_model_supplied');
});

test('known answers, open solutions, thin or misdated searches and another task\'s record refuse', () => {
  const s = priorArtRecord().searches;
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ knownAnswer: true }) })), 'known_answer_not_rewardable');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ openSolutionFound: true }) })), 'open_solution_found');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ searches: [s[0]] }) })), 'insufficient_prior_art_searches');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ searches: [s[0], { ...s[1], source: s[0].source, query: s[0].query.toUpperCase() }] }) })),
    'insufficient_prior_art_searches');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ searches: [s[0], { ...s[1], observedAt: '2026-11-06T11:30:00.000Z' }] }) })),
    'invalid_prior_art_search');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ producer: { ...priorArtRecord().producer, recordedAt: '2026-12-01T00:00:00.000Z' } }) })),
    'invalid_prior_art_record');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ subject: { projectId: ID, criteriaDigest: sha256('other criteria') } }) })), 'prior_art_subject_mismatch');
  refuses(() => proposeTask(args({ priorArtRecord: priorArtRecord({ subject: { projectId: 'OPP-00003', criteriaDigest: sha256(CRITERIA) } }) })), 'prior_art_subject_mismatch');
});

test('amounts: over the round ceiling, non-canonical, missing or over the allowance refuse; tampering is detected', async () => {
  const over = (ROUND_CEILING_UNITS[0] - 99999999n).toString();
  refuses(() => proposeTask(args({ managerReport: resealed(report, (r) => { r.tasks[0].proposed_price.solver_amount = over; }) })), 'amount_above_round_ceiling');
  refuses(() => proposeTask(args({ managerReport: resealed(report, (r) => { r.tasks[0].proposed_price.solver_amount = '1.5'; }) })), 'invalid_amount');
  refuses(() => proposeTask(args({ managerReport: resealed(report, (r) => { r.tasks[0].proposed_price.stars = 5; }) })), 'proposed_price_invalid');
  refuses(() => proposeTask(args({ managerReport: resealed(report, (r) => { r.tasks[0].proposed_price.rationale = 'one string'; }) })), 'invalid_price_rationale');
  const tampered = structuredClone(report);
  tampered.result.tasks[0].proposed_price.solver_amount = '9999999999';
  refuses(() => proposeTask(args({ managerReport: tampered })), 'manager_report_tampered');
  const unpriced = await managerReport({ tasks: [proposedTask({ proposed_price: null })] });
  refuses(() => proposeTask(args({ managerReport: unpriced })), 'task_price_missing');
  refuses(() => proposeTask(args({ taskIndex: 3 })), 'proposed_task_missing');
  // within the ceiling but beyond what the project still has: native-backed pricing refuses
  const spent = proposeTask(args({ approvedPlan: snapshot({ budget: budget(1, { reserved: '9800000000' }) }) }));
  refuses(() => validatePricedTask(spent), 'insufficient_project_allowance');
});

test('an unapproved, amended or different plan, a held project, a fixture report or unread supply refuse', async () => {
  refuses(() => proposeTask(args({ approvedPlan: snapshot({ fundState: fundState({ approved_revision: 0 }), approvedPlan: null }) })), 'plan_not_approved');
  refuses(() => proposeTask(args({ approvedPlan: snapshot({ approvedPlan: nativePlan(ID, { state: 'proposed' }) }) })), 'plan_not_approved');
  refuses(() => proposeTask(args({ approvedPlan: snapshot({ fundState: fundState({ revision: 2, pending: 'amend-2' }) }) })), 'plan_amendment_pending');
  refuses(() => proposeTask(args({ approvedPlan: { ...snapshot(), available: false } })), 'native_snapshot_unavailable');
  const revised = snapshot({ fundState: fundState({ revision: 2, approved_revision: 2 }), approvedPlan: nativePlan(ID, { revision: 2 }), plan: nativePlan(ID, { revision: 2 }) });
  refuses(() => proposeTask(args({ approvedPlan: revised })), 'plan_revision_mismatch');
  refuses(() => proposeTask(args({ approvedPlan: snapshot({ fundState: fundState({ completed: 1 }), budget: budget(2) }) })), 'milestone_round_mismatch');
  const other = { ...snapshot(), projectId: 'OPP-00003', nativeProjectId: 'P-OPP-00003', approvedPlan: nativePlan('OPP-00003'), budget: budget(1, { project: 'P-OPP-00003' }) };
  refuses(() => proposeTask(args({ approvedPlan: other })), 'plan_project_mismatch');

  const held = await managerReport({ id: HELD, tasks: [proposedTask()] });
  assert.equal(held.status, 'completed');
  refuses(() => proposeTask(args({ managerReport: held })), 'project_held');

  const fixtureReport = await managerReport({ actual: false });
  refuses(() => proposeTask(args({ managerReport: fixtureReport })), 'manager_report_not_actual');
  assert.equal(proposeTask(args({ managerReport: fixtureReport, requireActualReport: false })).task.projectId, ID);

  refuses(() => proposeTask(args({ pricingSnapshot: {} })), 'native_supply_unread');
  refuses(() => proposeTask(args({ pricingSnapshot: { supply: pricingSnapshot.supply, guessed: true } })), 'invalid_pricing_snapshot');
  const ceo = await runLeadership({
    projectId: ID, role: 'ceo', source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(ID)) },
    provider: provider({ main_kpi: selection.get(ID).kpi.statement, strategy: 'Build reproducible evidence first, then scale delivery carefully.', blockers: [] }),
    selection, store, now: () => new Date(NOW),
  });
  refuses(() => proposeTask(args({ managerReport: ceo })), 'manager_report_invalid');
});

test('no task is proposed before the prior-art survey is accepted, against another survey, or after a survey that finds the Main KPI met', () => {
  const bare = { projectId: ID, nativeProjectId: 'P-' + ID, available: true, height: '120', budget: budget(), fundState: fundState(), plan: nativePlan(), approvedPlan: nativePlan(), tasks: [] };
  refuses(() => proposeTask(args({ approvedPlan: bare })), 'prior_art_survey_required');
  const pending = withAcceptedSurvey(bare);
  pending.tasks = pending.tasks.map((t) => ({ ...t, state: 'under_review', winner: '', pending: 'sub-survey-' + ID }));
  refuses(() => proposeTask(args({ approvedPlan: pending })), 'prior_art_survey_required');
  const unread = withAcceptedSurvey(bare);
  unread.records = {};
  refuses(() => proposeTask(args({ approvedPlan: unread })), 'native_snapshot_unavailable');
  refuses(() => proposeTask(args({ approvedPlan: snapshot({}, { meetsMainKpi: true }) })), 'prior_art_survey_found_solution');
  const otherSurvey = snapshot({}, { mainKpi: 'FIXTURE a different accepted survey text.' });
  refuses(() => proposeTask(args({ approvedPlan: otherSurvey })), 'prior_art_survey_mismatch');
  const { evidence } = buildTaskProposal(args());
  assert.deepEqual(evidence.priorArtSurvey, { taskId: SURVEY.taskId, submission: SURVEY.submission, evidenceDigest: SURVEY.evidenceDigest });
});
