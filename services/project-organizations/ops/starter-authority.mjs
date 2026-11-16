#!/usr/bin/env node
/** Starter organizations (decision D2, 6 November 2026): the root-pinned authority that lets
 * `ops/custody/organization_starter.py` open one reviewed project and its paid prior-art survey
 * without any manual step.
 *
 *   objective OPP-xxxxx                 -> the Fund Manager objective (stdout)
 *   plan <objective.json>               -> {report, review}: two separate executions of the
 *                                          production Fund Manager model through the fixed
 *                                          provider fence (run as the central reviewer user)
 *   build OPP-xxxxx <plan.json> <preflight.json>
 *                                       -> the authority file (stdout); the full survey opens only
 *                                          when the reviewed live preflight resolved every record it
 *                                          requires with a real title (plan W7, 10 November 2026)
 *
 * The authority holds the six exact requests fleet custody signs, in order:
 *   open (guardian, open_project) · start (guardian, central_project_start, manager = guardian,
 *   the live pilot pattern) · configure (guardian, evaluator = UAIN Independent Fund Manager) ·
 *   plan and review (Fund Manager, revision 1) · survey (guardian as budget manager,
 *   central_task_open of the 200 + 50 AI$ survey).
 * Every payload is deterministic from the repository's frozen selection, catalogue, reviewed
 * prior-art record and the pinned plan; fleet custody checks native state when it signs.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { GUARDIAN, buildOpenProjectPayload } from '../src/bootstrap.mjs';
import { SURVEY_DECISION, SURVEY_PART_DECISION, buildSurveyOpenPayload, validateSurveyPreflight } from '../src/survey.mjs';
import { driverDigest } from '../src/verification.mjs';
import { digest, need } from '../src/common.mjs';
import { plan as proposePlan, review as reviewPlan, digest as planDigest } from '../../fund-manager/src/planner.mjs';

export const AUTHORITY_SCHEMA = 'uain-organization-starter-authority-v1';
/** Parts-first projects (Rahul, 9 November 2026: small single units, at least 50 open projects with
 * three open tasks each): the same first five stages, then the project's survey is opened only as
 * reviewed survey parts (`ops/survey-parts.mjs build`, root-pinned `<project>.parts.json`), never as
 * one 200 + 50 AI$ task. The parts are signed by the start stage's guardian, the budget manager. */
export const PARTS_AUTHORITY_SCHEMA = 'uain-organization-starter-authority-v2';
/** central_fund_manager.py identity: the licensed UAIN Independent Fund Manager. */
export const FUND_MANAGER = 'uain1a62e7d2841e34473b98a5fb8395019d1ca02b15c';
export const STAGES = Object.freeze([
  ['open', 'bootstrap', 'open_project'], ['start', 'bootstrap', 'central_project_start'], ['configure', 'bootstrap', 'central_fund_configure'],
  ['plan', 'agent', 'central_fund_plan'], ['review', 'agent', 'central_fund_plan_review'], ['survey', 'agent', 'central_task_open'],
]);
const DOCS = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

async function context() {
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const selection = await loadSelection();
  return { catalogue, selection };
}

/** The Fund Manager objective for one reviewed project. */
export function objectiveOf({ selection, catalogue }, projectId) {
  const p = selection.get(projectId);
  need(p.holds.length === 0, 'project_held');
  const row = catalogue.records.get(projectId);
  need(row, 'selected_source_missing');
  const text = [
    'UAIN central-earning-five-kpi-fund-v2: lifetime exactly 1,000,000,000 AI$; initial 10,000 AI$ unlocked reward allowance on project start',
    '(reward-only, not spendable personal money); later incremental 100k, 1m, 10m, 100m and 888.89m AI$ only after fully verified sub-KPIs 1..5,',
    'and the fifth sub-KPI includes full Main KPI achievement before its allocation. Every paid task needs an approved plan, a prior-art basis,',
    'reserved solver and reviewer rewards and a distinct UAIN reviewer. The first task of this organization is a paid prior-art survey of existing',
    'work for the Main KPI (decided 6 November 2026). No achievement is asserted by this design request.',
    `Project ${projectId}: ${row.title}. Category: ${row.category}.`,
    `Description: ${row.description}`,
    `Main KPI qualification: ${p.kpi.qualification}`,
  ].join(' ');
  return { schema: 'uain-fund-objective-v1', project: p.nativeProjectId, main_kpi: p.mainKpi, context: text.slice(0, 16000) };
}

/** Plan, then an independent review in a separate execution, through the production provider
 * fence. A rejected plan is revised: the next plan execution gets the review findings in its
 * objective context (at most `attempts` plans). Every attempt is returned for the record; only an
 * accepted review lets `build` pin the plan. */
export async function planFor({ selection }, objective, { run, attempts = 3 } = {}) {
  const projectId = objective.project.slice(2);
  const p = selection.get(projectId);
  const options = { selection, sourceDigest: p.sourceDigest, ...(run ? { run } : {}) };
  const history = [];
  let input = objective;
  for (let n = 1; n <= attempts; n++) {
    const report = await proposePlan(input, options);
    const review = await reviewPlan(report, options);
    history.push({ attempt: n, report, review });
    if (review.verdict === 'accept') return { report, review, history };
    const findings = review.findings.map((f) => `- ${f}`).join('\n');
    input = { ...objective, context: `${objective.context}\nThe independent plan review of attempt ${n} returned ${review.verdict}. ` +
      `Revise the plan so every stage has exact numeric success tests and verification rules. Findings:\n${findings}`.slice(0, 16000) };
  }
  const last = history.at(-1);
  return { report: last.report, review: last.review, history };
}

/** The six exact requests for one project, from the repository data and the pinned plan. */
/** A full survey may require only records the live preflight resolved with a real title: the three
 * held surveys of 9 November required mangled or untitled DOIs no submitter could satisfy. */
export function requireResolvedSurvey(survey, preflight, projectId) {
  validateSurveyPreflight(preflight, projectId);
  const resolved = new Set(preflight.records.filter((r) => r.status === 'resolved').map((r) => `${r.kind}:${r.id}`));
  const missing = survey.evidence.requiredIds.filter((r) => !resolved.has(`${r.kind}:${r.id}`));
  need(missing.length === 0, 'survey_requires_unresolved_record', missing.map((r) => `${r.kind} ${r.id}`).join(', ').slice(0, 400));
}

export function buildAuthority({ selection, catalogue }, projectId, { report, review }, { preflight } = {}) {
  const p = selection.get(projectId);
  need(p.holds.length === 0, 'project_held');
  const row = catalogue.records.get(projectId);
  const source = { revision: catalogue.revision, row: structuredClone(row) };
  const reviewed = readJson(new URL(`bootstrap-reviewed/${projectId}.json`, DOCS));
  const draft = readJson(new URL(`bootstrap-drafts/${projectId}.json`, DOCS));
  const P = p.nativeProjectId;
  need(report?.schema === 'uain-fund-model-report-v1' && report.input?.project === P && report.result?.main_kpi === p.mainKpi, 'invalid_plan_report');
  need(review?.schema === 'uain-fund-plan-review-v1' && review.verdict === 'accept' && review.report_digest === planDigest(report), 'plan_review_not_accepted');
  const start = digest({ schema: 'uain-organization-starter-start-v1', project: projectId, decision: SURVEY_DECISION, reviewed: digest(reviewed) });
  const survey = buildSurveyOpenPayload({ projectId, selection, source, draft, reviewed, driverSha256: driverDigest('prior-art-survey') });
  if (preflight !== undefined) requireResolvedSurvey(survey, preflight, projectId);
  const requests = {
    open: { id: `open-${projectId}`, member: GUARDIAN, operation: 'open_project', payload: buildOpenProjectPayload({ selection, projectId, source, review: reviewed }) },
    start: { id: `start-${projectId}`, member: GUARDIAN, operation: 'central_project_start',
      payload: centralPayload('central_project_start', { project: P, manager: GUARDIAN, evidence_digest: start }) },
    configure: { id: `configure-${projectId}`, member: GUARDIAN, operation: 'central_fund_configure',
      payload: centralPayload('central_fund_configure', { project: P, evaluator: FUND_MANAGER, expected_evaluator: '', evidence_digest: start }) },
    plan: { id: `plan-${projectId}-1`, member: FUND_MANAGER, operation: 'central_fund_plan',
      payload: centralPayload('central_fund_plan', { project: P, revision: 1, main_kpi: report.result.main_kpi, stages: report.result.stages,
        reason: report.result.reason, evidence_digest: planDigest(report) }) },
    review: { id: `review-${projectId}-1`, member: FUND_MANAGER, operation: 'central_fund_plan_review',
      payload: centralPayload('central_fund_plan_review', { project: P, revision: 1, verdict: 'accept', evidence_digest: planDigest(review) }) },
    survey: { id: `survey-${projectId}`, member: GUARDIAN, operation: 'central_task_open', payload: survey.payload },
  };
  return {
    schema: AUTHORITY_SCHEMA, project: projectId, native_project: P, selection_digest: selection.digest, source_digest: p.sourceDigest,
    decision: { ...SURVEY_DECISION }, stages: STAGES.map(([name, caller, operation]) => ({ name, caller, operation, request: requests[name].id })),
    requests, evidence: { plan_report: report, plan_review: review, survey_evidence: survey.evidence, survey_policy: survey.policy },
  };
}

/** The five exact requests of a parts-first project: open, start, configure, plan and review. The
 * survey itself opens as parts, so this authority has no survey stage. */
export function buildPartsAuthority(ctx, projectId, plan) {
  const full = buildAuthority(ctx, projectId, plan);
  const { survey, ...requests } = full.requests;
  return {
    schema: PARTS_AUTHORITY_SCHEMA, project: full.project, native_project: full.native_project, selection_digest: full.selection_digest,
    source_digest: full.source_digest, decision: { ...SURVEY_PART_DECISION },
    stages: full.stages.filter((s) => s.name !== 'survey'), requests,
    evidence: { plan_report: full.evidence.plan_report, plan_review: full.evidence.plan_review },
  };
}

// Resolve symlinks (a release is installed behind /opt/uain-organizations/current).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [command, a, b, c] = process.argv.slice(2);
  try {
    const ctx = await context();
    let out;
    if (command === 'objective') out = objectiveOf(ctx, a);
    else if (command === 'plan') out = await planFor(ctx, JSON.parse(readFileSync(a, 'utf8')));
    else if (command === 'build') {
      if (!c) throw Object.assign(new Error('build needs the reviewed live preflight of the survey records'), { code: 'survey_preflight_required' });
      out = buildAuthority(ctx, a, JSON.parse(readFileSync(b, 'utf8')), { preflight: JSON.parse(readFileSync(c, 'utf8')) });
    }
    else if (command === 'build-parts') out = buildPartsAuthority(ctx, a, JSON.parse(readFileSync(b, 'utf8')));
    else throw Object.assign(new Error('usage: objective OPP | plan objective.json | build OPP plan.json preflight.json | build-parts OPP plan.json'), { code: 'usage' });
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (error) {
    process.stderr.write(`starter authority refused: ${error.code ?? 'error'} ${error.message ?? ''}\n`);
    process.exitCode = 1;
  }
}
