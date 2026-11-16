// No-install sending: service-level fault matrix against a fake ledger that
// applies coin_shield consensus rules (signature, sequence, expiry, balance,
// single-use effects). The real Orchard chain runs in
// chain/scripts/server-send-network-smoke.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signingBytes } from '../../../chain/client/signing.mjs';
import { coinBoundaryApprovalBytes } from '../../../chain/client/coin-boundary.mjs';
import { hasPendingNativeSend } from '../server/native-sequence-fence.mjs';
import { createServerSendService, sendIntentBytes, sendIntentId, sendConfirmationBytes, receivingAddressBytes, sendPurposeCommitment, verifySendCommand } from '../server/server-send.mjs';

const hash = v => createHash('sha256').update(v).digest('hex');
const CHAIN = 'send-test', EPOCH = 'a'.repeat(64);
function person() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { ...pair, raw, publicKey: raw.toString('base64'), address: 'uain1' + hash(raw).slice(0, 40), orchard: randomBytes(43).toString('hex') };
}
const rejects = (p, code) => assert.rejects(p, e => e.code === code);

function ledger(people, reviewer, clock = () => Date.now()) {
  const s = { height: 100n, members: {}, balances: {}, records: {}, supply: { transparent: 0n, shielded: 0n }, mode: 'ok', broadcasts: 0 };
  for (const p of [...people, reviewer]) s.members[p.address] = { id: p.address, public_key: p.raw.toString('base64url'), sequence: '3', licence: 'active', karma: 200 };
  s.records['private_reviewer/' + reviewer.address] = { active: true };
  s.records.private_licence_revision = { value: '1' };
  s.records.private_frontier = { root: 'f'.repeat(64), count: '0' };
  s.records.private_activation = { policy: 'orchard-v2-reviewed-otc-v1', height: '1' };
  s.records.coin_activation = { policy: 'verified-bounties-108t-micro-v1', height: '1' };
  function credit(a, n) { s.balances[a] = (s.balances[a] ?? 0n) + n; s.supply.transparent += n; }
  function apply(envelope) {
    const c = envelope.command, m = s.members[c.member], a = c.payload.approval;
    if (!verify(null, signingBytes(c), { key: { kty: 'OKP', crv: 'Ed25519', x: envelope.public_key }, format: 'jwk' }, Buffer.from(envelope.signature, 'base64url'))) return 4;
    if ('uain1' + hash(Buffer.from(envelope.public_key, 'base64url')).slice(0, 40) !== c.member) return 4;
    if (c.sequence !== m.sequence) return 32;
    if (BigInt(c.expires_height) < s.height) return 33;
    if (a.member !== c.member || a.direction !== 'shield') return 34;
    if (s.records['private_boundary/' + a.effects]) return 35;
    const amount = BigInt(a.amount);
    if ((s.balances[c.member] ?? 0n) < amount) return 36;
    s.balances[c.member] -= amount; s.supply.transparent -= amount; s.supply.shielded += amount;
    s.records['private_boundary/' + a.effects] = { bundle: c.payload.bundle, approval: a, height: String(s.height) };
    m.sequence = String(BigInt(m.sequence) + 1n);
    s.notes = [...(s.notes ?? []), { to: c.payload.bundle, amount }];
    return 0;
  }
  const native = {
    configured: true, timeoutMs: 1000, pins: { chainId: CHAIN, epoch: EPOCH, verifierSha256: 'b'.repeat(64) },
    async publicState(sel) {
      if (s.mode === 'reader-down') throw Error('down');
      const records = {};
      for (const k of sel.keys ?? []) records[k] = s.mode === 'hide-record' && k.startsWith('private_boundary/') ? null : k.startsWith('coin_balance/') ? (s.balances[k.slice(13)] === undefined ? null : String(s.balances[k.slice(13)])) : k.startsWith('member/') ? structuredClone(s.members[k.slice(7)] ?? null) : structuredClone(s.records[k] ?? null);
      return { state: { chain_id: CHAIN, height: String(s.height), app_hash: 'c'.repeat(64), member: sel.member ? structuredClone(s.members[sel.member]) : undefined, records }, proof: { authority: 'native', chainId: CHAIN, epoch: EPOCH, verifierSha256: 'b'.repeat(64), headerTime: new Date(clock()).toISOString(), maxAgeSeconds: 120, height: String(s.height), appHash: 'c'.repeat(64) } };
    },
    async broadcastShield(envelope) {
      s.broadcasts++;
      const transactionHash = hash(JSON.stringify(envelope)).toUpperCase();
      if (s.mode === 'drop') throw Error('timeout');                 // never reached the chain
      if (s.mode === 'lost-ack') { apply(envelope); throw Error('timeout'); } // included, reply lost
      const code = apply(envelope);
      return { transactionHash, accepted: code === 0, code };
    },
  };
  return { s, native, credit };
}

function fixture({ checkerQueue = false, extra = {} } = {}) {
  const payer = person(), payee = person(), reviewer = person(), other = person();
  let clock = Date.now();
  const { s, native, credit } = ledger([payer, payee, other], reviewer, () => clock);
  credit(payer.address, 200_000000n);
  let data = { requests: {} }, tail = Promise.resolve(), builds = 0, queued = checkerQueue, lastBuild = null;
  const store = { read: () => structuredClone(data), transact(fn) { const t = tail.then(() => { const next = structuredClone(data), v = fn(next); data = next; return structuredClone(v); }); tail = t.catch(() => {}); return t; } };
  const builder = {
    async build(input) {
      builds++; lastBuild = input;
      if (queued) return { status: 'queued', retryAt: new Date(Date.now() + 1000).toISOString() };
      const effects = hash('effects' + input.intentId + input.attempt);
      const context = { version: 1, chain: input.chainId, expires: input.expiresHeight, licenceRevision: input.licenceRevision, effects, purpose: input.purposeCommitment, reviewer: reviewer.raw.toString('hex') };
      const approval = { reviewer: reviewer.address, effects, purpose_commitment: input.purposeCommitment, class: 'neutral', expires_height: input.expiresHeight, licence_revision: input.licenceRevision, signature: sign(null, coinBoundaryApprovalBytes(context, { direction: 'shield', member: input.member, amount: input.amountUnits }, 'neutral'), reviewer.privateKey).toString('base64url'), direction: 'shield', member: input.member, amount: input.amountUnits };
      return { status: 'built', bundle: Buffer.from(input.recipientAddress + ':' + input.amountUnits).toString('base64url'), approval };
    },
  };
  const make = () => createServerSendService({ store, native, builder, enabled: true, now: () => clock, limits: { maxNotAfterMs: 86400000, activePerPayer: 4, acceptedPerDay: 48, retainedPerPayer: 512, global: 20000, activeGlobal: 200, attemptBlocks: 60n, rebroadcastMs: 0, memoBytes: 200 } , ...extra });
  let service = make();
  const user = p => ({ address: p.address, publicKey: p.publicKey });
  return {
    payer, payee, other, reviewer, s, store, credit, native, builder,
    get service() { return service; }, get builds() { return builds; }, get lastBuild() { return lastBuild; },
    restart() { service = make(); }, unqueue() { queued = false; }, advance(ms) { clock += ms; },
    user,
    async register(p = payee) { return service.registerReceivingAddress(user(p), { address: p.orchard, signature: sign(null, receivingAddressBytes({ member: p.address, address: p.orchard, chainId: CHAIN }), p.privateKey).toString('base64url') }); },
    intent(over = {}) { return { schema: 'baink-send-intent-v1', chainId: CHAIN, genesisSha256: EPOCH, from: payer.address, to: payee.address, recipientAddress: payee.orchard, amountUnits: '25000000', nonce: randomBytes(16).toString('hex'), notAfter: new Date(clock + 3600000).toISOString(), requestId: null, memo: 'for the review', ...over }; },
    signed(intent, by = payer) { return { intent, signature: sign(null, sendIntentBytes(intent), by.privateKey).toString('base64url') }; },
    /** What the browser does: check the prepared command against its intent, then sign. */
    browserSign(record, by = payer) { const a = record.attempts.at(-1); const bytes = verifySendCommand(record, a.command); assert.equal(bytes.toString('base64'), a.signingBytesBase64); return { attempt: a.n, signature: sign(null, bytes, by.privateKey).toString('base64url') }; },
  };
}
async function sendOnce(f, over = {}) {
  await f.register();
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent(over)));
  await f.service.build(send.id);
  const { send: ready } = f.service.get(f.user(f.payer), send.id);
  assert.equal(ready.status, 'awaiting-signature');
  return ready;
}

test('earn -> pay -> recipient confirms: one debit, conserved supply', async () => {
  const f = fixture();
  const before = { ...f.s.supply };
  const ready = await sendOnce(f);
  const signed = await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  assert.equal(signed.send.status, 'submitted');
  await f.service.reconcile(ready.id);
  const { send } = f.service.get(f.user(f.payee), ready.id);
  assert.equal(send.status, 'finalized'); assert.equal(send.paid, false);
  assert.equal(send.attempts[0].command, undefined, 'the payee never sees the payer command');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
  assert.equal(f.s.supply.transparent + f.s.supply.shielded, before.transparent + before.shielded);
  assert.equal(f.s.supply.shielded, 25_000000n);
  const done = await f.service.confirm(f.user(f.payee), ready.id, { signature: sign(null, sendConfirmationBytes(send), f.payee.privateKey).toString('base64url') });
  assert.equal(done.send.paid, true);
});

test('duplicate submit, reload and duplicate signature never debit twice', async () => {
  const f = fixture();
  await f.register();
  const body = f.signed(f.intent());
  const a = await f.service.create(f.user(f.payer), body), b = await f.service.create(f.user(f.payer), body);
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.send.id, b.send.id);
  assert.equal(a.send.id, sendIntentId(body.intent));
  await Promise.all([f.service.build(a.send.id), f.service.build(a.send.id)]);
  const ready = f.service.get(f.user(f.payer), a.send.id).send;
  assert.equal(ready.attempts.length, 1);
  const sig = f.browserSign(ready);
  await f.service.sign(f.user(f.payer), ready.id, sig);
  const again = await f.service.sign(f.user(f.payer), ready.id, sig);
  assert.equal(again.attempted, false);
  f.restart(); // server restart: the journal is the store
  await f.service.tick(); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
  // Same nonce with different content is refused.
  await rejects(f.service.create(f.user(f.payer), f.signed({ ...body.intent, amountUnits: '1' })), 'send_nonce_reused');
});

test('crash mid-send: reply lost after inclusion is reconciled, never re-debited', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.s.mode = 'lost-ack';
  const r = await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  assert.equal(r.send.status, 'unknown');
  f.s.mode = 'ok'; f.restart();
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
});

test('dropped broadcast is re-sent with identical bytes, then finalizes', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.s.mode = 'drop';
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  f.s.mode = 'ok';
  await f.service.tick(); // reconcile: absent, not expired -> identical re-broadcast
  await f.service.tick();
  const { send } = f.service.get(f.user(f.payer), ready.id);
  assert.equal(send.status, 'finalized'); assert.equal(send.attempts.length, 1);
  assert.ok(send.attempts[0].broadcasts.length >= 2);
  assert.equal(new Set(send.attempts[0].broadcasts.map(() => send.attempts[0].transactionHash)).size, 1);
});

test('expired attempt is proved unincluded, rebuilt, re-signed and paid once', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.s.mode = 'drop';
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  f.s.height += 61n; // past expires_height, sequence unchanged, record absent
  await f.service.tick();
  let { send } = f.service.get(f.user(f.payer), ready.id);
  assert.equal(send.attempts[0].status, 'expired-unused');
  assert.equal(send.attempts[0].recovery.recordPresent, false);
  f.s.mode = 'ok';
  await f.service.tick(); // builds attempt 2
  send = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(send.status, 'awaiting-signature'); assert.equal(send.attempts.length, 2);
  // The expired bytes can never be used again.
  assert.notEqual(send.attempts[0].effects, send.attempts[1].effects);
  await f.service.sign(f.user(f.payer), send.id, f.browserSign(send));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), send.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
});

test('an expired intent ends and releases its reservation', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.advance(3600001);
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'expired');
  await rejects(f.service.create(f.user(f.payer), f.signed({ ...f.intent(), notAfter: new Date(Date.now() - 1000).toISOString() })), 'send_intent_expired');
  // The full balance is available again.
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '200000000' })));
  assert.equal(send.status, 'accepted');
});

test('conservation: reservations never exceed the proven balance', async () => {
  const f = fixture();
  await f.register();
  await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '150000000' })));
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '60000000' }))), 'insufficient_balance');
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '50000000' })));
  assert.equal(send.status, 'accepted');
});

test('the server cannot move funds without the member signature', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  const a = ready.attempts[0];
  // A server (or anyone) holding every artefact except the payer key:
  const forged = { command: a.command, public_key: f.payer.raw.toString('base64url'), signature: sign(null, Buffer.from(a.signingBytesBase64, 'base64'), f.other.privateKey).toString('base64url') };
  const own = { command: { ...a.command, member: f.other.address }, public_key: f.other.raw.toString('base64url'), signature: sign(null, signingBytes({ ...a.command, member: f.other.address }), f.other.privateKey).toString('base64url') };
  const before = f.s.balances[f.payer.address];
  // Consensus refuses a forged payer signature and a re-signed command under another member.
  assert.equal((await f.native.broadcastShield(forged)).accepted, false);
  assert.equal((await f.native.broadcastShield(own)).accepted, false);
  assert.equal(f.s.balances[f.payer.address], before);
  await rejects(f.service.sign(f.user(f.payer), ready.id, { attempt: a.n, signature: forged.signature }), 'invalid_send_signature');
  await rejects(f.service.sign(f.user(f.other), ready.id, f.browserSign(ready, f.other)), 'send_intent_missing');
  // A command that differs from the signed intent is refused by the browser check.
  assert.throws(() => verifySendCommand(ready, { ...a.command, payload: { ...a.command.payload, approval: { ...a.command.payload.approval, amount: '1' } } }), e => e.code === 'send_command_mismatch');
  assert.throws(() => verifySendCommand(ready, { ...a.command, member: f.other.address }), e => e.code === 'send_command_mismatch');
  assert.equal(f.s.balances[f.payer.address], before);
});

test('intent signature, network, recipient address and limits are enforced', async () => {
  const f = fixture();
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent())), 'recipient_address_unregistered');
  await f.register();
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent(), f.other)), 'invalid_send_signature');
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ chainId: 'other-net' }))), 'send_network_mismatch');
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ recipientAddress: f.other.orchard }))), 'recipient_address_unregistered');
  await rejects(f.service.create(f.user(f.other), f.signed(f.intent())), 'send_payer_required');
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ notAfter: new Date(Date.now() + 3 * 86400000).toISOString() }))), 'send_intent_expired');
  for (let i = 0; i < 4; i++) await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '1000000' })));
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '1000000' }))), 'send_active_limit');
});

test('checker capacity queues honestly and resumes', async () => {
  const f = fixture({ checkerQueue: true });
  await f.register();
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
  await f.service.build(send.id);
  let row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'queued-checker-capacity'); assert.ok(row.checker.retryAt);
  f.unqueue(); f.advance(2000);
  await f.service.tick();
  row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'awaiting-signature');
});

test('cancel before signing; after signing only once proved dead', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  const c = await f.service.cancel(f.user(f.payer), ready.id, {});
  assert.equal(c.send.status, 'cancelled');
  const second = await sendOnce(f);
  f.s.mode = 'drop';
  await f.service.sign(f.user(f.payer), second.id, f.browserSign(second));
  const pending = await f.service.cancel(f.user(f.payer), second.id, {});
  assert.equal(pending.send.status, 'cancel-requested');
  f.s.height += 61n;
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), second.id).send.status, 'cancelled');
  assert.equal(f.s.balances[f.payer.address], 200_000000n);
});

test('Trade-style request: pay once, paid=true after the recipient confirms, lock released on cancel', async () => {
  const f = fixture();
  await f.store.transact(s => { s.requests.r1 = { id: 'r1', from: f.payee.address, to: f.payer.address, amount: '25', currency: 'AI$', memo: '', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
  await f.register();
  const first = await f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' })));
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_locked');
  await f.service.cancel(f.user(f.payer), first.send.id, {});
  const ready = await sendOnce(f, { requestId: 'r1' });
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  await f.service.tick();
  const { send } = f.service.get(f.user(f.payee), ready.id);
  assert.equal(f.store.read().requests.r1.status, 'open');
  // Paid on the ledger but not yet confirmed by the payee: a second send for the same
  // request is refused, so the payer is never debited twice (security review, 10 Nov).
  assert.equal(send.status, 'finalized');
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_paid');
  assert.equal(f.store.read().serverSendRequestLocks.r1, ready.id);
  await f.service.confirm(f.user(f.payee), ready.id, { signature: sign(null, sendConfirmationBytes(send), f.payee.privateKey).toString('base64url') });
  const request = f.store.read().requests.r1;
  assert.equal(request.status, 'paid'); assert.equal(request.settlement.kind, 'native-server-send');
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_changed');
  // Wrong amount for a request is refused.
  await f.store.transact(s => { s.requests.r2 = { ...s.requests.r1, id: 'r2', status: 'open', amount: '3' }; delete s.requests.r2.settlement; });
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r2' }))), 'payment_request_changed');
});

test('a request paid on the ledger but not yet confirmed is never paid again (production, 10 November)', async () => {
  const f = fixture();
  await f.store.transact(s => { s.requests.r1 = { id: 'r1', from: f.payee.address, to: f.payer.address, amount: '25', currency: 'AI$', memo: '', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
  const ready = await sendOnce(f, { requestId: 'r1' });
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.store.read().requests.r1.status, 'open', 'the request waits for the recipient');
  // Paying the open request again is refused before anything is built or signed.
  await assert.rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), e => e.code === 'payment_request_paid' && /do not pay it again/.test(e.message));
  // Even when a later attempt took the lock over (the production state), the finalized send still blocks.
  const stray = f.signed(f.intent({ requestId: 'r1', amountUnits: '1' }));
  await f.store.transact(s => { const id = sendIntentId(stray.intent); s.serverSendIntents[id] = { ...structuredClone(s.serverSendIntents[ready.id]), id, intent: stray.intent, status: 'checker-refused', attempts: [], result: null }; s.serverSendRequestLocks.r1 = id; });
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_paid');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'debited once');
});

test('the attempt window is the longest the kit and the web sign (120 blocks)', async () => {
  const { SEND_LIMITS } = await import('../server/server-send.mjs');
  assert.equal(SEND_LIMITS.attemptBlocks, 120n);
});

test('many accounts send concurrently with exact conservation', async () => {
  const f = fixture();
  await f.register();
  const payers = Array.from({ length: 12 }, () => person());
  const { s } = f;
  for (const p of payers) { s.members[p.address] = { id: p.address, public_key: p.raw.toString('base64url'), sequence: '0', licence: 'active', karma: 0 }; f.credit(p.address, 10_000000n); }
  const supply = s.supply.transparent + s.supply.shielded;
  const rows = await Promise.all(payers.map(p => f.service.create(f.user(p), { intent: { ...f.intent({ from: p.address, amountUnits: '3000000' }) }, signature: null }).catch(() => null)));
  assert.ok(rows.every(r => r === null), 'unsigned intents are refused');
  const ids = [];
  for (const p of payers) { const intent = f.intent({ from: p.address, amountUnits: '3000000' }); ids.push((await f.service.create(f.user(p), { intent, signature: sign(null, sendIntentBytes(intent), p.privateKey).toString('base64url') })).send.id); }
  await f.service.tick({ max: 100 });
  for (const [i, id] of ids.entries()) { const row = f.service.get(f.user(payers[i]), id).send; await f.service.sign(f.user(payers[i]), id, f.browserSign(row, payers[i])); }
  await f.service.tick({ max: 100 });
  for (const [i, id] of ids.entries()) assert.equal(f.service.get(f.user(payers[i]), id).send.status, 'finalized');
  for (const p of payers) assert.equal(s.balances[p.address], 7_000000n);
  assert.equal(s.supply.transparent + s.supply.shielded, supply);
  assert.equal(s.supply.shielded, 36_000000n);
  assert.equal(sendPurposeCommitment(ids[0]).length, 64);
});

test('local byte formats match chain/client exactly', async () => {
  const local = await import('../server/server-send-crypto.mjs');
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const member = 'uain1' + hash(raw).slice(0, 40);
  const command = { version: 1, chain_id: CHAIN, member, sequence: '12', expires_height: '400', operation: 'coin_shield', payload: { bundle: 'QUJD', approval: { reviewer: member, effects: 'e'.repeat(64), purpose_commitment: 'f'.repeat(64), class: 'neutral', expires_height: '500', licence_revision: '0', signature: 'A'.repeat(86), direction: 'shield', member, amount: '7', memo_note: 'R&D <x>  ' } } };
  assert.deepEqual(local.chainCommandSigningBytes(command), signingBytes(command));
  const context = { version: 1, chain: CHAIN, expires: '500', licenceRevision: '0', effects: 'e'.repeat(64), purpose: 'f'.repeat(64), reviewer: raw.toString('hex') };
  for (const direction of ['shield', 'exit']) for (const cls of ['neutral', 'benevolent'])
    assert.deepEqual(local.coinBoundaryApprovalBytes(context, { direction, member, amount: '123456' }, cls), coinBoundaryApprovalBytes(context, { direction, member, amount: '123456' }, cls));
});

test('regression (9 Nov devnet): sequence advanced but record not visible is never a retry', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready)); // lands, sequence 3 -> 4
  f.s.mode = 'hide-record'; f.s.height += 61n;                           // an inconsistent read past expiry
  await f.service.tick(); await f.service.tick();
  let row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts.length, 1, 'no retry was built');
  assert.notEqual(row.attempts[0].status, 'expired-unused');
  assert.ok(row.attempts[0].sequenceConsumed);
  f.s.mode = 'ok';
  await f.service.tick();
  row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'debited exactly once');
});

test('no-install receiving key: signed viewing key, tool-derived address, evidence for the checker', async () => {
  const { receivingKeyBytes } = await import('../server/server-send.mjs');
  const derived = randomBytes(43).toString('hex'), seen = [];
  const f = fixture({ extra: { addressFromKey: async fvk => { seen.push(fvk); if (fvk.startsWith('00')) throw Error('full viewing key refused by the coin wallet'); return derived; } } });
  const fvk = 'ab'.repeat(96), body = k => ({ fullViewingKey: k, signature: sign(null, receivingKeyBytes({ member: f.payee.address, fullViewingKey: k, chainId: CHAIN }), f.payee.privateKey).toString('base64url') });
  await rejects(f.service.registerReceivingKey(f.user(f.payee), { ...body(fvk), signature: body('cd'.repeat(96)).signature }), 'invalid_receiving_key');
  await rejects(f.service.registerReceivingKey(f.user(f.payee), body('00'.repeat(96))), 'receiving_key_invalid');
  const saved = await f.service.registerReceivingKey(f.user(f.payee), body(fvk));
  assert.deepEqual([saved.address, saved.kind], [derived, 'key']);
  await f.service.registerReceivingKey(f.user(f.payee), body(fvk));
  assert.equal(seen.filter(k => k === fvk).length, 1, 'the same key is derived once');
  const own = f.service.receivingAddress(f.user(f.payee), f.payee.address);
  assert.deepEqual([own.address, own.kind, own.canReceive], [derived, 'key', true]);
  assert.equal(f.service.receivingAddress(f.user(f.payer), f.payee.address).canReceive, undefined);
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent({ recipientAddress: derived })));
  await f.service.build(send.id);
  assert.deepEqual(f.lastBuild.evidence.registration, { kind: 'key', fullViewingKey: fvk, publicKey: f.payee.publicKey, signature: body(fvk).signature });
});

test('two sends built at one sequence: the stale one is never relayed, then rebuilt and paid once (security review, 10 Nov)', async () => {
  const f = fixture();
  await f.register();
  const a = (await f.service.create(f.user(f.payer), f.signed(f.intent()))).send;
  const b = (await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '10000000' })))).send;
  await f.service.build(a.id); await f.service.build(b.id);
  const readyA = f.service.get(f.user(f.payer), a.id).send, readyB = f.service.get(f.user(f.payer), b.id).send;
  assert.equal(readyA.attempts[0].command.sequence, '3'); assert.equal(readyB.attempts[0].command.sequence, '3');
  await f.service.sign(f.user(f.payer), a.id, f.browserSign(readyA));       // lands, sequence 3 -> 4
  await f.service.reconcile(a.id);
  assert.equal(f.service.get(f.user(f.payer), a.id).send.status, 'finalized');
  const relays = f.s.broadcasts;
  await f.service.sign(f.user(f.payer), b.id, f.browserSign(readyB));       // its sequence is used: not relayed
  assert.equal(f.s.broadcasts, relays, 'stale bytes are never relayed');
  let row = f.store.read().serverSendIntents[b.id];
  assert.equal(row.attempts[0].sendAttemptedAt, null);
  assert.equal(hasPendingNativeSend(f.store.read(), f.payer.address), false, 'the payer\'s sequence fence stays open');
  f.s.height += 61n;                                                        // past the stale attempt's expiry
  await f.service.tick(); await f.service.tick();
  row = f.service.get(f.user(f.payer), b.id).send;
  assert.equal(row.attempts[0].status, 'expired-unused'); assert.equal(row.attempts[0].recovery.neverRelayed, true);
  assert.equal(row.status, 'awaiting-signature'); assert.equal(row.attempts[1].command.sequence, '4');
  await f.service.sign(f.user(f.payer), b.id, f.browserSign(row));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), b.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 165_000000n, 'each send debited exactly once');
});

test('a signed send cancelled before any relay is never relayed and ends cancelled (security review, 10 Nov)', async () => {
  const f = fixture();
  await f.register();
  const a = (await f.service.create(f.user(f.payer), f.signed(f.intent()))).send;
  const b = (await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '10000000' })))).send;
  await f.service.build(a.id); await f.service.build(b.id);
  const readyB = f.service.get(f.user(f.payer), b.id).send;
  await f.service.sign(f.user(f.payer), a.id, f.browserSign(f.service.get(f.user(f.payer), a.id).send));
  await f.service.reconcile(a.id);
  await f.service.sign(f.user(f.payer), b.id, f.browserSign(readyB));       // stale: signed, not relayed
  const relays = f.s.broadcasts;
  await f.service.cancel(f.user(f.payer), b.id, {});
  assert.equal(f.service.get(f.user(f.payer), b.id).send.status, 'cancel-requested');
  await f.service.tick();
  assert.equal(f.s.broadcasts, relays, 'no relay after cancel');
  f.s.height += 61n;
  await f.service.tick(); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), b.id).send.status, 'cancelled');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'only the first send was debited');
  assert.equal(hasPendingNativeSend(f.store.read(), f.payer.address), false);
});

test('an unreadable proof at signing time defers the relay instead of failing the signature (security review, 10 Nov)', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.s.mode = 'reader-down';
  const signed = await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  assert.equal(signed.attempted, true);
  assert.equal(f.s.broadcasts, 0);
  f.s.mode = 'ok';
  await f.service.tick(); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
});

test('a confirm that cannot mark the request paid keeps its lock, so the request is never paid twice (security review, 10 Nov)', async () => {
  const f = fixture();
  await f.store.transact(s => { s.requests.r1 = { id: 'r1', from: f.payee.address, to: f.payer.address, amount: '25', currency: 'AI$', memo: '', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
  const ready = await sendOnce(f, { requestId: 'r1' });
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  await f.service.tick();
  await f.store.transact(s => { s.requests.r1.status = 'expired'; });           // the deal sweep expired it before the payee confirmed
  const { send } = f.service.get(f.user(f.payee), ready.id);
  await f.service.confirm(f.user(f.payee), ready.id, { signature: sign(null, sendConfirmationBytes(send), f.payee.privateKey).toString('base64url') });
  assert.equal(f.store.read().requests.r1.status, 'expired');
  assert.equal(f.store.read().serverSendRequestLocks.r1, ready.id, 'the landed payment keeps holding the request');
  await f.store.transact(s => { s.requests.r1.status = 'open'; });              // a steward reopens it
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_paid');
});

test('a held central-earning intent is settled from chain state before the send is built (self-clearing fence)', async () => {
  let calls = 0, settle = false, f;
  const holdFor = (member) => f.store.transact(state => { state.centralEarningIntents = { held: { id: 'held', member, command: { member }, status: 'unknown', sendAttemptedAt: new Date().toISOString(), envelope: {} } }; });
  // Stands in for sequence-fence-clear.mjs: it may only read and record a proved outcome.
  f = fixture({ extra: { clearSequenceFence: async (member) => { calls++; if (settle) await f.store.transact(state => { state.centralEarningIntents.held.status = 'finalized'; }); return settle; } } });
  await f.register();
  await holdFor(f.payer.address);
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
  assert.equal((await f.service.build(send.id)).status, 'waiting-for-sequence', 'unsettled: the send waits');
  assert.equal(f.builds, 0, 'nothing is built or signed while the sequence is held');
  const waiting = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(waiting.waiting.message, 'Your last earning is still being confirmed. This payment goes through by itself in about a minute.');
  const { sendStatus } = await import('../web/server-send.js');
  assert.deepEqual([sendStatus(waiting, f.payer.address).label, sendStatus(waiting, f.payer.address).detail], ['Waiting', waiting.waiting.message]);
  settle = true;
  assert.equal((await f.service.build(send.id)).status, 'awaiting-signature', 'settled in the same request');
  assert.equal(f.service.get(f.user(f.payer), send.id).send.waiting, undefined, 'the note goes once it moves');
  assert.equal(calls, 2);
  const ready = f.service.get(f.user(f.payer), send.id).send;
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  await f.service.reconcile(ready.id);
  assert.equal(f.service.get(f.user(f.payer), send.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'paid once');
});

test('a failing or absent fence clearer leaves the send waiting, never sending past the fence', async () => {
  for (const clearSequenceFence of [async () => { throw Error('reader down'); }, null]) {
    const f = fixture({ extra: clearSequenceFence ? { clearSequenceFence } : {} });
    await f.register();
    await f.store.transact(state => { state.centralEarningIntents = { held: { id: 'held', member: f.payer.address, status: 'refused', sendAttemptedAt: 'x', envelope: {} } }; });
    const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
    assert.equal((await f.service.build(send.id)).status, 'waiting-for-sequence');
    assert.equal(f.builds, 0); assert.equal(f.s.broadcasts, 0);
  }
});

test('a signed first attempt settles the fence before relaying, then relays exactly once', async () => {
  let f, held = false;
  f = fixture({ extra: { clearSequenceFence: async () => { if (held) await f.store.transact(state => { state.centralEarningIntents.held.status = 'expired-unused'; }); held = false; return true; } } });
  const ready = await sendOnce(f);
  // A central step was sent after the build (from another device): the relay must wait for it.
  await f.store.transact(state => { state.centralEarningIntents = { held: { id: 'held', member: f.payer.address, status: 'unknown', sendAttemptedAt: 'x', envelope: {} } }; });
  held = true;
  const signed = await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  assert.equal(signed.send.status, 'submitted'); assert.equal(f.s.broadcasts, 1);
});

test('a request the wallet path paid or may still pay refuses a no-install send, whatever the lock maps say (shared guard, 10 Nov)', async () => {
  const f = fixture();
  await f.store.transact(s => { s.requests.r1 = { id: 'r1', from: f.payee.address, to: f.payer.address, amount: '25', currency: 'AI$', memo: '', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; });
  await f.register();
  // Recorded on the ledger through the device wallet; its lock is gone.
  await f.store.transact(s => { s.nativePaymentIntents = { w: { id: 'w', requestId: 'r1', status: 'ledger-recorded' } }; });
  await assert.rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), e => e.code === 'payment_request_paid' && /do not pay it again/.test(e.message));
  // Sent through the device wallet, outcome unknown, lock gone: still not payable.
  await f.store.transact(s => { s.nativePaymentIntents.w = { id: 'w', requestId: 'r1', status: 'unknown', sendAttemptedAt: new Date().toISOString(), envelope: {} }; });
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' }))), 'payment_request_locked');
  // Proved unused: payable.
  await f.store.transact(s => { s.nativePaymentIntents.w.status = 'expired-unused'; });
  assert.equal((await f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'r1' })))).send.status, 'accepted');
  assert.equal(Object.values(f.store.read().serverSendIntents).length, 1);
});

// S2 residual (security review, 10 Nov): the fake ledger can let another command take the payer's
// sequence in the moment between BAINK's fresh read and the relay.
function raceSequence(f) {
  const relay = f.native.broadcastShield;
  f.native.broadcastShield = async envelope => { const m = f.s.members[envelope.command.member]; if (m.sequence === envelope.command.sequence) m.sequence = String(BigInt(m.sequence) + 1n); return relay(envelope); };
  return () => { f.native.broadcastShield = relay; };
}
test('a relayed send every relay of which the chain refused is retired past expiry, then rebuilt and paid once (S2 residual, 10 Nov)', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  const restore = raceSequence(f);
  const signed = await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  restore();
  assert.equal(signed.send.status, 'refused'); assert.equal(signed.send.attempts[0].broadcasts[0].code, 32);
  assert.equal(hasPendingNativeSend(f.store.read(), f.payer.address), true, 'a relayed attempt holds the sequence until it is proved dead');
  // Before the expiry height nothing is concluded.
  await f.service.tick(); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.attempts[0].status, 'refused');
  // Past expiry: the first committed snapshot only records the observation, a later one retires the attempt.
  f.s.height += 61n;
  await f.service.tick();
  let row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts[0].status, 'refused'); assert.ok(row.attempts[0].refusedUnincluded, 'first observation recorded');
  assert.equal(hasPendingNativeSend(f.store.read(), f.payer.address), true);
  f.s.height += 1n;
  await f.service.tick();
  row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts[0].status, 'expired-unused');
  assert.equal(row.attempts[0].recovery.everyRelayRefused, true); assert.equal(row.attempts[0].recovery.recordPresent, false);
  assert.equal(hasPendingNativeSend(f.store.read(), f.payer.address), false, 'the fence is released');
  await f.service.tick(); // builds attempt 2 at the fresh sequence; the member signs again
  row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.status, 'awaiting-signature'); assert.equal(row.attempts[1].command.sequence, '4');
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(row));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'debited exactly once');
});
test('a relay with an unknown outcome is never retired on refusals alone (S2 residual, 10 Nov)', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.s.mode = 'lost-ack';                                                    // lands (sequence 3 -> 4), reply lost
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(ready));
  f.s.mode = 'hide-record';                                                 // the reader hides the record
  await f.service.broadcast(ready.id);                                      // refused for the sequence (our own command used it)
  f.s.height += 61n;
  await f.service.tick(); f.s.height += 1n; await f.service.tick(); f.s.height += 1n; await f.service.tick();
  let row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts.length, 1, 'no retry was built'); assert.notEqual(row.attempts[0].status, 'expired-unused');
  assert.ok(row.attempts[0].broadcasts.some(b => b.outcome === 'refused') && row.attempts[0].broadcasts.some(b => b.outcome === 'unknown'));
  f.s.mode = 'ok';
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n, 'debited exactly once');
});

test('an unsigned command whose window passed is replaced before the member signs it (10 Nov)', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  const dead = f.browserSign(ready);                                        // a late member's signature on the first command
  f.s.height += 61n; f.advance(120000);                                     // the 60-block window passed, nothing was signed
  await f.service.tick();
  let row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts[0].status, 'expired-unused'); assert.equal(row.attempts[0].recovery.neverSigned, true);
  await f.service.tick();
  row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.status, 'awaiting-signature'); assert.equal(row.attempts.length, 2);
  assert.ok(BigInt(row.attempts[1].command.expires_height) > f.s.height, 'the member is offered a live command');
  await rejects(f.service.sign(f.user(f.payer), ready.id, dead), 'send_not_awaiting_signature');
  assert.equal(f.s.broadcasts, 0, 'the dead command was never relayed');
  await f.service.sign(f.user(f.payer), ready.id, f.browserSign(row));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
});
// S7: a builder that models custody's one live approval per intent. While the AI checker has not
// answered, the build is queued and its bundle holds the claim until the bundle's expiry height; a
// new bundle before that is what custody refuses (shown to the payer as a false reason).
function claimingBuilder(f, { answer = () => 'pending' } = {}) {
  const claims = new Map(), inner = f.builder.build;
  let calls = 0;
  f.builder.build = async input => {
    calls++;
    const claimed = claims.get(input.intentId);
    if (claimed !== undefined && f.s.height <= claimed) return { status: 'refused', reason: 'The custody checker refused this payment (recipient, amount or signatures differ).' };
    const state = answer(calls);
    if (state === 'approved') { claims.delete(input.intentId); return inner(input); }
    claims.set(input.intentId, BigInt(input.expiresHeight));
    return { status: 'queued', retryAt: new Date(Date.now() - 1).toISOString(), reason: state === 'unanswered' ? 'checker-unanswered' : 'checker-capacity', claimExpiresHeight: input.expiresHeight };
  };
  return { get calls() { return calls; } };
}
test('a send queued for the AI checker waits for its claim window instead of being refused on retry (S7, 10 Nov)', async () => {
  const f = fixture();
  let ready = false;
  const custody = claimingBuilder(f, { answer: () => ready ? 'approved' : 'pending' });
  await f.register();
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
  await f.service.build(send.id);
  let row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'queued-checker-capacity'); assert.equal(row.checker.claimExpiresHeight, '160');
  // The retry time passes while the first bundle still holds custody's claim: nothing new is built.
  ready = true;
  f.advance(61000); await f.service.tick(); f.advance(61000); await f.service.tick();
  row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'queued-checker-capacity', 'never refused with a false reason'); assert.equal(custody.calls, 1);
  // Past the claimed bundle's expiry height custody accepts a new bundle.
  f.s.height += 61n; f.advance(61000);
  await f.service.tick();
  row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'awaiting-signature'); assert.equal(custody.calls, 2);
  await f.service.sign(f.user(f.payer), send.id, f.browserSign(row));
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), send.id).send.status, 'finalized');
  assert.equal(f.s.balances[f.payer.address], 175_000000n);
});
test('a checker that gives no answer is asked again after each window, three times at most, then the send ends with an honest reason (10 Nov)', async () => {
  const f = fixture();
  const custody = claimingBuilder(f, { answer: () => 'unanswered' });
  await f.register();
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
  await f.service.build(send.id);
  for (let i = 0; i < 2; i++) {
    assert.equal(f.service.get(f.user(f.payer), send.id).send.status, 'queued-checker-capacity');
    f.s.height += 61n; f.advance(61000); await f.service.tick();
  }
  const row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(custody.calls, 3); assert.equal(row.status, 'checker-refused');
  assert.match(row.checker.reason, /gave no answer/); assert.doesNotMatch(row.checker.reason, /signatures differ/);
  assert.equal(f.s.balances[f.payer.address], 200_000000n, 'nothing was sent');
});

test('retention: ended sends leave after a day, so the per-member and global caps are not lifetime caps; a finalized send stays while it proves a payment (S6, 10 Nov)', async () => {
  const f = fixture();
  const DAY = 86400000, at = ms => new Date(Date.now() + ms).toISOString();
  await f.store.transact(s => {
    s.requests.open1 = { id: 'open1', from: f.payee.address, to: f.payer.address, amount: '1', currency: 'AI$', memo: '', status: 'open', createdAt: at(-40 * DAY), updatedAt: at(-40 * DAY) };
    s.requests.paid1 = { ...s.requests.open1, id: 'paid1', status: 'paid', paymentIntentId: 'send:confirmed-request' };
    const row = (id, status, extra = {}, intent = {}) => ({ id, schema: 'baink-server-send-v1', intent: { from: f.payer.address, to: f.payee.address, amountUnits: '1000000', nonce: id, notAfter: at(-2 * DAY), requestId: null, ...intent }, status, attempts: [], recipientConfirmation: null, createdAt: at(-3 * DAY), updatedAt: at(-3 * DAY), ...extra });
    s.serverSendIntents = Object.fromEntries([
      ...Array.from({ length: 512 }, (_, i) => row('failed-' + i, ['expired', 'cancelled', 'checker-refused'][i % 3])),
      row('unconfirmed', 'finalized'),                                                                  // the payee has not confirmed: kept
      row('paid-open-request', 'finalized', {}, { requestId: 'open1' }),                                 // proves an open request is paid: kept
      row('confirmed-open-request', 'finalized', { recipientConfirmation: { at: at(-2 * DAY) } }, { requestId: 'open1' }), // its request is not marked paid by it: kept
      row('confirmed-request', 'finalized', { recipientConfirmation: { at: at(-2 * DAY) } }, { requestId: 'paid1' }),      // recent history: kept
      row('confirmed-old', 'finalized', { recipientConfirmation: { at: at(-39 * DAY) } }, { notAfter: at(-40 * DAY) }),   // older than 30 days: goes
      row('recent-failed', 'expired', {}, { notAfter: at(-3600000) }),                                   // inside the day: kept
    ].map(r => [r.id, r]));
    s.serverSendRequestLocks = { open1: 'paid-open-request' };
  });
  await f.register();
  // Before the fix the 513th send of a member was refused for good with send_capacity.
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '1000000' })));
  assert.equal(send.status, 'accepted');
  const left = Object.keys(f.store.read().serverSendIntents).sort();
  assert.deepEqual(left, ['confirmed-open-request', 'confirmed-request', 'paid-open-request', 'recent-failed', 'unconfirmed', send.id].sort());
  assert.equal(f.store.read().serverSendRequestLocks.open1, 'paid-open-request');
  // The request that a kept finalized send paid is still refused.
  await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'open1', amountUnits: '1000000' }))), 'payment_request_paid');
});
test('retention at the cap: the oldest confirmed payments make room, never one that still proves a payment (S6, 10 Nov)', async () => {
  const f = fixture(), DAY = 86400000, at = ms => new Date(Date.now() + ms).toISOString();
  await f.store.transact(s => {
    const row = (id, extra = {}, n = 0) => ({ id, schema: 'baink-server-send-v1', intent: { from: f.payer.address, to: f.payee.address, amountUnits: '1000000', nonce: id, notAfter: at(-2 * DAY), requestId: null }, status: 'finalized', attempts: [], recipientConfirmation: { at: at(-2 * DAY) }, createdAt: at(-5 * DAY + n), updatedAt: at(-3 * DAY), ...extra });
    s.serverSendIntents = Object.fromEntries([...Array.from({ length: 511 }, (_, i) => row('done-' + String(i).padStart(3, '0'), {}, i)), row('unconfirmed', { recipientConfirmation: null }, -1)].map(r => [r.id, r]));
  });
  await f.register();
  await f.service.create(f.user(f.payer), f.signed(f.intent({ amountUnits: '1000000' })));
  const left = f.store.read().serverSendIntents;
  assert.equal(Object.keys(left).length, 512); assert.equal(left['done-000'], undefined, 'the oldest confirmed payment made room');
  assert.ok(left.unconfirmed && left['done-001'], 'an unconfirmed payment is never dropped, and history is kept as long as there is room');
});

test('an unsigned command whose sequence another command used is replaced too; a live one is left alone (10 Nov)', async () => {
  const f = fixture();
  const ready = await sendOnce(f);
  f.advance(120000);
  await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), ready.id).send.attempts.length, 1, 'still inside its window: untouched');
  f.s.members[f.payer.address].sequence = '4';                              // an earning step used sequence 3
  f.advance(120000);
  await f.service.tick(); await f.service.tick();
  const row = f.service.get(f.user(f.payer), ready.id).send;
  assert.equal(row.attempts[0].status, 'expired-unused'); assert.equal(row.attempts[1].command.sequence, '4');
});

// P0-4 (12 November 2026): while Trade is paused a new send for a terms payment request (no signed
// deal) is refused before any lock; a deal payment, an ordinary request and a send that was already
// accepted before the pause all go on to the ledger and the recipient's confirmation.
test('paused Trade: a new terms send is refused, deal and ordinary sends and an earlier send finish', async () => {
  const { createTradeAvailability } = await import('../server/trade-availability.mjs');
  let current = createTradeAvailability({ mode: 'open' });
  const tradeAvailability = { assert: (op, state) => current.assert(op, state) };
  const f = fixture({ extra: { tradeAvailability, validateTradeRequest: () => ({ tradeDigest: 'a'.repeat(64) }) } });
  const at = new Date().toISOString();
  const row = (id, extra = {}) => ({ id, from: f.payee.address, to: f.payer.address, amount: '25', currency: 'AI$', memo: '', status: 'open', createdAt: at, updatedAt: at, ...extra });
  await f.store.transact((s) => {
    s.requests.terms = row('terms', { trade: { schema: 'baink-trade-payment-v1' } });
    s.requests.early = row('early', { trade: { schema: 'baink-trade-payment-v1' } });
    s.requests.deal = row('deal', { trade: { schema: 'baink-trade-deal-payment-v1', dealId: 'd1' } });
    s.requests.plain = row('plain');
  });
  // Accepted while Trade was open, then Trade is paused (a restart with the new setting).
  const early = await sendOnce(f, { requestId: 'early' });
  current = createTradeAvailability({ mode: 'paused' });
  f.restart();
  for (let i = 0; i < 2; i++) await rejects(f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'terms' }))), 'trade_paused');
  assert.equal(f.store.read().serverSendRequestLocks?.terms, undefined, 'a refused send takes no lock');
  assert.equal(Object.values(f.store.read().serverSendIntents ?? {}).filter((r) => r.intent.requestId === 'terms').length, 0, 'retries create nothing');
  for (const id of ['deal', 'plain']) {
    const { created } = await f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: id })));
    assert.equal(created, true, id);
  }
  await f.service.sign(f.user(f.payer), early.id, f.browserSign(early));
  await f.service.tick();
  const { send } = f.service.get(f.user(f.payee), early.id);
  assert.equal(send.status, 'finalized');
  await f.service.confirm(f.user(f.payee), early.id, { signature: sign(null, sendConfirmationBytes(send), f.payee.privateKey).toString('base64url') });
  assert.equal(f.store.read().requests.early.status, 'paid', 'a send accepted before the pause settles in full');
  // Open again: the terms send starts.
  current = createTradeAvailability({ mode: 'open' });
  assert.equal((await f.service.create(f.user(f.payer), f.signed(f.intent({ requestId: 'terms' })))).created, true);
});

// Second review (13 November 2026): the derivation line (8 places) was shared by everyone, so a
// few members registering random keys in parallel kept it full. One place per member now.
test('receiving-key registration: one place in the derivation line per member, so others are still served', async (t) => {
  const { addressFromFullViewingKey } = await import('../server/server-send-builder.mjs');
  const { receivingKeyBytes } = await import('../server/server-send.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fictional-coin-wallet-member-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, 'uain-coin-wallet');
  await writeFile(tool, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>setTimeout(()=>{const k=JSON.parse(s).full_viewing_key;process.stdout.write(JSON.stringify({address:k.slice(0,86)})+'\\n');},30));\n`);
  await chmod(tool, 0o700);
  const wallet = { executable: tool, executableSha256: hash(await readFile(tool)) };
  const f = fixture({ extra: { addressFromKey: (fvk) => addressFromFullViewingKey(wallet, fvk) } });
  const register = (who, k) => f.service.registerReceivingKey(f.user(who), { fullViewingKey: k, signature: sign(null, receivingKeyBytes({ member: who.address, fullViewingKey: k, chainId: CHAIN }), who.privateKey).toString('base64url') });
  const key = (i) => randomBytes(96).toString('hex').slice(0, 190) + i.toString(16).padStart(2, '0');
  const flooder = person(), others = Array.from({ length: 7 }, () => person());
  const [flood, served] = await Promise.all([
    Promise.allSettled(Array.from({ length: 10 }, (_, i) => register(flooder, key(i)))),
    Promise.allSettled(others.map((who, i) => register(who, key(100 + i)))),
  ]);
  assert.equal(flood.filter((x) => x.status === 'fulfilled').length, 1, 'one place for the flooding member');
  assert.ok(flood.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'receiving_key_unavailable' && x.reason.status === 503));
  assert.deepEqual(served.map((x) => x.status), Array(7).fill('fulfilled'), JSON.stringify(served.filter((x) => x.status === 'rejected').map((x) => x.reason.code)));
  // Once its derivation ends, the member can register again.
  assert.equal((await register(flooder, key(200))).member, flooder.address);
});

// L6 (security review, 13 November 2026): a build that fails before custody was tried again on
// every 5-second tick for the intent's whole life (up to a day). It now backs off, doubling up to
// five minutes, and still ends at the intent's expiry.
test('a failing build backs off instead of retrying every tick, and the send still ends at its expiry (L6)', async () => {
  const f = fixture();
  let calls = 0;
  const real = f.builder.build;
  f.builder.build = async () => { calls++; throw Error('coin-wallet exited 1'); };
  await f.register();
  const { send } = await f.service.create(f.user(f.payer), f.signed(f.intent()));
  assert.equal((await f.service.build(send.id)).status, 'build_failed');
  assert.equal(calls, 1);
  let row = f.service.get(f.user(f.payer), send.id).send;
  assert.equal(row.status, 'accepted'); assert.equal(row.lastError.code, 'build_failed');
  // Ticks inside the backoff do not call the builder again.
  for (let i = 0; i < 3; i++) { f.advance(1000); await f.service.tick(); }
  assert.equal(calls, 1, 'no rebuild inside the first 5 s');
  f.advance(3000); await f.service.tick();
  assert.equal(calls, 2, 'retried once the backoff passed');
  f.advance(6000); await f.service.tick();
  assert.equal(calls, 2, 'the second backoff is longer (10 s)');
  f.advance(5000); await f.service.tick();
  assert.equal(calls, 3);
  // Bounded: however many failures, the wait never exceeds five minutes.
  for (let i = 0; i < 10; i++) { f.advance(300_000); await f.service.tick(); }
  assert.equal(calls, 13, 'one try per five minutes at most');
  row = f.service.get(f.user(f.payer), send.id).send;
  assert.ok(Date.parse(row.lastError.retryAt) - Date.parse(row.lastError.at) <= 300_000);
  // The builder recovers: the next try after the backoff builds the attempt.
  f.builder.build = real;
  f.advance(300_000); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), send.id).send.status, 'awaiting-signature');
  // A send that keeps failing still ends at its expiry, not later.
  const second = (await f.service.create(f.user(f.payer), f.signed(f.intent()))).send;
  f.builder.build = async () => { calls++; throw Error('coin-wallet exited 1'); };
  await f.service.build(second.id);
  f.advance(3_600_000); await f.service.tick();
  assert.equal(f.service.get(f.user(f.payer), second.id).send.status, 'expired');
});
