import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, verify, createPublicKey } from 'node:crypto';
import * as server from '../server/server-send.mjs';
import { signingBytes } from '../../../chain/client/signing.mjs';
import { amountToUnits, unitsToAmount, buildSendIntent, signSendIntent, sendIntentId, sendPurposeCommitment, signPreparedCommand, signReceipt, signReceivingAddress, sendStatus, readyToSign } from './server-send.js';

const hash = v => createHash('sha256').update(v).digest('hex');
async function browserIdentity() {
  const pair = generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const privateKey = await crypto.subtle.importKey('jwk', pair.privateKey.export({ format: 'jwk' }), 'Ed25519', false, ['sign']);
  return { privateKey, raw, address: 'uain1' + hash(raw).slice(0, 40), publicKeyBase64: raw.toString('base64') };
}
const key = raw => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
const pins = { chainId: 'uain-test', genesisSha256: 'a'.repeat(64) };

test('amounts convert exactly', () => {
  assert.equal(amountToUnits('25'), '25000000');
  assert.equal(amountToUnits('0.000001'), '1');
  assert.equal(unitsToAmount('25500000'), '25.5');
  assert.throws(() => amountToUnits('0'));
  assert.throws(() => amountToUnits('1.0000001'));
  assert.throws(() => amountToUnits('-1'));
});

test('browser intent, command and receipt bytes match the server exactly', async () => {
  const me = await browserIdentity(), you = await browserIdentity();
  const intent = buildSendIntent({ pins, from: me.address, to: you.address, recipientAddress: randomBytes(43).toString('hex'), amountUnits: '25000000', memo: 'R&D <compute>' });
  const signed = await signSendIntent(me, intent);
  assert.ok(verify(null, server.sendIntentBytes(intent), key(me.raw), Buffer.from(signed.signature, 'base64url')));
  const id = await sendIntentId(intent);
  assert.equal(id, server.sendIntentId(intent));
  assert.equal(await sendPurposeCommitment(id), server.sendPurposeCommitment(id));
  const approval = { reviewer: 'uain1' + 'b'.repeat(40), effects: 'e'.repeat(64), purpose_commitment: server.sendPurposeCommitment(id), class: 'neutral', expires_height: '200', licence_revision: '1', signature: 'A'.repeat(86), direction: 'shield', member: me.address, amount: '25000000' };
  const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence: '4', expires_height: '160', operation: 'coin_shield', payload: { bundle: Buffer.from('bundle').toString('base64url'), approval } };
  const bytes = signingBytes(command);
  const record = { id, intent, signature: signed.signature, status: 'awaiting-signature', attempts: [{ n: 1, status: 'awaiting-signature', command, signingBytesBase64: bytes.toString('base64'), commandDigest: hash(bytes), proofHeight: '100' }] };
  assert.deepEqual(server.verifySendCommand(record, command), bytes);
  const s = await signPreparedCommand(me, record);
  assert.ok(verify(null, bytes, key(me.raw), Buffer.from(s.signature, 'base64url')));
  for (const bad of [{ amount: '1' }, { member: you.address }, { direction: 'exit' }, { purpose_commitment: 'f'.repeat(64) }]) {
    const r = structuredClone(record); Object.assign(r.attempts[0].command.payload.approval, bad);
    await assert.rejects(signPreparedCommand(me, r), /differs/);
  }
  const far = structuredClone(record); far.attempts[0].command.expires_height = '1000';
  await assert.rejects(signPreparedCommand(me, far), /differs/);
  await assert.rejects(signPreparedCommand(you, record), /differs/);
  // S5: a prepared command is signed only when this key signed its intent. A made-up signature, none,
  // another member's, or this key's signature on a different intent are all refused.
  const other = buildSendIntent({ pins, from: me.address, to: you.address, recipientAddress: intent.recipientAddress, amountUnits: '1000000000000' });
  for (const forged of ['not-a-signature', undefined, 'A'.repeat(86), (await signSendIntent(you, { ...intent, from: you.address, to: me.address })).signature, (await signSendIntent(me, other)).signature])
    await assert.rejects(signPreparedCommand(me, { ...record, signature: forged }), /not authorised on this device\. Nothing was signed/);
  const madeUp = { ...structuredClone(record), intent: other, id: await sendIntentId(other) };
  madeUp.attempts[0].command.payload.approval.amount = other.amountUnits; madeUp.attempts[0].command.payload.approval.purpose_commitment = await sendPurposeCommitment(madeUp.id);
  await assert.rejects(signPreparedCommand(me, madeUp), /not authorised on this device/, 'a server-supplied intent the member never signed gets no signature');
  const done = { ...record, status: 'finalized', result: { effects: 'e'.repeat(64) } };
  const receipt = await signReceipt(you, done);
  assert.ok(verify(null, server.sendConfirmationBytes(done), key(you.raw), Buffer.from(receipt.signature, 'base64url')));
  const addr = await signReceivingAddress(you, { address: intent.recipientAddress, chainId: pins.chainId });
  assert.ok(verify(null, server.receivingAddressBytes({ member: you.address, address: intent.recipientAddress, chainId: pins.chainId }), key(you.raw), Buffer.from(addr.signature, 'base64url')));
  assert.equal(sendStatus(record, me.address).needsMe, true);
  assert.equal(sendStatus(done, you.address).needsMe, true);
  assert.equal(sendStatus({ ...done, recipientConfirmation: { at: 'x' } }, me.address).label, 'Paid');
});

// FE-4 (security review, 13 November 2026): the browser repeats the server's time and state checks
// before it signs, so a server-supplied record cannot get a signature for an intent past its
// expiry, or a fresh attempt on a send that already landed.
test('the browser signs no command for an expired intent or a send that already landed', async () => {
  const me = await browserIdentity(), you = await browserIdentity();
  async function prepared({ now = Date.now() } = {}) {
    const intent = buildSendIntent({ pins, from: me.address, to: you.address, recipientAddress: randomBytes(43).toString('hex'), amountUnits: '25000000', now });
    const { signature } = await signSendIntent(me, intent), id = await sendIntentId(intent);
    const approval = { reviewer: 'uain1' + 'b'.repeat(40), effects: 'e'.repeat(64), purpose_commitment: server.sendPurposeCommitment(id), class: 'neutral', expires_height: '200', licence_revision: '1', signature: 'A'.repeat(86), direction: 'shield', member: me.address, amount: '25000000' };
    const command = { version: 1, chain_id: pins.chainId, member: me.address, sequence: '4', expires_height: '160', operation: 'coin_shield', payload: { bundle: Buffer.from('bundle').toString('base64url'), approval } };
    const bytes = signingBytes(command);
    return { id, intent, signature, status: 'awaiting-signature', result: null, recipientConfirmation: null, attempts: [{ n: 1, status: 'awaiting-signature', command, signingBytesBase64: bytes.toString('base64'), commandDigest: hash(bytes), proofHeight: '100' }] };
  }
  const live = await prepared();
  assert.ok((await signPreparedCommand(me, live)).signature, 'a live, fresh record is still signed');
  const expired = await prepared({ now: Date.now() - 2 * 3600_000 });
  await assert.rejects(signPreparedCommand(me, expired), /expired.*Nothing was signed/);
  // An earlier attempt that may have landed, or a result on the record: never sign another attempt.
  for (const earlier of ['finalized', 'submitted', 'signed', 'broadcasting', 'unknown', 'refused']) {
    const r = structuredClone(live); r.attempts.unshift({ ...structuredClone(r.attempts[0]), n: 0, status: earlier });
    await assert.rejects(signPreparedCommand(me, r), /already.*Nothing was signed/, earlier);
  }
  const retried = structuredClone(live); retried.attempts.unshift({ ...structuredClone(retried.attempts[0]), n: 0, status: 'expired-unused' });
  assert.ok((await signPreparedCommand(me, retried)).signature, 'a fresh attempt after one proved unused is signed');
  for (const done of [{ result: { effects: 'e'.repeat(64) } }, { recipientConfirmation: { at: 'x' } }])
    await assert.rejects(signPreparedCommand(me, { ...structuredClone(live), ...done }), /already.*Nothing was signed/);
  // The Pay screen's automatic signer skips the same records before asking.
  assert.equal(readyToSign(live, me.address), true);
  assert.equal(readyToSign(expired, me.address), false);
  assert.equal(readyToSign({ ...live, result: { effects: 'e'.repeat(64) } }, me.address), false);
  assert.equal(readyToSign(live, you.address), false);
});
