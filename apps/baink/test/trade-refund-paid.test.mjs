// A paid refund is a public event and a deal shows what refund is still owed
// (production acceptance, 10 November 2026: only the request appeared, and a deal read
// "refunded" while the ordered refund was unpaid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
import { tradeProposalDigest } from '../server/trade-payment.mjs';

let n = 0;
const cid = (label) => `${label}-${++n}-${Date.now()}`.slice(0, 90);
const paid = (f, id) => f.edit((s) => { Object.assign(s.requests[id], { status: 'paid', updatedAt: new Date().toISOString(), settlement: { kind: 'native-server-send', effects: [], chainId: 'fictional', amountVerification: 'recipient-attested' } }); });

test('a paid refund appears in the deal timeline and the public feed; refundOwed counts only unpaid refunds', async (t) => {
  const f = await fixture(t, { tradeDealSweep: false });
  const seller = member(), buyer = member();
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 'Fictional trader' })).status, 201);
  const offer = (await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Fictional analysis service', description: 'A fictional deliverable for tests', price: '2', publish: true })).body.offer;
  const enquiry = (await f.request(buyer, 'POST', `/api/trade/offers/${offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: offer.revision })).body.enquiry;
  const draft = (await f.request(seller, 'POST', `/api/trade/enquiries/${enquiry.id}/terms`, { clientRequestId: cid('draft'), terms: { scope: 'Fictional scope', deliverables: 'Fictional report', price: '2', timeline: 'Two days', acceptanceCriteria: 'Covers the questions' } })).body.draft;
  const proposal = (await f.request(seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('send'), expectedRevision: 1, confirmNonbinding: true })).body.proposal;
  const deal = (await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: proposal.id, proposalDigest: tradeProposalDigest(proposal), confirmBindingDraft: true })).body.deal;
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: deal.dealDigest, confirmBinding: true })).status, 200);
  await paid(f, (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal.payment.request.id);
  const first = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('refund'), amount: '0.5', reason: 'Goodwill for a late draft' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.deal.refundOwed, '0.500000');
  await paid(f, first.body.refund.requestId);
  // The next step on the deal records the paid refund publicly.
  const second = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('refund'), amount: '0.25', reason: 'Second goodwill' });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.deal.refundOwed, '0.250000', 'only the unpaid refund is owed');
  const detail = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.ok(detail.timeline.some((e) => e.type === 'refund.paid' && e.actor === seller.address), JSON.stringify(detail.timeline.map((e) => e.type)));
  const feed = (await f.request(null, 'GET', `/api/trade/feed?type=refund.`)).body;
  assert.equal(feed.events.filter((e) => e.type === 'refund.paid' && e.dealId === deal.id).length, 1, 'recorded once');
});
