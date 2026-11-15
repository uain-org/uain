import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { reviewCertificate, encryptPrivateReview, decryptPrivateReview, privatePartyConsent, verifyPrivatePartyConsent } from './private-review.mjs';
const raw = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' })).subarray(-32).toString('hex');
test('private checker transport conceals terms and rejects wrong keys, context and tampering', () => {
  const reviewer = generateKeyPairSync('ed25519'); const encryption = generateKeyPairSync('x25519'); const stranger = generateKeyPairSync('x25519');
  const context = { version: 1, licenceRevision: '0', chain: 'uain-private-test', expires: '100', effects: '01'.repeat(32), purpose: '02'.repeat(32), reviewer: raw(reviewer.publicKey) };
  const certificate = reviewCertificate(context, encryption.publicKey, reviewer.privateKey);
  const packet = { sender: 'fixture sender', recipient: 'fixture recipient', amount: '26', purpose: 'fictional neutral compute trade', oneTimeViewingKey: 'fictional test key' };
  const args = { certificate, trustedReviewerPublicKey: reviewer.publicKey, currentHeight: 1, chain: context.chain, packet };
  const envelope = encryptPrivateReview(args); const read = { envelope, reviewerEncryptionKey: encryption.privateKey, trustedReviewerPublicKey: reviewer.publicKey, currentHeight: 1, chain: context.chain };
  assert.deepEqual(decryptPrivateReview(read), packet);
  assert.ok(!JSON.stringify(envelope).includes('fixture sender')); assert.ok(!JSON.stringify(envelope).includes('fictional neutral compute trade'));
  assert.throws(() => decryptPrivateReview({ ...read, reviewerEncryptionKey: stranger.privateKey }));
  assert.throws(() => decryptPrivateReview({ ...read, currentHeight: 101 })); assert.throws(() => decryptPrivateReview({ ...read, chain: 'other-epoch' }));
  for (const field of ['nonce', 'ciphertext', 'tag', 'ephemeralKey']) {
    const changed = structuredClone(envelope); changed[field] = (changed[field][0] === 'a' ? 'b' : 'a') + changed[field].slice(1);
    assert.throws(() => decryptPrivateReview({ ...read, envelope: changed }));
  }
  const changed = structuredClone(envelope); changed.certificate.context.effects = '03'.repeat(32); assert.throws(() => decryptPrivateReview({ ...read, envelope: changed }));
  assert.throws(() => encryptPrivateReview({ ...args, packet: { terms: 'x'.repeat(256 * 1024) } }));
});
test('both parties consent with their own identity key; address/effect/chain changes fail', () => {
  const reviewer = generateKeyPairSync('ed25519'); const sender = generateKeyPairSync('ed25519'); const receiver = generateKeyPairSync('ed25519');
  const context = { version: 1, licenceRevision: '0', chain: 'uain-private-test', expires: '100', effects: '01'.repeat(32), purpose: '02'.repeat(32), reviewer: raw(reviewer.publicKey) };
  for (const party of [sender, receiver]) {
    const consent = privatePartyConsent(context, '03'.repeat(43), party.privateKey); assert.ok(verifyPrivatePartyConsent(context, consent, party.publicKey));
    assert.throws(() => verifyPrivatePartyConsent(context, { ...consent, address: '04'.repeat(43) }, party.publicKey));
    assert.throws(() => verifyPrivatePartyConsent({ ...context, chain: 'other-epoch' }, consent, party.publicKey));
    assert.throws(() => verifyPrivatePartyConsent(context, consent, reviewer.publicKey));
  }
});
test('checker signs only a matching confidential payment with independent licensed parties', async () => {
  const { signPrivateApproval } = await import('./private-review.mjs');
  const reviewer = generateKeyPairSync('ed25519'); const senderKey = generateKeyPairSync('ed25519'); const recipientKey = generateKeyPairSync('ed25519');
  const context = { version: 1, licenceRevision: '0', chain: 'uain-private-test', expires: '100', effects: '01'.repeat(32), purpose: '02'.repeat(32), reviewer: raw(reviewer.publicKey) };
  const sender = privatePartyConsent(context, '03'.repeat(43), senderKey.privateKey); const recipient = privatePartyConsent(context, '04'.repeat(43), recipientKey.privateKey);
  const relay = generateKeyPairSync('ed25519');
  const args = { context, trustedRelayerKey: relay.publicKey, reviewerSigningKey: reviewer.privateKey, sender, recipient, licensedSenderKey: senderKey.publicKey, licensedRecipientKey: recipientKey.publicKey, amount: '26', outputs: [{ address: recipient.address, amount: '26' }, { address: sender.address, amount: '44' }], decision: { class: 'neutral', checkedPurpose: context.purpose, bothLicencesChecked: true, statement: 'This isolated fictional compute trade was checked by its fixture reviewer.' } };
  const approved = signPrivateApproval(args); assert.equal(approved.class, 'neutral'); assert.equal(approved.signature.length, 86);
  for (const invalid of [{ trustedRelayerKey: senderKey.publicKey }, { trustedRelayerKey: undefined }, { amount: '27' }, { decision: { ...args.decision, class: 'malevolent' } }, { decision: { ...args.decision, bothLicencesChecked: false } }, { recipient: { ...recipient, address: sender.address } }]) assert.throws(() => signPrivateApproval({ ...args, ...invalid }));
  assert.ok(!JSON.stringify(approved).includes(sender.publicKey)); assert.ok(!JSON.stringify(approved).includes(recipient.address));
});

test('checker refuses third-party change, duplicate recipients and malformed inspected values', async () => {
  const { signPrivateApproval } = await import('./private-review.mjs');
  const reviewer = generateKeyPairSync('ed25519'), senderKey = generateKeyPairSync('ed25519'), recipientKey = generateKeyPairSync('ed25519'), relay = generateKeyPairSync('ed25519');
  const context = { version: 1, licenceRevision: '0', chain: 'uain-private-test', expires: '100', effects: '01'.repeat(32), purpose: '02'.repeat(32), reviewer: raw(reviewer.publicKey) };
  const sender = privatePartyConsent(context, '03'.repeat(43), senderKey.privateKey), recipient = privatePartyConsent(context, '04'.repeat(43), recipientKey.privateKey);
  const args = { context, trustedRelayerKey: relay.publicKey, reviewerSigningKey: reviewer.privateKey, sender, recipient, licensedSenderKey: senderKey.publicKey, licensedRecipientKey: recipientKey.publicKey, amount: '26', outputs: [{ address: recipient.address, amount: '26' }, { address: sender.address, amount: '44' }], decision: { class: 'neutral', checkedPurpose: context.purpose, bothLicencesChecked: true, statement: 'Both licensed members and all private outputs were checked for this fictional trade.' } };
  assert.equal(signPrivateApproval(args).class, 'neutral');
  const withChange = output => ({ ...args, outputs: [args.outputs[0], output] });
  assert.throws(() => signPrivateApproval(withChange({ address: '05'.repeat(43), amount: '44' })), /licensed sender change/);
  assert.throws(() => signPrivateApproval(withChange({ address: recipient.address, amount: '44' })), /licensed sender change/);
  for (const amount of [44, '044', '-1', '9223372036854775808', undefined]) assert.throws(() => signPrivateApproval(withChange({ address: sender.address, amount })), /licensed sender change/);
  const sameAddress = privatePartyConsent(context, sender.address, recipientKey.privateKey);
  assert.throws(() => signPrivateApproval({ ...args, recipient: sameAddress }), /licensed sender change/);
  assert.equal(signPrivateApproval(withChange({ address: sender.address, amount: '0' })).class, 'neutral');
  const maximum = '9223372036854775807';
  assert.equal(signPrivateApproval({ ...args, amount: maximum, outputs: [{ address: recipient.address, amount: maximum }, { address: sender.address, amount: '0' }] }).class, 'neutral');
});
