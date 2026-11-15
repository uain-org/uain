import test from 'node:test';
import assert from 'node:assert/strict';
import * as tradeListings from './trade-listings.js';
const a = 'uain1' + 'a'.repeat(40),
  b = 'uain1' + 'b'.repeat(40);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
test('provider listings bind the actual owner filter and suppress late rows and errors after a different selection', async () => {
  assert.equal(typeof tradeListings.createTradeListingsReader, 'function');
  const pending = [],
    events = [];
  const reader = tradeListings.createTradeListingsReader(
    (path) => {
      const job = deferred();
      pending.push({ path, ...job });
      return job.promise;
    },
    (event) => events.push(event),
  );
  const old = reader.load({ provider: a, page: 2, search: 'reasoning' });
  const current = reader.load({ provider: b, page: 1, search: '' });
  assert.equal(
    new URL(pending[0].path, 'https://baink.money').searchParams.get('owner'),
    a,
  );
  assert.equal(
    new URL(pending[1].path, 'https://baink.money').searchParams.get('owner'),
    b,
  );
  assert.equal(events.at(-1).data, null);
  pending[1].resolve({
    offers: [{ id: 'b-offer', owner: b }],
    count: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
  });
  await current;
  pending[0].resolve({
    offers: [{ id: 'a-offer', owner: a }],
    count: 1,
    page: 2,
    pageSize: 20,
    pages: 2,
  });
  await old;
  assert.deepEqual(
    events.at(-1).data.offers.map((row) => row.id),
    ['b-offer'],
  );
  const oldFailure = reader.load({ provider: a, page: 1, search: '' });
  const cleared = reader.load({ provider: null, page: 1, search: '' });
  assert.equal(
    new URL(pending[3].path, 'https://baink.money').searchParams.has('owner'),
    false,
  );
  assert.equal(events.at(-1).data, null);
  pending[3].resolve({ offers: [], count: 0, page: 1, pageSize: 20, pages: 1 });
  await cleared;
  const eventCount = events.length;
  pending[2].reject(Error('old provider failure'));
  await oldFailure;
  assert.equal(events.length, eventCount);
  assert.deepEqual(events.at(-1).data.offers, []);
});
test('foreign-provider results fail closed and disposed readers cannot publish late results', async () => {
  assert.equal(typeof tradeListings.createTradeListingsReader, 'function');
  const events = [],
    job = deferred();
  const reader = tradeListings.createTradeListingsReader(
    () => job.promise,
    (event) => events.push(event),
  );
  const reading = reader.load({ provider: a, page: 1, search: '' });
  job.resolve({
    offers: [{ id: 'foreign', owner: b }],
    count: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
  });
  await reading;
  assert.equal(events.at(-1).data, null);
  assert.match(events.at(-1).error, /provider/i);
  const later = deferred(),
    lateEvents = [];
  const closing = tradeListings.createTradeListingsReader(
    () => later.promise,
    (event) => lateEvents.push(event),
  );
  const work = closing.load({ provider: a, page: 1, search: '' });
  closing.dispose();
  const count = lateEvents.length;
  later.resolve({
    offers: [{ id: 'a', owner: a }],
    count: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
  });
  await work;
  assert.equal(lateEvents.length, count);
});
test('invalidating a pending filter clears rows immediately and refuses late publication until a new load', async () => {
  const events = [],
    job = deferred();
  const reader = tradeListings.createTradeListingsReader(
    () => job.promise,
    (event) => events.push(event),
  );
  const work = reader.load({ provider: a, page: 3, search: 'old' });
  reader.invalidate();
  assert.equal(events.at(-1).data, null);
  const count = events.length;
  job.resolve({
    offers: [{ id: 'old-page', owner: a }],
    count: 41,
    page: 3,
    pageSize: 20,
    pages: 3,
  });
  await work;
  assert.equal(events.length, count);
  assert.equal(events.at(-1).loading, true);
});
test('an invalid or closed provider intent never reaches the transport', async () => {
  let reads = 0;
  const events = [];
  const reader = tradeListings.createTradeListingsReader(
    async () => {
      reads++;
      return { offers: [] };
    },
    (event) => events.push(event),
  );
  await reader.load({ provider: 'https://elsewhere.test' });
  assert.equal(reads, 0);
  assert.equal(events.at(-1).data, null);
  assert.match(events.at(-1).error, /provider/i);
  reader.dispose();
  await reader.load({ provider: a });
  assert.equal(reads, 0);
});
test('resetting pagination while new search text is debouncing cannot load the previous search terms', async () => {
  const calls = [],
    events = [];
  const reader = tradeListings.createTradeListingsReader(
    async (path) => {
      calls.push(path);
      return { offers: [], count: 0, page: 1, pageSize: 20, pages: 1 };
    },
    (event) => events.push(event),
  );
  await reader.load({
    provider: a,
    page: 1,
    search: 'new terms',
    settledSearch: 'old terms',
  });
  assert.equal(calls.length, 0);
  assert.equal(events.at(-1).data, null);
  assert.equal(events.at(-1).loading, true);
  await reader.load({
    provider: a,
    page: 1,
    search: 'new terms',
    settledSearch: 'new terms',
  });
  assert.equal(calls.length, 1);
  const query = new URL(calls[0], 'https://baink.money').searchParams;
  assert.equal(query.get('search'), 'new terms');
  assert.equal(query.get('page'), '1');
});
