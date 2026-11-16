// A deal payment that a no-install send already paid on the ledger (finalized, the seller has not
// confirmed yet) is paid: it does not expire, and the seller's later confirmation still records it
// (10 November 2026: request 88a374c3… stayed open after three finalized sends).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
import { tradeProposalDigest } from '../server/trade-payment.mjs';

let n = 0;
const cid = (label) => `${label}-${++n}-${Date.now()}`.slice(0, 90);
async function agreed(f, seller, buyer, window = 1) {
  const offer = (await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Fictional analysis service', description: 'A fictional deliverable for tests', price: '1', publish: true })).body.offer;
  const enquiry = (await f.request(buyer, 'POST', `/api/trade/offers/${offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: offer.revision })).body.enquiry;
  const draft = (await f.request(seller, 'POST', `/api/trade/enquiries/${enquiry.id}/terms`, { clientRequestId: cid('draft'), terms: { scope: 'Fictional scope', deliverables: 'Fictional report', price: '1', timeline: 'Two days', acceptanceCriteria: 'Covers the questions' } })).body.draft;
  const proposal = (await f.request(seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('send'), expectedRevision: 1, confirmNonbinding: true })).body.proposal;
  const deal = (await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: proposal.id, proposalDigest: tradeProposalDigest(proposal), confirmBindingDraft: true, paymentWindowHours: window })).body.deal;
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: deal.dealDigest, confirmBinding: true })).status, 200);
  return (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
}
const finalizedSend = (requestId, from, to) => ({ id: 'f'.repeat(64), schema: 'baink-server-send-v1', intent: { requestId, from, to, amountUnits: '1000000', chainId: 'fictional' }, status: 'finalized', attempts: [], result: { effects: 'e'.repeat(64), height: '10' }, recipientConfirmation: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

test('a deal paid on the ledger but not yet confirmed never expires; an unpaid one does', async (t) => {
  const clock = { now: Date.now() };
  const f = await fixture(t, { tradeDealSweep: false, now: () => clock.now });
  const seller = member(), buyer = member();
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 'Fictional trader' })).status, 201);
  const paid = await agreed(f, seller, buyer), unpaid = await agreed(f, seller, buyer);
  await f.edit((s) => { s.serverSendIntents = { [finalizedSend(paid.payment.request.id, buyer.address, seller.address).id]: finalizedSend(paid.payment.request.id, buyer.address, seller.address) }; });
  clock.now += 2 * 3_600_000; // past the one-hour payment window
  await agreed(f, seller, buyer); // any deal step runs the expiry sweep first
  const after = async (id) => (await f.request(null, 'GET', `/api/trade/deals/${id}`)).body.deal;
  assert.equal((await after(unpaid.id)).status, 'expired', 'an unpaid deal payment still expires');
  const kept = await after(paid.id);
  assert.equal(kept.status, 'agreed', 'paid on the ledger: not expired');
  assert.equal(kept.payment.request.status, 'open', 'it waits for the seller to confirm');
});
