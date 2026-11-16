// Every Trade step tells the member's agent the one next action in one plain sentence
// (production acceptance, 10 November 2026: replies carried only the raw record).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADE_ACTIONS, tradeNext } from './uain-agent.mjs';

const buyer = 'uain1' + 'b'.repeat(40), seller = 'uain1' + 's'.repeat(40);
const request = { id: '11111111-1111-4111-8111-111111111111', amount: '0.500000', status: 'open', to: buyer, from: seller };
const deal = (over = {}) => ({ id: '22222222-2222-4222-8222-222222222222', buyer, seller, status: 'agreed', dealDigest: 'd'.repeat(64), payment: { request }, refunds: [], ...over });
const ONE_SENTENCE = /^[A-Z][^.!?]*(?:\.[0-9][^.!?]*)*[.!?]$/;

test('each Trade step names one next action in one sentence', () => {
  for (const action of Object.keys(TRADE_ACTIONS)) {
    for (const me of [buyer, seller]) {
      const text = tradeNext(action, { deal: deal(), draft: { id: 'x', revision: 1 }, dispute: { id: 'y' }, refund: { id: 'r' } }, me);
      assert.match(text, ONE_SENTENCE, `${action}: "${text}"`);
      assert.doesNotMatch(text, /\b(reconcil\w*|intent|nullifier|envelope)\b/i, `${action}: "${text}"`);
    }
  }
});

test('after both sign, the buyer is told to pay with uain_agent_pay and the seller to confirm receipt', () => {
  assert.match(tradeNext('deal_accept', { deal: deal() }, buyer), new RegExp(`uain_agent_pay \\(request ${request.id}\\)`));
  assert.match(tradeNext('deal_accept', { deal: deal() }, seller), /uain_agent_payment_received/);
  assert.match(tradeNext('deal_accept', { deal: deal({ status: 'proposed' }) }, buyer), /other party to sign/);
});

test('refunds and cancellations say who pays what', () => {
  const owed = { id: 'r', request: { id: '33333333-3333-4333-8333-333333333333', amount: '0.250000', status: 'open', to: seller, from: buyer } };
  assert.match(tradeNext('refund', { refund: owed, deal: deal({ refunds: [owed] }) }, seller), /Pay the refund of 0\.25 AI\$ with uain_agent_pay \(request 33333333/);
  assert.match(tradeNext('refund', { refund: owed, deal: deal({ refunds: [owed] }) }, buyer), /seller pays the refund next/);
  assert.match(tradeNext('deal_cancel', { cancelled: false, awaiting: 'seller', deal: deal({ status: 'paid' }) }, buyer), /seller must also cancel/);
  assert.match(tradeNext('deal_cancel', { cancelled: true, deal: deal({ status: 'cancelled', refunds: [owed] }) }, seller), /Pay the refund/);
  assert.match(tradeNext('deal_cancel', { cancelled: true, deal: deal({ status: 'cancelled' }) }, buyer), /nothing more to do/);
  assert.match(tradeNext('milestone_confirm', { deal: deal({ status: 'completed' }) }, buyer), /rate it with rate/);
});
