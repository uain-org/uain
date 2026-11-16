import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = b => createHash('sha256').update(b).digest('hex');
async function fixture(t, { enabled = true } = {}) {
  const { createNativeInstanceService } = await import('../server/native-instance.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'native-instance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.json');
  await writeFile(path, '{}');
  let data = {}, queue = Promise.resolve(), sends = 0, lost = false;
  const store = {
    read: () => structuredClone(data),
    transact(fn) {
      const task = queue.then(async () => {
        const next = structuredClone(data), answer = fn(next);
        await writeFile(path, JSON.stringify(next)); data = next;
        return structuredClone(answer);
      });
      queue = task.catch(() => {}); return task;
    },
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const user = { address: 'uain1' + digest(raw).slice(0, 40), publicKey: raw.toString('base64') };
  const member = { id: user.address, public_key: raw.toString('base64url'), sequence: '7', licence: 'active' };
  const state = { chain_id: 'fixture-chain', height: '100', app_hash: 'c'.repeat(64), event_count: '0', member, records: {} };
  const pins = { chainId: state.chain_id, epoch: 'a'.repeat(64), verifierSha256: 'b'.repeat(64) };
  let proofPatch = {}, receipt = null;
  const native = {
    configured: true, pins, timeoutMs: 1000,
    async publicState(selection) {
      const records = {};
      for (const key of selection.keys ?? []) records[key] = state.records[key] ?? null;
      return { state: { ...structuredClone(state), records, ...(selection.receipt ? { receipt } : {}) },
        proof: { authority: 'native', chainId: state.chain_id, height: state.height, appHash: 'c'.repeat(64), headerTime: new Date().toISOString(), maxAgeSeconds: 120, ...pins, ...proofPatch } };
    },
    async broadcastInstance(envelope) {
      sends++;
      // The durable marker must precede the irreversible network send.
      assert.ok(Object.values(JSON.parse(await readFile(path))).flatMap(x => Object.values(x)).find(i => i.sendAttemptedAt && i.envelope));
      if (lost) throw Error('connection lost');
      return { accepted: true, code: 0, transactionHash: digest(JSON.stringify(envelope)).toUpperCase(), finalized: false };
    },
    invalidateAccount() {},
  };
  let service = createNativeInstanceService({ store, native, enabled });
  return { user, state, member, native, store, get service() { return service; }, get sends() { return sends; },
    loseReply() { lost = true; }, patchProof(p) { proofPatch = p; },
    async restart() { data = JSON.parse(await readFile(path)); service = createNativeInstanceService({ store, native, enabled }); },
    body: { clientRequestId: 'instance-request-1', id: 'owned-one', name: 'My researcher', family: 'Fixture' },
    signed(intent) { return { envelope: { command: intent.command, public_key: raw.toString('base64url'), signature: sign(null, Buffer.from(intent.signingBytesBase64, 'base64'), privateKey).toString('base64url') } }; },
    finalize(intent, eventPatch = {}) {
      const event = { id: '1', member: user.address, operation: 'instance_create', subject: intent.command.payload.id, command_digest: intent.commandDigest, ...eventPatch };
      state.event_count = '1'; state.height = '101'; member.sequence = '8';
      state.records['event/00000000000000000001'] = event;
      state.records['instance/' + intent.command.payload.id] = { id: intent.command.payload.id, member: user.address, name: intent.command.payload.name, family: intent.command.payload.family, state: 'active' };
      receipt = { authority: 'native', finalized: true, chain_id: state.chain_id, state_height: '101', app_hash: 'c'.repeat(64), event };
    },
  };
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('prepares exact owner-bound instance_create with latest shared member sequence and no send', async t => {
  const f = await fixture(t), { intent, created } = await f.service.prepare(f.user, f.body);
  assert.equal(created, true); assert.equal(intent.command.operation, 'instance_create');
  assert.equal(intent.command.sequence, '7'); assert.equal(intent.command.member, f.user.address);
  assert.deepEqual(intent.command.payload, { id: 'owned-one', name: 'My researcher', family: 'Fixture' });
  assert.equal(f.sends, 0); assert.equal(intent.finalized, false);
  assert.equal((await f.service.prepare(f.user, f.body)).intent.id, intent.id);
  await rejects(f.service.prepare(f.user, { ...f.body, name: 'Other' }), 'instance_idempotency_conflict');
});
test('licence, exact key, ownership collision, capacity and unsafe input fail closed', async t => {
  for (const [mutate, code] of [
    [f => { f.member.licence = 'pending'; }, 'native_licence_inactive'],
    [f => { f.member.public_key = 'bad'; }, 'native_proof_unavailable'],
    [f => { f.state.records['instance/owned-one'] = { member: 'other' }; }, 'native_instance_exists'],
    [f => { f.state.records['instance_count/' + f.user.address] = 128; }, 'native_instance_limit'],
    [f => { f.body.id = '../escape'; }, 'invalid_instance_fields'],
    [f => { f.body.family = '\ud800'; }, 'invalid_native_command'],
    [f => { f.body.credits = '100'; }, 'invalid_instance_fields'],
  ]) { const f = await fixture(t); mutate(f); await rejects(f.service.prepare(f.user, f.body), code); assert.equal(f.sends, 0); }
});
test('stale, future, wrong epoch and rollback proofs cannot prepare or submit', async t => {
  for (const patch of [{ headerTime: new Date(0).toISOString() }, { headerTime: new Date(Date.now() + 120000).toISOString() }, { epoch: 'd'.repeat(64) }, { chainId: 'wrong' }, { verifierSha256: 'e'.repeat(64) }]) {
    const f = await fixture(t); f.patchProof(patch); await rejects(f.service.prepare(f.user, f.body), 'native_proof_unavailable');
  }
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body);
  f.state.height = '99'; await rejects(f.service.submit(f.user, intent.id, f.signed(intent)), 'native_proof_unavailable');
});
test('exact signed consent broadcasts once and uncertain sends survive restart without replacement', async t => {
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body), signed = f.signed(intent);
  f.loseReply(); const sent = await f.service.submit(f.user, intent.id, signed);
  assert.equal(sent.intent.status, 'unknown'); assert.equal(sent.intent.receiptRequired, true);
  await f.restart(); assert.equal((await f.service.submit(f.user, intent.id, signed)).attempted, false); assert.equal(f.sends, 1);
  await rejects(f.service.prepare(f.user, { ...f.body, clientRequestId: 'replacement-request' }), 'instance_intent_pending');
  const other = await fixture(t);
  assert.equal(f.service.list(other.user).intents.length, 0);
  await rejects(f.service.receipt(other.user, intent.id, {}), 'instance_intent_missing');
});
test('disabled or absent instance broadcast capability refuses signed submission', async t => {
  const f = await fixture(t, { enabled: false }), { intent } = await f.service.prepare(f.user, f.body);
  await rejects(f.service.submit(f.user, intent.id, f.signed(intent)), 'native_instance_disabled');
  const g = await fixture(t), prepared = await g.service.prepare(g.user, g.body); delete g.native.broadcastInstance;
  await rejects(g.service.submit(g.user, prepared.intent.id, g.signed(prepared.intent)), 'native_instance_disabled');
});
test('tampered envelope and changed latest sequence never broadcast', async t => {
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body), signed = f.signed(intent);
  signed.envelope.command.payload.name = 'Tampered'; await rejects(f.service.submit(f.user, intent.id, signed), 'native_envelope_mismatch');
  const again = (await f.service.prepare(f.user, f.body)).intent;
  f.member.sequence = '8'; await rejects(f.service.submit(f.user, intent.id, f.signed(again)), 'native_sequence_changed'); assert.equal(f.sends, 0);
});
test('CheckTx acceptance is not finality; exact event receipt plus owned instance is', async t => {
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body);
  const sent = await f.service.submit(f.user, intent.id, f.signed(intent)); assert.equal(sent.intent.finalized, false);
  assert.equal((await f.service.receipt(f.user, intent.id, {})).intent.finalized, false);
  f.finalize(intent);
  const final = (await f.service.receipt(f.user, intent.id, {})).intent;
  assert.equal(final.finalized, true); assert.equal(final.activation.verified, true); assert.equal(final.activation.instance.member, f.user.address);
  f.patchProof({ headerTime: new Date(0).toISOString() });
  const unavailable = (await f.service.receipt(f.user, intent.id, {})).intent;
  assert.equal(unavailable.activation.verified, false);
  assert.equal(unavailable.finalized, true);
  assert.deepEqual(unavailable.receipt, final.receipt, 'A current-state proof outage never erases the finalized historical receipt');
  assert.equal(f.sends, 1, 'Proof refresh never submits or retries the signed transaction');
});
test('wrong subject, wrong owner, changed epoch and caller receipt cursors cannot establish finality', async t => {
  for (const mutate of [f => f.finalize(f.intent, { subject: 'other-instance' }), f => { f.finalize(f.intent); f.state.records['instance/owned-one'].member = 'other'; }, f => { f.finalize(f.intent); f.patchProof({ epoch: 'e'.repeat(64) }); }]) {
    const f = await fixture(t); f.intent = (await f.service.prepare(f.user, f.body)).intent;
    await f.service.submit(f.user, f.intent.id, f.signed(f.intent)); mutate(f);
    await rejects(f.service.receipt(f.user, f.intent.id, {}), 'native_proof_unavailable');
    assert.equal(f.service.list(f.user).intents[0].finalized, false);
    await rejects(f.service.receipt(f.user, f.intent.id, { cursor: '1' }), 'invalid_receipt_request');
  }
});

test('resuming an unsigned prepared intent refreshes its proof without changing reviewed signing bytes', async t => {
  const f = await fixture(t), { intent } = await f.service.prepare(f.user,f.body);
  await f.store.transact(state => { state.nativeInstanceIntents[intent.id].proof.headerTime = new Date(0).toISOString(); });
  const resumed = (await f.service.prepare(f.user,f.body)).intent;
  assert.equal(resumed.id,intent.id);
  assert.notEqual(resumed.proof.headerTime,new Date(0).toISOString());
  assert.equal(resumed.signingBytesBase64,intent.signingBytesBase64);
  assert.equal(f.sends,0);
});

test('instance atomic send admission blocks another flow unknown send and never blocks its already-sent retry',async t=>{const f=await fixture(t),{intent}=await f.service.prepare(f.user,f.body);await f.store.transact(s=>{s.centralEarningIntents={other:{command:{member:f.user.address},status:'unknown',sendAttemptedAt:new Date().toISOString()}};});await assert.rejects(f.service.submit(f.user,intent.id,f.signed(intent)),e=>e.code==='native_sequence_pending');assert.equal(f.sends,0);await f.store.transact(s=>{s.centralEarningIntents.other.status='expired-unused'});assert.equal((await f.service.submit(f.user,intent.id,f.signed(intent))).attempted,true);await f.store.transact(s=>{s.centralEarningIntents.other.status='unknown'});assert.equal((await f.service.submit(f.user,intent.id,f.signed(intent))).attempted,false);assert.equal(f.sends,1);});

test('a sent instance command proved unincluded past expiry releases the sequence fence (security review, 10 Nov)', async t => {
  const { hasPendingNativeSend } = await import('../server/native-sequence-fence.mjs');
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body);
  f.loseReply(); assert.equal((await f.service.submit(f.user, intent.id, f.signed(intent))).intent.status, 'unknown');
  assert.equal(hasPendingNativeSend(f.store.read(), f.user.address), true);
  f.state.height = String(BigInt(intent.command.expires_height) + 5n);           // past expiry, sequence still 7: never landed
  await f.service.prepare(f.user, { ...f.body, clientRequestId: 'instance-request-2', id: 'owned-two' });
  assert.equal(f.store.read().nativeInstanceIntents[intent.id].status, 'expired_unincluded');
  assert.equal(hasPendingNativeSend(f.store.read(), f.user.address), false);
});

test('a sent instance command whose sequence moved on stays fenced: inclusion is not disproved', async t => {
  const { hasPendingNativeSend } = await import('../server/native-sequence-fence.mjs');
  const f = await fixture(t), { intent } = await f.service.prepare(f.user, f.body);
  f.loseReply(); await f.service.submit(f.user, intent.id, f.signed(intent));
  f.state.height = String(BigInt(intent.command.expires_height) + 5n); f.member.sequence = '8';
  await f.service.prepare(f.user, { ...f.body, clientRequestId: 'instance-request-3', id: 'owned-three' });
  assert.equal(f.store.read().nativeInstanceIntents[intent.id].status, 'expired');
  assert.equal(hasPendingNativeSend(f.store.read(), f.user.address), true);
});
