// Owner/checker Coin boundary approvals. Private agreement text stays encrypted;
// direction, owner and amount are deliberately public at pool entry/exit.
import { createHash, createPublicKey, sign } from 'node:crypto';
import { privatePurposeCommitment, verifyPrivatePartyConsent } from './private-review.mjs';
export const coinPolicy = 'verified-bounties-108t-micro-v1';
const hash = value => createHash('sha256').update(value).digest();
const raw = key => Buffer.from((key.type === 'public' ? key : createPublicKey(key)).export({ type: 'spki', format: 'der' })).subarray(-32);
const hex32 = value => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error('invalid boundary digest'); return Buffer.from(value, 'hex'); };
const uint = (value, max, zero = false) => {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value) || value.length > 20 || BigInt(value) > max) throw new Error('canonical bounded decimal boundary units required');
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b;
};
function metadata({ direction, member, amount }) {
  if (!['shield', 'exit'].includes(direction) || typeof member !== 'string' || !/^uain1[0-9a-f]{40}$/.test(member)) throw new Error('invalid boundary owner/direction');
  return Buffer.concat([hash(coinPolicy), Buffer.from([direction === 'shield' ? 1 : 2]), Buffer.from(member.slice(5), 'hex'), uint(amount, 0x7fffffffffffffffn)]);
}
export function coinBoundaryPurposeCommitment(agreement, boundary) {
  return hash(Buffer.concat([Buffer.from('UAIN/coin-boundary/purpose/v1\0'), metadata(boundary), hex32(privatePurposeCommitment(agreement))])).toString('hex');
}
export function coinBoundaryApprovalBytes(context, boundary, classification) {
  if (context.version !== 1 || typeof context.chain !== 'string' || !context.chain.length || context.chain.length > 128) throw new Error('invalid boundary chain');
  const cls = classification === 'benevolent' ? 1 : classification === 'neutral' ? 2 : 0;
  if (!cls) throw new Error('explicit benevolent/neutral review required');
  const meta = metadata(boundary);
  return Buffer.concat([Buffer.from('UAIN/coin-boundary/approval/v1\0'), meta.subarray(0, 32), hash(context.chain), uint(context.expires, 0x7fffffffffffffffn), uint(context.licenceRevision, 0xffffffffffffffffn, true), hex32(context.effects), hex32(context.purpose), Buffer.from([cls, 1]), hex32(context.reviewer), meta.subarray(32)]);
}
export function signCoinBoundaryApproval({ context, boundary, agreement, reviewerSigningKey, licensedOwnerKey, consents, outputs, valueBalance, decision }) {
  const bytes = coinBoundaryApprovalBytes(context, boundary, decision?.class);
  if (context.reviewer !== raw(reviewerSigningKey).toString('hex') || boundary.member !== 'uain1' + hash(raw(licensedOwnerKey)).subarray(0, 20).toString('hex') || raw(licensedOwnerKey).equals(raw(reviewerSigningKey))) throw new Error('proven owner and independent reviewer required');
  if (coinBoundaryPurposeCommitment(agreement, boundary) !== context.purpose || decision.checkedPurpose !== context.purpose || decision.ownerLicenceChecked !== true || typeof decision.statement !== 'string' || decision.statement.length < 20 || decision.statement.length > 4000) throw new Error('exact purpose and licensed boundary review required');
  const expected = (boundary.direction === 'shield' ? -1n : 1n) * BigInt(boundary.amount);
  if (valueBalance !== expected.toString() || !Array.isArray(outputs) || outputs.length !== 2 || !Array.isArray(consents) || consents.length < 1 || consents.length > 2) throw new Error('inspected boundary value balance and two owned outputs required');
  for (const consent of consents) verifyPrivatePartyConsent(context, consent, licensedOwnerKey);
  let total = 0n;
  for (const output of outputs) {
    uint(output.amount, 0x7fffffffffffffffn, true);
    if (!consents.some(consent => consent.address === output.address)) throw new Error('boundary output lacks licensed owner consent');
    total += BigInt(output.amount);
  }
  if (boundary.direction === 'shield' && total !== BigInt(boundary.amount)) throw new Error('entry outputs differ from the debited amount');
  return { reviewer: 'uain1' + hash(raw(reviewerSigningKey)).subarray(0, 20).toString('hex'), effects: context.effects, purpose_commitment: context.purpose, class: decision.class, expires_height: context.expires, licence_revision: context.licenceRevision, direction: boundary.direction, member: boundary.member, amount: boundary.amount, signature: sign(null, bytes, reviewerSigningKey).toString('base64url') };
}
