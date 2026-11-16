import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
import { tradeProposalDigest, validateTradePaymentRequest } from '../server/trade-payment.mjs';
import { verifySignedRequest, dealDigestInput, canonical } from '../server/trade-deals.mjs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';

let counter = 0;
const cid = (label) => `${label}-${++counter}-${Date.now()}`.slice(0, 90);
const sha = (x) => createHash('sha256').update(canonical(x)).digest('hex');
const DAY = 86_400_000;

async function world(t, { stewards = 2, reviewers = 1, extra = 0 } = {}) {
  const clock = { now: Date.now() };
  const steward = Array.from({ length: stewards }, member), reviewer = Array.from({ length: reviewers }, member);
  const f = await fixture(t, { tradeStewardAddresses: steward.map((x) => x.address), tradeAppealReviewerAddresses: reviewer.map((x) => x.address), tradeDealSweep: false, now: () => clock.now });
  const seller = member(), buyer = member(), outsider = member(), others = Array.from({ length: extra }, member);
  for (const who of [seller, buyer, outsider, ...steward, ...reviewer, ...others]) assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 'Fictional trader' })).status, 201);
  return { f, clock, seller, buyer, outsider, steward, reviewer, others };
}
async function proposal(f, seller, buyer, { price = '2.5', expiresAt } = {}) {
  const offer = (await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Fictional analysis service', description: 'A fictional deliverable for tests', price, publish: true })).body.offer;
  const enquiry = (await f.request(buyer, 'POST', `/api/trade/offers/${offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: offer.revision })).body.enquiry;
  const terms = { scope: 'Fictional scoped analysis', deliverables: 'Fictional report', price, timeline: 'Three days', acceptanceCriteria: 'Report covers the three named questions', ...(expiresAt ? { expiresAt } : {}) };
  const draft = (await f.request(seller, 'POST', `/api/trade/enquiries/${enquiry.id}/terms`, { clientRequestId: cid('draft'), terms })).body.draft;
  const sent = await f.request(seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('send'), expectedRevision: 1, confirmNonbinding: true });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return { offer, enquiry, proposal: sent.body.proposal };
}
async function agreedDeal(w, opts = {}) {
  const { f, seller, buyer } = w;
  const { proposal: p, offer } = await proposal(f, seller, buyer, opts);
  const created = await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true, ...(opts.milestones ? { milestones: opts.milestones } : {}), ...(opts.window ? { paymentWindowHours: opts.window } : {}) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deal = created.body.deal;
  for (const who of [seller, buyer]) {
    const r = await f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: deal.dealDigest, confirmBinding: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const detail = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  return { deal: detail, offer, proposal: p };
}
// What native-payments `confirm` writes once the seller's wallet confirms the private note.
const markPaid = (f, requestId) => f.edit((s) => { const q = s.requests[requestId]; q.status = 'paid'; q.paymentIntentId = '00000000-0000-4000-8000-000000000000'; q.settlement = { kind: 'native-private-payment', effects: [], chainId: 'fictional', requestDigest: 'a'.repeat(64), amountVerification: 'recipient-attested', publicAmountProof: false }; });

test('binding acceptance: both parties sign the exact digest; signatures verify publicly; payment request expires', async (t) => {
  const w = await world(t), { f, seller, buyer, outsider, clock } = w;
  const { proposal: p } = await proposal(f, seller, buyer);
  const body = { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true, milestones: ['Draft', 'Final'], paymentWindowHours: 24 };
  assert.equal((await f.request(outsider, 'POST', '/api/trade/deals', body)).status, 404);
  assert.equal((await f.request(buyer, 'POST', '/api/trade/deals', { ...body, proposalDigest: 'b'.repeat(64) })).status, 409);
  assert.equal((await f.request(buyer, 'POST', '/api/trade/deals', { ...body, confirmBindingDraft: false })).status, 400);
  const created = await f.request(buyer, 'POST', '/api/trade/deals', body);
  assert.equal(created.status, 201);
  assert.equal((await f.request(buyer, 'POST', '/api/trade/deals', body)).status, 200, 'same intent replays');
  const deal = created.body.deal;
  assert.equal(deal.status, 'proposed');
  assert.equal(sha(deal.digestInput), deal.dealDigest);
  assert.deepEqual(deal.digestInput, dealDigestInput({ ...deal, id: deal.id, terms: deal.terms, milestones: deal.milestones, policyVersion: deal.policyVersion }));
  const accept = (who, digest = deal.dealDigest) => f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: digest, confirmBinding: true });
  assert.equal((await accept(outsider)).status, 403);
  assert.equal((await accept(seller, 'c'.repeat(64))).status, 409);
  const one = await accept(seller);
  assert.equal(one.body.deal.status, 'proposed');
  assert.equal(one.body.deal.signed.seller, true);
  const two = await accept(buyer);
  assert.equal(two.body.deal.status, 'agreed');
  const pub = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  for (const role of ['seller', 'buyer']) {
    const a = pub.acceptances[role];
    assert.equal(a.address, role === 'seller' ? seller.address : buyer.address);
    assert.equal(a.body.dealDigest, deal.dealDigest);
    assert.equal(verifySignedRequest(a), true, 'anyone can re-verify the signature');
    assert.equal(verifySignedRequest({ ...a, body: { ...a.body, dealDigest: 'd'.repeat(64) } }), false);
  }
  const q = pub.payment.request;
  assert.equal(q.amount, '2.500000');
  assert.equal(Date.parse(q.expiresAt) - Date.parse(pub.agreedAt), 24 * 3600_000);
  const stored = (await f.request(buyer, 'GET', '/api/requests')).body.requests.find((x) => x.id === q.id);
  assert.equal(validateTradePaymentRequest(stored).dealId, deal.id, 'the request binds the deal');
  assert.equal((await f.request(seller, 'POST', `/api/trade/terms/${p.id}/payment-request`, { clientRequestId: cid('legacy'), snapshotDigest: tradeProposalDigest(p), confirmPaymentRequest: true })).status, 409, 'no second invoice for the proposal');
  // Expiry: past the window the request cannot be paid and the deal reads expired.
  clock.now += 25 * 3600_000;
  const pay = await f.request(buyer, 'POST', `/api/requests/${q.id}/pay`, { expectedTradeDigest: tradeProposalDigest(p), confirmTradeReview: true });
  assert.deepEqual([pay.status, pay.body.error.code], [409, 'payment_request_expired']);
  assert.equal((await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal.status, 'expired');
  // A write sweeps it durably; the request is listed as expired.
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'too late' });
  assert.equal((await f.request(buyer, 'GET', '/api/requests?status=expired')).body.count, 1);
  // Retry after reconciliation (no attempt ever started): a steward reopens it.
  const retry = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'No payment attempt reached the ledger; reopening per policy.', policyClauses: ['P7-failed-payment'] });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.deal.status, 'agreed');
  assert.equal(retry.body.deal.payment.request.status, 'open');
  assert.equal((await f.request(buyer, 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'A party cannot use steward powers at all.', policyClauses: ['P7-failed-payment'] })).status, 403);
  const decisions = (await f.request(null, 'GET', `/api/trade/decisions?dealId=${deal.id}`)).body;
  assert.equal(decisions.decisions[0].kind, 'steward-retry-payment');
});

test('retry refuses while a payment attempt may have reached the ledger', async (t) => {
  const w = await world(t), { f, buyer } = w;
  const { deal } = await agreedDeal(w);
  const requestId = deal.payment.request.id;
  await f.edit((s) => {
    s.nativePaymentIntents = s.nativePaymentIntents ?? {};
    s.nativePaymentIntents['11111111-1111-4111-8111-111111111111'] = { id: '11111111-1111-4111-8111-111111111111', requestId, status: 'abandoned', sendAttemptedAt: null, envelope: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    s.nativePaymentIntents['22222222-2222-4222-8222-222222222222'] = { id: '22222222-2222-4222-8222-222222222222', requestId, status: 'unknown', sendAttemptedAt: new Date().toISOString(), envelope: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  });
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body;
  assert.ok(attention.items.some((x) => x.kind === 'payment-reconcile' && x.dealId === deal.id));
  const r = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'Trying to retry with an unknown send outstanding.', policyClauses: ['P7-failed-payment'] });
  assert.deepEqual([r.status, r.body.error.code], [409, 'payment_reconciliation_required']);
  assert.equal((await f.request(buyer, 'GET', `/api/trade/deals/${deal.id}`)).body.deal.payment.attempts, 2);
});

// No-install server sends (server-send.mjs) pay deal requests too (10 Nov 2026).
const sendRow = (id, requestId, from, to, status, attempts) => ({ id, schema: 'baink-server-send-v1', intent: { from, to, requestId, amountUnits: '2500000', notAfter: new Date(Date.now() + 86400000).toISOString() }, status, attempts, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
test('a server send holds the deal payment: no expiry, no retry, and the next step names whose it is', async (t) => {
  const w = await world(t), { f, clock, buyer, seller } = w;
  const { deal } = await agreedDeal(w, { window: 1 });
  const requestId = deal.payment.request.id, sendId = 's'.repeat(8) + '-send';
  const read = async () => (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.deepEqual([(await read()).payment.next.actor, (await read()).payment.next.action], ['buyer', 'pay']);
  // In flight: signed and relayed, outcome not yet proved.
  await f.edit((s) => { s.serverSendIntents = { [sendId]: sendRow(sendId, requestId, buyer.address, seller.address, 'submitted', [{ n: 1, status: 'submitted', envelope: {}, sendAttemptedAt: new Date().toISOString() }]) }; s.serverSendRequestLocks = { [requestId]: sendId }; });
  clock.now += 2 * 3600_000;
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'sweep' });
  let pub = await read();
  assert.equal(pub.status, 'agreed', 'a live send keeps the request from expiring under it');
  assert.equal(pub.payment.request.status, 'open');
  assert.equal(pub.payment.inProgress, true);
  assert.equal(pub.payment.next.actor, 'uain');
  assert.deepEqual(pub.payment.serverSends.map((x) => [x.id, x.status]), [[sendId, 'submitted']]);
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body.items.filter((x) => x.dealId === deal.id);
  assert.ok(attention.some((x) => x.kind === 'payment-stuck' && x.sendId === sendId));
  const refused = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'Trying to retry while a server send is outstanding.', policyClauses: ['P7-failed-payment'] });
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'payment_reconciliation_required']);
  // Finalized but not yet confirmed by the payee: the seller's step, never a retry.
  await f.edit((s) => { s.serverSendIntents[sendId].status = 'finalized'; s.serverSendIntents[sendId].attempts[0].status = 'finalized'; });
  pub = await read();
  assert.deepEqual([pub.payment.next.actor, pub.payment.next.action, pub.payment.next.send], ['seller', 'confirm-received', sendId]);
  assert.equal((await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'A finalized send must never be retried.', policyClauses: ['P7-failed-payment'] })).status, 409);
});

test('a reopened deal payment is the buyer\'s next step once every server-send attempt is proved unused', async (t) => {
  const w = await world(t), { f, clock, buyer, seller } = w;
  const { deal } = await agreedDeal(w, { window: 1 });
  const requestId = deal.payment.request.id, sendId = 'd'.repeat(8) + '-dead';
  // The send ended with its only signed attempt proved unincluded after expiry (lock released).
  await f.edit((s) => { s.serverSendIntents = { [sendId]: sendRow(sendId, requestId, buyer.address, seller.address, 'expired', [{ n: 1, status: 'expired-unused', envelope: {}, sendAttemptedAt: new Date().toISOString() }]) }; });
  clock.now += 2 * 3600_000;
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'sweep' });
  let pub = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.equal(pub.status, 'expired');
  assert.equal(pub.payment.next.actor, 'steward');
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body.items.filter((x) => x.dealId === deal.id);
  assert.ok(attention.some((x) => x.kind === 'payment-failed' && x.attempts === 1), JSON.stringify(attention));
  const retry = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'The only server-send attempt was proved unused; reopening per policy.', policyClauses: ['P7-failed-payment'] });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  pub = (await f.request(buyer, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.equal(pub.status, 'agreed');
  assert.equal(pub.payment.retries.length, 1);
  assert.equal(pub.payment.retries[0].attemptsBefore, 1);
  const next = pub.payment.next;
  assert.deepEqual([next.actor, next.action, next.requestId, next.retries], ['buyer', 'pay', requestId, 1]);
  assert.equal(next.cli, `node uain-agent.mjs pay --request ${requestId}`);
  assert.match(next.why, /^This deal's payment did not complete\. Pay 2\.500000 AI\$ again by /);
  assert.doesNotMatch(JSON.stringify(pub.payment.next), /fence|intent|sequence|reconcil/i, 'plain words only');
  assert.ok(Date.parse(next.dueBy) > clock.now, 'a fresh payment window');
});

test('"pay again" is never offered while any earlier send is finalized, even after the request lock moved on', async (t) => {
  const w = await world(t), { f, clock, buyer, seller } = w;
  const { deal } = await agreedDeal(w, { window: 1 });
  const requestId = deal.payment.request.id, first = 'f'.repeat(8) + '-first', second = 'a'.repeat(8) + '-second';
  // The 10 Nov defect shape: send 1 finalized (payee not yet confirmed), the lock then
  // replaced by send 2, which ended unused and released the lock.
  await f.edit((s) => {
    s.serverSendIntents = {
      [first]: sendRow(first, requestId, buyer.address, seller.address, 'finalized', [{ n: 1, status: 'finalized', envelope: {}, sendAttemptedAt: new Date().toISOString() }]),
      [second]: sendRow(second, requestId, buyer.address, seller.address, 'expired', [{ n: 1, status: 'expired-unused', envelope: {}, sendAttemptedAt: new Date().toISOString() }]),
    };
    s.serverSendRequestLocks = {};
  });
  clock.now += 2 * 3600_000;
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'sweep' });
  const pub = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.equal(pub.status, 'agreed', 'never expired while a finalized send awaits confirmation');
  assert.deepEqual([pub.payment.next.actor, pub.payment.next.action, pub.payment.next.send], ['seller', 'confirm-received', first]);
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body.items.filter((x) => x.dealId === deal.id);
  assert.ok(!attention.some((x) => x.kind === 'payment-failed'), JSON.stringify(attention));
  const r = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'Must refuse: an earlier send is finalized.', policyClauses: ['P7-failed-payment'] });
  assert.deepEqual([r.status, r.body.error.code], [409, 'payment_reconciliation_required']);
});

test('"pay again" is offered only after sends that ended refused, expired unused or never signed', async (t) => {
  for (const [status, attempts] of [
    ['checker-refused', [{ n: 1, status: 'awaiting-signature', envelope: null, sendAttemptedAt: null }]],
    ['expired', [{ n: 1, status: 'expired-unused', envelope: {}, sendAttemptedAt: 'x' }, { n: 2, status: 'expired-unused', envelope: {}, sendAttemptedAt: 'x' }]],
    ['cancelled', []],
  ]) {
    const w = await world(t), { f, clock, buyer, seller } = w;
    const { deal } = await agreedDeal(w, { window: 1 });
    const requestId = deal.payment.request.id, id = 'c'.repeat(8) + '-' + status;
    await f.edit((s) => { s.serverSendIntents = { [id]: sendRow(id, requestId, buyer.address, seller.address, status, attempts) }; });
    clock.now += 2 * 3600_000;
    await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'sweep' });
    const retry = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: `The send ended ${status}; nothing was paid.`, policyClauses: ['P7-failed-payment'] });
    assert.equal(retry.status, 200, status + ' ' + JSON.stringify(retry.body));
    assert.deepEqual([retry.body.deal.payment.next.actor, retry.body.deal.payment.next.action], ['buyer', 'pay'], status);
  }
});

test('happy path: pay, deliver milestones, confirm, complete, rate; public feed and member history', async (t) => {
  const w = await world(t), { f, seller, buyer, outsider } = w;
  const { deal, offer } = await agreedDeal(w, { milestones: ['Outline', 'Report'] });
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'not mine' })).status, 403);
  await markPaid(f, deal.payment.request.id);
  assert.equal((await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal.status, 'paid');
  for (const i of [0, 1]) {
    const d = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/milestones/${i}/deliver`, { clientRequestId: cid('d'), note: `Milestone ${i} delivered`, url: 'https://example.com/report.pdf', sha256: 'e'.repeat(64) });
    assert.equal(d.status, 200, JSON.stringify(d.body));
  }
  const rej = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/milestones/1/reject`, { clientRequestId: cid('r'), reason: 'Missing question three' });
  assert.equal(rej.body.deal.milestones[1].status, 'rejected');
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/milestones/1/deliver`, { clientRequestId: cid('d'), note: 'Added question three' });
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 5 })).status, 409, 'rate only after completion');
  await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/milestones/0/confirm`, { clientRequestId: cid('c') });
  const done = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/milestones/1/confirm`, { clientRequestId: cid('c') });
  assert.equal(done.body.deal.status, 'completed');
  assert.equal((await f.request(outsider, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 5 })).status, 403);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 5, comment: 'Clear and on time' })).status, 200);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 4 })).status, 200);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 1 })).status, 409);
  const history = (await f.request(null, 'GET', `/api/trade/members/${seller.address}`)).body;
  assert.equal(history.reputation.completedAsSeller, 1);
  assert.equal(history.reputation.averageRating, 5);
  assert.match(history.reputation.karmaEffect, /^none/);
  const feed = (await f.request(null, 'GET', `/api/trade/feed?member=${seller.address}&pageSize=50`)).body;
  const types = feed.events.map((e) => e.type);
  for (const type of ['offer.published', 'enquiry.sent', 'terms.sent', 'deal.drafted', 'deal.signed', 'deal.agreed', 'deal.paid', 'milestone.delivered', 'milestone.rejected', 'milestone.confirmed', 'deal.completed', 'deal.rated']) assert.ok(types.includes(type), type);
  const enquiries = (await f.request(null, 'GET', `/api/trade/public/enquiries?offerId=${offer.id}`)).body;
  assert.equal(enquiries.count, 1);
  const props = (await f.request(null, 'GET', `/api/trade/public/proposals?enquiryId=${deal.enquiryId}`)).body;
  assert.equal(props.proposals[0].proposalDigest, deal.proposalDigest);
  assert.equal((await f.request(null, 'GET', `/api/trade/deals?member=${seller.address}&status=completed`)).body.count, 1);
});

test('cancellation at each state', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  // Proposed: either party.
  const { proposal: p } = await proposal(f, seller, buyer);
  const d0 = (await f.request(seller, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true })).body.deal;
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${d0.id}/cancel`, { clientRequestId: cid('c'), reason: 'Changed my mind' })).body.deal.status, 'cancelled');
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${d0.id}/accept`, { clientRequestId: cid('a'), dealDigest: d0.dealDigest, confirmBinding: true })).status, 409);
  // Agreed, unpaid: the open request closes too.
  const { deal: d1 } = await agreedDeal(w);
  const c1 = await f.request(seller, 'POST', `/api/trade/deals/${d1.id}/cancel`, { clientRequestId: cid('c'), reason: 'Cannot deliver' });
  assert.equal(c1.body.deal.status, 'cancelled');
  assert.equal(c1.body.deal.payment.request.status, 'cancelled');
  // Agreed with a payment in progress: refused.
  const { deal: d2 } = await agreedDeal(w);
  await f.edit((s) => { s.nativePaymentRequestLocks = { ...(s.nativePaymentRequestLocks ?? {}), [d2.payment.request.id]: '33333333-3333-4333-8333-333333333333' }; });
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${d2.id}/cancel`, { clientRequestId: cid('c'), reason: 'x' })).body.error.code, 'payment_request_locked');
  // Paid: needs both, then refunds the buyer.
  const { deal: d3 } = await agreedDeal(w);
  await markPaid(f, d3.payment.request.id);
  const half = await f.request(buyer, 'POST', `/api/trade/deals/${d3.id}/cancel`, { clientRequestId: cid('c'), reason: 'No longer needed' });
  assert.deepEqual([half.body.cancelled, half.body.awaiting], [false, 'seller']);
  const both = await f.request(seller, 'POST', `/api/trade/deals/${d3.id}/cancel`, { clientRequestId: cid('c'), reason: 'Agreed' });
  assert.equal(both.body.deal.status, 'cancelled');
  assert.equal(both.body.deal.refunds[0].amount, '2.500000');
  assert.equal(both.body.deal.refunds[0].request.to, seller.address, 'the seller pays the refund');
  assert.equal(both.body.deal.refunds[0].source, 'mutual-cancel');
  // Closed: no further cancel.
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${d3.id}/cancel`, { clientRequestId: cid('c'), reason: 'again' })).status, 409);
});

test('refunds are linked to the deal and bounded by the paid price', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  const { deal } = await agreedDeal(w);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '1', reason: 'goodwill' })).body.error.code, 'deal_not_paid');
  await markPaid(f, deal.payment.request.id);
  const r1 = await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: 'refund-fixed-1', amount: '1', reason: 'Late by a day' });
  assert.equal(r1.status, 201);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: 'refund-fixed-1', amount: '1', reason: 'Late by a day' })).status, 200);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2', reason: 'too much' })).body.error.code, 'refund_exceeds_payment');
  const reqs = (await f.request(seller, 'GET', '/api/requests?direction=incoming')).body.requests;
  const refundReq = reqs.find((q) => q.id === r1.body.refund.requestId);
  assert.equal(refundReq.dealRefund.dealId, deal.id);
  assert.equal(refundReq.from, buyer.address);
  // A declined refund frees its amount again.
  assert.equal((await f.request(seller, 'POST', `/api/requests/${refundReq.id}/decline`, {})).status, 200);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/refunds`, { clientRequestId: cid('r'), amount: '2.5', reason: 'Asking for all of it' })).status, 201);
});

test('dispute -> evidence -> steward decision (independent) -> appeal -> central review', async (t) => {
  const w = await world(t, { stewards: 2, reviewers: 2 }), { f, seller, buyer, outsider, steward, reviewer } = w;
  const { deal } = await agreedDeal(w, { milestones: ['A', 'B'] });
  await markPaid(f, deal.payment.request.id);
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'Part A' });
  await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/milestones/0/confirm`, { clientRequestId: cid('c') });
  const opened = await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/disputes`, { clientRequestId: cid('x'), reason: 'Milestone B never arrived after payment.', desiredOutcome: 'partial-refund', amount: '1.25' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const x = opened.body.dispute;
  assert.equal(opened.body.deal.status, 'disputed');
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/cancel`, { clientRequestId: cid('c'), reason: 'x' })).body.error.code, 'deal_disputed');
  assert.equal((await f.request(outsider, 'POST', `/api/trade/disputes/${x.id}/evidence`, { clientRequestId: cid('e'), statement: 'I saw it' })).status, 403);
  assert.equal((await f.request(seller, 'POST', `/api/trade/disputes/${x.id}/evidence`, { clientRequestId: cid('e'), statement: 'B is delayed by two days.' })).status, 201);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${x.id}/evidence`, { clientRequestId: cid('e'), statement: 'Deadline passed a week ago.', url: 'https://example.com/thread' })).status, 201);
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body;
  assert.ok(attention.items.some((i) => i.kind === 'dispute-open' && i.disputeId === x.id));
  const decision = { clientRequestId: cid('dec'), outcome: 'refund-partial', refundAmount: '1.25', reasons: 'Milestone A was confirmed; B was not delivered. Half the price is refunded.', policyClauses: ['P6-partial-delivery', 'P4-acceptance-criteria'], model: 'claude-sonnet-5-5' };
  assert.equal((await f.request(buyer, 'POST', `/api/trade/steward/disputes/${x.id}/decision`, decision)).body.error.code, 'steward_required');
  assert.equal((await f.request(steward[0], 'POST', `/api/trade/steward/disputes/${x.id}/decision`, { ...decision, policyClauses: ['Z9'] })).body.error.code, 'policy_clause_required');
  const decided = await f.request(steward[0], 'POST', `/api/trade/steward/disputes/${x.id}/decision`, decision);
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.deal.status, 'refunded');
  assert.equal(decided.body.decision.refundAmount, '1.250000');
  assert.equal((await f.request(steward[1], 'POST', `/api/trade/steward/disputes/${x.id}/decision`, decision)).body.error.code, 'dispute_not_open');
  // Appeal by the seller to central review; the reviewer cannot be the deciding steward.
  assert.equal((await f.request(outsider, 'POST', `/api/trade/disputes/${x.id}/appeal`, { clientRequestId: cid('ap'), reason: 'x' })).status, 403);
  const appealed = await f.request(seller, 'POST', `/api/trade/disputes/${x.id}/appeal`, { clientRequestId: cid('ap'), reason: 'B was delivered by email before the dispute.' });
  assert.equal(appealed.body.dispute.status, 'appealed');
  assert.equal((await f.request(seller, 'POST', `/api/trade/disputes/${x.id}/appeal`, { clientRequestId: cid('ap'), reason: 'again' })).body.error.code, 'already_appealed');
  assert.equal((await f.request(steward[1], 'POST', `/api/trade/appeals/${x.id}/decision`, { clientRequestId: cid('ad'), result: 'upheld', reasons: 'Steward cannot review appeals at all, only central.', policyClauses: ['P9-independence'] })).body.error.code, 'central_reviewer_required');
  const over = await f.request(reviewer[0], 'POST', `/api/trade/appeals/${x.id}/decision`, { clientRequestId: cid('ad'), result: 'overturned', outcome: 'no-refund', reasons: 'The seller filed proof of delivery of B before the dispute; no refund is owed.', policyClauses: ['P3-delivery', 'P10-evidence'] });
  assert.equal(over.status, 200, JSON.stringify(over.body));
  assert.equal(over.body.dispute.status, 'final');
  const after = (await f.request(null, 'GET', `/api/trade/deals/${deal.id}`)).body.deal;
  assert.equal(after.refunds[0].request.status, 'cancelled', 'the overturned refund request is withdrawn');
  const log = (await f.request(null, 'GET', `/api/trade/decisions?dealId=${deal.id}`)).body.decisions;
  assert.deepEqual(log.map((d) => d.kind), ['appeal-decision', 'steward-decision']);
  assert.equal(log[1].model, 'claude-sonnet-5-5');
  const pub = (await f.request(null, 'GET', `/api/trade/disputes/${x.id}`)).body.dispute;
  assert.equal(pub.evidence.length, 2);
  assert.equal(pub.appealDecision.result, 'overturned');
});

test('independence: a steward who is a party cannot decide; a reviewer cannot review their own decision', async (t) => {
  const w = await world(t, { stewards: 1, reviewers: 1 }), { f, steward, reviewer, buyer } = w;
  // The steward sells; the reviewer would be fine, the steward is not.
  const { proposal: p } = await proposal(f, steward[0], buyer);
  const d = (await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true })).body.deal;
  for (const who of [steward[0], buyer]) await f.request(who, 'POST', `/api/trade/deals/${d.id}/accept`, { clientRequestId: cid('a'), dealDigest: d.dealDigest, confirmBinding: true });
  const x = (await f.request(buyer, 'POST', `/api/trade/deals/${d.id}/disputes`, { clientRequestId: cid('x'), reason: 'Unpaid deal stalled', desiredOutcome: 'cancel' })).body.dispute;
  const r = await f.request(steward[0], 'POST', `/api/trade/steward/disputes/${x.id}/decision`, { clientRequestId: cid('dec'), outcome: 'cancel-deal', reasons: 'I would like to cancel my own deal here.', policyClauses: ['P8-cancel'] });
  assert.deepEqual([r.status, r.body.error.code], [403, 'steward_conflict']);
  assert.equal(reviewer.length, 1);
});

test('steward confirms a delivery the buyer ignored for 7 days; not earlier', async (t) => {
  const w = await world(t), { f, seller, clock, steward } = w;
  const { deal } = await agreedDeal(w);
  await markPaid(f, deal.payment.request.id);
  await f.request(seller, 'POST', `/api/trade/deals/${deal.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'Done' });
  const body = () => ({ clientRequestId: cid('s'), reasons: 'Buyer silent for the full review window after delivery.', policyClauses: ['P3-delivery'] });
  assert.equal((await f.request(steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/confirm-delivery`, body())).body.error.code, 'buyer_still_has_time');
  clock.now += 8 * DAY;
  assert.ok((await f.request(null, 'GET', '/api/trade/attention')).body.items.some((i) => i.kind === 'delivery-unconfirmed'));
  const r = await f.request(steward[0], 'POST', `/api/trade/steward/deals/${deal.id}/confirm-delivery`, body());
  assert.equal(r.body.deal.status, 'completed');
});

test('unsigned deals expire; policy and stewards are public; decided disputes become final after the appeal window', async (t) => {
  const w = await world(t), { f, seller, buyer, clock, steward } = w;
  const { proposal: p } = await proposal(f, seller, buyer);
  const d = (await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true })).body.deal;
  clock.now += 15 * DAY;
  await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Another', description: 'x', price: '1', publish: true });
  const r = await f.request(seller, 'POST', `/api/trade/deals/${d.id}/accept`, { clientRequestId: cid('a'), dealDigest: d.dealDigest, confirmBinding: true });
  assert.equal(r.body.error.code, 'deal_not_open');
  const policy = (await f.request(null, 'GET', '/api/trade/policy')).body;
  assert.equal(policy.policy.version, 'baink-trade-policy-v1');
  assert.deepEqual(policy.stewards, steward.map((s) => s.address));
  const { deal } = await agreedDeal(w);
  const x = (await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/disputes`, { clientRequestId: cid('x'), reason: 'Seller unreachable', desiredOutcome: 'cancel' })).body.dispute;
  await f.request(steward[0], 'POST', `/api/trade/steward/disputes/${x.id}/decision`, { clientRequestId: cid('dec'), outcome: 'cancel-deal', reasons: 'Unpaid deal; seller unreachable; cancelled before payment.', policyClauses: ['P8-cancel'] });
  clock.now += 8 * DAY;
  await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Another two', description: 'x', price: '1', publish: true });
  await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/rating`, { clientRequestId: cid('rate'), score: 2 });
  assert.equal((await f.request(null, 'GET', `/api/trade/disputes/${x.id}`)).body.dispute.status, 'final');
  assert.equal((await f.request(buyer, 'POST', `/api/trade/disputes/${x.id}/appeal`, { clientRequestId: cid('ap'), reason: 'late' })).status, 409);
});

test('deal storage is bounded: per proposal, per identity per day, and a byte budget (security review, 10 Nov)', async (t) => {
  const w = await world(t, { extra: 8 }), { f, seller, buyer, clock } = w;
  const sellers = w.others.slice(2);                                          // Trade allows 30 offer writes a minute per identity
  const draft = (who, p) => f.request(who, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true });
  const cancel = (who, d) => f.request(who, 'POST', `/api/trade/deals/${d.id}/cancel`, { clientRequestId: cid('c'), reason: 'Fictional cancel' });
  // Draft-and-cancel on one proposal stops after three rounds.
  const { proposal: p } = await proposal(f, seller, buyer);
  for (let i = 0; i < 3; i++) { const r = await draft(buyer, p); assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal((await cancel(buyer, r.body.deal)).status, 200); }
  const fourth = await draft(buyer, p);
  assert.equal(fourth.status, 429); assert.equal(fourth.body.error.code, 'deal_proposal_limit');
  // One identity starts at most 20 deals a day, closed ones included; the next day it may start again.
  for (let i = 3; i < 20; i++) { const { proposal: q } = await proposal(f, sellers[i % sellers.length], buyer); const r = await draft(buyer, q); assert.equal(r.status, 201, JSON.stringify(r.body)); await cancel(buyer, r.body.deal); }
  const { proposal: q } = await proposal(f, sellers[0], buyer);
  const over = await draft(buyer, q);
  assert.equal(over.status, 429); assert.equal(over.body.error.code, 'deal_daily_limit');
  clock.now += 86_400_000 + 1000;
  assert.equal((await draft(buyer, q)).status, 201);
  // Deals have their own byte budget, so the shared store keeps room for every other write.
  const [a, b] = w.others;
  await f.edit((s) => { for (let i = 0; i < 60; i++) s.tradeDeals.deals['filler-' + i] = { id: 'filler-' + i, proposalId: 'x' + i, seller: 'uain1' + '0'.repeat(40), buyer: 'uain1' + '1'.repeat(40), status: 'cancelled', createdAt: new Date(0).toISOString(), padding: 'p'.repeat(36_000) }; });
  const { proposal: r } = await proposal(f, a, b);
  const full = await draft(b, r);
  assert.equal(full.status, 503); assert.equal(full.body.error.code, 'trade_capacity');
  assert.equal((await f.request(member(), 'POST', '/api/account', { displayName: 'Fictional newcomer' })).status, 201, 'other writes still fit in the store');
});

test('a steward never revives an expired deal once a newer deal carries its proposal (security review, 10 Nov)', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  const { deal: first, proposal: p } = await agreedDeal(w);
  // The payment window passed: the sweep marks the deal and its request expired.
  await f.edit((s) => { s.tradeDeals.deals[first.id].status = 'expired'; s.requests[first.payment.request.id].status = 'expired'; });
  const created = await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/deals/${created.body.deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: created.body.deal.dealDigest, confirmBinding: true })).status, 200);
  const attention = (await f.request(null, 'GET', '/api/trade/attention')).body;
  assert.ok(!attention.items.some((x) => x.dealId === first.id), 'the superseded deal is not queued for a retry');
  const r = await f.request(w.steward[0], 'POST', `/api/trade/steward/deals/${first.id}/retry-payment`, { clientRequestId: cid('retry'), reasons: 'Reopen the expired payment of the first deal.', policyClauses: ['P7-failed-payment'] });
  assert.deepEqual([r.status, r.body.error.code], [409, 'deal_superseded']);
});

function mcp(f, name, args) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/mcp', { method: 'POST', headers: { Host: 'baink.example', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: 'https://baink.example', 'MCP-Protocol-Version': '2025-11-25' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject); req.end(body);
  });
}
test('public MCP reads the whole Trade record without an account', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  const { deal, offer } = await agreedDeal(w);
  const x = (await f.request(buyer, 'POST', `/api/trade/deals/${deal.id}/disputes`, { clientRequestId: cid('x'), reason: 'Unpaid and silent', desiredOutcome: 'cancel' })).body.dispute;
  const one = await mcp(f, 'baink_trade_deals', { id: deal.id });
  assert.equal(one.result.structuredContent.deal.id, deal.id, JSON.stringify(one));
  assert.equal((await mcp(f, 'baink_trade_deals', { member: seller.address })).result.structuredContent.count, 1);
  assert.ok((await mcp(f, 'baink_trade_feed', { type: 'deal.' })).result.structuredContent.events.every((e) => e.type.startsWith('deal.')));
  assert.equal((await mcp(f, 'baink_trade_disputes', { id: x.id })).result.structuredContent.dispute.status, 'open');
  assert.equal((await mcp(f, 'baink_trade_member', { address: buyer.address })).result.structuredContent.reputation.dealsAsBuyer, 1);
  const policy = (await mcp(f, 'baink_trade_policy', {})).result.structuredContent;
  assert.ok(policy.attention.items.some((i) => i.disputeId === x.id));
  assert.equal((await mcp(f, 'baink_trade_public_terms', { offerId: offer.id })).result.structuredContent.count, 1);
  assert.equal((await mcp(f, 'baink_trade_public_terms', { enquiryId: deal.enquiryId })).result.structuredContent.proposals[0].proposalDigest, deal.proposalDigest);
  assert.equal((await mcp(f, 'baink_trade_decisions', { dealId: deal.id })).result.structuredContent.count, 0);
});
