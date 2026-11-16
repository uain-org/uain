// Fictional keys only. The production send checker: custody evidence checks
// (reviewer-worker validateSendEvidence) and the BAINK custody adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSendEvidence } from '../review-broker/reviewer-worker.mjs';
import { createCustodySendChecker } from '../server/server-send-builder.mjs';
import { sendIntentId, sendPurposeCommitment, sendIntentBytes as serverIntentBytes, receivingAddressBytes } from '../server/server-send.mjs';
import { canonicalJSON } from '../server/native-financial-command.mjs';
import { buildSendIntent, signSendIntent, signReceivingAddress, sendIntentBytes as webIntentBytes } from '../web/server-send.js';

const sha = v => createHash('sha256').update(v).digest('hex');
const pins = { chainId: 'uain-fictional-send-1', genesisSha256: 'e'.repeat(64) };
const reviewerHex = 'c'.repeat(64);
async function actor() {
  const keys = generateKeyPairSync('ed25519'), raw = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const privateKey = await crypto.subtle.importKey('jwk', keys.privateKey.export({ format: 'jwk' }), 'Ed25519', false, ['sign']);
  return { address: 'uain1' + sha(raw).slice(0, 40), publicKey: raw.toString('base64'), web: { privateKey, address: 'uain1' + sha(raw).slice(0, 40), publicKeyBase64: raw.toString('base64') } };
}
async function fixture() {
  const payer = await actor(), payee = await actor(), recipientAddress = 'ab'.repeat(43);
  const signed = await signSendIntent(payer.web, buildSendIntent({ pins, from: payer.address, to: payee.address, recipientAddress, amountUnits: '2500000', memo: 'fictional test payment' }));
  const registration = { address: recipientAddress, publicKey: payee.publicKey, ...(await signReceivingAddress(payee.web, { address: recipientAddress, chainId: pins.chainId })) };
  delete registration.address; registration.address = recipientAddress;
  const id = sendIntentId(signed.intent);
  const context = { version: 1, chain: pins.chainId, expires: '160', licenceRevision: '3', effects: 'a'.repeat(64), purpose: sendPurposeCommitment(id), reviewer: reviewerHex };
  const packet = { request: { version: 1, effects: context.effects, purpose_commitment: context.purpose, expires_height: '160', licence_revision: '3', direction: 'shield', member: payer.address, amount: '2500000' }, chain_id: pins.chainId, reviewer_public_key: reviewerHex, effects: context.effects, effects_wire_hex: '00', one_time_viewing_key: 'f'.repeat(64) };
  const send = { packet, intent: signed.intent, signature: signed.signature, publicKey: payer.publicKey, registration: { address: registration.address, publicKey: registration.publicKey, signature: registration.signature } };
  return { payer, payee, context, send, id };
}

test('web, server and custody agree on the intent and receiving-address bytes', async () => {
  const { send } = await fixture();
  assert.deepEqual(Buffer.from(webIntentBytes(send.intent)), serverIntentBytes(send.intent));
  assert.ok(receivingAddressBytes({ member: send.intent.to, address: send.registration.address, chainId: pins.chainId }).toString().startsWith('BAINK/receiving-address/v1\u0000'));
});

test('custody accepts only the payer-signed intent, the payee-signed address and the exact boundary request', async () => {
  const f = await fixture();
  const ok = validateSendEvidence({ context: f.context, send: f.send, pins });
  assert.equal(ok.intentId, f.id);
  const tamper = [
    s => { s.signature = s.registration.signature; },                                  // not the payer's intent signature
    s => { s.intent = { ...s.intent, amountUnits: '2500001' }; },                      // signed amount differs
    s => { s.intent = { ...s.intent, recipientAddress: 'cd'.repeat(43) }; },           // recipient differs from the signed one
    s => { s.registration = { ...s.registration, signature: s.signature }; },          // payee never signed this address
    s => { s.registration = { ...s.registration, publicKey: s.publicKey }; },          // payer claims to be the payee
    s => { s.registration = { ...s.registration, address: 'cd'.repeat(43) }; },        // a different registered address
    s => { s.packet = { ...s.packet, request: { ...s.packet.request, amount: '1' } }; },
    s => { s.packet = { ...s.packet, request: { ...s.packet.request, member: s.intent.to } }; },
    s => { s.packet = { ...s.packet, reviewer_public_key: 'd'.repeat(64) }; },
    s => { s.publicKey = s.registration.publicKey; },                                  // a key that is not the payer's
  ];
  for (const change of tamper) {
    const send = structuredClone(f.send); change(send);
    assert.throws(() => validateSendEvidence({ context: f.context, send, pins }));
  }
  assert.throws(() => validateSendEvidence({ context: { ...f.context, purpose: 'b'.repeat(64) }, send: f.send, pins }), 'purpose must bind the intent id');
  assert.throws(() => validateSendEvidence({ context: f.context, send: f.send, pins: { ...pins, genesisSha256: '0'.repeat(64) } }));
  assert.throws(() => validateSendEvidence({ context: f.context, send: f.send, pins, now: Date.parse(f.send.intent.notAfter) + 1 }), 'expired intent');
});

async function adapter(decisions, { approval, route } = {}) {
  const f = await fixture(), calls = [];
  const dir = await mkdtemp(join(tmpdir(), 'fictional-send-packet-')), packetFile = join(dir, 'review.json');
  await writeFile(packetFile, JSON.stringify(f.send.packet), { mode: 0o600 });
  const reviewer = 'uain1' + sha(Buffer.from(reviewerHex, 'hex')).slice(0, 40);
  const request = { ...f.send.packet.request };
  const rootAction = async (action, jobId, body) => {
    calls.push(action);
    if (action === 'create') { assert.deepEqual(body.context, f.context); return { status: 'created', jobId }; }
    if (action === 'send-ingest') { assert.deepEqual(body, { ...f.send, packet: f.send.packet }); return { status: 'ingested' }; }
    if (action === 'inspect' && route === 'unanswered') throw new Error('review_root_refused');
    if (action === 'inspect' && route === 'claim-held') return { status: 'claim-held', retryAfterHeight: '777' };
    if (action === 'inspect') return route === 'refuse' ?{ status: 'refused', reason: 'member on the refuse list' } : { status: 'inspected', inspectionDigest: '9'.repeat(64), ...(route ? { route } : {}) };
    if (action === 'finalize' || action === 'finalize-rules') return { approval: approval ? approval(request) : { reviewer, effects: request.effects, purpose_commitment: request.purpose_commitment, class: 'neutral', expires_height: request.expires_height, licence_revision: request.licence_revision, signature: 'x'.repeat(86), direction: 'shield', member: request.member, amount: request.amount }, reviewerBinding: null };
    throw new Error(action);
  };
  const bindings = [];
  const checker = createCustodySendChecker({ rootAction, reviewerPublicKeyHex: reviewerHex, aiReview: async b => { bindings.push(b); return decisions.shift(); } });
  const expected = { recipientAddress: f.send.intent.recipientAddress, amountUnits: '2500000', member: f.payer.address, purposeCommitment: f.context.purpose, intentId: f.id, chainId: pins.chainId, evidence: { intent: f.send.intent, signature: f.send.signature, publicKey: f.send.publicKey, registration: f.send.registration } };
  try { return { result: await checker.review({ request, packetFile, expected }), calls, bindings, f }; } finally { await rm(dir, { recursive: true, force: true }); }
}

test('custody checker: approval only after an AI attestation, bound to the custody job', async () => {
  const { result, calls, bindings, f } = await adapter([{ status: 'attested' }]);
  assert.equal(result.status, 'approved');
  assert.deepEqual(calls, ['create', 'send-ingest', 'inspect', 'finalize']);
  assert.equal(bindings[0].owner, f.payer.address);
  assert.equal(bindings[0].publicKey, Buffer.from(f.payer.publicKey, 'base64').toString('base64url'));
  assert.equal(bindings[0].contextDigest, sha(canonicalJSON(f.context)));
  assert.equal(bindings[0].custodyJobId, sha('BAINK/server-send-custody/v1\n' + f.context.effects).slice(0, 32));
});

test('custody checker: refusal is terminal, a busy or absent AI checker queues, and nothing is finalized', async () => {
  for (const [decision, status] of [[{ status: 'refused' }, 'refused'], [{ status: 'pending' }, 'queued'], [{ status: 'unavailable' }, 'queued']]) {
    const { result, calls } = await adapter([decision]);
    assert.equal(result.status, status);
    assert.ok(!calls.includes('finalize'));
    if (status === 'queued') assert.ok(Date.parse(result.retryAt) > Date.now());
  }
});

test('custody checker: a queued send names its claim window; an unanswered or claim-held inspect is queued, never shown as a refusal (S7 and simultaneous payments, 10 Nov)', async () => {
  // Queued for the AI checker: custody holds its one approval per intent on this bundle until it expires.
  const ai = await adapter([{ status: 'pending' }]);
  assert.equal(ai.result.status, 'queued'); assert.equal(ai.result.claimExpiresHeight, ai.f.send.packet.request.expires_height);
  // Custody gave no answer (busy with another member's payment, a reader timeout): not a refusal.
  const none = await adapter([], { route: 'unanswered' });
  assert.deepEqual([none.result.status, none.result.reason, none.result.claimExpiresHeight], ['queued', 'checker-unanswered', none.f.send.packet.request.expires_height]);
  assert.ok(!none.calls.includes('finalize') && !none.calls.includes('finalize-rules'));
  // Newer custody names the held claim and the height after which a new bundle is accepted.
  const claim = await adapter([], { route: 'claim-held' });
  assert.deepEqual([claim.result.status, claim.result.reason, claim.result.claimExpiresHeight], ['queued', 'checker-claim-held', '777']);
  // A real rule refusal still reaches the payer with custody's reason.
  assert.equal((await adapter([], { route: 'refuse' })).result.status, 'refused');
});

test('custody checker: an approval for a different amount, member, effects, reviewer or class is rejected', async () => {
  const good = request => ({ reviewer: 'uain1' + sha(Buffer.from(reviewerHex, 'hex')).slice(0, 40), effects: request.effects, purpose_commitment: request.purpose_commitment, class: 'neutral', expires_height: request.expires_height, licence_revision: request.licence_revision, signature: 'x'.repeat(86), direction: 'shield', member: request.member, amount: request.amount });
  assert.equal((await adapter([{ status: 'attested' }], { approval: good })).result.status, 'approved');
  for (const change of [{ amount: '1' }, { member: 'uain1' + '0'.repeat(40) }, { effects: 'b'.repeat(64) }, { reviewer: 'uain1' + '1'.repeat(40) }, { class: 'refuse' }, { expires_height: '999' }]) {
    await assert.rejects(adapter([{ status: 'attested' }], { approval: request => ({ ...good(request), ...change }) }), /custody approval differs/);
  }
});

test('builder runs one coin wallet process at a time (memory bound of the BAINK unit)', async () => {
  const { createCoinWalletSendBuilder } = await import('../server/server-send-builder.mjs');
  const { chmod, readFile: read } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'fictional-coin-wallet-')), tool = join(dir, 'uain-coin-wallet');
  // Fictional stand-in: echoes the boundary request, waits for the approval line, prints a bundle.
  await writeFile(tool, `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin }); let n = 0;
rl.on('line', line => { const v = JSON.parse(line);
  if (n++ === 0) { require('node:fs').writeFileSync(v.review_file, '{}', { mode: 0o600 }); console.log(JSON.stringify({ version: 1, effects: 'a'.repeat(64), purpose_commitment: v.purpose_commitment, expires_height: v.expires_height, licence_revision: v.licence_revision, direction: 'shield', member: v.member, amount: v.amount })); }
  else { process.stdout.write(JSON.stringify({ bundle_hex: 'ab' }) + '\\n', () => process.exit(0)); } });
`);
  await chmod(tool, 0o755);
  let active = 0, maxActive = 0;
  const checker = { publicKeyHex: reviewerHex, async review({ request }) { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 150)); active--; return { status: 'approved', approval: { reviewer: 'r', effects: request.effects, signature: Buffer.alloc(64).toString('base64url') } }; } };
  const builder = createCoinWalletSendBuilder({ coinWallet: { executable: tool, executableSha256: sha(await read(tool)) }, checker, workDirectory: dir });
  const input = n => ({ intentId: String(n), chainId: pins.chainId, member: 'uain1' + 'a'.repeat(40), amountUnits: '5', recipientAddress: 'ab'.repeat(43), memo: '', expiresHeight: '100', licenceRevision: '0', frontier: { root: 'c'.repeat(64), count: '0' }, purposeCommitment: String(n).repeat(64).slice(0, 64), evidence: null });
  try {
    const results = await Promise.all([1, 2, 3].map(n => builder.build(input(n))));
    assert.deepEqual(results.map(r => r.status), ['built', 'built', 'built']);
    assert.equal(maxActive, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// No-install receiving: the payee signs a receiving key; custody derives the address.
import { addressFromViewingKey } from '../review-broker/reviewer-worker.mjs';
import { receivingKeyBytes } from '../server/server-send-check.mjs';
import { generateKeyPairSync as keyPair, sign as edSign } from 'node:crypto';
import { chmod, readFile as readBytes } from 'node:fs/promises';

test('custody accepts a payee-signed receiving key and derives its address with the pinned tool', async (t) => {
  const f = await fixture(), fvk = 'ab'.repeat(96);
  const payeeKeys = keyPair('ed25519'), raw = payeeKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const to = 'uain1' + sha(raw).slice(0, 40);
  const intent0 = { ...f.send.intent, to };
  const payerSend = await (async () => {
    // Re-sign the intent for the new payee with the original payer key.
    const signed = await signSendIntent(f.payer.web, intent0);
    return { ...f.send, intent: signed.intent, signature: signed.signature };
  })();
  const id = sendIntentId(payerSend.intent), context = { ...f.context, purpose: sendPurposeCommitment(id) };
  payerSend.packet = { ...payerSend.packet, request: { ...payerSend.packet.request, purpose_commitment: context.purpose } };
  const keySig = edSign(null, receivingKeyBytes({ member: to, fullViewingKey: fvk, chainId: pins.chainId }), payeeKeys.privateKey).toString('base64url');
  payerSend.registration = { kind: 'key', fullViewingKey: fvk, publicKey: raw.toString('base64'), signature: keySig };
  const ok = validateSendEvidence({ context, send: payerSend, pins });
  assert.equal(ok.receivingKey, fvk);
  for (const change of [
    s => { s.registration = { ...s.registration, fullViewingKey: 'cd'.repeat(96) }; },  // not the key the payee signed
    s => { s.registration = { ...s.registration, signature: s.signature }; },           // not the payee's signature
    s => { s.registration = { ...s.registration, kind: 'address' }; },                  // a key row passed as an address
    s => { s.registration = { ...s.registration, fullViewingKey: 'ab'.repeat(95) }; },  // wrong length
  ]) { const send = structuredClone(payerSend); change(send); assert.throws(() => validateSendEvidence({ context, send, pins })); }
  // The derivation: a pinned tool, refused when its bytes differ from the pin.
  const dir = await mkdtemp(join(tmpdir(), 'fictional-coin-wallet-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, 'uain-coin-wallet');
  await writeFile(tool, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(process.argv[2]!=='address-from-fvk')process.exit(2);const k=JSON.parse(s).full_viewing_key;process.stdout.write(JSON.stringify({address:k.slice(0,86)})+'\\n');});\n`);
  await chmod(tool, 0o700);
  const pin = sha(await readBytes(tool));
  assert.equal(await addressFromViewingKey({ executable: tool, executableSha256: pin }, fvk), fvk.slice(0, 86));
  await assert.rejects(addressFromViewingKey({ executable: tool, executableSha256: 'f'.repeat(64) }, fvk));
  await assert.rejects(addressFromViewingKey({ executable: tool, executableSha256: pin }, 'zz'));
});

test('BAINK derives a receiving key address only with the pinned coin wallet', async (t) => {
  const { addressFromFullViewingKey } = await import('../server/server-send-builder.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fictional-coin-wallet-baink-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, 'uain-coin-wallet');
  await writeFile(tool, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const k=JSON.parse(s).full_viewing_key;if(k.startsWith('00'))process.exit(1);process.stdout.write(JSON.stringify({address:k.slice(0,86)})+'\\n');});\n`);
  await chmod(tool, 0o700);
  const pin = sha(await readBytes(tool)), wallet = { executable: tool, executableSha256: pin };
  assert.equal(await addressFromFullViewingKey(wallet, 'ab'.repeat(96)), 'ab'.repeat(43));
  await assert.rejects(addressFromFullViewingKey(wallet, '00'.repeat(96)), /refused/);
  await assert.rejects(addressFromFullViewingKey({ ...wallet, executableSha256: 'f'.repeat(64) }, 'ab'.repeat(96)), /pin/);
});

// L5 (security review, 13 November 2026): parallel receiving-key registrations spawned one coin
// wallet each (12 at once were seen), each after reading the whole binary to check its pin.
test('receiving-key derivations run one coin wallet at a time', async (t) => {
  const { addressFromFullViewingKey } = await import('../server/server-send-builder.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'fictional-coin-wallet-serial-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, 'uain-coin-wallet'), lock = join(dir, 'running');
  // The fictional tool fails if another copy of it is running at the same moment.
  await writeFile(tool, `#!${process.execPath}\nconst fs=require('node:fs');let fd;try{fd=fs.openSync(${JSON.stringify(lock)},'wx');}catch{process.exit(3);}let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{setTimeout(()=>{fs.closeSync(fd);fs.unlinkSync(${JSON.stringify(lock)});const k=JSON.parse(s).full_viewing_key;process.stdout.write(JSON.stringify({address:k.slice(0,86)})+'\\n');},40);});\n`);
  await chmod(tool, 0o700);
  const wallet = { executable: tool, executableSha256: sha(await readBytes(tool)) };
  const keys = ['ab', 'cd', 'ef', '12', '34', '56'].map((x) => x.repeat(96));
  assert.deepEqual(await Promise.all(keys.map((k) => addressFromFullViewingKey(wallet, k))), keys.map((k) => k.slice(0, 86)));
  // A refused key does not block the ones after it.
  const [bad, good] = await Promise.allSettled([addressFromFullViewingKey({ ...wallet, executableSha256: 'f'.repeat(64) }, keys[0]), addressFromFullViewingKey(wallet, keys[1])]);
  assert.equal(bad.status, 'rejected'); assert.equal(good.value, keys[1].slice(0, 86));
  // The queue is bounded: past 8 derivations in line the rest are refused as busy (BAINK answers
  // 503 receiving_key_unavailable, "try again shortly"), never as a refused key, and none run.
  const many = Array.from({ length: 12 }, (_, i) => (i.toString(16).padStart(2, '0') + 'ab').repeat(48));
  const settled = await Promise.allSettled(many.map((k) => addressFromFullViewingKey(wallet, k)));
  assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 8);
  const busy = settled.filter((x) => x.status === 'rejected');
  assert.equal(busy.length, 4); assert.ok(busy.every((x) => /busy/.test(x.reason.message) && !/refused/.test(x.reason.message)));
  // Once the line clears, derivations run again.
  assert.equal(await addressFromFullViewingKey(wallet, keys[2]), keys[2].slice(0, 86));
});

test('P1: custody-routed rule approvals need no AI decision; AI-routed sends still need one', async () => {
  const rules = await adapter([], { route: 'rules' });
  assert.equal(rules.result.status, 'approved'); assert.equal(rules.result.route, 'rules');
  assert.deepEqual(rules.calls, ['create', 'send-ingest', 'inspect', 'finalize-rules']);
  assert.equal(rules.bindings.length, 0, 'no AI decision was asked for');
  const ai = await adapter([{ status: 'attested' }], { route: 'ai' });
  assert.equal(ai.result.route, 'ai'); assert.deepEqual(ai.calls, ['create', 'send-ingest', 'inspect', 'finalize']); assert.equal(ai.bindings.length, 1);
  const refusedByAi = await adapter([{ status: 'refused' }], { route: 'ai' });
  assert.equal(refusedByAi.result.status, 'refused'); assert.ok(!refusedByAi.calls.includes('finalize-rules'));
  const changed = await adapter([], { route: 'rules', approval: r => ({ reviewer: 'uain1' + sha(Buffer.from(reviewerHex, 'hex')).slice(0, 40), effects: r.effects, purpose_commitment: r.purpose_commitment, class: 'neutral', expires_height: r.expires_height, licence_revision: r.licence_revision, signature: 'x'.repeat(86), direction: 'shield', member: r.member, amount: '1' }) }).catch(e => e);
  assert.ok(changed instanceof Error || changed.result?.status !== 'approved', 'a rules approval for another amount is rejected');
});

test('a custody rule refusal reaches the payer with its reason and nothing is finalized', async () => {
  const r = await adapter([], { route: 'refuse' });
  assert.deepEqual(r.result, { status: 'refused', reason: 'The custody checker refused this payment: member on the refuse list' });
  assert.deepEqual(r.calls, ['create', 'send-ingest', 'inspect']); assert.equal(r.bindings.length, 0);
});
