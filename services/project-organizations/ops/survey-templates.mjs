#!/usr/bin/env node
/** Public survey templates for BAINK (apps/baink/server/survey-templates.json).
 *
 * A newcomer cannot see the root-owned verification policy, so BAINK publishes, per survey
 * task, exactly what the policy requires of the submission: the Main KPI text, the minimum
 * included items and kinds, and every identifier the trusted project-level searches returned
 * (with the title those searches showed). Built from the same code path that opens the task
 * (survey.mjs). Publication still requires the explicit reviewed contract tuple check.
 *
 * Full draft generation: node services/project-organizations/ops/survey-templates.mjs
 * For existing publications, use --refresh-task ID --criteria-digest SHA --policy-digest SHA
 * --evidence-digest SHA and review the selected row against the native contract. Other rows stay unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { buildSurveyOpenPayload, normalizeSurveyId } from '../src/survey.mjs';
import { driverDigest } from '../src/verification.mjs';
import { digest, need } from '../src/common.mjs';

const DOCS = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
const KIND_OF = { 'api.github.com/search/repositories': 'github', 'export.arxiv.org/api/query': 'arxiv', 'api.crossref.org/works': 'doi' };

/** id -> title as the trusted search result listed it. */
function titlesOf(draft) {
  const titles = new Map();
  for (const s of draft.searches) {
    const kind = KIND_OF[s.source];
    const top = kind && typeof s.resultSummary === 'string' ? s.resultSummary.split('; top: ')[1] : null;
    if (!top) continue;
    for (const entry of top.split(' | ')) {
      const m = /^(\S+) "(.*)"$/.exec(entry);
      const id = m && normalizeSurveyId(kind, m[1]);
      if (id && !titles.has(`${kind}:${id}`)) titles.set(`${kind}:${id}`, m[2].replace(/…$/, '').trim());
    }
  }
  return titles;
}

export async function surveyTemplatePublication() {
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
  const selection = await loadSelection();
  const driverSha256 = driverDigest('prior-art-survey');
  const out = {}, bindings = {};
  for (const id of selection.ids) {
    const reviewedUrl = new URL(`bootstrap-reviewed/${id}.json`, DOCS);
    if (selection.get(id).holds.length || !existsSync(reviewedUrl)) continue;
    const draft = JSON.parse(readFileSync(new URL(`bootstrap-drafts/${id}.json`, DOCS), 'utf8'));
    const reviewed = JSON.parse(readFileSync(reviewedUrl, 'utf8'));
    const { payload, policy } = buildSurveyOpenPayload({
      projectId: id, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) }, draft, reviewed, driverSha256,
    });
    bindings[payload.id] = { criteriaDigest: payload.acceptance_digest, policyDigest: digest(policy), evidenceDigest: payload.evidence_digest };
    const test = policy.successTests[0];
    const titles = titlesOf(draft);
    out[payload.id] = {
      project: payload.project, criteriaDigest: payload.acceptance_digest, mainKpi: test.mainKpi, minIncluded: test.minIncluded, minKinds: test.minKinds,
      required: test.requiredIds.map((r) => ({ kind: r.kind, id: r.id, title: titles.get(`${r.kind}:${r.id}`) ?? '' })),
    };
  }
  return { document: { schema: 'baink-survey-templates-v1', templates: out }, bindings };
}

export async function surveyTemplates() { return (await surveyTemplatePublication()).document; }

/** Refresh one explicitly reviewed contract, retaining every other published row. */
export function refreshPublishedSurveyTemplate(previous, publication, taskId, expected) {
  const valid = value => value && typeof value === 'object' && !Array.isArray(value);
  need(valid(previous) && previous.schema === 'baink-survey-templates-v1' && valid(previous.templates) &&
    valid(publication?.document?.templates) && valid(publication?.bindings) &&
    /^T-OPP-[0-9]{5}-1-prior-art-survey$/.test(taskId) && Object.hasOwn(previous.templates, taskId) &&
    valid(expected) && Object.keys(expected).sort().join(',') === 'criteriaDigest,evidenceDigest,policyDigest' &&
    Object.values(expected).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'invalid_survey_template_refresh');
  const template = publication.document.templates[taskId], binding = publication.bindings[taskId];
  need(valid(template) && valid(binding) && Object.keys(expected).every(key => binding[key] === expected[key]) &&
    template.criteriaDigest === expected.criteriaDigest && Array.isArray(template.required) &&
    template.required.every(record => typeof record.title === 'string' && record.title.trim() && record.title.toLowerCase() !== 'untitled'),
    'invalid_survey_template_refresh');
  const result = structuredClone(previous);
  result.templates[taskId] = structuredClone(template);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 0) process.stdout.write(JSON.stringify(await surveyTemplates()) + '\n');
  else {
    need(args.length === 8 && args[0] === '--refresh-task' && args[2] === '--criteria-digest' &&
      args[4] === '--policy-digest' && args[6] === '--evidence-digest', 'invalid_survey_template_refresh');
    const previous = JSON.parse(readFileSync(new URL('../../../apps/baink/server/survey-templates.json', import.meta.url), 'utf8'));
    const expected = { criteriaDigest: args[3], policyDigest: args[5], evidenceDigest: args[7] };
    process.stdout.write(JSON.stringify(refreshPublishedSurveyTemplate(previous, await surveyTemplatePublication(), args[1], expected)) + '\n');
  }
}
