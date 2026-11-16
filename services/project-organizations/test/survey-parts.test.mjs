/** Survey parts: split replacement surveys (Rahul, 9 November 2026; C1 and D-4 defaults).
 * Real catalogue, drafts, reviewed records and the committed preflights; record APIs are FIXTURE answers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { estimateTaskDifficulty } from '../../../apps/baink/server/task-difficulty.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { createRunner, driverDigest, validateTaskPolicy, verifyEvidence } from '../src/verification.mjs';
import {
  SURVEY_PART_MAX_REQUIRED, SURVEY_PART_REVIEWER_UNITS, SURVEY_REVIEWER_UNITS, SURVEY_SOLVER_UNITS, buildSurveyOpenPayload,
  buildSurveyPartPayloads, isSurveyTask, parseSurveyPartId, requireAcceptedSurvey, surveyPartSolverUnits, surveyResolution, surveyStatus,
  surveyTaskId, validateSurveyPreflight,
} from '../src/survey.mjs';
import { gate } from '../ops/manager-stage.mjs';
import { build as buildParts, preflightRow } from '../ops/survey-parts.mjs';
import { sha256 } from '../src/common.mjs';
import { draftOf, reviewedOf, surveyArtifact } from './fixtures/survey-fixture.mjs';

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const DRIVER = driverDigest('prior-art-survey');
const PARTS_DIR = new URL('../../../docs/baink/project-organizations-2026-11-06/survey-parts/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, PARTS_DIR), 'utf8'));
const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const ctxOf = (projectId) => ({
  projectId, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(projectId)) },
  draft: draftOf(projectId), reviewed: reviewedOf(projectId), driverSha256: DRIVER,
});
const HELD = ['OPP-00004', 'OPP-00005', 'OPP-00006', 'OPP-00007'];
const author = 'uain1' + 'a'.repeat(40);

test('the committed part builds are exactly what the builder produces from the committed preflights', () => {
  for (const id of HELD) {
    const committed = readJson(`${id}.parts.json`);
    assert.deepEqual(buildParts(ctxOf(id), readJson(`${id}.preflight.json`)), committed, id);
  }
});

test('parts are small: at most 3 required records, proportional reward, native-valid payloads, one superseded survey', () => {
  let total = 0n;
  for (const id of HELD) {
    const { parts, dropped } = buildSurveyPartPayloads({ ...ctxOf(id), supersedes: surveyTaskId(id), preflight: readJson(`${id}.preflight.json`) });
    assert.ok(parts.length >= 2 && parts.length <= 4, `${id} splits into a few parts`);
    for (const [n, { payload, evidence, policy }] of parts.entries()) {
      const required = policy.successTests[0].requiredIds.length;
      assert.ok(required >= 1 && required <= SURVEY_PART_MAX_REQUIRED);
      assert.deepEqual(parseSurveyPartId(payload.id), { projectId: id, revision: 2, part: n + 1 });
      assert.equal(payload.solver_amount, String(20_000_000 * required), 'solver: 20 AI$ per record, the survey rate');
      assert.equal(payload.reviewer_amount, SURVEY_PART_REVIEWER_UNITS);
      assert.deepEqual(centralPayload('central_task_open', payload), payload);
      assert.equal(payload.acceptance_digest, sha256(payload.criteria));
      assert.equal(evidence.supersedes, surveyTaskId(id));
      assert.match(evidence.novelty, /unresolved/);
      assert.equal(validateTaskPolicy(policy).taskId, payload.id);
      assert.match(payload.title, new RegExp(`\\(part ${n + 1} of ${parts.length}\\)$`));
      total += BigInt(payload.solver_amount) + BigInt(payload.reviewer_amount);
    }
    for (const d of dropped) assert.notEqual(d.status, 'resolved');
  }
  assert.ok(total < 4n * (BigInt(SURVEY_SOLVER_UNITS) + BigInt(SURVEY_REVIEWER_UNITS)), 'the parts cost less than the four surveys they replace');
});

test('no part requires an identifier the preflight did not resolve with a real title', () => {
  for (const id of HELD) {
    const checked = new Map(readJson(`${id}.preflight.json`).records.map((r) => [`${r.kind}:${r.id}`, r]));
    for (const { policy } of readJson(`${id}.parts.json`).parts)
      for (const r of policy.successTests[0].requiredIds) assert.equal(checked.get(`${r.kind}:${r.id}`)?.status, 'resolved', `${id} ${r.id}`);
  }
  const mangled = readJson('OPP-00007.parts.json').dropped.map((d) => d.id);
  assert.ok(mangled.includes('10.1016/s1937-64481830076-5'), 'the held OPP-00007 DOI is dropped, not required');
});

test('a preflight must cover every required id; malformed or foreign preflights refuse', () => {
  const ctx = ctxOf('OPP-00004');
  const pre = readJson('OPP-00004.preflight.json');
  const base = { ...ctx, supersedes: surveyTaskId('OPP-00004') };
  assert.throws(() => buildSurveyPartPayloads({ ...base, preflight: { ...pre, records: pre.records.slice(1) } }), refuses('survey_preflight_incomplete'));
  assert.throws(() => buildSurveyPartPayloads({ ...base, preflight: { ...pre, projectId: 'OPP-00005' } }), refuses('invalid_survey_preflight'));
  assert.throws(() => buildSurveyPartPayloads({ ...base, preflight: { ...pre, records: [{ ...pre.records[1], title: 'untitled' }, ...pre.records.slice(2)] } }),
    refuses('invalid_survey_preflight'));
  assert.throws(() => buildSurveyPartPayloads({ ...ctx, supersedes: 'T-other', preflight: pre }), refuses('invalid_survey_part'));
  assert.throws(() => surveyPartSolverUnits(4), refuses('invalid_survey_part'));
  assert.equal(validateSurveyPreflight(pre, 'OPP-00004'), pre);
});

test('preflight rows: a grant DOI with no title and a 404 are never "resolved"', () => {
  const doi = (message) => ({ kind: 'doi', id: '10.67599/anr-20-ce18-0001', status: 200, body: new Uint8Array(Buffer.from(JSON.stringify({ status: 'ok', message }))) });
  assert.deepEqual(preflightRow('doi', '10.67599/anr-20-ce18-0001', doi({ DOI: '10.67599/anr-20-ce18-0001', type: 'grant' })),
    { kind: 'doi', id: '10.67599/anr-20-ce18-0001', status: 'untitled', title: null });
  assert.equal(preflightRow('doi', '10.1/x', { kind: 'doi', id: '10.1/x', status: 404, body: null }).status, 'not_found');
  assert.equal(preflightRow('doi', '10.1/x', { kind: 'doi', id: '10.1/x', status: 0, body: null }).status, 'unreadable');
  assert.deepEqual(preflightRow('doi', '10.67599/anr-20-ce18-0001', doi({ DOI: '10.67599/anr-20-ce18-0001', title: ['A grant'] })).status, 'resolved');
});

/** FIXTURE record API answering exactly the given DOI titles. */
const doiApi = (titles) => ({
  async observe(url) {
    const id = Object.keys(titles).find((d) => surveyResolution('doi', d)?.url === url);
    if (!id) return { url, status: 404, bytes: Buffer.from('{"status":"error"}') };
    return { url, status: 200, bytes: Buffer.from(JSON.stringify({ status: 'ok', message: { DOI: id, title: [titles[id]] } })) };
  },
});
const instant = () => { let t = 0; return { sleep: async (ms) => { t += ms; }, now: () => t }; };

test('a part is verified by the same pinned survey driver: its own records pass; a missing record fails', async () => {
  const { parts } = readJson('OPP-00006.parts.json');
  const { policy } = parts[0];
  const pre = new Map(readJson('OPP-00006.preflight.json').records.map((r) => [r.id, r.title]));
  const items = policy.successTests[0].requiredIds.map((r, i) => ({
    kind: 'doi', id: r.id, title: pre.get(r.id), relation: i === 0 ? 'partial' : 'adjacent', note: 'FIXTURE note: not a research result.',
  }));
  const survey = { mainKpi: policy.successTests[0].mainKpi, asOf: '2026-11-09', items, conclusion: { meetsMainKpi: false, gaps: ['FIXTURE gap: these records leave the KPI undone.'] } };
  const assignment = { taskId: policy.taskId, projectId: policy.projectId, submissionId: 'S-part-1', author, criteriaDigest: policy.criteriaDigest };
  const runner = createRunner({ timeoutMs: 20000 });
  const titles = Object.fromEntries(items.map((i) => [i.id, i.title]));
  const run = (s) => verifyEvidence({ taskPolicy: policy, assignment, artifact: surveyArtifact({ taskId: policy.taskId, submissionId: 'S-part-1', author, survey: s }).artifact },
    { retriever: doiApi(titles), runner, surveyPacing: instant() });
  const pass = await run(survey);
  assert.equal(pass.verdict, 'pass', pass.findings.join(' '));
  assert.equal(pass.attestation.driver.sha256, DRIVER);
  const missing = await run({ ...survey, items: items.slice(1) });
  assert.equal(missing.verdict, 'fail');
  assert.ok(missing.findings.some((f) => f.startsWith('required_id_unaccounted')));
});

/** FIXTURE native tasks of a split survey: the held original stays open; parts in the given states. */
function splitSnapshot(projectId, states) {
  const { parts } = readJson(`${projectId}.parts.json`);
  const tasks = [{ id: surveyTaskId(projectId), project: `P-${projectId}`, state: 'open', pending: '', winner: '' }];
  const records = {};
  parts.forEach(({ request, policy }, i) => {
    const p = request.payload, state = states[i] ?? 'open';
    const task = { id: p.id, project: p.project, title: p.title, state, pending: state === 'under_review' ? 'S-x' : '', winner: '' };
    if (state === 'accepted') {
      const sid = `S-${p.id}`;
      const survey = { mainKpi: policy.successTests[0].mainKpi, asOf: `2026-11-1${i}`, items: [{ kind: 'doi', id: policy.successTests[0].requiredIds[0].id,
        title: 'FIXTURE', relation: 'partial', note: 'FIXTURE note: not a research result.' }], conclusion: { meetsMainKpi: false, gaps: [`FIXTURE gap from part ${i + 1} of the survey.`] } };
      const { bytes } = surveyArtifact({ taskId: p.id, submissionId: sid, author, survey });
      task.winner = sid;
      records[`central_submission/${sid}`] = { id: sid, task: p.id, author, evidence: bytes, evidence_digest: sha256(bytes), state: 'accepted' };
    }
    tasks.push(task);
  });
  return { projectId, nativeProjectId: `P-${projectId}`, available: true, tasks, records };
}

test('a split survey is accepted only when every part of the latest revision is accepted; items and gaps merge', () => {
  const pending = surveyStatus(splitSnapshot('OPP-00004', ['accepted', 'under_review', 'open']));
  assert.equal(pending.state, 'pending');
  assert.equal(pending.taskState, 'under_review');
  assert.throws(() => requireAcceptedSurvey(splitSnapshot('OPP-00004', ['accepted', 'accepted', 'open'])), refuses('prior_art_survey_required'));
  const partial = splitSnapshot('OPP-00004', ['accepted', 'accepted', 'accepted']);
  partial.tasks.pop();
  assert.equal(surveyStatus(partial).taskState, 'parts_opening', 'a part not yet opened keeps the survey pending');
  const done = requireAcceptedSurvey(splitSnapshot('OPP-00004', ['accepted', 'accepted', 'accepted']));
  assert.equal(done.state, 'accepted');
  assert.equal(done.survey.items.length, 3);
  assert.equal(done.survey.conclusion.gaps.length, 3);
  assert.equal(done.survey.asOf, '2026-11-12');
  assert.equal(done.taskIds.length, 4, 'the held original and the three parts');
  assert.ok(done.taskIds.every((t) => isSurveyTask('OPP-00004', t)));
  assert.equal(isSurveyTask('OPP-00004', 'T-OPP-00005-1-prior-art-survey-r2-p1'), false);
});

test('the manager gate treats the held original and every part as the survey, not as open work', () => {
  const snapshot = splitSnapshot('OPP-00004', ['accepted', 'accepted', 'accepted']);
  const policy = { projects: { 'OPP-00004': { manager: 'uain1' + 'c'.repeat(40) } } };
  const project = { holds: [] };
  const sel = { get: () => project };
  // stepFunds needs native funds; its refusal comes after the survey and open-task gates.
  assert.throws(() => gate({ snapshot, selection: sel, policy, projectId: 'OPP-00004' }), (e) => e.code !== 'open_task_exists' && e.code !== 'task_state_unknown');
  const other = { ...snapshot, tasks: [...snapshot.tasks, { id: 'T-OPP-00004-1-0123456789abcdef', state: 'open' }] };
  assert.throws(() => gate({ snapshot: other, selection: sel, policy, projectId: 'OPP-00004' }), refuses('open_task_exists'));
});

test('difficulty: a survey part is a starter of at most 30 minutes; a full survey is not a starter', () => {
  const { parts } = readJson('OPP-00006.parts.json');
  for (const { request, policy } of parts) {
    const p = request.payload;
    const task = { id: p.id, criteria: p.criteria, eligibility: p.eligibility, solver_amount: p.solver_amount, reviewer_amount: p.reviewer_amount, paid: '0', state: 'open' };
    const estimate = estimateTaskDifficulty(task, { requirements: { available: true, policy } });
    assert.equal(estimate.level, 'starter', JSON.stringify(estimate.reasons));
    assert.ok(estimate.minutes.max <= 30, `${p.id}: ${estimate.minutes.max} minutes`);
  }
  const { payload, policy } = buildSurveyOpenPayload(ctxOf('OPP-00002'));
  const full = estimateTaskDifficulty({ id: payload.id, criteria: payload.criteria, eligibility: 'new', solver_amount: payload.solver_amount,
    reviewer_amount: payload.reviewer_amount, paid: '0', state: 'open' }, { requirements: { available: true, policy } });
  assert.notEqual(full.level, 'starter');
  assert.ok(full.minutes.max > 30);
  assert.equal(SURVEY_REVIEWER_UNITS, '50000000');
});

test('a member agent can do a part through MCP alone: published template -> agent draft -> evidence the pinned driver passes', async () => {
  const { parseSurveyDraft, surveyEvidence, surveyTemplateText, SURVEY_TASK } = await import('../../../apps/baink/agent-kit/uain-agent.mjs');
  const published = JSON.parse(readFileSync(new URL('../../../apps/baink/server/survey-templates.json', import.meta.url), 'utf8')).templates;
  const { parts } = readJson('OPP-00005.parts.json');
  for (const { request, policy } of parts) assert.ok(published[policy.taskId] && SURVEY_TASK.test(policy.taskId), `${policy.taskId} published and accepted by the kit`);
  const { request, policy } = parts[0];
  const template = published[policy.taskId];
  assert.equal(template.criteriaDigest, request.payload.acceptance_digest);
  assert.deepEqual(template.required.map((r) => r.id), policy.successTests[0].requiredIds.map((r) => r.id));
  // The agent fills the template: it keeps the first record as partial and screens the others out.
  const text = surveyTemplateText(template, '2026-11-09').split('\n').map((line, i, all) =>
    line === `item: doi | ${template.required[0].id} | ${template.required[0].title} | screened_out | Why it does not bear on the Main KPI.`
      ? `item: doi | ${template.required[0].id} | ${template.required[0].title} | partial | FIXTURE note: an agent-written relation to the Main KPI.`
      : line).join('\n');
  const parsed = parseSurveyDraft(text, template);
  assert.equal(parsed.errors, undefined, JSON.stringify(parsed.errors));
  const author = 'uain1' + 'a'.repeat(40);
  const evidence = surveyEvidence({ taskId: policy.taskId, submissionId: 'CS-part', author, survey: parsed.survey });
  const artifact = JSON.parse(evidence);
  const titles = Object.fromEntries(template.required.map((r) => [r.id, r.title]));
  const result = await verifyEvidence({ taskPolicy: policy, assignment: { taskId: policy.taskId, projectId: policy.projectId, submissionId: 'CS-part', author, criteriaDigest: policy.criteriaDigest }, artifact },
    { retriever: doiApi(titles), runner: createRunner({ timeoutMs: 20000 }), surveyPacing: instant() });
  assert.equal(result.verdict, 'pass', result.findings.join(' '));
});

test('a full survey opens only when its live preflight resolved every required record (held specs, plan W7)', async () => {
  const { requireResolvedSurvey } = await import('../ops/starter-authority.mjs');
  const { buildSurveyOpenPayload } = await import('../src/survey.mjs');
  const { loadCatalogue } = await import('../../../apps/baink/server/catalogue.mjs');
  const { catalogueRecords, loadSelection } = await import('../src/selection.mjs');
  const { driverDigest } = await import('../src/verification.mjs');
  const { readdirSync, readFileSync } = await import('node:fs');
  const docs = new URL('../../../docs/baink/project-organizations-2026-11-06/', import.meta.url);
  const catalogue = catalogueRecords(await loadCatalogue(new URL('../../../apps/baink/catalogue', import.meta.url).pathname));
  const selection = await loadSelection();
  const json = (name) => JSON.parse(readFileSync(new URL(name, docs), 'utf8'));
  let refused = 0, accepted = 0;
  for (const name of readdirSync(new URL('survey-parts/', docs)).filter((n) => n.endsWith('.preflight.json'))) {
    const id = name.slice(0, 9);
    let survey;
    try {
      survey = buildSurveyOpenPayload({ projectId: id, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) },
        draft: json(`bootstrap-drafts/${id}.json`), reviewed: json(`bootstrap-reviewed/${id}.json`), driverSha256: driverDigest('prior-art-survey') });
    } catch { continue; }
    const preflight = json(`survey-parts/${name}`);
    const resolved = new Set(preflight.records.filter((r) => r.status === 'resolved').map((r) => `${r.kind}:${r.id}`));
    const complete = survey.evidence.requiredIds.every((r) => resolved.has(`${r.kind}:${r.id}`));
    if (complete) { requireResolvedSurvey(survey, preflight, id); accepted += 1; }
    else { assert.throws(() => requireResolvedSurvey(survey, preflight, id), (e) => e.code === 'survey_requires_unresolved_record'); refused += 1; }
  }
  // 10 November 2026: 13 committed specs still require punctuation-stripped DOIs from their reviewed searches
  // (for example 10.1016/s0262-40791530636-9, held OPP-00004); every one refuses, the other 75 build.
  assert.equal(refused, 13, `refused ${refused}`);
  assert.equal(accepted, 75, `accepted ${accepted}`);
  for (const held of ['OPP-00004', 'OPP-00007']) {
    const survey = buildSurveyOpenPayload({ projectId: held, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(held)) },
      draft: json(`bootstrap-drafts/${held}.json`), reviewed: json(`bootstrap-reviewed/${held}.json`), driverSha256: driverDigest('prior-art-survey') });
    assert.throws(() => requireResolvedSurvey(survey, json(`survey-parts/${held}.preflight.json`), held), (e) => e.code === 'survey_requires_unresolved_record', held);
  }
  assert.throws(() => requireResolvedSurvey({ evidence: { requiredIds: [] } }, { schema: 'x' }, 'OPP-00004'), (e) => e.code === 'invalid_survey_preflight');
});
