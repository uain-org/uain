import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createTradeService, TradeError } from '../server/trade.mjs';

function member() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40),
    publicKey: raw.toString('base64'),
  };
}
function fixture(serialized = '{}') {
  let state = JSON.parse(serialized),
    tail = Promise.resolve(),
    clock = Date.parse('2026-10-31T12:00:00Z');
  const store = {
    read: () => structuredClone(state),
    transact(fn) {
      const operation = tail.then(async () => {
        const next = structuredClone(state);
        const result = await fn(next);
        const persisted = JSON.stringify(next);
        state = JSON.parse(persisted);
        return structuredClone(result);
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
  return {
    store,
    service: createTradeService({ store, now: () => clock }),
    advance: (ms) => (clock += ms),
    serialized: () => JSON.stringify(state),
  };
}
const publication = (id = 'offer-intent-0001', patch = {}) => ({
  clientRequestId: id,
  title: 'Review a reproducibility package',
  description:
    'I will review the supplied open research package and report reproducibility issues.',
  category: 'Review',
  price: '12.000001',
  publish: true,
  ...patch,
});
const refusal = (status, code) => (error) =>
  error instanceof TradeError && error.status === status && error.code === code;

test('a signed seller explicitly publishes one bounded public peer offer, separate from research and settlement', async () => {
  const f = fixture(),
    seller = member();
  await assert.rejects(
    f.service.create(seller, { ...publication(), publish: false }),
    refusal(400, 'publication_required'),
  );
  assert.equal(f.service.list().count, 0);
  const { offer } = await f.service.create(seller, publication());
  assert.equal(offer.owner, seller.address);
  assert.equal(offer.price, '12.000001');
  assert.equal(offer.priceUnits, '12000001');
  assert.equal(offer.currency, 'AI$');
  assert.equal(offer.availability, 'open');
  assert.equal(offer.settlementAvailable, false);
  assert.equal(offer.kind, 'peer-offer');
  assert.equal(f.service.list().count, 1);
  assert.equal(f.service.detail(offer.id).offer.id, offer.id);
  assert.equal('ownerPublicKey' in offer, false);
  assert.equal('clientRequestId' in offer, false);
});

test('create retries and concurrent retries persist exactly one offer, and a conflicting intent is rejected', async () => {
  const f = fixture(),
    seller = member(),
    body = publication();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.service.create(seller, body)),
  );
  assert.equal(new Set(results.map((x) => x.offer.id)).size, 1);
  assert.equal(f.service.list().count, 1);
  await assert.rejects(
    f.service.create(seller, { ...body, description: 'Different publication' }),
    refusal(409, 'idempotency_conflict'),
  );
  assert.equal(f.service.list().count, 1);
});

test('only the bound owner can edit or withdraw; identity and availability cannot be rewritten through content updates', async () => {
  const f = fixture(),
    seller = member(),
    other = member();
  const { offer } = await f.service.create(seller, publication());
  await assert.rejects(
    f.service.update(other, offer.id, { title: 'Taken over', publish: true }),
    refusal(403, 'offer_forbidden'),
  );
  await assert.rejects(
    f.service.withdraw(other, offer.id),
    refusal(403, 'offer_forbidden'),
  );
  for (const patch of [
    { owner: other.address },
    { ownerPublicKey: other.publicKey },
    { id: 'replacement' },
    { availability: 'open' },
    { priceUnits: '1' },
  ])
    await assert.rejects(
      f.service.update(seller, offer.id, { ...patch, publish: true }),
      refusal(400, 'invalid_body'),
    );
  await assert.rejects(
    f.service.update(seller, offer.id, {
      title: 'An edit without publication consent',
    }),
    refusal(400, 'publication_required'),
  );
  const updated = await f.service.update(seller, offer.id, {
    title: 'Review one open-source package',
    price: '0.000001',
    publish: true,
  });
  assert.equal(updated.offer.owner, seller.address);
  assert.equal(updated.offer.createdAt, offer.createdAt);
  assert.equal(updated.offer.priceUnits, '1');
  const withdrawn = await f.service.withdraw(seller, offer.id);
  assert.equal(withdrawn.offer.availability, 'withdrawn');
  assert.equal(
    (await f.service.withdraw(seller, offer.id)).offer.updatedAt,
    withdrawn.offer.updatedAt,
  );
  assert.equal(f.service.list().count, 0);
  assert.equal(f.service.detail(offer.id).offer.availability, 'withdrawn');
  await assert.rejects(
    f.service.update(seller, offer.id, { title: 'Reopened', publish: true }),
    refusal(409, 'offer_withdrawn'),
  );
});

test('prices retain one micro and the full 108 trillion cap without Number conversion', async () => {
  const f = fixture(),
    seller = member();
  const micro = await f.service.create(
    seller,
    publication('price-micro-0001', { price: '0.000001' }),
  );
  assert.equal(micro.offer.priceUnits, '1');
  const cap = await f.service.create(
    seller,
    publication('price-cap-0001', { price: '108000000000000.000000' }),
  );
  assert.equal(cap.offer.priceUnits, '108000000000000000000');
  const precise = await f.service.create(
    seller,
    publication('price-precise-0001', { price: '107999999999999.999999' }),
  );
  assert.equal(precise.offer.priceUnits, '107999999999999999999');
  for (const price of [
    1,
    '0',
    '1e6',
    '-1',
    '01.00',
    '0.0000001',
    '108000000000000.000001',
  ])
    await assert.rejects(
      f.service.create(seller, publication('invalid-price-0001', { price })),
      refusal(400, 'invalid_price'),
    );
});

test('unauthenticated, mismatched-key and prototype-bearing writes are rejected without publishing', async () => {
  const f = fixture(),
    seller = member(),
    other = member();
  await assert.rejects(
    f.service.create(null, publication()),
    refusal(401, 'authentication_required'),
  );
  await assert.rejects(
    f.service.create({ ...seller, publicKey: other.publicKey }, publication()),
    refusal(401, 'invalid_identity'),
  );
  const inherited = Object.assign(
    Object.create({ hidden: 'inherited' }),
    publication(),
  );
  await assert.rejects(
    f.service.create(seller, inherited),
    refusal(400, 'invalid_body'),
  );
  for (const extra of [
    '__proto__',
    'constructor',
    'prototype',
    'balance',
    'reviews',
  ]) {
    const body = JSON.parse(JSON.stringify(publication()));
    Object.defineProperty(body, extra, {
      value: 'unsupported',
      enumerable: true,
    });
    await assert.rejects(
      f.service.create(seller, body),
      refusal(400, 'invalid_body'),
    );
  }
  await assert.rejects(
    f.service.create(
      seller,
      publication('bad-text-0001', { description: '\u0000hidden' }),
    ),
    refusal(400, 'invalid_body'),
  );
  await assert.rejects(
    f.service.create(
      seller,
      publication('big-text-0001', { description: 'é'.repeat(2001) }),
    ),
    refusal(400, 'invalid_body'),
  );
  assert.equal(f.service.list().count, 0);
  assert.equal({}.hidden, undefined);
});

test('public listings are bounded, deterministic and filterable without exposing private enquiries', async () => {
  const f = fixture(),
    seller = member();
  for (let i = 0; i < 30; i++) {
    await f.service.create(
      seller,
      publication(`list-intent-${String(i).padStart(4, '0')}`, {
        title: `Published offer ${i}`,
        category: i % 2 ? 'Review' : 'Compute',
      }),
    );
    f.advance(1);
  }
  const one = f.service.list({ page: '1', pageSize: '25' }),
    two = f.service.list({ page: 2, pageSize: 25 });
  assert.equal(one.count, 30);
  assert.equal(one.offers.length, 25);
  assert.equal(two.offers.length, 5);
  assert.equal(one.pages, 2);
  assert.equal(
    new Set([...one.offers, ...two.offers].map((x) => x.id)).size,
    30,
  );
  assert.deepEqual(f.service.list({ page: 2, pageSize: 25 }), two);
  assert.equal(f.service.list({ category: 'Review' }).count, 15);
  assert.equal(f.service.list({ q: 'offer 29' }).count, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(one)) < 128 * 1024);
  assert.throws(
    () => f.service.list({ pageSize: 26 }),
    refusal(400, 'invalid_query'),
  );
  assert.throws(
    () => f.service.list({ page: '1e2' }),
    refusal(400, 'invalid_query'),
  );
  assert.throws(
    () => f.service.list({ buyer: seller.address }),
    refusal(400, 'invalid_body'),
  );
});

test('an enquiry is nonbinding and private to its buyer and seller, including after withdrawal', async () => {
  const f = fixture(),
    seller = member(),
    buyer = member(),
    outsider = member();
  const { offer } = await f.service.create(seller, publication());
  const body = {
    clientRequestId: 'enquiry-intent-0001',
    expectedRevision: offer.revision,
    message: 'Can you review a package next week?',
  };
  const { enquiry } = await f.service.enquire(buyer, offer.id, body);
  assert.equal(enquiry.buyer, buyer.address);
  assert.equal(enquiry.seller, seller.address);
  assert.equal(enquiry.binding, false);
  assert.equal(enquiry.settlementAvailable, false);
  assert.equal(f.service.listEnquiries(buyer).count, 1);
  assert.equal(f.service.listEnquiries(seller).count, 1);
  assert.equal(f.service.listEnquiries(outsider).count, 0);
  assert.throws(
    () => f.service.listEnquiries(null),
    refusal(401, 'authentication_required'),
  );
  assert.equal(JSON.stringify(f.service.list()).includes(body.message), false);
  assert.equal(
    JSON.stringify(f.service.detail(offer.id)).includes(body.message),
    false,
  );
  await f.service.withdraw(seller, offer.id);
  assert.equal(
    (await f.service.enquire(buyer, offer.id, body)).enquiry.id,
    enquiry.id,
  );
  await assert.rejects(
    f.service.enquire(outsider, offer.id, {
      ...body,
      clientRequestId: 'new-enquiry-0001',
    }),
    refusal(409, 'offer_withdrawn'),
  );
  assert.equal(f.service.listEnquiries(seller, { offerId: offer.id }).count, 1);
});

test('enquiry retries are idempotent, self-enquiries and conflicting identities or bodies cannot create one', async () => {
  const f = fixture(),
    seller = member(),
    buyer = member();
  const first = await f.service.create(seller, publication());
  const second = await f.service.create(
    seller,
    publication('offer-intent-0002'),
  );
  const body = {
    clientRequestId: 'enquiry-stable-0001',
    expectedRevision: first.offer.revision,
    message: 'Is the listed service available?',
  };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.service.enquire(buyer, first.offer.id, body),
    ),
  );
  assert.equal(new Set(results.map((x) => x.enquiry.id)).size, 1);
  assert.equal(f.service.listEnquiries(buyer).count, 1);
  await assert.rejects(
    f.service.enquire(buyer, first.offer.id, {
      ...body,
      message: 'Different intent',
    }),
    refusal(409, 'idempotency_conflict'),
  );
  await assert.rejects(
    f.service.enquire(buyer, second.offer.id, body),
    refusal(409, 'idempotency_conflict'),
  );
  await assert.rejects(
    f.service.enquire(seller, first.offer.id, {
      ...body,
      clientRequestId: 'seller-self-0001',
    }),
    refusal(400, 'self_enquiry'),
  );
  await assert.rejects(
    f.service.enquire(buyer, first.offer.id, {
      ...body,
      clientRequestId: 'extra-fields-0001',
      seller: buyer.address,
    }),
    refusal(400, 'invalid_body'),
  );
});

test('durable serialized state preserves publication, enquiry privacy and retry identity across service restart', async () => {
  const f = fixture(),
    seller = member(),
    buyer = member();
  const body = publication();
  const { offer } = await f.service.create(seller, body);
  const enquiryBody = {
    clientRequestId: 'restart-enquiry-0001',
    expectedRevision: offer.revision,
    message: 'Please confirm availability.',
  };
  const { enquiry } = await f.service.enquire(buyer, offer.id, enquiryBody);
  const restarted = fixture(f.serialized());
  assert.equal(
    (await restarted.service.create(seller, body)).offer.id,
    offer.id,
  );
  assert.equal(
    (await restarted.service.enquire(buyer, offer.id, enquiryBody)).enquiry.id,
    enquiry.id,
  );
  assert.equal(restarted.service.list().count, 1);
  assert.equal(restarted.service.listEnquiries(seller).count, 1);
  const publicCopy = restarted.service.detail(offer.id);
  publicCopy.offer.description = 'Client-side alteration';
  assert.notEqual(
    restarted.service.detail(offer.id).offer.description,
    publicCopy.offer.description,
  );
});

test('durable write limits do not penalize retries and cannot be reset by recreating the service', async () => {
  const f = fixture(),
    seller = member();
  const first = publication();
  await f.service.create(seller, first);
  for (let i = 1; i < 30; i++)
    await f.service.create(
      seller,
      publication(`rate-intent-${String(i).padStart(4, '0')}`),
    );
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.service.create(seller, first)).offer.title,
      first.title,
    );
  await assert.rejects(
    f.service.create(seller, publication('rate-over-0001')),
    refusal(429, 'trade_rate_limited'),
  );
  const restarted = fixture(f.serialized());
  await assert.rejects(
    restarted.service.create(seller, publication('rate-over-0002')),
    refusal(429, 'trade_rate_limited'),
  );
  f.advance(60000);
  assert.equal(
    (await f.service.create(seller, publication('rate-next-window-0001'))).offer
      .availability,
    'open',
  );
});

test('later owner edits cannot rewrite the title, exact price or revision recorded with an enquiry', async () => {
  const f = fixture(),
    seller = member(),
    buyer = member();
  const { offer } = await f.service.create(seller, publication());
  const { enquiry } = await f.service.enquire(buyer, offer.id, {
    clientRequestId: 'snapshot-enquiry-0001',
    expectedRevision: offer.revision,
    message: 'Please discuss availability.',
  });
  const { offer: edited } = await f.service.update(seller, offer.id, {
    title: 'A different published service',
    price: '99.000001',
    publish: true,
  });
  assert.equal(offer.revision, 1);
  assert.equal(edited.revision, 2);
  const saved = f.service.listEnquiries(buyer).enquiries[0];
  assert.equal(saved.id, enquiry.id);
  assert.equal(saved.offer.title, 'Review a reproducibility package');
  assert.equal(saved.offer.price, '12.000001');
  assert.equal(saved.offer.priceUnits, '12000001');
  assert.equal(saved.offer.revision, 1);
  assert.equal(saved.binding, false);
  assert.equal(
    f.service.list({ search: 'different published service' }).count,
    1,
  );
});

test('the per-owner open-offer limit is durable and a withdrawal frees only an open slot', async () => {
  const f = fixture(),
    seller = member();
  let first;
  for (let i = 0; i < 100; i++) {
    const result = await f.service.create(
      seller,
      publication(`owner-cap-${String(i).padStart(4, '0')}`),
    );
    first ??= result.offer;
    f.advance(60000);
  }
  await assert.rejects(
    f.service.create(seller, publication('owner-cap-over-0001')),
    refusal(429, 'offer_limit'),
  );
  await f.service.withdraw(seller, first.id);
  const replacement = await f.service.create(
    seller,
    publication('owner-cap-replacement'),
  );
  assert.equal(replacement.offer.availability, 'open');
  assert.equal(f.service.list({ owner: seller.address }).count, 100);
  assert.equal(
    f.service.list({ owner: seller.address, availability: 'all' }).count,
    101,
  );
});

test('maximum permitted publication text still produces a bounded page rather than an oversized response', async () => {
  const f = fixture(),
    seller = member();
  const description = 'x' + '\n'.repeat(3998) + 'x';
  for (let i = 0; i < 25; i++)
    await f.service.create(
      seller,
      publication(`response-limit-${String(i).padStart(4, '0')}`, {
        title: 'T'.repeat(160),
        category: 'C'.repeat(80),
        description,
      }),
    );
  const page = f.service.list({ pageSize: 25 });
  assert.equal(page.offers.length, 25);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
});
