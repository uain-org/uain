// The web menu while Trade is paused for new business (P0-4, 12 November 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADE_PAUSED_NOTICE, hasOpenDeal, readOpenDeal, tradeNavigation, tradePaused, tradePauseSentence, tradeShortcut } from './trade-availability.js';

const navigation = [
  ['Overview', null, ['Dashboard']],
  ['Network & Trade', null, ['Trade', 'Profile']],
  ['Wallet & Activity', null, ['Send money']],
];
const me = 'uain1' + 'a'.repeat(40);

test('Trade leaves the menu only while paused and the member has no open deal', () => {
  assert.equal(tradePaused({ trade: { mode: 'open', newBusiness: true } }), false);
  assert.equal(tradePaused({ trade: { mode: 'paused', newBusiness: false } }), true);
  assert.equal(tradePaused(null), true, 'an unread config offers no Trade entry');
  assert.equal(tradeNavigation(navigation, { paused: false, openDeal: false }), navigation);
  assert.equal(tradeNavigation(navigation, { paused: true, openDeal: true }), navigation, 'a member with an open deal keeps the way in');
  const hidden = tradeNavigation(navigation, { paused: true, openDeal: false });
  assert.deepEqual(hidden.map(([name, , tabs]) => [name, tabs]), [['Overview', ['Dashboard']], ['Network', ['Profile']], ['Wallet & Activity', ['Send money']]]);
});

test('an open deal is one where the member is a party and a step may remain', async () => {
  for (const status of ['proposed', 'agreed', 'paid', 'disputed', 'refunded']) assert.equal(hasOpenDeal([{ status, buyer: me }], me), true, status);
  for (const status of ['completed', 'cancelled', 'expired']) assert.equal(hasOpenDeal([{ status, seller: me }], me), false, status);
  assert.equal(hasOpenDeal([{ status: 'agreed', buyer: 'uain1' + 'b'.repeat(40) }], me), false);
  assert.equal(await readOpenDeal(async () => ({ deals: [{ status: 'paid', seller: me }] }), me), true);
  assert.equal(await readOpenDeal(async () => ({ deals: [] }), me), false);
  assert.equal(await readOpenDeal(async () => { throw new Error('down'); }, me), true, 'unreadable keeps the way in');
});

// 12 November 2026: the Overview shortcut and the pause sentence follow the availability read.
const OPEN = { trade: { schema: 'baink-trade-availability-v1', mode: 'open', newBusiness: true } };
const PAUSED = { trade: { schema: 'baink-trade-availability-v1', mode: 'paused', newBusiness: false, note: 'Trade is paused for new business: the server sentence.' } };

test('the pause sentence is the server note while paused and nothing while open', () => {
  assert.equal(tradePauseSentence(OPEN), null);
  assert.equal(tradePauseSentence(PAUSED), 'Trade is paused for new business: the server sentence.');
  assert.equal(tradePauseSentence({ trade: { mode: 'paused', newBusiness: false } }), TRADE_PAUSED_NOTICE, 'no note: the local notice');
  assert.equal(tradePauseSentence({ trade: { mode: 'paused', newBusiness: false, note: '   ' } }), TRADE_PAUSED_NOTICE);
  assert.equal(tradePauseSentence(null), TRADE_PAUSED_NOTICE, 'an unread config never invites new business');
});

test('the Overview offers "Offer or find services" only while Trade is open', () => {
  assert.deepEqual(tradeShortcut(OPEN), { kind: 'shortcut', tab: 'Trade', label: 'Offer or find services' });
  assert.deepEqual(tradeShortcut(OPEN, { openDeal: true }), { kind: 'shortcut', tab: 'Trade', label: 'Offer or find services' });
  const paused = tradeShortcut(PAUSED);
  assert.equal(paused.kind, 'paused');
  assert.equal(paused.text, PAUSED.trade.note);
  assert.equal(paused.tab, undefined, 'no Trade link without an open deal');
  assert.doesNotMatch(JSON.stringify(paused), /Offer or find/);
  assert.deepEqual(tradeShortcut(PAUSED, { openDeal: true }), { kind: 'paused', text: PAUSED.trade.note, tab: 'Trade', label: 'Finish your open deal' });
  assert.equal(tradeShortcut(null).kind, 'paused');
  // Turning Trade back on brings the shortcut back from the same read, with no second flag.
  assert.equal(tradeShortcut({ ...PAUSED, trade: { ...PAUSED.trade, mode: 'open', newBusiness: true } }).kind, 'shortcut');
});

test('the public landing page makes no claim that members can offer services while Trade is paused', async () => {
  // Static wording (apps/baink/docs/trade.md lists it): reverse this edit when Trade reopens.
  const { readFile } = await import('node:fs/promises');
  const landing = await readFile(new URL('./Landing.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(landing, /offer (a )?services?\b/i);
  assert.match(landing, /Trade between members is paused for new business/);
});
