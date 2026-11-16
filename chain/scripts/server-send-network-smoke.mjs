#!/usr/bin/env node
// Disposable devnet acceptance for no-install sending
// (docs/baink/no-install-send-design-2026-11-09.md). One throwaway node with
// real Orchard proofs, many fictional accounts, the real BAINK send service,
// the real browser signing module and the real server-side builder.
// The checker is a fictional devnet rule checker; production keeps custody.
//
//   node scripts/server-send-network-smoke.mjs <uaind-private> <uain-coin-wallet> [uain-private-state uain-note-source]
//
// Never point this at an existing node: it creates its own chain and keys.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signedEnvelope, signingBytes } from '../client/signing.mjs';
import { createServerSendService, sendIntentBytes } from '../../apps/baink/server/server-send.mjs';
import { createCoinWalletSendBuilder, createCustodySendChecker, createDevnetRuleChecker, createShieldTransport } from '../../apps/baink/server/server-send-builder.mjs';
import { runReviewerAction, privateAIMessageBytes } from '../../apps/baink/review-broker/reviewer-worker.mjs';
import { canonicalJSON } from '../client/signing.mjs';
import { buildSendIntent, signSendIntent, signPreparedCommand, signReceipt, signReceivingAddress } from '../../apps/baink/web/server-send.js';

const [daemonArg, coinWalletArg, readerArg, noteToolArg] = process.argv.slice(2);
assert.ok(daemonArg && coinWalletArg, 'usage: server-send-network-smoke.mjs <uaind-private> <uain-coin-wallet> [uain-private-state uain-note-source]');
const daemon = resolve(daemonArg), coinWalletPath = resolve(coinWalletArg);
const CHAIN = 'uain-server-send-fixture-1';
import { createServer as netServer } from 'node:net';
async function freePort() { return new Promise((ok, fail) => { const s = netServer(); s.once('error', fail); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); }); }
// Two adjacent free ports (RPC and P2P); never assume a fixed port on a shared host.
let port = Number(process.env.UAIN_SERVER_SEND_SMOKE_PORT ?? 0);
while (!port) { const p = await freePort(); try { await new Promise((ok, fail) => { const s = netServer(); s.once('error', fail); s.listen(p - 1, '127.0.0.1', () => s.close(ok)); }); port = p; } catch {} }
const root = await mkdtemp(join(tmpdir(), 'uain-server-send-fixture-'));
const home = join(root, 'node');
const sha = v => createHash('sha256').update(v).digest('hex');
const pause = ms => new Promise(r => setTimeout(r, ms));
const stage = name => console.log('FIXTURE_STAGE ' + name);

function identity(name, karma = 0) {
  const keys = generateKeyPairSync('ed25519'), raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...keys, raw, name, member: { id: 'uain1' + sha(raw).slice(0, 40), public_key: raw.toString('base64url'), name, operator: name, family: name, licence: 'active', karma, credits: '0', sequence: '0', default_verifier: false, creator: false, active_projects: 0 } };
}
const guardian = identity('fictional-guardian'), manager = identity('fictional-manager', 1000), reviewer = identity('fictional-checker', 100), verifier = identity('fictional-verifier', 100);
guardian.member.default_verifier = true; manager.member.creator = true;
const payers = ['a', 'b', 'c', 'd'].map(n => identity('fictional-payer-' + n, 100));
const recipients = ['r1', 'r2', 'r3', 'r4', 'r5'].map(n => identity('fictional-recipient-' + n, 0));
const everyone = [guardian, manager, reviewer, verifier, ...payers, ...recipients];

let node, log = '';
async function run(args) {
  return new Promise((ok, fail) => { const c = spawn(daemon, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', b => { o += b; }); c.stderr.on('data', b => { o += b; }); c.once('error', fail); c.once('close', code => code === 0 ? ok(o.trim()) : fail(new Error(o))); });
}
function start() { node = spawn(daemon, ['start', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] }); for (const s of [node.stdout, node.stderr]) s.on('data', b => { log = (log + b).slice(-20000); }); }
async function stop() { if (!node || node.exitCode !== null) return; await new Promise(r => { const t = setTimeout(() => { node.kill('SIGKILL'); r(); }, 15000); node.once('exit', () => { clearTimeout(t); r(); }); node.kill('SIGTERM'); }); }
async function rpc(method, params = {}) {
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(method === 'broadcast_tx_commit' ? 30000 : 8000) });
  const d = await r.json(); if (d.error) throw new Error(JSON.stringify(d.error)); return d.result;
}
const tip = async () => Number((await rpc('status')).sync_info.latest_block_height);
async function waitFor(fn, tries = 120) { let last; for (let i = 0; i < tries; i++) { if (node.exitCode !== null) throw new Error('node exited\n' + log); try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await pause(500); } throw new Error('fixture wait failed: ' + last?.message + '\n' + log.slice(-3000)); }
async function record(key, height = '0') {
  const r = (await rpc('abci_query', { path: '/store/federation/key', data: Buffer.from(key).toString('hex'), height: String(height) })).response;
  assert.equal(r.code, 0, r.log); return r.value ? JSON.parse(Buffer.from(r.value, 'base64')) : null;
}
const sequences = new Map();
async function submit(operation, payload, actor = guardian, expected = true) {
  const sequence = sequences.get(actor.member.id) ?? 0;
  const command = { version: 1, chain_id: CHAIN, member: actor.member.id, sequence: String(sequence), expires_height: String((await tip()) + 1000), operation, payload };
  const tx = signedEnvelope(command, actor.raw, actor.privateKey);
  const result = await rpc(expected ? 'broadcast_tx_commit' : 'broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(tx)).toString('base64') });
  if (!expected) { assert.notEqual(result.code, 0, operation + ' incorrectly accepted'); return; }
  assert.equal(result.check_tx.code, 0, operation + ': ' + result.check_tx.log); assert.equal(result.tx_result.code, 0, operation + ': ' + result.tx_result.log);
  sequences.set(actor.member.id, sequence + 1);
  return Number(result.height);
}

/** Devnet reader: committed state by abci_query at one height. Production
 * BAINK reads through the pinned proving reader; the service logic is the same. */
const native = {
  configured: true, timeoutMs: 15000, pins: { chainId: CHAIN, epoch: null, verifierSha256: 'd'.repeat(64) },
  async publicState(selection) {
    // Read at the application's committed height. CometBFT stores block H before
    // the app commits it, so status.latest_block_height can name an uncommitted
    // version (this read once saw a sequence advance without its record).
    const status = await rpc('status'), info = (await rpc('abci_info')).response, height = String(info.last_block_height);
    const records = {};
    for (const key of selection.keys ?? []) records[key] = await record(key, height);
    const member = selection.member ? await record('member/' + selection.member, height) : undefined;
    const appHash = Buffer.from(info.last_block_app_hash, 'base64').toString('hex');
    return { state: { chain_id: CHAIN, height, app_hash: appHash, member, records },
      proof: { authority: 'native', chainId: CHAIN, epoch: native.pins.epoch, verifierSha256: native.pins.verifierSha256, headerTime: status.sync_info.latest_block_time, maxAgeSeconds: 120, height, appHash } };
  },
};
async function webIdentity(actor) {
  const privateKey = await crypto.subtle.importKey('jwk', actor.privateKey.export({ format: 'jwk' }), 'Ed25519', false, ['sign']);
  return { privateKey, address: actor.member.id, publicKeyBase64: actor.raw.toString('base64') };
}
const user = actor => ({ address: actor.member.id, publicKey: actor.raw.toString('base64') });
const balanceOf = async address => BigInt((await record('coin_balance/' + address)) ?? '0');

const receipt = { chain: CHAIN, accounts: everyone.length, scenarios: {} };
try {
  stage('devnet');
  const appGenesis = join(root, 'app-genesis.json');
  await writeFile(appGenesis, JSON.stringify({ version: 1, guardians: [guardian.member.id], members: everyone.map(a => a.member) }), { mode: 0o600 });
  await run(['init', '--home', home, '--chain-id', CHAIN, '--app-genesis', appGenesis, '--rpc', `tcp://127.0.0.1:${port}`, '--p2p', `tcp://127.0.0.1:${port - 1}`]);
  const genesis = await readFile(join(home, 'config/genesis.json'));
  native.pins.epoch = sha(genesis);
  start();
  await waitFor(async () => (await tip()) >= 3);
  assert.equal((await rpc('status')).node_info.network, CHAIN, 'the RPC port answers for this fixture chain');
  const evidence = '28'.repeat(32);
  const compact = await submit('activate_storage', { policy: 'compact-state-v1', evidence_digest: evidence });
  await waitFor(async () => (await tip()) > compact + 1);
  await submit('activate_membership', { policy: 'project-membership-v1', evidence_digest: evidence });
  await submit('activate_operator_rewards', { policy: 'pairwise-operator-rewards-v1', evidence_digest: evidence });
  await submit('activate_private_exchange', { policy: 'orchard-v2-reviewed-otc-v1', evidence_digest: evidence, relayer: guardian.member.id });
  for (const [i, actor] of [manager, verifier, guardian, ...payers].entries()) {
    await submit('identity_claim', {}, actor);
    await submit('operator_claim', { domain: `send-${i}.example` }, actor);
    const claim = await record(`operator_claim/${actor.member.id}/`);
    await submit('operator_attest', { member: actor.member.id, domain: claim.domain, claim_event_id: claim.event_id, txt: `uain-operator=${claim.did}`, checked_at: new Date().toISOString(), evidence_digest: evidence });
  }
  const activation = await submit('activate_coin', { policy: 'verified-bounties-108t-micro-v1', evidence_digest: evidence });
  await waitFor(async () => (await tip()) > activation + 1);

  stage('earn');
  const priorArt = { basis: 'No discoverable answer exists for this fictional disposable qualification problem.', searches: ['first fictional prior-art search', 'second fictional prior-art search'] };
  await submit('open_project', { id: 'P-send', title: 'Fictional server send qualification', class: 'benevolent', prior_art: priorArt }, manager);
  for (const actor of [verifier, guardian, ...payers]) await submit('project_join', { project: 'P-send' }, actor);
  for (const [i, payer] of payers.entries()) {
    const task = 'T-send-' + i, contribution = 'RC-send-' + i;
    await submit('open_task', { id: task, project: 'P-send', title: 'Fictional prospective bounty ' + i, class: 'benevolent', prior_art: priorArt, criteria: 'Check the fictional result independently and confirm its previously unknown answer.', kind: 'instant', karma_reward: 13, credit_reward: '13', verifiers_required: 2 }, manager);
    const openEvent = await record('event_count');
    await submit('coin_quote', { task, open_event: String(openEvent).padStart(20, '0'), amount: '5000000', evidence_digest: evidence }, manager);
    await submit('coin_reserve', { task, evidence_digest: evidence });
    await submit('submit', { id: contribution, task, evidence_digest: evidence }, payer);
    const check = { contribution, verdict: 'confirm', novelty: 'new', searches: priorArt.searches, evidence_digest: evidence };
    await submit('verify', check, verifier); await submit('verify', check);
    await submit('coin_claim', { contribution }, payer);
    assert.equal(await balanceOf(payer.member.id), 5000000n);
  }
  await submit('private_reviewer', { member: reviewer.member.id, active: true, evidence_digest: evidence });
  const supplyBefore = await record('coin_supply');
  assert.equal(supplyBefore.minted, String(5000000 * payers.length));
  receipt.scenarios.earn = { payers: payers.length, eachEarnedUnits: '5000000', supply: supplyBefore };

  stage('recipients set up receiving (keygen only; no holder)');
  const keyDir = join(root, 'recipient-keys'); await mkdir(keyDir, { mode: 0o700 });
  const walletTool = { executable: coinWalletPath, executableSha256: sha(await readFile(coinWalletPath)) };
  const store = (() => { let data = { requests: {} }, tail = Promise.resolve(); return { read: () => structuredClone(data), transact(fn) { const t = tail.then(() => { const next = structuredClone(data), v = fn(next); data = next; return structuredClone(v); }); tail = t.catch(() => {}); return t; } }; })();
  const work = join(root, 'builder'); await mkdir(work, { mode: 0o700 });
  const checker = createDevnetRuleChecker({ reviewerPrivateKey: reviewer.privateKey, coinWallet: walletTool, chainId: CHAIN });
  const builder = createCoinWalletSendBuilder({ coinWallet: walletTool, checker, workDirectory: work });
  const realTransport = createShieldTransport({ rpc: `http://127.0.0.1:${port}`, chainId: CHAIN });
  let transportMode = 'ok';
  native.broadcastShield = async (envelope, options) => {
    if (transportMode === 'drop') throw new Error('fixture: dropped before the node');
    const reply = await realTransport.broadcastShield(envelope, options);
    if (transportMode === 'lost-ack') throw new Error('fixture: reply lost after the node accepted it');
    return reply;
  };
  const limits = { maxNotAfterMs: 86400000, activePerPayer: 4, acceptedPerDay: 48, retainedPerPayer: 512, global: 20000, activeGlobal: 200, attemptBlocks: 40n, rebroadcastMs: 0, memoBytes: 200 };
  let service = createServerSendService({ store, native, builder, enabled: true, limits });
  const restart = () => { service = createServerSendService({ store, native, builder, enabled: true, limits }); };
  const orchard = new Map();
  for (const r of recipients) {
    const file = join(keyDir, r.name);
    const out = await new Promise((ok, fail) => { const c = spawn(coinWalletPath, ['keygen', file], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', b => { o += b; }); c.once('close', code => code === 0 ? ok(o) : fail(new Error('keygen failed'))); });
    const { address } = JSON.parse(out); orchard.set(r.member.id, { address, file });
    await service.registerReceivingAddress(user(r), await signReceivingAddress(await webIdentity(r), { address, chainId: CHAIN }));
  }
  const pins = { chainId: CHAIN, genesisSha256: native.pins.epoch };
  async function intentFor(payer, recipient, amountUnits, extra = {}) {
    const id = await webIdentity(payer);
    const intent = buildSendIntent({ pins, from: payer.member.id, to: recipient.member.id, recipientAddress: orchard.get(recipient.member.id).address, amountUnits, memo: 'fictional devnet payment', ...extra });
    return signSendIntent(id, intent);
  }
  const retriesSigned = [];
  async function untilStatus(id, statuses, actor, tries = 120) {
    for (let i = 0; i < tries; i++) {
      await service.tick({ max: 50 });
      const s = service.get(user(actor), id).send;
      if (statuses.includes(s.status)) return s;
      // Like the Pay screen and the agent kit: sign a retry of an authorised payment.
      if (!statuses.includes('awaiting-signature') && s.status === 'awaiting-signature' && s.intent.from === actor.member.id && s.attempts.length > 1) { retriesSigned.push({ id, attempt: s.current.n, unusedBecause: s.attempts.at(-2).recovery }); await service.sign(user(actor), id, await signPreparedCommand(await webIdentity(actor), s)); continue; }
      await pause(1000);
    }
    const row = service.get(user(actor), id).send;
    throw new Error('send ' + id + ' stuck in ' + row.status + ' ' + JSON.stringify({ lastError: row.lastError ?? null, attempts: row.attempts.map(a => ({ n: a.n, status: a.status, expires: a.command?.expires_height, proofHeight: a.proofHeight, broadcasts: a.broadcasts, recovery: a.recovery && { height: a.recovery.height, seq: a.recovery.memberSequence } })) }));
  }
  async function browserSign(payer, record) { return service.sign(user(payer), record.id, await signPreparedCommand(await webIdentity(payer), record)); }
  const paid = new Map(payers.map(p => [p.member.id, 0n]));
  const received = new Map(recipients.map(r => [r.member.id, 0n]));
  const done = (payer, recipient, units) => { paid.set(payer.member.id, paid.get(payer.member.id) + units); received.set(recipient.member.id, received.get(recipient.member.id) + units); };

  stage('earn -> pay -> recipient confirms');
  {
    const [payer, payee] = [payers[0], recipients[0]];
    const { send } = await service.create(user(payer), await intentFor(payer, payee, '1500000'));
    const ready = await untilStatus(send.id, ['awaiting-signature'], payer);
    await browserSign(payer, ready);
    const final = await untilStatus(send.id, ['finalized'], payer);
    done(payer, payee, 1500000n);
    const confirmed = await service.confirm(user(payee), send.id, await signReceipt(await webIdentity(payee), service.get(user(payee), send.id).send));
    assert.equal(confirmed.send.paid, true);
    receipt.scenarios.payAndConfirm = { effects: final.result.effects, height: final.result.height, paid: true };
  }

  stage('Trade-style request -> pay -> paid=true');
  {
    const [payer, payee] = [payers[1], recipients[1]];
    const now = new Date().toISOString();
    await store.transact(s => { s.requests['trade-req-1'] = { id: 'trade-req-1', from: payee.member.id, to: payer.member.id, amount: '2', currency: 'AI$', memo: 'fictional compute service', status: 'open', createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }; });
    const { send } = await service.create(user(payer), await intentFor(payer, payee, '2000000', { requestId: 'trade-req-1' }));
    // Duplicate submit of the same signed bytes and a restart before building.
    const again = await service.create(user(payer), { intent: send.intent, signature: send.signature });
    assert.equal(again.created, false); restart();
    const ready = await untilStatus(send.id, ['awaiting-signature'], payer);
    await browserSign(payer, ready);
    const dup = await service.sign(user(payer), send.id, await signPreparedCommand(await webIdentity(payer), ready));
    assert.equal(dup.attempted, false);
    await untilStatus(send.id, ['finalized'], payer);
    done(payer, payee, 2000000n);
    assert.equal(store.read().requests['trade-req-1'].status, 'open');
    await service.confirm(user(payee), send.id, await signReceipt(await webIdentity(payee), service.get(user(payee), send.id).send));
    const request = store.read().requests['trade-req-1'];
    assert.equal(request.status, 'paid'); assert.equal(request.settlement.kind, 'native-server-send');
    receipt.scenarios.tradeRequest = { requestStatus: request.status, paid: true, duplicateSubmitCreated: false, duplicateSignAttempted: false, restartedBeforeBuild: true };
  }

  stage('server crash mid-send: accepted by the node, reply lost, server restarts');
  {
    const [payer, payee] = [payers[2], recipients[2]];
    const { send } = await service.create(user(payer), await intentFor(payer, payee, '1000000'));
    const ready = await untilStatus(send.id, ['awaiting-signature'], payer);
    transportMode = 'lost-ack';
    const signed = await browserSign(payer, ready);
    assert.equal(signed.send.status, 'unknown');
    transportMode = 'ok'; restart();
    const final = await untilStatus(send.id, ['finalized'], payer);
    assert.equal(final.attempts.length, 1);
    done(payer, payee, 1000000n);
    receipt.scenarios.crashMidSend = { firstReply: 'unknown', final: 'finalized', attempts: 1 };
  }

  stage('dropped broadcast -> proved unused after expiry -> fresh attempt -> paid once');
  {
    const [payer, payee] = [payers[3], recipients[3]];
    const { send } = await service.create(user(payer), await intentFor(payer, payee, '1200000'));
    const ready = await untilStatus(send.id, ['awaiting-signature'], payer);
    transportMode = 'drop';
    await browserSign(payer, ready);
    const expiry = Number(ready.current.command.expires_height);
    await waitFor(async () => (await tip()) > expiry + 1, 600);
    await service.tick({ max: 50 });
    let row = service.get(user(payer), send.id).send;
    assert.equal(row.attempts[0].status, 'expired-unused'); assert.equal(row.attempts[0].recovery.recordPresent, false);
    transportMode = 'ok';
    row = await untilStatus(send.id, ['awaiting-signature'], payer);
    assert.equal(row.attempts.length, 2);
    await browserSign(payer, row);
    await untilStatus(send.id, ['finalized'], payer);
    done(payer, payee, 1200000n);
    receipt.scenarios.droppedThenRetried = { attempts: 2, firstAttempt: 'expired-unused', debits: 1 };
  }

  stage('many accounts at once');
  {
    const ids = [];
    for (const [i, payer] of payers.entries()) ids.push([payer, recipients[(i + 1) % recipients.length], (await service.create(user(payer), await intentFor(payer, recipients[(i + 1) % recipients.length], String(300000 + i)))).send.id]);
    for (const [payer, , id] of ids) await browserSign(payer, await untilStatus(id, ['awaiting-signature'], payer));
    for (const [payer, payee, id] of ids) { await untilStatus(id, ['finalized'], payer); done(payer, payee, BigInt(300000 + ids.findIndex(x => x[2] === id))); }
    receipt.scenarios.concurrent = { sends: ids.length, finalized: ids.length, retriesSignedAfterProvedUnused: retriesSigned.map(r => ({ attempt: r.attempt, recoveryHeight: r.unusedBecause?.height, memberSequence: r.unusedBecause?.memberSequence, commandSequence: r.unusedBecause?.commandSequence })) };
  }

  stage('expired intent never sends');
  {
    const [payer, payee] = [payers[0], recipients[4]];
    const signedIntent = await intentFor(payer, payee, '100000', { minutes: 5 });
    signedIntent.intent.notAfter = new Date(Date.now() + 62000).toISOString();
    signedIntent.signature = sign(null, sendIntentBytes(signedIntent.intent), payer.privateKey).toString('base64url');
    const { send } = await service.create(user(payer), signedIntent);
    await untilStatus(send.id, ['awaiting-signature'], payer);
    await pause(63000);
    const row = await untilStatus(send.id, ['expired'], payer, 10);
    assert.equal(row.attempts[0].envelope, null);
    receipt.scenarios.expiredIntent = { status: row.status, signed: false };
  }

  stage('negative: no member signature, no debit');
  {
    const payer = payers[1], before = await balanceOf(payer.member.id);
    const { send } = await service.create(user(payer), await intentFor(payer, recipients[4], '700000'));
    const ready = await untilStatus(send.id, ['awaiting-signature'], payer);
    const c = ready.current.command;
    const forged = { command: c, public_key: payer.raw.toString('base64url'), signature: sign(null, signingBytes(c), reviewer.privateKey).toString('base64url') };
    const r1 = await rpc('broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(forged)).toString('base64') });
    assert.notEqual(r1.code, 0, 'forged signature accepted');
    const changed = structuredClone(c); changed.payload.approval.amount = '7000000';
    const r2 = await rpc('broadcast_tx_sync', { tx: Buffer.from(JSON.stringify(signedEnvelope(changed, payer.raw, payer.privateKey))).toString('base64') });
    let refusedByConsensus = r2.code !== 0;
    if (!refusedByConsensus) { const h = await tip(); await waitFor(async () => (await tip()) > h + 1); refusedByConsensus = (await record('private_boundary/' + c.payload.approval.effects)) === null; }
    assert.ok(refusedByConsensus, 'a command whose amount differs from the proof must not land');
    await service.cancel(user(payer), send.id, {});
    assert.equal(await balanceOf(payer.member.id), before);
    receipt.scenarios.negative = { forgedSignatureRefused: true, alteredAmountRefused: true, balanceUnchanged: true };
  }

  if (readerArg) {
    // Production checker path: the actual custody reviewer worker (send-inspect,
    // send-finalize) with the pinned reader, the real coin wallet and a signed AI
    // decision from a fictional broker key. Only the Python job store and the SSH
    // hop are emulated here (both are covered by ops/custody tests).
    stage('custody checker: the real reviewer worker approves one send');
    const reader = { executable: resolve(readerArg), executableSha256: sha(await readFile(resolve(readerArg))), genesis: join(home, 'config/genesis.json'), genesisSha256: native.pins.epoch, rpc: `http://127.0.0.1:${port}`, maxAgeSeconds: 120 };
    const broker = generateKeyPairSync('ed25519'), brokerPublic = broker.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
    const profile = { pins: { chainId: CHAIN, genesisSha256: native.pins.epoch }, reader, tools: { coinWallet: walletTool }, reviewer: reviewer.member.id, reviewerPublicKey: reviewer.member.public_key, relay: guardian.member.id, decisionPublicKey: brokerPublic };
    const reviewerSeed = reviewer.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
    const jobs = new Map(), actions = [];
    const rootAction = async (action, jobId, body) => {
      actions.push(action); const j = jobs.get(jobId) ?? {}; jobs.set(jobId, j);
      if (action === 'create') { j.context = body.context; return { status: 'created', jobId }; }
      if (action === 'send-ingest') { j.send = body; return { status: 'ingested' }; }
      if (action === 'inspect') { j.report = (await runReviewerAction({ action: 'send-inspect', jobId, profile, context: j.context, send: j.send })).report; return { status: 'inspected', inspectionDigest: j.report.inspectionDigest }; }
      if (action === 'finalize') return runReviewerAction({ action: 'send-finalize', jobId, profile, context: j.context, send: j.send, report: j.report, audit: j.audit, reviewerSeed });
      throw new Error('unexpected custody action ' + action);
    };
    const aiReview = async binding => {
      const j = jobs.get(binding.custodyJobId), report = j.report;
      assert.equal(binding.inspectionDigest, report.inspectionDigest); assert.equal(binding.owner, report.inspection.parties[0].member); assert.equal(binding.publicKey, report.inspection.parties[0].publicKey);
      assert.equal(binding.contextDigest, sha(canonicalJSON(report.inspection.context)));
      const decision = { class: 'neutral', statement: 'Fictional devnet decision: the payer signed this ordinary payment to the registered recipient.', checkedPurpose: report.inspection.context.purpose, ownerLicenceChecked: report.inspection.checks.ownerLicenceChecked, bothLicencesChecked: report.inspection.checks.bothLicencesChecked };
      const request = JSON.stringify({ schema: 'baink-private-ai-request-v1', jobId: binding.custodyJobId, inspectionDigest: report.inspectionDigest, report });
      const response = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: decision });
      const payload = { schema: 'baink-private-ai-decision-v1', jobId: binding.custodyJobId, inspectionDigest: report.inspectionDigest, provider: 'claude-code', model: 'claude-sonnet-5-5', completedAt: new Date().toISOString(), requestSha256: sha(request), responseSha256: sha(response), decision };
      j.audit = { attestation: { payload, signature: sign(null, privateAIMessageBytes(payload), broker.privateKey).toString('base64url') }, request, response };
      return { status: 'attested' };
    };
    const custodyChecker = createCustodySendChecker({ rootAction, aiReview, reviewerPublicKeyHex: reviewer.raw.toString('hex') });
    const custodyService = createServerSendService({ store, native, builder: createCoinWalletSendBuilder({ coinWallet: walletTool, checker: custodyChecker, workDirectory: work }), enabled: true, limits, allowedMembers: [payers[1].member.id, recipients[4].member.id] });
    const [payer, payee] = [payers[1], recipients[4]], before = await balanceOf(payer.member.id);
    await assert.rejects(custodyService.create(user(payers[2]), await intentFor(payers[2], payee, '1000')), e => e.code === 'server_send_not_open');
    const { send } = await custodyService.create(user(payer), await intentFor(payer, payee, '700000'));
    let row;
    for (let i = 0; i < 120 && !['awaiting-signature', 'checker-refused'].includes((row = custodyService.get(user(payer), send.id).send).status); i++) { await custodyService.tick({ max: 50 }); await pause(500); }
    assert.equal(row.status, 'awaiting-signature', JSON.stringify(row.lastError ?? row.checker));
    assert.deepEqual(actions, ['create', 'send-ingest', 'inspect', 'finalize']);
    await custodyService.sign(user(payer), send.id, await signPreparedCommand(await webIdentity(payer), row));
    for (let i = 0; i < 120 && (row = custodyService.get(user(payer), send.id).send).status !== 'finalized'; i++) { await custodyService.tick({ max: 50 }); await pause(1000); }
    assert.equal(row.status, 'finalized');
    assert.equal(await balanceOf(payer.member.id), before - 700000n);
    await custodyService.confirm(user(payee), send.id, await signReceipt(await webIdentity(payee), custodyService.get(user(payee), send.id).send));
    assert.equal(custodyService.get(user(payee), send.id).send.paid, true);
    done(payer, payee, 700000n);
    receipt.scenarios.custodyChecker = { effects: row.attempts.map(a => a.effects), worker: 'apps/baink/review-broker/reviewer-worker.mjs send-inspect/send-finalize', reader: 'pinned uain-private-state', aiDecision: 'fictional broker key', paid: true, attempts: row.attempts.length, notOpenRefused: true };
  }

  stage('conservation and node restart');
  const lastHeight = await tip();
  await stop(); start();
  // The light reader proves height H from the header of H+1: wait for two new
  // blocks so the last payment before the restart is inside the proven state.
  await waitFor(async () => (await tip()) > lastHeight + 2);
  const supplyAfter = await record('coin_supply');
  let sentTotal = 0n;
  for (const p of payers) { assert.equal(await balanceOf(p.member.id), 5000000n - paid.get(p.member.id)); sentTotal += paid.get(p.member.id); }
  assert.equal(supplyAfter.minted, supplyBefore.minted);
  assert.equal(BigInt(supplyAfter.transparent) + BigInt(supplyAfter.shielded), BigInt(supplyAfter.minted));
  assert.equal(BigInt(supplyAfter.shielded), sentTotal);
  receipt.conservation = { minted: supplyAfter.minted, transparent: supplyAfter.transparent, shielded: supplyAfter.shielded, sentTotal: String(sentTotal), payerBalances: Object.fromEntries(await Promise.all(payers.map(async p => [p.name, String(await balanceOf(p.member.id))]))) };

  if (readerArg && noteToolArg) {
    stage('recipients find their notes by trial decryption');
    const { lightScan, ownedNotes } = await import('../client/note-scan.mjs');
    const reader = { executable: resolve(readerArg), executableSha256: sha(await readFile(resolve(readerArg))), genesis: join(home, 'config/genesis.json'), genesisSha256: native.pins.epoch, rpc: `http://127.0.0.1:${port}`, maxAgeSeconds: 120 };
    const scan = await lightScan(reader);
    const noteTool = { executable: resolve(noteToolArg), executableSha256: sha(await readFile(resolve(noteToolArg))) };
    receipt.recipientNotes = {};
    for (const r of recipients) {
      const notes = await ownedNotes({ scan, noteTool, spendingKeyFile: orchard.get(r.member.id).file });
      if (notes.balanceUnits !== String(received.get(r.member.id))) console.error('NOTE_DEBUG', JSON.stringify({ name: r.name, expected: String(received.get(r.member.id)), notes: notes.notes, records: scan.records.map(x => ({ id: x.id, kind: x.kind, height: x.height })), count: scan.count, custody: receipt.scenarios.custodyChecker ?? null }));
      assert.equal(notes.balanceUnits, String(received.get(r.member.id)), r.name + ' note total');
      receipt.recipientNotes[r.name] = notes.balanceUnits;
    }
  }
  receipt.result = 'passed';
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  await writeFile(join(root, 'daemon.log'), log).catch(() => {});
  console.error(error); console.error('Disposable fixture diagnostics: ' + root); process.exitCode = 1;
} finally { await stop().catch(() => {}); }
