import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { dealActions, dealNotes, dealStatus, verifyAcceptance, verifyDealDigest, canonical, eventLabel } from './trade-deals-view.js';
import { verifySignedRequest, dealDigestInput, canonical as serverCanonical } from '../server/trade-deals.mjs';

const seller = 'uain1' + 'a'.repeat(40), buyer = 'uain1' + 'b'.repeat(40);
const deal = (over = {}) => ({ seller, buyer, status: 'agreed', signed: { seller: true, buyer: true }, milestones: [{ index: 0, status: 'pending' }, { index: 1, status: 'delivered' }], payment: { request: { status: 'open' } }, agreedAt: 'x', ratings: {}, ...over });

test('actions follow the deal state and the viewer role', () => {
  assert.deepEqual(dealActions(deal(), 'uain1' + 'c'.repeat(40)), []);
  assert.ok(dealActions(deal(), buyer).includes('pay'));
  assert.ok(dealActions(deal(), buyer).includes('confirm:1'));
  assert.ok(!dealActions(deal(), seller).includes('pay'));
  assert.ok(dealActions(deal(), seller).includes('deliver:0'));
  assert.deepEqual(dealActions(deal({ status: 'proposed', signed: { seller: true, buyer: false }, payment: null, agreedAt: null }), buyer), ['sign', 'cancel']);
  assert.ok(dealActions(deal({ status: 'completed', payment: { request: { status: 'paid' } } }), buyer).includes('rate'));
  assert.ok(!dealActions(deal({ status: 'completed', ratings: { buyer: { score: 5 } } }), buyer).includes('rate'));
  assert.ok(dealActions(deal({ status: 'paid', cancellation: { requests: { buyer: {} } } }), seller).includes('cancel'));
  assert.ok(!dealActions(deal({ status: 'paid', cancellation: { requests: { buyer: {} } } }), buyer).includes('cancel'));
  assert.equal(dealStatus('disputed').tone, 'alert');
  // C4: once a payment landed the request is still "open", but the buyer is never offered "pay" again;
  // the seller is offered the confirmation instead.
  const landed = deal({ payment: { request: { id: 'r1', status: 'open' }, next: { actor: 'seller', action: 'confirm-received', send: 'a'.repeat(64) } } });
  assert.ok(!dealActions(landed, buyer).includes('pay'));
  assert.ok(dealActions(landed, seller).includes('confirm-received'));
  assert.ok(!dealActions(landed, buyer).includes('confirm-received'));
  const moving = deal({ payment: { request: { id: 'r1', status: 'open' }, next: { actor: 'uain', action: 'settling' } } });
  assert.ok(!dealActions(moving, buyer).includes('pay'), 'a payment on its way is not paid again');
  const ready = deal({ payment: { request: { id: 'r1', status: 'open' }, next: { actor: 'buyer', action: 'sign-payment', send: 'a'.repeat(64) } } });
  assert.ok(!dealActions(ready, buyer).includes('pay')); assert.ok(dealActions(ready, buyer).includes('sign-payment'));
  const due = deal({ payment: { request: { id: 'r1', status: 'open' }, next: { actor: 'buyer', action: 'pay' } } });
  assert.ok(dealActions(due, buyer).includes('pay'));
  assert.equal(eventLabel('dispute.appeal-decided'), 'Central review decided');
});

test('browser verification accepts exactly what the server verifies', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const a = { address: 'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40), publicKey: raw.toString('base64'), audience: 'https://baink.example', method: 'POST', path: '/api/trade/deals/x/accept', body: { clientRequestId: 'abcdefgh', dealDigest: 'd'.repeat(64), confirmBinding: true }, nonce: 'n'.repeat(24), timestamp: '1794211818415' };
  a.signature = sign(null, Buffer.from(canonical({ audience: a.audience, method: a.method, path: a.path, body: a.body, nonce: a.nonce, timestamp: a.timestamp })), privateKey).toString('base64');
  assert.equal(await verifyAcceptance(a), true);
  assert.equal(verifySignedRequest(a), true);
  const forged = { ...a, body: { ...a.body, dealDigest: 'e'.repeat(64) } };
  assert.equal(await verifyAcceptance(forged), false);
  assert.equal(verifySignedRequest(forged), false);
  assert.equal(await verifyAcceptance({ ...a, address: seller }), false);
});

test('the deal page offers only what BAINK 0.3.75 accepts, and says why the rest is not offered', () => {
  const codes = (d, who) => dealNotes(d, who).map((n) => n.code);
  // deal_not_final: a closed deal that can still reopen is not rated yet.
  const reopenable = deal({ status: 'refunded', payment: { request: { status: 'paid' } }, rateable: false });
  assert.ok(!dealActions(reopenable, buyer).includes('rate'));
  assert.deepEqual(codes(reopenable, buyer), ['deal_not_final']);
  assert.match(dealNotes(reopenable, buyer)[0].text, /can still reopen .* rate it once that is settled/);
  const final = deal({ status: 'refunded', payment: { request: { status: 'paid' } }, rateable: true });
  assert.ok(dealActions(final, buyer).includes('rate')); assert.deepEqual(codes(final, buyer), []);
  assert.ok(dealActions(deal({ status: 'cancelled' }), buyer).includes('rate'), 'a server that sends no rateable keeps the earlier rule');
  assert.deepEqual(codes(deal({ status: 'completed', rateable: false, ratings: { buyer: { score: 5 } } }), buyer), [], 'nothing to explain once rated');
  // dispute_pending: one dispute at a time.
  const disputed = deal({ status: 'paid', disputes: [{ id: 'd1', status: 'open' }] });
  assert.ok(!dealActions(disputed, buyer).includes('dispute')); assert.deepEqual(codes(disputed, seller), ['dispute_pending']);
  const decided = deal({ status: 'paid', disputes: [{ id: 'd1', status: 'decided', appealDeadline: '2026-11-17T09:00:00.000Z' }] });
  assert.match(dealNotes(decided, buyer)[0].text, /appeal that decision by 2026-11-17T09:00:00.000Z instead of opening a new dispute/);
  // dispute_limit: three disputes at most.
  const spent = deal({ status: 'paid', disputes: [1, 2, 3].map((n) => ({ id: 'd' + n, status: 'final' })) });
  assert.ok(!dealActions(spent, buyer).includes('dispute')); assert.deepEqual(codes(spent, buyer), ['dispute_limit']);
  assert.ok(dealActions(deal({ status: 'paid', disputes: [{ id: 'd1', status: 'final' }] }), buyer).includes('dispute'));
  // payment_request_paid: once the payment was sent, cancel is not offered; a dispute is the way.
  const paidUnconfirmed = deal({ payment: { request: { id: 'r1', status: 'open' }, next: { actor: 'seller', action: 'confirm-received', send: 'a'.repeat(64) } } });
  assert.ok(!dealActions(paidUnconfirmed, buyer).includes('cancel')); assert.ok(!dealActions(paidUnconfirmed, seller).includes('cancel'));
  assert.ok(dealActions(paidUnconfirmed, buyer).includes('dispute'));
  assert.deepEqual(codes(paidUnconfirmed, buyer), ['payment_request_paid']);
  assert.match(dealNotes(paidUnconfirmed, buyer)[0].text, /open a dispute to get it back/);
  assert.ok(dealActions(deal(), buyer).includes('cancel'), 'before any payment a signed deal can still be cancelled');
  assert.deepEqual(dealNotes(deal(), 'uain1' + 'c'.repeat(40)), [], 'a visitor is told nothing');
});

// 12 November 2026: while Trade is paused for new business, an unsigned deal shows the pause
// sentence instead of "Sign deal" (the server refuses it, trade_paused); open mode is unchanged.
test('a proposed deal offers Sign only while Trade is open, and says why while paused', () => {
  const proposed = deal({ status: 'proposed', signed: { seller: true, buyer: false }, agreedAt: null, payment: null });
  const sentence = 'Trade is paused for new business.';
  assert.ok(dealActions(proposed, buyer).includes('sign'), 'open: the buyer may sign');
  assert.ok(dealActions(proposed, buyer, { paused: false }).includes('sign'));
  assert.ok(!dealActions(proposed, buyer, { paused: true }).includes('sign'), 'paused: no Sign');
  assert.ok(dealActions(proposed, buyer, { paused: true }).includes('cancel'), 'paused: cancelling stays');
  assert.deepEqual(dealNotes(proposed, buyer).map((n) => n.code), [], 'open: no pause note');
  const notes = dealNotes(proposed, buyer, { pausedSentence: sentence });
  assert.deepEqual(notes.map((n) => n.code), ['trade_paused']);
  assert.match(notes[0].text, /^Trade is paused for new business\. So this deal cannot be signed now/);
  assert.equal(dealNotes(proposed, seller, { pausedSentence: sentence })[0].code, 'trade_paused', 'the party that signed reads it too');
  // An agreed deal is an obligation: every step stays and no pause note is shown.
  assert.deepEqual(dealActions(deal(), buyer, { paused: true }), dealActions(deal(), buyer));
  assert.deepEqual(dealNotes(deal(), buyer, { pausedSentence: sentence }), dealNotes(deal(), buyer));
});

// FE-4 (security review, 13 November 2026): before offering Sign, the browser recomputes the deal
// digest from the digestInput it reads, and checks that the terms it shows are the ones hashed.
test('Sign is enabled only when the deal digest recomputes from the terms shown', async () => {
  const stored = { id: '11111111-2222-4333-8444-555555555555', policyVersion: 'baink-trade-policy-v1', proposalId: '21111111-2222-4333-8444-555555555555', proposalDigest: 'c'.repeat(64), enquiryId: '31111111-2222-4333-8444-555555555555', offerId: '41111111-2222-4333-8444-555555555555', seller, buyer, terms: { scope: 'Fictional scope <b>&</b> ünïcode', deliverables: 'Fictional report', price: '2.5', priceUnits: '2500000', currency: 'AI$', timeline: 'Two days', acceptanceCriteria: 'Covers it', expiresAt: null }, milestones: [{ index: 0, title: 'First' }, { index: 1, title: 'Second' }], paymentWindowHours: 72 };
  const digestInput = dealDigestInput(stored);
  const shown = { ...deal({ status: 'proposed', signed: { seller: true, buyer: false }, agreedAt: null, payment: null }), id: stored.id, terms: structuredClone(stored.terms), price: '2.5', paymentWindowHours: 72, milestones: stored.milestones.map((m) => ({ ...m, status: 'pending' })), digestInput, dealDigest: createHash('sha256').update(serverCanonical(digestInput)).digest('hex') };
  assert.equal(await verifyDealDigest(shown), true, 'the server digest recomputes in the browser');
  const tampered = [
    (d) => { d.dealDigest = 'f'.repeat(64); },
    (d) => { d.digestInput.terms.price = '0.5'; },
    (d) => { d.terms.acceptanceCriteria = 'Anything goes'; },
    (d) => { d.price = '0.5'; },
    (d) => { d.milestones[1].title = 'Something else'; },
    (d) => { d.digestInput.dealId = '91111111-2222-4333-8444-555555555555'; },
    (d) => { d.seller = buyer; },
    (d) => { delete d.digestInput; },
  ];
  for (const mutate of tampered) { const d = structuredClone(shown); mutate(d); assert.equal(await verifyDealDigest(d), false, String(mutate)); }
});
