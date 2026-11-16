#!/usr/bin/env node
/** Split replacement surveys (Rahul, 9 November 2026: smaller tasks, single units).
 *
 *   preflight OPP-xxxxx            -> uain-survey-preflight-v1 (stdout): every identifier the
 *                                     project's survey would require, read once through its fixed
 *                                     record API by the same paced reader and parser the survey
 *                                     verifier uses. Network: the fixed record API hosts only.
 *   build OPP-xxxxx <preflight>    -> {project, revision, supersedes, dropped, parts:[{request,
 *                                     evidence, policy}]} (stdout): the exact `central_task_open`
 *                                     requests of the survey parts, for review and root-owned
 *                                     installation (policies under /etc/uain-custody/task-policies,
 *                                     requests in the organization-starter authority).
 *   template <parts> <preflight>   -> {taskId: row} (stdout): the public BAINK survey templates
 *                                     (apps/baink/server/survey-templates.json rows) of the parts,
 *                                     with each record's title as its record API returned it.
 *
 * Deterministic from the repository's frozen selection, catalogue, reviewed prior-art record,
 * committed draft and the reviewed preflight. No model call, no signature, no native write.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { GUARDIAN } from '../src/bootstrap.mjs';
import { SURVEY_HOSTS } from '../src/survey-sources.mjs';
import { SURVEY_PREFLIGHT_SCHEMA, buildSurveyOpenPayload, buildSurveyPartPayloads, surveyTaskId } from '../src/survey.mjs';
import { createRetriever, driverDigest, surveyRecords } from '../src/verification.mjs';
import { readRecord } from '../verifiers/prior-art-survey.mjs';

const DOCS = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

async function context(projectId) {
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const selection = await loadSelection();
  const row = catalogue.records.get(projectId);
  return {
    projectId, selection, source: { revision: catalogue.revision, row: structuredClone(row) },
    reviewed: readJson(new URL(`bootstrap-reviewed/${projectId}.json`, DOCS)),
    draft: readJson(new URL(`bootstrap-drafts/${projectId}.json`, DOCS)),
    driverSha256: driverDigest('prior-art-survey'),
  };
}

/** One preflight row from a record answer: resolved only with a real title. */
export function preflightRow(kind, id, record) {
  const answer = readRecord(kind, id, record);
  if (answer.unreadable) return { kind, id, status: 'unreadable', title: null };
  if (!answer.found) return { kind, id, status: 'not_found', title: null };
  const title = (answer.titles ?? []).find((t) => typeof t === 'string' && t.trim() && !/^untitled$/i.test(t.trim()));
  if (answer.repository) return { kind, id, status: 'resolved', title: id };
  return title ? { kind, id, status: 'resolved', title: title.trim().slice(0, 1000) } : { kind, id, status: 'untitled', title: null };
}

export async function preflight(ctx, { retriever, now = () => new Date() } = {}) {
  const { evidence } = buildSurveyOpenPayload(ctx);
  const items = evidence.requiredIds.map((r) => ({ ...r }));
  const records = await surveyRecords({ items }, retriever ?? createRetriever({
    allowedHosts: [...SURVEY_HOSTS], maxBytes: 2 * 1024 * 1024, timeoutMs: 20000,
    headers: { 'user-agent': 'uain-prior-art-survey-preflight/1 (+https://uain.global)', accept: 'application/json, application/atom+xml;q=0.9' },
  }));
  const byKey = new Map(records.map((r) => [`${r.kind}:${r.id}`, r]));
  return {
    schema: SURVEY_PREFLIGHT_SCHEMA, projectId: ctx.projectId, checkedAt: now().toISOString().slice(0, 19) + 'Z',
    records: items.map((r) => preflightRow(r.kind, r.id, byKey.get(`${r.kind}:${r.id}`))),
  };
}

export function build(ctx, checked, { revision = 2 } = {}) {
  const supersedes = surveyTaskId(ctx.projectId);
  const { parts, dropped } = buildSurveyPartPayloads({ ...ctx, revision, supersedes, preflight: checked });
  return {
    schema: 'uain-survey-parts-build-v1', project: ctx.projectId, revision, supersedes, dropped,
    parts: parts.map(({ payload, evidence, policy }) => ({
      request: { id: `survey-${ctx.projectId}-r${revision}-p${evidence.part}`, member: GUARDIAN, operation: 'central_task_open', payload },
      evidence, policy,
    })),
  };
}

/** Public survey-template rows of a part build: what each part's policy requires, with titles. */
export function templates(built, checked) {
  const titles = new Map(checked.records.map((r) => [`${r.kind}:${r.id}`, r.title]));
  return Object.fromEntries(built.parts.map(({ request, policy }) => {
    const t = policy.successTests[0];
    return [policy.taskId, {
      project: policy.projectId, criteriaDigest: policy.criteriaDigest, mainKpi: t.mainKpi, minIncluded: t.minIncluded, minKinds: t.minKinds,
      required: t.requiredIds.map((r) => ({ kind: r.kind, id: r.id, title: titles.get(`${r.kind}:${r.id}`) })),
    }];
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [command, projectId, file] = process.argv.slice(2);
  try {
    const ctx = await context(projectId);
    let out;
    if (command === 'preflight') out = await preflight(ctx);
    else if (command === 'build') out = build(ctx, JSON.parse(readFileSync(file, 'utf8')));
    else if (command === 'template') out = templates(JSON.parse(readFileSync(file, 'utf8')), JSON.parse(readFileSync(process.argv[5], 'utf8')));
    else throw Object.assign(new Error('usage: preflight OPP | build OPP preflight.json | template OPP parts.json preflight.json'), { code: 'usage' });
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (error) {
    process.stderr.write(`survey parts refused: ${error.code ?? 'error'} ${error.message ?? ''}\n`);
    process.exitCode = 1;
  }
}
