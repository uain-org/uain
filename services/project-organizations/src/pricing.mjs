/** Evidence-based task pricing against a fresh native budget snapshot.
 *
 * The manager sets each amount from documented effort, difficulty, novelty and
 * verification cost; there is no fixed stars-to-money conversion. This module only
 * checks that a proposal is eligible, well formed and affordable against the
 * snapshot it was given. Native `central_task_open` performs the authoritative
 * atomic reservation, so when two proposals race, native state picks the winner. */
import { centralPayload, CENTRAL_POLICY } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import {
  ADDRESS, CATALOGUE_ID, HASH, LIFETIME_UNITS, NATIVE_ID, digest, exactKeys, need, nativeProjectId, plain, refuse, sha256, text, units,
} from './common.mjs';

export const PRICE_SCHEMA = 'uain-project-organization-task-price-v1';
export const PRIOR_ART_SCHEMA = 'uain-project-organization-prior-art-v1';
export const ELIGIBILITY = Object.freeze(['hard', 'new', 'unresolved']);
/** Mirrors native coin.SupplyCap (108 trillion AI$ in micro-units). */
export const SUPPLY_CAP_UNITS = 108000000000000000000n;
export const MIN_PRIOR_ART_SEARCHES = 2;
export const MAX_PRIOR_ART_SEARCHES = 32;

const TASK_KEYS = ['id', 'projectId', 'milestoneRound', 'planRevision', 'title', 'criteria', 'eligibility',
  'solverAmount', 'reviewerAmount', 'rationale', 'evidenceDigest'];
const RATIONALE_KEYS = ['effort', 'difficulty', 'novelty', 'verificationCost'];
const PLAN_KEYS = ['projectId', 'revision', 'approved', 'stages', 'currentRound', 'mainKpiAchieved'];
const PRIOR_ART_KEYS = ['basis', 'searches', 'knownAnswer', 'openSolutionFound'];
const SEARCH_KEYS = ['query', 'source', 'observedAt', 'resultSummary'];
const BUDGET_REQUIRED = ['project', 'allocation', 'reserved', 'paid', 'round', 'policy'];
/** Native CentralBudget fields that may also appear; `closed` and `main_kpi_achieved` are omitempty. */
const BUDGET_OPTIONAL = ['closed', 'main_kpi_achieved', 'lifetime_ceiling', 'manager', 'height', 'evidence_digest'];
const SUPPLY_KEYS = ['cap', 'issued', 'reserved'];

const trimmed = (v, min, max) => text(v, min, max) && v.trim().length >= min;

/** Canonical nonnegative supply units; supply exceeds the per-project lifetime bound. */
function supplyUnits(value, { positive = false } = {}) {
  need(typeof value === 'string' && (positive ? /^[1-9][0-9]{0,20}$/ : /^(0|[1-9][0-9]{0,20})$/).test(value), 'invalid_supply');
  const n = BigInt(value);
  need(n <= SUPPLY_CAP_UNITS, 'invalid_supply');
  return n;
}

function checkTask(task) {
  need(exactKeys(task, TASK_KEYS), 'invalid_task');
  need(typeof task.id === 'string' && NATIVE_ID.test(task.id), 'invalid_task', 'invalid task id');
  need(typeof task.projectId === 'string' && CATALOGUE_ID.test(task.projectId), 'invalid_task', 'invalid project id');
  need(Number.isInteger(task.milestoneRound) && task.milestoneRound >= 1 && task.milestoneRound <= 5, 'invalid_task', 'invalid milestone round');
  need(Number.isSafeInteger(task.planRevision) && task.planRevision >= 1, 'invalid_task', 'invalid plan revision');
  need(trimmed(task.title, 3, 240), 'invalid_task', 'invalid title');
  need(trimmed(task.criteria, 20, 4096), 'invalid_task', 'invalid criteria');
  need(ELIGIBILITY.includes(task.eligibility), 'invalid_task', 'invalid eligibility');
  need(typeof task.evidenceDigest === 'string' && HASH.test(task.evidenceDigest), 'invalid_task', 'invalid evidence digest');
  need(exactKeys(task.rationale, RATIONALE_KEYS), 'invalid_price_rationale');
  for (const k of RATIONALE_KEYS) need(trimmed(task.rationale[k], 10, 2000), 'invalid_price_rationale', `invalid ${k} rationale`);
  const solver = units(task.solverAmount);
  const reviewer = units(task.reviewerAmount);
  need(solver + reviewer <= LIFETIME_UNITS, 'invalid_amount');
  return { solver, reviewer };
}

function checkPlan(plan, task) {
  need(exactKeys(plan, PLAN_KEYS), 'invalid_plan');
  need(plan.approved === true, 'plan_not_approved');
  need(Number.isSafeInteger(plan.revision) && plan.revision >= 1, 'invalid_plan');
  need(Array.isArray(plan.stages) && plan.stages.length === 5, 'invalid_plan', 'a plan has exactly five stages');
  plan.stages.forEach((s, i) => {
    need(exactKeys(s, ['round', 'criteria']) && s.round === i + 1 && trimmed(s.criteria, 20, 4096), 'invalid_plan');
  });
  need(Number.isInteger(plan.currentRound) && plan.currentRound >= 1 && plan.currentRound <= 5, 'invalid_plan');
  need(typeof plan.mainKpiAchieved === 'boolean', 'invalid_plan');
  need(!plan.mainKpiAchieved, 'project_main_kpi_achieved');
  need(plan.projectId === task.projectId, 'plan_project_mismatch');
  need(plan.revision === task.planRevision, 'plan_revision_mismatch');
  need(plan.currentRound === task.milestoneRound, 'milestone_round_mismatch');
}

/** Repository rule: reward only problems with no open-source or discoverable solution. */
function checkPriorArt(priorArt) {
  need(plain(priorArt), 'prior_art_basis_missing');
  need(trimmed(priorArt.basis, 20, 4096), 'prior_art_basis_missing');
  need(exactKeys(priorArt, PRIOR_ART_KEYS), 'invalid_prior_art');
  need(typeof priorArt.knownAnswer === 'boolean' && typeof priorArt.openSolutionFound === 'boolean', 'invalid_prior_art');
  need(!priorArt.knownAnswer, 'known_answer_not_rewardable');
  need(!priorArt.openSolutionFound, 'open_solution_found');
  need(Array.isArray(priorArt.searches) && priorArt.searches.length <= MAX_PRIOR_ART_SEARCHES, 'invalid_prior_art');
  const distinct = new Set();
  for (const s of priorArt.searches) {
    need(exactKeys(s, SEARCH_KEYS), 'invalid_prior_art_search');
    need(trimmed(s.query, 3, 400) && trimmed(s.source, 3, 400) && trimmed(s.resultSummary, 10, 2000), 'invalid_prior_art_search');
    need(typeof s.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s.observedAt) && !Number.isNaN(Date.parse(s.observedAt)),
      'invalid_prior_art_search');
    distinct.add(s.source.trim() + '\n' + s.query.trim().toLowerCase());
  }
  need(distinct.size >= MIN_PRIOR_ART_SEARCHES, 'insufficient_prior_art_searches');
  return { schema: PRIOR_ART_SCHEMA, ...structuredClone(priorArt) };
}

/** Validates a native CentralBudget snapshot and returns its exact accounting. */
export function budgetAccounting(budget) {
  need(plain(budget), 'invalid_budget');
  const keys = Object.keys(budget);
  need(BUDGET_REQUIRED.every((k) => keys.includes(k)) && keys.every((k) => BUDGET_REQUIRED.includes(k) || BUDGET_OPTIONAL.includes(k)), 'invalid_budget');
  need(budget.policy === CENTRAL_POLICY, 'unsupported_budget_policy');
  need(typeof budget.project === 'string' && NATIVE_ID.test(budget.project), 'invalid_budget');
  for (const k of ['closed', 'main_kpi_achieved']) need(budget[k] === undefined || typeof budget[k] === 'boolean', 'invalid_budget');
  need(budget.lifetime_ceiling === undefined || budget.lifetime_ceiling === String(LIFETIME_UNITS), 'invalid_budget');
  need(budget.manager === undefined || (typeof budget.manager === 'string' && ADDRESS.test(budget.manager)), 'invalid_budget');
  need(budget.height === undefined || (typeof budget.height === 'string' && /^[1-9][0-9]{0,18}$/.test(budget.height)), 'invalid_budget');
  need(budget.evidence_digest === undefined || (typeof budget.evidence_digest === 'string' && HASH.test(budget.evidence_digest)), 'invalid_budget');
  need(Number.isInteger(budget.round) && centralUnlockedUnits(budget.round) !== null, 'invalid_budget', 'invalid round');
  need(budget.allocation === centralUnlockedUnits(budget.round), 'budget_allocation_mismatch');
  const allocation = BigInt(budget.allocation);
  const paid = units(budget.paid, { allowZero: true });
  const reserved = units(budget.reserved, { allowZero: true });
  need(paid + reserved <= allocation, 'budget_overspent');
  return { allocation, paid, reserved, available: allocation - paid - reserved };
}

function supplyAccounting(supply) {
  need(exactKeys(supply, SUPPLY_KEYS), 'invalid_supply');
  const cap = supplyUnits(supply.cap, { positive: true });
  const issued = supplyUnits(supply.issued);
  const reserved = supplyUnits(supply.reserved);
  need(issued + reserved <= cap, 'invalid_supply');
  return { cap, available: cap - issued - reserved };
}

function existingIds(value = []) {
  need(Array.isArray(value) || value instanceof Set, 'invalid_existing_task_ids');
  const ids = new Set(value);
  for (const id of ids) need(typeof id === 'string', 'invalid_existing_task_ids');
  return ids;
}

/**
 * @returns {{nativePayload: object, totalUnits: string, availableUnits: string, priceDigest: string, priceEvidence: object}}
 *   `priceEvidence` is the exact preimage of `priceDigest`, to be retained with the intent.
 */
export function validatePricedTask(input) {
  need(plain(input), 'invalid_pricing_input');
  const { task, approvedPlan, priorArt, budget, supply, existingTaskIds, selection } = input;
  need(Object.keys(input).every((k) => ['task', 'approvedPlan', 'priorArt', 'budget', 'supply', 'existingTaskIds', 'selection'].includes(k)),
    'invalid_pricing_input');
  const { solver, reviewer } = checkTask(task);
  need(!existingIds(existingTaskIds).has(task.id), 'duplicate_task');
  if (selection !== undefined) {
    const project = selection.get(task.projectId);
    need(project.holds.length === 0, 'project_held', `${task.projectId} is held: ${project.holds.join(', ')}`);
  }
  need(approvedPlan !== undefined && approvedPlan !== null, 'plan_not_approved');
  checkPlan(approvedPlan, task);
  const priorArtRecord = checkPriorArt(priorArt);

  const nativeProject = nativeProjectId(task.projectId);
  need(plain(budget), 'invalid_budget');
  need(budget.project === nativeProject, 'budget_project_mismatch');
  need(budget.closed !== true, 'project_closed');
  need(budget.main_kpi_achieved !== true, 'project_main_kpi_achieved');
  const accounting = budgetAccounting(budget);
  // Round 6 exists natively only after Main KPI achievement; a snapshot claiming otherwise is inconsistent.
  need(budget.round <= 5, 'invalid_budget', 'round 6 without Main KPI achievement');
  need(budget.round === task.milestoneRound, 'milestone_round_mismatch');
  const total = solver + reviewer;
  need(total <= accounting.available, 'insufficient_project_allowance',
    `requires ${total} units; ${accounting.available} available`);
  const supplyState = supplyAccounting(supply);
  need(total <= supplyState.available, 'supply_cap_exceeded');

  const eligibilityDigest = digest(priorArtRecord);
  const terms = {
    id: task.id,
    project: nativeProject,
    title: task.title,
    criteria: task.criteria,
    acceptance_digest: sha256(task.criteria),
    eligibility: task.eligibility,
    eligibility_digest: eligibilityDigest,
    solver_amount: task.solverAmount,
    reviewer_amount: task.reviewerAmount,
  };
  const priceEvidence = {
    schema: PRICE_SCHEMA,
    task: structuredClone(task),
    plan: { projectId: approvedPlan.projectId, revision: approvedPlan.revision, currentRound: approvedPlan.currentRound,
      stagesDigest: digest(approvedPlan.stages) },
    priorArt: priorArtRecord,
    budget: structuredClone(budget),
    supply: structuredClone(supply),
    totalUnits: total.toString(),
    availableUnits: accounting.available.toString(),
    terms,
  };
  const priceDigest = digest(priceEvidence);
  let nativePayload;
  try {
    nativePayload = centralPayload('central_task_open', { ...terms, evidence_digest: priceDigest });
  } catch (error) {
    refuse('native_payload_rejected', error.message);
  }
  return Object.freeze({
    nativePayload,
    totalUnits: total.toString(),
    availableUnits: accounting.available.toString(),
    priceDigest,
    priceEvidence: Object.freeze(priceEvidence),
  });
}

/** Snapshot after a native reservation of `totalUnits`; refuses what native would refuse. */
export function applyReservation(budget, totalUnits) {
  const total = typeof totalUnits === 'bigint' ? totalUnits : units(totalUnits);
  need(total > 0n, 'invalid_amount');
  need(budget?.closed !== true, 'project_closed');
  need(budget?.main_kpi_achieved !== true, 'project_main_kpi_achieved');
  const { reserved, available } = budgetAccounting(budget);
  need(total <= available, 'insufficient_project_allowance');
  return Object.freeze({ ...budget, reserved: (reserved + total).toString() });
}

/**
 * Maps a native adapter snapshot (`native.snapshot(projectId)`) onto the pricing inputs:
 * the native `central_fund_plan` record plus `central_fund_state` become `approvedPlan`,
 * the native `central_project_budget` record is `budget`, and the read task IDs are
 * `existingTaskIds`. Refuses an unavailable or unapproved snapshot rather than guessing.
 * Supply state is not part of the project snapshot; pass `{supply}` (from the native
 * reader's `supply()`) to include it, or use `readPricingInputs`.
 */
export function pricingInputsFromSnapshot(snapshot, { supply } = {}) {
  need(plain(snapshot) && snapshot.available === true && plain(snapshot.budget) && plain(snapshot.fundState), 'native_snapshot_unavailable');
  need(CATALOGUE_ID.test(snapshot.projectId ?? '') && snapshot.nativeProjectId === nativeProjectId(snapshot.projectId), 'invalid_native_snapshot');
  const fund = snapshot.fundState, plan = snapshot.approvedPlan;
  need(Number.isSafeInteger(fund.approved_revision) && fund.approved_revision >= 1 && plain(plan) && plan.state === 'accept' &&
    plan.revision === fund.approved_revision && plan.project === snapshot.nativeProjectId, 'plan_not_approved');
  need(fund.pending === '' && (fund.revision === fund.approved_revision || snapshot.plan?.state === 'reject'), 'plan_amendment_pending');
  need(Number.isSafeInteger(fund.completed) && fund.completed >= 0 && fund.completed <= 4, 'invalid_native_snapshot');
  need(snapshot.tasks === null || Array.isArray(snapshot.tasks), 'invalid_native_snapshot');
  need(Array.isArray(snapshot.tasks), 'native_tasks_unread', 'existing task IDs must be read before pricing');
  return {
    approvedPlan: {
      projectId: snapshot.projectId, revision: plan.revision, approved: true,
      stages: Array.isArray(plan.stages) ? plan.stages.map((s) => ({ round: s?.round, criteria: s?.criteria })) : plan.stages,
      currentRound: fund.completed + 1, mainKpiAchieved: snapshot.budget.main_kpi_achieved === true,
    },
    budget: structuredClone(snapshot.budget),
    existingTaskIds: snapshot.tasks.map((t) => t.id),
    ...(supply === undefined ? {} : { supply: nativeSupply(supply) }),
  };
}

/** A supply read from native (`reader.supply()`), validated; never a default or a guess. */
function nativeSupply(supply) {
  need(plain(supply), 'native_supply_unread');
  supplyAccounting(supply);
  return { cap: supply.cap, issued: supply.issued, reserved: supply.reserved };
}

/**
 * Fresh pricing inputs from the native adapter and native reader: the project snapshot
 * (plan, budget, existing task IDs) and the global supply (`reader.supply()`). A supply that
 * cannot be read refuses (`native_supply_unread`); it never defaults to zero issued.
 */
export async function readPricingInputs({ native, reader, projectId }) {
  need(typeof native?.snapshot === 'function' && typeof reader?.supply === 'function', 'invalid_pricing_input');
  const snapshot = await native.snapshot(projectId);
  let supply;
  try {
    supply = await reader.supply();
  } catch (error) {
    refuse('native_supply_unread', error?.code ?? 'supply read failed');
  }
  return pricingInputsFromSnapshot(snapshot, { supply });
}
