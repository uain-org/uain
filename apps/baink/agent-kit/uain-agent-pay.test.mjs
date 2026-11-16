// uain-agent payments over MCP against the real BAINK server code (in-process,
// temp data dir). The chain is an in-memory fake applying coin_shield rules;
// the builder is a fictional stand-in for the Orchard tool and the checker.
// The real Orchard chain path runs in chain/scripts/server-send-network-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, verify, createPublicKey } from 'node:crypto';
import { createBainkServer } from '../server/app.mjs';
import { chainCommandSigningBytes, coinBoundaryApprovalBytes } from '../server/server-send-crypto.mjs';
import * as kit from './uain-agent.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const E = 'e'.repeat(64);

async function fixture(t, { dropFirst = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'uain-agent-pay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const genesis = JSON.stringify({ chain_id: 'fictional-pay' }), genesisFile = join(dir, 'genesis.json'), binary = join(dir, 'reader');
  await writeFile(binary, 'synthetic pinned transport fixture', { mode: 0o700 });
  await writeFile(genesisFile, genesis, { mode: 0o600 });
  const o1 = { home: join(dir, 'h'), as: 'payer' }, o2 = { home: join(dir, 'h'), as: 'payee' };
  const payer = await kit.initIdentity(o1), payee = await kit.initIdentity(o2);
  const reviewerPair = generateKeyPairSync('ed25519'), reviewerRaw = reviewerPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const reviewer = 'uain1' + sha(reviewerRaw).slice(0, 40);
  const chain = { height: 20n };
  const records = {
    coin_activation: { policy: 'verified-bounties-108t-micro-v1', height: '5', evidence_digest: E },
    private_activation: { policy: 'orchard-v2-reviewed-otc-v1', height: '5', evidence_digest: E },
    coin_supply: { minted: '50000000', reserved: '0', transparent: '50000000', shielded: '0' },
    private_licence_revision: { value: '1' }, private_frontier: { root: 'f'.repeat(64), count: '0' },
    ['private_reviewer/' + reviewer]: { active: true },
    ['coin_balance/' + payer.address]: '50000000',
  };
  const members = {};
  for (const [address, key, karma] of [[payer.address, payer.publicKey, 0], [payee.address, payee.publicKey, 0], [reviewer, reviewerRaw.toString('base64url'), 200]]) members[address] = { id: address, public_key: key, sequence: '2', licence: 'active', karma };
  const transport = {
    profile: null, prepare: async () => {}, close: async () => {}, readBatch: async () => { throw Error('unused'); },
    async read(selection) {
      const out = { chain_id: 'fictional-pay', height: String(chain.height), header_time: new Date().toISOString(), app_hash: 'c'.repeat(64), event_count: '1', records: {} };
      for (const k of [...(selection.keys ?? []), 'guardians', 'legacy_import', 'event_count']) out.records[k] = k.startsWith('member/') ? structuredClone(members[k.slice(7)] ?? null) : structuredClone(records[k] ?? null);
      if (selection.member) out.member = structuredClone(members[selection.member] ?? null);
      out.queries = Object.keys(out.records).map((k) => ({ key: Buffer.from(k).toString('base64') }));
      return Buffer.from(JSON.stringify(out));
    },
  };
  let builds = 0, broadcasts = 0;
  const builder = {
    async build(input) {
      builds++;
      const effects = sha('fx' + input.intentId + input.attempt);
      const context = { version: 1, chain: input.chainId, expires: input.expiresHeight, licenceRevision: input.licenceRevision, effects, purpose: input.purposeCommitment, reviewer: reviewerRaw.toString('hex') };
      const approval = { reviewer, effects, purpose_commitment: input.purposeCommitment, class: 'neutral', expires_height: input.expiresHeight, licence_revision: input.licenceRevision, signature: sign(null, coinBoundaryApprovalBytes(context, { direction: 'shield', member: input.member, amount: input.amountUnits }, 'neutral'), reviewerPair.privateKey).toString('base64url'), direction: 'shield', member: input.member, amount: input.amountUnits };
      return { status: 'built', bundle: Buffer.from('bundle:' + input.recipientAddress + ':' + effects).toString('base64url'), approval };
    },
  };
  const sendTransport = {
    async broadcastShield(envelope) {
      broadcasts++;
      const c = envelope.command, a = c.payload.approval, m = members[c.member], transactionHash = sha(JSON.stringify(envelope)).toUpperCase();
      if (dropFirst && broadcasts === 1) throw Error('dropped');
      const ok = verify(null, chainCommandSigningBytes(c), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key }, format: 'jwk' }), Buffer.from(envelope.signature, 'base64url'))
        && c.sequence === m.sequence && BigInt(c.expires_height) >= chain.height && !records['private_boundary/' + a.effects] && BigInt(records['coin_balance/' + c.member] ?? '0') >= BigInt(a.amount);
      if (!ok) return { transactionHash, accepted: false, code: 5 };
      records['coin_balance/' + c.member] = String(BigInt(records['coin_balance/' + c.member]) - BigInt(a.amount));
      records['private_boundary/' + a.effects] = { bundle: c.payload.bundle, approval: a, height: String(chain.height) };
      m.sequence = String(BigInt(m.sequence) + 1n); chain.height += 1n;
      return { transactionHash, accepted: true, code: 0 };
    },
  };
  const rpc = createServer((req, res) => res.end('{}'));
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  const free = createServer(); await new Promise((r) => free.listen(0, '127.0.0.1', r)); const port = free.address().port; await new Promise((r) => free.close(r));
  const nativeConfig = { binary, binaryHash: sha('synthetic pinned transport fixture'), genesis: genesisFile, genesisHash: sha(genesis), chainId: 'fictional-pay', rpc: `http://127.0.0.1:${rpc.address().port}`, timeoutMs: 3000, maxAgeSeconds: 120 };
  transport.profile = { chainId: nativeConfig.chainId, genesisSha256: nativeConfig.genesisHash, verifierSha256: nativeConfig.binaryHash, maxAgeSeconds: 120 };
  const url = `http://127.0.0.1:${port}`;
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, nativeConfig, nativeStateTransport: transport, serverSendEnabled: true, serverSendTickMs: 0, serverSend: { builder, transport: sendTransport, addressFromKey: async (fvk) => (sha('fvk:' + fvk) + sha(fvk)).slice(0, 86) } });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections?.(); await app.close(); await new Promise((r) => rpc.close(r)); });
  for (const o of [o1, o2]) Object.assign(o, { url, pollMs: 50 });
  await kit.ops.account(o1, { name: 'Paying agent' }); await kit.ops.account(o2, { name: 'Paid agent' });
  return { o1, o2, payer, payee, records, chain, get builds() { return builds; }, get broadcasts() { return broadcasts; } };
}

test('an agent pays another agent over MCP; the recipient confirms; one debit', async (t) => {
  const f = await fixture(t);
  const address = randomBytes(43).toString('hex');
  const reg = await kit.handleMcp(f.o2, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_agent_receiving_address', arguments: { address, confirm: true } } });
  assert.ok(!reg.result.isError, reg.result.content[0].text);
  const unconfirmed = await kit.handleMcp(f.o1, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'baink_agent_pay', arguments: { to: f.payee.address, amount: '12.5' } } });
  assert.equal(JSON.parse(unconfirmed.result.content[0].text).error, 'confirmation_required');
  const paid = await kit.handleMcp(f.o1, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'baink_agent_pay', arguments: { to: f.payee.address, amount: '12.5', memo: 'for the survey', waitSeconds: 20, confirm: true } } });
  const out = JSON.parse(paid.result.content[0].text);
  assert.equal(out.status, 'finalized', paid.result.content[0].text);
  assert.match(out.note, /do not pay again/, 'a finalized payment the recipient has not confirmed yet says so plainly');
  assert.equal(f.records['coin_balance/' + f.payer.address], '37500000');
  const seen = await kit.ops.payments(f.o2);
  assert.equal(seen.payments[0].direction, 'in'); assert.match(seen.payments[0].next, /payment_received/);
  const confirmed = await kit.handleMcp(f.o2, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'baink_agent_payment_received', arguments: { send: out.send, confirm: true } } });
  assert.equal(JSON.parse(confirmed.result.content[0].text).paid, true);
  // Paying the same again is a new intent (new nonce), never a replay of the first.
  assert.equal(f.broadcasts, 1);
});

test('a dropped send is proved unused after expiry and retried automatically, paid once', async (t) => {
  const f = await fixture(t, { dropFirst: true });
  await kit.ops.receivingAddress(f.o2, { address: randomBytes(43).toString('hex') });
  const first = await kit.ops.pay(f.o1, { to: f.payee.address, amount: '3', waitSeconds: 1 });
  assert.notEqual(first.status, 'finalized');
  f.chain.height += 200n; // past the attempt's expiry; record absent, sequence unchanged
  let row;
  for (let i = 0; i < 6 && row?.status !== 'finalized'; i++) row = (await kit.ops.payments(f.o1)).payments.find((p) => p.send === first.send);
  assert.equal(row.status, 'finalized'); assert.equal(row.attempts, 2);
  assert.equal(f.records['coin_balance/' + f.payer.address], '47000000');
});

test('paying a request uses its amount and payee; insufficient balance is refused before anything is signed', async (t) => {
  const f = await fixture(t);
  await kit.ops.receivingAddress(f.o2, { address: randomBytes(43).toString('hex') });
  const payeeId = await kit.loadIdentity(f.o2);
  const req = await kit.api(f.o2, 'POST', '/api/requests', { to: f.payer.address, amount: '2', memo: 'trade request', clientRequestId: 'kit-request-0001' }, payeeId);
  const r = await kit.ops.pay(f.o1, { request: req.request.id, waitSeconds: 20 });
  assert.equal(r.status, 'finalized'); assert.equal(r.request, req.request.id);
  await kit.ops.paymentReceived(f.o2, { send: r.send });
  const list = await kit.api(f.o1, 'GET', '/api/requests?direction=incoming', undefined, await kit.loadIdentity(f.o1));
  assert.equal(list.requests.find((x) => x.id === req.request.id).status, 'paid');
  await assert.rejects(kit.ops.pay(f.o1, { to: f.payee.address, amount: '100' }), (e) => e.code === 'insufficient_balance');
});

// Checked against orchard 0.16.0 (`uain-coin-wallet viewing-key`) on 9 Nov 2026:
// 40 random keys, identical raw full viewing keys. Throwaway test keys.
const ORCHARD_VECTORS = [["32f193499b60953d05d1bd32f8d0d0e407add476e666c6966a69e75439827c23","3295910521ba567a46b48999fb3ecd887007fb40d37d1453dfd46ff4d29ada1191ec821487b07ff140d0bfeef7415d0b49cc4fb76c22ff759d58de4f9e96cd233fe7f41f43844036cc558a74273e728127d9c3e95e3cdca8820a91ccf8c10420"],["b7539d852d8da893ccb86cf69dd318eb77337cb7fd074a64a0c54a675c8b3ff1","b94ce312faf273eb13f63679726828c082abaa4d0b82e28002a6e4212cc70a32a0f725bd47d14bf8ddd977bc7adcb6ae1bb0dd0dd4797db50383e847f6ca6d09675c9e6e96bd830964e622c59dc86599c59e60fda2b6aa29646aa011eed1e90b"],["bfd37041e0a7b750efd0cdb1ae65ae10dce3af564b7da50aacce1078da417d5e","ef1fb53563d99940941f879bee57a777219ff8a288920904110f0b1a11ca2d03f354e94a0353021764dff5abfe1a6e0e6b759febf2f9ab2b499a25943f8a021e2afac02dad4bce9a861bb561aa33c2cbd54330b5897ef445e718275442229706"]];
test('the kit derives the same Orchard full viewing key as the orchard crate', () => {
  for (const [sk, fvk] of ORCHARD_VECTORS) assert.equal(Buffer.from(kit.orchardFullViewingKey(Uint8Array.from(Buffer.from(sk, 'hex')))).toString('hex'), fvk);
  assert.throws(() => kit.orchardFullViewingKey(new Uint8Array(31)));
});

test('no install: the payee sets up receiving over MCP, keeps its key, and is paid', async (t) => {
  const f = await fixture(t);
  const before = await kit.ops.receivingAddress(f.o2, {});
  assert.equal(before.address, null); assert.match(before.next, /setup: true/);
  await assert.rejects(kit.ops.pay(f.o1, { to: f.payee.address, amount: '1' }), (e) => e.code === 'recipient_address_unregistered');
  const reg = await kit.handleMcp(f.o2, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_agent_receiving_address', arguments: { setup: true, confirm: true } } });
  const out = JSON.parse(reg.result.content[0].text);
  assert.ok(!reg.result.isError, reg.result.content[0].text);
  assert.equal(out.kind, 'key'); assert.match(out.address, /^[a-f0-9]{86}$/);
  const id2 = await kit.loadIdentity(f.o2);
  assert.equal(out.address.length, 86);
  assert.equal(await kit.receivingViewingKey(id2), await kit.receivingViewingKey(await kit.loadIdentity(f.o2)), 'deterministic from the member key');
  assert.notEqual(await kit.receivingViewingKey(id2), await kit.receivingViewingKey(await kit.loadIdentity(f.o1)));
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(join(f.o2.home, 'payee')).filter((n) => /orchard|receiv/.test(n)), [], 'no extra key file to back up');
  const again = await kit.ops.receivingAddress(f.o2, { setup: true });
  assert.equal(again.address, out.address, 'setup is idempotent: the same key, the same address');
  const r = await kit.ops.pay(f.o1, { to: f.payee.address, amount: '4', waitSeconds: 20 });
  assert.equal(r.status, 'finalized');
  assert.equal(f.records['coin_balance/' + f.payer.address], '46000000');
  assert.equal((await kit.ops.paymentReceived(f.o2, { send: r.send })).paid, true);
});

test('pay settles open sent steps first and signs nothing while one stays open', async (t) => {
  const f = await fixture(t);
  await kit.ops.receivingAddress(f.o2, { address: randomBytes(43).toString('hex') });
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const file = join(f.o1.home, 'payer', 'journal.json');
  const journal = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, steps: {}, ids: {} };
  const stuck = '00000000-0000-4000-8000-00000000abcd';
  journal.steps[stuck] = { intent: stuck, kind: 'central', operation: 'central_submit', target: 'submit:T-x', status: 'accepted' };
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  await assert.rejects(kit.ops.pay(f.o1, { to: f.payee.address, amount: '1' }), (e) => e.code === 'step_unsettled' && e.message.includes(stuck));
  assert.equal(f.builds, 0, 'nothing was signed or built');
  delete journal.steps[stuck]; writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  assert.equal((await kit.ops.pay(f.o1, { to: f.payee.address, amount: '1', waitSeconds: 20 })).status, 'finalized');
});

test('pay follows one payment with one signed call per poll, and a nonce-limit answer means "still in progress", never a second payment', async (t) => {
  const f = await fixture(t);
  await kit.ops.receivingAddress(f.o2, { address: randomBytes(43).toString('hex') });
  const seen = [];
  const base = f.o1.fetch ?? fetch;
  // Every signed BAINK call holds one of the member's 128 five-minute nonces (10 November real-daemon run).
  f.o1.fetch = (url, init) => { if (init?.headers?.['X-BAINK-Nonce']) seen.push(`${init.method} ${new URL(url).pathname}`); return base(url, init); };
  const r = await kit.ops.pay(f.o1, { to: f.payee.address, amount: '1', waitSeconds: 20 });
  assert.equal(r.status, 'finalized');
  const following = seen.slice(seen.indexOf('POST /api/native/sends') + 1);
  assert.equal(following.filter((x) => x === 'GET /api/native/sends').length, 0, 'no list reads while following one payment');
  assert.ok(following.every((x) => x.startsWith(`POST /api/native/sends/${r.send}/`)), following.join(', '));
  // BAINK answers 429 member_nonce_limit while a payment is under way: pay returns it as in progress.
  f.o1.fetch = (url, init) => /\/api\/native\/sends\/[a-f0-9]{64}\//.test(new URL(url).pathname)
    ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'member_nonce_limit', message: 'Too many outstanding signed operations for this identity.' } }), { status: 429, headers: { 'content-type': 'application/json' } }))
    : base(url, init);
  const busy = await kit.ops.pay(f.o1, { to: f.payee.address, amount: '1', waitSeconds: 20 });
  assert.notEqual(busy.status, 'finalized');
  assert.match(busy.note, /do not pay again/);
  f.o1.fetch = base;
  const later = (await kit.ops.payments(f.o1)).payments.find((p) => p.send === busy.send);
  assert.ok(later, 'the payment is still followed by baink_agent_payments');
});
