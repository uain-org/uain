// uain-agent 0.2.15: revising a survey after "needs more evidence" in one command (10 November 2026).
// Before, `revise` took only --evidence, so a survey revision could not carry its own new submission id,
// which the survey attestation binds; an operator had to pre-set the kit journal by hand.
// Fixture level: BAINK is a stub; the kit code is the shipped file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as kit from './uain-agent.mjs';
import * as web from '../web/survey-draft.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const TASK = 'T-OPP-00002-1-prior-art-survey', ORIGINAL = 'CS-11111111-0000-4000-8000-000000000001';
const template = JSON.parse(readFileSync(new URL('../server/survey-templates.json', import.meta.url))).templates[TASK];
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const NOW = Date.parse('2026-11-10T14:30:00Z');

function filled() {
  const extra = [1, 2, 3, 4].flatMap((n) => [
    `item: doi | 10.1000/fiction.${n} | Fictional record number ${n} | partial | Covers part of the KPI, not the scale.`,
    `item: arxiv | 2501.0000${n} | Fictional preprint number ${n} | adjacent | Related method that leaves the KPI open.`,
  ]);
  return web.surveyTemplateText(template, '2026-11-10').replace('gap:', extra.join('\n') + '\ngap:').replace('gap: What existing work leaves undone for the Main KPI (20 to 600 characters).', 'gap: No machine has more than tens of logical qubits today.');
}
/** A member whose survey the reviewer sent back, with the original in the kit journal as this kit sent it. */
async function member(t, { outcome = 'needs_evidence', open = true, reassess = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-revise-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const o = { home: dir, url: 'http://127.0.0.1:9', offline: true };
  const { address } = await kit.ops.init(o);
  const survey = web.parseSurveyDraft(filled(), template).survey;
  const evidence = kit.surveyEvidence({ taskId: TASK, submissionId: ORIGINAL, author: address, survey });
  const journal = { version: 1, ids: { [TASK]: { draft: 'x', id: ORIGINAL } }, steps: {
    'aaaaaaaa-0000-4000-8000-000000000001': { intent: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'central', operation: 'central_submit', target: 'submit:' + TASK, status: 'finalized', sentAt: '2026-11-10T03:00:00Z', payload: { id: ORIGINAL, task: TASK, evidence, evidence_digest: sha(evidence) } } } };
  await writeFile(join(dir, 'default', 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  const detail = {
    authority: 'native', verified: true, member: address, outcome,
    submission: { id: ORIGINAL, task: TASK, author: address, state: outcome === 'needs_evidence' ? 'under_review' : outcome, evidence_deadline: '1568910', ...(reassess ? { reassess: true } : {}) },
    task: { id: TASK, project: 'P-OPP-00002' },
    evidence: outcome !== 'needs_evidence' ? null : reassess ? { kind: 'reassessment_pending', window: { deadlineHeight: '1568910', blocksLeft: '120000', open: true }, actions: [] } : {
      kind: 'reviewer_request', found: ['Central accuracy remains unconfirmed: the claim that no machine has more than tens of logical qubits needs a source.'],
      window: { requestedAtHeight: '1439310', deadlineHeight: '1568910', blocksLeft: open ? '125000' : '0', deadlineEstimate: '2026-11-13T13:04:00Z', open }, actions: [] },
  };
  const calls = [], prepared = [];
  o.fetch = async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === `/api/native/central/submissions/${ORIGINAL}`) return json(detail);
    if (u.pathname === `/api/native/central/survey-template/${TASK}`) return json(template);
    // The test stops at the first signed step: it records what would be signed.
    if (u.pathname === '/api/native/central/prepare') { prepared.push(JSON.parse(init.body)); return json({ error: { code: 'test_stop', message: 'stopped by the test' } }, 400); }
    const base = { '/api/config': { origin: 'http://127.0.0.1:9' }, '/api/health': { ok: true }, '/api/account': { account: { native: { memberStatus: 'active' } } }, '/api/native/central/status': { licence: 'active', awards: [], earnings: { total: '0' }, balanceUnits: '0' },
      '/api/trade/enquiries': { enquiries: [] }, '/api/trade/deals': { deals: [] }, '/api/native/central/tasks': { tasks: [], more: false }, '/api/native/sends': { sends: [] }, '/api/native/payments': { intents: [] },
      '/api/native/central/intents': { intents: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'finalized', createdAt: '2026-11-10T03:00:00Z', command: { operation: 'central_submit', payload: { id: ORIGINAL, task: TASK } } }] } };
    if (base[u.pathname] !== undefined) return json(base[u.pathname]);
    return json({ error: { code: 'not_found', message: 'not found' } }, 404);
  };
  return { o, address, survey, calls, prepared };
}

test('the deadline is a time a person can read, at about 2.06 s a block', () => {
  const d = kit.deadlineText({ deadlineHeight: '1568910', blocksLeft: '125000' }, NOW);
  assert.equal(kit.BLOCK_SECONDS, 2.06);
  assert.equal(d.at, new Date(NOW + 125000 * 2060).toISOString());
  assert.equal(d.text, 'Friday 13 November, about 14:01 UTC (in about 72 hours)');
  assert.match(kit.deadlineText({ blocksLeft: '600' }, NOW).text, /\(in about 21 minutes\)$/);
  assert.match(kit.deadlineText({ blocksLeft: '0' }, NOW).text, /\(already passed\)$/);
});

test('next leads to the request: what the reviewer asked, the deadline, both choices and what happens after', async (t) => {
  const { o } = await member(t);
  const r = await kit.ops.next(o);
  assert.equal(r.stage, 'needs_evidence');
  assert.equal(r.next.tool, 'uain_agent_template'); assert.deepEqual(r.next.args, { task: TASK, from: ORIGINAL });
  assert.equal(r.next.cli, `uain-agent template ${TASK} --from ${ORIGINAL}`);
  assert.match(r.next.why, /^The reviewer needs more evidence for submission CS-1111.* Answer by [A-Z][a-z]+day \d+ November, about \d\d:\d\d UTC \(in about \d+ hours\): revise the answer, or ask once for a reassessment of the same answer\./);
  assert.match(r.next.why, /If neither is sent before the deadline, the submission closes unpaid and the task reopens for other members\./);
  assert.match(r.next.why, /What the reviewer found: \(1\) Central accuracy remains unconfirmed/);
  const ask = r.evidenceRequest;
  assert.deepEqual(ask.choices.map((c) => c.do), ['Revise the answer', 'Ask once for a reassessment']);
  assert.match(ask.choices[0].how, new RegExp(`uain-agent revise ${ORIGINAL} --survey <file>`));
  assert.equal(ask.choices[1].cli, `uain-agent reassess ${ORIGINAL}`);
  assert.equal(ask.deadline.height, '1568910');
});

test('status and history carry the same request', async (t) => {
  const { o } = await member(t);
  const s = await kit.ops.status(o);
  assert.match(s.evidenceNote, /^The reviewer needs more evidence for submission/);
  assert.equal(s.evidenceRequests.length, 1);
  const h = await kit.ops.history(o);
  const step = h.steps.find((x) => x.submission === ORIGINAL);
  assert.match(step.review, /^The reviewer needs more evidence/);
  assert.deepEqual(step.evidenceRequest.choices.map((c) => c.tool), ['uain_agent_template', 'uain_agent_reassess']);
});

test('template --from gives the survey as sent, as editable lines that parse back to the same survey', async (t) => {
  const { o, survey } = await member(t);
  const r = await kit.ops.template(o, { task: TASK, from: ORIGINAL });
  assert.equal(r.original, true);
  assert.match(r.text, /^# Your survey as you sent it\./);
  assert.match(r.text, /# What the reviewer found:\n#  - Central accuracy remains unconfirmed/);
  assert.match(r.text, /# Deadline: [A-Z][a-z]+day \d+ November/);
  assert.deepEqual(web.parseSurveyDraft(r.text, template).survey, survey, 'the lines read back to exactly what was sent');
});

test('revise --survey builds the revision with its own new id, linked to the original, the task read from the original', async (t) => {
  const { o, address, prepared } = await member(t);
  const corrected = (await kit.ops.template(o, { task: TASK, from: ORIGINAL })).text.replace('gap: No machine has more than tens of logical qubits today.', 'gap: This survey found no record of a machine with the Main KPI; the records only show single logical qubits.');
  await assert.rejects(kit.ops.revise(o, { submission: ORIGINAL, survey: corrected }), (e) => e.code === 'test_stop');
  assert.equal(prepared.length, 1);
  const { operation, payload } = prepared[0];
  assert.equal(operation, 'central_submit');
  assert.equal(payload.revises, ORIGINAL); assert.equal(payload.task, TASK);
  assert.match(payload.id, /^CS-[0-9a-f-]{36}$/); assert.notEqual(payload.id, ORIGINAL);
  const artifact = JSON.parse(payload.evidence);
  assert.equal(artifact.submissionId, payload.id, 'the attestation binds the revision\'s own id');
  assert.equal(artifact.author, address); assert.equal(artifact.taskId, TASK);
  assert.deepEqual(artifact.survey.conclusion.gaps, ['This survey found no record of a machine with the Main KPI; the records only show single logical qubits.']);
  assert.equal(payload.evidence_digest, sha(payload.evidence));
  // Sending the same text again keeps the same revision id (a retry never makes a second revision).
  await assert.rejects(kit.ops.revise(o, { submission: ORIGINAL, survey: corrected }), (e) => e.code === 'test_stop');
  assert.equal(prepared[1].payload.id, payload.id);
  // A survey task does not take free text: it says how to get the survey back.
  await assert.rejects(kit.ops.revise(o, { submission: ORIGINAL, evidence: 'more words' }), (e) => e.code === 'invalid_input' && /--survey file .* template .* --from/.test(e.message));
});

test('revise refuses before signing when nothing waits for the author', async (t) => {
  for (const [state, code] of [[{ outcome: 'accepted' }, 'central_evidence_not_requested'], [{ open: false }, 'central_evidence_window_closed'], [{ reassess: true }, 'central_evidence_already_answered']]) {
    const { o, prepared } = await member(t, state);
    await assert.rejects(kit.ops.revise(o, { submission: ORIGINAL, survey: filled() }), (e) => e.code === code && /Nothing was signed\./.test(e.message), code);
    assert.equal(prepared.length, 0, code);
  }
});

test('a submission the reviewer decided is cached and never read again by next', async (t) => {
  const { o, calls } = await member(t, { outcome: 'accepted' });
  await kit.ops.next(o);
  const reads = () => calls.filter((c) => c === `GET /api/native/central/submissions/${ORIGINAL}`).length;
  assert.equal(reads(), 1);
  await kit.ops.next(o);
  assert.equal(reads(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(o.home, 'default', 'outcomes.json'), 'utf8')), { [ORIGINAL]: 'accepted' });
});

test('the CLI and MCP take the survey for a revision', async () => {
  const tools = (await kit.handleMcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
  const revise = tools.find((x) => x.name === 'uain_agent_revise'), template = tools.find((x) => x.name === 'uain_agent_template');
  assert.deepEqual(revise.inputSchema.required, ['submission', 'confirm']);
  assert.ok(revise.inputSchema.properties.survey); assert.ok(template.inputSchema.properties.from);
});
