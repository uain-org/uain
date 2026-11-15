// Pure helpers for the public Trade deal pages: plain-language status, which
// actions the viewer may take now, and in-browser verification of the signed
// acceptances (the same canonical bytes the server checks).
const STATUS = {
  proposed: ['Waiting for signatures', 'Both parties sign the exact terms before anything is paid.'],
  agreed: ['Signed · awaiting payment', 'The buyer pays before the payment request expires.'],
  paid: ['Paid · in delivery', 'The seller delivers each milestone; the buyer confirms it.'],
  completed: ['Completed', 'Every milestone was confirmed.'],
  disputed: ['In dispute', 'A UAIN trade steward decides under the written policy.'],
  refunded: ['Refunded', 'A refund linked to this deal was ordered or agreed.'],
  cancelled: ['Cancelled', 'This deal was cancelled.'],
  expired: ['Expired', 'Not signed or not paid in time. A steward can reopen an unpaid payment.'],
};
export function dealStatus(status) {
  const [label, hint] = STATUS[status] ?? ['Unknown', ''];
  return { label, hint, tone: ['completed'].includes(status) ? 'good' : ['disputed', 'expired', 'cancelled', 'refunded'].includes(status) ? 'alert' : 'live' };
}
export function roleIn(deal, address) {
  return address === deal?.seller ? 'seller' : address === deal?.buyer ? 'buyer' : null;
}
/** The actions this viewer can take on this deal now (the server checks again). */
export function dealActions(deal, address, { paused = false } = {}) {
  const role = roleIn(deal, address);
  if (!role) return [];
  const s = deal.status, out = [];
  // While Trade is paused for new business the server refuses to sign a deal that is still
  // proposed (trade_paused); dealNotes shows the pause sentence instead (12 November 2026).
  if (s === 'proposed' && !deal.signed?.[role] && !paused) out.push('sign');
  // A deal whose payment already arrived cannot be cancelled (BAINK 0.3.75 refuses it, payment_request_paid):
  // the money comes back through a dispute, so "cancel" is not offered and dealNotes says why.
  const arrived = s === 'agreed' && ['confirm-received', 'settling'].includes(deal.payment?.next?.action);
  if (['proposed', 'agreed', 'paid'].includes(s) && !(deal.cancellation?.requests?.[role]) && !arrived) out.push('cancel');
  // The server names the one payment step and whose it is (payment.next). A request stays "open" until the
  // seller confirms, so "open" alone never means "pay": after a payment landed the buyer waits and the
  // seller confirms (security review 10 November 2026, C4). Without payment.next (an older server) the
  // open request is the only signal there is.
  const step = deal.payment?.next;
  if (s === 'agreed' && role === 'buyer' && deal.payment?.request?.status === 'open' && (step ? step.actor === 'buyer' && step.action === 'pay' : true)) out.push('pay');
  if (s === 'agreed' && step?.actor === role && step.action === 'sign-payment') out.push('sign-payment');
  if (step?.actor === role && step.action === 'confirm-received' && deal.payment?.request?.status !== 'paid') out.push('confirm-received');
  if (['agreed', 'paid'].includes(s)) {
    for (const m of deal.milestones ?? []) {
      if (role === 'seller' && m.status !== 'confirmed') out.push(`deliver:${m.index}`);
      if (role === 'buyer' && m.status === 'delivered') out.push(`confirm:${m.index}`, `reject:${m.index}`);
    }
  }
  if (['paid', 'completed'].includes(s) || (s === 'cancelled' && deal.payment?.request?.status === 'paid')) out.push('refund');
  // One dispute at a time and at most MAX_DISPUTES per deal (dispute_pending, dispute_limit).
  const disputes = deal.disputes ?? [];
  if ((['agreed', 'paid', 'completed'].includes(s) || (s === 'expired' && deal.agreedAt)) && !disputes.some((d) => d.status !== 'final') && disputes.length < MAX_DISPUTES) out.push('dispute');
  // A deal is rated only once it can no longer reopen: the server says so in `rateable` (deal_not_final).
  // A server that does not send it keeps the earlier rule.
  if (['completed', 'refunded', 'cancelled', 'expired'].includes(s) && deal.agreedAt && !deal.ratings?.[role] && deal.rateable !== false) out.push('rate');
  return out;
}
/** The written Trade policy: a deal can be disputed this many times (trade-deals.mjs maxDisputesPerDeal). */
export const MAX_DISPUTES = 3;
/** Why a step this viewer might look for is not offered, in the server's own plain words (BAINK 0.3.75
 * refuses these with deal_not_final, dispute_pending, dispute_limit and payment_request_paid). */
export function dealNotes(deal, address, { pausedSentence = null } = {}) {
  const role = roleIn(deal, address);
  if (!role) return [];
  const s = deal.status, notes = [], disputes = deal.disputes ?? [], live = disputes.find((d) => d.status !== 'final');
  if (pausedSentence && s === 'proposed')
    notes.push({ code: 'trade_paused', text: `${pausedSentence} So this deal cannot be signed now: it expires on its own and no money moves, and you can still cancel it.` });
  if (['completed', 'refunded', 'cancelled', 'expired'].includes(s) && deal.agreedAt && !deal.ratings?.[role] && deal.rateable === false)
    notes.push({ code: 'deal_not_final', text: 'This deal can still reopen (an appeal, an unpaid ordered refund or a payment retry is pending), so you can rate it once that is settled.' });
  if (live)
    notes.push({ code: 'dispute_pending', text: live.status === 'decided'
      ? `This deal's dispute was decided. If you disagree, appeal that decision${live.appealDeadline ? ` by ${live.appealDeadline}` : ''} instead of opening a new dispute.`
      : 'This deal has a dispute in progress. Add your evidence there and wait for the decision.' });
  else if (disputes.length >= MAX_DISPUTES)
    notes.push({ code: 'dispute_limit', text: `A deal can be disputed ${MAX_DISPUTES} times at most, and this one has been.` });
  if (s === 'agreed' && ['confirm-received', 'settling'].includes(deal.payment?.next?.action))
    notes.push({ code: 'payment_request_paid', text: role === 'buyer'
      ? 'Your payment for this deal has been sent, so the deal can no longer be cancelled. If something is wrong, open a dispute to get it back.'
      : 'The payment for this deal has been sent, so the deal can no longer be cancelled.' });
  return notes;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
/** FE-4 (security review, 13 November 2026): true only when the deal digest is the SHA-256 of the
 *  digestInput this browser read (as server/trade-deals.mjs computes it) and that input carries the
 *  same deal, parties, terms, price and milestones the page shows. Sign is offered only then. */
export async function verifyDealDigest(deal, subtle = globalThis.crypto.subtle) {
  try {
    const x = deal?.digestInput;
    if (!x || typeof x !== 'object' || x.schema !== 'baink-trade-deal-v1' || !/^[a-f0-9]{64}$/.test(deal.dealDigest ?? '')) return false;
    const shown = deal.milestones ?? [];
    if (x.dealId !== deal.id || x.seller !== deal.seller || x.buyer !== deal.buyer || canonical(x.terms) !== canonical(deal.terms) || x.terms?.price !== deal.price
      || x.paymentWindowHours !== deal.paymentWindowHours || x.fee?.amountUnits !== '0' || x.fee?.currency !== 'AI$'
      || !Array.isArray(x.milestones) || x.milestones.length !== shown.length || x.milestones.some((m, i) => m?.index !== shown[i]?.index || m?.title !== shown[i]?.title)) return false;
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(canonical(x))));
    return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') === deal.dealDigest;
  } catch {
    return false;
  }
}
/** Verify one stored acceptance with Web Crypto: the party's key signed these exact bytes. */
export async function verifyAcceptance(a, subtle = globalThis.crypto.subtle) {
  try {
    const key = await subtle.importKey('raw', bytes(a.publicKey), 'Ed25519', false, ['verify']);
    const message = new TextEncoder().encode(canonical({ audience: a.audience, method: a.method, path: a.path, body: a.body, nonce: a.nonce, timestamp: a.timestamp }));
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes(a.publicKey)));
    const address = 'uain1' + [...digest].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
    return address === a.address && (await subtle.verify('Ed25519', key, bytes(a.signature), message));
  } catch {
    return false;
  }
}
const EVENT = {
  'offer.published': 'Listed', 'offer.withdrawn': 'Withdrew a listing', 'enquiry.sent': 'Enquired', 'terms.sent': 'Proposed terms',
  'deal.drafted': 'Drafted a deal', 'deal.signed': 'Signed', 'deal.agreed': 'Deal agreed', 'deal.paid': 'Paid', 'deal.completed': 'Completed',
  'deal.cancelled': 'Cancelled', 'deal.cancel-requested': 'Asked to cancel', 'deal.expired': 'Expired', 'deal.refund': 'Refund', 'deal.rated': 'Rated',
  'milestone.delivered': 'Delivered', 'milestone.confirmed': 'Confirmed delivery', 'milestone.rejected': 'Rejected delivery', 'milestone.steward-confirmed': 'Steward confirmed delivery',
  'payment.retry': 'Steward reopened payment', 'steward.note': 'Steward note', 'dispute.opened': 'Dispute opened', 'dispute.evidence': 'Evidence filed',
  'dispute.decided': 'Steward decided', 'dispute.appealed': 'Appealed', 'dispute.appeal-decided': 'Central review decided', 'dispute.final': 'Decision final',
};
export const eventLabel = (type) => EVENT[type] ?? type;
export const shortAddress = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-4)}` : '—');
