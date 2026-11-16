// Survey-part templates derived from the native task (server/survey-part-template.mjs) and
// served by the public template route when no static row exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  SURVEY_PART_KINDS, SURVEY_PART_MAX_ITEMS, SURVEY_PART_MAX_REQUIRED, SURVEY_PART_MINUTES, SURVEY_PART_MIN_INCLUDED,
  SURVEY_PART_MIN_KINDS, normalizeSurveyPartId, parseSurveyPartCriteria, surveyPartCriteriaText, surveyPartTemplate,
} from '../server/survey-part-template.mjs';
import { createPublicRoutes } from '../server/routes/public.mjs';
import { ApiError } from '../server/http-errors.mjs';
import * as survey from '../../../services/project-organizations/src/survey.mjs';
import { KINDS, MAX_ITEMS, normalizeId } from '../../../services/project-organizations/verifiers/prior-art-survey.mjs';
import { loadCatalogue } from '../server/catalogue.mjs';
import { catalogueRecords } from '../../../services/project-organizations/src/selection.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const KPI = 'Reduce the median diagnosis time of rare paediatric disorders to under 30 days';
const IDS = [{ kind: 'doi', id: '10.1016/b978-0-12-821085-7.00002-6' }, { kind: 'arxiv', id: '2401.01234' }, { kind: 'github', id: 'owner/repo' }];
const input = (over = {}) => ({ title: 'Rare disease diagnosis', mainKpi: KPI, part: 2, parts: 4, requiredIds: IDS, ...over });
const TASK_ID = 'T-OPP-00042-1-prior-art-survey-r2-p2';
function nativeTask(over = {}, criteria = survey.surveyPartCriteria(input())) {
  return {
    id: TASK_ID, project: 'P-OPP-00042', title: 'Prior-art survey: Rare disease diagnosis (part 2 of 4)', criteria,
    acceptance_digest: sha(criteria), eligibility: 'new', eligibility_digest: 'e'.repeat(64), evidence_digest: 'e'.repeat(64),
    solver_amount: '60000000', reviewer_amount: '10000000', state: 'open', pending: '', winner: '', reserved: '70000000', paid: '0', ...over,
  };
}

test('the mirrored generator and constants match survey.mjs byte for byte', () => {
  assert.deepEqual(SURVEY_PART_KINDS, KINDS);
  assert.equal(SURVEY_PART_MAX_ITEMS, MAX_ITEMS);
  assert.equal(SURVEY_PART_MAX_REQUIRED, survey.SURVEY_PART_MAX_REQUIRED);
  assert.equal(SURVEY_PART_MINUTES, survey.SURVEY_PART_MINUTES);
  assert.equal(SURVEY_PART_MIN_INCLUDED, survey.SURVEY_PART_MIN_INCLUDED);
  assert.equal(SURVEY_PART_MIN_KINDS, survey.SURVEY_PART_MIN_KINDS);
  const long = 'Ü'.repeat(150) + ' title';
  for (const over of [{}, { requiredIds: IDS.slice(0, 1) }, { requiredIds: IDS.slice(0, 2), part: 1, parts: 1 },
    { title: long }, { mainKpi: 'é'.repeat(400) }, { title: 'Quoted "x"; y', part: 12, parts: 12 },
    { requiredIds: [{ kind: 'pubmed', id: '12345678' }, { kind: 'nct', id: 'NCT01234567' }, { kind: 'wikidata', id: 'Q42' }] }])
    assert.equal(surveyPartCriteriaText(input(over)), survey.surveyPartCriteria(input(over)));
  for (const [kind, id] of [['doi', 'https://doi.org/10.1000/ABC'], ['arxiv', 'arXiv:2401.01234v3'], ['github', 'https://github.com/A/B.git'],
    ['nct', 'nct01234567'], ['wikidata', 'q42'], ['pubmed', '012'], ['doi', '10.1/x y'], ['other', 'x'], ['doi', 5]])
    assert.equal(normalizeSurveyPartId(kind, id), normalizeId(kind, id), `${kind} ${id}`);
  for (const bad of [{ part: 5 }, { requiredIds: [] }, { requiredIds: [...IDS, IDS[0]] }, { requiredIds: [{ kind: 'doi', id: '10.1000/ABC' }] }, { mainKpi: 'short' }]) {
    assert.equal(surveyPartCriteriaText(input(bad)), null);
    assert.throws(() => survey.surveyPartCriteria(input(bad)));
  }
});

test('criteria parse only when the parsed fields regenerate them exactly', () => {
  for (const over of [{}, { requiredIds: IDS.slice(0, 1) }, { title: 'Ü'.repeat(150) }, { requiredIds: [{ kind: 'doi', id: '10.1000/a;;b' }, { kind: 'pubmed', id: '9' }] }]) {
    const parsed = parseSurveyPartCriteria(survey.surveyPartCriteria(input(over)));
    assert.equal(parsed.mainKpi, KPI);
    assert.deepEqual(parsed.requiredIds, input(over).requiredIds);
    assert.deepEqual([parsed.part, parsed.parts], [2, 4]);
  }
  const good = survey.surveyPartCriteria(input());
  for (const tampered of [
    good + ' ', ' ' + good, good.replace('part 2 of 4', 'part 2 of  4'), good.replace('these 3 identifiers', 'these 2 identifiers'),
    good.replace('github owner/repo', 'github Owner/repo'), good.replace('; arxiv', ';  arxiv'), good.replace('arxiv 2401.01234', 'arxiv 2401.01234v2'),
    good.replace('within 20 minutes', 'within 30 minutes'), good.replace('16 KiB', '32 KiB'), good.replace('doi 10', 'isbn 10'),
    survey.surveyPartCriteria(input({ title: 'A". Main KPI: "B' })),
    survey.surveyPartCriteria(input({ mainKpi: 'x'.repeat(700) })), survey.surveyPartCriteria(input({ mainKpi: KPI + '...' })),
    survey.surveyCriteria({ title: 'Rare disease diagnosis', mainKpi: KPI, required: 3 }), '', null, 42,
  ]) assert.equal(parseSurveyPartCriteria(tampered), null, String(tampered).slice(0, 80));
});

test('a template is derived only from an open or under-review part whose native record binds the criteria', () => {
  assert.deepEqual(surveyPartTemplate(TASK_ID, nativeTask()), {
    project: 'P-OPP-00042', criteriaDigest: sha(survey.surveyPartCriteria(input())), mainKpi: KPI, minIncluded: 1, minKinds: 1,
    required: IDS.map((r) => ({ ...r, title: null })),
  });
  assert.ok(surveyPartTemplate(TASK_ID, nativeTask({ state: 'open_unfunded' })));
  // Under review: its author may need it to revise after "needs more evidence" (10 November 2026).
  assert.ok(surveyPartTemplate(TASK_ID, nativeTask({ state: 'under_review' })));
  for (const state of ['accepted', 'withdrawn']) assert.equal(surveyPartTemplate(TASK_ID, nativeTask({ state })), null);
  assert.equal(surveyPartTemplate(TASK_ID, nativeTask({ acceptance_digest: 'f'.repeat(64) })), null);
  assert.equal(surveyPartTemplate(TASK_ID, nativeTask({ project: 'P-OPP-00043' })), null);
  assert.equal(surveyPartTemplate(TASK_ID, nativeTask({ id: 'T-OPP-00042-1-prior-art-survey-r2-p3' })), null);
  assert.equal(surveyPartTemplate('T-OPP-00042-1-prior-art-survey-r2-p3', nativeTask({ id: 'T-OPP-00042-1-prior-art-survey-r2-p3' })), null);
  assert.equal(surveyPartTemplate(TASK_ID, nativeTask({ title: 'Prior-art survey: Rare disease diagnosis (part 2 of 5)' })), null);
  assert.equal(surveyPartTemplate('T-OPP-00042-1-prior-art-survey', nativeTask({ id: 'T-OPP-00042-1-prior-art-survey' })), null);
  const other = 'Answer is 42';
  assert.equal(surveyPartTemplate(TASK_ID, nativeTask({}, other)), null);
  assert.equal(surveyPartTemplate(TASK_ID, null), null);
});

test('every published part row is what derivation from its native contract gives, titles aside', async () => {
  const { templates } = JSON.parse(await readFile(new URL('../server/survey-templates.json', import.meta.url), 'utf8'));
  const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../catalogue', import.meta.url))));
  const parts = Object.entries(templates).filter(([id]) => /-r[2-9]-p[0-9]+$/.test(id));
  assert.ok(parts.length >= 1);
  for (const [id, row] of parts) {
    const [, project, revision, part] = /^T-(OPP-[0-9]{5})-1-prior-art-survey-r([2-9])-p([0-9]+)$/.exec(id);
    const count = Object.keys(templates).filter((k) => k.startsWith(`T-${project}-1-prior-art-survey-r${revision}-p`)).length;
    const criteria = survey.surveyPartCriteria({ title: catalogue.records.get(project).title, mainKpi: row.mainKpi, part: Number(part), parts: count,
      requiredIds: row.required.map((r) => ({ kind: r.kind, id: r.id })) });
    assert.equal(sha(criteria), row.criteriaDigest, id);
    const task = { id, project: row.project, title: `Prior-art survey: x (part ${part} of ${count})`, criteria, acceptance_digest: sha(criteria), state: 'open' };
    assert.deepEqual(surveyPartTemplate(id, task), { ...row, required: row.required.map((r) => ({ ...r, title: null })) }, id);
  }
});

function route(centralEarning, options = {}) {
  const routes = createPublicRoutes({ publicConfig: async () => ({}), centralEarning, ...options });
  return async (taskId) => {
    const ctx = { method: 'GET', path: `/api/native/central/survey-template/${taskId}`, sent: null, send(status, body) { this.sent = { status, body: JSON.parse(JSON.stringify(body)) }; return true; } };
    try {
      await routes.public(ctx);
      return ctx.sent;
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, code: error.code };
      throw error;
    }
  };
}

test('the public route serves static rows unchanged and derives a part that has none', async () => {
  const { templates } = JSON.parse(await readFile(new URL('../server/survey-templates.json', import.meta.url), 'utf8'));
  const records = new Map([[TASK_ID, nativeTask()]]), calls = [];
  const central = { async publicTask(id) { calls.push(id); const task = records.get(id); return task ? { authority: 'native', verified: true, task: structuredClone(task), proof: {} } : null; } };
  const get = route(central);
  // Static rows keep priority and never touch native.
  for (const id of ['T-OPP-00002-1-prior-art-survey', 'T-OPP-00006-1-prior-art-survey-r2-p1']) {
    const r = await get(id);
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.body), JSON.stringify({ taskId: id, ...templates[id] }));
  }
  assert.deepEqual(calls, []);
  const derived = await get(TASK_ID);
  assert.equal(derived.status, 200);
  assert.deepEqual(derived.body, { taskId: TASK_ID, ...surveyPartTemplate(TASK_ID, nativeTask()) });
  assert.deepEqual(Object.keys(derived.body), ['taskId', 'project', 'criteriaDigest', 'mainKpi', 'minIncluded', 'minKinds', 'required']);
  // A positive result is cached, even once the task leaves the open state.
  records.set(TASK_ID, nativeTask({ state: 'under_review' }));
  assert.deepEqual((await get(TASK_ID)).body, derived.body);
  assert.deepEqual(calls, [TASK_ID]);
  // Unknown, closed or unparseable parts are the existing 404; a whole survey is never derived.
  records.set('T-OPP-00042-1-prior-art-survey-r2-p3', nativeTask({ id: 'T-OPP-00042-1-prior-art-survey-r2-p3', state: 'accepted' }));
  for (const id of ['T-OPP-00042-1-prior-art-survey-r2-p9', 'T-OPP-00042-1-prior-art-survey-r2-p3', 'T-OPP-99999-1-prior-art-survey'])
    assert.deepEqual(await get(id), { status: 404, code: 'survey_template_missing' }, id);
  assert.deepEqual(calls, [TASK_ID, 'T-OPP-00042-1-prior-art-survey-r2-p9', 'T-OPP-00042-1-prior-art-survey-r2-p3']);
});

test('the public route refuses briefly, bounds concurrent native reads and passes proof failures through', async () => {
  let clock = 1_000, calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const records = new Map();
  const central = { async publicTask(id) { calls++; await gate; const task = records.get(id); return task ? { authority: 'native', verified: true, task, proof: {} } : null; } };
  const get = route(central, { now: () => clock });
  // Concurrent requests for one part share a single read; at most 8 distinct reads run.
  const ids = Array.from({ length: 9 }, (_, i) => `T-OPP-00042-1-prior-art-survey-r3-p${i + 1}`);
  const pending = [...ids.slice(0, 8), ids[0]].map((id) => get(id));
  assert.deepEqual(await get(ids[8]), { status: 503, code: 'survey_template_busy' });
  release();
  for (const r of await Promise.all(pending)) assert.deepEqual(r, { status: 404, code: 'survey_template_missing' });
  assert.equal(calls, 8);
  // A part opened after its first refusal is served once the 30-second refusal lapses.
  records.set(ids[0], nativeTask({ id: ids[0], title: 'Prior-art survey: x (part 1 of 1)' }, survey.surveyPartCriteria(input({ part: 1, parts: 1 }))));
  assert.deepEqual(await get(ids[0]), { status: 404, code: 'survey_template_missing' });
  assert.equal(calls, 8);
  clock += 30_001;
  assert.equal((await get(ids[0])).status, 200);
  assert.equal(calls, 9);
  const g2 = route({ async publicTask() { calls++; return null; } }, { now: () => clock });
  await g2('T-OPP-00042-1-prior-art-survey-r4-p1');
  await g2('T-OPP-00042-1-prior-art-survey-r4-p1');
  const before = calls;
  clock += 30_001;
  await g2('T-OPP-00042-1-prior-art-survey-r4-p1');
  assert.equal(calls, before + 1);
  // Without a central service there is nothing to derive; an unproved read is not cached.
  assert.deepEqual(await route(null)(TASK_ID), { status: 404, code: 'survey_template_missing' });
  const proofError = Object.assign(new Error('central_proof_unavailable'), { status: 503, code: 'central_proof_unavailable' });
  let attempts = 0;
  const failing = route({ async publicTask() { attempts++; throw proofError; } });
  await assert.rejects(failing(TASK_ID), (e) => e === proofError);
  await assert.rejects(failing(TASK_ID), (e) => e === proofError);
  assert.equal(attempts, 2);
  // A reply that is not a verified native read is refused.
  assert.deepEqual(await route({ async publicTask() { return { authority: 'native', verified: false, task: nativeTask() }; } })(TASK_ID), { status: 404, code: 'survey_template_missing' });
});
