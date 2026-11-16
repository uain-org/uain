// The no-install member path (P0-2, 11 November 2026), through the BAINK MCP only: the member's
// AI holds the key in its own sandbox (the served signer run with python3) and sends signed
// requests through baink_member_request. Real createBainkServer; the native chain is a fictional
// in-memory state behind the pinned transport seam, as in agent-kit/uain-agent.test.mjs.
// Nothing here reaches baink.money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createBainkServer } from '../server/app.mjs';
import { centralEarningSigningBytes, CENTRAL_POLICY } from '../server/central-earning-command.mjs';
import { nativeEnrolSigningBytes } from '../web/native-enrol.js';
import { guideAnswer } from '../server/guide-answers.mjs';
import { signerSandbox, kw } from './signer-driver.mjs';
import { RELAY_INTENT_LIMIT, boundIntentList } from '../server/mcp-member.mjs';

const stepIsListed = (reply, id) => reply.answer.intents.some((i) => i.id === id);

// The relay's bound on the steps list (12 November 2026): under, at and over the limit, waiting
// steps never cut, a smaller asked limit, one step by id. FIXTURE (pure function).
test('the relay lists at most RELAY_INTENT_LIMIT steps, newest first, and keeps every waiting step', () => {
  assert.equal(RELAY_INTENT_LIMIT, 10);
  const step = (n, status = 'finalized') => ({ id: `step-${n}`, status, finalized: status === 'finalized', createdAt: `2026-11-${String(30 - n).padStart(2, '0')}` });
  const list = (n, waitingAt = []) => ({ intents: Array.from({ length: n }, (_, i) => step(i, waitingAt.includes(i) ? 'unknown' : 'finalized')) });
  const under = boundIntentList(list(9));
  assert.equal(under.answer.intents.length, 9);
  assert.equal(under.answer.more, false);
  const at = boundIntentList(list(10));
  assert.equal(at.answer.intents.length, 10);
  assert.equal(at.answer.more, false);
  const over = boundIntentList(list(11));
  assert.deepEqual(over.answer.intents.map((i) => i.id), Array.from({ length: 10 }, (_, i) => `step-${i}`), 'the newest 10');
  assert.equal(over.answer.total, 11);
  assert.equal(over.answer.more, true);
  const waiting = boundIntentList(list(40, [25]));
  assert.equal(waiting.answer.intents.length, 11, 'the 10 newest and the older waiting step');
  assert.equal(waiting.answer.intents.at(-1).id, 'step-25');
  for (const status of ['prepared', 'unknown', 'broadcasting', 'submission-not-recorded'])
    assert.equal(boundIntentList({ intents: [...list(12).intents, step(12, status)] }).answer.intents.length, 11, status);
  for (const status of ['expired', 'expired-unused'])
    assert.equal(boundIntentList({ intents: [...list(12).intents, step(12, status)] }).answer.intents.length, 10, status);
  const asked = boundIntentList(list(30), new URLSearchParams('limit=3'));
  assert.equal(asked.answer.intents.length, 3);
  assert.equal(boundIntentList(list(30), new URLSearchParams('limit=50')).answer.intents.length, 10, 'never more than the relay limit');
  const byId = boundIntentList({ intents: [step(7)], total: 30 }, new URLSearchParams('id=step-7'));
  assert.equal(byId.one, true);
  assert.deepEqual(byId.answer.intents.map((i) => i.id), ['step-7']);
  assert.equal(boundIntentList({ intents: [], total: 30 }, new URLSearchParams('id=x')).answer.intents.length, 0);
  assert.deepEqual(boundIntentList(null).answer.intents, [], 'an odd answer lists nothing');
});

const sha = (v) => createHash('sha256').update(v).digest('hex');
const E = 'e'.repeat(64);
const REVIEWER_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
const OTHER = 'uain1' + sha(Buffer.from(REVIEWER_KEY, 'base64url')).slice(0, 40);
const TASK = 'T-OPP-00002-1-prior-art-survey', PROJECT = 'P-OPP-00002';
const templates = JSON.parse(readFileSync(new URL('../server/survey-templates.json', import.meta.url))).templates;
const OPEN_TASKS = '/api/native/central/tasks?order=newest&state=open&limit=12&cursor=0';

/** Real BAINK server with a fictional chain. `enrolled`: the member already exists on the chain. */
async function bainkFixture(t, { enrolled = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-member-mcp-'));
  const genesis = JSON.stringify({ chain_id: 'fictional-member-mcp' }), genesisFile = join(dir, 'genesis.json'), binary = join(dir, 'reader');
  await writeFile(binary, 'synthetic pinned transport fixture', { mode: 0o700 });
  await writeFile(genesisFile, genesis, { mode: 0o600 });
  const chain = { height: '20', eventCount: '1', receipt: null, member: null };
  const criteria = 'A prior-art survey that the fixed verifier accepts.';
  const records = {
    ['member/' + OTHER]: { id: OTHER, public_key: REVIEWER_KEY, sequence: '4', licence: 'active' },
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: E },
    central_earning_activation: { policy: CENTRAL_POLICY, reviewer: OTHER, height: '5', evidence_digest: E },
    central_task_count: '1', 'central_task_index/00000000000000000001': { id: TASK, project: PROJECT },
    ['central_task/' + TASK]: { id: TASK, project: PROJECT, title: 'Prior-art survey', criteria, acceptance_digest: sha(criteria), eligibility: 'hard', eligibility_digest: E, evidence_digest: E, solver_amount: '200000000', reviewer_amount: '20000000', state: 'open', pending: '', winner: '', reserved: '220000000', paid: '0' },
    ['project/' + PROJECT]: { id: PROJECT, lead: OTHER, state: 'active', safety_halted: false },
    ['central_project_budget/' + PROJECT]: { project: PROJECT, manager: OTHER, policy: CENTRAL_POLICY, allocation: '10000000000', lifetime_ceiling: '1000000000000000', round: 1, height: '5', evidence_digest: E, reserved: '220000000', paid: '0' },
    coin_supply: { minted: '0', reserved: '220000000', transparent: '0', shielded: '0' },
    legacy_import: null,
  };
  let address = null;
  const transport = {
    profile: null, prepare: async () => {}, close: async () => {}, readBatch: async () => { throw Error('unused'); },
    async read(selection) {
      if (selection.receipt && !chain.receipt) throw Error('no receipt yet');
      const out = { chain_id: 'fictional-member-mcp', height: chain.height, header_time: new Date().toISOString(), app_hash: 'c'.repeat(64), event_count: chain.eventCount, records: {} };
      if (address) records['member/' + address] = chain.member ? structuredClone(chain.member) : null;
      for (const k of [...(selection.keys ?? []), 'guardians', 'legacy_import', 'event_count']) out.records[k] = structuredClone(records[k] ?? null);
      // Like the pinned reader, a receipt read also carries the member record.
      if (selection.member || selection.receipt) out.member = (selection.member ?? address) === address && chain.member ? structuredClone(chain.member) : null;
      if (selection.receipt) out.receipt = chain.receipt;
      out.queries = Object.keys(out.records).map((k) => ({ key: Buffer.from(k).toString('base64') }));
      return Buffer.from(JSON.stringify(out));
    },
  };
  const sent = [];
  const rpc = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const tx = Buffer.from(JSON.parse(body).params.tx, 'base64');
    sent.push(JSON.parse(tx.toString('utf8')));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: { code: 0, hash: sha(tx).toUpperCase() } }));
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const free = createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  const nativeConfig = { binary, binaryHash: sha('synthetic pinned transport fixture'), genesis: genesisFile, genesisHash: sha(genesis), chainId: 'fictional-member-mcp', rpc: `http://127.0.0.1:${rpc.address().port}`, timeoutMs: 3000, maxAgeSeconds: 120 };
  transport.profile = { chainId: nativeConfig.chainId, genesisSha256: nativeConfig.genesisHash, verifierSha256: nativeConfig.binaryHash, maxAgeSeconds: 120 };
  const url = `http://127.0.0.1:${port}`;
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, nativeConfig, nativeStateTransport: transport, centralEarningEnabled: true, nativeEnrolEnabled: true });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections?.(); await app.close(); await new Promise((r) => rpc.close(r)); await rm(dir, { recursive: true, force: true }); });

  const seen = [];
  /** One MCP tools/call, exactly as a remote client sends it. Every reply is kept for the key scan. */
  async function tool(name, args) {
    const response = await fetch(url + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const text = await response.text();
    seen.push(text);
    const body = JSON.parse(text);
    if (body.error) return { rpcError: body.error, status: response.status };
    return { ...body.result.structuredContent, isError: body.result.isError };
  }
  function event(operation, subject, member) {
    const envelope = sent.at(-1);
    const bytes = operation === 'enrol' ? Buffer.from(nativeEnrolSigningBytes(envelope.command)) : centralEarningSigningBytes(envelope.command);
    const id = String(Number(chain.eventCount) + 1);
    const ev = { id, height: String(Number(chain.height) + 1), member, operation, subject, command_digest: sha(bytes) };
    chain.height = String(Number(chain.height) + 2);
    chain.eventCount = id;
    records['event/' + id.padStart(20, '0')] = ev;
    chain.receipt = { authority: 'native', finalized: true, chain_id: 'fictional-member-mcp', state_height: chain.height, app_hash: 'c'.repeat(64), event: ev };
    return { ...envelope, height: ev.height };
  }
  return {
    url, sent, tool, seen, chain, records,
    use(me) { address = me.address; if (enrolled) chain.member = { id: me.address, public_key: me.publicKeyUrl, sequence: '2', licence: 'active' }; },
    finalizeEnrol(me, licence = 'pending') {
      event('enrol', me.address, me.address);
      chain.member = { id: me.address, public_key: me.publicKeyUrl, sequence: '1', licence };
    },
    finalizeCentral(operation, subject, me) {
      const envelope = event(operation, subject, me.address);
      chain.member.sequence = String(Number(chain.member.sequence) + 1);
      if (operation === 'project_join') records[`participation/${PROJECT}/${me.address}/`] = { project: PROJECT, member: me.address };
      else { records['central_submission/' + subject] = { ...envelope.command.payload, author: me.address, state: 'under_review', height: envelope.height }; Object.assign(records['central_task/' + TASK], { state: 'under_review', pending: subject }); }
    },
  };
}

const SIGNER_TEXT = readFileSync(new URL('../shared/uain_signer.py', import.meta.url), 'utf8');
/** The member's AI: gets the signer from the MCP, checks it, and signs in its own sandbox. */
async function memberAi(t, f) {
  const signer = await f.tool('baink_signer', {});
  assert.equal(signer.isError, false);
  assert.equal(signer.sha256, sha(signer.text), 'the published checksum matches the text served');
  assert.equal(signer.text, SIGNER_TEXT);
  const py = signerSandbox(t, signer.text);
  const send = (key, method, path, body, options = {}) => f.tool('baink_member_request', py('sign_request', key, method, path, ...(body === undefined ? [] : [body]), kw({ audience: f.url, ...options })));
  return { py, send, signer };
}
const noKeyIn = (f, key) => {
  const hex = Buffer.from(key, 'base64url').toString('hex'), std = Buffer.from(key, 'base64url').toString('base64');
  for (const text of f.seen) for (const form of [key, hex, std.replace(/=+$/, '')]) assert.ok(!text.includes(form), 'a reply contains key material');
};

test('a first-time member goes from no key to a submission under review through the MCP only', async (t) => {
  const f = await bainkFixture(t);
  const ai = await memberAi(t, f);
  const me = ai.py('new_key');
  assert.match(me.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(me.address, 'uain1' + sha(Buffer.from(me.publicKey, 'base64')).slice(0, 40));
  f.use(me);
  const key = me.privateKey;

  // No profile yet: the reply says to create one.
  const missing = await ai.send(key, 'GET', '/api/account');
  assert.equal(missing.isError, true);
  assert.equal(missing.error.code, 'account_missing');
  assert.match(missing.nextStep.sign, /POST", "\/api\/account"/);
  const account = await ai.send(key, 'POST', '/api/account', { displayName: 'Sandbox agent' });
  assert.equal(account.isError, false, JSON.stringify(account));
  assert.equal(account.answer.account.address, me.address);
  assert.match(account.nextStep.sign, /\/api\/native\/enrol\/prepare/);

  // Reading the public network details needs no signature.
  const config = (await f.tool('baink_member_request', { method: 'GET', path: '/api/config' })).answer;
  assert.equal(config.nativeRegistration.enrol.chainId, 'fictional-member-mcp');

  // Enrol with a stable request id: preparing twice gives the same step.
  const details = { name: 'Sandbox agent', operator: 'Independent', family: '' };
  const clientRequestId = ai.py('enrol_request_id', me.address, details.name, details.operator);
  const prepared = await ai.send(key, 'POST', '/api/native/enrol/prepare', { clientRequestId, ...details });
  assert.equal(prepared.isError, false, JSON.stringify(prepared));
  assert.equal(prepared.answer.intent.status, 'prepared');
  assert.match(prepared.nextStep.do, /sign_prepared/);
  const again = await ai.send(key, 'POST', '/api/native/enrol/prepare', { clientRequestId, ...details });
  assert.equal(again.answer.intent.id, prepared.answer.intent.id, 'the same request id is the same enrolment');
  const conflict = await ai.send(key, 'POST', '/api/native/enrol/prepare', { clientRequestId, ...details, name: 'Other name' });
  assert.equal(conflict.error.code, 'enrol_idempotency_conflict');
  assert.match(conflict.nextStep.do, /enrol_request_id/);
  const intent = again.answer.intent;
  const envelope = ai.py('sign_prepared', key, intent, 'enrol', details, config);
  const submitted = await ai.send(key, 'POST', `/api/native/enrol/${intent.id}/submit`, { envelope });
  assert.equal(submitted.isError, false, JSON.stringify(submitted));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].command.operation, 'enrol');
  assert.match(submitted.nextStep.sign, new RegExp(`/api/native/enrol/${intent.id}/receipt`));
  // A second enrolment with other names while this one waits is refused with a next step.
  const second = await ai.send(key, 'POST', '/api/native/enrol/prepare', { clientRequestId: ai.py('enrol_request_id', me.address, 'Other', 'Independent'), name: 'Other', operator: 'Independent', family: '' });
  assert.equal(second.error.code, 'enrol_intent_pending');
  assert.match(second.nextStep.sign, /"GET", "\/api\/native\/enrol"/);
  const notYet = await ai.send(key, 'POST', `/api/native/enrol/${intent.id}/receipt`, {});
  assert.notEqual(notYet.answer.intent.status, 'finalized');
  assert.match(notYet.nextStep.do, /never send the step again/);
  f.finalizeEnrol(me, 'pending');
  const receipt = await ai.send(key, 'POST', `/api/native/enrol/${intent.id}/receipt`, {});
  assert.equal(receipt.answer.intent.status, 'finalized', JSON.stringify(receipt));
  assert.equal(receipt.answer.intent.activation.licence, 'pending');

  // Licence still pending: joining is refused with a plain next step.
  const pending = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'project_join', payload: { project: PROJECT } });
  assert.equal(pending.isError, true);
  assert.equal(pending.error.code, 'central_licence_inactive');
  assert.match(pending.nextStep.do, /not active yet.*Wait two minutes/);
  f.chain.member.licence = 'active';

  // Find a task and what it asks for.
  const tasks = await ai.send(key, 'GET', OPEN_TASKS);
  assert.equal(tasks.isError, false, JSON.stringify(tasks));
  assert.deepEqual(tasks.answer.tasks.map((x) => x.id), [TASK]);
  const template = (await ai.send(key, 'GET', `/api/native/central/survey-template/${TASK}`)).answer;
  assert.equal(template.mainKpi, templates[TASK].mainKpi);

  // Join.
  const join = { project: PROJECT };
  const joinPrep = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'project_join', payload: join });
  assert.equal(joinPrep.answer.intent.status, 'prepared', JSON.stringify(joinPrep));
  const joinSent = await ai.send(key, 'POST', `/api/native/central/intents/${joinPrep.answer.intent.id}/submit`, { envelope: ai.py('sign_prepared', key, joinPrep.answer.intent, 'project_join', join, config) });
  assert.equal(joinSent.isError, false, JSON.stringify(joinSent));
  f.finalizeCentral('project_join', PROJECT, me);
  const joined = await ai.send(key, 'POST', `/api/native/central/intents/${joinPrep.answer.intent.id}/reconcile`, {});
  assert.equal(joined.answer.intent.status, 'finalized', JSON.stringify(joined));

  // Submit a survey with a stable submission id.
  const items = [
    ...template.required.map((r) => ({ kind: r.kind, id: r.id, title: r.title || 'Required record', relation: 'screened_out', note: 'Does not bear on the Main KPI.' })),
    ...[1, 2, 3, 4].flatMap((n) => [
      { kind: 'doi', id: `10.1000/fiction.${n}`, title: `Fictional record number ${n}`, relation: 'partial', note: 'Covers part of the KPI, not the scale.' },
      { kind: 'arxiv', id: `2501.0000${n}`, title: `Fictional preprint number ${n}`, relation: 'adjacent', note: 'Related method that leaves the KPI open.' },
    ]),
  ];
  const survey = ai.py('survey', template, '2026-11-11', items, false, ['Nothing yet reaches the Main KPI at scale.']);
  const id = ai.py('submission_id', me.address, TASK, survey);
  assert.equal(id, ai.py('submission_id', me.address, TASK, survey), 'the same draft keeps its id');
  const evidence = ai.py('survey_evidence', TASK, id, me.address, survey);
  const payload = { id, task: TASK, evidence, evidence_digest: sha(evidence) };
  const prep = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload });
  assert.equal(prep.answer.intent.status, 'prepared', JSON.stringify(prep));
  // Preparing the same draft again returns the same step: a retry never makes a second one.
  const prepAgain = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload });
  assert.equal(prepAgain.answer.intent.id, prep.answer.intent.id);
  const sent = await ai.send(key, 'POST', `/api/native/central/intents/${prep.answer.intent.id}/submit`, { envelope: ai.py('sign_prepared', key, prep.answer.intent, 'central_submit', payload, config) });
  assert.equal(sent.isError, false, JSON.stringify(sent));
  assert.equal(f.sent.length, 3);
  // After it was sent: the same draft prepared again is the sent step (reconcile, never re-sign),
  assert.notEqual((await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload })).answer.intent.status, 'prepared');
  const resent = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload });
  assert.match(resent.nextStep.do, /never sign it again/);
  assert.throws(() => ai.py('sign_prepared', key, resent.answer.intent, 'central_submit', payload, config), /not waiting for a signature/);
  // and another draft while this one is still open is refused, naming how to settle it.
  const other = ai.py('survey', template, '2026-11-11', items, false, ['A different gap statement for a second draft.']);
  const otherId = ai.py('submission_id', me.address, TASK, other);
  const otherEvidence = ai.py('survey_evidence', TASK, otherId, me.address, other);
  const blocked = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload: { id: otherId, task: TASK, evidence: otherEvidence, evidence_digest: sha(otherEvidence) } });
  assert.equal(blocked.error.code, 'central_intent_pending', JSON.stringify(blocked));
  assert.match(blocked.nextStep.sign, /\/api\/native\/central\/intents"\)/);
  // Lost answer recovery without a journal: the intents list shows the open step to reconcile.
  const open = await ai.send(key, 'GET', '/api/native/central/intents');
  assert.ok(open.answer.intents.some((i) => i.id === prep.answer.intent.id));
  // 12 November 2026: the relay bounds the list and can read one step by id (signed with its query).
  assert.equal(open.answer.limit, RELAY_INTENT_LIMIT);
  assert.equal(open.answer.total, open.answer.intents.length, 'under the limit: everything is listed');
  assert.equal(open.answer.more, false);
  const one = await ai.send(key, 'GET', `/api/native/central/intents?id=${prep.answer.intent.id}`);
  assert.equal(one.isError, false, JSON.stringify(one));
  assert.deepEqual(one.answer.intents.map((i) => i.id), [prep.answer.intent.id]);
  assert.match(one.nextStep.sign, new RegExp(`/api/native/central/intents/${prep.answer.intent.id}/reconcile`), 'the one step leads to its reconcile');
  const newest = await ai.send(key, 'GET', '/api/native/central/intents?limit=1');
  assert.equal(newest.answer.intents[0].id, prep.answer.intent.id, 'newest first');
  assert.ok(newest.answer.total >= 2, 'the join step is older');
  assert.equal(newest.answer.more, true);
  assert.match(newest.nextStep.do, /Showing the newest 1 of your \d+ steps .*\?id=<step id>/);
  const noStep = await ai.send(key, 'GET', `/api/native/central/intents?id=${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`);
  assert.deepEqual(noStep.answer.intents, []);
  assert.match(noStep.nextStep.do, /No step of yours has that id/);
  const tooMany = await ai.send(key, 'GET', '/api/native/central/intents?limit=99');
  assert.equal(tooMany.error.code, 'invalid_query', JSON.stringify(tooMany));
  // Recovery with the signer still works on the bounded list: the waiting step is there to reconcile.
  assert.ok(stepIsListed(open, prep.answer.intent.id));
  f.finalizeCentral('central_submit', id, me);
  const done = await ai.send(key, 'POST', `/api/native/central/intents/${prep.answer.intent.id}/reconcile`, {});
  assert.equal(done.answer.intent.status, 'finalized', JSON.stringify(done));
  assert.match(done.nextStep.do, /review result/);
  // P0-2 copy gap (12 November 2026): a recorded submission leads to reading that submission, not the steps list.
  assert.match(done.nextStep.sign, new RegExp(`"GET", "/api/native/central/submissions/${id}"`));

  // History: the submission and its review state.
  const read = await ai.send(key, 'GET', `/api/native/central/submissions/${id}`);
  assert.equal(read.isError, false, JSON.stringify(read));
  assert.equal(JSON.stringify(read.answer).includes(id), true);
  const status = await ai.send(key, 'GET', '/api/native/central/status');
  assert.equal(status.isError, false, JSON.stringify(status));
  // Status leads with the contribution view (points are Karma), then the ledger facts.
  assert.ok(status.answer.contribution, JSON.stringify(status.answer).slice(0, 300));
  assert.match(status.nextStep.do, /contribution points/);
  const pub = await f.tool('baink_member_request', { method: 'GET', path: `/api/public/contribution/${me.address}` });
  assert.equal(pub.isError, false, JSON.stringify(pub));
  assert.equal(pub.answer.schema, 'uain-contribution-v1');
  assert.equal(f.sent.length, 3, 'reads send nothing');
  noKeyIn(f, key);
});

test('a returning member pastes the key and goes straight to tasks; stale and reused signatures say to sign again', async (t) => {
  const f = await bainkFixture(t, { enrolled: true });
  const ai = await memberAi(t, f);
  const me = ai.py('new_key');
  f.use(me);
  const key = me.privateKey;
  assert.equal((await ai.send(key, 'POST', '/api/account', { displayName: 'Returning agent' })).isError, false);
  // A later visit: a new sandbox with the pasted key; no profile or enrolment step.
  const later = await memberAi(t, f);
  const account = await later.send(key, 'GET', '/api/account');
  assert.equal(account.answer.account.address, me.address);
  const tasks = await later.send(key, 'GET', OPEN_TASKS);
  assert.deepEqual(tasks.answer.tasks.map((x) => x.id), [TASK]);
  const enrolled = await later.send(key, 'POST', '/api/native/enrol/prepare', { clientRequestId: later.py('enrol_request_id', me.address, 'Returning agent', 'Independent'), name: 'Returning agent', operator: 'Independent', family: '' });
  assert.equal(enrolled.error.code, 'native_member_exists');
  assert.match(enrolled.nextStep.do, /already a member/);

  const stale = await later.send(key, 'GET', '/api/native/central/status', undefined, { now_ms: Date.now() - 400_000 });
  assert.equal(stale.error.code, 'invalid_signature');
  assert.match(stale.nextStep.do, /Sign the same request again/);
  const args = later.py('sign_request', key, 'GET', '/api/native/central/status', kw({ audience: f.url }));
  assert.equal((await f.tool('baink_member_request', args)).isError, false);
  const reused = await f.tool('baink_member_request', args);
  assert.equal(reused.error.code, 'replay_detected');
  assert.match(reused.nextStep.do, /Sign the request again/);
  const tampered = await f.tool('baink_member_request', { ...later.py('sign_request', key, 'POST', '/api/account', { displayName: 'A' }, kw({ audience: f.url })), body: { displayName: 'B' } });
  assert.equal(tampered.error.code, 'invalid_signature');
  noKeyIn(f, key);
});

test('the relay refuses payments, Trade and anything off the earning path, and never takes a private key', async (t) => {
  const f = await bainkFixture(t, { enrolled: true });
  const ai = await memberAi(t, f);
  const me = ai.py('new_key');
  f.use(me);
  const key = me.privateKey;
  await ai.send(key, 'POST', '/api/account', { displayName: 'Careful agent' });
  for (const [method, path, body] of [
    ['POST', '/api/native/sends', { intent: {}, signature: 'x' }],
    ['GET', '/api/native/sends'],
    ['GET', '/api/native/payments'],
    ['POST', '/api/requests', { to: OTHER, amount: '1' }],
    ['POST', '/api/trade/offers', { title: 'x', description: 'y', price: '1' }],
    ['POST', '/api/native/receiving-key', {}],
    ['PATCH', '/api/account', { displayName: 'x' }],
    ['POST', '/api/native/central/prepare', { operation: 'central_fund_plan', payload: {} }],
    ['GET', '/api/account/../native/sends'],
    ['GET', '/admin'],
  ]) {
    const args = method === 'PATCH' || path === '/admin' ? { method, path, publicKey: 'x' } : ai.py('sign_request', key, method, path, ...(body ? [body] : []), kw({ audience: f.url }));
    const r = await f.tool('baink_member_request', args);
    assert.equal(r.isError, true, path);
    assert.ok(['not_on_this_path', 'invalid_arguments'].includes(r.error.code), path + ' ' + r.error.code);
    if (r.error.code === 'not_on_this_path') assert.match(r.error.message, /Paying, sending, payment requests and Trade need the uain-agent kit/);
    assert.ok(r.nextStep, path);
  }
  // The refused signatures were never used: the same nonce store still accepts a fresh read.
  assert.equal((await ai.send(key, 'GET', '/api/native/central/status')).isError, false);

  // A private key anywhere in the arguments is refused and never echoed.
  const signed = ai.py('sign_request', key, 'POST', '/api/account', { displayName: 'x' }, kw({ audience: f.url }));
  for (const args of [
    { ...signed, body: { displayName: key } },
    { ...signed, body: { displayName: 'my key is ' + key + ' please' } },
    { ...signed, privateKey: key },
    { ...signed, body: { displayName: 'x', seed: 'anything' } },
    { ...signed, body: { displayName: '-----BEGIN PRIVATE KEY-----' } },
    { method: 'GET', path: '/api/account', signature: key },
  ]) {
    const r = await f.tool('baink_member_request', args);
    assert.equal(r.isError, true);
    assert.equal(r.error.code, 'private_key_refused', JSON.stringify(r).slice(0, 200));
    assert.match(r.nextStep.do, /Sign the request in your sandbox/);
  }
  // The caller's own public key in the envelope is not mistaken for a private key.
  assert.equal(f.sent.length, 0);
  noKeyIn(f, key);
});

test('a chat-only client can read, and the guide says how to go on; the connection metadata is no-install', async (t) => {
  const f = await bainkFixture(t, { enrolled: true });
  const tasks = await f.tool('baink_tasks', {});
  assert.equal(tasks.isError, false);
  const chat = guideAnswer('baink', { question: 'I cannot run code, I am chat only. How do I take part?' });
  assert.equal(chat.topic, 'kit');
  assert.match(chat.answer, /cannot run code/i);
  assert.match(chat.answer, /baink_tasks/);
  for (const q of ['how do I start?', 'how do I start without installing anything?', 'do I need to install anything?']) {
    const r = guideAnswer('baink', { question: q });
    assert.match(r.answer, /sandbox/, q);
    assert.match(r.answer, /baink_signer/, q);
  }
  const front = guideAnswer('baink', {});
  assert.match(front.journey[0], /^Connect/);
  assert.ok(front.journey[0].indexOf('sandbox') < front.journey[0].indexOf('curl'), 'no install comes before the optional kit');
  const key = guideAnswer('baink', { question: 'where is my key and is it safe?' }).answer;
  assert.match(key, /visible in this chat/);
  assert.match(key, /anyone who has it can act as you/i);
  assert.match(key, /never typed into a chat or a tool call/);
  const pay = guideAnswer('baink', { question: 'do I need the kit to pay or trade?' });
  assert.match(pay.answer + (pay.alsoAnswered?.answer ?? ''), /kit/);
  const connections = await f.tool('baink_connections', {});
  assert.equal(connections.holderConnection.installationRequired, false);
  assert.ok(connections.holderConnection.modes.some((m) => m.id === 'sandbox'));
  // A client that reaches the server under another address is told the exact one to use.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(f.url + '/mcp', { method: 'POST', headers: { Host: 'other.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, async (res) => {
      let text = ''; for await (const c of res) text += c; resolve({ status: res.statusCode, body: JSON.parse(text) });
    });
    req.on('error', reject); req.end('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });
  assert.equal(wrongHost.status, 403);
  assert.match(wrongHost.body.error.message, /https:\/\/baink\.money\/mcp exactly.*baink_guide/);
});

test('a full 16,384-byte evidence fits through the relay; other MCP calls keep the 16 KiB limit', async (t) => {
  const f = await bainkFixture(t, { enrolled: true });
  const ai = await memberAi(t, f);
  const me = ai.py('new_key');
  f.use(me);
  const key = me.privateKey;
  await ai.send(key, 'POST', '/api/account', { displayName: 'Long evidence agent' });
  const join = { project: PROJECT };
  const config = (await f.tool('baink_member_request', { method: 'GET', path: '/api/config' })).answer;
  const jp = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'project_join', payload: join });
  await ai.send(key, 'POST', `/api/native/central/intents/${jp.answer.intent.id}/submit`, { envelope: ai.py('sign_prepared', key, jp.answer.intent, 'project_join', join, config) });
  f.finalizeCentral('project_join', PROJECT, me);
  await ai.send(key, 'POST', `/api/native/central/intents/${jp.answer.intent.id}/reconcile`, {});
  // Worst case for JSON escaping: quotes and newlines double in size.
  const evidence = ('"line"\n'.repeat(2340)).padEnd(16384, 'x');
  assert.equal(Buffer.byteLength(evidence), 16384);
  const id = ai.py('submission_id', me.address, TASK, evidence);
  const payload = { id, task: TASK, evidence, evidence_digest: sha(evidence) };
  const prep = await ai.send(key, 'POST', '/api/native/central/prepare', { operation: 'central_submit', payload });
  assert.equal(prep.isError, false, JSON.stringify(prep).slice(0, 300));
  const sent = await ai.send(key, 'POST', `/api/native/central/intents/${prep.answer.intent.id}/submit`, { envelope: ai.py('sign_prepared', key, prep.answer.intent, 'central_submit', payload, config) });
  assert.equal(sent.isError, false, JSON.stringify(sent).slice(0, 300));
  assert.equal(f.sent.at(-1).command.payload.evidence, evidence);
  const big = await f.tool('baink_guide', { question: 'x'.repeat(17000) });
  assert.equal(big.status, 413);
  noKeyIn(f, key);
});

test('the signer is served at a stable public address with its checksum', async (t) => {
  const f = await bainkFixture(t, { enrolled: true });
  const text = await (await fetch(f.url + '/uain_signer.py')).text();
  assert.equal(text, SIGNER_TEXT);
  assert.equal(await (await fetch(f.url + '/uain_signer.py.sha256')).text(), `${sha(SIGNER_TEXT)}  uain_signer.py\n`);
  const front = await f.tool('baink_guide', {});
  assert.equal(front.signer.sha256, sha(SIGNER_TEXT));
  // The docs that print the checksum are kept in step with the file.
  for (const doc of ['../docs/mcp.md', '../../../public/llms.txt', '../public/llms.txt']) assert.match(readFileSync(new URL(doc, import.meta.url), 'utf8'), new RegExp(sha(SIGNER_TEXT)), doc);
});
