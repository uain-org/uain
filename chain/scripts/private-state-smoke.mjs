#!/usr/bin/env node
// Disposable SDK/client acceptance fixture. Every key below is fictional.
// No real member key, agreement, spending key or viewing key is printed.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { readPrivateState, signApprovalFromPrivateState } from '../client/private-state.mjs';
import { reviewCertificate, encryptPrivateReview, decryptPrivateReview, privatePartyConsent, privatePurposeCommitment } from '../client/private-review.mjs';
const [reader, wallet] = process.argv.slice(2);
if (!reader || !wallet) throw new Error('fixture reader/wallet binaries required');
let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('oversized fixture request'); }
const config = JSON.parse(input); const hash = createHash('sha256');
for await (const bytes of createReadStream(reader)) hash.update(bytes);
const options = { executable: reader, executableSha256: hash.digest('hex'), ...config };
const state = await readPrivateState(options);
assert.equal(state.count, '4'); assert.equal(state.payments.length, 1);
assert.ok(Object.isFrozen(state) && Object.isFrozen(state.parties) && Object.isFrozen(state.commitments));
await assert.rejects(readPrivateState({ ...options, genesisSha256: '00'.repeat(32) }), /independent pin/);
await assert.rejects(readPrivateState({ ...options, request: { ...config.request, parties: [config.request.parties[0], config.request.parties[0]] } }), /distinct members/);
assert.throws(() => signApprovalFromPrivateState({ state: JSON.parse(JSON.stringify(state)), context: {} }), /pinned finalized-state reader/);
const fixtureKey = seed => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), type: 'pkcs8', format: 'der' });
const sender = fixtureKey(5), recipient = fixtureKey(6), reviewer = fixtureKey(42);
const raw = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
assert.equal(raw(sender).toString('base64url'), state.parties[0].public_key);
assert.equal(raw(recipient).toString('base64url'), state.parties[1].public_key);
assert.equal(raw(reviewer).toString('base64url'), state.reviewer.public_key);
const root = await mkdtemp(join(tmpdir(), 'uain-private-state-wallet-fixture-'));
const senderFile = join(root, 'fictional-spending-key'); await writeFile(senderFile, Buffer.alloc(32, 1), { mode: 0o600, flag: 'wx' });
const receiver = spawnSync(wallet, ['keygen', join(root, 'fictional-receiver-key')], { encoding: 'utf8' });
assert.equal(receiver.status, 0, receiver.stderr); const address = JSON.parse(receiver.stdout).address;
let payment;
const agreement = { text: 'Fictional neutral compute service for seventeen disposable test units.', salt: randomBytes(32).toString('hex') };
const purpose = privatePurposeCommitment(agreement);
for (const position of [2, 3]) {
  const reviewFile = join(root, `fictional-review-${position}.json`);
  const child = spawn(wallet, ['pay'], { stdio: ['pipe', 'pipe', 'pipe'] }); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; }); const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  child.stdin.write(JSON.stringify({ chain_id: state.chain_id, expires_height: Number(state.height) + 400, licence_revision: state.licence_revision, key_file: senderFile, commitments: state.commitments, expected_root: state.root, source_bundle: Buffer.from(state.payments[0].bundle, 'base64url').toString('hex'), source_position: position, recipient: address, amount: 17, purpose_commitment: purpose, reviewer_public_key: raw(reviewer).toString('hex'), memo: 'fictional neutral compute exchange', review_file: reviewFile }) + '\n');
  const first = await lines.next();
  if (first.done) { const [code] = await closed; assert.equal(code, 1); continue; }
  const requested = JSON.parse(first.value);
  const context = { version: 1, chain: state.chain_id, expires: String(requested.expires_height), licenceRevision: state.licence_revision, effects: requested.effects, purpose: requested.purpose_commitment, reviewer: raw(reviewer).toString('hex') };
  const encryption = generateKeyPairSync('x25519'); const certificate = reviewCertificate(context, encryption.publicKey, reviewer);
  const packet = JSON.parse(await readFile(reviewFile, 'utf8'));
  packet.agreement = agreement;
  const envelope = encryptPrivateReview({ certificate, trustedReviewerPublicKey: createPublicKey(reviewer), currentHeight: state.height, chain: state.chain_id, packet });
  assert.ok(!JSON.stringify(envelope).includes(packet.one_time_viewing_key));
  const recovered = decryptPrivateReview({ envelope, reviewerEncryptionKey: encryption.privateKey, trustedReviewerPublicKey: createPublicKey(reviewer), currentHeight: state.height, chain: state.chain_id });
  const inspectionFile = join(root, `fictional-inspection-${position}.json`); await writeFile(inspectionFile, JSON.stringify(recovered), { mode: 0o600, flag: 'wx' });
  const inspection = spawnSync(wallet, ['inspect-review', inspectionFile], { encoding: 'utf8' }); assert.equal(inspection.status, 0, inspection.stderr);
  const inspected = JSON.parse(inspection.stdout); assert.equal(inspected.effects, context.effects);
  const change = inspected.outputs.find(output => output.amount === '27'); assert.ok(change);
  const review = { state, context, agreement: recovered.agreement, reviewerSigningKey: reviewer, sender: privatePartyConsent(context, change.address, sender), recipient: privatePartyConsent(context, address, recipient), outputs: inspected.outputs, amount: '17', decision: { class: 'neutral', checkedPurpose: context.purpose, bothLicencesChecked: true, statement: 'The fictional SDK parties and agreement were checked using independently pinned finalized state.' } };
  assert.throws(() => signApprovalFromPrivateState({ ...review, agreement: { ...agreement, text: `${agreement.text} changed` } }), /private agreement differs/);
  assert.throws(() => signApprovalFromPrivateState({ ...review, agreement: { ...agreement, salt: '00'.repeat(32) } }), /private agreement differs/);
  assert.throws(() => signApprovalFromPrivateState({ ...review, context: { ...context, licenceRevision: '999' } }), /finalized policy/);
  assert.throws(() => signApprovalFromPrivateState({ ...review, context: { ...context, chain: 'different-epoch' } }), /finalized policy/);
  const approval = signApprovalFromPrivateState(review);
  child.stdin.end(JSON.stringify({ effects: approval.effects, purpose_commitment: approval.purpose_commitment, class: approval.class, expires_height: Number(approval.expires_height), licence_revision: approval.licence_revision, signature: Buffer.from(approval.signature, 'base64url').toString('hex') }) + '\n');
  const last = await lines.next(); assert.equal(last.done, false);
  const result = JSON.parse(last.value); const [code] = await closed; assert.equal(code, 0, stderr);
  payment = { bundle: Buffer.from(result.bundle_hex, 'hex').toString('base64url'), approval }; break;
}
assert.ok(payment, 'no owned change note in authenticated SDK state');
assert.ok(!JSON.stringify(payment).includes(state.parties[0].member));
assert.ok(!JSON.stringify(payment).includes(state.parties[1].member));
assert.ok(!JSON.stringify(payment).includes(address));
console.log(JSON.stringify(payment)); // Only the public native payment, consumed by the SDK test.
