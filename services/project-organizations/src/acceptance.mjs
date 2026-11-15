/** Receipt-derived per-project acceptance for the frozen 120 organizations.
 *
 * Two distinct reports (design resolution 5):
 * - operational readiness: organization + leadership runs + native start/plan/allowance +
 *   reserved task + actual bounded worker attempt;
 * - reward acceptance: native submission + independent final review + exact awards +
 *   refreshed account readback.
 *
 * Every cell is `{status, evidence, reason}` with status pass | missing | unknown | held.
 * Unknown (unreadable source, unresolved journal outcome, unpinned production chain) is never
 * zero and never pass. A fixture, a non-production chain, an unfinalized proof or another
 * project's record can never fill a row. Selection holds stay held; nothing is substituted.
 *
 * Input contracts (all optional sources may be a Map or plain object keyed by catalogue or
 * native project ID):
 * - nativeSnapshots: {projectId, fixture?, proof:{authority:'native', chainId, height, appHash,
 *   finalized:true, genesisSha256?, fixture?}, records:{<native store key>: value}} using the
 *   chain/federation key names (project/, central_project_budget/, central_fund_state/,
 *   central_fund_config/, central_fund_plan/<id>/<rev20>, central_task/, central_submission/,
 *   central_review/<sub>/<sha(execution)>, central_award/<role>/<sub>, central_earnings/,
 *   central_earning_activation).
 * - paperclipSnapshots: {projectId, fixture?, readAt, company:{id}, agents:[{id, role, reportsTo}]}.
 * - leadershipRuns: [{runId, projectId, companyId, agentId, role:'ceo'|'manager', actual, fixture?,
 *   outcome:'completed'|'blocked'|'failed', finishedAt}].
 * - workerAttempts: [{attemptId, projectId, taskId, leaseId, actual, bounded, fixture?, outcome, finishedAt}].
 * - accountReadbacks: [{member, total, readAt, fixture?}] as displayed by the BAINK account view.
 * - A per-project value `{unavailable: '<reason>'}` in leadershipRuns, workerAttempts or
 *   accountReadbacks means that source could not be read for the project: its cells are
 *   unknown, never missing. A native snapshot may list `unread` record classes (store key
 *   prefixes); a cell that would be missing only for lack of such records is unknown.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADDRESS, HASH, LIFETIME_UNITS, UNITS_PER_AID, need, plain } from './common.mjs';

export const OPERATIONAL_SCHEMA = 'uain-project-organization-operational-readiness-v1';
export const REWARD_SCHEMA = 'uain-project-organization-reward-acceptance-v1';
export const COMBINED_SCHEMA = 'uain-project-organization-acceptance-v1';
export const OPERATIONAL_COLUMNS = Object.freeze(['organization', 'ceoRun', 'managerRun', 'nativeAdmission', 'approvedPlan', 'allowance', 'reservedTask', 'workerAttempt']);
export const REWARD_COLUMNS = Object.freeze(['submission', 'independentReview', 'awards', 'accountReadback']);
export const CELL_STATUSES = Object.freeze(['pass', 'missing', 'unknown', 'held']);
export const STAGES = Object.freeze([1, 5, 20, 120]);
export const POLICY = 'central-earning-five-kpi-fund-v2';
export const OPENING_UNITS = 10000n * UNITS_PER_AID;
export const CUMULATIVE_UNITS = Object.freeze(['10000000000', '110000000000', '1110000000000', '11110000000000', '111110000000000', '1000000000000000']);
/** A selection hold can never be lifted by evidence: native refuses its plan, so everything
 * that depends on an approved plan stays held. */
const PLAN_DEPENDENT = new Set(['approvedPlan', 'reservedTask', 'workerAttempt', ...REWARD_COLUMNS]);
/** Journal operations whose unresolved outcome makes the named columns unknown. */
export const OPERATION_COLUMNS = Object.freeze({
  project_create: ['nativeAdmission'], project_join: ['nativeAdmission'], central_project_start: ['nativeAdmission', 'allowance'],
  central_fund_configure: ['approvedPlan'], central_fund_plan: ['approvedPlan'], central_fund_plan_review: ['approvedPlan'],
  central_fund_apply: ['allowance'], central_fund_decide: ['allowance'],
  central_task_open: ['reservedTask'], central_task_fund: ['reservedTask'],
  central_submit: ['submission'], central_review: ['independentReview', 'awards', 'accountReadback'],
});
const UNRESOLVED = new Set(['claimed', 'dispatched', 'unknown']);
const UNITS = /^(0|[1-9][0-9]{0,20})$/;
const APP_HASH = /^[A-Fa-f0-9]{64}$/;
const HEIGHT = /^[1-9][0-9]{0,19}$/;

const cell = (status, evidence = null, reason = null) => Object.freeze({ status, evidence, reason });
const pass = (evidence) => cell('pass', evidence, null);
const missing = (reason, evidence = null) => cell('missing', evidence, reason);
const unknown = (reason, evidence = null) => cell('unknown', evidence, reason);
const units = (v) => typeof v === 'string' && UNITS.test(v);
const positiveUnits = (v) => units(v) && BigInt(v) > 0n;
const when = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isFixture = (x) => x?.fixture === true || x?.proof?.fixture === true;

function lookup(source, p) {
  if (source === null || source === undefined) return undefined;
  const get = (k) => (source instanceof Map ? source.get(k) : Object.hasOwn(source, k) ? source[k] : undefined);
  return get(p.id) ?? get(p.nativeProjectId);
}
const list = (v) => (Array.isArray(v) ? v.filter(plain) : []);
const unavailableReason = (v) => (plain(v) && typeof v.unavailable === 'string' && /^[a-z0-9_:,.-]{1,200}$/.test(v.unavailable) ? v.unavailable : null);
/** Native record classes and the columns that read nothing but them. */
const UNREAD_COLUMNS = Object.freeze({
  'central_task/': ['reservedTask', 'workerAttempt', ...REWARD_COLUMNS],
  'central_submission/': [...REWARD_COLUMNS],
  'central_review/': ['independentReview', 'awards', 'accountReadback'],
  'central_award/': ['awards', 'accountReadback'],
  'central_earnings/': ['accountReadback'],
  central_earning_activation: ['independentReview', 'awards', 'accountReadback'],
});

/** Native snapshot trust: production chain, finalized proof, this project's snapshot. */
function nativeContext(snapshot, p, production) {
  if (snapshot === undefined || snapshot === null) return { failure: unknown('native_snapshot_unavailable') };
  if (!plain(snapshot) || !plain(snapshot.proof) || !plain(snapshot.records)) return { failure: unknown('native_snapshot_invalid') };
  const proof = snapshot.proof;
  if (isFixture(snapshot)) return { failure: missing('fixture_evidence_not_production', { chainId: String(proof.chainId ?? '') }) };
  if (!production || typeof production.chainId !== 'string' || !production.chainId) return { failure: unknown('production_chain_unpinned') };
  if (proof.chainId !== production.chainId) return { failure: missing('non_production_chain', { chainId: String(proof.chainId ?? '') }) };
  if (production.genesisSha256 && proof.genesisSha256 !== production.genesisSha256) return { failure: missing('non_production_genesis') };
  if (proof.authority !== 'native' || proof.finalized !== true || !HEIGHT.test(String(proof.height ?? '')) || !APP_HASH.test(proof.appHash ?? ''))
    return { failure: unknown('native_proof_not_finalized') };
  if (snapshot.projectId !== p.nativeProjectId && snapshot.projectId !== p.id) return { failure: missing('snapshot_project_mismatch') };
  const records = snapshot.records;
  const rec = (key) => (Object.hasOwn(records, key) && plain(records[key]) ? records[key] : null);
  const prefixed = (prefix) => Object.entries(records).filter(([k, v]) => k.startsWith(prefix) && plain(v));
  const at = { chainId: proof.chainId, height: String(proof.height), appHash: proof.appHash };
  return { rec, prefixed, at, nid: p.nativeProjectId };
}

function organizationCell(binding, snap, p) {
  if (binding === null) return unknown('registry_unavailable');
  const absent = ['paperclipCompanyId', 'ceoAgentId', 'managerAgentId'].filter((f) => !binding[f]);
  if (absent.length) return missing('binding_missing:' + absent.join(','));
  const bound = { companyId: binding.paperclipCompanyId, ceoAgentId: binding.ceoAgentId, managerAgentId: binding.managerAgentId };
  if (snap === undefined || snap === null) return unknown('paperclip_readback_unavailable', bound);
  if (!plain(snap) || !plain(snap.company) || !Array.isArray(snap.agents)) return unknown('paperclip_readback_invalid', bound);
  if (isFixture(snap)) return missing('fixture_evidence_not_production', bound);
  if (snap.projectId !== p.id) return missing('paperclip_readback_project_mismatch', bound);
  if (!when(snap.readAt)) return unknown('paperclip_readback_invalid', bound);
  if (snap.company.id !== binding.paperclipCompanyId) return missing('paperclip_company_mismatch', bound);
  const agent = (id) => snap.agents.find((a) => plain(a) && a.id === id);
  const ceo = agent(binding.ceoAgentId), manager = agent(binding.managerAgentId);
  if (!ceo || ceo.role !== 'ceo') return missing('paperclip_ceo_mismatch', bound);
  if (!manager || manager.role !== 'manager') return missing('paperclip_manager_mismatch', bound);
  if (manager.reportsTo !== ceo.id) return missing('manager_does_not_report_to_ceo', bound);
  return pass({ ...bound, readAt: snap.readAt });
}

function runCell(runs, role, binding, p) {
  if (binding === null) return unknown('registry_unavailable');
  if (unavailableReason(runs)) return unknown(unavailableReason(runs));
  const agentId = binding?.[role === 'ceo' ? 'ceoAgentId' : 'managerAgentId'];
  if (!agentId) return missing('agent_binding_missing');
  const own = list(runs).filter((r) => r.role === role && r.projectId === p.id);
  const actual = own.filter((r) => r.actual === true && !isFixture(r) && r.agentId === agentId && r.companyId === binding.paperclipCompanyId &&
    typeof r.runId === 'string' && when(r.finishedAt) && ['completed', 'blocked', 'failed'].includes(r.outcome));
  if (!actual.length) return missing(own.length ? 'no_actual_run:records_only_or_fixture' : 'no_actual_run');
  actual.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const completed = actual.find((r) => r.outcome === 'completed');
  const latest = { lastRunId: actual[0].runId, lastOutcome: actual[0].outcome, lastFinishedAt: actual[0].finishedAt };
  if (!completed) return missing('last_actual_run_' + actual[0].outcome, latest);
  return pass({ runId: completed.runId, agentId, finishedAt: completed.finishedAt, ...latest });
}

function projectTasks(ctx) {
  return ctx.prefixed('central_task/').map(([k, t]) => [k.slice('central_task/'.length), t])
    .filter(([id, t]) => t.id === id && t.project === ctx.nid && positiveUnits(t.solver_amount) && positiveUnits(t.reviewer_amount) && units(t.reserved ?? '') && units(t.paid ?? ''))
    .map(([, t]) => t);
}
const taskTotal = (t) => (BigInt(t.solver_amount) + BigInt(t.reviewer_amount)).toString();
/** A task proves a finalized reservation when it is currently exactly reserved, or when native
 * settlement shows it was (accepted: both paid; open_unfunded after reject: reviewer paid). */
function reservationProven(t) {
  if (['open', 'under_review'].includes(t.state)) return t.reserved === taskTotal(t);
  if (t.state === 'accepted') return t.paid === taskTotal(t);
  if (t.state === 'open_unfunded') return t.reserved === '0' && BigInt(t.paid) >= BigInt(t.reviewer_amount);
  return false;
}

function nativeCells(ctx, p, binding) {
  const out = {};
  const b = ctx.rec('central_project_budget/' + ctx.nid);
  const project = ctx.rec('project/' + ctx.nid);
  const at = ctx.at;
  // Admission and authoritative start.
  if (!project) out.nativeAdmission = missing('native_project_missing', at);
  else if (project.state !== 'active' || project.safety_halted === true) out.nativeAdmission = missing('native_project_not_active', at);
  else if (!b || b.project !== ctx.nid) out.nativeAdmission = missing('central_project_start_missing', at);
  else if (b.policy !== POLICY) out.nativeAdmission = missing('wrong_policy', at);
  else if (!binding?.nativeManager) out.nativeAdmission = missing('manager_binding_missing', at);
  else if (b.manager !== binding.nativeManager) out.nativeAdmission = missing('native_manager_mismatch', at);
  else out.nativeAdmission = pass({ ...at, recordKey: 'central_project_budget/' + ctx.nid, manager: b.manager });
  // Allowance.
  if (!b || b.project !== ctx.nid) out.allowance = missing('central_project_budget_missing', at);
  else if (!CUMULATIVE_UNITS.includes(b.allocation) || BigInt(b.allocation) < OPENING_UNITS || b.lifetime_ceiling !== LIFETIME_UNITS.toString() ||
    !units(b.reserved) || !units(b.paid) || BigInt(b.paid) + BigInt(b.reserved) > BigInt(b.allocation)) out.allowance = missing('allowance_proof_invalid', at);
  else out.allowance = pass({ ...at, allocation: b.allocation, reserved: b.reserved, paid: b.paid, round: b.round ?? null,
    available: (BigInt(b.allocation) - BigInt(b.paid) - BigInt(b.reserved)).toString() });
  // Approved independent five-stage plan with the unchanged Main KPI.
  const st = ctx.rec('central_fund_state/' + ctx.nid), config = ctx.rec('central_fund_config/' + ctx.nid);
  const rev = Number.isSafeInteger(st?.approved_revision) ? st.approved_revision : 0;
  const planKey = `central_fund_plan/${ctx.nid}/${String(rev).padStart(20, '0')}`;
  const plan = rev > 0 ? ctx.rec(planKey) : null;
  if (!st || rev < 1) out.approvedPlan = missing('no_approved_plan', at);
  else if (!plan || plan.project !== ctx.nid || plan.state !== 'accept') out.approvedPlan = missing('approved_plan_record_missing', at);
  else if (!Array.isArray(plan.stages) || plan.stages.length !== 5 || plan.stages.some((s, i) => !plain(s) || s.round !== i + 1 || typeof s.criteria !== 'string' || s.criteria.trim().length < 20))
    out.approvedPlan = missing('plan_not_five_stages', at);
  else if (plan.main_kpi !== p.mainKpi) out.approvedPlan = missing('main_kpi_changed', at);
  else if (!b || plan.manager !== b.manager || !config || config.evaluator === b.manager || plan.reviewer === plan.manager || plan.reviewer !== config.evaluator)
    out.approvedPlan = missing('plan_not_independently_approved', at);
  else if (binding?.nativeEvaluator && config.evaluator !== binding.nativeEvaluator) out.approvedPlan = missing('evaluator_binding_mismatch', at);
  else out.approvedPlan = pass({ ...at, recordKey: planKey, revision: rev, evaluator: config.evaluator });
  // Reserved task (this project's only).
  const tasks = projectTasks(ctx);
  const reserved = tasks.filter(reservationProven);
  out.reservedTask = reserved.length
    ? pass({ ...at, taskId: reserved[0].id, solverAmount: reserved[0].solver_amount, reviewerAmount: reserved[0].reviewer_amount, state: reserved[0].state, reservedTasks: reserved.length })
    : missing(tasks.length ? 'task_reservation_not_proven' : 'no_reserved_task', at);
  return { cells: out, tasks: reserved };
}

function attemptCell(attempts, p, ctx, tasks) {
  if (unavailableReason(attempts)) return unknown(unavailableReason(attempts));
  const actual = list(attempts).filter((a) => a.projectId === p.id && a.actual === true && a.bounded === true && !isFixture(a) &&
    typeof a.attemptId === 'string' && typeof a.taskId === 'string' && when(a.finishedAt) && ['completed', 'blocked', 'failed'].includes(a.outcome));
  if (!actual.length) return missing(list(attempts).some((a) => a.projectId === p.id) ? 'no_actual_attempt:records_only_or_fixture' : 'no_actual_attempt');
  if (ctx.failure) return unknown(ctx.failure.reason === 'native_snapshot_unavailable' ? 'attempt_task_unverifiable' : ctx.failure.reason);
  const ids = new Set(tasks.map((t) => t.id));
  const own = actual.filter((a) => ids.has(a.taskId)).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  if (!own.length) return missing('attempt_task_not_in_project');
  return pass({ attemptId: own[0].attemptId, taskId: own[0].taskId, outcome: own[0].outcome, finishedAt: own[0].finishedAt });
}

/** Best native evidence trail across this project's tasks: submission -> final review -> awards. */
function rewardCells(ctx, tasks, readbacks) {
  const at = ctx.at;
  const activation = ctx.rec('central_earning_activation');
  const trails = [];
  for (const t of tasks) {
    for (const [k, v] of ctx.prefixed('central_submission/')) {
      const sid = k.slice('central_submission/'.length);
      if (v.id !== sid || v.task !== t.id || !ADDRESS.test(v.author ?? '') || !HASH.test(v.evidence_digest ?? '')) continue;
      const trail = { t, v, score: 1 };
      const reviews = ctx.prefixed(`central_review/${sid}/`).map(([, r]) => r).filter((r) => r.submission === sid);
      const finals = reviews.filter((r) => r.verdict === 'accept' || r.verdict === 'reject');
      trail.needsEvidence = reviews.some((r) => r.verdict === 'needs_evidence');
      const r = finals[0];
      if (finals.length > 1) trail.reviewFailure = 'conflicting_final_reviews';
      else if (!r) trail.reviewFailure = trail.needsEvidence ? 'needs_evidence_not_final' : 'no_final_review';
      else if (!ADDRESS.test(r.reviewer ?? '') || r.reviewer === v.author) trail.reviewFailure = 'reviewer_is_author';
      else if (activation && activation.reviewer !== r.reviewer) trail.reviewFailure = 'reviewer_not_central_reviewer';
      else if (r.criteria_digest !== t.acceptance_digest || r.evidence_digest !== v.evidence_digest) trail.reviewFailure = 'review_digest_mismatch';
      else {
        trail.review = r;
        trail.score = 2;
        const award = (role) => ctx.rec(`central_award/${role}/${sid}`);
        const reviewerAward = award('reviewer'), solverAward = award('solver');
        const exact = (a, role, member, amount) => a && a.role === role && a.member === member && a.amount === amount && a.project === ctx.nid && a.task === t.id && a.submission === sid;
        if (!exact(reviewerAward, 'reviewer', r.reviewer, t.reviewer_amount)) trail.awardFailure = 'reviewer_award_missing_or_inexact';
        else if (r.verdict === 'accept' && !exact(solverAward, 'solver', v.author, t.solver_amount)) trail.awardFailure = 'solver_award_missing_or_inexact';
        else if (r.verdict === 'reject' && solverAward) trail.awardFailure = 'unexpected_solver_award_on_reject';
        else {
          trail.awards = r.verdict === 'accept' ? [reviewerAward, solverAward] : [reviewerAward];
          trail.score = 3;
        }
      }
      trails.push(trail);
    }
  }
  if (!trails.length) {
    const none = missing('no_native_submission', at);
    return { submission: none, independentReview: missing('no_native_submission', at), awards: missing('no_native_submission', at), accountReadback: missing('no_native_submission', at) };
  }
  trails.sort((a, b) => b.score - a.score);
  const best = trails[0];
  const out = {};
  out.submission = pass({ ...at, submissionId: best.v.id, taskId: best.t.id, author: best.v.author, state: best.v.state ?? null, submissions: trails.length });
  if (!best.review) {
    out.independentReview = missing(best.reviewFailure, at);
    out.awards = missing('no_final_review', at);
    out.accountReadback = missing('no_final_review', at);
    return out;
  }
  out.independentReview = pass({ ...at, submissionId: best.v.id, verdict: best.review.verdict, reviewer: best.review.reviewer, executionId: String(best.review.execution_id ?? '') });
  if (!best.awards) {
    out.awards = missing(best.awardFailure, at);
    out.accountReadback = missing('awards_not_proven', at);
    return out;
  }
  out.awards = pass({ ...at, submissionId: best.v.id, verdict: best.review.verdict, awards: best.awards.map((a) => ({ role: a.role, member: a.member, amount: a.amount })) });
  // Account readback: native lifetime earnings cover each award, and the BAINK display shows them.
  const owed = new Map();
  for (const a of best.awards) owed.set(a.member, (owed.get(a.member) ?? 0n) + BigInt(a.amount));
  for (const [member, amount] of owed) {
    const e = ctx.rec('central_earnings/' + member);
    if (!e || e.member !== member || !units(e.total) || BigInt(e.total) < amount) {
      out.accountReadback = missing('native_earnings_missing', at);
      return out;
    }
  }
  if (unavailableReason(readbacks)) {
    out.accountReadback = unknown(unavailableReason(readbacks), at);
    return out;
  }
  const display = list(readbacks).filter((r) => !isFixture(r));
  if (!display.length) {
    out.accountReadback = unknown(list(readbacks).length ? 'fixture_evidence_not_production' : 'account_display_readback_unavailable', at);
    return out;
  }
  const shown = [];
  for (const member of owed.keys()) {
    const e = ctx.rec('central_earnings/' + member);
    const d = display.find((r) => r.member === member && when(r.readAt));
    if (!d) {
      out.accountReadback = unknown('account_display_readback_unavailable', at);
      return out;
    }
    if (d.total !== e.total) {
      out.accountReadback = unknown('account_display_stale', at);
      return out;
    }
    shown.push({ member, total: d.total, readAt: d.readAt });
  }
  out.accountReadback = pass({ ...at, accounts: shown });
  return out;
}

function overlayJournal(cells, intents, columns) {
  for (const i of intents) {
    if (!UNRESOLVED.has(i.state)) continue;
    const affected = (i.kind === 'paperclip' ? ['organization', 'ceoRun', 'managerRun'] : OPERATION_COLUMNS[i.operation] ?? columns).filter((c) => columns.includes(c));
    for (const c of affected)
      if (cells[c].status !== 'pass' && cells[c].status !== 'held')
        cells[c] = unknown('journal_outcome_unknown', { intentId: i.id, operation: i.operation, state: i.state });
  }
}
function applyHolds(cells, p, columns) {
  if (!p.holds.length) return;
  const reason = p.holds.join(',');
  for (const c of columns) if (PLAN_DEPENDENT.has(c)) cells[c] = cell('held', null, reason);
}
/** A reviewed prior-art hold (open solution or known answer) means the project is never
 * opened natively: every cell that has not already passed is held, not missing. */
function applyBootstrapHold(cells, reason, columns) {
  if (!reason) return;
  for (const c of columns) if (cells[c].status !== 'pass') cells[c] = cell('held', null, reason);
}
const HOLD_REASON = /^prior_art_(open_solution_found|known_answer|review_required)$/;
/** Reads `<id>.hold.json` files written by ops/promote-reviewed.mjs into {catalogueId: reason}. */
export function bootstrapHoldsFrom(directory, selection) {
  const holds = {};
  for (const name of readdirSync(directory)) {
    const m = /^(OPP-[0-9]{5})\.hold\.json$/.exec(name);
    if (!m) continue;
    need(selection.has(m[1]), 'invalid_bootstrap_hold', `${name} is not a selected project`);
    const hold = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    need(plain(hold) && typeof hold.reason === 'string' && HOLD_REASON.test(hold.reason), 'invalid_bootstrap_hold', name);
    holds[m[1]] = hold.reason;
  }
  return holds;
}
const rowStatus = (cells) => {
  const v = Object.values(cells).map((c) => c.status);
  return v.every((s) => s === 'pass') ? 'pass' : v.includes('held') ? 'held' : 'incomplete';
};
function counts(rows, columns) {
  const result = { rows: { pass: 0, held: 0, incomplete: 0 }, columns: {} };
  for (const c of columns) result.columns[c] = Object.fromEntries(CELL_STATUSES.map((s) => [s, 0]));
  for (const r of rows) {
    result.rows[r.status]++;
    for (const c of columns) result.columns[c][r.columns[c].status]++;
  }
  return result;
}
/** A stage is reached when every member passes or is explicitly held, and at least one passes. */
export function stageStatus(rows) {
  return STAGES.map((n) => {
    const members = rows.slice(0, n);
    const passed = members.filter((r) => r.status === 'pass').length, held = members.filter((r) => r.status === 'held').length;
    return { stage: n, reached: passed > 0 && passed + held === n, passed, held, incomplete: n - passed - held };
  });
}

export function buildAcceptance({ selection, registry = null, journal = null, nativeSnapshots = null, paperclipSnapshots = null,
  leadershipRuns = null, workerAttempts = null, accountReadbacks = null, production = null, bootstrapHolds = null,
  generatedAt = new Date().toISOString() } = {}) {
  need(selection?.projects?.length === 120 && typeof selection.digest === 'string', 'invalid_acceptance_input', 'a frozen 120-project selection is required');
  need(when(generatedAt), 'invalid_acceptance_input');
  let journalAll = null;
  if (journal) {
    try {
      journalAll = journal.list();
    } catch {
      journalAll = null;
    }
  }
  const operational = [], reward = [];
  for (const p of selection.projects) {
    let binding = null;
    if (registry) {
      try {
        binding = registry.get(p.id);
      } catch {
        binding = null;
      }
    }
    const ctx = nativeContext(lookup(nativeSnapshots, p), p, production);
    const op = {
      organization: organizationCell(binding, lookup(paperclipSnapshots, p), p),
      ceoRun: runCell(lookup(leadershipRuns, p), 'ceo', binding, p),
      managerRun: runCell(lookup(leadershipRuns, p), 'manager', binding, p),
    };
    let tasks = [];
    if (ctx.failure) for (const c of ['nativeAdmission', 'approvedPlan', 'allowance', 'reservedTask']) op[c] = ctx.failure;
    else {
      const native = nativeCells(ctx, p, binding);
      Object.assign(op, native.cells);
      tasks = native.tasks;
    }
    op.workerAttempt = attemptCell(lookup(workerAttempts, p), p, ctx, tasks);
    const rw = ctx.failure ? Object.fromEntries(REWARD_COLUMNS.map((c) => [c, ctx.failure])) : rewardCells(ctx, tasks, lookup(accountReadbacks, p));
    if (!ctx.failure) {
      const unread = lookup(nativeSnapshots, p).unread;
      for (const prefix of Array.isArray(unread) ? unread : [])
        for (const c of UNREAD_COLUMNS[prefix] ?? [])
          for (const set of [op, rw]) if (set[c]?.status === 'missing') set[c] = unknown('native_records_unread', set[c].evidence);
    }
    const intents = journalAll === null ? null : journalAll.filter((i) => i.projectId === p.id);
    if (intents === null && journal === null) {
      // No journal supplied: unresolved writes cannot be excluded, so nothing below pass can be called missing.
      for (const set of [op, rw]) for (const c of Object.keys(set)) if (set[c].status === 'missing') set[c] = unknown('journal_unavailable', set[c].evidence);
    } else if (intents === null) {
      for (const set of [op, rw]) for (const c of Object.keys(set)) if (set[c].status === 'missing') set[c] = unknown('journal_unreadable', set[c].evidence);
    } else {
      overlayJournal(op, intents, OPERATIONAL_COLUMNS);
      overlayJournal(rw, intents, REWARD_COLUMNS);
    }
    applyHolds(op, p, OPERATIONAL_COLUMNS);
    applyHolds(rw, p, REWARD_COLUMNS);
    const bootstrapHold = plain(bootstrapHolds) ? bootstrapHolds[p.id] ?? null : null;
    applyBootstrapHold(op, bootstrapHold, OPERATIONAL_COLUMNS);
    applyBootstrapHold(rw, bootstrapHold, REWARD_COLUMNS);
    const ordered = (cells, cols) => Object.freeze(Object.fromEntries(cols.map((c) => [c, cells[c]])));
    const base = { projectId: p.id, nativeProjectId: p.nativeProjectId, holds: [...p.holds, ...(bootstrapHold ? [bootstrapHold] : [])] };
    const opCols = ordered(op, OPERATIONAL_COLUMNS), rwCols = ordered(rw, REWARD_COLUMNS);
    operational.push({ ...base, status: rowStatus(opCols), columns: opCols });
    reward.push({ ...base, status: rowStatus(rwCols), columns: rwCols });
  }
  const opCounts = counts(operational, OPERATIONAL_COLUMNS), rwCounts = counts(reward, REWARD_COLUMNS);
  const header = { selectionDigest: selection.digest, generatedAt, total: 120, production: production?.chainId ? { chainId: production.chainId } : null };
  return {
    operationalReadiness: { schema: OPERATIONAL_SCHEMA, ...header, columns: [...OPERATIONAL_COLUMNS], projects: operational, counts: opCounts,
      stages: stageStatus(operational), complete: opCounts.rows.pass === 120 },
    rewardAcceptance: { schema: REWARD_SCHEMA, ...header, columns: [...REWARD_COLUMNS], projects: reward, counts: rwCounts, complete: rwCounts.rows.pass === 120 },
  };
}

function checkReport(r, schema, columns) {
  need(plain(r) && r.schema === schema && Array.isArray(r.projects) && r.projects.length === 120 && typeof r.selectionDigest === 'string', 'invalid_acceptance_report');
  for (const row of r.projects) need(plain(row.columns) && columns.every((c) => CELL_STATUSES.includes(row.columns[c]?.status)), 'invalid_acceptance_report');
  need(r.complete === r.projects.every((row) => row.status === 'pass'), 'invalid_acceptance_report');
}
function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o640, flag: 'wx' });
  renameSync(tmp, path);
  return path;
}
/** Writes the two distinct reports plus a combined file for the private BAINK projection. */
export function writeReports(dir, acceptance) {
  need(typeof dir === 'string' && dir.length > 0 && plain(acceptance), 'invalid_acceptance_report');
  const { operationalReadiness: op, rewardAcceptance: rw } = acceptance;
  checkReport(op, OPERATIONAL_SCHEMA, OPERATIONAL_COLUMNS);
  checkReport(rw, REWARD_SCHEMA, REWARD_COLUMNS);
  need(op.selectionDigest === rw.selectionDigest && op.projects.every((r, i) => r.projectId === rw.projects[i].projectId), 'invalid_acceptance_report');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    operationalReadiness: writeAtomic(join(dir, 'operational-readiness.json'), op),
    rewardAcceptance: writeAtomic(join(dir, 'reward-acceptance.json'), rw),
    combined: writeAtomic(join(dir, 'acceptance.json'), { schema: COMBINED_SCHEMA, selectionDigest: op.selectionDigest, generatedAt: op.generatedAt, operationalReadiness: op, rewardAcceptance: rw }),
  };
}
