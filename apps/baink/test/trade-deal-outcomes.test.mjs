// Deal outcomes handed over by the 10 November 2026 security review (docs/security/review-2026-11-10.md):
// D1 a landed but unconfirmed payment, D2 an ignored ordered refund, D3 a party refund during a
// dispute, C2 one live dispute per deal, C3 stale cancel consent, C7 ratings on states that can reopen.
// FIXTURE level: the BAINK HTTP server on a temporary store; payments are written as the send
// services would write them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
import { tradeProposalDigest } from '../server/trade-payment.mjs';
import { verifyDealDigest } from '../web/trade-deals-view.js';

let n = 0;
const cid = (label) => `${label}-${++n}-${Date.now()}`.slice(0, 90);
const HOUR = 3_600_000, DAY = 24 * HOUR;
async function world(t) {
  const clock = { now: Date.now() };
  const steward = [member(), member()], reviewer = [member()];
  const f = await fixture(t, { tradeStewardAddresses: steward.map((x) => x.address), tradeAppealReviewerAddresses: reviewer.map((x) => x.address), tradeDealSweep: false, now: () => clock.now });
  const seller = member(), buyer = member();
  for (const who of [seller, buyer, ...steward, ...reviewer]) assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 'Fictional trader' })).status, 201);
  const read = async (id) => (await f.request(null, 'GET', `/api/trade/deals/${id}`)).body.deal;
  async function agreed({ window = 1 } = {}) {
    const offer = (await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Fictional analysis service', description: 'A fictional deliverable for tests', price: '2.5', publish: true })).body.offer;
    const enquiry = (await f.request(buyer, 'POST', `/api/trade/offers/${offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: offer.revision })).body.enquiry;
    const draft = (await f.request(seller, 'POST', `/api/trade/enquiries/${enquiry.id}/terms`, { clientRequestId: cid('draft'), terms: { scope: 'Fictional scope', deliverables: 'Fictional report', price: '2.5', timeline: 'Two days', acceptanceCriteria: 'Covers the questions' } })).body.draft;
    const proposal = (await f.request(seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('send'), expectedRevision: 1, confirmNonbinding: true })).body.proposal;
    const deal = (await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: proposal.id, proposalDigest: tradeProposalDigest(proposal), confirmBindingDraft: true, paymentWindowHours: window })).body.deal;
    for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: deal.dealDigest, confirmBinding: true })).status, 200);
    return read(deal.id);
  }
  // What the send service writes when the buyer's payment is final on the ledger and the seller has not confirmed.
  const land = (deal) => f.edit((s) => { const id = (++n).toString(16).padStart(64, 'f'); (s.serverSendIntents ??= {})[id] = { id, schema: 'baink-server-send-v1', intent: { requestId: deal.payment.request.id, from: buyer.address, to: seller.address, amountUnits: '2500000', chainId: 'fictional', notAfter: new Date(clock.now + DAY).toISOString() }, status: 'finalized', attempts: [], result: { effects: 'e'.repeat(64), height: '10' }, recipientConfirmation: null, createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString() }; (s.serverSendRequestLocks ??= {})[deal.payment.request.id] = id; });
  // What the payee's confirmation writes.
  const markPaid = (requestId) => f.edit((s) => { const q = s.requests[requestId]; q.status = 'paid'; q.updatedAt = new Date(clock.now).toISOString(); q.paymentIntentId = '00000000-0000-4000-8000-000000000000'; q.settlement = { kind: 'native-private-payment', effects: [], chainId: 'fictional', requestDigest: 'a'.repeat(64), amountVerification: 'recipient-attested', publicAmountProof: false }; });
  const paidDeal = async () => { const deal = await agreed(); await markPaid(deal.payment.request.id); return read(deal.id); };
  const dispute = async (who, deal, desiredOutcome = 'refund') => { const r = await f.request(who, 'POST', `/api/trade/deals/${deal.id}/disputes`, { clientRequestId: cid('x'), reason: 'Nothing was delivered after payment.', desiredOutcome }); return r; };
  const decide = (by, disputeId, outcome, extra = {}) => f.request(by, 'POST', `/api/trade/steward/disputes/${disputeId}/decision`, { clientRequestId: cid('dec'), outcome, reasons: 'Decided under the written policy on the filed evidence.', policyClauses: ['P5-non-delivery'], ...extra });
  const attention = async () => (await f.request(null, 'GET', '/api/trade/attention')).body.items;
  return { f, clock, seller, buyer, steward, reviewer, read, agreed, land, markPaid, paidDeal, dispute, decide, attention };
}
const code = (r) => [r.status, r.body.error?.code];

test('D1: a payment that landed but the seller never confirms can be refunded by decision after the grace period', async (t) => {
  const w = await world(t), { f, clock, buyer, steward } = w;
  const deal = await w.agreed();
  await w.land(deal);
  // The buyer cannot cancel a deal whose payment arrived, and is told what to do instead.
  const cancel = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'The seller is silent' });
  assert.deepEqual(code(cancel), [409, 'payment_request_paid']); assert.match(cancel.body.error.message, /dispute/);
  const opened = await w.dispute(buyer, deal);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  // Inside the grace period the seller can still confirm in the ordinary way: no refund order yet.
  assert.deepEqual(code(await w.decide(steward[0], opened.body.dispute.id, 'refund-full')), [409, 'deal_not_paid']);
  clock.now += 25 * HOUR;
  const decided = await w.decide(steward[0], opened.body.dispute.id, 'refund-full');
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const after = await w.read(deal.id);
  assert.equal(after.status, 'refunded'); assert.equal(after.refunds.length, 1);
  assert.deepEqual([after.refunds[0].amount, after.refunds[0].source, after.refunds[0].request.status], ['2.500000', 'steward-decision', 'open']);
  assert.equal(after.payment.request.status, 'open', 'the payment request still waits for the seller, so a late confirmation is recorded');
});
test('D1: a steward can cancel a deal whose payment landed unconfirmed; the buyer is refunded and the payment is never reopened', async (t) => {
  const w = await world(t), { f, clock, buyer, steward } = w;
  const deal = await w.agreed();
  await w.land(deal);
  clock.now += 25 * HOUR;
  const opened = await w.dispute(buyer, deal, 'cancel');
  const decided = await w.decide(steward[0], opened.body.dispute.id, 'cancel-deal', { policyClauses: ['P8-cancel'] });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const after = await w.read(deal.id);
  assert.equal(after.status, 'cancelled'); assert.equal(after.refunds[0].amount, '2.500000');
  assert.equal(after.payment.request.status, 'open');
  const retry = await f.request(steward[1], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'Trying to reopen a payment that already landed.', policyClauses: ['P7-failed-payment'] });
  assert.equal(retry.status, 409);
});

test('D2: an ordered refund the seller ignores expires, is recorded as refused (P12), and the deal no longer reads refunded', async (t) => {
  const w = await world(t), { f, clock, seller, buyer, steward } = w;
  const deal = await w.paidDeal();
  const opened = await w.dispute(buyer, deal);
  assert.equal((await w.decide(steward[0], opened.body.dispute.id, 'refund-full')).status, 200);
  let now = await w.read(deal.id);
  const refund = now.refunds[0];
  assert.equal(now.status, 'refunded');
  assert.equal(Date.parse(refund.request.expiresAt) - Date.parse(refund.createdAt), 7 * DAY, 'an ordered refund has a deadline');
  clock.now += 8 * DAY;
  await w.agreed(); // any deal step runs the sweep
  now = await w.read(deal.id);
  assert.equal(now.refunds[0].request.status, 'expired');
  assert.equal(now.refunds[0].refusal, 'expired-unpaid'); assert.ok(now.refunds[0].refusedAt);
  assert.equal(now.status, 'paid', 'the buyer is not left with a deal that reads refunded');
  assert.equal(now.refundOwed, '0.000000');
  assert.ok(now.timeline.some((e) => e.type === 'refund.refused'), 'recorded publicly');
  assert.ok((await w.attention()).some((x) => x.kind === 'ordered-refund-declined' && x.dealId === deal.id && x.reason === 'expired'));
  assert.equal((await f.request(null, 'GET', `/api/trade/members/${seller.address}`)).body.reputation.orderedRefundsDeclined, 1);
  // The buyer has a next step again: a new dispute about the refused refund.
  assert.equal((await w.dispute(buyer, now)).status, 201);
});
test('D2: a declined ordered refund reopens the deal the same way; a paid one keeps it refunded', async (t) => {
  const w = await world(t), { f, seller, buyer, steward } = w;
  const declined = await w.paidDeal(), paid = await w.paidDeal();
  for (const deal of [declined, paid]) { const x = await w.dispute(buyer, deal); assert.equal((await w.decide(steward[0], x.body.dispute.id, 'refund-full')).status, 200); }
  const refundOf = async (deal) => (await w.read(deal.id)).refunds[0];
  assert.equal((await f.request(seller, 'POST', `/api/requests/${(await refundOf(declined)).requestId}/decline`, {})).status, 200);
  await w.markPaid((await refundOf(paid)).requestId);
  await w.agreed();
  const a = await w.read(declined.id), b = await w.read(paid.id);
  assert.deepEqual([a.status, a.refunds[0].refusal], ['paid', 'declined']);
  assert.deepEqual([b.status, b.refunds[0].refusal ?? null, Boolean(b.refunds[0].paidAt)], ['refunded', null, true]);
  assert.equal((await f.request(null, 'GET', `/api/trade/members/${seller.address}`)).body.reputation.orderedRefundsDeclined, 1);
});

test('D3: a refund a party opened during a dispute does not block the steward\'s order', async (t) => {
  const w = await world(t), { f, seller, buyer, steward } = w;
  const deal = await w.paidDeal();
  const opened = await w.dispute(buyer, deal);
  // The seller "offers" the whole price back and never pays it.
  const offered = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2.5', reason: 'I will refund it myself' });
  assert.equal(offered.status, 201);
  const decided = await w.decide(steward[0], opened.body.dispute.id, 'refund-full');
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  const after = await w.read(deal.id);
  const byId = Object.fromEntries(after.refunds.map((r) => [r.source, r]));
  assert.equal(byId['seller-offered'].request.status, 'cancelled', 'the decision replaces the open party refund');
  assert.deepEqual([byId['steward-decision'].amount, byId['steward-decision'].request.status], ['2.500000', 'open']);
  assert.equal(after.refundOwed, '2.500000');
});

test('C2: while a dispute is open, decided or appealed there is no second one; the way on is the appeal', async (t) => {
  const w = await world(t), { f, clock, seller, buyer, steward } = w;
  const deal = await w.paidDeal();
  const first = await w.dispute(buyer, deal);
  assert.equal((await w.decide(steward[0], first.body.dispute.id, 'no-refund', { policyClauses: ['P3-delivery'] })).status, 200);
  assert.equal((await w.read(deal.id)).status, 'paid');
  // The loser cannot open the matter again inside the appeal window.
  const again = await w.dispute(buyer, deal);
  assert.deepEqual(code(again), [409, 'dispute_pending']); assert.match(again.body.error.message, /appeal/);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${first.body.dispute.id}/appeal`, { clientRequestId: cid('ap'), reason: 'The delivery was never made.' })).body.dispute.status, 'appealed');
  assert.deepEqual(code(await w.dispute(seller, deal)), [409, 'dispute_pending']);
  assert.equal((await w.read(deal.id)).disputes.filter((x) => x.status !== 'final').length, 1, 'one live dispute');
});
test('C2: after a final decision a new matter can be disputed, three disputes a deal at most', async (t) => {
  const w = await world(t), { clock, buyer, steward } = w;
  const deal = await w.paidDeal();
  for (let i = 0; i < 3; i++) {
    const x = await w.dispute(buyer, deal);
    assert.equal(x.status, 201, JSON.stringify(x.body));
    assert.equal((await w.decide(steward[0], x.body.dispute.id, 'no-refund', { policyClauses: ['P3-delivery'] })).status, 200);
    clock.now += 8 * DAY; // the appeal window closes: final
  }
  assert.deepEqual(code(await w.dispute(buyer, deal)), [409, 'dispute_limit']);
});

test('C3: consent to cancel a paid deal lapses after seven days', async (t) => {
  const w = await world(t), { f, clock, seller, buyer } = w;
  const deal = await w.paidDeal();
  const asked = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'No longer needed' });
  assert.deepEqual([asked.body.cancelled, asked.body.awaiting], [false, 'seller']);
  clock.now += 8 * DAY;
  // Weeks later the other party "agrees": the old request no longer counts.
  const late = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Agreed, at last' });
  assert.deepEqual([late.status, late.body.cancelled, late.body.awaiting], [200, false, 'buyer']);
  assert.equal((await w.read(deal.id)).refunds.length, 0, 'no refund is ordered on a lapsed consent');
  // Fresh consent from both still cancels and refunds.
  const fresh = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Yes, cancel' });
  assert.equal(fresh.body.deal.status, 'cancelled'); assert.equal(fresh.body.deal.refunds[0].source, 'mutual-cancel');
});

test('C7: a deal is rated only once it can no longer reopen', async (t) => {
  const w = await world(t), { f, clock, seller, buyer, steward } = w;
  const rate = (who, deal) => f.request(who, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 2 });
  // Expired, and a steward can still reopen its payment.
  const expired = await w.agreed();
  // Refunded by decision: the appeal window is open and the ordered refund is unpaid.
  const refunded = await w.paidDeal();
  const x = await w.dispute(buyer, refunded);
  assert.equal((await w.decide(steward[0], x.body.dispute.id, 'refund-full')).status, 200);
  clock.now += 2 * HOUR;
  await w.agreed(); // sweep: the first deal's payment window passed
  assert.equal((await w.read(expired.id)).status, 'expired');
  for (const deal of [expired, refunded]) {
    const r = await rate(seller, deal);
    assert.deepEqual(code(r), [409, 'deal_not_final'], JSON.stringify(r.body));
    assert.equal((await w.read(deal.id)).rateable, false);
  }
  // Refund paid and the appeal window closed: final, so it can be rated.
  await w.markPaid((await w.read(refunded.id)).refunds[0].requestId);
  clock.now += 8 * DAY;
  await w.agreed();
  assert.equal((await w.read(refunded.id)).rateable, true);
  assert.equal((await rate(buyer, refunded)).status, 200);
  assert.deepEqual(code(await rate(buyer, refunded)), [409, 'already_rated']);
});

// B2-1 (security review, 13 November 2026): a paid deal cancelled by both parties read cancelled
// before the buyer was refunded. An open party refund counted as refunded, so the mutual cancel
// ordered nothing, and a declined mutual-cancel refund was recorded nowhere and left a deal that
// could not be disputed. The agreed refund now runs like an ordered one (D2).
const cancelBoth = async (w, deal) => {
  const { f, seller, buyer } = w;
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Cannot deliver, refunding' })).status, 200);
  return f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Agreed, refund me' });
};
test('B2-1: a declined mutual-cancel refund is recorded against the seller and the deal returns to paid, open to dispute', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  const deal = await w.paidDeal();
  const both = await cancelBoth(w, deal);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  const refund = both.body.deal.refunds[0];
  assert.deepEqual([both.body.deal.status, refund.source, refund.request.status], ['cancelled', 'mutual-cancel', 'open']);
  assert.equal(Date.parse(refund.request.expiresAt) - Date.parse(refund.createdAt), 7 * DAY, 'the agreed refund has a deadline');
  assert.equal(both.body.deal.rateable, false, 'a cancelled deal with its refund unpaid can still reopen');
  assert.equal((await f.request(seller, 'POST', `/api/requests/${refund.requestId}/decline`, {})).status, 200);
  await w.agreed(); // any deal step runs the sweep
  const after = await w.read(deal.id);
  assert.deepEqual([after.status, after.refunds[0].refusal], ['paid', 'declined']);
  assert.ok(after.timeline.some((e) => e.type === 'refund.refused'), 'recorded publicly');
  assert.ok((await w.attention()).some((x) => x.kind === 'ordered-refund-declined' && x.dealId === deal.id && x.source === 'mutual-cancel'));
  assert.equal((await f.request(null, 'GET', `/api/trade/members/${seller.address}`)).body.reputation.orderedRefundsDeclined, 1);
  // The earlier consent does not cancel the reopened deal again on one party's word.
  const one = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Cancel again' });
  assert.deepEqual([one.status, one.body.cancelled, one.body.awaiting], [200, false, 'buyer']);
  assert.equal((await w.dispute(buyer, after)).status, 201, 'the buyer can dispute the unrefunded deal');
});
test('B2-1: a mutual cancel replaces an open party refund and orders the whole price; ignored, it expires as refused', async (t) => {
  const w = await world(t), { f, clock, seller, buyer } = w;
  const deal = await w.paidDeal();
  const offered = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2.5', reason: 'Sorry, I will refund you in full' });
  assert.equal(offered.status, 201);
  const both = await cancelBoth(w, deal);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  const bySource = Object.fromEntries(both.body.deal.refunds.map((r) => [r.source, r]));
  assert.equal(bySource['seller-offered']?.request.status, 'cancelled', 'the agreed refund replaces the open offer');
  assert.deepEqual([bySource['mutual-cancel']?.amount, bySource['mutual-cancel']?.request.status], ['2.500000', 'open']);
  assert.equal(both.body.deal.refundOwed, '2.500000');
  // The replaced offer can no longer be declined to strand the buyer.
  assert.equal((await f.request(seller, 'POST', `/api/requests/${offered.body.refund.requestId}/decline`, {})).status, 409);
  clock.now += 8 * DAY;
  await w.agreed();
  const after = await w.read(deal.id);
  const agreed = after.refunds.find((r) => r.source === 'mutual-cancel');
  assert.deepEqual([after.status, agreed.request.status, agreed.refusal], ['paid', 'expired', 'expired-unpaid']);
  assert.ok((await w.attention()).some((x) => x.kind === 'ordered-refund-declined' && x.dealId === deal.id && x.reason === 'expired'));
  assert.equal((await w.dispute(buyer, after)).status, 201);
});
test('B2-1: a paid mutual-cancel refund keeps the deal cancelled and final', async (t) => {
  const w = await world(t), { f, buyer } = w;
  const deal = await w.paidDeal();
  const both = await cancelBoth(w, deal);
  await w.markPaid(both.body.deal.refunds[0].requestId);
  await w.agreed();
  const after = await w.read(deal.id);
  assert.deepEqual([after.status, Boolean(after.refunds[0].paidAt), after.refunds[0].refusal ?? null, after.rateable], ['cancelled', true, null, true]);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 4 })).status, 200);
});
// L1 (security review, 13 November 2026): the public event list is global and bounded, and it
// evicted the oldest events first, so one busy deal could push an honest deal's record out.
test('L1: a flood of events on one deal never pushes another deal\'s timeline out, and repeats trim themselves first', async (t) => {
  const w = await world(t), { f, seller } = w;
  const honest = await w.agreed();
  const before = honest.timeline.map((e) => e.type);
  assert.deepEqual(before, ['deal.drafted', 'deal.signed', 'deal.signed', 'deal.agreed']);
  // Another deal (fictional id) fills the whole list with later events.
  const at = new Date(w.clock.now).toISOString();
  await f.edit((s) => { let seq = s.tradeDeals.sequence; for (let i = 0; i < 4000; i++) s.tradeDeals.events.push({ seq: ++seq, at, type: 'milestone.delivered', dealId: 'spam-deal', actor: seller.address, summary: 'Spam' }); s.tradeDeals.sequence = seq; });
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${honest.id}/milestones/0/deliver`, { clientRequestId: cid('dl'), note: 'Delivered' })).status, 200);
  const after = await w.read(honest.id);
  assert.deepEqual(after.timeline.map((e) => e.type), [...before, 'milestone.delivered'], 'the honest deal keeps its whole timeline');
  let events;
  await f.edit((s) => { events = s.tradeDeals.events; });
  assert.equal(events.length, 4000, 'the list stays at its bound');
  // One deal's own repeats are capped too, and they trim their own kind before the deal's history.
  await f.edit((s) => { let seq = s.tradeDeals.sequence; for (let i = 0; i < 400; i++) s.tradeDeals.events.push({ seq: ++seq, at, type: 'milestone.delivered', dealId: honest.id, actor: seller.address, summary: `Delivered again ${i}` }); s.tradeDeals.sequence = seq; });
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${honest.id}/milestones/0/deliver`, { clientRequestId: cid('dl'), note: 'Delivered once more' })).status, 200);
  const capped = await w.read(honest.id);
  assert.equal(capped.timeline.length, 400);
  assert.deepEqual(capped.timeline.slice(0, 4).map((e) => e.type), before, 'the deal\'s own history stays; its repeats were trimmed');
  assert.equal(capped.timeline.at(-1).summary, 'Milestone 1 delivered: Delivery of the agreed deliverables');
});
// Review of B2-1 (13 November 2026): a mutual-cancel refund agreed before this release carried no
// deadline, so the binding rule must not reach back and record it as refused after the legacy
// request grace (17 November); only refunds the new code marks as binding are held to it.
test('B2-1: mutual-cancel refunds agreed before this release are left exactly as before', async (t) => {
  const w = await world(t), { f, clock, seller } = w;
  const open = await w.paidDeal(), declined = await w.paidDeal();
  const refunds = {};
  for (const deal of [open, declined]) { const both = await cancelBoth(w, deal); assert.equal(both.body.deal.refunds[0].binding, true, 'the new code marks the refund it binds'); refunds[deal.id] = both.body.deal.refunds[0]; }
  // What a pre-release store holds: no marker, no deadline; one of them the seller declined back then.
  await f.edit((s) => {
    for (const deal of [open, declined]) { const r = s.tradeDeals.deals[deal.id].refunds[0]; delete r.binding; delete s.requests[r.requestId].expiresAt; }
    const q = s.requests[refunds[declined.id].requestId]; q.status = 'declined'; q.updatedAt = new Date(clock.now).toISOString();
  });
  clock.now = Math.max(clock.now, Date.parse('2026-11-17T00:00:00Z')) + 30 * DAY;
  await w.agreed(); // the sweep runs
  for (const deal of [open, declined]) {
    const now = await w.read(deal.id);
    assert.equal(now.status, 'cancelled', 'no reopen');
    assert.equal(now.refunds[0].refusal ?? null, null, 'no refusal record');
    assert.ok(!now.timeline.some((e) => e.type === 'refund.refused' || e.type === 'deal.reopened'));
    assert.ok(!(await w.attention()).some((x) => x.dealId === deal.id), 'no steward item');
  }
  assert.equal((await f.request(null, 'GET', `/api/trade/members/${seller.address}`)).body.reputation.orderedRefundsDeclined, 0);
});
// Review of B2-1: an appeal overturn on a deal both parties cancelled after a steward decision.
async function decidedThenCancelled(w) {
  const { f, buyer, steward } = w;
  const deal = await w.paidDeal();
  const x = await w.dispute(buyer, deal);
  assert.equal((await w.decide(steward[0], x.body.dispute.id, 'redeliver', { policyClauses: ['P4-acceptance-criteria'] })).status, 200);
  assert.equal((await w.read(deal.id)).status, 'paid');
  const both = await cancelBoth(w, deal);
  assert.equal(both.body.deal.status, 'cancelled');
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${x.body.dispute.id}/appeal`, { clientRequestId: cid('ap'), reason: 'Nothing was ever delivered.' })).status, 200);
  return { deal, disputeId: x.body.dispute.id };
}
const overturn = (w, disputeId, outcome) => w.f.request(w.reviewer[0], 'POST', `/api/trade/appeals/${disputeId}/decision`, { clientRequestId: cid('ad'), result: 'overturned', outcome, reasons: 'Central review read both parties\' evidence against the terms.', policyClauses: ['P5-non-delivery'] });
test('B2-1 review: an appeal overturned to a full refund replaces the open mutual-cancel refund', async (t) => {
  const w = await world(t);
  const { deal, disputeId } = await decidedThenCancelled(w);
  const r = await overturn(w, disputeId, 'refund-full');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await w.read(deal.id);
  const bySource = Object.fromEntries(after.refunds.map((x) => [x.source, x]));
  assert.equal(bySource['mutual-cancel'].request.status, 'cancelled');
  assert.deepEqual([bySource['appeal-decision'].amount, bySource['appeal-decision'].request.status], ['2.500000', 'open']);
  assert.deepEqual([after.status, after.refundOwed], ['refunded', '2.500000']);
});
// Second review: an overturn that orders nothing back keeps the refund both parties agreed; the
// deal stays cancelled, so the agreed refund's deadline and refusal path still apply.
for (const outcome of ['no-refund', 'redeliver']) {
  test(`B2-1 review: an appeal overturned to ${outcome} keeps the agreed mutual-cancel refund`, async (t) => {
    const w = await world(t), { f, seller } = w;
    const { deal, disputeId } = await decidedThenCancelled(w);
    const r = await overturn(w, disputeId, outcome);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.decision.outcome, r.body.decision.effects], [outcome, []], 'the overturn is recorded and orders nothing');
    const after = await w.read(deal.id);
    assert.equal(after.status, 'cancelled');
    assert.deepEqual(after.refunds.map((x) => [x.source, x.binding ?? null, x.request.status]), [['mutual-cancel', true, 'open']]);
    assert.equal(after.refundOwed, '2.500000', 'never more than the price is owed');
    assert.equal(after.disputes.at(-1).outcome, outcome);
    // Trade leftover (d), 15 November 2026: while the agreed refund stands, the buyer lost nothing.
    const lost = async (who) => (await f.request(null, 'GET', `/api/trade/members/${who.address}`)).body.reputation.disputesLost;
    assert.deepEqual([await lost(w.buyer), await lost(seller)], [0, 0]);
    // The agreed refund still runs its course: declined, it is recorded and the deal reopens.
    assert.equal((await f.request(seller, 'POST', `/api/requests/${after.refunds[0].requestId}/decline`, {})).status, 200);
    await w.agreed();
    const reopened = await w.read(deal.id);
    assert.deepEqual([reopened.status, reopened.refunds[0].refusal], ['paid', 'declined']);
    // Refused, it no longer stands: a no-refund is then the buyer's loss, as before.
    assert.deepEqual([await lost(w.buyer), await lost(seller)], [outcome === 'no-refund' ? 1 : 0, 0]);
  });
}
// Third review: a deal whose price party refunds already returned in full, then cancelled, has no
// agreed refund; an overturn that orders nothing must not read it paid again.
test('B2-1 review: an overturn to no-refund keeps a deal cancelled after its whole price was refunded', async (t) => {
  const w = await world(t), { f, buyer, seller, steward } = w;
  const deal = await w.paidDeal();
  const x = await w.dispute(buyer, deal);
  assert.equal((await w.decide(steward[0], x.body.dispute.id, 'redeliver', { policyClauses: ['P4-acceptance-criteria'] })).status, 200);
  const offered = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2.5', reason: 'Refunding in full' });
  assert.equal(offered.status, 201);
  await w.markPaid(offered.body.refund.requestId);
  const both = await cancelBoth(w, deal);
  assert.deepEqual([both.body.deal.status, both.body.deal.refunds.length], ['cancelled', 1], 'nothing left to agree back');
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${x.body.dispute.id}/appeal`, { clientRequestId: cid('ap'), reason: 'Nothing was ever delivered.' })).status, 200);
  const r = await overturn(w, x.body.dispute.id, 'no-refund');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.decision.outcome, r.body.decision.effects], ['no-refund', []], 'the overturn is recorded and orders nothing');
  const after = await w.read(deal.id);
  assert.equal(after.status, 'cancelled', 'never paid with the whole price already returned');
  assert.equal(after.refunds.length, 1);
  assert.equal(after.disputes.at(-1).outcome, 'no-refund');
});
test('B2-1 review: consent to cancel given before an overturn does not carry over to the deal it returns to paid', async (t) => {
  const w = await world(t), { f, seller, buyer, steward } = w;
  const deal = await w.paidDeal();
  const x = await w.dispute(buyer, deal);
  assert.equal((await w.decide(steward[0], x.body.dispute.id, 'redeliver', { policyClauses: ['P4-acceptance-criteria'] })).status, 200);
  const asked = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Please cancel' });
  assert.deepEqual([asked.body.cancelled, asked.body.awaiting], [false, 'seller']);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${x.body.dispute.id}/appeal`, { clientRequestId: cid('ap'), reason: 'Nothing was ever delivered.' })).status, 200);
  assert.equal((await overturn(w, x.body.dispute.id, 'no-refund')).status, 200);
  assert.equal((await w.read(deal.id)).status, 'paid');
  const one = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'Cancel now' });
  assert.deepEqual([one.status, one.body.cancelled, one.body.awaiting], [200, false, 'buyer'], 'fresh consent from both is needed');
  assert.equal((await w.read(deal.id)).refunds.length, 0);
});
test('B2-1 review: an overturn to a full refund while the agreed refund is being paid answers refund_in_progress', async (t) => {
  const w = await world(t), { f, clock, seller, buyer } = w;
  const { deal, disputeId } = await decidedThenCancelled(w);
  const r1 = (await w.read(deal.id)).refunds[0];
  await f.edit((s) => { const id = 'e'.repeat(64); (s.serverSendIntents ??= {})[id] = { id, schema: 'baink-server-send-v1', intent: { requestId: r1.requestId, from: seller.address, to: buyer.address, amountUnits: '2500000', chainId: 'fictional', notAfter: new Date(clock.now + DAY).toISOString() }, status: 'awaiting-signature', attempts: [], recipientConfirmation: null, createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString() }; (s.serverSendRequestLocks ??= {})[r1.requestId] = id; });
  assert.deepEqual(code(await overturn(w, disputeId, 'refund-full')), [409, 'refund_in_progress']);
  const after = await w.read(deal.id);
  assert.deepEqual(after.refunds.map((x) => [x.source, x.request.status]), [['mutual-cancel', 'open']]);
});
// Review of B2-1 (older defect): a steward cancelled a deal whose payment landed but was never
// confirmed; a refused refund left it cancelled and the buyer stranded.
test('D1/D2: a refused refund on a landed, unconfirmed payment reopens the deal so the buyer can dispute', async (t) => {
  const w = await world(t), { f, clock, seller, buyer, steward } = w;
  const deal = await w.agreed();
  await w.land(deal);
  clock.now += 25 * HOUR;
  const opened = await w.dispute(buyer, deal, 'cancel');
  assert.equal((await w.decide(steward[0], opened.body.dispute.id, 'cancel-deal', { policyClauses: ['P8-cancel'] })).status, 200);
  const refund = (await w.read(deal.id)).refunds[0];
  assert.equal((await f.request(seller, 'POST', `/api/requests/${refund.requestId}/decline`, {})).status, 200);
  clock.now += 8 * DAY; // the appeal window closes
  await w.agreed();
  const after = await w.read(deal.id);
  assert.notEqual(after.status, 'cancelled');
  assert.equal(after.refunds[0].refusal, 'declined');
  assert.equal(after.payment.request.status, 'open', 'the landed payment still waits for the seller, never paid again');
  assert.equal((await w.dispute(buyer, after)).status, 201);
});
test('FE-4: a deal read from the server passes the browser digest check that enables Sign', async (t) => {
  const w = await world(t);
  const deal = await w.agreed();
  assert.equal(await verifyDealDigest(deal), true);
  assert.equal(await verifyDealDigest({ ...deal, terms: { ...deal.terms, scope: 'Changed after signing' } }), false);
});
test('B2-1: no mutual cancel while a party refund payment is going through', async (t) => {
  const w = await world(t), { f, clock, seller, buyer } = w;
  const deal = await w.paidDeal();
  const offered = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2.5', reason: 'Refunding in full' });
  // The seller's refund payment waits for its signature: a live server send holds the request.
  await f.edit((s) => { const id = 'd'.repeat(64); (s.serverSendIntents ??= {})[id] = { id, schema: 'baink-server-send-v1', intent: { requestId: offered.body.refund.requestId, from: seller.address, to: buyer.address, amountUnits: '2500000', chainId: 'fictional', notAfter: new Date(clock.now + DAY).toISOString() }, status: 'awaiting-signature', attempts: [], recipientConfirmation: null, createdAt: new Date(clock.now).toISOString(), updatedAt: new Date(clock.now).toISOString() }; (s.serverSendRequestLocks ??= {})[offered.body.refund.requestId] = id; });
  const both = await cancelBoth(w, deal);
  assert.deepEqual(code(both), [409, 'refund_in_progress']);
  assert.equal((await w.read(deal.id)).status, 'paid');
});
