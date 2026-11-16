// Trade leftover (a) of the 13 November security review (docs/security/todos.md, section 5),
// fixed 15 November 2026: the kit recomputes the deal digest before deal_accept signs it, with the
// same checks as the browser (web/trade-deals-view.js verifyDealDigest, FE-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as kit from './uain-agent.mjs';
import { verifyDealDigest as browserCheck } from '../web/trade-deals-view.js';
import { dealDigestInput, canonical as serverCanonical } from '../server/trade-deals.mjs';

const seller = 'uain1' + 'a'.repeat(40), buyer = 'uain1' + 'b'.repeat(40);
function shownDeal() {
  const stored = { id: '11111111-2222-4333-8444-555555555555', policyVersion: 'baink-trade-policy-v1', proposalId: '21111111-2222-4333-8444-555555555555', proposalDigest: 'c'.repeat(64), enquiryId: '31111111-2222-4333-8444-555555555555', offerId: '41111111-2222-4333-8444-555555555555', seller, buyer, terms: { scope: 'Fictional scope <b>&</b> ünïcode', deliverables: 'Fictional report', price: '2.500000', priceUnits: '2500000', currency: 'AI$', timeline: 'Two days', acceptanceCriteria: 'Covers it', expiresAt: null }, milestones: [{ index: 0, title: 'First' }, { index: 1, title: 'Second' }], paymentWindowHours: 72 };
  const digestInput = dealDigestInput(stored);
  return { id: stored.id, status: 'proposed', seller, buyer, signed: { seller: true, buyer: false }, terms: structuredClone(stored.terms), price: '2.500000', paymentWindowHours: 72, milestones: stored.milestones.map((m) => ({ ...m, status: 'pending' })), digestInput, dealDigest: createHash('sha256').update(serverCanonical(digestInput)).digest('hex') };
}
const tampered = [
  (d) => { d.dealDigest = 'f'.repeat(64); },
  (d) => { d.digestInput.terms.price = '0.500000'; },
  (d) => { d.terms.acceptanceCriteria = 'Anything goes'; },
  (d) => { d.price = '0.500000'; },
  (d) => { d.paymentWindowHours = 1; },
  (d) => { d.milestones[1].title = 'Something else'; },
  (d) => { d.milestones.pop(); },
  (d) => { d.digestInput.dealId = '91111111-2222-4333-8444-555555555555'; },
  (d) => { d.digestInput.fee.amountUnits = '1'; },
  (d) => { d.seller = buyer; },
  (d) => { delete d.digestInput; },
];

test('the kit recomputes the deal digest exactly as the browser does', async () => {
  assert.equal(typeof kit.verifyDealDigest, 'function');
  assert.equal(await kit.verifyDealDigest(shownDeal()), true, 'the server digest recomputes in the kit');
  for (const mutate of tampered) {
    const d = shownDeal(); mutate(d);
    assert.equal(await kit.verifyDealDigest(d), false, String(mutate));
    assert.equal(await kit.verifyDealDigest(d), await browserCheck(d), `kit and browser agree: ${mutate}`);
  }
});

async function world(t, served) {
  const home = await mkdtemp(join(tmpdir(), 'uain-agent-digest-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const o = { home, url: 'http://127.0.0.1:9' }, posts = [];
  await kit.ops.init(o);
  o.fetch = async (url, init = {}) => {
    const u = new URL(url), json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if ((init.method ?? 'GET') === 'GET' && u.pathname === `/api/trade/deals/${served.id}`) return json({ deal: served });
    if (init.method === 'POST') { posts.push(u.pathname); return json({ deal: { ...served, signed: { seller: true, buyer: true } } }); }
    return new Response('{}', { status: 404 });
  };
  return { o, posts };
}

test('deal_accept signs only a digest that recomputes from the deal read, and the one given', async (t) => {
  const good = shownDeal();
  const ok = await world(t, good);
  const r = await kit.ops.tradeAct(ok.o, { action: 'deal_accept', dealId: good.id, dealDigest: good.dealDigest });
  assert.equal(r.action, 'deal_accept');
  assert.deepEqual(ok.posts, [`/api/trade/deals/${good.id}/accept`], 'a matching digest is signed and sent once');

  // The server shows terms other than the ones hashed: nothing is signed or sent.
  const changed = shownDeal(); changed.terms.acceptanceCriteria = 'Anything goes';
  const bad = await world(t, changed);
  await assert.rejects(kit.ops.tradeAct(bad.o, { action: 'deal_accept', dealId: changed.id, dealDigest: changed.dealDigest }), (e) => e.code === 'deal_digest_mismatch' && /Nothing was signed/.test(e.message));
  assert.deepEqual(bad.posts, []);

  // A digest the caller was given that is not the deal's own: refused too.
  const other = await world(t, shownDeal());
  await assert.rejects(kit.ops.tradeAct(other.o, { action: 'deal_accept', dealId: good.id, dealDigest: 'e'.repeat(64) }), (e) => e.code === 'deal_digest_mismatch');
  assert.deepEqual(other.posts, []);
});
