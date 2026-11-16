// Trade deal layer on the pinned native daemon (real-daemon stage). Opt-in:
// UAIN_TRADE_REAL_DAEMON=1 with UAIN_TRADE_TOOLS naming a folder that holds the
// pinned `uaind`, `uain-state` (the BAINK proving reader) and `uain-coin-wallet`,
// plus optionally `uain-private-state` and `uain-note-source` (recipient note check).
// Run by services/project-organizations/ops/qualify-native-trade.sh inside a
// --network none container on the test host.
//
// One disposable chain with a fictional genesis; fictional identities only. The
// buyer, seller, UAIN trade steward and central reviewer are uain-agent kit
// identities and act only through the kit's MCP tools against the real BAINK
// server (createBainkServer), which proves state with the pinned reader, builds
// each no-install send with the pinned coin wallet and relays the member-signed
// coin_shield to the real daemon. The boundary checker is the devnet rule checker
// (FIXTURE: production keeps the custody checker). Nothing touches production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';
import { verifySignedRequest } from '../server/trade-deals.mjs';
import { addressFromFullViewingKey, createCoinWalletSendBuilder, createDevnetRuleChecker, createShieldTransport } from '../server/server-send-builder.mjs';
import * as kit from '../agent-kit/uain-agent.mjs';
import { createTradeSteward } from './trade-steward.mjs';
import { signedEnvelope } from '../../../chain/client/signing.mjs';

// The kit lists only uain_agent_* tools but still answers the earlier baink_agent_* names:
// look the annotations up under the listed name, then call with the name given.
function toolFor(name) {
  const listed = typeof name === 'string' && name.startsWith(kit.LEGACY_PREFIX) ? 'uain_agent_' + name.slice(kit.LEGACY_PREFIX.length) : name;
  const tool = kit.MCP_TOOLS.find((x) => x.name === listed);
  if (!tool) throw Error(`unknown kit tool: ${name}`);
  return tool;
}

const ENABLED = process.env.UAIN_TRADE_REAL_DAEMON === '1';
const TOOLS = process.env.UAIN_TRADE_TOOLS ?? '';
const EVIDENCE = process.env.UAIN_TRADE_EVIDENCE ?? '';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const units = (ai) => BigInt(Math.round(Number(ai) * 1e6));

async function freePort() { return new Promise((ok, fail) => { const s = netServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); }); }
async function pinned(name) { const executable = join(TOOLS, name); return { executable, executableSha256: sha(await readFile(executable)) }; }
async function exists(path) { try { await readFile(path); return true; } catch { return false; } }

test('Trade deal layer on the pinned native daemon: sign, pay, deliver, refund, retries, disputes and the 720-block window', { skip: !ENABLED && 'set UAIN_TRADE_REAL_DAEMON=1 and UAIN_TRADE_TOOLS (real-daemon stage)', timeout: 2_400_000 }, async (t) => {
  const daemon = join(TOOLS, 'uaind');
  const reader = await pinned('uain-state'), wallet = await pinned('uain-coin-wallet');
  const noteTools = (await exists(join(TOOLS, 'uain-private-state'))) && (await exists(join(TOOLS, 'uain-note-source')));
  const CHAIN = `uain-trade-fictional-${randomUUID().slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), 'uain-trade-real-daemon-'));
  const home = join(root, 'node'), agents = join(root, 'agents');
  const receipt = { schema: 'uain-trade-real-daemon-v1', chain: CHAIN, startedAt: new Date().toISOString(), tools: { uaind: sha(await readFile(daemon)), 'uain-state': reader.executableSha256, 'uain-coin-wallet': wallet.executableSha256 }, checker: 'FIXTURE devnet rule checker (production keeps custody)', rows: [], scenarios: {} };
  const row = (n, capability, result, detail) => { receipt.rows.push({ n, capability, result, ...detail }); console.log(`# row ${n} ${capability}: ${result}`); };
  const stage = (name) => console.log(`# STAGE ${name}`);

  // ---------------------------------------------------------------- chain
  let port = 0;
  while (!port) { const p = await freePort(); try { await new Promise((ok, fail) => { const s = netServer(); s.once('error', fail); s.listen(p - 1, '127.0.0.1', () => s.close(ok)); }); port = p; } catch {} }
  let node, log = '';
  const run = (args) => new Promise((ok, fail) => { const c = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', (b) => { o += b; }); c.stderr.on('data', (b) => { o += b; }); c.once('error', fail); c.once('close', (code) => (code === 0 ? ok(o.trim()) : fail(new Error(o)))); });
  const start = () => { node = spawn(daemon, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); for (const s of [node.stdout, node.stderr]) s.on('data', (b) => { log = (log + b).slice(-20000); }); };
  const stopNode = async () => { if (!node || node.exitCode !== null) return; await new Promise((r) => { const tm = setTimeout(() => { node.kill('SIGKILL'); r(); }, 15000); node.once('exit', () => { clearTimeout(tm); r(); }); node.kill('SIGTERM'); }); };
  async function rpc(method, params = {}) {
    const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'broadcast_tx_commit' ? 30000 : 8000) });
    const d = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return d.result;
  }
  const tip = async () => Number((await rpc('status')).sync_info.latest_block_height);
  async function waitFor(fn, tries = 240, every = 500) { let last; for (let i = 0; i < tries; i++) { if (node.exitCode !== null) throw new Error('node exited\n' + log); try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await pause(every); } throw new Error('stage wait failed: ' + last?.message + '\n' + log.slice(-3000)); }
  async function record(key, height = '0') {
    const r = (await rpc('abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(height) })).response;
    assert.equal(r.code, 0, r.log); return r.value ? JSON.parse(Buffer.from(r.value, 'base64')) : null;
  }
  const balanceOf = async (address) => BigInt((await record('coin_balance/' + address)) ?? '0');
  const sequences = new Map();
  async function submit(operation, payload, actor) {
    const member = await record('member/' + actor.id);
    const sequence = Math.max(sequences.get(actor.id) ?? 0, Number(member?.sequence ?? 0));
    const command = { version: 1, chain_id: CHAIN, member: actor.id, sequence: String(sequence), expires_height: String((await tip()) + 1000), operation, payload };
    const tx = signedEnvelope(command, actor.raw, actor.privateKey);
    const result = await rpc('broadcast_tx_commit', { tx: Buffer.from(JSON.stringify(tx)).toString('base64') });
    assert.equal(result.check_tx.code, 0, operation + ': ' + result.check_tx.log); assert.equal(result.tx_result.code, 0, operation + ': ' + result.tx_result.log);
    sequences.set(actor.id, sequence + 1);
    return Number(result.height);
  }
  const fixtureActor = (name, karma = 0) => { const keys = generateKeyPairSync('ed25519'), raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32); return { name, karma, raw, privateKey: keys.privateKey, id: 'uain1' + sha(raw).slice(0, 40) }; };
  const genesisMember = (a, extra = {}) => ({ id: a.id, public_key: a.raw.toString('base64url'), name: a.name, operator: a.name, family: a.name, licence: 'active', karma: a.karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0, ...extra });

  // Kit identities: the parties and UAIN agents sign exactly as members do.
  const names = ['seller', 'buyer', 'steward', 'reviewer'];
  const party = {};
  for (const as of names) {
    await kit.initIdentity({ home: agents, as });
    const file = (await kit.loadIdentity({ home: agents, as })).summary.file, data = JSON.parse(await readFile(file, 'utf8'));
    const raw = Buffer.from(data.public_key, 'base64url');
    party[as] = { name: `fictional-${as}`, karma: 100, raw, id: data.address, privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: data.public_key, d: data.private_key }, format: 'jwk' }) };
    assert.equal('uain1' + sha(raw).slice(0, 40), data.address);
  }
  const guardian = fixtureActor('fictional-guardian'), manager = fixtureActor('fictional-manager', 1000), checker = fixtureActor('fictional-checker', 100), verifier = fixtureActor('fictional-verifier', 100);
  const everyone = [guardian, manager, checker, verifier, ...names.map((n) => party[n])];

  let app;
  t.after(async () => {
    try { app?.server.closeAllConnections?.(); await app?.close(); } catch {}
    await stopNode().catch(() => {});
    if (EVIDENCE) { await writeFile(join(EVIDENCE, 'daemon.log'), log).catch(() => {}); await writeFile(join(EVIDENCE, 'trade-real-daemon.json'), JSON.stringify(receipt, null, 2) + '\n').catch(() => {}); }
  });

  stage('fictional chain on the pinned daemon');
  const appGenesis = join(root, 'app-genesis.json');
  await writeFile(appGenesis, JSON.stringify({ version: 1, guardians: [guardian.id], members: everyone.map((a) => genesisMember(a, a === guardian ? { default_verifier: true } : a === manager ? { creator: true } : {})) }), { mode: 0o600 });
  await run(['init', '--home', home, '--chain-id', CHAIN, '--app-genesis', appGenesis, '--rpc', `tcp://127.0.0.1:${port}`, '--p2p', `tcp://127.0.0.1:${port - 1}`]);
  const genesisFile = join(home, 'config/genesis.json'), genesisSha256 = sha(await readFile(genesisFile));
  receipt.genesisSha256 = genesisSha256;
  start();
  await waitFor(async () => (await tip()) >= 3);
  const evidence = '28'.repeat(32);
  const compact = await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence }, guardian);
  await waitFor(async () => (await tip()) > compact + 1);
  await submit('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence }, guardian);
  await submit('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence }, guardian);
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', evidence_digest: evidence, relayer: guardian.id }, guardian);
  const earners = [party.seller, party.buyer];
  for (const [i, actor] of [manager, verifier, guardian, ...earners].entries()) {
    await submit('identity_claim', {}, actor);
    await submit('operator_claim', { domain: `trade-${i}.example` }, actor);
    const claim = await record(`operator_claim/${actor.id}/`);
    await submit('operator_attest', { member: actor.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence }, guardian);
  }
  const activation = await submit('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence }, guardian);
  await waitFor(async () => (await tip()) > activation + 1);

  stage('seller and buyer earn AI$ through verified bounties (nothing minted outside the rules)');
  const priorArt = { basis: 'No discoverable answer exists for this fictional disposable qualification problem.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-trade', title: 'Fictional Trade qualification', class: 'benevolent', prior_art: priorArt }, manager);
  for (const actor of [verifier, guardian, ...earners]) await submit('project_join', { project: 'P-trade' }, actor);
  const EARNED = 5_000_000n;
  for (const [i, earner] of earners.entries()) {
    const task = 'T-trade-' + i, contribution = 'RC-trade-' + i;
    await submit('open_task', { id: task, project: 'P-trade', title: 'Fictional prospective bounty ' + i, class: 'benevolent', prior_art: priorArt, criteria: 'Check the fictional result independently and confirm its previously unknown answer.', kind: 'instant', karma_reward: 13, credit_reward: '13', verifiers_required: 2 }, manager);
    const openEvent = await record('event_count');
    await submit('coin_quote', { task, open_event: String(openEvent).padStart(20, '0'), amount: String(EARNED), evidence_digest: evidence }, manager);
    await submit('coin_reserve', { task, evidence_digest: evidence }, guardian);
    await submit('submit', { id: contribution, task, evidence_digest: evidence }, earner);
    const check = { contribution, verdict: 'confirm', novelty: 'new', searches: priorArt.searches, evidence_digest: evidence };
    await submit('verify', check, verifier); await submit('verify', check, guardian);
    await submit('coin_claim', { contribution }, earner);
    assert.equal(await balanceOf(earner.id), EARNED);
  }
  await submit('private_reviewer', { member: checker.id, active: true, evidence_digest: evidence }, guardian);
  const supplyStart = await record('coin_supply');
  receipt.scenarios.earn = { sellerUnits: String(EARNED), buyerUnits: String(EARNED), supply: supplyStart };

  // ---------------------------------------------------------------- BAINK
  stage('real BAINK server: pinned reader, pinned coin wallet, real relay');
  const free = httpServer(); await new Promise((r) => free.listen(0, '127.0.0.1', r)); const httpPort = free.address().port; await new Promise((r) => free.close(r));
  const url = `http://127.0.0.1:${httpPort}`, clock = { offset: 0 }, now = () => Date.now() + clock.offset;
  const work = join(root, 'builder'); await mkdir(work, { mode: 0o700 });
  const devnetChecker = createDevnetRuleChecker({ reviewerPrivateKey: checker.privateKey, coinWallet: wallet, chainId: CHAIN });
  const builder = createCoinWalletSendBuilder({ coinWallet: wallet, checker: devnetChecker, workDirectory: work });
  const transport = createShieldTransport({ rpc: `http://127.0.0.1:${port}`, chainId: CHAIN });
  const nativeConfig = { binary: reader.executable, binaryHash: reader.executableSha256, genesis: genesisFile, genesisHash: genesisSha256, rpc: `http://127.0.0.1:${port}/`, chainId: CHAIN, timeoutMs: 10000, maxAgeSeconds: 120 };
  const dataDir = join(root, 'baink');
  const startApp = async () => {
    app = await createBainkServer({ dataDir, publicOrigin: url, projectsSource: null, catalogueDir: null, trustProxy: true, tradeMode: 'open', tradeDealSweep: false, now,
      tradeStewardAddresses: [party.steward.id], tradeAppealReviewerAddresses: [party.reviewer.id],
      nativeConfig, nativeEnrolEnabled: true, serverSendEnabled: true, serverSendTickMs: 1000,
      serverSend: { builder, transport, addressFromKey: (fvk) => addressFromFullViewingKey(wallet, fvk) } });
    await new Promise((r) => app.server.listen(httpPort, '127.0.0.1', r));
  };
  await startApp();
  // The kit's own pacing (5 s polls): every signed call holds one of the member's 128 five-minute nonces.
  const o = (as) => ({ home: agents, as, url, fetch: (u, init) => fetch(u, { ...init, headers: { ...init.headers, 'X-Real-IP': `10.0.0.${names.indexOf(as) + 1}` } }) });
  const messages = [];
  const slowdowns = [];
  async function call(as, name, args = {}) {
    const write = !toolFor(name).annotations.readOnlyHint;
    let reply, data;
    for (let i = 0; ; i++) {
      reply = await kit.handleMcp(o(as), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: write ? { ...args, confirm: true } : args } });
      data = JSON.parse(reply.result.content[0].text);
      // What the kit's hint tells an agent to do when BAINK asks it to slow down: wait, then go on.
      if (!(reply.result.isError && ['member_nonce_limit', 'rate_limited'].includes(data.error) && i < 12)) break;
      slowdowns.push({ as, tool: name, action: args.action ?? args.view ?? null, code: data.error, at: new Date().toISOString() });
      await pause(30_000);
    }
    for (const k of ['message', 'note', 'next']) if (typeof data?.[k] === 'string') messages.push({ as, tool: name, action: args.action ?? args.view ?? null, kind: k, text: data[k], error: Boolean(reply.result.isError) });
    if (reply.result.isError) throw Object.assign(Error(data.message ?? data.error), { code: data.error, data });
    return data;
  }
  const act = (as, action, args) => call(as, 'baink_agent_trade_act', { action, ...args }).then((r) => r.result);
  const read = (as, view, args = {}) => call(as, 'baink_agent_trade', { view, ...args });
  const deal = async (id) => (await read('buyer', 'deal', { id })).deal;
  const steward = createTradeSteward({ o: o('steward'), now });
  const centralReview = createTradeSteward({ o: o('reviewer'), role: 'central-review', now });

  for (const as of names) await call(as, 'baink_agent_account', { displayName: `Fictional ${as}` });
  const config = await (await fetch(url + '/api/config')).json();
  assert.equal(config.nativeRegistration.enrol.chainId, CHAIN, 'BAINK proves state of the fictional chain with the pinned reader');
  for (const as of ['seller', 'buyer']) {
    const r = await call(as, 'baink_agent_receiving_address', { setup: true });
    assert.match(r.address ?? r.receiving?.address ?? JSON.stringify(r), /[a-f0-9]{86}/);
  }

  const paidUnits = { seller: 0n, buyer: 0n }, receivedUnits = { seller: 0n, buyer: 0n };
  async function sendsOf(as) { return (await call(as, 'baink_agent_payments')).payments; }
  /** The payer agent pays through the kit; the payee agent confirms receipt. */
  async function payRequest(payer, payee, requestId, amount) {
    const before = await balanceOf(party[payer].id);
    let paid = await call(payer, 'baink_agent_pay', { request: requestId, waitSeconds: 300 });
    // "Still in progress ... call baink_agent_payments in a minute": follow it the way the note says.
    for (let i = 0; i < 20 && paid.status !== 'finalized' && !['expired', 'cancelled', 'checker-refused'].includes(paid.status); i++) { await pause(15_000); paid = (await sendsOf(payer)).find((x) => x.send === paid.send) ?? paid; }
    assert.equal(paid.status, 'finalized', JSON.stringify(paid));
    const send = (await sendsOf(payee)).find((s) => s.send === paid.send);
    assert.ok(send?.next, 'the payee is told to confirm receipt');
    const confirmed = await call(payee, 'baink_agent_payment_received', { send: paid.send });
    assert.equal(confirmed.paid, true);
    assert.equal(before - (await balanceOf(party[payer].id)), units(amount), 'exact debit on the ledger');
    paidUnits[payer] += units(amount); receivedUnits[payee] += units(amount);
    return { send: paid.send, height: paid.ledgerHeight, attempts: paid.attempts };
  }
  /** List -> enquire -> terms -> deal -> both sign, all by MCP. */
  async function agree({ price = '1', milestones = ['Draft', 'Final'], window } = {}) {
    const offer = (await act('seller', 'offer_create', { title: 'Fictional analysis service', description: 'Fictional analysis for the real-daemon stage', price, category: 'research' })).offer;
    const enquiry = (await act('buyer', 'enquire', { offerId: offer.id, message: 'I would like this', expectedRevision: offer.revision })).enquiry;
    const draft = (await act('seller', 'terms_draft', { enquiryId: enquiry.id, terms: { scope: 'Fictional scope', deliverables: 'Fictional report', price, timeline: 'Two days', acceptanceCriteria: 'Covers the three named questions' } })).draft;
    await act('seller', 'terms_send', { termsId: draft.id, expectedRevision: draft.revision });
    const proposal = (await read('buyer', 'proposals', { enquiryId: enquiry.id })).proposals[0];
    const drafted = (await act('buyer', 'deal_create', { proposalId: proposal.id, proposalDigest: proposal.proposalDigest, milestones, ...(window ? { paymentWindowHours: window } : {}) })).deal;
    for (const who of ['seller', 'buyer']) { const d = await read(who, 'deal', { id: drafted.id }); await act(who, 'deal_accept', { dealId: d.deal.id, dealDigest: d.deal.dealDigest }); }
    const agreed = await deal(drafted.id);
    assert.equal(agreed.status, 'agreed');
    assert.ok(verifySignedRequest(agreed.acceptances.seller) && verifySignedRequest(agreed.acceptances.buyer), 'both binding signatures re-verify');
    return agreed;
  }

  // ---------------------------------------------------------------- scenarios
  stage('1. sign -> pay on the ledger -> deliver -> confirm -> rate');
  const d1 = await agree({ price: '1', milestones: ['Draft', 'Final'] });
  const p1 = await payRequest('buyer', 'seller', d1.payment.request.id, '1');
  assert.equal((await deal(d1.id)).status, 'paid');
  for (const index of [0, 1]) await act('seller', 'milestone_deliver', { dealId: d1.id, index, note: `Milestone ${index + 1}`, url: 'https://example.com/fictional' });
  for (const index of [0, 1]) await act('buyer', 'milestone_confirm', { dealId: d1.id, index });
  await act('buyer', 'rate', { dealId: d1.id, score: 5, comment: 'Fictional praise' });
  await act('seller', 'rate', { dealId: d1.id, score: 4 });
  const done1 = await deal(d1.id);
  assert.equal(done1.status, 'completed');
  assert.equal(done1.payment.request.status, 'paid');
  assert.equal(done1.payment.request.settlement?.kind, 'native-server-send');
  receipt.scenarios.signPayDeliver = { dealId: d1.id, dealDigest: d1.dealDigest, send: p1.send, ledgerHeight: p1.height, attempts: p1.attempts, status: done1.status };
  row('D1', 'binding deal signed by both, paid by a no-install send, delivered in milestones, completed and rated', 'pass', { dealId: d1.id, height: p1.height });

  stage('2. linked refund paid by the seller on the ledger');
  const d2 = await agree({ price: '1', milestones: ['Report'] });
  const p2 = await payRequest('buyer', 'seller', d2.payment.request.id, '1');
  const refund = await act('seller', 'refund', { dealId: d2.id, amount: '0.25', reason: 'Goodwill for a late draft' });
  const refundRequest = refund.deal.refunds[0].request;
  assert.equal(refundRequest.to, party.seller.id, 'the seller pays the linked refund');
  const r2 = await payRequest('seller', 'buyer', refundRequest.id, '0.25');
  const after2 = await deal(d2.id);
  assert.equal(after2.refunds[0].request.status, 'paid');
  receipt.scenarios.linkedRefund = { dealId: d2.id, paymentSend: p2.send, refundRequest: refundRequest.id, refundSend: r2.send, refundHeight: r2.height, dealStatus: after2.status };
  row('D2', 'refund linked to the deal, paid by the seller with a no-install send and confirmed by the buyer', 'pass', { dealId: d2.id, height: r2.height });

  stage('3. abandoned attempt -> steward retry -> paid once');
  const d3 = await agree({ price: '0.5', milestones: ['Report'] });
  const before3 = await balanceOf(party.buyer.id);
  const started = await call('buyer', 'baink_agent_pay', { request: d3.payment.request.id, waitSeconds: 0 });
  const cancelled = await call('buyer', 'baink_agent_cancel_payment', { send: started.send });
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  assert.equal(await balanceOf(party.buyer.id), before3, 'an abandoned attempt debits nothing');
  let cycle = await steward.cycle();
  const retry3 = cycle.results.find((x) => x.label === 'retry-payment' && x.item.dealId === d3.id);
  assert.ok(retry3?.ok, 'the steward sees the abandoned attempt and reopens the payment: ' + JSON.stringify(cycle.results));
  const p3 = await payRequest('buyer', 'seller', d3.payment.request.id, '0.5');
  const after3 = await deal(d3.id);
  assert.equal(after3.status, 'paid');
  assert.equal(after3.payment.retries.length, 1);
  receipt.scenarios.stewardRetryAfterAbandon = { dealId: d3.id, abandonedSend: started.send, retryDecision: retry3.result.decision.id, paidSend: p3.send, height: p3.height, debits: 1 };
  row('D3', 'steward retry after an abandoned attempt; one debit', 'pass', { dealId: d3.id, height: p3.height });

  stage('4. a signed-late attempt expires unused (the 9 November case) -> fresh attempt -> one debit');
  const d4 = await agree({ price: '0.5', milestones: ['Report'] });
  const before4 = await balanceOf(party.buyer.id);
  const slow = await call('buyer', 'baink_agent_pay', { request: d4.payment.request.id, waitSeconds: 0 });
  // The buyer's agent does not come back to sign until the prepared command's window has passed
  // (production, 9 November: signed 86 s after the attempt was ready, 23 s after it expired).
  const sendRecord = async () => (await kit.api(o('buyer'), 'GET', `/api/native/sends/${slow.send}`, undefined, await kit.loadIdentity(o('buyer')))).send;
  const ready = await waitFor(async () => { const r = await sendRecord(); return r.status === 'awaiting-signature' ? r : null; }, 600, 500);
  const firstExpiry = Number(ready.attempts.at(-1).command.expires_height), firstProof = Number(ready.attempts.at(-1).proofHeight);
  const readyAt = Date.now(), readyTip = await tip();
  await waitFor(async () => (await tip()) > firstExpiry + 1, 1200, 1000);
  const p4 = await call('buyer', 'baink_agent_pay', { request: d4.payment.request.id, waitSeconds: 0 }).catch((e) => e);
  assert.ok(p4 instanceof Error, 'a second payment for the same request is refused while the first is still settling');
  let final4;
  for (let i = 0; i < 40 && final4?.status !== 'finalized'; i++) { final4 = (await sendsOf('buyer')).find((s) => s.send === slow.send); if (final4?.status !== 'finalized') await pause(10_000); }
  assert.equal(final4.status, 'finalized', JSON.stringify(final4));
  const record4 = await sendRecord();
  assert.equal(record4.attempts.length, 2, 'attempt 1 was proved unused, attempt 2 was signed');
  assert.equal(record4.attempts[0].status, 'expired-unused');
  await call('seller', 'baink_agent_payment_received', { send: slow.send });
  assert.equal(before4 - (await balanceOf(party.buyer.id)), units('0.5'), 'paid exactly once');
  paidUnits.buyer += units('0.5'); receivedUnits.seller += units('0.5');
  receipt.scenarios.expiredAttemptRecovered = { dealId: d4.id, send: slow.send, firstAttempt: { proofHeight: firstProof, expiresHeight: firstExpiry, windowBlocks: firstExpiry - firstProof, tipWhenReady: readyTip, blocksLeftWhenReady: firstExpiry - readyTip, secondsWaitedBeforeSigning: Math.round((Date.now() - readyAt) / 1000), broadcasts: record4.attempts[0].broadcasts?.map((b) => ({ outcome: b.outcome, code: b.code, log: b.log })) ?? [], recovery: record4.attempts[0].recovery ? { height: record4.attempts[0].recovery.height, recordPresent: record4.attempts[0].recovery.recordPresent } : null }, attempts: record4.attempts.length, height: final4.ledgerHeight, debits: 1, secondPayRefused: p4.code };
  row('D4', 'prepared attempt signed too late expires unused on the ledger; a fresh attempt pays once', 'pass', { dealId: d4.id, windowBlocks: firstExpiry - firstProof });

  stage('5. payment window expiry -> steward retry -> paid');
  const d5 = await agree({ price: '0.5', milestones: ['Report'], window: 1 });
  // The one-hour window passes: move the request's due time into the past in BAINK's store, so the
  // deal layer and the send service (each on the real clock) both see it expired.
  app.server.closeAllConnections?.(); await app.close();
  const statePath = join(dataDir, 'state.json'), state5 = JSON.parse(await readFile(statePath, 'utf8'));
  state5.requests[d5.payment.request.id].expiresAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(statePath, JSON.stringify(state5)); await startApp();
  const late = await call('buyer', 'baink_agent_pay', { request: d5.payment.request.id, waitSeconds: 0 }).catch((e) => e);
  assert.ok(late instanceof Error, 'an expired deal payment is refused');
  assert.equal((await deal(d5.id)).status, 'expired');
  cycle = await steward.cycle();
  const retry5 = cycle.results.find((x) => x.label === 'retry-payment' && x.item.dealId === d5.id);
  assert.ok(retry5?.ok, JSON.stringify(cycle.results));
  const p5 = await payRequest('buyer', 'seller', d5.payment.request.id, '0.5');
  assert.equal((await deal(d5.id)).status, 'paid');
  receipt.scenarios.expiryRetry = { dealId: d5.id, refusedWith: late.code, retryDecision: retry5.result.decision.id, paidSend: p5.send, height: p5.height };
  row('D5', 'deal payment expires, steward reopens it, buyer pays', 'pass', { dealId: d5.id, height: p5.height });

  stage('6. dispute -> steward decision -> appeal -> central review -> ordered refund paid');
  const d6 = await agree({ price: '0.5', milestones: ['Report'] });
  await payRequest('buyer', 'seller', d6.payment.request.id, '0.5');
  const dispute = (await act('buyer', 'dispute_open', { dealId: d6.id, reason: 'Paid; nothing delivered.', desiredOutcome: 'refund' })).dispute;
  await act('buyer', 'dispute_evidence', { disputeId: dispute.id, statement: 'No message or file received.' });
  await act('seller', 'dispute_evidence', { disputeId: dispute.id, statement: 'I could not deliver in time.' });
  cycle = await steward.cycle();
  const decided = cycle.results.find((x) => x.label === 'dispute-decision' && x.item.dealId === d6.id);
  assert.ok(decided?.ok, JSON.stringify(cycle.results));
  assert.equal(decided.result.decision.outcome, 'refund-full');
  await act('seller', 'dispute_appeal', { disputeId: dispute.id, reason: 'I will deliver tomorrow instead.' });
  const reviewCycle = await centralReview.cycle();
  const appeal = reviewCycle.results.find((x) => x.label === 'appeal-decision');
  assert.ok(appeal?.ok, JSON.stringify(reviewCycle.results));
  const finalDispute = (await read('buyer', 'dispute', { id: dispute.id })).dispute;
  assert.equal(finalDispute.status, 'final');
  const ordered = (await deal(d6.id)).refunds.find((r) => r.request.status === 'open');
  let refundSend = null;
  if (ordered) refundSend = await payRequest('seller', 'buyer', ordered.request.id, ordered.request.amount);
  const after6 = await deal(d6.id);
  receipt.scenarios.disputeAppeal = { dealId: d6.id, disputeId: dispute.id, stewardOutcome: decided.result.decision.outcome, appeal: finalDispute.appealDecision?.result, refundPaidSend: refundSend?.send ?? null, dealStatus: after6.status };
  row('D6', 'dispute decided by the steward agent, appeal decided by the central-review agent, ordered refund paid on the ledger', 'pass', { dealId: d6.id, appeal: finalDispute.appealDecision?.result });

  stage('7. cancel before payment, and mutual cancel after payment with the refund paid');
  const c1 = await agree({ price: '0.5', milestones: ['Report'] });
  assert.equal((await act('buyer', 'deal_cancel', { dealId: c1.id, reason: 'Found another provider' })).deal.status, 'cancelled');
  const c2 = await agree({ price: '0.5', milestones: ['Report'] });
  await payRequest('buyer', 'seller', c2.payment.request.id, '0.5');
  assert.equal((await act('buyer', 'deal_cancel', { dealId: c2.id, reason: 'Project stopped' })).cancelled, false);
  const both = await act('seller', 'deal_cancel', { dealId: c2.id, reason: 'Agreed' });
  assert.equal(both.deal.status, 'cancelled');
  const mutual = both.deal.refunds.find((r) => r.source === 'mutual-cancel');
  const r7 = await payRequest('seller', 'buyer', mutual.request.id, mutual.request.amount);
  receipt.scenarios.cancel = { beforePayment: c1.id, afterPayment: c2.id, refundSend: r7.send, height: r7.height };
  row('D7', 'cancel before payment; mutual cancel after payment with the full refund paid on the ledger', 'pass', { dealId: c2.id });

  stage('8. matrix row 30: paying more than the payer holds is refused, nothing debited');
  const beforeOver = await balanceOf(party.buyer.id);
  const over = await call('buyer', 'baink_agent_pay', { to: party.seller.id, amount: '1000', waitSeconds: 120 }).catch((e) => e);
  const overStatus = over instanceof Error ? { refused: over.code, message: over.message } : { status: over.status, reason: over.reason ?? null, note: over.note ?? null };
  assert.ok(over instanceof Error || ['checker-refused', 'cancelled', 'expired'].includes(over.status), 'an overspend never finalizes: ' + JSON.stringify(overStatus));
  if (!(over instanceof Error) && !['checker-refused', 'cancelled', 'expired'].includes(over.status)) await call('buyer', 'baink_agent_cancel_payment', { send: over.send }).catch(() => {});
  assert.equal(await balanceOf(party.buyer.id), beforeOver);
  receipt.scenarios.overspend = { balanceUnits: String(beforeOver), askedUnits: String(units('1000')), ...overStatus };
  row(30, 'insufficient funds: a payment above the payer balance is refused before anything is signed or debited', 'pass', overStatus);

  stage('9. matrix row 25: the 720-block approval window on the ledger');
  const buyerChain = party.buyer;
  const target = (await call('seller', 'baink_agent_receiving_address', {})).address;
  assert.match(target ?? '', /^[a-f0-9]{86}$/);
  async function shieldWith(approvalBlocks, commandBlocks, amountUnits) {
    const h = await tip();
    const revision = (await record('private_licence_revision')).value, frontier = await record('private_frontier');
    const built = await builder.build({ intentId: 'stage-' + randomUUID(), attempt: 1, chainId: CHAIN, member: buyerChain.id, amountUnits, recipientAddress: target, memo: 'fictional window check', expiresHeight: String(h + approvalBlocks), licenceRevision: revision, frontier: { root: frontier.root, count: frontier.count }, purposeCommitment: sha('fictional window check ' + randomUUID()), evidence: null });
    assert.equal(built.status, 'built', JSON.stringify(built));
    const member = await record('member/' + buyerChain.id);
    const command = { version: 1, chain_id: CHAIN, member: buyerChain.id, sequence: String(member.sequence), expires_height: String(h + commandBlocks), operation: 'coin_shield', payload: { bundle: built.bundle, approval: built.approval } };
    return { h, command, envelope: signedEnvelope(command, buyerChain.raw, buyerChain.privateKey) };
  }
  const broadcast = async (envelope) => rpc('broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(envelope)).toString('base64') });
  const beforeWindow = await balanceOf(buyerChain.id), supplyWindow = await record('coin_supply');
  // (a) an approval far beyond the 720-block window is refused by consensus. The window is counted
  // from the inclusion height, and building the Orchard proof takes several blocks, so 725 from the
  // pre-build tip can land legitimately (seen on 10 November); 1,500 is beyond it at any inclusion.
  const wide = await shieldWith(1500, 30, '10000');
  const wideTip = await tip(), wideReply = await broadcast(wide.envelope);
  let wideRecorded = false;
  if (wideReply.code === 0) { const h = await tip(); await waitFor(async () => (await tip()) > h + 2); wideRecorded = (await record('private_boundary/' + wide.command.payload.approval.effects)) !== null; }
  assert.equal(wideRecorded, false, 'an approval beyond 720 blocks never lands');
  // (b) a command whose approval already expired is refused.
  const short = await shieldWith(3, 3, '10000');
  await waitFor(async () => (await tip()) > short.h + 4, 120, 1000);
  const shortReply = await broadcast(short.envelope);
  assert.notEqual(shortReply.code, 0, 'an expired approval is refused at CheckTx');
  // (c) an approval exactly 720 blocks ahead is accepted and recorded once.
  const edge = await shieldWith(719, 30, '10000');
  const edgeTip = await tip(), edgeReply = await broadcast(edge.envelope);
  assert.equal(edgeReply.code, 0, edgeReply.log);
  await waitFor(async () => (await record('private_boundary/' + edge.command.payload.approval.effects)) !== null, 120, 1000);
  assert.equal(beforeWindow - (await balanceOf(buyerChain.id)), 10000n, 'only the in-window approval debited');
  paidUnits.buyer += 10000n; receivedUnits.seller += 10000n;
  const supplyAfterWindow = await record('coin_supply');
  assert.equal(supplyAfterWindow.minted, supplyWindow.minted);
  receipt.scenarios.approvalWindow = {
    beyondWindow: { approvalExpires: wide.h + 1500, tipAtBroadcast: wideTip, blocksAheadAtBroadcast: wide.h + 1500 - wideTip, checkTxCode: wideReply.code, log: String(wideReply.log ?? '').slice(0, 200), recorded: wideRecorded },
    expired: { approvalBlocksAhead: 3, checkTxCode: shortReply.code, log: String(shortReply.log ?? '').slice(0, 200) },
    atEdge: { approvalExpires: edge.h + 719, tipAtBroadcast: edgeTip, blocksAheadAtBroadcast: edge.h + 719 - edgeTip, checkTxCode: edgeReply.code, recorded: true, effects: edge.command.payload.approval.effects },
  };
  row(25, 'approval window: far beyond 720 blocks refused, an expired approval refused, inside the window accepted once', 'pass', receipt.scenarios.approvalWindow);

  stage('10. conservation, reputation and public evidence');
  const supplyEnd = await record('coin_supply');
  assert.equal(supplyEnd.minted, supplyStart.minted, 'nothing minted during trading');
  assert.equal(BigInt(supplyEnd.transparent) + BigInt(supplyEnd.shielded), BigInt(supplyEnd.minted));
  assert.equal(await balanceOf(party.buyer.id), EARNED - paidUnits.buyer);
  assert.equal(await balanceOf(party.seller.id), EARNED - paidUnits.seller);
  assert.equal(BigInt(supplyEnd.shielded) - BigInt(supplyStart.shielded), paidUnits.buyer + paidUnits.seller);
  const member = await read('buyer', 'member', { member: party.seller.id });
  const feed = await read('buyer', 'feed', {});
  const decisions = await read('buyer', 'decisions');
  assert.ok(decisions.decisions.every((x) => x.reasons.length >= 20 && x.policyClauses.length >= 1));
  receipt.conservation = { minted: supplyEnd.minted, transparent: supplyEnd.transparent, shielded: supplyEnd.shielded, buyerPaidUnits: String(paidUnits.buyer), sellerPaidUnits: String(paidUnits.seller), buyerBalance: String(await balanceOf(party.buyer.id)), sellerBalance: String(await balanceOf(party.seller.id)) };
  receipt.publicEvidence = { feedEvents: feed.events?.length ?? feed.count, decisions: decisions.count, sellerReputation: member.reputation };

  if (noteTools) {
    stage('11. recipients find their notes with the kit-derived receiving key');
    const { lightScan, ownedNotes } = await import('../../../chain/client/note-scan.mjs');
    const privateReader = { ...(await pinned('uain-private-state')), genesis: genesisFile, genesisSha256, rpc: `http://127.0.0.1:${port}`, maxAgeSeconds: 120 };
    const noteTool = await pinned('uain-note-source');
    const scan = await lightScan(privateReader);
    receipt.recipientNotes = {};
    for (const as of ['seller', 'buyer']) {
      // The kit's derivation (DEC-CHAIN-019): fictional key, written only inside the disposable stage.
      const identity = await kit.loadIdentity(o(as));
      const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', identity.privateKey, new TextEncoder().encode(kit.ORCHARD_RECEIVING_DOMAIN + identity.address)));
      const seed = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array([...new TextEncoder().encode('BAINK/orchard-receiving-key/derive/v1\0'), ...signature])));
      const file = join(root, `${as}.orchard`); await writeFile(file, seed, { mode: 0o600 }); await chmod(file, 0o600);
      const notes = await ownedNotes({ scan, noteTool, spendingKeyFile: file });
      assert.equal(notes.balanceUnits, String(receivedUnits[as]), `${as} holds exactly what it was paid`);
      receipt.recipientNotes[as] = notes.balanceUnits;
    }
    row('D8', 'recipients hold exactly what they were paid, found with the kit-derived receiving key', 'pass', receipt.recipientNotes);
  } else receipt.recipientNotes = 'skipped: uain-private-state and uain-note-source not provided';

  receipt.messages = messages;
  receipt.slowdowns = slowdowns;
  receipt.finishedAt = new Date().toISOString();
  receipt.result = 'passed';
});
