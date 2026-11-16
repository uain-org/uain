import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createTradeService, TradeError } from '../server/trade.mjs';
import { createPeerMessages } from '../server/messages.mjs';

function member() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(key).digest('hex').slice(0, 40),
    publicKey: key.toString('base64'),
  };
}
function fixture(initial) {
  const seller = initial?.seller ?? member(),
    buyer = initial?.buyer ?? member();
  let state = initial?.state ?? {
      accounts: Object.fromEntries(
        [seller, buyer].map((user) => [user.address, user]),
      ),
    },
    tail = Promise.resolve(),
    commits = 0;
  const store = {
    read: () => structuredClone(state),
    transact(fn) {
      const result = tail.then(async () => {
        const next = structuredClone(state),
          value = await fn(next);
        state = JSON.parse(JSON.stringify(next));
        commits++;
        return structuredClone(value);
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  return {
    seller,
    buyer,
    store,
    trade: createTradeService({ store }),
    messages: createPeerMessages({ store }),
    commits: () => commits,
    restart: () => fixture({ seller, buyer, state: structuredClone(state) }),
  };
}
const offerBody = {
  clientRequestId: 'review-offer-0001',
  title: 'Package review',
  description: 'Review an open reproducibility package.',
  price: '0.000001',
  publish: true,
};
const enquiryBody = {
  clientRequestId: 'review-enquiry-0001',
  message: 'Please discuss a package review.',
};
const refusal = (status, code) => (error) =>
  error instanceof TradeError && error.status === status && error.code === code;

test('a changed offer cannot silently replace the listing reviewed before an enquiry', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  await f.trade.update(f.seller, offer.id, {
    price: '99.000001',
    publish: true,
  });
  const before = f.store.read(),
    commits = f.commits();
  await assert.rejects(
    f.trade.enquire(f.buyer, offer.id, {
      ...enquiryBody,
      expectedRevision: offer.revision,
    }),
    refusal(409, 'offer_changed'),
  );
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.commits(), commits);
});

test('an existing peer block prevents a new Trade enquiry', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  await f.messages.block(f.seller, { address: f.buyer.address });
  const before = f.store.read(),
    commits = f.commits();
  await assert.rejects(
    f.trade.enquire(f.buyer, offer.id, {
      ...enquiryBody,
      expectedRevision: offer.revision,
    }),
    refusal(403, 'peer_blocked'),
  );
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.commits(), commits);
});

test('missing and malformed review revisions cannot create enquiries or change durable state', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const before = f.store.read(),
    commits = f.commits();
  await assert.rejects(
    f.trade.enquire(f.buyer, offer.id, enquiryBody),
    (error) =>
      refusal(400, 'offer_review_required')(error) &&
      /reload.*review/i.test(error.message),
  );
  for (const expectedRevision of [
    undefined,
    null,
    true,
    false,
    '1',
    '',
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
  ]) {
    await assert.rejects(
      f.trade.enquire(f.buyer, offer.id, { ...enquiryBody, expectedRevision }),
      refusal(400, 'invalid_body'),
    );
  }
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.commits(), commits);
});

test('an exact reviewed micro-price creates one immutable enquiry without initializing message state', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const body = { ...enquiryBody, expectedRevision: offer.revision };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => f.trade.enquire(f.buyer, offer.id, body)),
  );
  assert.equal(new Set(results.map((result) => result.enquiry.id)).size, 1);
  assert.equal(f.trade.listEnquiries(f.buyer).count, 1);
  assert.deepEqual(results[0].enquiry.offer, {
    title: 'Package review',
    price: '0.000001',
    priceUnits: '1',
    currency: 'AI$',
    revision: 1,
  });
  assert.equal(results[0].enquiry.binding, false);
  assert.equal(results[0].enquiry.settlementAvailable, false);
  assert.equal(Object.hasOwn(results[0].enquiry, 'expectedRevision'), false);
  assert.equal(Object.hasOwn(f.store.read(), 'peerMessages'), false);
  const saved = results[0].enquiry;
  await f.trade.update(f.seller, offer.id, {
    price: '2.000001',
    publish: true,
  });
  await f.messages.block(f.seller, { address: f.buyer.address });
  await f.trade.withdraw(f.seller, offer.id);
  const restarted = f.restart(),
    before = restarted.store.read();
  assert.deepEqual(
    (await restarted.trade.enquire(f.buyer, offer.id, body)).enquiry,
    saved,
  );
  assert.deepEqual(restarted.store.read(), before);
  for (const patch of [
    { expectedRevision: 2 },
    { message: 'Different message' },
  ]) {
    await assert.rejects(
      restarted.trade.enquire(f.buyer, offer.id, { ...body, ...patch }),
      refusal(409, 'idempotency_conflict'),
    );
  }
  await assert.rejects(
    restarted.trade.enquire(f.buyer, offer.id, {
      ...body,
      expectedRevision: undefined,
    }),
    refusal(400, 'invalid_body'),
  );
  await assert.rejects(
    restarted.trade.enquire(f.buyer, offer.id, enquiryBody),
    refusal(409, 'idempotency_conflict'),
  );
});

test('a changed review needs a fresh intent rather than retargeting a completed enquiry', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const body = { ...enquiryBody, expectedRevision: 1 };
  const first = await f.trade.enquire(f.buyer, offer.id, body);
  await f.trade.update(f.seller, offer.id, {
    price: '2.000001',
    publish: true,
  });
  await assert.rejects(
    f.trade.enquire(f.buyer, offer.id, { ...body, expectedRevision: 2 }),
    refusal(409, 'idempotency_conflict'),
  );
  const second = await f.trade.enquire(f.buyer, offer.id, {
    ...body,
    clientRequestId: 'review-enquiry-0002',
    expectedRevision: 2,
  });
  assert.notEqual(second.enquiry.id, first.enquiry.id);
  assert.equal(first.enquiry.offer.price, '0.000001');
  assert.equal(second.enquiry.offer.price, '2.000001');
  assert.equal(second.enquiry.offer.revision, 2);
});

test('legacy enquiry retries remain exact after restart, withdrawal and blocking without enabling new unreviewed writes', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const id = '86a77dc9-b5e0-4b8d-873f-21d0ee8c5861';
  const legacy = {
    id,
    offerId: offer.id,
    buyer: f.buyer.address,
    buyerPublicKey: f.buyer.publicKey,
    seller: f.seller.address,
    sellerPublicKey: f.seller.publicKey,
    ...enquiryBody,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([offer.id, enquiryBody.message]))
      .digest('hex'),
    offerTitle: offer.title,
    offerPrice: offer.price,
    offerPriceUnits: offer.priceUnits,
    offerRevision: 1,
    createdAt: '2026-10-31T12:00:00.000Z',
  };
  await f.store.transact((state) => {
    state.trade.enquiries[id] = legacy;
  });
  await f.trade.update(f.seller, offer.id, {
    price: '77.000001',
    publish: true,
  });
  await f.trade.withdraw(f.seller, offer.id);
  await f.messages.block(f.buyer, { address: f.seller.address });
  const restarted = f.restart(),
    before = restarted.store.read();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      restarted.trade.enquire(f.buyer, offer.id, enquiryBody),
    ),
  );
  assert.ok(
    results.every(
      (result) =>
        result.enquiry.id === id && result.enquiry.offer.revision === 1,
    ),
  );
  assert.deepEqual(restarted.store.read(), before);
  assert.deepEqual(restarted.store.read().trade.enquiries[id], legacy);
  await assert.rejects(
    restarted.trade.enquire(f.buyer, offer.id, {
      ...enquiryBody,
      expectedRevision: 1,
    }),
    refusal(409, 'idempotency_conflict'),
  );
  await assert.rejects(
    restarted.trade.enquire(f.buyer, offer.id, {
      ...enquiryBody,
      message: 'Changed',
    }),
    refusal(409, 'idempotency_conflict'),
  );
  await assert.rejects(
    restarted.trade.enquire(f.buyer, offer.id, {
      ...enquiryBody,
      clientRequestId: 'new-legacy-attempt',
    }),
    refusal(400, 'offer_review_required'),
  );
  assert.deepEqual(restarted.store.read(), before);
});

test('both block directions give the same refusal and unblocking permits a new reviewed intent', async () => {
  const messages = [];
  for (const direction of ['seller', 'buyer']) {
    const f = fixture(),
      { offer } = await f.trade.create(f.seller, offerBody);
    const blocker = f[direction],
      peer = direction === 'seller' ? f.buyer : f.seller;
    await f.messages.block(blocker, { address: peer.address });
    const before = f.store.read();
    await assert.rejects(
      f.trade.enquire(f.buyer, offer.id, {
        ...enquiryBody,
        expectedRevision: 1,
      }),
      (error) => {
        messages.push(error.message);
        return refusal(403, 'peer_blocked')(error);
      },
    );
    assert.deepEqual(f.store.read(), before);
    await f.messages.block(blocker, { address: peer.address, blocked: false });
    assert.equal(
      (
        await f.trade.enquire(f.buyer, offer.id, {
          ...enquiryBody,
          expectedRevision: 1,
        })
      ).enquiry.offer.revision,
      1,
    );
  }
  assert.equal(messages[0], messages[1]);
});

test('serialized block/enquiry races honor the committed block and preserve already recorded enquiries', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const body = { ...enquiryBody, expectedRevision: 1 };
  const [blocked, enquiry] = await Promise.allSettled([
    f.messages.block(f.seller, { address: f.buyer.address }),
    f.trade.enquire(f.buyer, offer.id, body),
  ]);
  assert.equal(blocked.status, 'fulfilled');
  assert.equal(enquiry.status, 'rejected');
  assert.ok(refusal(403, 'peer_blocked')(enquiry.reason));
  assert.equal(f.trade.listEnquiries(f.buyer).count, 0);
  await f.messages.block(f.seller, {
    address: f.buyer.address,
    blocked: false,
  });
  const [recorded, laterBlock] = await Promise.all([
    f.trade.enquire(f.buyer, offer.id, body),
    f.messages.block(f.buyer, { address: f.seller.address }),
  ]);
  assert.equal(laterBlock.blocked, true);
  assert.deepEqual(
    (await f.trade.enquire(f.buyer, offer.id, body)).enquiry,
    recorded.enquiry,
  );
  assert.equal(f.trade.listEnquiries(f.seller).count, 1);
});

test('review validation uses the offer revision at serialized commit, not the earlier call', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  const results = await Promise.allSettled([
    f.trade.update(f.seller, offer.id, { price: '88.000001', publish: true }),
    f.trade.enquire(f.buyer, offer.id, { ...enquiryBody, expectedRevision: 1 }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(refusal(409, 'offer_changed')(results[1].reason));
  assert.equal(f.trade.listEnquiries(f.buyer).count, 0);
});

test('a peer block is enforced before exhausted write capacity and does not consume allowance', async () => {
  const f = fixture(),
    { offer } = await f.trade.create(f.seller, offerBody);
  await f.messages.block(f.seller, { address: f.buyer.address });
  await f.store.transact((state) => {
    state.trade.rate[f.buyer.address] = {
      startedAt: Date.now() + 60000,
      count: 30,
    };
  });
  const before = f.store.read(),
    commits = f.commits();
  await assert.rejects(
    f.trade.enquire(f.buyer, offer.id, { ...enquiryBody, expectedRevision: 1 }),
    refusal(403, 'peer_blocked'),
  );
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.commits(), commits);
});

test('malformed existing communication policy fails closed without repairing or replacing it', async () => {
  for (const policy of [
    null,
    { version: 2, blocks: {} },
    { version: 1, blocks: [] },
    'invalid-list',
  ]) {
    const f = fixture(),
      { offer } = await f.trade.create(f.seller, offerBody);
    await f.store.transact((state) => {
      state.peerMessages =
        policy === 'invalid-list'
          ? { version: 1, blocks: { [f.seller.address]: f.buyer.address } }
          : policy;
    });
    const before = f.store.read(),
      commits = f.commits();
    await assert.rejects(
      f.trade.enquire(f.buyer, offer.id, {
        ...enquiryBody,
        expectedRevision: 1,
      }),
      refusal(503, 'trade_storage_invalid'),
    );
    assert.deepEqual(f.store.read(), before);
    assert.equal(f.commits(), commits);
  }
});
