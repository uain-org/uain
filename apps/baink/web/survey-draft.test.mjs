import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseSurveyDraft, surveyEvidence, surveyTemplateText } from './survey-draft.js';

const template = {
  mainKpi: '1,000,000,000 people treated yearly', minIncluded: 2, minKinds: 2,
  required: [{ kind: 'doi', id: '10.1002/bies.201670910', title: 'To clear, or not to clear (senescent cells)? That is the question' }],
};

test('the template keeps every required identifier and parses once the newcomer adds items', () => {
  const text = surveyTemplateText(template, '2026-11-07');
  assert.match(text, /item: doi \| 10\.1002\/bies\.201670910 \| To clear/);
  const incomplete = parseSurveyDraft(text, template);
  assert.ok(incomplete.errors.some((e) => /at least 2 items/.test(e)));
  const filled = text + [
    'item: nct | nct04733534 | Senolytics to treat frailty | partial | A trial of a multi-day oral cycle, not a once-a-year treatment.',
    'item: doi | https://doi.org/10.1038/S43587-023-00560-5 | Prophylactic and long-lasting efficacy of senolytic CAR T cells | adjacent | Mouse data only.',
  ].join('\n');
  const { survey, errors } = parseSurveyDraft(filled, template);
  assert.equal(errors, undefined);
  assert.equal(survey.mainKpi, template.mainKpi);
  assert.deepEqual(survey.items.map((i) => `${i.kind}:${i.id}`), ['doi:10.1002/bies.201670910', 'nct:NCT04733534', 'doi:10.1038/s43587-023-00560-5']);
  assert.deepEqual(survey.conclusion.meetsMainKpi, false);
});

test('the evidence is the sorted-key artifact naming the submission and author', () => {
  const survey = { mainKpi: 'x'.repeat(20), asOf: '2026-11-07', items: [], conclusion: { meetsMainKpi: false, gaps: ['g'.repeat(20)] } };
  const evidence = surveyEvidence({ taskId: 'T-OPP-00002-1-prior-art-survey', submissionId: 'CS-1', author: 'uain1' + 'a'.repeat(40), survey });
  const parsed = JSON.parse(evidence);
  assert.deepEqual(Object.keys(parsed), ['author', 'schema', 'submissionId', 'survey', 'taskId']);
  assert.equal(evidence, canonical(parsed));
  assert.equal(parsed.schema, 'uain-evidence-artifact-v1');
});

test('inconsistent conclusions and unknown fields are refused with readable errors', () => {
  const bad = 'asOf: 2026-11-07\nitem: doi | 10.1/x | A record title | meets_main_kpi | n is long enough\nmeetsMainKpi: no\nfoo: bar\n';
  const { errors } = parseSurveyDraft(bad, { ...template, required: [] });
  assert.ok(errors.some((e) => /meetsMainKpi must be yes/.test(e)));
  assert.ok(errors.some((e) => /unknown field foo/.test(e)));
});
