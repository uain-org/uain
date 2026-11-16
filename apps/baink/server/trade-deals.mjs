// Public, binding Trade deals on top of sent terms proposals and payment requests.
//
// A deal binds one sent proposal. Both parties accept the exact deal digest with
// their own signed BAINK request; the stored acceptance is the canonical signed
// request, which anyone can re-verify with the party's public key. When both have
// signed, the payment request is created with an expiry. The private native
// payment itself is unchanged (holder-signed, server-submitted once); this module
// never sends value. Delivery runs through milestones the buyer confirms.
// Refunds are payment requests linked to the deal. Disputes are decided by
// configured UAIN trade stewards under the written policy below, never by a
// party; a party may appeal once to configured central reviewers, who must
// differ from the deciding steward. Every deal, decision and outcome is public
// (decision 9 November 2026).
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createTradeTermsService } from './trade-terms.mjs';
import { tradeProposalDigest, tradePaymentMemo } from './trade-payment.mjs';
import { formatNativeUnits, nativeUnitsFromDecimal } from './native-asset.mjs';
import { paymentRequestExpiresAt } from './native-payments.mjs';
import { SEND_CLOSED as SEND_DEAD, sendsFor, intentsFor, sendMayHaveDebited, requestPaidBy } from './request-payment-guard.mjs';

export const TRADE_POLICY = Object.freeze({
  version: 'baink-trade-policy-v1',
  feeUnits: '0',
  defaultPaymentWindowHours: 72,
  maxPaymentWindowHours: 720,
  unsignedDealDays: 14,
  deliveryConfirmDays: 7,
  appealDays: 7,
  stuckPaymentMinutes: 60,
  // Deal outcomes of the 10 November 2026 security review.
  unconfirmedPaymentGraceHours: 24, // then a payment proved on the ledger counts as paid for refund outcomes
  orderedRefundDays: 7,             // an ordered refund not paid by then is recorded as refused (P12)
  cancelConsentDays: 7,             // one party's consent to cancel a paid deal lapses after this
  maxDisputesPerDeal: 3,
  clauses: Object.freeze({
    'P1-terms': 'The signed deal digest (terms, price, milestones, payment window) is the whole agreement. Statements outside it do not change it.',
    'P2-payment-first': 'The buyer pays before or during delivery. A recorded private payment is final on the ledger; recourse is a linked refund.',
    'P3-delivery': 'The seller delivers each milestone with evidence. The buyer confirms or rejects it with a reason. Silence for 7 days after the last delivery lets a steward confirm it.',
    'P4-acceptance-criteria': 'A dispute about quality is judged against the signed acceptance criteria and the evidence both parties filed, not against expectations outside the terms.',
    'P5-non-delivery': 'If the seller does not deliver after payment, the buyer is owed a full refund.',
    'P6-partial-delivery': 'If only some milestones meet the criteria, the refund is proportional to the undelivered milestones.',
    'P7-failed-payment': 'A payment that failed before it reached the ledger is retried after reconciliation shows no send happened. A payment never sends twice.',
    'P8-cancel': 'Before payment either party may cancel. After payment a cancellation needs both parties or a steward decision, and it refunds the buyer.',
    'P9-independence': 'A steward never decides a deal it is party to. An appeal is decided by a central reviewer other than the deciding steward.',
    'P10-evidence': 'Each party may file up to 20 evidence statements. Evidence not filed before the decision is not considered, except on appeal.',
    'P11-public': 'Deals, payments, deliveries, disputes, decisions, appeals and ratings are public. Private keys, wallet notes and payment proofs are never published.',
    'P12-refund-refused': 'A seller who declines a refund ordered by a decision is recorded publicly and referred to central review for a Karma penalty; ratings alone never change Karma.',
  }),
});

const ADDRESS = /^uain1[a-f0-9]{40}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CLIENT = /^[A-Za-z0-9_-]{8,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMITS = { deals: 5000, disputes: 2000, decisions: 5000, intents: 20000, events: 4000, rate: 5000 };
// Storage bounds (10 November 2026 security review): every deal copies its proposal, and closed
// deals are kept, so draft-and-cancel rounds could fill the whole shared BAINK store (8 MB) in
// minutes and refuse every member's writes. Deals now get their own budget well below the store
// limit, a proposal can be drafted only a few times, and each identity a few dozen times a day.
const DEAL_BUDGET_BYTES = 2 * 1024 * 1024, DEALS_PER_PROPOSAL = 3, DEALS_PER_IDENTITY_PER_DAY = 20;
const MAX_WRITES = 60, WINDOW = 60_000;
const DAY = 86_400_000, HOUR = 3_600_000;
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const OUTCOMES = ['refund-full', 'refund-partial', 'no-refund', 'redeliver', 'cancel-deal'];
const DESIRED = ['refund', 'partial-refund', 'redelivery', 'release-payment', 'cancel', 'other'];
const CLOSED = ['completed', 'cancelled', 'expired', 'refunded'];
const LIVE_REQUEST = ['open', 'paid'];
/** Another deal or payment request now carries this deal's proposal (10 November 2026 security
 *  review): reviving this one would let the buyer pay twice for one proposal. */
function superseded(state, d, deal, requestId) {
  return Object.values(d.deals).some((x) => x.id !== deal.id && x.proposalId === deal.proposalId && !['cancelled', 'expired'].includes(x.status))
    || Object.values(state.requests ?? {}).some((r) => r.id !== requestId && r.trade?.proposal?.id === deal.proposalId && LIVE_REQUEST.includes(r.status));
}

export class TradeDealError extends Error {
  constructor(status, code, message) { super(message); this.name = 'TradeDealError'; this.status = status; this.code = code; }
}
const check = (ok, status, code, message) => { if (!ok) throw new TradeDealError(status, code, message); };
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
export function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (record(x)) return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
const sha = (x) => createHash('sha256').update(typeof x === 'string' ? x : canonical(x)).digest('hex');
const only = (body, required, optional = []) => check(record(body) && required.every((k) => Object.hasOwn(body, k)) && Object.keys(body).every((k) => required.includes(k) || optional.includes(k)), 400, 'invalid_trade_body', 'The request contains missing or unsupported fields.');
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function text(x, max, label, { optional = false, min = 1 } = {}) {
  if (x === undefined && optional) return null;
  check(typeof x === 'string' && Buffer.byteLength(x) <= max && !BAD_TEXT.test(x) && x.trim().length >= min, 400, 'invalid_trade_body', `${label} must be text of ${min} to ${max} bytes.`);
  return x.trim();
}
const id = (x, label = 'identifier') => { check(typeof x === 'string' && ID.test(x), 400, 'invalid_identifier', `Enter a valid ${label}.`); return x; };
const client = (x) => { check(typeof x === 'string' && CLIENT.test(x), 400, 'invalid_request_id', 'Use a client request identifier of 8–100 letters, numbers, dashes or underscores.'); return x; };
const hash = (x, label) => { check(typeof x === 'string' && HASH.test(x), 400, 'invalid_trade_body', `${label} must be a SHA-256 hex digest.`); return x; };
function evidenceLink(body) {
  const url = body.url === undefined ? null : text(body.url, 1500, 'Evidence URL');
  check(url === null || /^https:\/\/[^\s]+$/.test(url), 400, 'invalid_trade_body', 'Evidence URLs must be https.');
  const sha256 = body.sha256 === undefined ? null : hash(body.sha256, 'Evidence digest');
  return { url, sha256 };
}
function amountUnits(x) {
  try { const u = nativeUnitsFromDecimal(x); check(BigInt(u) > 0n, 400, 'invalid_amount', 'Enter a positive AI$ amount.'); return u; }
  catch (e) { if (e instanceof TradeDealError) throw e; check(false, 400, 'invalid_amount', 'Enter a positive AI$ amount with at most six decimal places.'); }
}
function principal(user) {
  check(record(user) && typeof user.address === 'string' && ADDRESS.test(user.address) && typeof user.publicKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(user.publicKey), 401, 'authentication_required', 'A signed BAINK identity is required.');
  const raw = Buffer.from(user.publicKey, 'base64');
  check(raw.length === 32 && 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40) === user.address, 401, 'invalid_identity', 'The public key must match the signed identity address.');
  return user;
}

/** Re-verify a stored signed acceptance: the exact canonical BAINK request the party signed. */
export function verifySignedRequest(s) {
  try {
    if (!record(s) || typeof s.signature !== 'string' || typeof s.publicKey !== 'string') return false;
    const message = canonical({ audience: s.audience, method: s.method, path: s.path, body: s.body, nonce: s.nonce, timestamp: s.timestamp });
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(s.publicKey, 'base64')]), format: 'der', type: 'spki' });
    const raw = Buffer.from(s.publicKey, 'base64');
    return verify(null, Buffer.from(message), key, Buffer.from(s.signature, 'base64')) && 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40) === s.address;
  } catch { return false; }
}

function storage(state, write = false) {
  check(record(state), 503, 'trade_deal_storage_invalid', 'Trade deal storage is unavailable.');
  if (state.tradeDeals === undefined) {
    const empty = { version: 1, deals: {}, disputes: {}, decisions: [], events: [], intents: {}, rate: {}, sequence: 0 };
    if (!write) return empty;
    state.tradeDeals = empty;
  }
  const d = state.tradeDeals;
  check(record(d) && d.version === 1 && record(d.deals) && record(d.disputes) && Array.isArray(d.decisions) && Array.isArray(d.events) && record(d.intents) && record(d.rate), 503, 'trade_deal_storage_invalid', 'Trade deal storage has an unsupported format.');
  return d;
}
function limitWrites(d, user, stamp) {
  for (const [k, b] of Object.entries(d.rate)) if (stamp - b.startedAt >= WINDOW) delete d.rate[k];
  const b = d.rate[user.address] ?? (d.rate[user.address] = { startedAt: stamp, count: 0 });
  check(Object.keys(d.rate).length <= LIMITS.rate, 503, 'trade_capacity', 'Trade is busy right now, so try again in a minute.');
  check(b.count < MAX_WRITES, 429, 'trade_rate_limited', `Trade allows ${MAX_WRITES} deal changes per identity per minute. Retry later.`);
  b.count++;
}
function remember(d, user, clientRequestId, fingerprint, produce) {
  const key = user.address + '/' + clientRequestId;
  const prior = Object.hasOwn(d.intents, key) ? d.intents[key] : null;
  if (prior) {
    check(prior.fingerprint === fingerprint, 409, 'idempotency_conflict', 'This clientRequestId was already used for a different step, so give a new one.');
    return { replay: true, ref: prior.ref };
  }
  const ref = produce();
  const keys = Object.keys(d.intents);
  if (keys.length >= LIMITS.intents) for (const k of keys.slice(0, keys.length - LIMITS.intents + 1)) delete d.intents[k];
  d.intents[key] = { fingerprint, ref, at: new Date().toISOString() };
  return { replay: false, ref };
}
/** L1 (security review, 13 November 2026): the event and decision lists are global and bounded,
 *  and they evicted the oldest entry first, so one busy deal could push every other deal's public
 *  record out. Now one deal keeps at most `perDeal` entries (its own repeats of the same kind go
 *  first), and when the whole list is full the deal holding the most entries gives up its oldest. */
const PER_DEAL = { events: 400, decisions: 200 };
function bound(list, added, max, perDeal, kind) {
  if (added.dealId) {
    const mine = list.filter((e) => e.dealId === added.dealId);
    for (let excess = mine.length - perDeal; excess > 0; excess--) {
      const i = mine.findIndex((e) => e !== added && kind(e) === kind(added)), drop = mine.splice(i >= 0 ? i : 0, 1)[0];
      list.splice(list.indexOf(drop), 1);
    }
  }
  while (list.length > max) {
    const counts = new Map();
    for (const e of list) counts.set(e.dealId ?? null, (counts.get(e.dealId ?? null) ?? 0) + 1);
    let top = null, most = -1;
    for (const [k, n] of counts) if (n > most) { top = k; most = n; }
    list.splice(list.findIndex((e) => (e.dealId ?? null) === top), 1);
  }
}
function emit(d, event) {
  d.sequence = (d.sequence ?? 0) + 1;
  const added = { seq: d.sequence, at: new Date().toISOString(), ...event };
  d.events.push(added);
  bound(d.events, added, LIMITS.events, PER_DEAL.events, (e) => e.type);
}
function recordDecision(d, entry) { d.decisions.push(entry); bound(d.decisions, entry, LIMITS.decisions, PER_DEAL.decisions, (e) => e.kind); }
function units(deal) { return BigInt(deal.terms.priceUnits); }
function refundedUnits(state, deal, { includeOpen = true } = {}) {
  return deal.refunds.reduce((sum, r) => {
    const q = state.requests?.[r.requestId];
    return q && (q.status === 'paid' || (includeOpen && q.status === 'open')) ? sum + BigInt(r.amountUnits) : sum;
  }, 0n);
}
function paymentRequest(state, deal) { return deal.paymentRequestId ? state.requests?.[deal.paymentRequestId] ?? null : null; }
function paid(state, deal) { return paymentRequest(state, deal)?.status === 'paid'; }
/** D1 (security review, 10 November 2026). "Paid" above means the seller confirmed receipt. A
 *  payment proved on the ledger that the seller never confirms left the buyer with no refund and
 *  no cancel. After the grace period such a payment counts as paid for refund outcomes. */
function landedPayment(state, deal) { const q = paymentRequest(state, deal); return q ? requestPaidBy(state, q.id) : null; }
function refundable(state, deal) {
  if (paid(state, deal)) return true;
  const landed = landedPayment(state, deal), at = Date.parse(landed?.at);
  return Boolean(landed && Number.isFinite(at) && at + TRADE_POLICY.unconfirmedPaymentGraceHours * HOUR <= viewNow());
}
/** Refunds ordered by a steward or appeal decision (policy P12 applies to these). */
const ORDERED = ['steward-decision', 'appeal-decision'];
/** B2-1 (security review, 13 November 2026): refunds the seller is bound to pay, with a deadline,
 *  and recorded as refused (P12) when declined or left unpaid: the ordered ones and the refund
 *  both parties agreed when they cancelled a paid deal. A refused one reopens the deal to paid. */
const BINDING = [...ORDERED, 'mutual-cancel'];
/** Only a mutual-cancel refund created under that rule is bound by it (createRefund marks it):
 *  one agreed before this release had no deadline and stays exactly as the earlier code left it. */
const binding = (r) => ORDERED.includes(r.source) || (r.source === 'mutual-cancel' && r.binding === true);
/** C7: a closed deal that can still reopen: an appeal can overturn its decision, a refused
 *  binding refund returns it to paid, a steward can reopen an expired payment. */
function reopenable(state, deal) {
  const d = state.tradeDeals;
  if ((deal.disputeIds ?? []).some((x) => d?.disputes?.[x] && d.disputes[x].status !== 'final')) return true;
  if (['refunded', 'cancelled'].includes(deal.status) && deal.refunds.some((r) => binding(r) && !r.paidAt && !r.refusedAt && state.requests?.[r.requestId]?.status === 'open')) return true;
  if (deal.status === 'refunded') return false;
  if (deal.status === 'expired') return Boolean(d) && !superseded(state, d, deal, deal.paymentRequestId);
  return false;
}
// No-install server sends (server-send.mjs) pay deal requests too. A send that
// ended without a debit (expired, cancelled, checker-refused) frees the request;
// a live or finalized-but-unconfirmed one holds it like a holder-path intent.
// The journal scans live in request-payment-guard.mjs, shared by every payment guard.
// Any live send counts, not only the one named by the request lock: a lock can
// be replaced while an earlier send is finalized but not yet confirmed (the
// 10 Nov double-pay defect), and that send must still hold the request.
function heldSend(state, requestId) {
  if (!requestId) return null;
  const live = sendsFor(state, requestId).filter((r) => !SEND_DEAD.includes(r.status) && !(r.status === 'finalized' && r.recipientConfirmation));
  return live.find((r) => r.status === 'finalized') ?? live.find((r) => r.id === state.serverSendRequestLocks?.[requestId]) ?? live[0] ?? null;
}
// A wallet payment recorded on the ledger holds the request too until the recipient confirms it,
// even if its lock is gone.
function locked(state, requestId) { return Boolean(requestId && (state.nativePaymentRequestLocks?.[requestId] || heldSend(state, requestId) || intentsFor(state, requestId).some((i) => i.status === 'ledger-recorded'))); }
/** The one next step on a deal payment, and whose it is (public, like the deal). */
function paymentNext(state, deal, q, retries) {
  if (!q || q.status === 'paid') return null;
  const reopened = retries.length > 0 ? { reopenedAt: retries.at(-1).at, retries: retries.length } : {};
  const held = heldSend(state, q.id);
  if (held?.status === 'finalized') return { actor: 'seller', action: 'confirm-received', requestId: q.id, send: held.id, why: 'The payment arrived. The seller confirms receipt to finish it.', cli: `node uain-agent.mjs received ${held.id}`, ...reopened };
  if (held?.status === 'awaiting-signature') return { actor: 'buyer', action: 'sign-payment', requestId: q.id, send: held.id, why: 'The payment is ready. The buyer confirms it to send it.', cli: 'node uain-agent.mjs payments', ...reopened };
  if (locked(state, q.id)) return { actor: 'uain', action: 'settling', requestId: q.id, why: 'The payment is going through. Nothing to do; it is never paid twice.', ...reopened };
  if (q.status === 'open' && (!q.expiresAt || Date.parse(q.expiresAt) > viewNow())) return { actor: 'buyer', action: 'pay', requestId: q.id, dueBy: q.expiresAt ?? null, why: retries.length ? `This deal's payment did not complete. Pay ${q.amount} AI$ again by ${q.expiresAt}.` : `Pay ${q.amount} AI$ for this deal${q.expiresAt ? ` by ${q.expiresAt}` : ''}.`, cli: `node uain-agent.mjs pay --request ${q.id}`, ...reopened };
  return { actor: 'steward', action: 'retry-payment', requestId: q.id, why: 'The payment time ran out. A UAIN steward will reopen it.', ...reopened };
}
function addHistory(state, type, request, actorAddress) {
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({ id: randomUUID(), type, requestId: request.id, at: new Date().toISOString(), actor: actorAddress, from: request.from, to: request.to, amount: request.amount, memo: request.memo, status: request.status, currency: 'AI$' });
}
function closeRequest(state, request, status, actorAddress) {
  if (!request || request.status !== 'open') return false;
  check(!requestPaidBy(state, request.id), 409, 'payment_request_paid', 'The payment for this deal already arrived and waits for the seller to confirm receipt, so open a dispute to get it back instead of cancelling.');
  check(!locked(state, request.id), 409, 'payment_request_locked', 'A payment for this deal is already going through, so wait for it to finish instead of paying again.');
  request.status = status; request.updatedAt = new Date().toISOString();
  addHistory(state, `request.${status}`, request, actorAddress);
  return true;
}
/** Bring a stored deal up to date with its payment request and milestones (inside a write). */
function sync(state, d, deal) {
  const request = paymentRequest(state, deal);
  if (deal.status === 'agreed' && request?.status === 'paid') {
    deal.status = 'paid'; deal.paidAt = request.updatedAt;
    emit(d, { type: 'deal.paid', dealId: deal.id, actor: deal.buyer, summary: `Payment of ${deal.terms.price} AI$ recorded and confirmed by the seller's wallet.` });
  }
  if (deal.status === 'paid' && deal.milestones.every((m) => m.status === 'confirmed')) {
    deal.status = 'completed'; deal.completedAt = new Date().toISOString();
    emit(d, { type: 'deal.completed', dealId: deal.id, actor: deal.buyer, summary: 'Every milestone confirmed; the deal is complete.' });
  }
  // A paid refund is public too (10 November acceptance: only the request appeared in the feed).
  for (const r of deal.refunds ?? []) {
    const rq = state.requests?.[r.requestId];
    if (rq?.status === 'paid' && !r.paidAt) { r.paidAt = rq.updatedAt; emit(d, { type: 'refund.paid', dealId: deal.id, actor: rq.to, summary: `Refund of ${rq.amount} AI$ paid and confirmed by the buyer's wallet.` }); }
  }
}

export function dealDigestInput(deal) {
  return {
    schema: 'baink-trade-deal-v1', dealId: deal.id, policyVersion: deal.policyVersion,
    proposalId: deal.proposalId, proposalDigest: deal.proposalDigest, enquiryId: deal.enquiryId, offerId: deal.offerId,
    seller: deal.seller, buyer: deal.buyer, terms: deal.terms,
    milestones: deal.milestones.map((m) => ({ index: m.index, title: m.title })),
    paymentWindowHours: deal.paymentWindowHours, fee: { amountUnits: TRADE_POLICY.feeUnits, currency: 'AI$' },
  };
}

function publicRequest(q) {
  if (!q) return null;
  return {
    id: q.id, status: q.status, amount: q.amount, currency: 'AI$', from: q.from, to: q.to,
    createdAt: q.createdAt, updatedAt: q.updatedAt, expiresAt: q.expiresAt ?? null,
    settlement: q.settlement ? { kind: q.settlement.kind, chainId: q.settlement.chainId, amountVerification: q.settlement.amountVerification } : null,
  };
}
function paymentView(state, deal) {
  const q = paymentRequest(state, deal);
  if (!q) return null;
  const intents = intentsFor(state, q.id);
  const current = intents.filter((i) => i.status !== 'abandoned').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    request: publicRequest(q), inProgress: locked(state, q.id),
    attempts: intents.length, abandonedAttempts: intents.filter((i) => i.status === 'abandoned').length,
    currentAttempt: current ? { status: current.status === 'broadcasting' ? 'unknown' : current.status, sendAttempted: Boolean(current.sendAttemptedAt), createdAt: current.createdAt, updatedAt: current.updatedAt } : null,
    retries: deal.paymentRetries ?? [],
    serverSends: sendsFor(state, q.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10).map((r) => ({ id: r.id, status: r.status, attempts: r.attempts?.length ?? 0, paid: Boolean(r.recipientConfirmation), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    next: paymentNext(state, deal, q, deal.paymentRetries ?? []),
  };
}
// The service clock for synchronous view building (set by each service call).
let viewNow = () => Date.now();
function effectiveStatus(state, deal) {
  if (deal.status === 'agreed' && paid(state, deal)) return deal.milestones.every((m) => m.status === 'confirmed') ? 'completed' : 'paid';
  if (deal.status === 'paid' && deal.milestones.every((m) => m.status === 'confirmed')) return 'completed';
  if (deal.status === 'agreed') {
    const q = paymentRequest(state, deal);
    if (q?.status === 'open' && q.expiresAt && Date.parse(q.expiresAt) <= viewNow() && !locked(state, q.id)) return 'expired';
  }
  return deal.status;
}
function dealView(state, deal, { full = true } = {}) {
  const status = effectiveStatus(state, deal);
  const base = {
    id: deal.id, kind: 'trade-deal', status, seller: deal.seller, buyer: deal.buyer,
    offerId: deal.offerId, enquiryId: deal.enquiryId, proposalId: deal.proposalId,
    title: deal.offerTitle, price: deal.terms.price, priceUnits: deal.terms.priceUnits, currency: 'AI$',
    fee: { amount: formatNativeUnits(TRADE_POLICY.feeUnits), currency: 'AI$' },
    dealDigest: deal.dealDigest, createdAt: deal.createdAt, updatedAt: deal.updatedAt,
    agreedAt: deal.agreedAt ?? null, disputeId: deal.disputeId ?? null,
    signed: { seller: Boolean(deal.acceptances.seller), buyer: Boolean(deal.acceptances.buyer) },
    milestonesConfirmed: deal.milestones.filter((m) => m.status === 'confirmed').length, milestoneCount: deal.milestones.length,
    // What is still owed as a refund: a deal can read refunded while the ordered refund is unpaid.
    refundOwed: formatNativeUnits((refundedUnits(state, deal) - refundedUnits(state, deal, { includeOpen: false })).toString()),
  };
  if (!full) return base;
  return {
    ...base, policyVersion: deal.policyVersion, proposalDigest: deal.proposalDigest, terms: deal.terms,
    paymentWindowHours: deal.paymentWindowHours, digestInput: dealDigestInput(deal),
    acceptances: deal.acceptances, milestones: deal.milestones, payment: paymentView(state, deal),
    refunds: deal.refunds.map((r) => ({ ...r, request: publicRequest(state.requests?.[r.requestId]) })),
    cancellation: deal.cancellation ?? null, ratings: deal.ratings,
    // A deal is rated only once it can no longer reopen (C7). In the full view only: it scans other deals.
    rateable: CLOSED.includes(deal.status) && Boolean(deal.agreedAt) && !reopenable(state, deal),
    disputes: deal.disputeIds.map((x) => state.tradeDeals?.disputes?.[x]).filter(Boolean).map((x) => disputeView(state, x, { full: false })),
    timeline: (state.tradeDeals?.events ?? []).filter((e) => e.dealId === deal.id),
    notice: 'Public record. The private payment itself is shielded on the UAIN ledger; its amount is attested by the recipient wallet.',
  };
}
function disputeView(state, x, { full = true } = {}) {
  const base = { id: x.id, kind: 'trade-dispute', dealId: x.dealId, status: x.status, openedBy: x.openedBy, respondent: x.respondent, desiredOutcome: x.desiredOutcome, openedAt: x.openedAt, decidedAt: x.decision?.at ?? null, outcome: x.appealDecision?.outcome ?? x.decision?.outcome ?? null, appealed: Boolean(x.appeal) };
  if (!full) return base;
  return { ...base, reason: x.reason, requestedAmount: x.requestedAmount, evidence: x.evidence, decision: x.decision, appeal: x.appeal, appealDecision: x.appealDecision, appealDeadline: x.appealDeadline ?? null, policyVersion: TRADE_POLICY.version };
}
function page(query, max = 50) {
  const n = (v, f, m) => { if (v === undefined) return f; check(/^[1-9][0-9]{0,4}$/.test(String(v)) && Number(v) <= m, 400, 'invalid_query', 'Pagination requires small positive whole numbers.'); return Number(v); };
  return { page: n(query.page, 1, 10000), pageSize: n(query.pageSize, 20, max) };
}
const slice = (rows, p) => ({ count: rows.length, page: p.page, pageSize: p.pageSize, pages: Math.max(1, Math.ceil(rows.length / p.pageSize)), rows: rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize) });

export function createTradeDealService({ store, trade, availability = null, stewards = [], appealReviewers = [], now = () => Date.now() }) {
  const stewardSet = new Set(stewards), reviewerSet = new Set(appealReviewers);
  viewNow = now;
  for (const a of [...stewardSet, ...reviewerSet]) if (!ADDRESS.test(a)) throw new TypeError('Trade steward and reviewer addresses must be UAIN addresses.');
  const nowIso = () => new Date(now()).toISOString();
  const termsIn = (state) => createTradeTermsService({ store: { read: () => state, transact: () => { throw new Error('read only'); } }, context: (...args) => trade.termsContext(...args) });
  const dealIn = (d, dealId) => { const deal = Object.hasOwn(d.deals, id(dealId, 'deal identifier')) ? d.deals[dealId] : null; check(deal, 404, 'deal_not_found', 'No deal has this id, so check the deal id and try again.'); return deal; };
  const party = (deal, user) => { const role = user.address === deal.seller ? 'seller' : user.address === deal.buyer ? 'buyer' : null; check(role, 403, 'deal_party_required', 'Only the buyer or the seller of this deal can do this step.'); return role; };
  const steward = (user) => check(stewardSet.has(user.address), 403, 'steward_required', 'Only a configured UAIN trade steward can do this.');
  const clauses = (list) => { check(Array.isArray(list) && list.length >= 1 && list.length <= 12 && list.every((c) => Object.hasOwn(TRADE_POLICY.clauses, c)), 400, 'policy_clause_required', 'Cite one or more clauses of the written Trade policy.'); return [...new Set(list)]; };
  const signedEvidence = (user, signed) => {
    check(record(signed) && typeof signed.signature === 'string', 401, 'signed_request_required', 'This step needs the party\'s own signed request.');
    const s = { address: user.address, publicKey: user.publicKey, audience: signed.audience, method: signed.method, path: signed.path, body: signed.body, nonce: signed.nonce, timestamp: signed.timestamp, signature: signed.signature };
    check(verifySignedRequest(s), 401, 'invalid_signature', 'The signed acceptance does not verify.');
    return s;
  };
  // Expiry and finality commit on their own, so a refused write never rolls them back.
  const sweepDue = async () => { const state = store.read(); if (state.tradeDeals && due(state, state.tradeDeals)) await store.transact((s) => { sweepState(s, storage(s, true)); }); };
  const tx = async (user, fn) => {
    await sweepDue();
    return store.transact((state) => {
      const d = storage(state, true);
      if (user) limitWrites(d, user, now());
      sweepState(state, d);
      return fn(state, d);
    });
  };

  function createRefund(state, d, deal, { amountUnits: u, reason, source, actor: by, decisionId = null }) {
    check(['paid', 'completed', 'disputed', 'refunded', 'cancelled'].includes(deal.status) && refundable(state, deal), 409, 'deal_not_paid', landedPayment(state, deal)
      ? `The payment arrived and the seller has ${TRADE_POLICY.unconfirmedPaymentGraceHours} hours to confirm it; after that it can be refunded.`
      : 'This deal has not been paid yet, so there is nothing to refund; cancel the deal instead.');
    const remaining = units(deal) - refundedUnits(state, deal);
    check(BigInt(u) <= remaining, 409, 'refund_exceeds_payment', `At most ${formatNativeUnits(remaining.toString())} AI$ of this deal can still be refunded.`);
    check(Object.keys(state.requests).length < 10000, 429, 'capacity', 'Payment-request storage capacity reached.');
    const at = nowIso(), refundId = randomUUID();
    const request = { id: randomUUID(), from: deal.buyer, to: deal.seller, amount: formatNativeUnits(u), memo: `Refund for Trade deal ${deal.id}: ${Array.from(reason).slice(0, 300).join('')}`, clientRequestId: `deal-refund-${refundId}`, status: 'open', createdAt: at, updatedAt: at, currency: 'AI$', settlementAvailable: false, dealRefund: { dealId: deal.id, refundId, source } };
    // D2: an ordered refund has a deadline; unpaid by then it is recorded as refused (P12).
    if (BINDING.includes(source)) request.expiresAt = new Date(now() + TRADE_POLICY.orderedRefundDays * DAY).toISOString();
    state.requests[request.id] = request;
    addHistory(state, 'request.created', request, by);
    const refund = { id: refundId, requestId: request.id, amount: request.amount, amountUnits: u, reason, source, decisionId, requestedBy: by, createdAt: at, ...(source === 'mutual-cancel' ? { binding: true } : {}) };
    deal.refunds.push(refund);
    emit(d, { type: 'deal.refund', dealId: deal.id, actor: by, summary: `Refund of ${request.amount} AI$ requested from the seller (${source}).` });
    return refund;
  }
  function cancelDeal(state, d, deal, by, reason, { keepLandedPayment = false } = {}) {
    const q = paymentRequest(state, deal);
    // D1: a decision that refunds a landed, unconfirmed payment leaves its request open, so the
    // seller's late confirmation is still recorded and the request can never be paid again.
    if (q?.status === 'open' && !(keepLandedPayment && requestPaidBy(state, q.id))) closeRequest(state, q, 'cancelled', by);
    deal.status = 'cancelled'; deal.updatedAt = nowIso();
    deal.cancellation = { ...(deal.cancellation ?? {}), cancelledAt: deal.updatedAt, by, reason };
    emit(d, { type: 'deal.cancelled', dealId: deal.id, actor: by, summary: reason });
  }
  /** D3 and B2-1: a decision or a mutual cancel replaces refunds a party opened and left unpaid.
   *  Counted as refunded while open, they blocked the binding refund (a full refund came out as
   *  zero), and the seller could then decline them unrecorded. */
  function replaceOpenPartyRefunds(state, deal, by, replacedBy, keep = binding) {
    for (const r of deal.refunds) { const q = state.requests?.[r.requestId]; if (!keep(r) && q?.status === 'open' && !locked(state, q.id)) { closeRequest(state, q, 'cancelled', by); r.replacedBy = replacedBy; } }
  }
  /** D2: how a binding refund (ordered, or agreed in a mutual cancel: B2-1) was refused, if it was
   *  and is not recorded yet: the seller declined it, or left it unpaid past its deadline with no
   *  payment in flight. Null otherwise. */
  function refusedHow(state, r, stamp) {
    if (!binding(r) || r.paidAt || r.refusedAt) return null;
    // While the decision is under appeal the order is not yet settled, so nothing is refused.
    if (r.decisionId && state.tradeDeals?.disputes?.[r.decisionId]?.status === 'appealed') return null;
    const q = state.requests?.[r.requestId];
    if (q?.status === 'declined') return 'declined';
    const at = q?.status === 'open' ? paymentRequestExpiresAt(q) : null;
    return at !== null && Date.parse(at) <= stamp && !locked(state, q.id) ? 'expired-unpaid' : null;
  }
  function due(state, d) {
    const stamp = now();
    return Object.values(d.deals).some((deal) => {
      if ((deal.refunds ?? []).some((r) => !r.paidAt && state.requests?.[r.requestId]?.status === 'paid')) return true;
      if ((deal.refunds ?? []).some((r) => refusedHow(state, r, stamp))) return true;
      if (deal.status === 'proposed') return Date.parse(deal.createdAt) + TRADE_POLICY.unsignedDealDays * DAY <= stamp || (deal.terms.expiresAt && Date.parse(deal.terms.expiresAt) <= stamp);
      const q = paymentRequest(state, deal);
      if (deal.status === 'agreed') return q?.status === 'paid' || (q?.status === 'open' && q.expiresAt && Date.parse(q.expiresAt) <= stamp && !locked(state, q.id));
      return deal.status === 'paid' && deal.milestones.every((m) => m.status === 'confirmed');
    }) || Object.values(d.disputes).some((x) => x.status === 'decided' && x.appealDeadline && Date.parse(x.appealDeadline) <= stamp);
  }
  function sweepState(state, d) {
    const stamp = now();
    for (const deal of Object.values(d.deals)) {
      if (deal.status === 'proposed' && (Date.parse(deal.createdAt) + TRADE_POLICY.unsignedDealDays * DAY <= stamp || (deal.terms.expiresAt && Date.parse(deal.terms.expiresAt) <= stamp))) {
        deal.status = 'expired'; deal.updatedAt = new Date(stamp).toISOString();
        emit(d, { type: 'deal.expired', dealId: deal.id, actor: 'uain', summary: 'Not signed by both parties in time.' });
        continue;
      }
      sync(state, d, deal);
      // D2: an ordered refund the seller declined or ignored is recorded publicly (P12), and the
      // deal stops reading refunded, so the buyer is not stranded with a closed, unrefunded deal.
      for (const r of deal.refunds ?? []) {
        const how = refusedHow(state, r, stamp);
        if (!how) continue;
        const q = state.requests[r.requestId], at = new Date(stamp).toISOString();
        if (how === 'expired-unpaid') { q.status = 'expired'; q.updatedAt = at; addHistory(state, 'request.expired', q, 'uain'); }
        r.refusedAt = at; r.refusal = how;
        const what = r.source === 'mutual-cancel' ? 'agreed when both parties cancelled the deal' : 'ordered by a decision';
        emit(d, { type: 'refund.refused', dealId: deal.id, actor: deal.seller, summary: how === 'declined' ? `The seller declined the refund of ${r.amount} AI$ ${what} (policy P12); referred to central review.` : `The seller did not pay the refund of ${r.amount} AI$ ${what} within ${TRADE_POLICY.orderedRefundDays} days (policy P12); referred to central review.` });
        if (deal.status === 'refunded') { deal.status = paid(state, deal) ? 'paid' : 'agreed'; deal.updatedAt = at; if (deal.cancellation?.requests) deal.cancellation = { ...deal.cancellation, requests: {} }; }
        // B2-1: a paid deal cancelled with its refund refused is paid again, so the buyer can
        // dispute it. Earlier consent to cancel does not carry over to the reopened deal.
        // A landed payment the seller never confirmed counts too (D1): the deal reads agreed with its
        // payment still waiting for the seller, so it is never paid again.
        else if (deal.status === 'cancelled' && refundable(state, deal)) {
          deal.status = paid(state, deal) ? 'paid' : 'agreed'; deal.updatedAt = at;
          if (deal.cancellation) deal.cancellation = { ...deal.cancellation, requests: {}, reopenedAt: at };
          emit(d, { type: 'deal.reopened', dealId: deal.id, actor: 'uain', summary: 'The cancellation refund was refused, so the deal is paid again and the buyer can open a dispute.' });
        }
      }
      if (deal.status === 'agreed') {
        const q = paymentRequest(state, deal);
        if (q?.status === 'open' && q.expiresAt && Date.parse(q.expiresAt) <= stamp && !locked(state, q.id)) {
          q.status = 'expired'; q.updatedAt = new Date(stamp).toISOString(); addHistory(state, 'request.expired', q, 'uain');
          deal.status = 'expired'; deal.updatedAt = q.updatedAt;
          emit(d, { type: 'deal.expired', dealId: deal.id, actor: 'uain', summary: `Payment request expired unpaid after ${deal.paymentWindowHours} hours.` });
        }
      }
    }
    for (const x of Object.values(d.disputes))
      if (x.status === 'decided' && x.appealDeadline && Date.parse(x.appealDeadline) <= stamp) {
        x.status = 'final';
        emit(d, { type: 'dispute.final', dealId: x.dealId, disputeId: x.id, actor: 'uain', summary: 'Appeal window closed; the decision is final.' });
      }
  }
  function decide(state, d, x, deal, { by, outcome, refundUnits, reasons, policyClauses, role, model, keepCancelled = false }) {
    check(OUTCOMES.includes(outcome), 400, 'invalid_outcome', `Outcome must be one of ${OUTCOMES.join(', ')}.`);
    // isPaid: the seller confirmed receipt. canRefund also counts a payment proved on the ledger
    // that the seller left unconfirmed past the grace period (D1).
    const isPaid = paid(state, deal), canRefund = refundable(state, deal);
    const effects = [];
    // D3: the decision replaces refunds a party opened and left unpaid. Counted as refunded,
    // they blocked the steward's own order (a full refund came out as zero).
    // A decision replaces every open refund it did not order, a mutual-cancel one included.
    const replacePartyRefunds = () => replaceOpenPartyRefunds(state, deal, by, x.id, (r) => ORDERED.includes(r.source));
    if (outcome === 'refund-full' || outcome === 'refund-partial') {
      check(canRefund, 409, 'deal_not_paid', landedPayment(state, deal) ? `The payment arrived and the seller has ${TRADE_POLICY.unconfirmedPaymentGraceHours} hours to confirm it; decide a refund after that.` : 'Refund outcomes need a recorded payment; use cancel-deal or no-refund.');
      replacePartyRefunds();
      const remaining = units(deal) - refundedUnits(state, deal);
      // A refund being paid right now cannot be replaced; it is what makes the remainder zero.
      check(!(outcome === 'refund-full' && remaining <= 0n && deal.refunds.some((r) => state.requests?.[r.requestId]?.status === 'open' && locked(state, r.requestId))), 409, 'refund_in_progress', 'A refund payment for this deal is going through, so wait for it to finish, then decide.');
      const u = outcome === 'refund-full' ? remaining.toString() : refundUnits;
      check(u && BigInt(u) > 0n, 400, 'invalid_amount', 'A partial refund needs refundAmount.');
      const refund = createRefund(state, d, deal, { amountUnits: u, reason: `${role} decision on dispute ${x.id}`, source: role === 'steward' ? 'steward-decision' : 'appeal-decision', actor: by, decisionId: x.id });
      effects.push({ refundId: refund.id, requestId: refund.requestId, amount: refund.amount });
      deal.status = 'refunded';
    } else if (outcome === 'cancel-deal') {
      if (canRefund) { replacePartyRefunds(); const remaining = units(deal) - refundedUnits(state, deal); if (remaining > 0n) { const r = createRefund(state, d, deal, { amountUnits: remaining.toString(), reason: `${role} cancelled the deal on dispute ${x.id}`, source: role === 'steward' ? 'steward-decision' : 'appeal-decision', actor: by, decisionId: x.id }); effects.push({ refundId: r.id, requestId: r.requestId, amount: r.amount }); } }
      cancelDeal(state, d, deal, by, `Cancelled by ${role} decision on dispute ${x.id}.`, { keepLandedPayment: canRefund && !isPaid });
    } else if (keepCancelled) {
      // The parties cancelled by agreement after the steward decided; an outcome that orders
      // nothing back leaves that agreed refund, and the cancelled deal it belongs to, as they are.
    } else {
      if (outcome === 'redeliver') for (const m of deal.milestones) if (m.status !== 'confirmed') { m.status = 'pending'; m.delivery = null; m.rejection = null; }
      if (outcome === 'no-refund') for (const m of deal.milestones) if (m.status === 'delivered' && isPaid) { m.status = 'confirmed'; m.confirmedAt = nowIso(); m.confirmedBy = by; }
      if (!(deal.status === 'cancelled' && !isPaid)) deal.status = isPaid ? 'paid' : x.priorStatus === 'expired' ? 'expired' : 'agreed';
      // A deal a decision returns to paid needs fresh consent from both to cancel it.
      if (deal.cancellation?.requests && deal.status !== 'cancelled') deal.cancellation = { ...deal.cancellation, requests: {} };
      sync(state, d, deal);
    }
    deal.updatedAt = nowIso();
    const entry = { id: randomUUID(), kind: role === 'steward' ? 'steward-decision' : 'appeal-decision', at: nowIso(), by, dealId: deal.id, disputeId: x.id, outcome, refundAmount: effects[0]?.amount ?? null, reasons, policyClauses, policyVersion: TRADE_POLICY.version, model: model ?? null, effects };
    recordDecision(d, entry);
    return entry;
  }

  return {
    policy: () => structuredClone(TRADE_POLICY),
    stewards: () => ({ stewards: [...stewardSet], appealReviewers: [...reviewerSet], policyVersion: TRADE_POLICY.version }),
    /** Periodic expiry and finality; returns true when something changed. */
    async sweep() {
      const state = store.read();
      if (!state.tradeDeals || !due(state, state.tradeDeals)) return false;
      await sweepDue();
      return true;
    },

    async create(user, body) {
      principal(user);
      only(body, ['clientRequestId', 'proposalId', 'proposalDigest', 'confirmBindingDraft'], ['milestones', 'paymentWindowHours']);
      const clientRequestId = client(body.clientRequestId), proposalId = id(body.proposalId, 'proposal identifier'), proposalDigest = hash(body.proposalDigest, 'Proposal digest');
      check(body.confirmBindingDraft === true, 400, 'confirmation_required', 'Confirm that this drafts a binding deal for both parties to sign.');
      const milestones = body.milestones === undefined ? ['Delivery of the agreed deliverables'] : body.milestones;
      check(Array.isArray(milestones) && milestones.length >= 1 && milestones.length <= 10, 400, 'invalid_milestones', 'Give one to ten milestone titles.');
      const titles = milestones.map((m) => text(m, 300, 'Milestone title'));
      const windowHours = body.paymentWindowHours ?? TRADE_POLICY.defaultPaymentWindowHours;
      check(Number.isSafeInteger(windowHours) && windowHours >= 1 && windowHours <= TRADE_POLICY.maxPaymentWindowHours, 400, 'invalid_payment_window', `The payment window is 1 to ${TRADE_POLICY.maxPaymentWindowHours} hours.`);
      const fingerprint = sha({ proposalId, proposalDigest, titles, windowHours });
      return tx(user, (state, d) => {
        const out = remember(d, user, clientRequestId, fingerprint, () => {
          const detail = termsIn(state).detail(user, proposalId);
          check(detail.proposal, 404, 'trade_proposal_missing', 'Only a sent terms proposal can become a deal.');
          const p = detail.proposal, e = p.enquirySnapshot;
          check(tradeProposalDigest(p) === proposalDigest, 409, 'trade_proposal_changed', 'The terms changed since you read them, so read them again before you create the deal.');
          trade.termsContext(state, user, p.enquiryId, { write: true });
          check(p.terms.expiresAt === null || Date.parse(p.terms.expiresAt) > now(), 409, 'trade_terms_expired', 'These terms have expired, so ask the seller to send new terms.');
          const offer = state.trade.offers[e.offerId];
          check(offer.revision === e.offer.revision, 409, 'trade_offer_changed', 'The listing changed after your enquiry, so send a new enquiry.');
          check(!Object.values(d.deals).some((x) => x.proposalId === proposalId && !['cancelled', 'expired'].includes(x.status)), 409, 'deal_exists', 'These terms already have an open deal, so use that deal instead.');
          check(!Object.values(state.requests).some((r) => r.trade?.proposal?.id === proposalId && LIVE_REQUEST.includes(r.status)), 409, 'trade_proposal_already_requested', 'This proposal already has a payment request.');
          check(Object.keys(d.deals).length < LIMITS.deals, 429, 'trade_capacity', 'Trade deal capacity reached.');
          check(Object.values(d.deals).filter((x) => x.proposalId === proposalId).length < DEALS_PER_PROPOSAL, 429, 'deal_proposal_limit', 'This proposal already became a deal three times, so ask the other member for a new proposal.');
          check(Object.values(d.deals).filter((x) => (x.seller === user.address || x.buyer === user.address) && Date.parse(x.createdAt) > now() - 86_400_000).length < DEALS_PER_IDENTITY_PER_DAY, 429, 'deal_daily_limit', `You can start ${DEALS_PER_IDENTITY_PER_DAY} deals a day, so try again tomorrow.`);
          check(Buffer.byteLength(JSON.stringify(d.deals)) < DEAL_BUDGET_BYTES, 503, 'trade_capacity', 'Trade is full for now, so try again later.');
          check(Object.values(d.deals).filter((x) => (x.seller === user.address || x.buyer === user.address) && !CLOSED.includes(x.status)).length < 200, 429, 'deal_limit', 'This identity has 200 open deals; close some first.');
          const at = nowIso();
          const deal = {
            id: randomUUID(), policyVersion: TRADE_POLICY.version, proposalId, proposalDigest, proposal: p,
            enquiryId: p.enquiryId, offerId: e.offerId, offerTitle: e.offer.title, seller: e.seller, buyer: e.buyer,
            terms: { scope: p.terms.scope, deliverables: p.terms.deliverables, price: p.terms.price, priceUnits: p.terms.priceUnits, currency: 'AI$', timeline: p.terms.timeline, acceptanceCriteria: p.terms.acceptanceCriteria, expiresAt: p.terms.expiresAt },
            milestones: titles.map((title, index) => ({ index, title, status: 'pending', delivery: null, rejection: null, confirmedAt: null, confirmedBy: null })),
            paymentWindowHours: windowHours, status: 'proposed', createdBy: user.address, createdAt: at, updatedAt: at,
            acceptances: { seller: null, buyer: null }, refunds: [], ratings: { seller: null, buyer: null }, disputeIds: [], paymentRetries: [],
          };
          deal.dealDigest = sha(dealDigestInput(deal));
          d.deals[deal.id] = deal;
          emit(d, { type: 'deal.drafted', dealId: deal.id, offerId: deal.offerId, actor: user.address, summary: `Binding deal drafted for ${deal.terms.price} AI$: ${Array.from(deal.offerTitle).slice(0, 120).join('')}` });
          return deal.id;
        });
        return { created: !out.replay, deal: dealView(state, d.deals[out.ref]) };
      });
    },

    async accept(user, dealId, body, signed) {
      principal(user);
      only(body, ['clientRequestId', 'dealDigest', 'confirmBinding']);
      client(body.clientRequestId); hash(body.dealDigest, 'Deal digest');
      check(body.confirmBinding === true, 400, 'confirmation_required', 'Confirm that you accept these exact terms as binding.');
      const evidence = signedEvidence(user, signed);
      check(canonical(evidence.body) === canonical(body), 401, 'invalid_signature', 'The signed request must carry exactly this acceptance.');
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId), role = party(deal, user);
        // P0-4: while Trade is paused an unsigned deal cannot be signed; the sweep expires it.
        availability?.assert('deal.accept', { deal });
        if (deal.acceptances[role]) { check(deal.acceptances[role].body.dealDigest === body.dealDigest, 409, 'deal_already_signed', 'You already signed this deal.'); return { created: false, deal: dealView(state, deal) }; }
        check(deal.status === 'proposed', 409, 'deal_not_open', `This deal is ${deal.status} and cannot be signed.`);
        check(body.dealDigest === deal.dealDigest && sha(dealDigestInput(deal)) === deal.dealDigest, 409, 'deal_changed', 'The deal changed since you read it, so read it again and sign the new version.');
        trade.termsContext(state, user, deal.enquiryId, { write: true });
        deal.acceptances[role] = { ...evidence, role, at: nowIso() };
        deal.updatedAt = nowIso();
        emit(d, { type: 'deal.signed', dealId: deal.id, actor: user.address, summary: `The ${role} signed the exact deal terms.` });
        if (deal.acceptances.seller && deal.acceptances.buyer) {
          check(!Object.values(state.requests).some((r) => r.trade?.proposal?.id === deal.proposalId && LIVE_REQUEST.includes(r.status)), 409, 'trade_proposal_already_requested', 'This proposal already has a payment request.');
          check(Object.keys(state.requests).length < 10000, 429, 'capacity', 'Payment-request storage capacity reached.');
          const at = nowIso();
          const request = {
            id: randomUUID(), from: deal.seller, to: deal.buyer, amount: deal.terms.price,
            memo: tradePaymentMemo(deal.proposal, deal.proposalDigest), clientRequestId: `deal-${deal.id}`,
            status: 'open', createdAt: at, updatedAt: at, currency: 'AI$', settlementAvailable: false,
            expiresAt: new Date(now() + deal.paymentWindowHours * HOUR).toISOString(),
            trade: { schema: 'baink-trade-deal-payment-v1', proposal: structuredClone(deal.proposal), snapshotDigest: deal.proposalDigest, dealId: deal.id, dealDigest: deal.dealDigest },
          };
          state.requests[request.id] = request;
          addHistory(state, 'request.created', request, deal.seller);
          deal.paymentRequestId = request.id; deal.status = 'agreed'; deal.agreedAt = at;
          emit(d, { type: 'deal.agreed', dealId: deal.id, actor: user.address, summary: `Both parties signed. Payment of ${deal.terms.price} AI$ is due by ${request.expiresAt}.` });
        }
        return { created: true, deal: dealView(state, deal) };
      });
    },

    async cancel(user, dealId, body) {
      principal(user);
      only(body, ['clientRequestId', 'reason']);
      client(body.clientRequestId); const reason = text(body.reason, 1000, 'Reason');
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId), role = party(deal, user);
        sync(state, d, deal);
        check(!CLOSED.includes(deal.status), 409, 'deal_closed', `This deal is already ${deal.status}.`);
        check(deal.status !== 'disputed', 409, 'deal_disputed', 'This deal is in a dispute, so wait for the UAIN steward to decide it.');
        if (['proposed', 'agreed'].includes(deal.status)) {
          cancelDeal(state, d, deal, user.address, `Cancelled by the ${role} before payment: ${reason}`);
          return { cancelled: true, deal: dealView(state, deal) };
        }
        // Paid: needs both parties; the second request refunds the buyer what remains.
        // C3: consent lapses. Weeks later the other party could "agree" to a request made in a
        // different situation and have the whole price ordered back.
        const fresh = Object.fromEntries(Object.entries(deal.cancellation?.requests ?? {}).filter(([, r]) => Date.parse(r?.at) + TRADE_POLICY.cancelConsentDays * DAY > now()));
        deal.cancellation = deal.cancellation ?? { requests: {} };
        deal.cancellation.requests = { ...fresh, [role]: { at: nowIso(), reason } };
        deal.updatedAt = nowIso();
        emit(d, { type: 'deal.cancel-requested', dealId: deal.id, actor: user.address, summary: `The ${role} asked to cancel after payment: ${reason}` });
        if (deal.cancellation.requests.seller && deal.cancellation.requests.buyer) {
          // B2-1: the agreed refund replaces open party refunds, which the seller could decline
          // unrecorded. One already being paid cannot be replaced, so the cancel waits for it.
          check(!deal.refunds.some((r) => !binding(r) && state.requests?.[r.requestId]?.status === 'open' && locked(state, r.requestId)), 409, 'refund_in_progress', 'A refund payment for this deal is going through, so wait for it to finish, then cancel.');
          replaceOpenPartyRefunds(state, deal, user.address, 'mutual-cancel');
          const remaining = units(deal) - refundedUnits(state, deal);
          if (remaining > 0n) createRefund(state, d, deal, { amountUnits: remaining.toString(), reason: 'Cancelled by both parties after payment', source: 'mutual-cancel', actor: user.address });
          cancelDeal(state, d, deal, user.address, 'Cancelled by both parties after payment; the buyer is refunded.');
          return { cancelled: true, deal: dealView(state, deal) };
        }
        return { cancelled: false, awaiting: role === 'seller' ? 'buyer' : 'seller', deal: dealView(state, deal) };
      });
    },

    async deliver(user, dealId, index, body) {
      principal(user);
      only(body, ['clientRequestId', 'note'], ['url', 'sha256']);
      client(body.clientRequestId); const note = text(body.note, 2000, 'Delivery note'); const link = evidenceLink(body);
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId); check(party(deal, user) === 'seller', 403, 'seller_required', 'Only the seller delivers milestones.');
        sync(state, d, deal);
        check(['agreed', 'paid'].includes(deal.status), 409, 'deal_not_deliverable', `A ${deal.status} deal takes no deliveries.`);
        const m = deal.milestones[index]; check(m, 404, 'milestone_not_found', 'No such milestone.');
        check(m.status !== 'confirmed', 409, 'milestone_confirmed', 'This milestone is already confirmed.');
        m.status = 'delivered'; m.delivery = { note, ...link, at: nowIso() }; m.rejection = null; deal.updatedAt = nowIso();
        emit(d, { type: 'milestone.delivered', dealId: deal.id, actor: user.address, summary: `Milestone ${index + 1} delivered: ${m.title}` });
        return { deal: dealView(state, deal) };
      });
    },
    async reviewDelivery(user, dealId, index, body, accept) {
      principal(user);
      only(body, ['clientRequestId'], accept ? [] : ['reason']);
      client(body.clientRequestId); const reason = accept ? null : text(body.reason, 2000, 'Reason');
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId); check(party(deal, user) === 'buyer', 403, 'buyer_required', 'Only the buyer confirms or rejects a delivery.');
        sync(state, d, deal);
        check(['agreed', 'paid'].includes(deal.status), 409, 'deal_not_deliverable', `A ${deal.status} deal takes no delivery reviews.`);
        const m = deal.milestones[index]; check(m, 404, 'milestone_not_found', 'No such milestone.');
        check(m.status === 'delivered', 409, 'milestone_not_delivered', 'This milestone has not been delivered yet, so wait for the seller to deliver it.');
        if (accept) { m.status = 'confirmed'; m.confirmedAt = nowIso(); m.confirmedBy = user.address; }
        else { m.status = 'rejected'; m.rejection = { reason, at: nowIso() }; }
        deal.updatedAt = nowIso();
        emit(d, { type: accept ? 'milestone.confirmed' : 'milestone.rejected', dealId: deal.id, actor: user.address, summary: accept ? `Milestone ${index + 1} confirmed.` : `Milestone ${index + 1} rejected: ${reason}` });
        sync(state, d, deal);
        return { deal: dealView(state, deal) };
      });
    },

    async refund(user, dealId, body) {
      principal(user);
      only(body, ['clientRequestId', 'amount', 'reason']);
      const clientRequestId = client(body.clientRequestId), u = amountUnits(body.amount), reason = text(body.reason, 1000, 'Reason');
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId), role = party(deal, user);
        sync(state, d, deal);
        const out = remember(d, user, clientRequestId, sha({ dealId, u, reason }), () => createRefund(state, d, deal, { amountUnits: u, reason, source: role === 'seller' ? 'seller-offered' : 'buyer-requested', actor: user.address }).id);
        return { created: !out.replay, refund: deal.refunds.find((r) => r.id === out.ref), deal: dealView(state, deal) };
      });
    },

    async rate(user, dealId, body) {
      principal(user);
      only(body, ['clientRequestId', 'score'], ['comment']);
      client(body.clientRequestId);
      check(Number.isSafeInteger(body.score) && body.score >= 1 && body.score <= 5, 400, 'invalid_score', 'Score is a whole number from 1 to 5.');
      const comment = text(body.comment, 500, 'Comment', { optional: true });
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId), role = party(deal, user);
        sync(state, d, deal);
        check(CLOSED.includes(deal.status) && deal.agreedAt, 409, 'deal_not_finished', 'You can rate this deal once it is completed, refunded or cancelled.');
        check(!deal.ratings[role], 409, 'already_rated', 'You already rated this deal.');
        // C7: a rating cannot be replaced, so it waits until the deal can no longer reopen.
        check(!reopenable(state, deal), 409, 'deal_not_final', 'This deal can still reopen (an appeal, an unpaid ordered refund or a payment retry is pending), so rate it once that is settled.');
        deal.ratings[role] = { by: user.address, of: role === 'seller' ? deal.buyer : deal.seller, score: body.score, comment, at: nowIso() };
        deal.updatedAt = nowIso();
        emit(d, { type: 'deal.rated', dealId: deal.id, actor: user.address, summary: `The ${role} rated the other party ${body.score}/5.` });
        return { deal: dealView(state, deal) };
      });
    },

    async openDispute(user, dealId, body) {
      principal(user);
      only(body, ['clientRequestId', 'reason', 'desiredOutcome'], ['amount']);
      const clientRequestId = client(body.clientRequestId), reason = text(body.reason, 4000, 'Reason');
      check(DESIRED.includes(body.desiredOutcome), 400, 'invalid_outcome', `Desired outcome is one of ${DESIRED.join(', ')}.`);
      const requested = body.amount === undefined ? null : amountUnits(body.amount);
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId); party(deal, user);
        sync(state, d, deal);
        const out = remember(d, user, clientRequestId, sha({ dealId, reason, o: body.desiredOutcome, requested }), () => {
          // C2: one live dispute per deal. A decided dispute is answered by its one appeal, not by
          // a second dispute on the same deal while the first can still change.
          const live = deal.disputeIds.map((x) => d.disputes[x]).find((x) => x && x.status !== 'final');
          check(!live, 409, 'dispute_pending', live?.status === 'decided' ? `This deal's dispute was decided, so if you disagree appeal that decision by ${live.appealDeadline} instead of opening a new dispute.` : 'This deal already has a dispute in progress, so add your evidence there and wait for the decision.');
          check(deal.disputeIds.length < TRADE_POLICY.maxDisputesPerDeal, 409, 'dispute_limit', `A deal can be disputed ${TRADE_POLICY.maxDisputesPerDeal} times at most, and this one has been.`);
          check(['agreed', 'paid', 'completed'].includes(deal.status) || (deal.status === 'expired' && deal.agreedAt), 409, 'deal_not_disputable', `A ${deal.status} deal cannot be disputed.`);
          check(deal.status !== 'completed' || Date.parse(deal.completedAt) + 30 * DAY > now(), 409, 'dispute_window_closed', 'This deal was completed more than 30 days ago, so it can no longer be disputed.');
          check(Object.keys(d.disputes).length < LIMITS.disputes, 429, 'trade_capacity', 'Dispute capacity reached.');
          const x = { id: randomUUID(), dealId: deal.id, openedBy: user.address, respondent: user.address === deal.seller ? deal.buyer : deal.seller, reason, desiredOutcome: body.desiredOutcome, requestedAmount: requested ? formatNativeUnits(requested) : null, status: 'open', priorStatus: deal.status, openedAt: nowIso(), evidence: [], decision: null, appeal: null, appealDecision: null, triage: [] };
          d.disputes[x.id] = x; deal.disputeIds.push(x.id); deal.disputeId = x.id; deal.status = 'disputed'; deal.updatedAt = nowIso();
          emit(d, { type: 'dispute.opened', dealId: deal.id, disputeId: x.id, actor: user.address, summary: `Dispute opened (${body.desiredOutcome}): ${Array.from(reason).slice(0, 200).join('')}` });
          return x.id;
        });
        return { created: !out.replay, dispute: disputeView(state, d.disputes[out.ref]), deal: dealView(state, deal, { full: false }) };
      });
    },
    async addEvidence(user, disputeId, body) {
      principal(user);
      only(body, ['clientRequestId', 'statement'], ['url', 'sha256']);
      const clientRequestId = client(body.clientRequestId), statement = text(body.statement, 4000, 'Statement'), link = evidenceLink(body);
      return tx(user, (state, d) => {
        const x = Object.hasOwn(d.disputes, id(disputeId, 'dispute identifier')) ? d.disputes[disputeId] : null; check(x, 404, 'dispute_not_found', 'No dispute has this id, so check the dispute id and try again.');
        const deal = d.deals[x.dealId]; const isParty = [deal.seller, deal.buyer].includes(user.address);
        check(isParty || stewardSet.has(user.address), 403, 'deal_party_required', 'Only the parties or a steward add evidence.');
        check(x.status === 'open' || (x.status === 'appealed' && isParty), 409, 'dispute_evidence_closed', 'This dispute is already decided, so no more evidence can be added.');
        const out = remember(d, user, clientRequestId, sha({ disputeId, statement, link }), () => {
          check(x.evidence.filter((e) => e.by === user.address).length < 20, 429, 'evidence_limit', 'You have filed the most statements allowed (20) for this dispute; wait for the decision.');
          const e = { id: randomUUID(), by: user.address, role: user.address === deal.seller ? 'seller' : user.address === deal.buyer ? 'buyer' : 'steward', statement, ...link, stage: x.status, at: nowIso() };
          x.evidence.push(e);
          emit(d, { type: 'dispute.evidence', dealId: deal.id, disputeId: x.id, actor: user.address, summary: `Evidence filed by the ${e.role}.` });
          return e.id;
        });
        return { created: !out.replay, dispute: disputeView(state, x) };
      });
    },
    async appeal(user, disputeId, body) {
      principal(user);
      only(body, ['clientRequestId', 'reason']);
      client(body.clientRequestId); const reason = text(body.reason, 4000, 'Reason');
      return tx(user, (state, d) => {
        const x = Object.hasOwn(d.disputes, id(disputeId, 'dispute identifier')) ? d.disputes[disputeId] : null; check(x, 404, 'dispute_not_found', 'No dispute has this id, so check the dispute id and try again.');
        const deal = d.deals[x.dealId]; party(deal, user);
        check(x.status === 'decided', 409, x.appeal ? 'already_appealed' : 'appeal_unavailable', x.appeal ? 'This decision was already appealed.' : 'Only a decided dispute inside its appeal window can be appealed.');
        x.status = 'appealed'; x.appeal = { by: user.address, reason, at: nowIso() };
        emit(d, { type: 'dispute.appealed', dealId: deal.id, disputeId: x.id, actor: user.address, summary: `Appealed to central review: ${Array.from(reason).slice(0, 200).join('')}` });
        return { dispute: disputeView(state, x) };
      });
    },

    // UAIN steward actions. Every one is a signed request from a configured
    // steward, cites the written policy and is published with its reasons.
    async stewardDecide(user, disputeId, body) {
      principal(user); steward(user);
      only(body, ['clientRequestId', 'outcome', 'reasons', 'policyClauses'], ['refundAmount', 'model']);
      client(body.clientRequestId);
      const reasons = text(body.reasons, 4000, 'Reasons', { min: 20 }), policyClauses = clauses(body.policyClauses);
      const refundUnits = body.refundAmount === undefined ? null : amountUnits(body.refundAmount);
      const model = body.model === undefined ? null : text(body.model, 120, 'Model');
      return tx(user, (state, d) => {
        const x = Object.hasOwn(d.disputes, id(disputeId, 'dispute identifier')) ? d.disputes[disputeId] : null; check(x, 404, 'dispute_not_found', 'No dispute has this id, so check the dispute id and try again.');
        const deal = d.deals[x.dealId];
        check(![deal.seller, deal.buyer].includes(user.address), 403, 'steward_conflict', 'A steward never decides a deal it is party to.');
        check(x.status === 'open', 409, 'dispute_not_open', `This dispute is ${x.status}.`);
        const entry = decide(state, d, x, deal, { by: user.address, outcome: body.outcome, refundUnits, reasons, policyClauses, role: 'steward', model });
        x.status = 'decided'; x.decision = { by: user.address, outcome: body.outcome, refundAmount: entry.refundAmount, reasons, policyClauses, model, at: entry.at, decisionId: entry.id, effects: entry.effects };
        x.appealDeadline = new Date(now() + TRADE_POLICY.appealDays * DAY).toISOString();
        emit(d, { type: 'dispute.decided', dealId: deal.id, disputeId: x.id, actor: user.address, summary: `Steward decision: ${body.outcome}. ${Array.from(reasons).slice(0, 200).join('')}` });
        return { decision: entry, dispute: disputeView(state, x), deal: dealView(state, deal, { full: false }) };
      });
    },
    async appealDecide(user, disputeId, body) {
      principal(user);
      check(reviewerSet.has(user.address), 403, 'central_reviewer_required', 'Only a configured UAIN central reviewer decides appeals.');
      only(body, ['clientRequestId', 'result', 'reasons', 'policyClauses'], ['outcome', 'refundAmount', 'model']);
      client(body.clientRequestId);
      const model = body.model === undefined ? null : text(body.model, 120, 'Model');
      check(['upheld', 'overturned'].includes(body.result), 400, 'invalid_result', 'Result is upheld or overturned.');
      const reasons = text(body.reasons, 4000, 'Reasons', { min: 20 }), policyClauses = clauses(body.policyClauses);
      const refundUnits = body.refundAmount === undefined ? null : amountUnits(body.refundAmount);
      return tx(user, (state, d) => {
        const x = Object.hasOwn(d.disputes, id(disputeId, 'dispute identifier')) ? d.disputes[disputeId] : null; check(x, 404, 'dispute_not_found', 'No dispute has this id, so check the dispute id and try again.');
        const deal = d.deals[x.dealId];
        check(![deal.seller, deal.buyer, x.decision?.by].includes(user.address), 403, 'reviewer_conflict', 'A central reviewer never decides an appeal of its own decision or a deal it is party to.');
        check(x.status === 'appealed', 409, 'appeal_not_open', 'This dispute has no open appeal.');
        let entry = null;
        if (body.result === 'overturned') {
          check(OUTCOMES.includes(body.outcome), 400, 'invalid_outcome', 'An overturn names the new outcome.');
          for (const r of deal.refunds.filter((r) => r.decisionId === x.id)) { const q = state.requests[r.requestId]; if (q?.status === 'open' && !locked(state, q.id)) closeRequest(state, q, 'cancelled', user.address); }
          // A refund both parties agreed when they cancelled after the steward decided (open or paid)
          // stands unless the new outcome itself orders money back or cancels the deal; then the
          // decision replaces it (decide), as it replaces party refunds.
          // Likewise a cancelled or refunded deal whose whole price paid refunds already returned:
          // reading it paid again would contradict the money (third review, 13 November 2026).
          const ordersNothing = !['refund-full', 'refund-partial', 'cancel-deal'].includes(body.outcome);
          const agreedCancel = ordersNothing && ((deal.status === 'cancelled'
            && deal.refunds.some((r) => r.source === 'mutual-cancel' && binding(r) && !r.refusedAt && !r.replacedBy && ['open', 'paid'].includes(state.requests?.[r.requestId]?.status)))
            || (['cancelled', 'refunded'].includes(deal.status) && refundedUnits(state, deal, { includeOpen: false }) >= units(deal)));
          if (!agreedCancel && paid(state, deal) && ['refunded', 'cancelled'].includes(deal.status)) deal.status = 'paid';
          entry = decide(state, d, x, deal, { by: user.address, outcome: body.outcome, refundUnits, reasons, policyClauses, role: 'central-review', model, keepCancelled: agreedCancel });
        } else {
          // Upheld: the ordered refund stands, and its deadline runs from now (it did not run during the appeal).
          for (const r of deal.refunds.filter((r) => r.decisionId === x.id && !r.paidAt && !r.refusedAt)) { const q = state.requests[r.requestId]; if (q?.status === 'open') { q.expiresAt = new Date(now() + TRADE_POLICY.orderedRefundDays * DAY).toISOString(); q.updatedAt = nowIso(); } }
          entry = { id: randomUUID(), kind: 'appeal-decision', at: nowIso(), by: user.address, dealId: deal.id, disputeId: x.id, outcome: x.decision.outcome, refundAmount: x.decision.refundAmount, reasons, policyClauses, policyVersion: TRADE_POLICY.version, model, effects: [] };
          recordDecision(d, entry);
        }
        x.status = 'final'; x.appealDecision = { by: user.address, result: body.result, outcome: entry.outcome, refundAmount: entry.refundAmount, reasons, policyClauses, at: entry.at, decisionId: entry.id, effects: entry.effects };
        emit(d, { type: 'dispute.appeal-decided', dealId: deal.id, disputeId: x.id, actor: user.address, summary: `Central review ${body.result} the steward decision${body.result === 'overturned' ? ` (${entry.outcome})` : ''}.` });
        return { decision: entry, dispute: disputeView(state, x), deal: dealView(state, deal, { full: false }) };
      });
    },
    async stewardAction(user, dealId, action, body) {
      principal(user); steward(user);
      only(body, ['clientRequestId', 'reasons', 'policyClauses'], ['model']);
      client(body.clientRequestId);
      const reasons = text(body.reasons, 4000, 'Reasons', { min: 20 }), policyClauses = clauses(body.policyClauses);
      const model = body.model === undefined ? null : text(body.model, 120, 'Model');
      check(['retry-payment', 'confirm-delivery', 'note'].includes(action), 404, 'not_found', 'Unknown steward action.');
      return tx(user, (state, d) => {
        const deal = dealIn(d, dealId);
        check(![deal.seller, deal.buyer].includes(user.address), 403, 'steward_conflict', 'A steward never acts on a deal it is party to.');
        sync(state, d, deal);
        const effects = [];
        if (action === 'retry-payment') {
          const q = paymentRequest(state, deal);
          check(q && ['agreed', 'expired'].includes(deal.status) && ['open', 'expired'].includes(q.status), 409, 'retry_unavailable', 'Only an unpaid, agreed deal payment can be retried.');
          // Reconciliation first: never retry while any attempt may have reached the ledger.
          check(!locked(state, q.id), 409, 'payment_reconciliation_required', 'A payment attempt still holds this request. Reconcile or abandon it first.');
          check(!superseded(state, d, deal, q.id), 409, 'deal_superseded', 'A newer deal for this proposal exists, so this one stays closed.');
          // Any send marker or envelope counts, whatever the status says.
          const risky = intentsFor(state, q.id).filter((i) => i.sendAttemptedAt || i.envelope || i.effects || ['intent-ready', 'ledger-recorded', 'recipient-confirmed-paid', 'broadcasting', 'unknown', 'submitted'].includes(i.status));
          check(risky.length === 0 && !sendsFor(state, q.id).some(sendMayHaveDebited), 409, 'payment_reconciliation_required', 'An earlier attempt may have reached the ledger. Reconcile it; a payment never sends twice.');
          const at = nowIso();
          if (q.status === 'expired') { q.status = 'open'; addHistory(state, 'request.reopened', q, user.address); }
          q.updatedAt = at; q.expiresAt = new Date(now() + deal.paymentWindowHours * HOUR).toISOString();
          deal.status = 'agreed'; deal.paymentRetries.push({ at, by: user.address, attemptsBefore: intentsFor(state, q.id).length + sendsFor(state, q.id).length, expiresAt: q.expiresAt });
          effects.push({ requestId: q.id, expiresAt: q.expiresAt });
          emit(d, { type: 'payment.retry', dealId: deal.id, actor: user.address, summary: `Steward reopened the payment after reconciliation; due by ${q.expiresAt}.` });
        } else if (action === 'confirm-delivery') {
          check(['agreed', 'paid'].includes(deal.status) && paid(state, deal), 409, 'confirm_unavailable', 'Only a paid deal with deliveries can be confirmed by a steward.');
          const delivered = deal.milestones.filter((m) => m.status === 'delivered');
          check(delivered.length > 0 && delivered.every((m) => Date.parse(m.delivery.at) + TRADE_POLICY.deliveryConfirmDays * DAY <= now()), 409, 'buyer_still_has_time', `The buyer has ${TRADE_POLICY.deliveryConfirmDays} days to review a delivery.`);
          for (const m of delivered) { m.status = 'confirmed'; m.confirmedAt = nowIso(); m.confirmedBy = user.address; effects.push({ milestone: m.index }); }
          emit(d, { type: 'milestone.steward-confirmed', dealId: deal.id, actor: user.address, summary: `Steward confirmed ${delivered.length} delivery(ies) after the buyer's review window.` });
          sync(state, d, deal);
        } else {
          emit(d, { type: 'steward.note', dealId: deal.id, actor: user.address, summary: Array.from(reasons).slice(0, 300).join('') });
        }
        deal.updatedAt = nowIso();
        const entry = { id: randomUUID(), kind: `steward-${action}`, at: nowIso(), by: user.address, dealId: deal.id, disputeId: null, outcome: action, refundAmount: null, reasons, policyClauses, policyVersion: TRADE_POLICY.version, model, effects };
        recordDecision(d, entry);
        return { decision: entry, deal: dealView(state, deal) };
      });
    },

    // Public reads: no signature, everything visible (decision 9 November 2026).
    detail(dealId) {
      const state = store.read(), d = storage(state); return { deal: dealView(state, dealIn(d, dealId)) };
    },
    list(query = {}) {
      only(query, [], ['page', 'pageSize', 'member', 'status', 'offerId']);
      check(query.member === undefined || ADDRESS.test(query.member), 400, 'invalid_query', 'Give the member as a UAIN address that starts with uain1.');
      const p = page(query), state = store.read(), d = storage(state);
      const rows = Object.values(d.deals)
        .filter((x) => (!query.member || x.seller === query.member || x.buyer === query.member) && (!query.offerId || x.offerId === query.offerId))
        .map((x) => dealView(state, x, { full: false }))
        .filter((x) => !query.status || x.status === query.status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      const s = slice(rows, p); return { deals: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages };
    },
    dispute(disputeId) {
      const state = store.read(), d = storage(state);
      const x = Object.hasOwn(d.disputes, id(disputeId, 'dispute identifier')) ? d.disputes[disputeId] : null; check(x, 404, 'dispute_not_found', 'No dispute has this id, so check the dispute id and try again.');
      return { dispute: disputeView(state, x), deal: dealView(state, d.deals[x.dealId], { full: false }) };
    },
    disputes(query = {}) {
      only(query, [], ['page', 'pageSize', 'status']);
      const p = page(query), state = store.read(), d = storage(state);
      const rows = Object.values(d.disputes).filter((x) => !query.status || x.status === query.status).map((x) => disputeView(state, x, { full: false })).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
      const s = slice(rows, p); return { disputes: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages };
    },
    decisions(query = {}) {
      only(query, [], ['page', 'pageSize', 'dealId']);
      const p = page(query), d = storage(store.read());
      const rows = d.decisions.filter((x) => !query.dealId || x.dealId === query.dealId).slice().reverse();
      const s = slice(rows, p); return { decisions: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages, policyVersion: TRADE_POLICY.version };
    },
    /** One public feed: listings, enquiries, sent proposals and every deal event. */
    feed(query = {}) {
      only(query, [], ['page', 'pageSize', 'member', 'type']);
      check(query.member === undefined || ADDRESS.test(query.member), 400, 'invalid_query', 'Give the member as a UAIN address that starts with uain1.');
      const p = page(query), state = store.read(), d = storage(state);
      const t = state.trade ?? { offers: {}, enquiries: {} }, terms = state.tradeTerms ?? { proposals: {} };
      const deals = d.deals;
      const rows = [
        ...Object.values(t.offers).map((o) => ({ at: o.createdAt, type: 'offer.published', offerId: o.id, actor: o.owner, parties: [o.owner], summary: `Listed "${o.title}" at ${o.price} AI$.` })),
        ...Object.values(t.offers).filter((o) => o.availability !== 'open').map((o) => ({ at: o.updatedAt, type: 'offer.withdrawn', offerId: o.id, actor: o.owner, parties: [o.owner], summary: `Withdrew "${o.title}".` })),
        ...Object.values(t.enquiries).map((e) => ({ at: e.createdAt, type: 'enquiry.sent', offerId: e.offerId, enquiryId: e.id, actor: e.buyer, parties: [e.buyer, e.seller], summary: `Enquired about "${e.offerTitle}".` })),
        ...Object.values(terms.proposals).map((x) => ({ at: x.sentAt, type: 'terms.sent', enquiryId: x.enquiryId, proposalId: x.id, actor: x.author, parties: [x.enquirySnapshot.buyer, x.enquirySnapshot.seller], summary: `Proposed terms at ${x.terms.price} AI$.` })),
        ...d.events.map((e) => ({ ...e, parties: e.dealId && deals[e.dealId] ? [deals[e.dealId].seller, deals[e.dealId].buyer] : [] })),
      ].filter((e) => (!query.member || e.parties.includes(query.member)) && (!query.type || e.type.startsWith(query.type)))
        .sort((a, b) => b.at.localeCompare(a.at) || (b.seq ?? 0) - (a.seq ?? 0));
      const s = slice(rows, p); return { events: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages };
    },
    /** Public enquiries for one listing and the sent proposals of one enquiry. */
    publicEnquiries(query = {}) {
      only(query, [], ['offerId', 'page', 'pageSize']);
      id(query.offerId, 'listing identifier');
      const p = page(query), t = store.read().trade ?? { enquiries: {} };
      const rows = Object.values(t.enquiries).filter((e) => e.offerId === query.offerId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((e) => ({ id: e.id, offerId: e.offerId, buyer: e.buyer, seller: e.seller, message: e.message, offer: { title: e.offerTitle, price: e.offerPrice, revision: e.offerRevision }, createdAt: e.createdAt }));
      const s = slice(rows, p); return { enquiries: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages };
    },
    publicProposals(query = {}) {
      only(query, [], ['enquiryId', 'page', 'pageSize']);
      id(query.enquiryId, 'enquiry identifier');
      const p = page(query), terms = store.read().tradeTerms ?? { proposals: {} };
      const rows = Object.values(terms.proposals).filter((x) => x.enquiryId === query.enquiryId).sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .map((x) => { const dto = { id: x.id, kind: 'nonbinding-terms-proposal', enquiryId: x.enquiryId, author: x.author, draftId: x.draftId, draftRevision: x.draftRevision, terms: x.terms, enquirySnapshot: x.enquirySnapshot, sentAt: x.sentAt, nonbinding: true, binding: false, settlementAvailable: false, acceptanceAvailable: false, notice: 'Discussion only. No agreement, purchase, escrow, payment or native financial action is created.' }; return { ...dto, proposalDigest: tradeProposalDigest(dto) }; });
      const s = slice(rows, p); return { proposals: s.rows, count: s.count, page: s.page, pageSize: s.pageSize, pages: s.pages };
    },
    /** A member's public trade record and reputation. Ratings never change Karma. */
    member(address) {
      check(typeof address === 'string' && ADDRESS.test(address), 400, 'invalid_query', 'Give a UAIN address.');
      const state = store.read(), d = storage(state);
      const mine = Object.values(d.deals).filter((x) => x.seller === address || x.buyer === address);
      const views = mine.map((x) => dealView(state, x, { full: false }));
      const ratings = mine.flatMap((x) => Object.values(x.ratings).filter((r) => r && r.of === address));
      const disputes = Object.values(d.disputes).filter((x) => x.openedBy === address || x.respondent === address);
      // Trade leftover (d), 15 November 2026: a no-refund that left standing the refund both parties
      // agreed when they cancelled (an overturn that orders nothing, B2-1) is no loss for the buyer.
      const agreedBefore = (deal, at) => deal.refunds.some((r) => r.source === 'mutual-cancel' && binding(r) && !r.refusedAt && !r.replacedBy && r.createdAt <= at && ['open', 'paid'].includes(state.requests?.[r.requestId]?.status));
      const lost = disputes.filter((x) => { const o = x.appealDecision?.outcome ?? x.decision?.outcome; if (!o || o === 'redeliver') return false; const deal = d.deals[x.dealId]; const sellerLost = ['refund-full', 'refund-partial', 'cancel-deal'].includes(o); if (!sellerLost && agreedBefore(deal, x.appealDecision?.at ?? x.decision?.at)) return false; return (sellerLost ? deal.seller : deal.buyer) === address; });
      const refusedRefunds = mine.filter((x) => x.seller === address).flatMap((x) => x.refunds).filter((r) => binding(r) && (r.refusedAt || state.requests?.[r.requestId]?.status === 'declined')).length;
      const count = (role, status) => views.filter((v) => v[role] === address && (!status || v.status === status)).length;
      return {
        address,
        reputation: {
          completedAsSeller: count('seller', 'completed'), completedAsBuyer: count('buyer', 'completed'),
          dealsAsSeller: count('seller'), dealsAsBuyer: count('buyer'),
          ratingCount: ratings.length, averageRating: ratings.length ? Math.round(ratings.reduce((s, r) => s + r.score, 0) / ratings.length * 100) / 100 : null,
          disputesInvolved: disputes.length, disputesLost: lost.length, orderedRefundsDeclined: refusedRefunds,
          karmaEffect: 'none: trade ratings are reputation only; a declined ordered refund is referred to central review (policy P12).',
        },
        ratings: ratings.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
        deals: views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100),
      };
    },
    /** Deals that need a steward: the queue the UAIN trade agents work from. */
    attention() {
      const state = store.read(), d = storage(state), stamp = now(), items = [];
      for (const deal of Object.values(d.deals)) {
        const status = effectiveStatus(state, deal), q = paymentRequest(state, deal);
        if (status === 'disputed') { const x = d.disputes[deal.disputeId]; if (x?.status === 'open') items.push({ kind: 'dispute-open', dealId: deal.id, disputeId: x.id, since: x.openedAt }); }
        if (q && ['agreed', 'expired'].includes(status)) {
          const intents = intentsFor(state, q.id);
          const sends = sendsFor(state, q.id);
          const lastFailure = [...intents.filter((i) => i.status === 'abandoned'), ...sends.filter((r) => SEND_DEAD.includes(r.status))].map((i) => i.updatedAt).sort().at(-1);
          const lastRetry = (deal.paymentRetries ?? []).at(-1)?.at;
          const failedSinceRetry = lastFailure && (!lastRetry || lastFailure > lastRetry);
          const unsafe = intents.some((i) => i.sendAttemptedAt || i.envelope || i.effects) || sends.some(sendMayHaveDebited);
          if ((status === 'expired' || failedSinceRetry) && !locked(state, q.id) && !superseded(state, d, deal, q.id)) items.push({ kind: unsafe ? 'payment-reconcile' : 'payment-failed', reason: status === 'expired' ? 'expired' : 'attempt-abandoned', dealId: deal.id, requestId: q.id, since: status === 'expired' ? q.expiresAt : lastFailure, attempts: intents.length + sends.length });
          const lock = state.nativePaymentRequestLocks?.[q.id], held = lock && state.nativePaymentIntents?.[lock];
          if (held && Date.parse(held.updatedAt) + TRADE_POLICY.stuckPaymentMinutes * 60_000 <= stamp) items.push({ kind: 'payment-stuck', dealId: deal.id, requestId: q.id, intentStatus: held.status, since: held.updatedAt });
          const send = heldSend(state, q.id);
          if (send && Date.parse(send.updatedAt) + TRADE_POLICY.stuckPaymentMinutes * 60_000 <= stamp) items.push({ kind: 'payment-stuck', dealId: deal.id, requestId: q.id, sendId: send.id, intentStatus: send.status, since: send.updatedAt });
        }
        if (['paid', 'agreed'].includes(status) && paid(state, deal)) {
          const late = deal.milestones.filter((m) => m.status === 'delivered' && Date.parse(m.delivery.at) + TRADE_POLICY.deliveryConfirmDays * DAY <= stamp);
          if (late.length) items.push({ kind: 'delivery-unconfirmed', dealId: deal.id, milestones: late.map((m) => m.index), since: late[0].delivery.at });
        }
        for (const r of deal.refunds) { const rq = state.requests?.[r.requestId]; if (binding(r) && (r.refusedAt || rq?.status === 'declined')) items.push({ kind: 'ordered-refund-declined', reason: r.refusal === 'expired-unpaid' ? 'expired' : 'declined', source: r.source, dealId: deal.id, refundId: r.id, since: r.refusedAt ?? rq.updatedAt }); }
      }
      for (const x of Object.values(d.disputes)) if (x.status === 'appealed') items.push({ kind: 'appeal-open', dealId: x.dealId, disputeId: x.id, since: x.appeal.at });
      return { items: items.sort((a, b) => a.since.localeCompare(b.since)), count: items.length, policyVersion: TRADE_POLICY.version, stewards: [...stewardSet], appealReviewers: [...reviewerSet] };
    },
    /** Pay route guard: a deal payment request that expired cannot be paid. */
    assertPayable(request) {
      check(!request.expiresAt || Date.parse(request.expiresAt) > now(), 409, 'payment_request_expired', 'The time to pay this deal ran out; a UAIN steward reopens it shortly, then pay again.');
    },
  };
}
