/** Trusted model instructions selected only from the authenticated operation name.
 * These instructions never turn a purpose assertion into verified external facts.
 * The original inspected request bytes and decision audit remain unchanged.
 */
export const REVIEW_OPERATION_POLICY_VERSION = 'baink-operation-review-v2';

const boundary = Object.freeze({
  coin_shield: 'coin_shield moves the one licensed owner\'s transparent funds into that owner\'s private wallet.',
  coin_exit: 'coin_exit moves the one licensed owner\'s private funds back to that owner\'s transparent balance.',
});

export function operationReviewInstructions(request) {
  let operation;
  try { operation = JSON.parse(request)?.report?.inspection?.operation; } catch {}
  if (typeof operation === 'string' && Object.hasOwn(boundary, operation)) return [
    `TRUSTED OPERATION CONTRACT ${REVIEW_OPERATION_POLICY_VERSION}: ${boundary[operation]}`,
    'This is NOT a bilateral payment. Its protocol requires invoice=null and purposeEvidence=null; invoiceAgreed=false, purposeEvidenceVerified=false and bothLicencesChecked=false are EXPECTED, not missing required evidence.',
    'Use ownerLicenceChecked, consentsVerified and reviewerAppointed for this single-owner operation. Echo bothLicencesChecked=false; do not invent a second party.',
    'An explicit ordinary use of one\'s own funds may be neutral without an invoice, external provenance of earnings, or a digest-bound payment memo. Assess the actual declared purpose, which is bound by inspection.context.purpose to the inspected agreement. Do not treat claims about an award, delivered service or invoice as independently verified facts.',
    'Do NOT refuse solely because bilateral-payment-only fields are absent/false or external references are unverified. Do NOT automatically approve: refuse harmful, prohibited, deceptive, opaque or insufficiently specified purposes, missing owner/consent/appointment checks, or inconsistent inspected facts.',
  ].join('\n');
  if (operation === 'private_payment') return [
    `TRUSTED OPERATION CONTRACT ${REVIEW_OPERATION_POLICY_VERSION}: private_payment is a bilateral payment, NOT a single-owner boundary move.`,
    'Require the inspected agreed invoice, nonempty digest-bound purposeEvidence memo, both licensed parties, verified consents, reviewer appointment, and all invoice/purpose checks. Boundary exceptions do not apply. Refuse missing, false, inconsistent or opaque payment evidence and harmful/prohibited purposes.',
  ].join('\n');
  if (operation === 'server_send') return [
    `TRUSTED OPERATION CONTRACT ${REVIEW_OPERATION_POLICY_VERSION}: server_send is a payment from the payer's own public AI$ balance to another licensed member (a coin_shield whose paid note belongs to the payee), built by the BAINK server. Payments between members are public and ordinary on this platform (decisions K-19, K-38).`,
    'Custody authenticated, before this review: the payer\'s own signature on the send intent (payee, amount, memo, expiry), the payee\'s own signature on its receiving address, the payer\'s active licence, key and balance, and both decrypted outputs: exactly one pays the registered recipient the exact amount and the other is zero (recipientAndAmountMatch, payerIntentSigned, payeeAddressSigned). purposeEvidence is the signed intent summary bound to inspection.context.purpose.',
    'This is NOT the invoice-based private_payment protocol: invoice=null, invoiceAgreed=false and bothLicencesChecked=false are EXPECTED (BAINK checks the payee licence before building). Use ownerLicenceChecked, consentsVerified and reviewerAppointed. A short or empty memo is not by itself a reason to refuse an ordinary member-to-member payment.',
    'Do NOT automatically approve: refuse when the memo or inspected facts indicate a harmful, prohibited, deceptive or coercive purpose, or when the outputs, value balance, parties, signatures or checks are missing or inconsistent. Do not treat claims in the memo as independently verified facts.',
  ].join('\n');
  return `TRUSTED OPERATION CONTRACT ${REVIEW_OPERATION_POLICY_VERSION}: unsupported or missing operation; refuse. Never infer a boundary exemption from agreement text.`;
}
