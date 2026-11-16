import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';

const terms = (change = {}) => ({
  scope: 'Inspect the supplied synthetic CSV without external data access.',
  deliverables: 'One CSV report and a reproducible analysis note.',
  price: '0.000001',
  timeline: 'Within three business days after a separate agreement.',
  acceptanceCriteria: 'Report the agreed column checks and all uncertainty.',
  ...change,
});
const checkTerms = (actual, expected) => {
  for (const [key, value] of Object.entries(expected))
    assert.equal(actual[key], value, key);
  assert.equal(actual.currency, 'AI$');
};
const nonbinding = (value) => {
  assert.equal(value.nonbinding, true);
  assert.equal(value.binding, false);
  assert.equal(value.settlementAvailable, false);
  assert.equal(value.acceptanceAvailable, false);
};
const error = (response, status, code) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.error.code, code);
};
async function setup(t) {
  const f = await fixture(t), seller = member(), buyer = member(), outsider = member();
  for (const who of [seller, buyer, outsider])
    assert.equal((await f.request(who, 'POST', '/api/account', {
      displayName: 'Synthetic terms member',
    })).status, 201);
  const offer = await f.request(seller, 'POST', '/api/trade/offers', {
    clientRequestId: 'terms-http-offer',
    title: 'Synthetic CSV review',
    description: 'A bounded synthetic service, without payment activation.',
    price: '0.000001', publish: true,
  });
  assert.equal(offer.status, 201);
  const enquiry = await f.request(buyer, 'POST', `/api/trade/offers/${offer.body.offer.id}/enquiries`, {
    clientRequestId: 'terms-http-enquiry',
    message: 'Please discuss the scope of a synthetic CSV review.',
    expectedRevision: offer.body.offer.revision,
  });
  assert.equal(enquiry.status, 201);
  return { f, seller, buyer, outsider, offer: offer.body.offer, enquiry: enquiry.body.enquiry,
    list: `/api/trade/enquiries/${enquiry.body.enquiry.id}/terms` };
}
const draftPath = (id) => `/api/trade/terms/${id}`;
const create = async (f, who, path, id, value = terms()) =>
  f.request(who, 'POST', path, { clientRequestId: id, terms: value });
const send = async (f, who, draft, id, extra = {}) =>
  f.request(who, 'POST', draftPath(draft.id) + '/send', {
    clientRequestId: id, expectedRevision: draft.revision, confirmNonbinding: true, ...extra,
  });

test('terms drafts are author-only; only explicitly sent snapshots reach the counterparty and survive restart', async (t) => {
  const { f, seller, buyer, outsider, enquiry, list } = await setup(t);
  const input = terms({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const made = await create(f, buyer, list, 'terms-create-private', input);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const draft = made.body.draft;
  assert.equal(draft.revision, 1);
  const createReplay = await create(f, buyer, list, 'terms-create-private', input);
  assert.equal(createReplay.status, 201);
  assert.deepEqual(createReplay.body.draft, draft);
  error(await create(f, buyer, list, 'terms-create-private', { ...input, scope: 'Changed body under the same request intent.' }), 409, 'terms_intent_conflict');
  checkTerms(draft.terms, input);
  nonbinding(draft);
  assert.equal((await f.request(buyer, 'GET', draftPath(draft.id))).status, 200);
  error(await f.request(seller, 'GET', draftPath(draft.id)), 404, 'terms_not_found');
  error(await f.request(seller, 'PATCH', draftPath(draft.id), {
    clientRequestId: 'terms-counterparty-patch', expectedRevision: draft.revision, terms: terms(),
  }), 404, 'terms_not_found');
  error(await send(f, seller, draft, 'terms-counterparty-send'), 404, 'terms_not_found');
  error(await f.request(outsider, 'GET', draftPath(draft.id)), 404, 'enquiry_not_found');
  assert.equal((await f.request(seller, 'GET', list)).body.draftCount, 0);
  assert.equal((await f.request(seller, 'GET', list)).body.proposalCount, 0);
  error(await f.request(outsider, 'GET', list), 404);
  const other = await create(f, seller, list, 'terms-other-private', terms({ scope: 'Private seller-only draft scope.' }));
  assert.equal(other.status, 201);
  const sent = await send(f, buyer, draft, 'terms-explicit-send');
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const proposal = sent.body.proposal;
  assert.equal(proposal.draftId, draft.id);
  assert.equal(proposal.draftRevision, draft.revision);
  checkTerms(proposal.terms, input);
  nonbinding(proposal);
  for (const who of [buyer, seller]) {
    const r = await f.request(who, 'GET', list);
    assert.equal(r.status, 200);
    assert.equal(r.body.draftCount, 1);
    assert.equal(r.body.proposalCount, 1);
    assert.equal(r.body.proposals[0].id, proposal.id);
    assert.equal(r.body.drafts[0].id, who === buyer ? draft.id : other.body.draft.id);
    const page = await f.request(who, 'GET', list + '?page=1&pageSize=1');
    assert.equal(page.body.drafts.length + page.body.proposals.length, 1);
    assert.equal(page.body.pages, 2);
  }
  await f.restart();
  assert.equal((await f.request(buyer, 'GET', draftPath(draft.id))).body.draft.id, draft.id);
  assert.deepEqual((await f.request(seller, 'GET', list)).body.proposals[0], proposal);
  error(await f.request(seller, 'GET', draftPath(draft.id)), 404, 'terms_not_found');
  const replay = await send(f, buyer, draft, 'terms-explicit-send');
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body.proposal, proposal);
  error(await send(f, buyer, draft, 'terms-explicit-send', { expectedRevision: draft.revision + 1 }), 409, 'terms_intent_conflict');
  const state = readPersistedState(f.dataDir);
  assert.deepEqual(state.nativeIntents, {});
  assert.equal(enquiry.binding, false);
});

test('signed terms routes require a registered identity and refuse anonymous or unrelated reads/writes', async (t) => {
  const { f, buyer, outsider, list } = await setup(t);
  const made = await create(f, buyer, list, 'terms-auth-private');
  assert.equal(made.status, 201);
  const draft = made.body.draft;
  const routes = [
    ['GET', list, {}], ['POST', list, { clientRequestId: 'terms-anon-create', terms: terms() }],
    ['GET', draftPath(draft.id), {}],
    ['PATCH', draftPath(draft.id), { clientRequestId: 'terms-anon-patch', expectedRevision: 1, terms: terms() }],
    ['POST', draftPath(draft.id) + '/send', { clientRequestId: 'terms-anon-send', expectedRevision: 1, confirmNonbinding: true }],
  ];
  for (const [method, path, body] of routes) {
    error(await f.request(null, method, path, body), 401);
    error(await f.request(member(), method, path, body), 404, 'account_missing');
    error(await f.request(outsider, method, path, body), 404);
  }
});

test('draft replacement and send require the reviewed revision and explicit nonbinding confirmation', async (t) => {
  const { f, buyer, list } = await setup(t);
  const made = await create(f, buyer, list, 'terms-revision-create');
  assert.equal(made.status, 201);
  const first = made.body.draft, replacement = terms({ price: '0.000002', scope: 'The explicitly revised private synthetic scope.' });
  const changed = await f.request(buyer, 'PATCH', draftPath(first.id), {
    clientRequestId: 'terms-revision-update', expectedRevision: first.revision, terms: replacement,
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.draft.revision, first.revision + 1);
  checkTerms(changed.body.draft.terms, replacement);
  error(await f.request(buyer, 'PATCH', draftPath(first.id), {
    clientRequestId: 'terms-stale-update', expectedRevision: first.revision, terms: terms(),
  }), 409, 'terms_revision_changed');
  error(await send(f, buyer, first, 'terms-stale-send'), 409, 'terms_revision_changed');
  for (const confirmation of [undefined, false, 'true', 1]) {
    const body = { clientRequestId: 'terms-no-confirm-' + String(confirmation), expectedRevision: changed.body.draft.revision };
    if (confirmation !== undefined) body.confirmNonbinding = confirmation;
    error(await f.request(buyer, 'POST', draftPath(first.id) + '/send', body), 400);
  }
  assert.equal((await f.request(buyer, 'GET', list)).body.proposalCount, 0);
  const sent = await send(f, buyer, changed.body.draft, 'terms-reviewed-send');
  assert.equal(sent.status, 201);
  checkTerms(sent.body.proposal.terms, replacement);
  error(await send(f, buyer, changed.body.draft, 'terms-repeat-version-new-intent'), 409, 'terms_version_already_sent');
});

test('sent terms and original enquiry context remain immutable after offer changes and another draft', async (t) => {
  const { f, seller, buyer, offer, list } = await setup(t);
  const made = await create(f, buyer, list, 'terms-snapshot-create');
  assert.equal(made.status, 201);
  const sent = await send(f, buyer, made.body.draft, 'terms-snapshot-send');
  assert.equal(sent.status, 201);
  const snapshot = structuredClone(sent.body.proposal);
  assert.equal(snapshot.enquirySnapshot.offer.price, '0.000001');
  assert.equal(snapshot.enquirySnapshot.offer.revision, offer.revision);
  assert.equal((await f.request(seller, 'PATCH', `/api/trade/offers/${offer.id}`, { price: '0.000009', publish: true })).status, 200);
  assert.equal((await create(f, seller, list, 'terms-new-separate-draft', terms({ price: '0.000003' }))).status, 201);
  assert.deepEqual((await f.request(seller, 'GET', list)).body.proposals[0], snapshot);
  await f.restart();
  assert.deepEqual((await f.request(buyer, 'GET', list)).body.proposals[0], snapshot);
});

test('completed create/send intents recover original records after a block while fresh writes stop', async (t) => {
  const { f, seller, buyer, list } = await setup(t);
  const createBody = { clientRequestId: 'terms-retry-create', terms: terms() };
  const made = await f.request(buyer, 'POST', list, createBody);
  assert.equal(made.status, 201);
  const sent = await send(f, buyer, made.body.draft, 'terms-retry-send');
  assert.equal(sent.status, 201);
  const unsent = await create(f, buyer, list, 'terms-unsent-before-block');
  assert.equal(unsent.status, 201);
  assert.equal((await f.request(seller, 'POST', '/api/messages/blocks', { address: buyer.address, blocked: true })).status, 200);
  const replayCreate = await f.request(buyer, 'POST', list, createBody);
  assert.equal(replayCreate.status, 201);
  assert.deepEqual(replayCreate.body.draft, made.body.draft);
  assert.deepEqual((await send(f, buyer, made.body.draft, 'terms-retry-send')).body.proposal, sent.body.proposal);
  error(await create(f, buyer, list, 'terms-new-after-block'), 403, 'peer_blocked');
  error(await f.request(buyer, 'PATCH', draftPath(unsent.body.draft.id), {
    clientRequestId: 'terms-patch-after-block', expectedRevision: unsent.body.draft.revision, terms: terms({ price: '0.000003' }),
  }), 403, 'peer_blocked');
  error(await send(f, buyer, unsent.body.draft, 'terms-new-send-after-block'), 403, 'peer_blocked');
  assert.equal((await f.request(seller, 'GET', list)).body.proposalCount, 1);
  assert.equal((await f.request(buyer, 'GET', draftPath(unsent.body.draft.id))).status, 200);
  await f.restart();
  assert.deepEqual((await send(f, buyer, made.body.draft, 'terms-retry-send')).body.proposal, sent.body.proposal);
});

test('reverse peer blocks and withdrawn offers deny new terms but preserve historical read and exact retry', async (t) => {
  const { f, seller, buyer, offer, list } = await setup(t);
  const first = await create(f, seller, list, 'terms-withdraw-create');
  assert.equal(first.status, 201);
  const sent = await send(f, seller, first.body.draft, 'terms-withdraw-send');
  assert.equal(sent.status, 201);
  const unsent = await create(f, seller, list, 'terms-withdraw-unsent');
  assert.equal(unsent.status, 201);
  assert.equal((await f.request(buyer, 'POST', '/api/messages/blocks', { address: seller.address, blocked: true })).status, 200);
  error(await create(f, seller, list, 'terms-reverse-blocked'), 403, 'peer_blocked');
  assert.equal((await f.request(buyer, 'POST', '/api/messages/blocks', { address: seller.address, blocked: false })).status, 200);
  assert.equal((await f.request(seller, 'POST', `/api/trade/offers/${offer.id}/withdraw`, {})).status, 200);
  error(await create(f, seller, list, 'terms-after-withdraw'), 409, 'offer_withdrawn');
  error(await send(f, seller, unsent.body.draft, 'terms-send-after-withdraw'), 409, 'offer_withdrawn');
  error(await f.request(seller, 'PATCH', draftPath(unsent.body.draft.id), {
    clientRequestId: 'terms-patch-after-withdraw', expectedRevision: unsent.body.draft.revision, terms: terms(),
  }), 409, 'offer_withdrawn');
  assert.deepEqual((await send(f, seller, first.body.draft, 'terms-withdraw-send')).body.proposal, sent.body.proposal);
  assert.equal((await f.request(buyer, 'GET', list)).body.proposalCount, 1);
  assert.equal((await f.request(seller, 'GET', draftPath(unsent.body.draft.id))).status, 200);
});

test('invalid terms leave no records while past canonical expiry remains nonbinding information', async (t) => {
  const { f, buyer, seller, list } = await setup(t);
  let n = 0;
  for (const price of [0, 0.1, '0', '-1', '1e6', '0.0000001', '108000000000001'])
    error(await create(f, buyer, list, 'terms-invalid-price-' + n++, terms({ price })), 400);
  for (const expiresAt of ['2099-02-31T00:00:00.000Z', '2099-01-01T00:00:00+00:00', 'tomorrow'])
    error(await create(f, buyer, list, 'terms-invalid-expiry-' + n++, terms({ expiresAt })), 400);
  for (const body of [
    { clientRequestId: 'terms-extra-author', terms: terms(), author: seller.address },
    { clientRequestId: 'terms-extra-accept', terms: { ...terms(), accepted: true } },
    { clientRequestId: 'terms-extra-ledger', terms: terms(), nativeTransfer: true },
    { clientRequestId: 'terms-missing-scope', terms: { ...terms(), scope: '' } },
  ]) error(await f.request(buyer, 'POST', list, body), 400);
  assert.equal((await f.request(buyer, 'GET', list)).body.draftCount, 0);
  assert.equal((await f.request(seller, 'GET', list)).body.proposalCount, 0);
  // An expiry field records discussion text; it never creates contractual validity.
  const past = await create(f, buyer, list, 'terms-past-expiry-information', terms({ expiresAt: '2000-01-01T00:00:00.000Z' }));
  assert.equal(past.status, 201);
  assert.equal(past.body.draft.terms.expiresAt, '2000-01-01T00:00:00.000Z');
  nonbinding(past.body.draft);
  const sent = await send(f, buyer, past.body.draft, 'terms-past-expiry-send');
  assert.equal(sent.status, 201);
  nonbinding(sent.body.proposal);
});

test('private terms listing has bounded signed pagination and refuses unsupported query fields', async (t) => {
  const { f, buyer, seller, list } = await setup(t);
  for (let i = 0; i < 11; i++)
    assert.equal((await create(f, buyer, list, 'terms-page-create-' + String(i).padStart(2, '0'))).status, 201);
  const first = await f.request(buyer, 'GET', list);
  assert.equal(first.status, 200);
  assert.equal(first.body.draftCount, 11);
  assert.equal(first.body.pageSize, 10);
  assert.equal(first.body.drafts.length + first.body.proposals.length, 10);
  assert.equal(first.body.pages, 2);
  const second = await f.request(buyer, 'GET', list + '?page=2&pageSize=10');
  assert.equal(second.status, 200);
  assert.equal(second.body.drafts.length, 1);
  assert.equal(new Set([...first.body.drafts, ...second.body.drafts].map(x => x.id)).size, 11);
  assert.equal((await f.request(seller, 'GET', list)).body.draftCount, 0);
  for (const query of ['?pageSize=11', '?page=0', '?page=1.5', '?author=' + seller.address, '?page=1&page=2'])
    error(await f.request(buyer, 'GET', list + query), 400);
});
