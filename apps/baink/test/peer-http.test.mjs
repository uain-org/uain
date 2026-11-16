import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';

test('published Trade and participant-only enquiries cross the real signed HTTP boundary', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member(),
    outsider = member();
  for (const who of [alice, bob, outsider])
    assert.equal(
      (
        await f.request(who, 'POST', '/api/account', {
          displayName: 'Private account name',
        })
      ).status,
      201,
    );
  const draft = {
    clientRequestId: 'http-offer-first',
    title: 'Dataset analysis',
    description: 'Independent analysis of a supplied dataset.',
    price: '0.000001',
    publish: true,
  };
  const created = await f.request(alice, 'POST', '/api/trade/offers', draft);
  assert.equal(created.status, 201);
  const id = created.body.offer.id;
  assert.equal(
    (await f.request(alice, 'POST', '/api/trade/offers', draft)).body.offer.id,
    id,
  );
  const publicList = await f.request(null, 'GET', '/api/trade/offers');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.body.offers[0].price, '0.000001');
  assert.equal(publicList.body.offers[0].settlementAvailable, false);
  assert.equal(
    (
      await f.request(bob, 'PATCH', `/api/trade/offers/${id}`, {
        title: 'Hijacked',
        publish: true,
      })
    ).status,
    403,
  );
  const enquiry = await f.request(
    bob,
    'POST',
    `/api/trade/offers/${id}/enquiries`,
    {
      clientRequestId: 'http-enquiry-first',
      message: 'Can you inspect CSV data?',
      expectedRevision: created.body.offer.revision,
    },
  );
  assert.equal(enquiry.status, 201);
  assert.equal(
    (await f.request(null, 'GET', '/api/trade/enquiries')).status,
    401,
  );
  assert.equal(
    (await f.request(outsider, 'GET', '/api/trade/enquiries')).body.enquiries
      .length,
    0,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/trade/enquiries')).body.enquiries
      .length,
    1,
  );
  assert.equal(
    (await f.request(alice, 'POST', `/api/trade/offers/${id}/withdraw`, {}))
      .status,
    200,
  );
  assert.equal(
    (await f.request(null, 'GET', '/api/trade/offers')).body.offers.length,
    0,
  );
  await f.restart();
  assert.equal(
    (await f.request(bob, 'GET', '/api/trade/enquiries')).body.enquiries.length,
    1,
  );
});

test('new Trade enquiries bind the reviewed revision and respect peer blocks over signed HTTP', async (t) => {
  const f = await fixture(t),
    seller = member(),
    buyer = member();
  for (const who of [seller, buyer])
    assert.equal(
      (
        await f.request(who, 'POST', '/api/account', {
          displayName: 'Synthetic member',
        })
      ).status,
      201,
    );
  const created = await f.request(seller, 'POST', '/api/trade/offers', {
    clientRequestId: 'review-offer',
    title: 'Synthetic analysis',
    description: 'A bounded synthetic service.',
    price: '0.000001',
    publish: true,
  });
  const id = created.body.offer.id,
    path = `/api/trade/offers/${id}/enquiries`;
  const unreviewed = await f.request(buyer, 'POST', path, {
    clientRequestId: 'unreviewed',
    message: 'Private question.',
  });
  assert.equal(unreviewed.status, 400);
  assert.equal(unreviewed.body.error.code, 'offer_review_required');
  assert.equal(
    (await f.request(buyer, 'GET', '/api/trade/enquiries')).body.count,
    0,
  );
  const updated = await f.request(seller, 'PATCH', `/api/trade/offers/${id}`, {
    price: '0.000002',
    publish: true,
  });
  const body = {
    clientRequestId: 'reviewed-enquiry',
    message: 'Private reviewed question.',
    expectedRevision: 1,
  };
  const stale = await f.request(buyer, 'POST', path, body);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'offer_changed');
  assert.equal(
    (await f.request(buyer, 'GET', '/api/trade/enquiries')).body.count,
    0,
  );
  body.expectedRevision = updated.body.offer.revision;
  const sent = await f.request(buyer, 'POST', path, body);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.enquiry.offer.revision, 2);
  assert.equal(sent.body.enquiry.offer.price, '0.000002');
  assert.equal(sent.body.enquiry.binding, false);
  const block = (who, peer, blocked) =>
    f.request(who, 'POST', '/api/messages/blocks', {
      address: peer.address,
      blocked,
    });
  assert.equal((await block(seller, buyer, true)).status, 200);
  const blocked = await f.request(buyer, 'POST', path, {
    ...body,
    clientRequestId: 'blocked-enquiry',
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'peer_blocked');
  assert.equal(
    (await f.request(buyer, 'POST', path, body)).body.enquiry.id,
    sent.body.enquiry.id,
  );
  assert.equal(
    (await f.request(buyer, 'GET', '/api/trade/enquiries')).body.count,
    1,
  );
  assert.equal(
    (
      await f.request(seller, 'PATCH', `/api/trade/offers/${id}`, {
        price: '0.000003',
        publish: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(buyer, 'POST', path, body)).body.enquiry.id,
    sent.body.enquiry.id,
  );
  assert.equal(
    (await f.request(buyer, 'POST', path, { ...body, expectedRevision: 3 }))
      .body.error.code,
    'idempotency_conflict',
  );
  assert.equal((await block(seller, buyer, false)).status, 200);
  assert.equal((await block(buyer, seller, true)).status, 200);
  assert.equal(
    (
      await f.request(buyer, 'POST', path, {
        ...body,
        expectedRevision: 3,
        clientRequestId: 'reverse-block',
      })
    ).body.error.code,
    'peer_blocked',
  );
  assert.equal((await block(buyer, seller, false)).status, 200);
  const after = await f.request(buyer, 'POST', path, {
    ...body,
    expectedRevision: 3,
    clientRequestId: 'unblocked-enquiry',
  });
  assert.equal(after.status, 201);
  assert.equal(after.body.enquiry.offer.revision, 3);
  assert.equal(after.body.enquiry.offer.price, '0.000003');
  await f.restart();
  assert.equal(
    (await f.request(buyer, 'POST', path, body)).body.enquiry.id,
    sent.body.enquiry.id,
  );
  assert.equal(
    (await f.request(buyer, 'GET', '/api/trade/enquiries')).body.count,
    2,
  );
  assert.equal(
    (await f.request(null, 'GET', '/api/trade/offers')).body.offers[0].revision,
    3,
  );
});

test('public member reads expose source projections and never BAINK private metadata', async (t) => {
  const address = 'uain1' + 'a'.repeat(40);
  const f = await fixture(t, {
    memberDirectoryOptions: {
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify({
            participants: [
              {
                id: 'public-instance',
                member_id: address,
                name: 'Declared system',
                capabilities: ['Analysis'],
              },
            ],
            count: 1,
            page: 1,
            page_size: 20,
            pages: 1,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    },
  });
  const result = await f.request(
    null,
    'GET',
    '/api/members?page=1&pageSize=20',
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.members[0].address, address);
  assert.equal(result.body.source.independentlyVerified, false);
  assert.equal(
    (await f.request(null, 'GET', '/api/members?page=1&page=2')).status,
    400,
  );
  assert.equal(
    (await f.request(null, 'GET', '/api/members?secret=anything')).status,
    400,
  );
});

test('profile drafts stay private until a signed owner publication, with version conflict protection', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member();
  for (const who of [alice, bob])
    await f.request(who, 'POST', '/api/account', {
      displayName: 'Never automatically public',
    });
  assert.equal((await f.request(null, 'GET', '/api/profiles')).status, 200);
  assert.equal(
    (await f.request(null, 'GET', '/api/profiles')).body.profiles.length,
    0,
  );
  const draft = {
    displayName: 'Analysis system',
    summary: 'Independent analysis',
    capabilities: ['Research'],
    services: ['Data analysis'],
    languages: ['English'],
    availability: 'open',
    website: 'https://example.com/',
    publish: false,
    expectedVersion: 0,
  };
  const saved = await f.request(alice, 'PATCH', '/api/profile', draft);
  assert.equal(saved.status, 200);
  assert.equal(
    (await f.request(null, 'GET', '/api/profiles/' + alice.address)).status,
    404,
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/profile')).body.profile,
    null,
  );
  const published = await f.request(alice, 'PATCH', '/api/profile', {
    ...draft,
    publish: true,
    expectedVersion: 1,
  });
  assert.equal(published.status, 200);
  assert.equal(
    (await f.request(null, 'GET', '/api/profiles/' + alice.address)).body
      .profile.provenance.independentlyVerified,
    false,
  );
  assert.equal(
    (
      await f.request(alice, 'PATCH', '/api/profile', {
        ...draft,
        expectedVersion: 1,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(alice, 'PATCH', '/api/profile', {
        publish: false,
        expectedVersion: 2,
      })
    ).status,
    200,
  );
  await f.restart();
  assert.equal(
    (await f.request(null, 'GET', '/api/profiles/' + alice.address)).status,
    404,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/profile')).body.profile.displayName,
    draft.displayName,
  );
});

test('peer conversation messages are signed, deduplicated, persistent and restricted to the two participants', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member(),
    outsider = member();
  for (const who of [alice, bob, outsider])
    await f.request(who, 'POST', '/api/account', { displayName: 'Private' });
  const opened = await f.request(alice, 'POST', '/api/messages/conversations', {
    to: bob.address,
    clientRequestId: 'open-http-first',
  });
  assert.equal(opened.status, 201);
  const id = opened.body.conversation.id,
    path = `/api/messages/conversations/${id}`;
  const body = {
    body: '<b>Literal plain text</b>',
    clientRequestId: 'send-http-first',
  };
  const sent = await f.request(alice, 'POST', path + '/messages', body);
  assert.equal(sent.status, 201);
  assert.equal(
    (await f.request(alice, 'POST', path + '/messages', body)).body.message.id,
    sent.body.message.id,
  );
  assert.equal((await f.request(null, 'GET', path)).status, 401);
  assert.equal((await f.request(outsider, 'GET', path)).status, 404);
  assert.equal(
    (await f.request(bob, 'GET', '/api/messages/conversations')).body
      .unreadCount,
    1,
  );
  assert.equal(
    (await f.request(bob, 'POST', path + '/read', { throughSequence: '1' }))
      .status,
    200,
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/messages/conversations')).body
      .unreadCount,
    0,
  );
  await f.restart();
  const thread = await f.request(bob, 'GET', path);
  assert.equal(thread.body.messages.length, 1);
  assert.equal(thread.body.messages[0].body, body.body);
});
