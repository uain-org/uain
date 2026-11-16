// uain-agent against the real BAINK server code, started in-process with a temp
// data dir and a fictional native state transport. Nothing here reaches baink.money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, stat, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBainkServer } from '../server/app.mjs';
import { centralEarningSigningBytes, CENTRAL_POLICY } from '../server/central-earning-command.mjs';
import { importIdentity } from '../web/identity.js';
import { signCentralEarningIntent } from '../web/central-earning.js';
import { signNativeEnrolIntent, nativeEnrolSigningBytes } from '../web/native-enrol.js';
import * as web from '../web/survey-draft.js';
import * as kit from './uain-agent.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const E = 'e'.repeat(64);
// A fictional appointed checker with a well-formed native member record.
const REVIEWER_KEY = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
const OTHER = 'uain1' + sha(Buffer.from(REVIEWER_KEY, 'base64url')).slice(0, 40);
const TASK = 'T-OPP-00002-1-prior-art-survey', PROJECT = 'P-OPP-00002';
const templates = JSON.parse(readFileSync(new URL('../server/survey-templates.json', import.meta.url))).templates;

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A filled survey for a published template: every required id kept, eight included items. */
function filledSurvey(template) {
  const extra = [1, 2, 3, 4].flatMap((n) => [
    `item: doi | 10.1000/fiction.${n} | Fictional record number ${n} | partial | Covers part of the KPI, not the scale.`,
    `item: arxiv | 2501.0000${n} | Fictional preprint number ${n} | adjacent | Related method that leaves the KPI open.`,
  ]);
  return web.surveyTemplateText(template, '2026-11-06').replace('gap:', extra.join('\n') + '\ngap:');
}

test('init writes a 0600 key in a 0700 folder, never prints it, and the file is a BAINK web backup', async (t) => {
  const o = { home: await home(t), as: 'alpha' };
  const created = await kit.initIdentity(o);
  assert.equal(created.created, true);
  const text = await readFile(created.file, 'utf8');
  const { private_key } = JSON.parse(text);
  assert.ok(!JSON.stringify(created).includes(private_key));
  assert.equal((await stat(created.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(o.home, 'alpha'))).mode & 0o777, 0o700);
  assert.equal((await kit.initIdentity(o)).created, false, 'an existing key is never replaced');
  assert.equal((await importIdentity(text)).address, created.address);
  await chmod(created.file, 0o644);
  await assert.rejects(kit.loadIdentity(o), (e) => e.code === 'identity_permissions');
});

test('survey conversion and template text match web/survey-draft.js byte for byte', () => {
  for (const id of Object.keys(templates).slice(0, 12)) {
    const template = templates[id];
    if (template.required.some((r) => !r.title)) continue;
    assert.equal(kit.surveyTemplateText(template, '2026-11-06'), web.surveyTemplateText(template, '2026-11-06'));
    const draft = filledSurvey(template);
    const mine = kit.parseSurveyDraft(draft, template), theirs = web.parseSurveyDraft(draft, template);
    assert.deepEqual(mine, theirs);
    assert.ok(mine.survey, JSON.stringify(mine.errors));
    const args = { taskId: id, submissionId: 'CS-fixture', author: OTHER, survey: mine.survey };
    assert.equal(kit.surveyEvidence(args), web.surveyEvidence(args));
    for (const broken of [draft.replace('meetsMainKpi: no', ''), draft.replace(/item: doi \| 10\.1000\/fiction\.1.*\n/, 'item: doi | x\n'), 'asOf: soon'])
      assert.deepEqual(kit.parseSurveyDraft(broken, template), web.parseSurveyDraft(broken, template));
  }
});

test('local signatures equal the BAINK web signer (central_submit, project_join, enrol) and the server bytes', async (t) => {
  const o = { home: await home(t) };
  await kit.initIdentity(o);
  const me = await kit.loadIdentity(o);
  const webIdentity = await importIdentity(await readFile(me.summary.file, 'utf8'));
  const pins = { chainId: 'fictional-central', genesisSha256: 'a'.repeat(64) };
  const proof = { authority: 'native', chainId: pins.chainId, epoch: pins.genesisSha256, genesisSha256: pins.genesisSha256, verifierSha256: 'b'.repeat(64), appHash: 'c'.repeat(64), headerTime: new Date().toISOString(), height: '20', maxAgeSeconds: 120 };
  const evidence = '42 <α> & reproducible line';
  for (const [operation, payload] of [
    ['central_submit', { id: 'CS-one', task: 'CT-one', evidence, evidence_digest: sha(evidence) }],
    ['project_join', { project: 'P-one' }],
  ]) {
    const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence: '2', expires_height: '120', operation, payload };
    const bytes = centralEarningSigningBytes(command);
    assert.deepEqual(Buffer.from(kit.commandBytes(command)), bytes);
    const intent = { id: 'fixture', member: me.address, status: 'prepared', publicKey: me.summary.publicKey, command, signingBytesBase64: bytes.toString('base64'), commandDigest: sha(bytes), proof };
    const mine = await kit.signPrepared(me, intent, { operation, payload, pins });
    const theirs = await signCentralEarningIntent(webIdentity, intent, { ...pins, expectedOperation: operation, expectedPayload: payload });
    assert.deepEqual(mine, theirs);
    await assert.rejects(kit.signPrepared(me, intent, { operation, payload: { ...payload, x: 1 }, pins }));
    await assert.rejects(kit.signPrepared(me, { ...intent, proof: { ...proof, headerTime: new Date(Date.now() - 200_000).toISOString() } }, { operation, payload, pins }));
  }
  const payload = { name: 'Fixture agent', operator: 'Fictional operator', family: '' };
  const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence: '0', expires_height: '120', operation: 'enrol', payload };
  const bytes = nativeEnrolSigningBytes(command);
  assert.deepEqual(kit.commandBytes(command), bytes);
  const intent = { id: 'enrol', status: 'prepared', publicKey: me.summary.publicKey, command, signingBytesBase64: Buffer.from(bytes).toString('base64'), proof };
  assert.deepEqual(
    await kit.signPrepared(me, intent, { operation: 'enrol', payload, pins }),
    await signNativeEnrolIntent(webIdentity, intent, { ...pins, expectedPayload: payload }),
  );
});

/** Real createBainkServer; the native chain is a fictional in-memory state behind the pinned transport seam. */
async function bainkFixture(t, address, publicKey) {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-baink-'));
  const genesis = JSON.stringify({ chain_id: 'fictional-agent-kit' }), genesisFile = join(dir, 'genesis.json'), binary = join(dir, 'reader');
  await writeFile(binary, 'synthetic pinned transport fixture', { mode: 0o700 });
  await writeFile(genesisFile, genesis, { mode: 0o600 });
  const member = { id: address, public_key: publicKey, sequence: '2', licence: 'active' };
  const chain = { height: '20', eventCount: '1', receipt: null };
  const criteria = 'A prior-art survey that the fixed verifier accepts.';
  const records = {
    ['member/' + OTHER]: { id: OTHER, public_key: REVIEWER_KEY, sequence: '4', licence: 'active' }, ['member/' + address]: member,
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: E },
    central_earning_activation: { policy: CENTRAL_POLICY, reviewer: OTHER, height: '5', evidence_digest: E },
    central_task_count: '1', 'central_task_index/00000000000000000001': { id: TASK, project: PROJECT },
    ['central_task/' + TASK]: { id: TASK, project: PROJECT, title: 'Prior-art survey', criteria, acceptance_digest: sha(criteria), eligibility: 'hard', eligibility_digest: E, evidence_digest: E, solver_amount: '200000000', reviewer_amount: '20000000', state: 'open', pending: '', winner: '', reserved: '220000000', paid: '0' },
    ['project/' + PROJECT]: { id: PROJECT, lead: OTHER, state: 'active', safety_halted: false },
    ['central_project_budget/' + PROJECT]: { project: PROJECT, manager: OTHER, policy: CENTRAL_POLICY, allocation: '10000000000', lifetime_ceiling: '1000000000000000', round: 1, height: '5', evidence_digest: E, reserved: '220000000', paid: '0' },
    coin_supply: { minted: '0', reserved: '220000000', transparent: '0', shielded: '0' },
  };
  const transport = {
    profile: null, prepare: async () => {}, close: async () => {}, readBatch: async () => { throw Error('unused'); },
    async read(selection) {
      if (selection.receipt && !chain.receipt) throw Error('no receipt yet');
      const out = { chain_id: 'fictional-agent-kit', height: chain.height, header_time: new Date().toISOString(), app_hash: 'c'.repeat(64), event_count: chain.eventCount, records: {} };
      // Like the pinned reader, every snapshot also carries its anchor records.
      for (const k of [...(selection.keys ?? []), 'guardians', 'legacy_import', 'event_count']) out.records[k] = structuredClone(records[k] ?? null);
      if (selection.member) out.member = selection.member === address ? structuredClone(member) : null;
      if (selection.receipt) out.receipt = chain.receipt;
      // The batched central reader selects proven keys by their query entries.
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
    res.end(JSON.stringify({ result: { code: chain.code ?? 0, hash: sha(tx).toUpperCase() } }));
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const free = createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  const nativeConfig = { binary, binaryHash: sha('synthetic pinned transport fixture'), genesis: genesisFile, genesisHash: sha(genesis), chainId: 'fictional-agent-kit', rpc: `http://127.0.0.1:${rpc.address().port}`, timeoutMs: 3000, maxAgeSeconds: 120 };
  transport.profile = { chainId: nativeConfig.chainId, genesisSha256: nativeConfig.genesisHash, verifierSha256: nativeConfig.binaryHash, maxAgeSeconds: 120 };
  const url = `http://127.0.0.1:${port}`;
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, nativeConfig, nativeStateTransport: transport, centralEarningEnabled: true });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections?.(); await app.close(); await new Promise((r) => rpc.close(r)); await rm(dir, { recursive: true, force: true }); });
  /** The network records a sent step: the next reconcile finds its exact event. */
  function finalize(intentId, operation, subject) {
    const envelope = sent.at(-1);
    const bytes = centralEarningSigningBytes(envelope.command);
    const id = String(Number(chain.eventCount) + 1);
    const event = { id, height: String(Number(chain.height) + 1), member: address, operation, subject, command_digest: sha(bytes) };
    member.sequence = String(Number(member.sequence) + 1);
    chain.height = String(Number(chain.height) + 2);
    chain.eventCount = id;
    records['event/' + id.padStart(20, '0')] = event;
    chain.receipt = { authority: 'native', finalized: true, chain_id: 'fictional-agent-kit', state_height: chain.height, app_hash: 'c'.repeat(64), event };
    if (operation === 'project_join') records[`participation/${PROJECT}/${address}/`] = { project: PROJECT, member: address };
    else {records['central_submission/' + subject] = { ...envelope.command.payload, author: address, state: 'under_review', height: event.height };Object.assign(records['central_task/'+TASK],{state:'under_review',pending:subject});}
  }
  return { url, sent, finalize, chain, member };
}

test('end to end on the real server: signed account, tasks, template, join, survey submit, lost answer never re-sent', async (t) => {
  const o = { home: await home(t) };
  await kit.initIdentity(o);
  const me = await kit.loadIdentity(o);
  const f = await bainkFixture(t, me.address, me.summary.publicKey);
  o.url = f.url;

  // Signed requests accepted by the real server code.
  const created = await kit.ops.account(o, { name: 'Fixture agent' });
  assert.equal(created.account.address, me.address);
  assert.equal((await kit.ops.account(o)).account.displayName, 'Fixture agent');

  const { tasks } = await kit.ops.tasks(o);
  assert.deepEqual(tasks.map((x) => [x.id, x.project, x.rewardAI$, x.survey]), [[TASK, PROJECT, '200', true]]);
  // Advisory difficulty from the real server: a "hard" survey without a published policy is standard, never starter.
  assert.deepEqual(tasks.map((x) => [x.level, x.difficulty.schema]), [['standard', 'baink-task-difficulty-v1']]);
  assert.ok(tasks[0].minutes.min > 0 && tasks[0].minutes.max >= tasks[0].minutes.min);
  assert.deepEqual((await kit.ops.tasks(o, { level: 'starter' })).tasks, []);
  assert.deepEqual((await kit.ops.tasks(o, { level: 'standard' })).tasks.map((x) => x.id), [TASK]);
  await assert.rejects(kit.ops.tasks(o, { level: 'easy' }), (e) => e.code === 'invalid_input');
  const listed = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'uain_agent_tasks', arguments: { level: 'starter' } } })).result;
  assert.ok(!listed.isError);
  assert.deepEqual(JSON.parse(listed.content[0].text).tasks, []);
  const { text } = await kit.ops.template(o, { task: TASK });
  // The exact amount the task holds comes first as a comment (the parser skips it), then the same template as the web.
  assert.equal(text, '# If the reviewer accepts it, this task gives 200 contribution points (Karma) and records 200 AI$; the amount was fixed when the task opened.\n' + web.surveyTemplateText(templates[TASK]));
  // "What next" points a member with no project at the open task, reading only.
  const before = f.sent.length, first = await kit.ops.next(o);
  assert.equal(first.stage, 'choose_task', JSON.stringify(first));
  assert.equal(first.task.id, TASK);
  assert.equal(first.next.tool, 'uain_agent_template');
  assert.equal(f.sent.length, before);

  const joined = await kit.ops.join(o, { project: PROJECT });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].command.operation, 'project_join');
  f.finalize(joined.intent.id, 'project_join', PROJECT);
  assert.equal((await kit.ops.reconcile(o, { intent: joined.intent.id })).intent.status, 'finalized');

  // The answer to the submit is lost after BAINK has sent it.
  let prepares = 0;
  o.fetch = async (url, init) => {
    if (url.endsWith('/api/native/central/prepare')) prepares++;
    const response = await fetch(url, init);
    if (/\/submit$/.test(url)) throw new TypeError('socket hang up');
    return response;
  };
  const survey = filledSurvey(templates[TASK]);
  await assert.rejects(kit.ops.submit(o, { task: TASK, survey }), (e) => e.code === 'outcome_unknown' && /reconcile/.test(e.message));
  assert.equal(f.sent.length, 2);
  const journal = JSON.parse(await readFile(join(o.home, 'default', 'journal.json'), 'utf8'));
  const step = Object.values(journal.steps).find((s) => s.operation === 'central_submit');
  assert.equal(step.status, 'unknown');
  assert.equal((await stat(join(o.home, 'default', 'journal.json'))).mode & 0o777, 0o600);

  // Trying again refuses locally: nothing is prepared, signed or sent.
  await assert.rejects(kit.ops.submit(o, { task: TASK, survey }), (e) => e.code === 'step_outstanding');
  assert.equal(prepares, 1);
  assert.equal(f.sent.length, 2);
  assert.deepEqual((await kit.ops.status(o)).openSteps.map((s) => s.intent), [step.intent]);

  // The submitted evidence is the canonical artifact naming this submission and author.
  const payload = f.sent[1].command.payload;
  assert.equal(payload.evidence, web.surveyEvidence({ taskId: TASK, submissionId: payload.id, author: me.address, survey: web.parseSurveyDraft(survey, templates[TASK]).survey }));

  delete o.fetch;
  f.finalize(step.intent, 'central_submit', payload.id);
  // next settles a step still in flight by reading its record (it never re-sends).
  const sentBefore = f.sent.length;
  assert.notEqual((await kit.ops.next(o)).stage, 'step_unsettled');
  assert.equal(f.sent.length, sentBefore, 'next sends nothing');
  assert.deepEqual((await kit.ops.status(o)).openSteps, []);
  assert.equal((await kit.ops.reconcile(o, { intent: step.intent })).intent.status, 'finalized');
  const status = await kit.ops.status(o);
  assert.deepEqual(status.openSteps, []);
  assert.equal(status.licence, 'active', JSON.stringify(status));

  // History reads every step back with its review outcome; next waits for the review.
  const history = await kit.ops.history(o);
  assert.deepEqual(history.steps.filter((s) => s.operation === 'project_join').map((s) => [s.project, s.status]), [[PROJECT, 'finalized']]);
  const mine = history.steps.find((s) => s.operation === 'central_submit' && s.status === 'finalized');
  assert.equal(mine.task, TASK);
  assert.equal(mine.submission, payload.id);
  assert.match(mine.review, /waiting for the reviewer \(usually 2 to 10 minutes; up to an hour/);
  assert.ok(Array.isArray(history.payments), JSON.stringify(history));
  assert.equal(history.earnedAI$, '0');
  const after = await kit.ops.next(o);
  assert.equal(after.stage, 'no_open_task', JSON.stringify(after));
  assert.deepEqual(after.waitingForReview, [TASK]);
  assert.equal(after.next.tool, 'uain_agent_next', 'a finished agent is told to come back, not to stop');
  assert.match(after.next.why, /Keep the session running/);
  assert.equal(f.sent.length, 2, 'history and next sign and send nothing');
});

test('MCP lists the tools and every write tool refuses without confirm: true, sending nothing', async (t) => {
  let calls = 0;
  const o = { home: await home(t), url: 'http://127.0.0.1:9', fetch: async () => { calls++; throw Error('no network in this test'); } };
  const init = await kit.handleMcp(o, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const { tools } = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result;
  const writes = tools.filter((x) => !x.annotations.readOnlyHint).map((x) => x.name);
  assert.deepEqual(writes.sort(), ['uain_agent_account', 'uain_agent_backup', 'uain_agent_cancel_payment', 'uain_agent_enrol', 'uain_agent_init', 'uain_agent_join', 'uain_agent_pay', 'uain_agent_payment_received', 'uain_agent_reassess', 'uain_agent_receiving_address', 'uain_agent_restore', 'uain_agent_revise', 'uain_agent_submit', 'uain_agent_trade_act']);
  for (const name of writes) {
    const r = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: { task: TASK, project: PROJECT, survey: 'x', name: 'A', operator: 'B' } } })).result;
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.content[0].text).error, 'confirmation_required');
  }
  assert.equal(calls, 0);
  // The plain-language reads exist, every tool explains itself, and "next" works before any key exists.
  for (const name of ['uain_agent_next', 'uain_agent_history', 'uain_agent_status']) assert.ok(tools.some((x) => x.name === name && x.annotations.readOnlyHint), name);
  for (const x of tools) {
    assert.ok(x.description.length > 40, x.name);
    for (const [k, v] of Object.entries(x.inputSchema.properties)) assert.ok(v.description, `${x.name}.${k} has a description`);
  }
  assert.match(init.result.instructions, /uain_agent_next/);
  const fresh = JSON.parse((await kit.handleMcp(o, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'uain_agent_next', arguments: {} } })).result.content[0].text);
  assert.equal(fresh.stage, 'no_key');
  assert.equal(fresh.next.tool, 'uain_agent_init');
  const missing = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'uain_agent_history', arguments: {} } })).result;
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content[0].text).error, 'identity_missing');
  assert.match(JSON.parse(missing.content[0].text).next, /uain_agent_init/);
  assert.equal(calls, 1, 'first setup asks BAINK once whether this kit is still accepted; with no answer it goes on');
  const made = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'uain_agent_init', arguments: { confirm: true } } })).result;
  assert.ok(!made.isError && JSON.parse(made.content[0].text).address.startsWith('uain1'));
  // Every work reply carries the next step and the one-task line, even when the next read fails.
  const madeBody = JSON.parse(made.content[0].text);
  assert.equal(madeBody.keepWorking, kit.KEEP_WORKING);
  assert.equal(madeBody.thenNext.next.tool, 'uain_agent_next');
  assert.match(init.result.instructions, /One task, then ask/);
  assert.match(init.result.instructions, /uain\.global\/mcp/);
  assert.match(init.result.instructions, /baink\.money\/mcp/);
  assert.ok(!made.content[0].text.includes(JSON.parse(await readFile(join(o.home, 'default', 'identity.json'), 'utf8')).private_key));
  assert.equal(await kit.handleMcp(o, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('the CLI serves MCP over stdio and init prints no private key', async (t) => {
  const dir = await home(t), env = { ...process.env, UAIN_AGENT_HOME: dir, UAIN_AGENT_URL: 'http://127.0.0.1:9' };
  const cli = fileURLToPath(new URL('./uain-agent.mjs', import.meta.url));
  const printed = execFileSync(process.execPath, [cli, 'init'], { env, encoding: 'utf8' });
  const { private_key } = JSON.parse(await readFile(join(dir, 'default', 'identity.json'), 'utf8'));
  assert.ok(printed.includes('uain1') && !printed.includes(private_key));
  const child = spawn(process.execPath, [cli, 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', (d) => lines.push(...d.split('\n').filter(Boolean)));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'uain_agent_join', arguments: { project: PROJECT } } });
  for (let n = 0; lines.length < 2 && n < 200; n++) await new Promise((r) => setTimeout(r, 50));
  const [init, call] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, 'uain-agent');
  assert.equal(JSON.parse(call.result.content[0].text).error, 'confirmation_required');
  child.stdin.end();
});


test('agent task discovery excludes operator-held native-open work and all view retains hold reason',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const availability={authority:'uain-operator',available:false,reason:'task_specification_unusable'};globalThis.fetch=async()=>Response.json({tasks:[{id:'T-held',project:'P-one',state:'open',pending:'',winner:'',solver_amount:'1000000',availability}],more:false,nextCursor:'1'});assert.deepEqual((await kit.ops.tasks(o)).tasks,[]);const all=await kit.ops.tasks(o,{all:true});assert.equal(all.tasks[0].state,'open');assert.deepEqual(all.tasks[0].availability,availability);});

test('direct template request checks authenticated task availability before fetching survey data',async(t)=>{
 const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);let calls=[];
 o.fetch=async(url,init)=>{calls.push(new URL(url).pathname);assert.ok(init.headers['X-BAINK-Signature'],'availability check is authenticated');return Response.json({task:{id:TASK,state:'open',availability:{authority:'uain-operator',available:false,reason:'task_specification_unusable'}}});};
 await assert.rejects(kit.ops.template(o,{task:TASK}),e=>e.code==='central_task_specification_unusable'&&/held|hold/i.test(e.message));
 assert.deepEqual(calls,[`/api/native/central/tasks/${TASK}`],'held contract never fetches or formats template');
 calls=[];o.fetch=async(url,init)=>{const path=new URL(url).pathname;calls.push(path);if(path===`/api/native/central/tasks/${TASK}`){assert.ok(init.headers['X-BAINK-Signature']);return Response.json({task:{id:TASK,state:'open'}});}return Response.json(templates[TASK]);};
 assert.equal((await kit.ops.template(o,{task:TASK})).text,web.surveyTemplateText(templates[TASK]));
 assert.deepEqual(calls,[`/api/native/central/tasks/${TASK}`,`/api/native/central/survey-template/${TASK}`]);
 const detail={task:{id:'T-other',state:'accepted'}};calls=[];o.fetch=async(url)=>{calls.push(new URL(url).pathname);return Response.json(detail);};
 assert.deepEqual(await kit.ops.template(o,{task:'T-other'}),detail);assert.deepEqual(calls,['/api/native/central/tasks/T-other']);
});

test('history resolves explicit rejection and old acceptance by exact authenticated point reads',async t=>{
 const o={home:await home(t)},created=await kit.initIdentity(o),me=await kit.loadIdentity(o);let outcome='rejected',detailCalls=0;
 o.fetch=async(url,init)=>{
  assert.equal(init.method,'GET');const path=new URL(url).pathname;
  if(path.endsWith('/intents'))return Response.json({intents:[{id:'history-intent',status:'finalized',command:{operation:'central_submit',payload:{id:'CS-old',task:'CT-old'}}}]});
  if(path.endsWith('/status'))return Response.json({awards:[],awardsScope:{complete:false,limit:12},earnings:{total:'0'},balanceUnits:'0'});
  if(path.endsWith('/payments'))return Response.json({intents:[]});
  if(path.endsWith('/submissions/CS-old')){detailCalls++;return Response.json({authority:'native',verified:true,member:me.address,outcome,submission:{id:'CS-old',task:'CT-old',author:me.address,state:outcome},task:{id:'CT-old',project:'P-old'},solverAward:outcome==='accepted'?{member:me.address,submission:'CS-old',task:'CT-old',project:'P-old',role:'solver',amount:'123000000'}:null,review:{status:'locator-required'},feedback:{available:false}});}
  throw Error('unexpected read');
 };
 const r=await kit.ops.history(o);assert.match(r.steps[0].review,/rejected/);assert.equal(r.steps[0].outcome,'rejected');assert.equal(r.steps[0].feedback.available,false);
 outcome='accepted';const a=await kit.ops.history(o);assert.match(a.steps[0].review,/accepted: earned 123 AI\$/);assert.equal(a.steps[0].outcome,'accepted');assert.equal(detailCalls,2);
 const single=await kit.ops.history(o,{submission:'CS-old'});assert.equal(single.submissionOutcome.outcome,'accepted');
});

test('history read deadline refuses before network and never changes write admission',async()=>{
 let calls=0;const o={fetch:async()=>{calls++;throw Error('must not read');}};
 await assert.rejects(kit.api(o,'GET','/api/native/central/status',undefined,undefined,{deadline:Date.now()-1}),e=>e.code==='read_deadline');assert.equal(calls,0);
});

test('history caps concurrent detail reads and exposes direct selection beyond its default bound',async t=>{
 const o={home:await home(t)};await kit.initIdentity(o);const me=await kit.loadIdentity(o);let active=0,peak=0,reads=0;
 o.fetch=async(url)=>{const path=new URL(url).pathname;if(path.endsWith('/intents'))return Response.json({intents:Array.from({length:105},(_,n)=>({id:'intent-'+n,status:'finalized',command:{operation:'central_submit',payload:{id:'CS-'+n,task:'CT-'+n}}}))});if(path.endsWith('/status'))return Response.json({awards:[]});if(path.endsWith('/payments'))return Response.json({intents:[]});
 if(path==='/api/public/review-queue')return Response.json({status:'unavailable',limits:{perHour:16,perDay:128}});const id=path.split('/').at(-1);reads++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;return Response.json({authority:'native',verified:true,member:me.address,outcome:'under_review',submission:{id,task:id.replace('CS-','CT-'),author:me.address,state:'under_review'},task:{id:id.replace('CS-','CT-')},solverAward:null,review:{status:'locator-required'},feedback:{available:false}});
 };
 const result=await kit.ops.history(o);assert.equal(reads,100);assert(peak<=4);assert.equal(result.submissionOutcomeScope.complete,false);assert.equal((await kit.ops.history(o,{submission:'CS-104'})).submissionOutcome.submission.id,'CS-104');assert.equal(reads,101);
});
test('chat history points members to attached committed feedback instead of claiming it is unavailable',async t=>{
 const o={home:await home(t)};await kit.initIdentity(o);const me=await kit.loadIdentity(o);let reads=0;
 const feedback={available:true,authority:'native-committed-decision',scope:'retained-review',packet:{schema:'uain-central-review-feedback-v1',decision:{findings:['Correct the treated population count.']}}};
 o.fetch=async(url,options)=>{assert.equal(options.method,'GET');reads++;const path=new URL(url).pathname;
  if(path.endsWith('/intents'))return Response.json({intents:[{id:'history-intent',status:'finalized',command:{operation:'central_submit',payload:{id:'CS-feedback',task:'CT-feedback'}}}]});
  if(path.endsWith('/status'))return Response.json({awards:[]});if(path.endsWith('/payments'))return Response.json({intents:[]});
  if(path.endsWith('/submissions/CS-feedback'))return Response.json({authority:'native',verified:true,member:me.address,outcome:'needs_evidence',submission:{id:'CS-feedback',task:'CT-feedback',author:me.address,state:'under_review'},task:{id:'CT-feedback',project:'P-one'},solverAward:null,review:{status:'proved'},feedback});throw Error('unexpected read');};
 const result=await kit.ops.history(o);assert.match(result.steps[0].review,/feedback attached/);assert.doesNotMatch(result.steps[0].review,/unavailable/);assert.deepEqual(result.steps[0].feedback.packet.decision.findings,['Correct the treated population count.']);assert.equal(reads,4);
});

test('encrypted identity backup restores across the agent kit and the web app, and init fails closed after a lost key', async (t) => {
  const webBackup = await import('../web/identity-backup.js');
  const o = { home: await home(t) }, PASS = 'fictional agent passphrase', FAST = 100000;
  const made = await kit.initIdentity(o);
  const backup = await kit.backupIdentity(o, { passphrase: PASS, iterations: FAST });
  const text = await readFile(backup.file, 'utf8');
  assert.equal((await stat(backup.file)).mode & 0o777, 0o600); assert.ok(!text.includes(JSON.parse(await readFile(made.file, 'utf8')).private_key));
  // The web app opens the agent's backup ...
  assert.equal((await importIdentity(await webBackup.decryptIdentityBackup(text, PASS))).address, made.address);
  // ... and the agent opens a web backup.
  const webText = await webBackup.encryptIdentityBackup(await readFile(made.file, 'utf8'), PASS, { iterations: FAST });
  // A journaled step, then the key file is lost.
  await writeFile(join(o.home, 'default', 'journal.json'), JSON.stringify({ version: 1, steps: { a: { sent: true } }, ids: {} }), { mode: 0o600 });
  await rm(made.file);
  await assert.rejects(kit.initIdentity(o), (e) => e.code === 'identity_restore_required');
  const next = await kit.handleMcp(o, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'uain_agent_next', arguments: {} } });
  assert.match(next.result.content[0].text, /uain_agent_restore/);
  const wrongFile = join(o.home, 'wrong-pass.txt'), passFile = join(o.home, 'pass.txt');
  await writeFile(wrongFile, 'not the right passphrase\n', { mode: 0o600 }); await writeFile(passFile, PASS + '\n', { mode: 0o600 });
  const wrong = await kit.handleMcp(o, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'uain_agent_restore', arguments: { file: backup.file, passphraseFile: wrongFile, confirm: true } } });
  assert.equal(JSON.parse(wrong.result.content[0].text).error, 'backup_passphrase_wrong');
  const webFile = join(o.home, 'web.backup.json'); await writeFile(webFile, webText, { mode: 0o600 });
  // A passphrase typed into a tool call is refused and nothing is restored (security review L3).
  const typed = await kit.handleMcp(o, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'uain_agent_restore', arguments: { file: webFile, passphrase: PASS, confirm: true } } });
  assert.equal(JSON.parse(typed.result.content[0].text).error, 'backup_passphrase_in_chat'); assert.ok(!typed.result.content[0].text.includes(PASS));
  await assert.rejects(kit.loadIdentity(o), (e) => e.code === 'identity_missing');
  const ok = await kit.handleMcp(o, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'uain_agent_restore', arguments: { file: webFile, passphraseFile: passFile, confirm: true } } });
  const restored = JSON.parse(ok.result.content[0].text);
  assert.equal(restored.address, made.address); assert.ok(!ok.result.content[0].text.includes('private_key'));
  assert.equal((await kit.loadIdentity(o)).address, made.address);
  await assert.rejects(kit.restoreIdentity(o, { file: webFile, passphrase: PASS }), (e) => e.code === 'identity_exists');
  const damaged = join(o.home, 'damaged.json'); await writeFile(damaged, text.slice(0, 150), { mode: 0o600 });
  await assert.rejects(kit.restoreIdentity({ ...o, as: 'other' }, { file: damaged, passphrase: PASS }), (e) => e.code === 'backup_corrupt');
});

test('tradeAttention names the one Trade step waiting on this member, read-only', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const me = (await kit.ops.status({ ...o, fetch: async () => new Response('{}', { status: 503 }) }).catch(() => null))?.address
    ?? JSON.parse(await readFile(join(o.home, 'default', 'identity.json'), 'utf8')).address;
  const other = 'uain1' + 'b'.repeat(40), digest = 'd'.repeat(64), sent = [];
  const deals = [
    { id: '11111111-1111-4111-8111-111111111111', status: 'proposed', seller: other, buyer: me, signed: { seller: true, buyer: false }, dealDigest: digest, title: 'Sign me', price: '3.000000', enquiryId: 'e0' },
    { id: '22222222-2222-4222-8222-222222222222', status: 'paid', seller: me, buyer: other, signed: { seller: true, buyer: true }, title: 'Deliver me', price: '2.000000', enquiryId: 'e9' },
    { id: '33333333-3333-4333-8333-333333333333', status: 'completed', seller: me, buyer: other, title: 'Done', price: '1.000000', enquiryId: 'e8' },
  ];
  const enquiry = { id: '44444444-4444-4444-8444-444444444444', offerId: '55555555-5555-4555-8555-555555555555', seller: me, buyer: other, message: 'Can you summarise this?', offer: { title: 'Summary', price: '3.000000' } };
  o.fetch = async (url, init = {}) => {
    sent.push(init.method ?? 'GET');
    const u = new URL(url), json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/trade/enquiries') return json({ enquiries: [enquiry] });
    if (u.pathname === '/api/trade/deals') return json({ deals });
    if (u.pathname === `/api/trade/deals/${deals[1].id}`) return json({ deal: { ...deals[1], milestones: [{ title: 'Final summary', status: 'pending' }] } });
    if (u.pathname === '/api/trade/public/proposals') return json({ proposals: [] });
    // Open Trade, explicitly (P0-4): paused is covered in test/trade-availability.test.mjs.
    if (u.pathname === '/api/trade/policy') return json({ availability: { mode: 'open', newBusiness: true } });
    return new Response('{}', { status: 404 });
  };
  const { mine, others } = await kit.tradeAttention(o, me);
  assert.deepEqual(mine.map((m) => m.title), ['Sign me', 'Deliver me', 'Summary']);
  assert.match(mine[0].cli, /deal_accept/); assert.match(mine[0].cli, new RegExp(digest));
  assert.match(mine[1].cli, /milestone_deliver/); assert.match(mine[1].cli, /"index":0/);
  assert.match(mine[2].cli, /terms_draft/);
  assert.deepEqual(others, []);
  assert.ok(sent.every((m) => m === 'GET'), 'tradeAttention only reads');
});

test('a transient central_proof_unavailable on a read is retried; a write is never retried', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  let reads = 0, writes = 0;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...a) => realTimeout(fn, 0, ...a); // no real backoff wait in tests
  t.after(() => { globalThis.setTimeout = realTimeout; });
  const refusal = () => new Response(JSON.stringify({ error: { code: 'central_proof_unavailable', message: 'proof unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  const { api } = kit;
  o.fetch = async () => { reads++; return reads < 2 ? refusal() : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  assert.deepEqual(await api(o, 'GET', '/api/native/central/tasks'), { ok: true });
  assert.equal(reads, 2, 'one refusal, one retry, success');
  // A retry that also fails pauses retries: the next read answers at once.
  reads = 0; o.fetch = async () => { reads++; return refusal(); };
  await assert.rejects(api(o, 'GET', '/api/native/central/tasks'), (e) => e.code === 'central_proof_unavailable');
  assert.equal(reads, 2);
  reads = 0; await assert.rejects(api(o, 'GET', '/api/native/central/tasks'), (e) => e.code === 'central_proof_unavailable');
  assert.equal(reads, 1, 'no retry while paused');
  o.fetch = async () => { writes++; return refusal(); };
  await assert.rejects(api(o, 'POST', '/api/native/central/prepare', {}), (e) => e.code === 'central_proof_unavailable');
  assert.equal(writes, 1, 'a write is sent once and never retried here');
});

test('a seller with an agreed deal and no receiving key is told to set up receiving first', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  const me = JSON.parse(await readFile(join(o.home, 'default', 'identity.json'), 'utf8')).address, buyer = 'uain1' + 'c'.repeat(40);
  const deal = { id: '66666666-6666-4666-8666-666666666666', status: 'agreed', seller: me, buyer, signed: { seller: true, buyer: true }, title: 'Summary', price: '3.000000', enquiryId: 'e1' };
  o.fetch = async (url) => {
    const u = new URL(url), json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/trade/enquiries') return json({ enquiries: [] });
    if (u.pathname === '/api/trade/deals') return json({ deals: [deal] });
    if (u.pathname === `/api/trade/deals/${deal.id}`) return json({ deal: { ...deal, payment: { request: { id: 'r1', status: 'open' } } } });
    if (u.pathname === `/api/native/receiving-address/${me}`) return json({ address: null });
    return new Response('{}', { status: 404 });
  };
  const { mine, others } = await kit.tradeAttention(o, me);
  assert.equal(mine[0].cli, 'node uain-agent.mjs receiving setup');
  assert.equal(others.length, 1, 'the payment itself waits on the buyer');
});

test('the kit notices when BAINK serves a newer kit and says how to update', async (t) => {
  const o = { home: await home(t), url: 'http://127.0.0.1:9' };
  await kit.ops.init(o);
  o.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'x-uain-agent-latest': '99.0.0' } });
  await kit.api(o, 'GET', '/api/config');
  const u = kit.kitUpdate();
  assert.equal(u.latest, '99.0.0');
  assert.match(u.how, /curl -fsSLO https:\/\/uain\.global\/uain-agent\.mjs/);
  o.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json', 'x-uain-agent-latest': '0.0.1' } });
  await kit.api(o, 'GET', '/api/config');
  assert.equal(kit.kitUpdate(), null, 'an older served kit is never offered');
});

test('tasks print claimable and why_not, list only claimable by default, and work against an older server',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const base={project:'P-one',solver_amount:'1000000',reviewer_amount:'200000',reserved:'1200000',paid:'0',pending:'',winner:'',state:'open'};
 globalThis.fetch=async()=>Response.json({tasks:[{...base,id:'T-open',claimable:true,why_not:null},{...base,id:'T-busy',state:'under_review',pending:'CS-x',claimable:false,why_not:'under_review',why_not_text:'Another member\'s submission is being checked.'}],more:false,nextCursor:'2'});
 let r=await kit.ops.tasks(o);assert.deepEqual(r.tasks.map(x=>[x.id,x.claimable]),[['T-open',true]]);assert.equal(r.claimableCount,1);assert.deepEqual(r.notClaimable,{under_review:1});
 r=await kit.ops.tasks(o,{all:true});assert.equal(r.tasks[1].why_not,'under_review');assert.match(r.tasks[1].whyNot,/being checked/);
 // An older server sends no claimable: the kit applies the same rule.
 globalThis.fetch=async()=>Response.json({tasks:[{...base,id:'T-open'},{...base,id:'T-rejected',state:'open_unfunded',reserved:'0',paid:'200000'},{...base,id:'T-won',state:'accepted',winner:'CS-1',reserved:'0'}],more:false,nextCursor:'3'});
 r=await kit.ops.tasks(o,{all:true});assert.deepEqual(r.tasks.map(x=>[x.id,x.claimable,x.why_not]),[['T-open',true,null],['T-rejected',false,'not_funded'],['T-won',false,'won']]);});

test('next names a claimable task and says why nothing can be taken when every task is being checked',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const base={project:'P-one',solver_amount:'1000000',reviewer_amount:'200000',reserved:'1200000',paid:'0',pending:'',winner:'',state:'open'};let tasks;
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p==='/api/account')return Response.json({account:{native:{memberStatus:'active'}}});if(p==='/api/native/central/status')return Response.json({licence:'active',awards:[],earnings:{total:'0'},balanceUnits:'0'});if(p.startsWith('/api/trade'))return Response.json({enquiries:[],deals:[]});if(p==='/api/native/central/tasks')return Response.json({tasks,more:false,nextCursor:'2'});return Response.json({});};
 tasks=[{...base,id:'T-busy',state:'under_review',pending:'CS-x',claimable:false,why_not:'under_review'},{...base,id:'T-open',claimable:true,why_not:null}];
 let r=await kit.ops.next(o);assert.equal(r.task.id,'T-open');assert.equal(r.task.claimable,true);
 tasks=[{...base,id:'T-busy',state:'under_review',pending:'CS-x',claimable:false,why_not:'under_review'}];
 r=await kit.ops.next(o);assert.equal(r.stage,'no_open_task');assert.match(r.next.why,/No paid task|being checked/);});

test('awards read every page of the award history, newest first',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const all=Array.from({length:30},(_,i)=>({position:String(30-i),submission:'CS-'+(30-i),role:'solver',amount:'1500000'}));const asked=[];
 globalThis.fetch=async(url)=>{const u=new URL(url);asked.push(u.search);const top=Number(u.searchParams.get('cursor')??30),limit=Number(u.searchParams.get('limit'));const page=all.filter(a=>Number(a.position)<=top).slice(0,limit),floor=Math.max(0,top-limit);return Response.json({awards:page,total:'30',more:floor>0,nextCursor:floor>0?String(floor):null,earnings:{total:'45000000'}});};
 let r=await kit.ops.awards(o,{limit:12});assert.equal(r.awards.length,12);assert.equal(r.complete,false);assert.equal(r.nextCursor,'18');assert.match(r.next,/--cursor 18/);assert.equal(r.awards[0].amountAI$,'1.5');
 r=await kit.ops.awards(o,{limit:12,all:true});assert.equal(r.awards.length,30);assert.equal(r.complete,true);assert.equal(r.earnedAI$,'45');assert.deepEqual(asked.slice(-3),['?limit=12','?cursor=18&limit=12','?cursor=6&limit=12']);
 await assert.rejects(kit.ops.awards(o,{cursor:'x'}),e=>e.code==='invalid_input');});

test('submit refuses a task that is not claimable before anything is signed',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const posts=[];
 globalThis.fetch=async(url,init)=>{if(init?.method==='POST')posts.push(url);return Response.json({claimable:false,why_not:'won',why_not_text:'Another member\'s submission was accepted; the reward is paid and the task is closed.'});};
 await assert.rejects(kit.ops.submit(o,{task:'T-won',evidence:'my answer'}),e=>e.code==='central_task_not_claimable'&&/won/.test(e.message)&&/Nothing was signed/.test(e.message));assert.deepEqual(posts,[]);});

test('tasks read the newest tasks first, so open work is found when old tasks are all closed',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 // 134 tasks; the oldest 120 are won, and among the newest some are being checked.
 const all=Array.from({length:134},(_,i)=>({id:'T-'+(i+1),project:'P-one',state:i<120?'accepted':i%3===0?'under_review':'open',winner:i<120?'CS':'',pending:i>=120&&i%3===0?'CS-x':'',solver_amount:'1000000',reviewer_amount:'200000',reserved:i<120?'0':'1200000',paid:'0'}));
 const open=x=>x.state==='open'&&!x.pending&&!x.winner;let asked=[],filters=true;
 globalThis.fetch=async(url)=>{const u=new URL(url),q=u.searchParams,c=Number(q.get('cursor')),l=Number(q.get('limit'));asked.push(u.search);
  if(q.has('order')&&!filters)return Response.json({error:{code:'invalid_query',message:'Use only cursor and limit.'}},{status:400});
  if(q.get('order')==='newest'){const rows=[...all].reverse().filter(x=>q.get('state')!=='open'||open(x));const page=rows.slice(c,c+l);return Response.json({tasks:page,total:'134',more:c+l<rows.length,nextCursor:String(c+l)});}
  return Response.json({tasks:all.slice(c,c+l),total:'134',more:c+l<134,nextCursor:String(c+l)});};
 let r=await kit.ops.tasks(o);assert.equal(r.tasks.length,9);assert.equal(r.tasks[0].id,'T-134');assert.ok(r.tasks.every(x=>x.claimable));assert.ok(asked.filter(a=>!a.includes('limit=1')).every(a=>a.includes('state=open')),'one filtered listing plus a public total, no scan of old tasks');
 r=await kit.ops.tasks(o,{all:true});assert.ok(asked.at(-1).includes('state=all'));assert.equal(r.tasks[0].id,'T-134');
 // An older server without the filter: newest-first scan from the end.
 filters=false;asked=[];r=await kit.ops.tasks(o);assert.equal(r.tasks.length,9);assert.equal(r.tasks[0].id,'T-134');assert.ok(!asked.some(a=>a==='?cursor=12&limit=12'),'old pages are not read');});

test('a buyer is never told to pay a request that already has a final or moving payment; the seller is told to confirm',async(t)=>{
 const o={home:await home(t),url:'http://127.0.0.1:9'};await kit.ops.init(o);
 const me=JSON.parse(await readFile(join(o.home,'default','identity.json'),'utf8')).address,other='uain1'+'b'.repeat(40),req='66666666-6666-4666-8666-666666666666',sent=[];
 const deal=(buyer,seller)=>({id:'77777777-7777-4777-8777-777777777777',status:'agreed',seller,buyer,signed:{seller:true,buyer:true},title:'Paid once',price:'3.000000',enquiryId:'e1'});
 let deals,sends;
 o.fetch=async(url,init={})=>{sent.push(init.method??'GET');const u=new URL(url),json=b=>new Response(JSON.stringify(b),{status:200,headers:{'content-type':'application/json'}});
  if(u.pathname==='/api/trade/enquiries')return json({enquiries:[]});if(u.pathname==='/api/trade/deals')return json({deals});
  if(u.pathname===`/api/trade/deals/${deals[0].id}`)return json({deal:{...deals[0],payment:{request:{id:req,status:'open'}}}});
  if(u.pathname==='/api/native/sends')return json({sends});
  if(u.pathname==='/api/requests')return json({requests:[{id:req,from:other,to:me,amount:'3.000000',status:'open'}]});
  if(u.pathname==='/api/config')return json({});
  return new Response('{}',{status:404});};
 deals=[deal(me,other)];sends=[{id:'S-1',status:'finalized',paid:false,intent:{requestId:req,from:me,to:other,amountUnits:'3000000'}}];
 let r=await kit.tradeAttention(o,me);assert.deepEqual(r.mine,[]);assert.match(r.others[0].what,/Do not pay again/);
 sends=[{...sends[0],status:'checker-refused'}];r=await kit.tradeAttention(o,me);assert.match(r.mine[0].cli,/pay --request/,'a refused attempt moved nothing, so paying is offered');
 deals=[deal(other,me)];sends=[{id:'S-2',status:'finalized',paid:false,intent:{requestId:req,from:other,to:me,amountUnits:'3000000'}}];
 r=await kit.tradeAttention(o,me);assert.match(r.mine.find(m=>m.title==='Paid once').cli,/received S-2/);
 deals=[deal(me,other)];sends=[{id:'S-1',status:'broadcasting',paid:false,intent:{requestId:req,from:me,to:other,amountUnits:'3000000'}}];
 await assert.rejects(kit.ops.pay(o,{request:req}),e=>e.code==='payment_already_sent'&&/do not pay again/i.test(e.message));
 assert.ok(sent.every(m=>m==='GET'),'nothing was signed or sent');});

test('a step BAINK proved expired-unused is settled, so next stops asking to reconcile it and the step can be retried',async(t)=>{
 const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const file=join(o.home,'default','journal.json');
 await writeFile(file,JSON.stringify({version:1,ids:{},steps:{'98248054-0000-4000-8000-000000000000':{intent:'98248054-0000-4000-8000-000000000000',kind:'central',operation:'project_join',target:'join:P-OPP-00004',status:'expired-unused',payload:{project:'P-OPP-00004'}}}}),{mode:0o600});
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p==='/api/account')return Response.json({account:{native:{memberStatus:'active'}}});if(p==='/api/native/central/status')return Response.json({licence:'active',awards:[],earnings:{total:'0'},balanceUnits:'0'});if(p.startsWith('/api/trade'))return Response.json({enquiries:[],deals:[]});if(p==='/api/native/central/tasks')return Response.json({tasks:[],total:'0',more:false});return Response.json({});};
 const r=await kit.ops.next(o);assert.notEqual(r.stage,'step_unsettled');assert.equal(r.stage,'no_open_task');});

test('a sent step prints a short summary, never the signed bytes or the evidence',()=>{
 const i={id:'9b4587ef-0000-4000-8000-000000000000',status:'finalized',signingBytesBase64:'A'.repeat(4000),envelope:{signature:'x'},command:{operation:'central_submit',payload:{id:'CS-1',task:'T-1',evidence:'long evidence '.repeat(300)}},receipt:{event:{height:'1421929'}},result:{status:'submitted',paid:false}};
 const s=kit.stepSummary(i);assert.deepEqual(s,{id:i.id,operation:'central_submit',status:'finalized',task:'T-1',submission:'CS-1',height:'1421929',result:{status:'submitted',paid:false}});
 assert.ok(JSON.stringify(s).length<300);});

test('next lists only unpaid submissions as waiting for review',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const step=(n,task)=>[n,{intent:n,kind:'central',operation:'central_submit',target:'submit:'+task,status:'finalized',payload:{id:'CS-'+n,task}}];
 await writeFile(join(o.home,'default','journal.json'),JSON.stringify({version:1,ids:{},steps:Object.fromEntries([step('a','T-paid'),step('b','T-wait')])}),{mode:0o600});
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p==='/api/account')return Response.json({account:{native:{memberStatus:'active'}}});if(p==='/api/native/central/status')return Response.json({licence:'active',awards:[{role:'solver',task:'T-paid',submission:'CS-a',amount:'60000000'}],earnings:{total:'60000000'},balanceUnits:'60000000'});if(p.startsWith('/api/trade'))return Response.json({enquiries:[],deals:[]});if(p==='/api/native/central/tasks')return Response.json({tasks:[],more:false});return Response.json({});};
 const r=await kit.ops.next(o);assert.deepEqual(r.waitingForReview,['T-wait']);assert.deepEqual(r.paid,['T-paid: paid 60 AI$']);});

test('next says the record could not be read, not "wait for admission", when BAINK cannot prove membership',async(t)=>{const o={home:await home(t),url:'https://fixture.example'};await kit.initIdentity(o);const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 await writeFile(join(o.home,'default','journal.json'),JSON.stringify({version:1,ids:{},steps:{e:{intent:'e',kind:'enrol',operation:'enrol',target:'x',status:'finalized'}}}),{mode:0o600});
 globalThis.fetch=async(url)=>{const p=new URL(url).pathname;if(p==='/api/account')return Response.json({account:{native:{memberStatus:'unknown'}}});if(p==='/api/native/central/status')return Response.json({error:{code:'central_proof_unavailable',message:'central_proof_unavailable'}},{status:503});return Response.json({});};
 const r=await kit.ops.next(o);assert.equal(r.stage,'records_unavailable');assert.match(r.next.why,/nothing changed/);});

test('a step the network refused after BAINK relayed it stays open until reconcile proves it unused (C6)', async (t) => {
  const o = { home: await home(t) };
  const me = await kit.initIdentity(o);
  const fx = await bainkFixture(t, me.address, me.publicKey);
  o.url = fx.url;
  await kit.ops.account(o, { name: 'Refused step agent' });
  // The network refuses the relayed join (CheckTx code 32). BAINK keeps counting the step against this key's sequence.
  fx.chain.code = 32;
  const refused = await kit.ops.join(o, { project: PROJECT });
  assert.equal(refused.intent.status, 'refused');
  assert.match(refused.note, /nothing was recorded/); assert.match(refused.note, /never send it again/);
  assert.equal(fx.sent.length, 1);
  let status = await kit.ops.status(o);
  assert.deepEqual(status.openSteps.map((x) => [x.operation, x.status]), [['project_join', 'refused']], 'the refused step is still open');
  // Nothing else goes out behind it, and next says so in plain words.
  await assert.rejects(kit.ops.join(o, { project: PROJECT }), (e) => e.code === 'step_outstanding');
  await assert.rejects(kit.ops.pay(o, { to: OTHER, amount: '1' }), (e) => e.code === 'step_unsettled' && /Nothing was signed/.test(e.message));
  const next = await kit.ops.next(o);
  assert.equal(next.stage, 'step_unsettled'); assert.match(next.next.why, /refused/); assert.match(next.next.why, /never send the step again/);
  assert.equal(fx.sent.length, 1, 'the refused bytes were never sent again');
  // Past the step's expiry, with the sequence unchanged and no record, BAINK proves it unused: reconcile settles it.
  fx.chain.height = '500';
  const settledNow = await kit.ops.reconcile(o, { intent: refused.intent.id });
  assert.equal(settledNow.intent.status, 'expired-unused');
  status = await kit.ops.status(o);
  assert.deepEqual(status.openSteps, []);
  // next says plainly that the earlier attempt expired unused and offers the same step again.
  const offer = await kit.ops.next(o);
  assert.equal(offer.stage, 'send_again'); assert.equal(offer.next.tool, 'uain_agent_join'); assert.deepEqual(offer.next.args, { project: PROJECT });
  assert.match(offer.next.why, /expired unused: .* safe to join again now/);
  // The member can now join again with a fresh step.
  fx.chain.code = 0;
  const again = await kit.ops.join(o, { project: PROJECT });
  assert.notEqual(again.intent.id, refused.intent.id); assert.equal(fx.sent.length, 2);
  assert.notEqual((await kit.ops.next(o)).stage, 'send_again', 'a new attempt supersedes the note');
});

test('the open paid tasks are readable with no key: GET /api/public/tasks and the BAINK MCP tool baink_tasks', async (t) => {
  const o = { home: await home(t) };
  const me = await kit.initIdentity(o);
  const fx = await bainkFixture(t, me.address, me.publicKey);
  // No signature, no account, no profile.
  const res = await fetch(fx.url + '/api/public/tasks');
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.status, 'available'); assert.equal(list.openNow, 1); assert.equal(list.more, false);
  assert.deepEqual(list.tasks.map((x) => [x.id, x.project, x.pays, x.canTakeNow, x.kind, x.take]), [[TASK, PROJECT, '200 AI$', true, 'prior-art survey', 'node uain-agent.mjs template ' + TASK]]);
  assert.match(list.howToTake, /curl -fsSLO https:\/\/baink\.money\/uain-agent\.mjs/);
  assert.doesNotMatch(JSON.stringify(list), /Docker|install a client/i);
  // Cursor pages the cached full index, never causes a separate chain scan.
  const beyond = await (await fetch(fx.url + '/api/public/tasks?cursor=12')).json(); assert.equal(beyond.totalOpen, 1); assert.equal(beyond.tasks.length, 0);
  assert.equal((await fetch(fx.url + '/api/public/tasks?limit=51')).status, 400);
  assert.notEqual((await fetch(fx.url + '/api/public/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fx.url }, body: '{}' })).status, 200);
  // The same list through the read-only MCP server, as a listed tool.
  const rpc = async (method, params = {}) => (await fetch(fx.url + '/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: fx.url, 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  const tools = (await rpc('tools/list')).result.tools;
  const tool = tools.find((x) => x.name === 'baink_tasks');
  assert.ok(tool, 'baink_tasks is listed'); assert.equal(tool.annotations.readOnlyHint, true);
  const called = (await rpc('tools/call', { name: 'baink_tasks', arguments: {} })).result;
  assert.equal(called.isError, false);
  assert.deepEqual(called.structuredContent.tasks.map((x) => x.id), [TASK]);
  // 11 November 2026 (P0-2): taking a task needs nothing installed; the next step is the sandbox signer, the kit still named.
  assert.equal(called.structuredContent.nextStep.tool, 'baink_signer');
  assert.match(called.structuredContent.nextStep.do, /node uain-agent\.mjs next/);
  // It agrees with what the kit lists for a member (the same proved page).
  await kit.ops.account({ ...o, url: fx.url }, { name: 'Public list agent' });
  assert.deepEqual((await kit.ops.tasks({ ...o, url: fx.url })).tasks.map((x) => [x.id, x.claimable]), list.tasks.map((x) => [x.id, x.canTakeNow]));
});

// 0.2.23 (16 November 2026, "Use UAIN throughout"): tools are listed as uain_agent_*; the earlier
// baink_agent_* names still answer the same way, unlisted, so agents already set up keep working.
test('MCP lists only uain_agent_* names and still answers every earlier baink_agent_* name', async (t) => {
  let calls = 0;
  const o = { home: await home(t), url: 'http://127.0.0.1:9', fetch: async () => { calls++; throw Error('no network in this test'); } };
  const { tools } = (await kit.handleMcp(o, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).result;
  assert.ok(tools.length > 20);
  assert.ok(tools.every((x) => x.name.startsWith('uain_agent_')), 'only UAIN names are listed');
  assert.equal(kit.LEGACY_PREFIX, 'baink_agent_');
  const call = async (name, args = {}) => (await kit.handleMcp(o, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).result;
  // Every listed tool has its earlier name, refused or answered exactly as the new one.
  for (const x of tools.filter((x) => !x.annotations.readOnlyHint)) {
    const old = await call(x.name.replace('uain_agent_', 'baink_agent_'));
    assert.equal(old.isError, true); assert.equal(JSON.parse(old.content[0].text).error, 'confirmation_required', x.name);
  }
  assert.equal(calls, 0, 'a write without confirm sends nothing under either name');
  const fresh = JSON.parse((await call('baink_agent_next')).content[0].text);
  assert.equal(fresh.stage, 'no_key'); assert.equal(fresh.next.tool, 'uain_agent_init');
  const made = await call('baink_agent_init', { confirm: true });
  assert.ok(!made.isError && JSON.parse(made.content[0].text).address.startsWith('uain1'), 'an earlier name still writes');
  assert.equal(JSON.parse((await call('baink_agent_nothing')).content[0].text).error, 'unknown_tool');
  assert.match(kit.MCP_INSTRUCTIONS, /uain_agent_next/); assert.match(kit.MCP_INSTRUCTIONS, /baink_agent_\* tool names still work/);
});

test('the kit is fetched from uain.global but still signs for and talks to the payment engine', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./uain-agent.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.UAIN_AGENT_URL \?\? 'https:\/\/baink\.money'/, 'backend origin, and so the signature audience, unchanged');
  assert.doesNotMatch(src, /curl -fsSLO? https:\/\/baink\.money/, 'every download line names uain.global');
  assert.doesNotMatch(src, /'baink_agent_[a-z_]+'/, 'no tool or step names an earlier tool name');
});
