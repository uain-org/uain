/** Bridge from a retained Project Manager proposal to the `validatePricedTask` input.
 *
 * Three independent inputs are joined here, and none may stand in for another:
 * - `managerReport`: a retained leadership report (role `manager`, `proposal_only`). It
 *   supplies the title, criteria, eligibility class and the manager's proposed amounts with
 *   their four-part rationale. Amounts are passed through exactly as the canonical micro-AI$
 *   strings the manager wrote; the bridge never converts stars, scores or any other unit.
 * - `priorArtRecord`: produced by a separate trusted search step, NOT by the model. It
 *   carries the searches actually run (query, source, observedAt, resultSummary), its
 *   producer and the exact task it was run for. Model-produced citations or an
 *   `eligibility_basis` narrative alone can never establish prior art: the leadership
 *   sanitizer strips any search or citation fields a model volunteers, and this bridge
 *   refuses a record whose producer is the model run (or that copies the model's own
 *   claim) as `prior_art_model_supplied`. The bridge cannot authenticate the search step;
 *   the record's provenance is retained in the evidence digest for later review.
 * - `approvedPlan`: the native snapshot (`native.snapshot(projectId)`), the authority for
 *   the approved plan revision, current round, budget and existing task IDs.
 *   `pricingSnapshot` carries the native supply (`reader.supplySnapshot()` or `{supply}`).
 *
 * Every organization's first task is its prior-art survey (survey.mjs). No other task is
 * proposed until that survey is accepted natively, the manager report was made against that
 * exact accepted survey, and the survey does not report the Main KPI already met. Pass the
 * snapshot read with `{evidence: true}` so the winning submission is in it.
 *
 * The result is only a pricing input. `validatePricedTask` re-checks everything against the
 * snapshot and native `central_task_open` performs the authoritative reservation. */
import { LEADERSHIP_SCHEMA, PRICE_RATIONALE_PARTS, ROUND_CEILING_UNITS } from './leadership.mjs';
import { MIN_PRIOR_ART_SEARCHES, MAX_PRIOR_ART_SEARCHES, pricingInputsFromSnapshot } from './pricing.mjs';
import { CATALOGUE_ID, HASH, NATIVE_ID, digest, exactKeys, need, plain, sha256, text, units } from './common.mjs';
import { requireAcceptedSurvey } from './survey.mjs';

export const TASK_PROPOSAL_SCHEMA = 'uain-project-organization-task-proposal-v1';
export const TRUSTED_PRIOR_ART_SCHEMA = 'uain-project-organization-trusted-prior-art-v1';
export const TRUSTED_SEARCH_KIND = 'trusted_search';

const RECORD_KEYS = ['schema', 'producer', 'subject', 'basis', 'searches', 'knownAnswer', 'openSolutionFound'];
const PRODUCER_KEYS = ['kind', 'id', 'recordedAt'];
const SUBJECT_KEYS = ['projectId', 'criteriaDigest'];
const SEARCH_KEYS = ['query', 'source', 'observedAt', 'resultSummary'];
const SNAPSHOT_KEYS = ['supply', 'height', 'fetchedAt', 'proof'];
/** A search "source" that names the model or leadership itself is not an external search. */
const SELF_SOURCE = /^(?:model|llm|leadership|manager|ceo|assistant|self|agent)(?:$|[\s:/_-])/i;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const trimmed = (v, min, max) => text(v, min, max) && v.trim().length >= min;
const isoMs = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v) ? Date.parse(v) : NaN);
const norm = (v) => v.trim().replace(/\s+/g, ' ').toLowerCase();

/** The manager report must be an untampered, completed manager proposal for a selected project. */
function checkReport(report, selection, requireActual) {
  need(plain(report) && report.schema === LEADERSHIP_SCHEMA, 'manager_report_invalid');
  need(report.role === 'manager' && report.authority === 'proposal_only', 'manager_report_invalid', 'a manager proposal is required');
  need(report.status === 'completed' && plain(report.result) && Array.isArray(report.result.tasks), 'manager_report_not_completed');
  need(report.resultDigest === digest(report.result), 'manager_report_tampered');
  if (requireActual) need(report.actual === true && report.execution?.actual === true, 'manager_report_not_actual');
  need(typeof report.projectId === 'string' && CATALOGUE_ID.test(report.projectId), 'manager_report_invalid');
  const project = selection.get(report.projectId);
  need(report.nativeProjectId === project.nativeProjectId, 'manager_report_invalid', 'native project mismatch');
  need(report.selectionDigest === selection.digest, 'selection_drift');
  need(report.sourceDigest === project.sourceDigest, 'selected_source_changed');
  need(project.holds.length === 0, 'project_held', `${project.id} is held: ${project.holds.join(', ')}`);
  need(report.result.main_kpi === project.mainKpi, 'main_kpi_changed');
  return project;
}

function checkProposedTask(report, taskIndex, round) {
  need(Number.isInteger(taskIndex) && taskIndex >= 0 && taskIndex < report.result.tasks.length, 'proposed_task_missing');
  const t = report.result.tasks[taskIndex];
  need(plain(t) && trimmed(t.title, 3, 240) && trimmed(t.criteria, 20, 4096) && ['hard', 'new', 'unresolved'].includes(t.eligibility), 'proposed_task_invalid');
  const price = t.proposed_price;
  need(price !== null && price !== undefined, 'task_price_missing', 'the manager proposed no valid price for this task');
  need(exactKeys(price, ['solver_amount', 'reviewer_amount', 'rationale']), 'proposed_price_invalid');
  need(exactKeys(price.rationale, PRICE_RATIONALE_PARTS), 'invalid_price_rationale', 'the four-part rationale is required');
  for (const part of PRICE_RATIONALE_PARTS) need(trimmed(price.rationale[part], 10, 2000), 'invalid_price_rationale', `invalid ${part} rationale`);
  // Canonical micro-unit strings only, used verbatim: no float, star or unit conversion.
  const solver = units(price.solver_amount);
  const reviewer = units(price.reviewer_amount);
  const ceiling = ROUND_CEILING_UNITS[round - 1];
  need(solver + reviewer <= ceiling, 'amount_above_round_ceiling', `requires ${solver + reviewer} units; round ${round} ceiling is ${ceiling}`);
  return t;
}

/** Strict trusted prior-art record; refuses anything model-produced or bound to another task. */
function checkPriorArtRecord(record, report, task, now) {
  need(record !== undefined && record !== null, 'prior_art_record_required');
  need(exactKeys(record, RECORD_KEYS) && record.schema === TRUSTED_PRIOR_ART_SCHEMA, 'invalid_prior_art_record');
  const { producer, subject } = record;
  need(exactKeys(producer, PRODUCER_KEYS) && trimmed(producer.id, 3, 200), 'invalid_prior_art_record', 'producer');
  const modelIds = [report.id, report.execution?.id].filter((v) => typeof v === 'string');
  need(producer.kind === TRUSTED_SEARCH_KIND && !modelIds.includes(producer.id.trim()), 'prior_art_model_supplied',
    'prior art must come from a trusted search step, not the leadership model');
  const recordedAt = isoMs(producer.recordedAt);
  need(Number.isFinite(recordedAt) && recordedAt <= now + CLOCK_SKEW_MS, 'invalid_prior_art_record', 'recordedAt');
  need(exactKeys(subject, SUBJECT_KEYS) && subject.projectId === report.projectId && typeof subject.criteriaDigest === 'string' &&
    HASH.test(subject.criteriaDigest), 'prior_art_subject_mismatch');
  need(subject.criteriaDigest === sha256(task.criteria), 'prior_art_subject_mismatch', 'the search was run for different criteria');
  need(trimmed(record.basis, 20, 4096), 'prior_art_basis_missing');
  need(typeof record.knownAnswer === 'boolean' && typeof record.openSolutionFound === 'boolean', 'invalid_prior_art_record');
  need(!record.knownAnswer, 'known_answer_not_rewardable');
  need(!record.openSolutionFound, 'open_solution_found');
  need(Array.isArray(record.searches) && record.searches.length <= MAX_PRIOR_ART_SEARCHES, 'invalid_prior_art_record');
  const claim = typeof task.eligibility_basis === 'string' ? norm(task.eligibility_basis) : null;
  need(claim === null || norm(record.basis) !== claim, 'prior_art_model_supplied', 'the basis repeats the model eligibility claim');
  const distinct = new Set();
  for (const s of record.searches) {
    need(exactKeys(s, SEARCH_KEYS) && trimmed(s.query, 3, 400) && trimmed(s.source, 3, 400) && trimmed(s.resultSummary, 10, 2000),
      'invalid_prior_art_search');
    need(!SELF_SOURCE.test(s.source.trim()), 'prior_art_model_supplied', `search source ${s.source} is not an external search`);
    need(claim === null || norm(s.resultSummary) !== claim, 'prior_art_model_supplied', 'a search result repeats the model eligibility claim');
    const observed = isoMs(s.observedAt);
    need(Number.isFinite(observed) && observed <= recordedAt && observed <= now + CLOCK_SKEW_MS, 'invalid_prior_art_search', 'observedAt');
    distinct.add(s.source.trim() + '\n' + s.query.trim().toLowerCase());
  }
  need(distinct.size >= MIN_PRIOR_ART_SEARCHES, 'insufficient_prior_art_searches');
  return record;
}

function checkPricingSnapshot(snapshot) {
  need(plain(snapshot) && Object.keys(snapshot).every((k) => SNAPSHOT_KEYS.includes(k)), 'invalid_pricing_snapshot');
  need(plain(snapshot.supply), 'native_supply_unread', 'supply must be read from native before pricing');
  return structuredClone(snapshot.supply);
}

/**
 * @returns {{input: object, evidence: object}} `input` is exactly the `validatePricedTask`
 *   input; `evidence` is the preimage of `input.task.evidenceDigest` (retain it with the intent).
 */
export function buildTaskProposal({
  managerReport, taskIndex = 0, taskId, priorArtRecord, approvedPlan, selection, pricingSnapshot,
  requireActualReport = true, now = () => Date.now(),
} = {}) {
  need(selection?.projects?.length === 120 && Object.isFrozen(selection) && typeof selection.get === 'function', 'invalid_proposal_configuration',
    'frozen selection required');
  const project = checkReport(managerReport, selection, requireActualReport !== false);
  // Native snapshot: refuses an unavailable, unapproved or amendment-pending plan.
  const inputs = pricingInputsFromSnapshot(approvedPlan);
  const plan = inputs.approvedPlan;
  need(plan.projectId === project.id, 'plan_project_mismatch');
  const survey = requireAcceptedSurvey(approvedPlan);
  need(managerReport.priorArtSurvey?.evidenceDigest === survey.evidenceDigest && managerReport.priorArtSurvey?.submission === survey.submission,
    'prior_art_survey_mismatch', 'the proposal was made against another survey');
  need(managerReport.approvedPlanRevision === plan.revision, 'plan_revision_mismatch', 'the proposal was made against another plan revision');
  const round = plan.currentRound;
  need(managerReport.milestoneRound === round && managerReport.result.round === round, 'milestone_round_mismatch');
  need(managerReport.result.milestone_criteria === plan.stages[round - 1]?.criteria, 'milestone_criteria_changed');
  const t = checkProposedTask(managerReport, taskIndex, round);
  const record = checkPriorArtRecord(priorArtRecord, managerReport, t, now());
  const supply = checkPricingSnapshot(pricingSnapshot);

  const id = taskId ?? `T-${project.id}-${round}-${sha256(`${managerReport.id}:${taskIndex}`).slice(0, 16)}`;
  need(typeof id === 'string' && NATIVE_ID.test(id), 'invalid_task', 'invalid task id');
  const evidence = {
    schema: TASK_PROPOSAL_SCHEMA,
    managerReport: {
      id: managerReport.id, resultDigest: managerReport.resultDigest, executionId: managerReport.execution?.id ?? null,
      actual: managerReport.actual === true, receiptDigest: managerReport.execution?.receiptDigest ?? null,
      approvedPlanRevision: managerReport.approvedPlanRevision, milestoneRound: round,
    },
    taskIndex,
    priorArtSurvey: { taskId: survey.taskId, submission: survey.submission, evidenceDigest: survey.evidenceDigest },
    proposedTask: structuredClone(t),
    priorArt: structuredClone(record),
  };
  const task = {
    id, projectId: project.id, milestoneRound: round, planRevision: plan.revision,
    title: t.title, criteria: t.criteria, eligibility: t.eligibility,
    solverAmount: t.proposed_price.solver_amount, reviewerAmount: t.proposed_price.reviewer_amount,
    rationale: Object.fromEntries(PRICE_RATIONALE_PARTS.map((k) => [k, t.proposed_price.rationale[k]])),
    evidenceDigest: digest(evidence),
  };
  const input = {
    task,
    approvedPlan: plan,
    priorArt: { basis: record.basis, searches: structuredClone(record.searches), knownAnswer: record.knownAnswer, openSolutionFound: record.openSolutionFound },
    budget: inputs.budget,
    supply,
    existingTaskIds: inputs.existingTaskIds,
    selection,
  };
  return { input, evidence };
}

/** @returns the `validatePricedTask` input for one proposed task (see `buildTaskProposal`). */
export const proposeTask = (args) => buildTaskProposal(args).input;
