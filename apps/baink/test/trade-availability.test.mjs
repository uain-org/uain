// Trade paused for new business (P0-4, 12 November 2026; Rahul's ruling of 11 November).
// One server-owned capability (server/trade-availability.mjs) decides every Trade write.
// These tests cross every operation with both modes and every deal state with every step,
// through the real HTTP server, the remote MCP and the kit, and show that switching back
// to open restores every operation. The existing Trade suites run in open mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, member, signed, audience } from './http-fixture.mjs';
import { tradeProposalDigest } from '../server/trade-payment.mjs';
import { createTradeAvailability, resolveTradeMode, TRADE_OPERATIONS } from '../server/trade-availability.mjs';
import { createBainkServer } from '../server/app.mjs';
import * as kit from '../agent-kit/uain-agent.mjs';

let counter = 0;
const cid = (label) => `${label}-${++counter}-${Date.now()}`.slice(0, 90);
const DAY = 86_400_000;
const NEW_BUSINESS = ['offer.create', 'offer.update', 'enquiry.create', 'terms.create', 'terms.update', 'terms.send', 'terms.payment-request', 'deal.create'];

test('the setting: only the exact word "open" opens Trade; missing, empty or unknown is paused', () => {
  assert.deepEqual(resolveTradeMode(undefined), { mode: 'paused', setting: 'default' });
  assert.deepEqual(resolveTradeMode(''), { mode: 'paused', setting: 'default' });
  assert.deepEqual(resolveTradeMode('OPEN'), { mode: 'paused', setting: 'invalid' });
  assert.deepEqual(resolveTradeMode('on'), { mode: 'paused', setting: 'invalid' });
  assert.deepEqual(resolveTradeMode('open'), { mode: 'open', setting: 'set' });
  assert.deepEqual(resolveTradeMode('paused'), { mode: 'paused', setting: 'set' });
  assert.equal(createTradeAvailability().paused, true);
  assert.equal(createTradeAvailability({ mode: 'typo' }).view().settingInvalid, true);
  assert.throws(() => createTradeAvailability({ mode: 'open' }).decide('offer.delete'), TypeError, 'an unknown operation is never allowed by default');
});

test('every operation under both modes, and every deal state for signing', () => {
  const open = createTradeAvailability({ mode: 'open' }), paused = createTradeAvailability({ mode: 'paused' });
  const termsRequest = { trade: { schema: 'baink-trade-payment-v1' } }, dealRequest = { trade: { schema: 'baink-trade-deal-payment-v1' } };
  for (const op of TRADE_OPERATIONS) {
    assert.equal(open.decide(op, { deal: { status: 'proposed' }, request: termsRequest }).allowed, true, `open allows ${op}`);
    const d = paused.decide(op, { deal: { status: 'agreed' }, request: dealRequest });
    assert.equal(d.allowed, !NEW_BUSINESS.includes(op), `paused ${op}`);
    if (!d.allowed) {
      assert.equal(d.code, 'trade_paused');
      assert.match(d.message, /^Trade is paused for new business, so .+\. Nothing was created or charged\.$/);
      assert.match(d.next, /Do not send this step again\.$/);
    }
  }
  for (const status of ['proposed', 'agreed', 'paid', 'completed', 'cancelled', 'expired', 'refunded', 'disputed'])
    assert.equal(paused.decide('deal.accept', { deal: { status } }).allowed, status !== 'proposed', status);
  for (const op of ['request.pay', 'payment.start']) {
    assert.equal(paused.decide(op, { request: termsRequest }).allowed, false);
    assert.equal(paused.decide(op, { request: dealRequest }).allowed, true);
    assert.equal(paused.decide(op, { request: { id: 'ordinary' } }).allowed, true);
    assert.equal(paused.decide(op, { request: { dealRefund: { dealId: 'x' } } }).allowed, true, 'refund requests carry no trade field');
  }
  assert.deepEqual(paused.view().refused, NEW_BUSINESS);
  assert.equal(open.view().newBusiness, true);
  assert.equal(open.view().refused, undefined);
});

// A Trade world built while Trade is open: one deal in each state a member can still act on.
async function world(t) {
  const clock = { now: Date.now() };
  const steward = member(), reviewer = member();
  const f = await fixture(t, { tradeMode: 'open', tradeStewardAddresses: [steward.address], tradeAppealReviewerAddresses: [reviewer.address], tradeDealSweep: false, now: () => clock.now });
  const seller = member(), buyer = member();
  for (const who of [seller, buyer, steward, reviewer]) assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 'Fictional trader' })).status, 201);
  const w = { f, clock, seller, buyer, steward, reviewer };
  w.offer = (await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'Fictional analysis service', description: 'A fictional deliverable for tests', price: '2', publish: true })).body.offer;
  w.enquire = async () => (await f.request(buyer, 'POST', `/api/trade/offers/${w.offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: w.offer.revision })).body.enquiry;
  w.terms = { scope: 'Fictional scoped analysis', deliverables: 'Fictional report', price: '2', timeline: 'Three days', acceptanceCriteria: 'Report covers the questions' };
  w.draft = async (enquiry) => (await f.request(seller, 'POST', `/api/trade/enquiries/${enquiry.id}/terms`, { clientRequestId: cid('draft'), terms: w.terms })).body.draft;
  w.proposal = async () => {
    const draft = await w.draft(await w.enquire());
    const sent = await f.request(seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('send'), expectedRevision: 1, confirmNonbinding: true });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    return sent.body.proposal;
  };
  w.createDeal = async (p) => {
    const r = await f.request(buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: p.id, proposalDigest: tradeProposalDigest(p), confirmBindingDraft: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.deal;
  };
  w.accept = (who, deal) => f.request(who, 'POST', `/api/trade/deals/${deal.id}/accept`, { clientRequestId: cid('accept'), dealDigest: deal.dealDigest, confirmBinding: true });
  w.agreed = async () => {
    const deal = await w.createDeal(await w.proposal());
    for (const who of [seller, buyer]) assert.equal((await w.accept(who, deal)).status, 200);
    return w.read(deal.id);
  };
  w.read = async (id) => (await f.request(null, 'GET', `/api/trade/deals/${id}`)).body.deal;
  // What native-payments confirm writes once the recipient's wallet confirms the note.
  w.markPaid = (requestId) => f.edit((s) => { const q = s.requests[requestId]; q.status = 'paid'; q.paymentIntentId = '00000000-0000-4000-8000-000000000000'; q.settlement = { kind: 'native-private-payment', effects: [], chainId: 'fictional', requestDigest: 'a'.repeat(64), amountVerification: 'recipient-attested', publicAmountProof: false }; });
  w.counts = async () => {
    const s = (await f.request(null, 'GET', '/api/trade/feed?pageSize=50')).body;
    const deals = (await f.request(null, 'GET', '/api/trade/deals?pageSize=50')).body.count;
    const offers = (await f.request(null, 'GET', '/api/trade/offers')).body.count;
    const requests = (await f.request(buyer, 'GET', '/api/requests')).body.count + (await f.request(seller, 'GET', '/api/requests?direction=outgoing')).body.count;
    return { deals, offers, requests, feed: s.count };
  };
  return w;
}

test('paused: every new-business write is refused with one sentence and a next step; retries stay refused and create nothing; existing deals finish', async (t) => {
  const w = await world(t), { f, clock, seller, buyer, steward, reviewer } = w;
  // Before the pause: an unsent draft, a sent proposal, a terms payment request, and deals in each state.
  const enquiryForDraft = await w.enquire();
  const draft = await w.draft(enquiryForDraft);
  const looseProposal = await w.proposal();
  const termsProposal = await w.proposal();
  const tpr = await f.request(seller, 'POST', `/api/trade/terms/${termsProposal.id}/payment-request`, { clientRequestId: cid('tpr'), snapshotDigest: tradeProposalDigest(termsProposal), confirmPaymentRequest: true });
  assert.equal(tpr.status, 201, JSON.stringify(tpr.body));
  const proposed = await w.createDeal(await w.proposal());
  assert.equal((await w.accept(seller, proposed)).status, 200, 'one party signed before the pause');
  const agreed = await w.agreed();
  const toPay = await w.agreed();
  const paid = await w.agreed();
  await w.markPaid(paid.payment.request.id);
  const disputed = await w.agreed();
  await w.markPaid(disputed.payment.request.id);
  const refunding = await w.agreed();
  await w.markPaid(refunding.payment.request.id);
  const ordinary = await f.request(seller, 'POST', '/api/requests', { to: buyer.address, amount: '1', clientRequestId: cid('plain') });
  assert.equal(ordinary.status, 201);
  // Pay this deal in full only after the pause: its payment request stays payable.
  assert.equal((await w.read(toPay.id)).status, 'agreed');

  await f.restart({ tradeMode: 'paused' });
  // Any deal write first commits the due sweep (deals marked paid above read paid); count after it.
  assert.equal((await f.request(seller, 'POST', '/api/trade/deals/00000000-0000-4000-8000-000000000009/cancel', { clientRequestId: cid('c'), reason: 'sweep' })).status, 404);
  const before = await w.counts();

  // Every new-business route, each sent twice, same answer, nothing created.
  const writes = [
    [seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'New', description: 'New service', price: '3', publish: true }],
    [seller, 'PATCH', `/api/trade/offers/${w.offer.id}`, { clientRequestId: cid('upd'), title: 'Changed', publish: true }],
    [buyer, 'POST', `/api/trade/offers/${w.offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Interested', expectedRevision: w.offer.revision }],
    [seller, 'POST', `/api/trade/enquiries/${enquiryForDraft.id}/terms`, { clientRequestId: cid('draft'), terms: w.terms }],
    [seller, 'PATCH', `/api/trade/terms/${draft.id}`, { clientRequestId: cid('tu'), expectedRevision: 1, terms: w.terms }],
    [seller, 'POST', `/api/trade/terms/${draft.id}/send`, { clientRequestId: cid('ts'), expectedRevision: 1, confirmNonbinding: true }],
    [seller, 'POST', `/api/trade/terms/${looseProposal.id}/payment-request`, { clientRequestId: cid('tpr'), snapshotDigest: tradeProposalDigest(looseProposal), confirmPaymentRequest: true }],
    [buyer, 'POST', '/api/trade/deals', { clientRequestId: cid('deal'), proposalId: looseProposal.id, proposalDigest: tradeProposalDigest(looseProposal), confirmBindingDraft: true }],
    [buyer, 'POST', `/api/trade/deals/${proposed.id}/accept`, { clientRequestId: cid('accept'), dealDigest: proposed.dealDigest, confirmBinding: true }],
    [buyer, 'POST', `/api/requests/${tpr.body.request.id}/pay`, { expectedTradeDigest: tradeProposalDigest(termsProposal), confirmTradeReview: true }],
  ];
  for (const [who, method, path, body] of writes) {
    const answers = [await f.request(who, method, path, body), await f.request(who, method, path, body)];
    for (const r of answers) {
      assert.equal(r.status, 409, `${method} ${path} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'trade_paused');
      assert.match(r.body.error.message, /^Trade is paused for new business/);
      assert.equal(typeof r.body.error.next, 'string');
      assert.equal(r.headers.get('retry-after'), null, 'a final refusal carries no retry hint');
    }
    assert.deepEqual(answers[0].body, answers[1].body);
  }
  assert.deepEqual(await w.counts(), before, 'refused writes created nothing');
  assert.equal((await w.read(proposed.id)).signed.buyer, false);

  // Reads stay open.
  for (const path of ['/api/trade/offers', `/api/trade/offers/${w.offer.id}`, '/api/trade/deals', `/api/trade/deals/${agreed.id}`, '/api/trade/feed', '/api/trade/disputes', '/api/trade/decisions', `/api/trade/members/${seller.address}`, `/api/trade/public/enquiries?offerId=${w.offer.id}`, '/api/trade/attention'])
    assert.equal((await f.request(null, 'GET', path)).status, 200, path);
  assert.equal((await f.request(buyer, 'GET', '/api/trade/enquiries')).status, 200);
  assert.equal((await f.request(seller, 'GET', `/api/trade/terms/${draft.id}`)).status, 200);
  assert.equal((await f.request(buyer, 'GET', '/api/history')).status, 200);
  const policy = (await f.request(null, 'GET', '/api/trade/policy')).body;
  assert.equal(policy.availability.mode, 'paused');
  assert.equal(policy.availability.newBusiness, false);
  assert.equal((await f.request(null, 'GET', '/api/config')).body.trade.mode, 'paused');

  // Agreed deal, paid after the pause: the deal payment is not refused by Trade, and the deal completes.
  const pay = await f.request(buyer, 'POST', `/api/requests/${toPay.payment.request.id}/pay`, { expectedTradeDigest: toPay.proposalDigest, confirmTradeReview: true });
  assert.equal(typeof toPay.proposalDigest, 'string');
  assert.equal(pay.status, 503, 'past Trade and the deal checks, it stops only at the fixture\'s missing native ledger');
  assert.notEqual(pay.body.error?.code, 'trade_paused', JSON.stringify(pay.body));
  await w.markPaid(toPay.payment.request.id);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${toPay.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'Delivered' })).status, 200);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${toPay.id}/milestones/0/reject`, { clientRequestId: cid('rj'), reason: 'Missing a part' })).status, 200);
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${toPay.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'Delivered again' })).status, 200);
  const done = await f.request(buyer, 'POST', `/api/trade/deals/${toPay.id}/milestones/0/confirm`, { clientRequestId: cid('c') });
  assert.equal(done.status, 200);
  assert.equal(done.body.deal.status, 'completed');
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/deals/${toPay.id}/rating`, { clientRequestId: cid('rate'), score: 5 })).status, 200);

  // An agreed, unpaid deal can still be cancelled; its payment request closes.
  const cancelled = await f.request(seller, 'POST', `/api/trade/deals/${agreed.id}/cancel`, { clientRequestId: cid('c'), reason: 'No longer needed' });
  assert.equal(cancelled.body.deal.status, 'cancelled');

  // A paid deal: a pending refund is created and completes (refunded).
  const refund = await f.request(buyer, 'POST', `/api/trade/deals/${refunding.id}/refunds`, { clientRequestId: cid('r'), amount: '2', reason: 'Not needed after all' });
  assert.equal(refund.status, 201, JSON.stringify(refund.body));
  await w.markPaid(refund.body.refund.requestId);
  await f.request(seller, 'POST', `/api/trade/deals/${refunding.id}/rating`, { clientRequestId: cid('rate'), score: 3 });
  assert.equal((await w.read(refunding.id)).refunds[0].request.status, 'paid', 'the pending refund settled');

  // A paid deal: dispute, evidence, steward decision, appeal and central review all run.
  const opened = await f.request(buyer, 'POST', `/api/trade/deals/${disputed.id}/disputes`, { clientRequestId: cid('x'), reason: 'Nothing arrived after payment.', desiredOutcome: 'refund' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const x = opened.body.dispute;
  for (const who of [seller, buyer]) assert.equal((await f.request(who, 'POST', `/api/trade/disputes/${x.id}/evidence`, { clientRequestId: cid('e'), statement: 'Our account of it.' })).status, 201);
  const decided = await f.request(steward, 'POST', `/api/trade/steward/disputes/${x.id}/decision`, { clientRequestId: cid('dec'), outcome: 'refund-full', reasons: 'Nothing was delivered, so the buyer is refunded in full.', policyClauses: ['P5-non-delivery'], model: 'policy' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.deal.status, 'refunded');
  assert.equal((await f.request(seller, 'POST', `/api/trade/disputes/${x.id}/appeal`, { clientRequestId: cid('ap'), reason: 'It was delivered by email.' })).status, 200);
  const final = await f.request(reviewer, 'POST', `/api/trade/appeals/${x.id}/decision`, { clientRequestId: cid('ad'), result: 'upheld', reasons: 'No delivery evidence was filed; the refund stands.', policyClauses: ['P10-evidence'] });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.dispute.status, 'final');

  // The paid deal finishes: delivery and confirmation.
  assert.equal((await f.request(seller, 'POST', `/api/trade/deals/${paid.id}/milestones/0/deliver`, { clientRequestId: cid('d'), note: 'Here' })).status, 200);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/deals/${paid.id}/milestones/0/confirm`, { clientRequestId: cid('c') })).body.deal.status, 'completed');

  // A listing can be withdrawn; a terms payment request can be declined; an ordinary request is untouched.
  assert.equal((await f.request(seller, 'POST', `/api/trade/offers/${w.offer.id}/withdraw`, {})).status, 200);
  assert.equal((await f.request(buyer, 'POST', `/api/requests/${tpr.body.request.id}/decline`, {})).body.request.status, 'declined');
  assert.equal((await f.request(seller, 'POST', '/api/requests', { to: buyer.address, amount: '1', clientRequestId: cid('plain') })).status, 201);
  const plainPay = await f.request(buyer, 'POST', `/api/requests/${ordinary.body.request.id}/pay`, {});
  assert.notEqual(plainPay.body.error?.code, 'trade_paused');
  assert.equal((await f.request(seller, 'POST', `/api/requests/${ordinary.body.request.id}/cancel`, {})).body.request.status, 'cancelled');

  // The half-signed deal is left to the sweep: after 14 days it expires, and no payment request was made.
  const requestsBefore = (await f.request(buyer, 'GET', '/api/requests')).body.count;
  clock.now += 15 * DAY;
  await f.request(seller, 'POST', `/api/trade/deals/${proposed.id}/cancel`, { clientRequestId: cid('c'), reason: 'sweep' });
  const expired = await w.read(proposed.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.payment?.request ?? null, null, 'no money moved');
  assert.equal((await f.request(buyer, 'GET', '/api/requests')).body.count, requestsBefore);
});

test('switching back to open restores every operation, on the same data', async (t) => {
  const w = await world(t), { f, seller, buyer } = w;
  await f.restart({ tradeMode: 'paused' });
  assert.equal((await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: 'reopen-offer-1', title: 'New', description: 'New service', price: '3', publish: true })).body.error.code, 'trade_paused');
  await f.restart({ tradeMode: 'open' });
  assert.equal((await f.request(null, 'GET', '/api/trade/policy')).body.availability.mode, 'open');
  // The same client request id now succeeds: the refusal recorded nothing.
  assert.equal((await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: 'reopen-offer-1', title: 'New', description: 'New service', price: '3', publish: true })).status, 201);
  const deal = await w.agreed();
  assert.equal(deal.status, 'agreed');
  const p = await w.proposal();
  assert.equal((await f.request(seller, 'POST', `/api/trade/terms/${p.id}/payment-request`, { clientRequestId: cid('tpr'), snapshotDigest: tradeProposalDigest(p), confirmPaymentRequest: true })).status, 201);
  assert.equal((await f.request(buyer, 'POST', `/api/trade/offers/${w.offer.id}/enquiries`, { clientRequestId: cid('enq'), message: 'Again', expectedRevision: w.offer.revision })).status, 201);
});

test('a server started with no Trade setting is paused', async (t) => {
  const f = await fixture(t, { tradeMode: undefined });
  const seller = member();
  await f.request(seller, 'POST', '/api/account', { displayName: 'Fictional trader' });
  assert.equal((await f.request(seller, 'POST', '/api/trade/offers', { clientRequestId: cid('offer'), title: 'New', description: 'New service', price: '3', publish: true })).body.error.code, 'trade_paused');
  assert.equal((await f.request(null, 'GET', '/api/config')).body.trade.mode, 'paused');
});

// fetch cannot set Host; the MCP endpoint only answers its own host, as in mcp.test.mjs.
function mcp(f, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/mcp', { method: 'POST', headers: { Host: new URL(audience).host, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).result));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('remote MCP: paused hides baink_trade but every Trade reader answers by name; discovery says paused', async (t) => {
  for (const mode of ['paused', 'open']) {
    const f = await fixture(t, { tradeMode: mode });
    const tools = (await mcp(f, 'tools/list')).tools.map((x) => x.name);
    assert.equal(tools.includes('baink_trade'), mode === 'open', mode);
    const init = await mcp(f, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(/Trade is paused for new business/.test(init.instructions), mode === 'paused');
    for (const [name, args] of [['baink_trade', { view: 'deals' }], ['baink_trade', { view: 'policy' }], ['baink_trade_deals', {}], ['baink_trade_feed', {}], ['baink_trade_offers', {}], ['baink_trade_policy', {}], ['baink_trade_disputes', {}], ['baink_trade_decisions', {}]]) {
      const r = await mcp(f, 'tools/call', { name, arguments: args });
      assert.equal(r.isError, false, `${mode} ${name} ${JSON.stringify(r.structuredContent).slice(0, 200)}`);
      if (mode === 'paused') {
        assert.match(r.structuredContent.readOnly, /^Trade is paused for new business/);
        assert.equal(r.structuredContent.nextStep.tool, 'baink_agent_next', 'no paused reply suggests a new listing or enquiry');
      }
    }
    const policy = await mcp(f, 'tools/call', { name: 'baink_trade_policy', arguments: {} });
    assert.equal(policy.structuredContent.availability.mode, mode);
    const conn = (await mcp(f, 'tools/call', { name: 'baink_connections', arguments: {} })).structuredContent;
    assert.equal(Boolean(conn.connections[0].capabilityStatus?.['peer-trade']), mode === 'paused');
    const onboarding = (await mcp(f, 'tools/call', { name: 'baink_onboarding', arguments: {} })).structuredContent;
    assert.equal(onboarding.sell.paused === true, mode === 'paused');
    const guide = (await mcp(f, 'tools/call', { name: 'baink_guide', arguments: { question: 'how do I sell a service on trade?' } })).structuredContent;
    assert.equal(guide.topic, 'trade');
    assert.equal(/^Trade is paused for new business/.test(guide.answer), mode === 'paused');
  }
});

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('the current kit, an older kit and a direct HTTP call get the same refusal, and the kit shows it as it is', async (t) => {
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(join(tmpdir(), 'baink-trade-paused-'));
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, tradeDealSweep: false });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const o = { home: join(dir, 'kit'), url };
  await kit.ops.init(o);
  await kit.api(o, 'POST', '/api/account', { displayName: 'Fictional seller' }, await kit.loadIdentity(o));
  const args = { action: 'offer_create', title: 'New', description: 'New service', price: '3' };
  const first = await kit.ops.tradeAct(o, args).then(() => null, (e) => e);
  assert.equal(first.code, 'trade_paused');
  assert.equal(first.unknown, undefined, 'a refusal is final: never "outcome unknown", never retried');
  assert.match(first.message, /^Trade is paused for new business, so no new listing was created\. Nothing was created or charged\.$/);
  assert.match(first.next, /node uain-agent\.mjs next/);
  // Through the kit's MCP tool: the server's sentence and next step, as they are.
  const reply = await kit.handleMcp(o, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_agent_trade_act', arguments: { ...args, confirm: true } } });
  const shown = JSON.parse(reply.result.content[0].text);
  assert.equal(reply.result.isError, true);
  assert.deepEqual(shown, { error: 'trade_paused', message: first.message, next: first.next });
  // An older kit is just a signed HTTP call with its own User-Agent: same status, code and sentence.
  const raw = await fetch(url + '/api/trade/offers', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'User-Agent': 'uain-agent/0.2.10' }, body: '{}' });
  assert.equal(raw.status, 401, 'unsigned is refused before Trade is asked');
  const identity = await kit.loadIdentity(o);
  const old = await kit.api(o, 'POST', '/api/trade/offers', { clientRequestId: 'old-kit-offer-1', title: 'New', description: 'New service', price: '3', publish: true }, identity).then(() => null, (e) => e);
  assert.equal(old.status, 409);
  assert.equal(old.message, first.message);
  // A deal step an older kit sends for a deal that does not exist is answered by the deal rules, not paused.
  const missing = await kit.ops.tradeAct(o, { action: 'deal_cancel', dealId: '00000000-0000-4000-8000-000000000001', reason: 'x' }).then(() => null, (e) => e);
  assert.equal(missing.code, 'deal_not_found');
});

test('kit next offers no new-business Trade step while paused', async () => {
  const me = 'uain1' + 'a'.repeat(40), other = 'uain1' + 'b'.repeat(40);
  const replies = {
    '/api/trade/enquiries': { enquiries: [{ id: '11111111-1111-4111-8111-111111111111', offerId: '22222222-2222-4222-8222-222222222222', seller: me, buyer: other, offer: { title: 'Fictional', price: '2' }, message: 'Interested' }] },
    deals: { deals: [{ id: '33333333-3333-4333-8333-333333333333', status: 'proposed', seller: me, buyer: other, title: 'Fictional', price: '2', dealDigest: 'c'.repeat(64), signed: { seller: false, buyer: true } }] },
    '/api/trade/public/proposals': { proposals: [] },
    '/api/native/sends': { sends: [] },
    '/api/native/receiving-address': { address: 'f'.repeat(86) },
  };
  for (const newBusiness of [false, true]) {
    const fetch = async (u) => {
      const path = new URL(u).pathname;
      const body = path === '/api/trade/policy' ? { availability: { mode: newBusiness ? 'open' : 'paused', newBusiness } }
        : path === '/api/trade/deals' ? replies.deals
        : Object.entries(replies).find(([k]) => path.startsWith(k))?.[1] ?? {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const o = { url: 'https://baink.example', fetch, home: await mkdtemp(join(tmpdir(), 'kit-next-')) };
    await kit.ops.init(o);
    const identity = await kit.loadIdentity(o);
    void identity;
    const { mine, others } = await kit.tradeAttention(o, me, []);
    const cli = mine.map((m) => m.cli).join(' ');
    if (newBusiness) assert.match(cli, /deal_accept|terms_draft/);
    else {
      assert.doesNotMatch(cli, /deal_accept|terms_draft|deal_create|offer_create|enquire/);
      assert.ok(others.some((x) => /Trade is paused for new business/.test(x.what)));
    }
    await rm(o.home, { recursive: true, force: true });
  }
});

test('all 21 kit Trade actions under both modes: only new business is refused, and nothing else is', async (t) => {
  assert.equal(Object.keys(kit.TRADE_ACTIONS).length, 21);
  const refusedWhenPaused = new Set(['offer_create', 'offer_update', 'enquire', 'terms_draft', 'terms_update', 'terms_send', 'deal_create']);
  const id = '00000000-0000-4000-8000-00000000000a';
  const args = { offerId: id, enquiryId: id, termsId: id, dealId: id, disputeId: id, requestId: id, title: 'T', description: 'D', price: '1', message: 'M', expectedRevision: 1, terms: { scope: 's' }, proposalId: id, proposalDigest: 'a'.repeat(64), dealDigest: 'a'.repeat(64), reason: 'R', note: 'N', amount: '1', score: 5, desiredOutcome: 'refund', statement: 'S' };
  for (const mode of ['open', 'paused']) {
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const dir = await mkdtemp(join(tmpdir(), 'baink-trade-actions-'));
    const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: url, projectsSource: null, catalogueDir: null, tradeDealSweep: false, tradeMode: mode });
    await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
    t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
    const o = { home: join(dir, 'kit'), url };
    await kit.ops.init(o);
    await kit.api(o, 'POST', '/api/account', { displayName: 'Fictional member' }, await kit.loadIdentity(o));
    for (const action of Object.keys(kit.TRADE_ACTIONS)) {
      const e = await kit.ops.tradeAct(o, { action, ...args }).then(() => null, (x) => x);
      const paused = e?.code === 'trade_paused';
      assert.equal(paused, mode === 'paused' && refusedWhenPaused.has(action), `${mode} ${action}: ${e?.code}`);
      // Everything else reaches the action's own rules (here: the record does not exist).
      if (!paused) assert.ok(e && e.status >= 400 && e.status < 500, `${mode} ${action}: ${e?.code}`);
    }
  }
});
