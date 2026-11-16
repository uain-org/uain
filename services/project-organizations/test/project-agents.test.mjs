/** Project agents (Rahul, 9 November 2026): two Sonnet agents per project, woken by project activity.
 * Real catalogue, selection, drafts and reviewed records; models, native and record APIs are FIXTURES. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { driverDigest, validateTaskPolicy } from '../src/verification.mjs';
import { GUARDIAN } from '../src/bootstrap.mjs';
import { buildAgentPartPayloads, parseSurveyPartId, surveyPartCriteria } from '../src/survey.mjs';
import { sha256 } from '../src/common.mjs';
import {
  PROJECT_AGENT_MODEL, PROJECT_AGENT_SCHEMAS, activityFromEvents, executionsAdmitted, nextRevision, parseAssessor, parseWriter,
  projectStock, resolvedUnits, subjectProject, unitsNeeded, wakeOrder, writerPrompt,
} from '../src/project-agents.mjs';
import { runProject, validateConfig } from '../ops/project-agents.mjs';
import { execute as runtimeExecute } from '../ops/project-agent-runtime.mjs';
import { draftOf, reviewedOf } from './fixtures/survey-fixture.mjs';

const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const DRIVER = driverDigest('prior-art-survey');
const PARTS = JSON.parse(readFileSync(new URL('../../../docs/baink/project-organizations-2026-11-06/survey-parts/OPP-00004.parts.json', import.meta.url), 'utf8'));
const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const H = (c) => c.repeat(64);
const config = validateConfig({ schema: 'uain-project-agents-config-v1', target_open: 3, max_projects_per_run: 2, max_executions_per_day: 120, cooldown_minutes: 10, fallback_hours: 24 });

test('every agent runs on Sonnet', () => {
  assert.equal(PROJECT_AGENT_MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(Object.keys(PROJECT_AGENT_SCHEMAS), ['writer', 'assessor']);
});

test('joins, submissions and reviews by members wake their project; our own openings and other projects do not', () => {
  const events = [
    { id: '1', operation: 'project_join', member: 'uain1' + 'b'.repeat(40), subject: 'P-OPP-00004' },
    { id: '2', operation: 'central_submit', member: 'uain1' + 'b'.repeat(40), subject: 'CS-1' },
    { id: '3', operation: 'central_review', member: 'uain1' + 'c'.repeat(40), subject: 'CS-1' },
    { id: '4', operation: 'central_task_open', member: GUARDIAN, subject: 'T-OPP-00004-1-prior-art-survey-r3-p1' },
    { id: '5', operation: 'project_join', member: GUARDIAN, subject: 'P-OPP-00005' },
    { id: '6', operation: 'project_join', member: 'uain1' + 'b'.repeat(40), subject: 'P-OPP-99999' },
    { id: '7', operation: 'central_submit', member: 'uain1' + 'b'.repeat(40), subject: 'CS-unknown' },
  ];
  const activity = activityFromEvents(events, { projects: ['OPP-00004', 'OPP-00005'], ownMembers: [GUARDIAN],
    submissionTask: new Map([['CS-1', 'T-OPP-00004-1-prior-art-survey-r2-p1']]) });
  assert.deepEqual([...activity.keys()], ['OPP-00004']);
  assert.deepEqual(activity.get('OPP-00004').map((e) => e.operation), ['project_join', 'central_submit', 'central_review']);
  assert.equal(subjectProject('T-OPP-00242-1-prior-art-survey-r2-p1'), 'OPP-00242');
  assert.equal(subjectProject('CS-1'), null);
});

test('stock counts accepting, waiting, reviewed and accepted parts, and what is covered', () => {
  const opened = new Set(PARTS.parts.slice(0, 2).map((r) => r.request.id));
  const [a, b] = PARTS.parts.map((r) => r.request.payload.id);
  const stock = projectStock('OPP-00004', [PARTS], opened, { [a]: { state: 'open', pending: '', winner: '' }, [b]: { state: 'under_review', pending: 'CS-1', winner: '' } });
  assert.deepEqual([stock.open, stock.unopened, stock.underReview, stock.accepted], [1, 1, 1, 0]);
  assert.equal(stock.covered.length, PARTS.parts.flatMap((r) => r.policy.successTests[0].requiredIds).length);
  assert.equal(unitsNeeded(stock, 3), 1);
  assert.equal(unitsNeeded({ ...stock, open: 3 }, 3), 0);
  assert.equal(nextRevision(stock), 3);
  assert.equal(nextRevision({ revisions: [2, 3, 4, 5, 6, 7, 8, 9] }), null);
});

test('activity wakes after the cooldown; the fallback only for a short project; activity first', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const state = { 'OPP-00002': { lastRun: now - 5 * 60000 }, 'OPP-00003': { lastRun: now - 30 * 3600000 }, 'OPP-00004': { lastRun: now - 60 * 60000 } };
  const woken = wakeOrder({ projects: ['OPP-00002', 'OPP-00003', 'OPP-00004', 'OPP-00005'], now, cooldownMinutes: 10, fallbackHours: 24, state,
    activity: new Map([['OPP-00002', [{}]], ['OPP-00004', [{}]]]), short: new Set(['OPP-00003', 'OPP-00005']) });
  assert.deepEqual(woken, [{ project: 'OPP-00004', reason: 'activity' }, { project: 'OPP-00005', reason: 'fallback' }, { project: 'OPP-00003', reason: 'fallback' }]);
  assert.equal(executionsAdmitted([now - 1000, now - 25 * 3600000], 2, { maxPerDay: 3, now }), true);
  assert.equal(executionsAdmitted([now - 1000, now - 2000], 2, { maxPerDay: 3, now }), false);
});

test('writer units are normalized, deduplicated against coverage and capped; assessor accepts only explicit verdicts', () => {
  const covered = [{ kind: 'doi', id: '10.1000/covered' }];
  const out = parseWriter({ note: 'n', units: [
    { records: [{ kind: 'doi', id: 'https://doi.org/10.1000/COVERED' }, { kind: 'doi', id: '10.2000/New' }, { kind: 'pubmed', id: 'x' }], reason: 'r1' },
    { records: [{ kind: 'nct', id: 'nct01234567' }], reason: 'r2' },
    { records: [{ kind: 'doi', id: '10.2000/new' }], reason: 'duplicate of unit 1' },
  ] }, { covered, needed: 3 });
  assert.deepEqual(out.units.map((u) => u.records), [[{ kind: 'doi', id: '10.2000/new' }], [{ kind: 'nct', id: 'NCT01234567' }]]);
  assert.deepEqual(parseAssessor({ verdicts: [{ unit: 2, accept: true, reason: 'ok' }, { unit: 1, accept: false, reason: 'no' }, { unit: 9, accept: true, reason: 'x' }] }, 2), [2]);
  assert.throws(() => parseWriter({ units: 'x', note: '' }), refuses('invalid_writer_output'));
  const units = resolvedUnits(out.units, [{ kind: 'doi', id: '10.2000/new', status: 'not_found' }, { kind: 'nct', id: 'NCT01234567', status: 'resolved', title: 'A trial' }]);
  assert.deepEqual(units, [{ records: [{ kind: 'nct', id: 'NCT01234567', title: 'A trial' }], reason: 'r2' }]);
});

const ctxOf = (projectId) => ({ projectId, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(projectId)) },
  draft: draftOf(projectId), reviewed: reviewedOf(projectId), driverSha256: DRIVER });

test('agent parts are ordinary survey parts at a later revision: fixed criteria, policy and price', () => {
  const { parts, supersedes } = buildAgentPartPayloads({ ...ctxOf('OPP-00004'), revision: 3, units: [[{ kind: 'doi', id: '10.2000/new' }], [{ kind: 'pubmed', id: '123' }, { kind: 'nct', id: 'NCT01234567' }]],
    covered: [{ kind: 'doi', id: '10.1000/covered' }], agents: { writer: H('a'), assessor: H('b') } });
  assert.equal(supersedes, 'T-OPP-00004-1-prior-art-survey');
  assert.deepEqual(parts.map((p) => p.payload.id), ['T-OPP-00004-1-prior-art-survey-r3-p1', 'T-OPP-00004-1-prior-art-survey-r3-p2']);
  assert.deepEqual(parts.map((p) => [p.payload.solver_amount, p.payload.reviewer_amount]), [['20000000', '10000000'], ['40000000', '10000000']]);
  for (const p of parts) {
    assert.equal(p.payload.acceptance_digest, sha256(p.payload.criteria));
    assert.equal(p.payload.criteria, surveyPartCriteria({ title: catalogue.records.get('OPP-00004').title, mainKpi: selection.get('OPP-00004').mainKpi,
      part: p.evidence.part, parts: 2, requiredIds: p.evidence.requiredIds }));
    assert.equal(p.policy.class, 'prior_art_survey');
    assert.equal(p.policy.driver.sha256, DRIVER);
    validateTaskPolicy(p.policy);
    assert.deepEqual(parseSurveyPartId(p.payload.id), { projectId: 'OPP-00004', revision: 3, part: p.evidence.part });
  }
  assert.throws(() => buildAgentPartPayloads({ ...ctxOf('OPP-00004'), revision: 2, units: [[{ kind: 'doi', id: '10.2000/new' }]], agents: { writer: H('a'), assessor: H('b') } }), refuses('invalid_survey_part'));
  assert.throws(() => buildAgentPartPayloads({ ...ctxOf('OPP-00004'), revision: 3, units: [[{ kind: 'doi', id: '10.1000/covered' }]], covered: [{ kind: 'doi', id: '10.1000/covered' }],
    agents: { writer: H('a'), assessor: H('b') } }), refuses('survey_part_duplicate'));
  assert.throws(() => buildAgentPartPayloads({ ...ctxOf('OPP-00004'), revision: 3, units: [[{ kind: 'doi', id: '10.2000/new' }]], agents: { writer: H('a'), assessor: H('a') } }), refuses('invalid_agent_receipts'));
});

const receipt = (role) => ({ executionId: 'pa-' + role, role, projectId: 'OPP-00004', model: PROJECT_AGENT_MODEL, startedAt: '2026-11-09T12:00:00.000Z' });

test('a woken short project runs its two agents and writes policies before the parts file', async () => {
  const stock = projectStock('OPP-00004', [PARTS], new Set(PARTS.parts.map((r) => r.request.id)), Object.fromEntries(PARTS.parts.map((r, i) =>
    [r.request.payload.id, i === 0 ? { state: 'under_review', pending: 'CS-1' } : { state: 'open', pending: '', winner: '' }])));
  const writes = [], roles = [];
  const deps = {
    now: () => Date.parse('2026-11-09T12:00:00Z'), policies: '/P', authorityDir: '/A',
    execute: async ({ role, prompt }) => {
      roles.push(role);
      if (role === 'writer') {
        assert.match(prompt, /propose exactly 3 new small unit/);
        return { value: { units: [{ records: [{ kind: 'doi', id: '10.2000/new' }, { kind: 'doi', id: '10.3000/missing' }], reason: 'gap' }], note: '' }, receipt: receipt(role) };
      }
      assert.match(prompt, /10\.2000\/new — "Real title"/);
      assert.doesNotMatch(prompt, /10\.3000\/missing/);
      return { value: { verdicts: [{ unit: 1, accept: true, reason: 'relevant' }] }, receipt: receipt(role) };
    },
    preflight: async (units) => units.flatMap((u) => u.records).map((r) => r.id === '10.2000/new' ? { ...r, status: 'resolved', title: 'Real title' } : { ...r, status: 'not_found', title: null }),
    write: async (path, value) => writes.push([path, value]),
  };
  const record = await runProject('OPP-00004', { ctx: { selection, catalogue }, config, stock, activity: [{ operation: 'central_submit', subject: 'CS-1' }], deps });
  assert.equal(record.outcome, 'written');
  assert.deepEqual(roles, ['writer', 'assessor']);
  assert.deepEqual(record.tasks, ['T-OPP-00004-1-prior-art-survey-r3-p1']);
  assert.deepEqual(writes.map(([p]) => p), ['/P/T-OPP-00004-1-prior-art-survey-r3-p1.json', '/A/OPP-00004.agent-r3.parts.json']);
  const file = writes[1][1];
  assert.equal(file.schema, 'uain-survey-parts-build-v1');
  assert.equal(file.parts[0].request.member, GUARDIAN);
  assert.equal(file.parts[0].request.id, 'survey-OPP-00004-r3-p1');
  assert.deepEqual(file.parts[0].policy.successTests[0].requiredIds, [{ kind: 'doi', id: '10.2000/new' }]);
  assert.deepEqual(record.executions.map((e) => e.model), [PROJECT_AGENT_MODEL, PROJECT_AGENT_MODEL]);
});

test('a full project records the wake without a model call; a rejected unit writes nothing', async () => {
  const full = { projectId: 'OPP-00004', open: 3, unopened: 0, underReview: 0, accepted: 0, covered: [], revisions: [2] };
  const never = async () => assert.fail('no model call');
  const r1 = await runProject('OPP-00004', { ctx: { selection, catalogue }, config, stock: full, activity: [{ operation: 'project_join' }], deps: { now: () => 0, execute: never } });
  assert.equal(r1.outcome, 'stock_full');
  const writes = [];
  const r2 = await runProject('OPP-00004', { ctx: { selection, catalogue }, config, stock: { ...full, open: 2 }, activity: [], deps: { now: () => 0,
    execute: async ({ role }) => role === 'writer' ? { value: { units: [{ records: [{ kind: 'doi', id: '10.2000/new' }], reason: 'x' }], note: '' }, receipt: receipt(role) }
      : { value: { verdicts: [{ unit: 1, accept: false, reason: 'unrelated' }] }, receipt: receipt(role) },
    preflight: async (units) => units.flatMap((u) => u.records).map((r) => ({ ...r, status: 'resolved', title: 't' })), write: async (...a) => writes.push(a) } });
  assert.equal(r2.outcome, 'assessor_rejected_all');
  assert.equal(writes.length, 0);
});

test('the isolated runtime pins the CLI, Sonnet, subscription OAuth and per-role tools', async () => {
  const calls = [];
  const run = async (o) => (calls.push(o), { value: { units: [], note: '' }, metadata: { model: 'claude-sonnet-5-5' } });
  const out = await runtimeExecute({ role: 'writer', projectId: 'OPP-00004', executionId: 'pa-1', prompt: 'p' }, { run, env: {} });
  assert.equal(out.model, 'claude-sonnet-5-5');
  assert.equal(calls[0].usageSource, 'subscription');
  assert.equal(calls[0].tools, 'WebSearch,WebFetch');
  await runtimeExecute({ role: 'assessor', projectId: 'OPP-00004', executionId: 'pa-2', prompt: 'p' }, { run, env: {} });
  assert.equal(calls[1].tools, '');
  await assert.rejects(runtimeExecute({ role: 'ceo', projectId: 'x', executionId: 'y', prompt: 'p' }, { run }));
  await assert.rejects(runtimeExecute({ role: 'writer', projectId: 'x', executionId: 'y', prompt: 'p' }, { run: async () => ({ value: {}, metadata: { model: 'claude-opus-5-5' } }) }));
});

test('configuration is strict and bounded', () => {
  for (const change of [{ target_open: 0 }, { max_executions_per_day: 5000 }, { cooldown_minutes: 0 }, { extra: 1 }]) {
    assert.throws(() => validateConfig({ ...config, ...change }), refuses('invalid_agent_config'));
  }
  assert.match(writerPrompt({ projectId: 'OPP-00004', title: 't', mainKpi: 'kpi', stock: { open: 0, unopened: 0, underReview: 0, accepted: 0, covered: [] }, needed: 2, activity: [] }), /scheduled check/);
});

test('the five v1 projects whose full survey opened get agent parts that never repeat the survey records', async () => {
  const { surveyCovered } = await import('../ops/project-agents.mjs');
  const { buildSurveyOpenPayload } = await import('../src/survey.mjs');
  for (const id of ['OPP-00002', 'OPP-00003', 'OPP-00009', 'OPP-00010', 'OPP-00014']) {
    const source = { revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) };
    const opened = buildSurveyOpenPayload({ projectId: id, selection, source, draft: draftOf(id), reviewed: reviewedOf(id), driverSha256: DRIVER });
    const policy = opened.policy ?? opened.task?.policy;
    assert.ok(policy, `${id}: survey policy`);
    // The installed survey policy is read from the policy folder; a parts-first project has none.
    const read = async (path, { optional }) => (path.endsWith(`T-${id}-1-prior-art-survey.json`) ? structuredClone(policy) : (assert.ok(optional), null));
    const surveyIds = await surveyCovered(id, '/etc/uain-custody/task-policies', read);
    assert.deepEqual(surveyIds, policy.successTests[0].requiredIds);
    assert.deepEqual(await surveyCovered('OPP-00243', '/etc/uain-custody/task-policies', read), []);
    // No reviewed parts file: the stock is empty, so the agents start at revision 3 with three units.
    const stock = projectStock(id, [], new Set(), {}, { surveyCovered: surveyIds });
    assert.deepEqual([stock.open, stock.unopened, nextRevision(stock), unitsNeeded(stock, 3)], [0, 0, 3, 3]);
    assert.equal(stock.covered.length, surveyIds.length);
    // A unit that repeats a survey record is refused; a new record builds a part the starter accepts.
    assert.throws(() => buildAgentPartPayloads({ projectId: id, selection, source, draft: draftOf(id), reviewed: reviewedOf(id), driverSha256: DRIVER, revision: 3,
      units: [[surveyIds[0]]], covered: stock.covered, agents: { writer: H('a'), assessor: H('b') } }), refuses('survey_part_duplicate'));
    const fresh = { kind: 'pubmed', id: '39000001' };
    const built = buildAgentPartPayloads({ projectId: id, selection, source, draft: draftOf(id), reviewed: reviewedOf(id), driverSha256: DRIVER, revision: 3,
      units: [[fresh]], covered: stock.covered, agents: { writer: H('a'), assessor: H('b') } });
    assert.equal(built.parts[0].payload.id, `T-${id}-1-prior-art-survey-r3-p1`);
    assert.equal(built.supersedes, `T-${id}-1-prior-art-survey`);
    validateTaskPolicy(built.parts[0].policy);
  }
  assert.throws(() => projectStock('OPP-00002', [], new Set(), {}, { surveyCovered: [{ kind: 'doi', id: 'NOT CANONICAL' }] }), refuses('invalid_parts'));
});
