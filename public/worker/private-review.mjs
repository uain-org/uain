// Private client/checker transport. KeyObjects stay on the member/checker's own machine.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
const limit = 256 * 1024;
const digest = value => createHash('sha256').update(value).digest();
const rawKey = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' })).subarray(-32);
const decode32 = value => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('invalid private context'); return Buffer.from(value, 'hex'); };
// Exact private agreement bytes, salted so public commitments do not expose
// predictable terms. The checker receives both fields over encrypted transport.
export function privatePurposeCommitment({ text, salt }) {
  if (typeof text !== 'string' || !text.length || !text.isWellFormed()) throw new Error('invalid private agreement');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 65536) throw new Error('private agreement too large');
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  return digest(Buffer.concat([Buffer.from('UAIN/private-exchange/purpose/v1\0'), decode32(salt), length, bytes])).toString('hex');
}
function frame(context) {
  if (context.version !== 1 || typeof context.chain !== 'string' || !context.chain.length || context.chain.length > 128 || !/^[1-9][0-9]{0,18}$/.test(context.expires)) throw new Error('invalid private context');
  const height = BigInt(context.expires); if (height > 0x7fffffffffffffffn) throw new Error('invalid expiry');
  const chain = digest(context.chain); const expiry = Buffer.alloc(8); expiry.writeBigUInt64BE(height);
  if (typeof context.licenceRevision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(context.licenceRevision) || BigInt(context.licenceRevision) > 0xffffffffffffffffn) throw new Error('invalid licence revision');
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(context.licenceRevision));
  return Buffer.concat([Buffer.from('UAIN/private-review/context/v1\0'), chain, expiry, revision, decode32(context.effects), decode32(context.purpose), decode32(context.reviewer)]);
}
function xPublic(raw) { return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), decode32(raw)]), type: 'spki', format: 'der' }); }
function certificateBytes(certificate) { return Buffer.concat([frame(certificate.context), decode32(certificate.encryptionKey)]); }
export function reviewCertificate(context, encryptionPublicKey, reviewerSigningKey) {
  const certificate = { context, encryptionKey: rawKey(encryptionPublicKey).toString('hex') };
  certificate.signature = sign(null, certificateBytes(certificate), reviewerSigningKey).toString('base64url');
  return certificate;
}
export function verifyReviewCertificate(certificate, trustedReviewerPublicKey, currentHeight, expectedChain) {
  if (certificate.context.chain !== expectedChain || BigInt(certificate.context.expires) < BigInt(currentHeight) || certificate.context.reviewer !== rawKey(trustedReviewerPublicKey).toString('hex')) throw new Error('wrong or expired reviewer context');
  const signature = Buffer.from(certificate.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== certificate.signature || !verify(null, certificateBytes(certificate), trustedReviewerPublicKey, signature)) throw new Error('invalid reviewer certificate');
  return xPublic(certificate.encryptionKey);
}
export function encryptPrivateReview({ certificate, trustedReviewerPublicKey, currentHeight, chain, packet }) {
  const recipient = verifyReviewCertificate(certificate, trustedReviewerPublicKey, currentHeight, chain);
  const aad = certificateBytes(certificate); const pair = generateKeyPairSync('x25519');
  const secret = diffieHellman({ privateKey: pair.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync('sha256', secret, digest(aad), Buffer.from('UAIN/private-review/key/v1'), 32));
  const plaintext = Buffer.from(JSON.stringify(packet));
  try {
    if (plaintext.length > limit) throw new Error('private review packet too large');
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { certificate, ephemeralKey: rawKey(pair.publicKey).toString('hex'), nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('hex') };
  } finally { secret.fill(0); key.fill(0); plaintext.fill(0); }
}
export function decryptPrivateReview({ envelope, reviewerEncryptionKey, trustedReviewerPublicKey, currentHeight, chain }) {
  const recipient = verifyReviewCertificate(envelope.certificate, trustedReviewerPublicKey, currentHeight, chain);
  if (!rawKey(recipient).equals(rawKey(reviewerEncryptionKey))) throw new Error('wrong review key');
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > Math.ceil(limit * 4 / 3) + 4 || !/^[0-9a-f]{24}$/.test(envelope.nonce) || !/^[0-9a-f]{32}$/.test(envelope.tag)) throw new Error('invalid private review envelope');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  if (ciphertext.toString('base64url') !== envelope.ciphertext) throw new Error('noncanonical private ciphertext');
  const aad = certificateBytes(envelope.certificate);
  const secret = diffieHellman({ privateKey: reviewerEncryptionKey, publicKey: xPublic(envelope.ephemeralKey) });
  const key = Buffer.from(hkdfSync('sha256', secret, digest(aad), Buffer.from('UAIN/private-review/key/v1'), 32));
  let plaintext;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex')); cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } finally { secret.fill(0); key.fill(0); plaintext?.fill(0); }
}
export function privatePartyConsent(context, address, memberSigningKey) {
  if (typeof address !== 'string' || !/^[0-9a-f]{86}$/.test(address)) throw new Error('invalid shielded address');
  const bytes = Buffer.concat([Buffer.from('UAIN/private-review/party-consent/v1\0'), frame(context), Buffer.from(address, 'hex')]);
  return { publicKey: rawKey(memberSigningKey).toString('hex'), address, signature: sign(null, bytes, memberSigningKey).toString('base64url') };
}
export function verifyPrivatePartyConsent(context, consent, trustedLicensedMemberKey) {
  if (consent.publicKey !== rawKey(trustedLicensedMemberKey).toString('hex') || !/^[0-9a-f]{86}$/.test(consent.address)) throw new Error('wrong party identity or address');
  const bytes = Buffer.concat([Buffer.from('UAIN/private-review/party-consent/v1\0'), frame(context), Buffer.from(consent.address, 'hex')]);
  const signature = Buffer.from(consent.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== consent.signature || !verify(null, bytes, trustedLicensedMemberKey, signature)) throw new Error('invalid party consent');
  return true;
}
// The checker receives independently verified current licence/key records and
// the decoded Orchard outputs. Scientific/ethical judgement is its attestation,
// never inferred by the relay from an opaque commitment.
export function signPrivateApproval({ context, reviewerSigningKey, sender, recipient, licensedSenderKey, licensedRecipientKey, trustedRelayerKey, outputs, amount, decision }) {
  if (context.reviewer !== rawKey(reviewerSigningKey).toString('hex')) throw new Error('wrong reviewer identity');
  if (sender.publicKey === recipient.publicKey || [sender.publicKey, recipient.publicKey].includes(context.reviewer)) throw new Error('independent reviewer and two distinct parties required');
  if (!trustedRelayerKey || [sender.publicKey, recipient.publicKey].includes(rawKey(trustedRelayerKey).toString('hex'))) throw new Error('separate relay from the committed activation policy required');
  verifyPrivatePartyConsent(context, sender, licensedSenderKey); verifyPrivatePartyConsent(context, recipient, licensedRecipientKey);
  if (typeof amount !== 'string' || !/^[1-9][0-9]{0,18}$/.test(amount) || BigInt(amount) > 0x7fffffffffffffffn) throw new Error('invalid shielded payment amount');
  // Both recovered outputs must belong to the two consenting licensed members.
  // Checking only the recipient permits change to an unreviewed third party.
  if (sender.address === recipient.address || !Array.isArray(outputs) || outputs.length !== 2 || outputs.some(output => typeof output?.amount !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(output.amount) || BigInt(output.amount) > 0x7fffffffffffffffn) || outputs.filter(output => output.address === recipient.address && output.amount === amount).length !== 1 || outputs.filter(output => output.address === sender.address).length !== 1) throw new Error('reviewed recipient/amount and licensed sender change do not match Orchard outputs');
  const cls = decision?.class === 'benevolent' ? 1 : decision?.class === 'neutral' ? 2 : 0;
  if (!cls || decision.checkedPurpose !== context.purpose || decision.bothLicencesChecked !== true || typeof decision.statement !== 'string' || decision.statement.length < 20 || decision.statement.length > 4000) throw new Error('explicit benevolence/neutrality and licence review required');
  const chain = digest(context.chain); const expiry = Buffer.alloc(8); expiry.writeBigUInt64BE(BigInt(context.expires));
  const revision = Buffer.alloc(8); revision.writeBigUInt64BE(BigInt(context.licenceRevision));
  const bytes = Buffer.concat([Buffer.from('UAIN/private-exchange/approval/v1\0'), chain, expiry, revision, decode32(context.effects), decode32(context.purpose), Buffer.from([cls, 1]), decode32(context.reviewer)]);
  const signature = sign(null, bytes, reviewerSigningKey);
  const reviewer = 'uain1' + digest(decode32(context.reviewer)).subarray(0, 20).toString('hex');
  return { reviewer, effects: context.effects, purpose_commitment: context.purpose, class: decision.class, expires_height: context.expires, licence_revision: context.licenceRevision, signature: signature.toString('base64url') };
}
