/** The prior-art survey: the first task of every project organization.
 *
 * Decided by Rahul on 6 November 2026. Before an organization proposes any research
 * task, it pays one small task to report everything that already exists on the
 * internet for its Main KPI: papers, open code, trials, products and programmes,
 * each cited by an identifier a fixed primary-source record API resolves. Later
 * tasks are proposed against that inventory, and an inventory that shows the Main
 * KPI already met holds the project.
 *
 * Why this task is rewardable under the rule that only problems with no open or
 * discoverable solution are created and rewarded: the reward pays for a checked,
 * dated inventory of existing work against this exact Main KPI, which does not
 * exist until it is made. It makes no novelty claim about the Main KPI. Its basis
 * is the project's independently reviewed prior-art record (the AI reviewer Rahul
 * accepted on 6 November 2026) together with that decision.
 *
 * Everything here is deterministic. No model writes the task, its price, its
 * criteria or its verification policy.
 */
import { CATALOGUE_ID, HASH, digest, exactKeys, need, plain, sha256, text } from './common.mjs';
import { PRIOR_ART_SCHEMA, pricingInputsFromSnapshot } from './pricing.mjs';
import { centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { sourceDigestOf } from './selection.mjs';
import { NATIVE_CLASSES, validateBootstrapReview } from './bootstrap.mjs';
import { KINDS, MAX_ITEMS, RELATIONS, normalizeId } from '../verifiers/prior-art-survey.mjs';
import { SURVEY_CLASS, SURVEY_DRIVER, SURVEY_HOSTS, SURVEY_RESOLVERS, surveyResolution } from './survey-sources.mjs';

export { KINDS as SURVEY_KINDS, RELATIONS as SURVEY_RELATIONS, MAX_ITEMS as SURVEY_MAX_ITEMS, normalizeId as normalizeSurveyId };
export { SURVEY_CLASS, SURVEY_DRIVER, SURVEY_HOSTS, SURVEY_RESOLVERS, surveyResolution };
export const SURVEY_TASK_SCHEMA = 'uain-project-organization-survey-task-v1';
export const SURVEY_DECISION = Object.freeze({
  decidedBy: 'Rahul',
  decidedAt: '2026-11-06',
  record: 'docs/baink/project-organizations-2026-11-06/decisions.md#d2',
});
/** 200 AI$ to the solver and 50 AI$ to the reviewer: 2.5% of the 10,000 AI$ opening allowance. */
export const SURVEY_SOLVER_UNITS = '200000000';
export const SURVEY_REVIEWER_UNITS = '50000000';
export const SURVEY_MIN_INCLUDED = 8;
export const SURVEY_MIN_KINDS = 2;
/** Identifiers from the project-level searches the survey must account for; leaves room for its own finds. */
export const SURVEY_MAX_REQUIRED = 40;
/**
 * Survey parts (Rahul, 9 November 2026: tasks split into single units an AI can finish easily;
 * decisions C1 and D-4 at their recorded defaults). A part is the same checked inventory for at
 * most SURVEY_PART_MAX_REQUIRED of the project-level identifiers, about 20 minutes of work,
 * checked by the same hash-pinned prior-art-survey driver fixed in its policy at opening. Its
 * reward is proportional to the full survey's rate: 20 AI$ per required record (200 AI$ for the
 * survey's ~10 records) plus a 10 AI$ check.
 */
export const SURVEY_PART_SCHEMA = 'uain-project-organization-survey-part-v1';
export const SURVEY_PART_DECISION = Object.freeze({
  decidedBy: 'Rahul',
  decidedAt: '2026-11-09',
  record: 'docs/baink/questions-9-nov-2026.md#c1',
});
export const SURVEY_PART_MAX_REQUIRED = 3;
export const SURVEY_PART_MAX_PARTS = 12;
export const SURVEY_PART_MINUTES = 20;
export const SURVEY_PART_SOLVER_UNITS_PER_RECORD = 20_000_000n;
export const SURVEY_PART_REVIEWER_UNITS = '10000000';
export const SURVEY_PART_MIN_INCLUDED = 1;
export const SURVEY_PART_MIN_KINDS = 1;
const SURVEY_PART_ID = /^T-(OPP-[0-9]{5})-1-prior-art-survey-r([2-9])-p([1-9][0-9]?)$/;
const SURVEY_PART_TITLE = /\(part ([1-9][0-9]?) of ([1-9][0-9]?)\)$/;

export const surveyPartTaskId = (projectId, revision, part) => {
  need(typeof projectId === 'string' && CATALOGUE_ID.test(projectId) && Number.isSafeInteger(revision) && revision >= 2 && revision <= 9 &&
    Number.isSafeInteger(part) && part >= 1 && part <= SURVEY_PART_MAX_PARTS, 'invalid_survey_part');
  return `T-${projectId}-1-prior-art-survey-r${revision}-p${part}`;
};
/** `{projectId, revision, part}` of a survey-part task id, or null. */
export function parseSurveyPartId(taskId) {
  const m = typeof taskId === 'string' ? SURVEY_PART_ID.exec(taskId) : null;
  return m ? { projectId: m[1], revision: Number(m[2]), part: Number(m[3]) } : null;
}
/** Whether a task id is this project's survey or one of its survey parts. */
export const isSurveyTask = (projectId, taskId) => taskId === surveyTaskId(projectId) || parseSurveyPartId(taskId)?.projectId === projectId;

/** States in which the survey is not yet decided, and later tasks wait. */
const SURVEY_PENDING_STATES = Object.freeze(['open', 'open_unfunded', 'under_review']);

export const surveyTaskId = (projectId) => {
  need(typeof projectId === 'string' && CATALOGUE_ID.test(projectId), 'invalid_survey_project');
  return `T-${projectId}-1-prior-art-survey`;
};

/** Search source label -> survey identifier kind (sources without a record API are skipped). */
const SOURCE_KINDS = Object.freeze({
  'api.github.com/search/repositories': 'github',
  'export.arxiv.org/api/query': 'arxiv',
  'api.crossref.org/works': 'doi',
});

/**
 * The identifiers the trusted project-level searches returned (their `top:` entries), in
 * search order, canonical and without duplicates. The survey must account for each one:
 * include it, or screen it out with a note. Results that are plainly unrelated are
 * screened out, which is still a reviewed decision on the record.
 */
export function requiredIdsFromSearches(searches) {
  need(Array.isArray(searches), 'invalid_survey_searches');
  const out = [];
  const seen = new Set();
  for (const s of searches) {
    const kind = SOURCE_KINDS[s?.source];
    if (!kind || typeof s.resultSummary !== 'string') continue;
    const top = s.resultSummary.split('; top: ')[1];
    if (!top) continue;
    for (const entry of top.split(' | ')) {
      // A display fallback is not a primary title. Historical summaries remain
      // evidence, but future task generation must not turn absent titles into an
      // impossible exact-title requirement. DOI punctuation stays canonical.
      const match = /^(\S+) "([^"]+)"$/.exec(entry);
      if (!match || !match[2].trim() || /^untitled$/i.test(match[2].trim())) continue;
      const id = normalizeId(kind, match[1]);
      if (id === null || seen.has(`${kind}:${id}`)) continue;
      seen.add(`${kind}:${id}`);
      out.push({ kind, id });
      if (out.length >= SURVEY_MAX_REQUIRED) return out;
    }
  }
  return out;
}

const clip = (value, bytes) => {
  if (Buffer.byteLength(value) <= bytes) return value;
  return Buffer.from(value).subarray(0, bytes - 3).toString('utf8').replace(/�+$/, '').trimEnd() + '...';
};

/** The fixed criteria text. Its sha256 is the native acceptance digest. */
export function surveyCriteria({ title, mainKpi, required }) {
  need(text(title, 1, 1000) && text(mainKpi, 20, 4096) && Number.isSafeInteger(required) && required >= 0, 'invalid_survey_criteria');
  const head = `Prior-art survey for "${clip(title, 200)}". Main KPI: "${clip(mainKpi, 600)}". ` +
    'Report the work that already exists for this Main KPI as an evidence artifact whose "survey" field is ' +
    '{mainKpi, asOf, items, conclusion}. mainKpi is the Main KPI above, exactly. asOf is the survey date (YYYY-MM-DD). ' +
    `Each of 1 to ${MAX_ITEMS} items is {kind, id, title, relation, note}: kind is one of ${KINDS.join(', ')}; ` +
    'id is the canonical identifier (lowercase DOI, arXiv id without version, lowercase owner/repo, PubMed id, NCT number, Wikidata Q-id); ' +
    'title is the title of that record; relation is meets_main_kpi, partial, adjacent or screened_out; note says in 10 to 400 bytes ' +
    'what the item does for the Main KPI, or why it was screened out. ' +
    `At least ${SURVEY_MIN_INCLUDED} items are not screened out, from at least ${SURVEY_MIN_KINDS} kinds. ` +
    `Every one of the ${required} identifiers the project-level searches returned (listed in the verification policy) is an item. ` +
    'conclusion is {meetsMainKpi, gaps}: meetsMainKpi is true exactly when an item meets the Main KPI as written; gaps lists, ' +
    'in up to 12 entries of 20 to 600 bytes, what existing work leaves undone (at least one when meetsMainKpi is false). ' +
    'Accepted when the fixed prior-art-survey verifier resolves every identifier through its primary-source record API with a ' +
    'matching title and finds the survey complete and consistent, and the central reviewer finds it accurate. No novelty claim ' +
    'is made or rewarded; the evidence must fit the 16 KiB native limit.';
  return head;
}

/** The fixed criteria of one survey part. Its sha256 is the native acceptance digest. */
export function surveyPartCriteria({ title, mainKpi, part, parts, requiredIds }) {
  need(text(title, 1, 1000) && text(mainKpi, 20, 4096) && Number.isSafeInteger(part) && Number.isSafeInteger(parts) && part >= 1 &&
    part <= parts && Array.isArray(requiredIds) && requiredIds.length >= 1 && requiredIds.length <= SURVEY_PART_MAX_REQUIRED &&
    requiredIds.every((r) => plain(r) && normalizeId(r.kind, r.id) === r.id), 'invalid_survey_criteria');
  const required = requiredIds.length;
  const listed = requiredIds.map((r) => `${r.kind} ${r.id}`).join('; ');
  return `Prior-art survey part ${part} of ${parts} for "${clip(title, 200)}". Main KPI: "${clip(mainKpi, 600)}". ` +
    `A small unit, expected within ${SURVEY_PART_MINUTES} minutes: check ${required === 1 ? 'this identifier' : `these ${required} identifiers`} ` +
    `the project-level searches returned against this Main KPI: ${listed}. Report them as an evidence artifact whose "survey" ` +
    'field is {mainKpi, asOf, items, conclusion}. mainKpi is the Main KPI above, exactly. asOf is the survey date (YYYY-MM-DD). ' +
    `Each of 1 to ${MAX_ITEMS} items is {kind, id, title, relation, note}: kind is one of ${KINDS.join(', ')}; ` +
    'id is the canonical identifier; title is the title of that record; relation is meets_main_kpi, partial, adjacent or screened_out; ' +
    'note says in 10 to 400 bytes what the item does for the Main KPI, or why it was screened out. ' +
    `Every identifier above is an item, and at least ${SURVEY_PART_MIN_INCLUDED} item is not screened out (add one record you found if ` +
    'all listed ones are unrelated). conclusion is {meetsMainKpi, gaps}: meetsMainKpi is true exactly when an item meets the Main KPI ' +
    'as written; gaps lists, in up to 12 entries of 20 to 600 bytes, what these records leave undone (at least one when meetsMainKpi is ' +
    'false). Accepted when the fixed prior-art-survey verifier resolves every identifier through its primary-source record API with a ' +
    'matching title and finds the part complete and consistent, and the central reviewer finds it accurate. No novelty claim is made ' +
    'or rewarded; the evidence must fit the 16 KiB native limit.';
}

/** Solver reward of a part: proportional to its required records. */
export const surveyPartSolverUnits = (required) => {
  need(Number.isSafeInteger(required) && required >= 1 && required <= SURVEY_PART_MAX_REQUIRED, 'invalid_survey_part');
  return String(SURVEY_PART_SOLVER_UNITS_PER_RECORD * BigInt(required));
};

const PRICE_RATIONALE = Object.freeze({
  effort: 'Fixed survey price (Rahul, 6 November 2026): one bounded search-and-report pass over existing literature, code, trials and programmes.',
  difficulty: 'Low to moderate: finding and classifying existing work, without new research or experiments.',
  novelty: 'Pays for a checked, dated inventory of existing work against this Main KPI; no novelty claim about the Main KPI.',
  verificationCost: 'Deterministic: every identifier is resolved through a fixed record API by the hash-pinned prior-art-survey driver, then reviewed once.',
});

function checkSurveyBasis(draft, reviewed, project) {
  // The draft shape bootstrap-record.mjs validates (not imported: it would close an import cycle).
  need(plain(draft) && draft.schema === 'uain-project-organization-bootstrap-draft-v1' && Array.isArray(draft.searches) &&
    draft.class === null && draft.assessment === null, 'invalid_bootstrap_draft');
  need(draft.project === project.id && draft.source_digest === project.sourceDigest, 'survey_draft_mismatch', `${project.id} draft is bound to another source`);
  validateBootstrapReview(reviewed, project);
  need(NATIVE_CLASSES.includes(reviewed.class) && plain(reviewed.prior_art) && text(reviewed.prior_art.basis, 40, 4000), 'invalid_prior_art_review');
  const searches = draft.searches.filter((s) => exactKeys(s, ['query', 'source', 'observedAt', 'resultSummary']));
  need(searches.length >= 2, 'insufficient_prior_art_searches');
  return searches.slice(0, 32);
}

/** The root-owned verification policy for one project's survey task. */
export function surveyVerificationPolicy({ projectId, nativeProjectId, criteria, mainKpi, requiredIds, driverSha256, taskId, minIncluded = SURVEY_MIN_INCLUDED, minKinds = SURVEY_MIN_KINDS }) {
  need(CATALOGUE_ID.test(projectId ?? '') && typeof nativeProjectId === 'string' && HASH.test(driverSha256 ?? ''), 'invalid_survey_policy');
  need(taskId === undefined || isSurveyTask(projectId, taskId), 'invalid_survey_policy');
  return {
    schema: 'uain-task-verification-policy-v1',
    class: SURVEY_CLASS,
    taskId: taskId ?? surveyTaskId(projectId),
    projectId: nativeProjectId,
    criteriaDigest: sha256(criteria),
    inputs: [],
    primarySourceHosts: [...SURVEY_HOSTS],
    driver: { name: SURVEY_DRIVER, sha256: driverSha256 },
    successTests: [{ id: 'survey', mainKpi, minIncluded, minKinds, requiredIds: structuredClone(requiredIds) }],
  };
}

/**
 * The survey task for one opened project, as the exact `validatePricedTask` input.
 *
 * @param approvedPlan native snapshot (`native.snapshot(projectId)`): an approved plan in
 *   round 1 with no task opened yet. The survey is the organization's first task.
 * @param pricingSnapshot `{supply}` read from native.
 * @param draft the project's bootstrap draft (trusted project-level searches).
 * @param reviewed the project's promoted bootstrap record (independent prior-art review).
 * @param driverSha256 sha256 of verifiers/prior-art-survey.mjs (`driverDigest('prior-art-survey')`).
 * @returns {{input, evidence, policy}} retain `evidence` (preimage of the task evidence digest) and
 *   install `policy` root-owned for the verifier before the task opens.
 */
/** The deterministic parts of one project's survey task: no native state is read. */
function surveyParts({ projectId, selection, source, draft, reviewed, driverSha256 }) {
  need(selection?.projects?.length === 120 && Object.isFrozen(selection) && typeof selection.get === 'function', 'invalid_survey_configuration',
    'frozen selection required');
  const project = selection.get(projectId);
  need(project.holds.length === 0, 'project_held', `${project.id} is held: ${project.holds.join(', ')}`);
  need(plain(source) && plain(source.row) && source.row.id === project.id, 'selected_source_missing');
  need(sourceDigestOf(source.row, source.revision) === project.sourceDigest, 'selected_source_changed');
  const searches = checkSurveyBasis(draft, reviewed, project);
  const requiredIds = requiredIdsFromSearches(searches);
  need(requiredIds.length > 0, 'insufficient_survey_records', 'no eligible primary record with a real title in reviewed searches');
  const criteria = surveyCriteria({ title: source.row.title, mainKpi: project.mainKpi, required: requiredIds.length });
  need(Buffer.byteLength(criteria) <= 4096, 'invalid_survey_criteria', 'criteria above the native limit');
  const policy = surveyVerificationPolicy({
    projectId: project.id, nativeProjectId: project.nativeProjectId, criteria, mainKpi: project.mainKpi, requiredIds, driverSha256,
  });
  const basis = clip(`Prior-art survey task, decided by ${SURVEY_DECISION.decidedBy} on ${SURVEY_DECISION.decidedAt} as the first task of ` +
    `every project organization (${SURVEY_DECISION.record}). It pays for a checked, dated inventory of existing work against this Main KPI, ` +
    'not for a novelty claim. No such inventory exists before this task makes it. Project-level review: ' + reviewed.prior_art.basis, 4096);
  const evidence = {
    schema: SURVEY_TASK_SCHEMA,
    decision: { ...SURVEY_DECISION },
    projectId: project.id,
    draftDigest: digest(draft),
    reviewedDigest: digest(reviewed),
    policyDigest: digest(policy),
    requiredIds: structuredClone(requiredIds),
  };
  const priorArt = { basis, searches: structuredClone(searches), knownAnswer: false, openSolutionFound: false };
  return { project, criteria, policy, evidence, priorArt, taskId: surveyTaskId(project.id), title: clip(`Prior-art survey: ${source.row.title}`, 240) };
}

/**
 * The survey task for one opened project, as the exact `validatePricedTask` input.
 *
 * @param approvedPlan native snapshot (`native.snapshot(projectId)`): an approved plan in
 *   round 1 with no task opened yet. The survey is the organization's first task.
 * @param pricingSnapshot `{supply}` read from native.
 * @param draft the project's bootstrap draft (trusted project-level searches).
 * @param reviewed the project's promoted bootstrap record (independent prior-art review).
 * @param driverSha256 sha256 of verifiers/prior-art-survey.mjs (`driverDigest('prior-art-survey')`).
 * @returns {{input, evidence, policy}} retain `evidence` (preimage of the task evidence digest) and
 *   install `policy` root-owned for the verifier before the task opens.
 */
export function buildSurveyTask({ projectId, selection, source, draft, reviewed, approvedPlan, pricingSnapshot, driverSha256 } = {}) {
  const parts = surveyParts({ projectId, selection, source, draft, reviewed, driverSha256 });
  const { project, taskId } = parts;
  const inputs = pricingInputsFromSnapshot(approvedPlan);
  const plan = inputs.approvedPlan;
  need(plan.projectId === project.id, 'plan_project_mismatch');
  need(plan.currentRound === 1, 'survey_round_passed', 'the survey is the first task of round 1');
  need(!inputs.existingTaskIds.includes(taskId), 'survey_already_open');
  need(inputs.existingTaskIds.length === 0, 'survey_not_first', 'another task was opened before the survey');
  need(plain(pricingSnapshot) && plain(pricingSnapshot.supply), 'native_supply_unread', 'supply must be read from native before pricing');
  const task = {
    id: taskId, projectId: project.id, milestoneRound: 1, planRevision: plan.revision,
    title: parts.title, criteria: parts.criteria, eligibility: 'new',
    solverAmount: SURVEY_SOLVER_UNITS, reviewerAmount: SURVEY_REVIEWER_UNITS,
    rationale: { ...PRICE_RATIONALE }, evidenceDigest: digest(parts.evidence),
  };
  const input = {
    task, approvedPlan: plan, priorArt: parts.priorArt,
    budget: inputs.budget, supply: structuredClone(pricingSnapshot.supply), existingTaskIds: inputs.existingTaskIds, selection,
  };
  return { input, evidence: parts.evidence, policy: parts.policy };
}

/**
 * The exact `central_task_open` payload of a starter organization's survey, computed without a
 * native snapshot so it can be pinned root-owned before the project opens. Fleet custody checks
 * native state (approved plan, budget manager, no task yet) when it signs. `eligibility_digest`
 * is the digest of the prior-art record (as `validatePricedTask` computes it) and
 * `evidence_digest` the digest of the survey evidence preimage.
 */
export function buildSurveyOpenPayload({ projectId, selection, source, draft, reviewed, driverSha256 } = {}) {
  const parts = surveyParts({ projectId, selection, source, draft, reviewed, driverSha256 });
  const payload = centralPayload('central_task_open', {
    id: parts.taskId, project: parts.project.nativeProjectId, title: parts.title, criteria: parts.criteria,
    acceptance_digest: sha256(parts.criteria), eligibility: 'new',
    eligibility_digest: digest({ schema: PRIOR_ART_SCHEMA, ...parts.priorArt }),
    solver_amount: SURVEY_SOLVER_UNITS, reviewer_amount: SURVEY_REVIEWER_UNITS, evidence_digest: digest(parts.evidence),
  });
  return { payload, evidence: parts.evidence, policy: parts.policy, priorArt: parts.priorArt };
}

/**
 * Validated primary-record preflight: which required identifiers resolve through their record API
 * with a real title. Recorded offline by `ops/survey-preflight.mjs` and reviewed before an opening;
 * an identifier it did not resolve (a mangled DOI from an old draft, a grant record with no title)
 * is never required, so no part carries an impossible contract.
 */
export const SURVEY_PREFLIGHT_SCHEMA = 'uain-survey-preflight-v1';
export function validateSurveyPreflight(preflight, projectId) {
  need(plain(preflight) && exactKeys(preflight, ['schema', 'projectId', 'checkedAt', 'records']) && preflight.schema === SURVEY_PREFLIGHT_SCHEMA &&
    preflight.projectId === projectId && typeof preflight.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(preflight.checkedAt) &&
    Array.isArray(preflight.records) && preflight.records.length <= SURVEY_MAX_REQUIRED, 'invalid_survey_preflight');
  const seen = new Set();
  for (const r of preflight.records) {
    need(plain(r) && exactKeys(r, ['kind', 'id', 'status', 'title']) && normalizeId(r.kind, r.id) === r.id && !seen.has(`${r.kind}:${r.id}`) &&
      ['resolved', 'not_found', 'untitled', 'unreadable'].includes(r.status) &&
      (r.status === 'resolved' ? text(r.title, 1, 1000) && !/^untitled$/i.test(r.title.trim()) : r.title === null), 'invalid_survey_preflight');
    seen.add(`${r.kind}:${r.id}`);
  }
  return preflight;
}

/**
 * A replacement survey split into parts, for a project whose first survey contract cannot be
 * satisfied (held by the operator as `task_specification_unusable`; there is no native withdraw).
 * Revision `r` is a successor: the old contract stays exactly as it is on native, and the
 * project's survey counts as accepted once every part of the latest revision is accepted.
 * Every part targets records that no accepted inventory covers yet.
 *
 * @returns {{parts: Array<{payload, evidence, policy}>, dropped: Array<{kind,id,status}>}}
 */
export function buildSurveyPartPayloads({ projectId, selection, source, draft, reviewed, driverSha256, revision = 2, supersedes, preflight } = {}) {
  const base = surveyParts({ projectId, selection, source, draft, reviewed, driverSha256 });
  const { project } = base;
  need(supersedes === base.taskId, 'invalid_survey_part', 'a part revision supersedes the project survey');
  validateSurveyPreflight(preflight, project.id);
  const checked = new Map(preflight.records.map((r) => [`${r.kind}:${r.id}`, r]));
  const required = base.evidence.requiredIds;
  need(required.every((r) => checked.has(`${r.kind}:${r.id}`)), 'survey_preflight_incomplete', 'every required identifier must be preflighted');
  const usable = required.filter((r) => checked.get(`${r.kind}:${r.id}`).status === 'resolved');
  const dropped = required.filter((r) => checked.get(`${r.kind}:${r.id}`).status !== 'resolved')
    .map((r) => ({ kind: r.kind, id: r.id, status: checked.get(`${r.kind}:${r.id}`).status }));
  need(usable.length > 0, 'insufficient_survey_records', 'no required identifier resolved in the preflight');
  const groups = [];
  for (let i = 0; i < usable.length; i += SURVEY_PART_MAX_REQUIRED) groups.push(usable.slice(i, i + SURVEY_PART_MAX_REQUIRED));
  need(groups.length <= SURVEY_PART_MAX_PARTS, 'survey_too_many_parts');
  const priorArt = base.priorArt;
  const eligibilityDigest = digest({ schema: PRIOR_ART_SCHEMA, ...priorArt });
  const parts = groups.map((requiredIds, index) => {
    const part = index + 1;
    const taskId = surveyPartTaskId(project.id, revision, part);
    const criteria = surveyPartCriteria({ title: source.row.title, mainKpi: project.mainKpi, part, parts: groups.length, requiredIds });
    need(Buffer.byteLength(criteria) <= 4096, 'invalid_survey_criteria', 'criteria above the native limit');
    const policy = surveyVerificationPolicy({
      projectId: project.id, nativeProjectId: project.nativeProjectId, criteria, mainKpi: project.mainKpi, requiredIds, driverSha256, taskId,
      minIncluded: SURVEY_PART_MIN_INCLUDED, minKinds: SURVEY_PART_MIN_KINDS,
    });
    const evidence = {
      schema: SURVEY_PART_SCHEMA,
      decision: { ...SURVEY_DECISION },
      splitDecision: { ...SURVEY_PART_DECISION },
      projectId: project.id,
      revision, part, parts: groups.length, supersedes,
      draftDigest: base.evidence.draftDigest,
      reviewedDigest: base.evidence.reviewedDigest,
      preflightDigest: digest(preflight),
      policyDigest: digest(policy),
      requiredIds: structuredClone(requiredIds),
      dropped: structuredClone(dropped),
      novelty: 'Each listed record is unresolved: no accepted inventory of this project covers it yet.',
    };
    const solver = surveyPartSolverUnits(requiredIds.length);
    const payload = centralPayload('central_task_open', {
      id: taskId, project: project.nativeProjectId,
      title: `${clip(`Prior-art survey: ${source.row.title}`, 220)} (part ${part} of ${groups.length})`,
      criteria, acceptance_digest: sha256(criteria), eligibility: 'new', eligibility_digest: eligibilityDigest,
      solver_amount: solver, reviewer_amount: SURVEY_PART_REVIEWER_UNITS, evidence_digest: digest(evidence),
    });
    return { payload, evidence, policy };
  });
  return { parts, dropped, priorArt };
}

/** Project-agent survey parts (Rahul, 9 November 2026: each project organization runs its own two
 * Sonnet agents, which keep at least three small units open). The project manager agent proposes
 * existing-work identifiers no part of the project covers yet; a separate assessor agent accepts
 * each unit; every identifier was resolved with a real title by the fixed record API before this
 * builder runs. A unit is a part exactly like a reviewed replacement part (same criteria, policy,
 * 20 AI$ per record and 10 AI$ check), at a later revision so its task id never collides.
 *
 * @param units Array<Array<{kind,id}>> each 1..3 resolved identifiers, in part order
 * @param agents {writer, assessor} receipts digests bound into each part's evidence
 */
export const PROJECT_AGENT_PART_SCHEMA = 'uain-project-agent-survey-part-v1';
export const PROJECT_AGENT_DECISION = Object.freeze({
  decidedBy: 'Rahul',
  decidedAt: '2026-11-09',
  answer: 'At least 50 open projects with 3 open small tasks each; two Sonnet agents per project start on project activity.',
});
export function buildAgentPartPayloads({ projectId, selection, source, draft, reviewed, driverSha256, revision, units, covered = [], agents } = {}) {
  const base = surveyParts({ projectId, selection, source, draft, reviewed, driverSha256 });
  const { project } = base;
  need(Number.isSafeInteger(revision) && revision >= 3 && revision <= 9, 'invalid_survey_part', 'agent parts use revisions 3 to 9');
  need(Array.isArray(units) && units.length >= 1 && units.length <= SURVEY_PART_MAX_PARTS, 'invalid_survey_part');
  need(plain(agents) && HASH.test(agents.writer ?? '') && HASH.test(agents.assessor ?? '') && agents.writer !== agents.assessor, 'invalid_agent_receipts');
  const seen = new Set(covered.map((r) => `${r.kind}:${r.id}`));
  for (const unit of units) {
    need(Array.isArray(unit) && unit.length >= 1 && unit.length <= SURVEY_PART_MAX_REQUIRED, 'invalid_survey_part');
    for (const r of unit) {
      need(plain(r) && exactKeys(r, ['kind', 'id']) && KINDS.includes(r.kind) && normalizeId(r.kind, r.id) === r.id, 'invalid_survey_part');
      need(!seen.has(`${r.kind}:${r.id}`), 'survey_part_duplicate', `${r.kind} ${r.id} is already covered`);
      seen.add(`${r.kind}:${r.id}`);
    }
  }
  const supersedes = base.taskId;
  const eligibilityDigest = digest({ schema: PRIOR_ART_SCHEMA, ...base.priorArt });
  const parts = units.map((requiredIds, index) => {
    const part = index + 1;
    const taskId = surveyPartTaskId(project.id, revision, part);
    const criteria = surveyPartCriteria({ title: source.row.title, mainKpi: project.mainKpi, part, parts: units.length, requiredIds });
    need(Buffer.byteLength(criteria) <= 4096, 'invalid_survey_criteria', 'criteria above the native limit');
    const policy = surveyVerificationPolicy({
      projectId: project.id, nativeProjectId: project.nativeProjectId, criteria, mainKpi: project.mainKpi, requiredIds, driverSha256, taskId,
      minIncluded: SURVEY_PART_MIN_INCLUDED, minKinds: SURVEY_PART_MIN_KINDS,
    });
    const evidence = {
      schema: PROJECT_AGENT_PART_SCHEMA, decision: { ...PROJECT_AGENT_DECISION }, splitDecision: { ...SURVEY_PART_DECISION },
      projectId: project.id, revision, part, parts: units.length, supersedes,
      reviewedDigest: base.evidence.reviewedDigest, policyDigest: digest(policy), requiredIds: structuredClone(requiredIds),
      agents: { writer: agents.writer, assessor: agents.assessor },
      novelty: 'Each listed record is uncovered: no part of this project lists it yet.',
    };
    const payload = centralPayload('central_task_open', {
      id: taskId, project: project.nativeProjectId,
      title: `${clip(`Prior-art survey: ${source.row.title}`, 220)} (part ${part} of ${units.length})`,
      criteria, acceptance_digest: sha256(criteria), eligibility: 'new', eligibility_digest: eligibilityDigest,
      solver_amount: surveyPartSolverUnits(requiredIds.length), reviewer_amount: SURVEY_PART_REVIEWER_UNITS, evidence_digest: digest(evidence),
    });
    return { payload, evidence, policy };
  });
  return { parts, supersedes };
}

/** The `survey` field of an accepted submission's evidence, or null when it is not one. */
export function surveyOfEvidence(evidence) {
  if (typeof evidence !== 'string') return null;
  let artifact;
  try {
    artifact = JSON.parse(evidence);
  } catch {
    return null;
  }
  const s = plain(artifact) ? artifact.survey : null;
  if (!plain(s) || !Array.isArray(s.items) || !plain(s.conclusion) || typeof s.conclusion.meetsMainKpi !== 'boolean') return null;
  return s;
}

function acceptedSurveyOf(snapshot, task) {
  if (task.state !== 'accepted' || typeof task.winner !== 'string' || !task.winner) return { reason: 'survey_task_state_unknown' };
  const submission = snapshot.records?.[`central_submission/${task.winner}`];
  if (!plain(submission)) return { reason: 'survey_submission_unread' };
  need(submission.task === task.id && submission.state === 'accepted' && typeof submission.evidence === 'string' &&
    sha256(submission.evidence) === submission.evidence_digest, 'survey_submission_invalid');
  const survey = surveyOfEvidence(submission.evidence);
  need(survey, 'survey_submission_invalid', 'the accepted submission carries no survey');
  return { submission, survey };
}

const got0MainKpi = (snapshot, rows) => {
  const first = snapshot.records?.[`central_submission/${rows[0].task.winner}`];
  return surveyOfEvidence(first?.evidence)?.mainKpi ?? null;
};

/** The latest survey-part revision on native: {revision, parts, tasks} or null. */
function latestPartRevision(snapshot) {
  const byRevision = new Map();
  for (const t of snapshot.tasks) {
    const id = parseSurveyPartId(t?.id);
    if (!id || id.projectId !== snapshot.projectId) continue;
    if (!byRevision.has(id.revision)) byRevision.set(id.revision, []);
    byRevision.get(id.revision).push({ ...id, task: t });
  }
  if (byRevision.size === 0) return null;
  const revision = Math.max(...byRevision.keys());
  const rows = byRevision.get(revision).sort((a, b) => a.part - b.part);
  const counts = new Set(rows.map((r) => Number(SURVEY_PART_TITLE.exec(r.task.title ?? '')?.[2] ?? NaN)));
  const parts = counts.size === 1 ? [...counts][0] : NaN;
  return { revision, parts, rows };
}

/**
 * Where a project's survey stands, from a native snapshot read with `{evidence: true}`:
 *   absent | pending | accepted | unread
 * `accepted` carries the accepted survey (from the winning submission's inline evidence,
 * checked against its native evidence digest) and `meetsMainKpi`. When survey parts exist,
 * the latest part revision decides: accepted once every part is accepted, with the parts'
 * items and gaps merged. `taskIds` lists every survey-family task (the original and all parts).
 */
export function surveyStatus(snapshot) {
  need(plain(snapshot) && CATALOGUE_ID.test(snapshot.projectId ?? ''), 'invalid_native_snapshot');
  if (!Array.isArray(snapshot.tasks)) return { state: 'unread', reason: 'native_tasks_unread' };
  const id = surveyTaskId(snapshot.projectId);
  const taskIds = snapshot.tasks.map((t) => t?.id).filter((t) => isSurveyTask(snapshot.projectId, t));
  const revision = latestPartRevision(snapshot);
  if (revision) {
    const { rows, parts } = revision;
    const taskId = rows[0].task.id;
    if (!Number.isSafeInteger(parts) || rows.length > parts) return { state: 'unread', taskId, taskIds, reason: 'survey_parts_inconsistent' };
    if (rows.length < parts) return { state: 'pending', taskId, taskIds, taskState: 'parts_opening' };
    const waiting = rows.find((r) => SURVEY_PENDING_STATES.includes(r.task.state));
    if (waiting) return { state: 'pending', taskId: waiting.task.id, taskIds, taskState: waiting.task.state };
    const items = [], gaps = [], submissions = [];
    let meets = false, asOf = '';
    for (const r of rows) {
      const got = acceptedSurveyOf(snapshot, r.task);
      if (!got.survey) return { state: 'unread', taskId: r.task.id, taskIds, reason: got.reason };
      submissions.push(got.submission.id);
      items.push(...got.survey.items);
      gaps.push(...(Array.isArray(got.survey.conclusion.gaps) ? got.survey.conclusion.gaps : []));
      meets ||= got.survey.conclusion.meetsMainKpi === true;
      if (typeof got.survey.asOf === 'string' && got.survey.asOf > asOf) asOf = got.survey.asOf;
    }
    const survey = { mainKpi: got0MainKpi(snapshot, rows), asOf, items: items.slice(0, MAX_ITEMS), conclusion: { meetsMainKpi: meets, gaps: gaps.slice(0, 12) } };
    return { state: 'accepted', taskId, taskIds, submission: submissions[0], submissions, evidenceDigest: null, survey, meetsMainKpi: meets };
  }
  const task = snapshot.tasks.find((t) => t?.id === id);
  if (!task) return { state: 'absent', taskId: id, taskIds };
  if (SURVEY_PENDING_STATES.includes(task.state)) return { state: 'pending', taskId: id, taskIds, taskState: task.state };
  const got = acceptedSurveyOf(snapshot, task);
  if (!got.survey) return { state: 'unread', taskId: id, taskIds, reason: got.reason };
  return { state: 'accepted', taskId: id, taskIds, submission: got.submission.id, evidenceDigest: got.submission.evidence_digest, survey: got.survey, meetsMainKpi: got.survey.conclusion.meetsMainKpi };
}

/** Later tasks wait for an accepted survey; a survey that finds the Main KPI met holds the project. */
export function requireAcceptedSurvey(snapshot) {
  const status = surveyStatus(snapshot);
  need(status.state !== 'unread', 'native_snapshot_unavailable', status.reason ?? 'survey state unread');
  need(status.state === 'accepted', 'prior_art_survey_required', `the survey task ${status.taskId} is ${status.state}`);
  need(status.meetsMainKpi === false, 'prior_art_survey_found_solution', 'the accepted survey reports the Main KPI already met');
  return status;
}

/** The bounded part of an accepted survey a Project Manager sees (untrusted data in its prompt). */
export function surveyBriefing(status) {
  need(plain(status) && status.state === 'accepted' && plain(status.survey), 'prior_art_survey_required');
  const s = status.survey;
  return {
    task: status.taskId, submission: status.submission, as_of: s.asOf,
    items: s.items.slice(0, MAX_ITEMS).map((i) => ({ kind: i.kind, id: i.id, title: i.title, relation: i.relation, note: i.note })),
    gaps: Array.isArray(s.conclusion.gaps) ? s.conclusion.gaps.slice(0, 12) : [],
  };
}

