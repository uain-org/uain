import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTradeTermsRecovery } from './trade-terms-recovery.js';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function holder(byte = 7) {
  const bytes = Buffer.alloc(32, byte);
  return { address: 'uain1' + createHash('sha256').update(bytes).digest('hex').slice(0, 40), publicKeyBase64: bytes.toString('base64') };
}
const owner = holder(), peer = holder(8);
function scope(n = 1) {
  return {
    ...owner,
    enquiry: {
      id: id(n), kind: 'nonbinding-enquiry', offerId: id(900),
      buyer: owner.address, seller: peer.address,
      message: 'Please discuss a bounded synthetic CSV review.',
      offer: { title: 'Synthetic CSV review', price: '0.000001', priceUnits: '1', currency: 'AI$', revision: 1 },
      createdAt: '2026-11-02T00:00:00.000Z', binding: false, settlementAvailable: false,
    },
  };
}
function terms(change = {}) {
  return {
    scope: 'Inspect the synthetic CSV.', deliverables: 'One CSV and a reproducible note.',
    price: '0.000001', timeline: 'Three business days.',
    acceptanceCriteria: 'Report the agreed checks and uncertainties.', expiresAt: null,
    ...change,
  };
}
function request(kind = 'create', n = 1) {
  const clientRequestId = 'recovery-http-intent-' + String(n).padStart(3, '0');
  if (kind === 'send') return { kind, draftId: id(500), body: { clientRequestId, expectedRevision: 2, confirmNonbinding: true }, reviewedTerms: { ...terms(), priceUnits: '1', currency: 'AI$' } };
  return { kind, draftId: kind === 'create' ? null : id(500), body: { clientRequestId, ...(kind === 'update' ? { expectedRevision: 2 } : {}), terms: terms() }, reviewedTerms: null };
}
const snapshot = (storage) => JSON.stringify([...storage.data]);
const noRecovery = (recovery, value) => {
  let result, refused = false;
  try { result = recovery.read(value); } catch (e) { assert.ok(e instanceof Error); refused = true; }
  if (!refused) assert.equal(result, null);
};

test('create, update and send recover the exact reviewed request after a new helper instance', () => {
  for (const kind of ['create', 'update', 'send']) {
    const storage = memoryStorage(), context = scope(), pending = request(kind);
    assert.equal(createTradeTermsRecovery(storage).read(context), null);
    createTradeTermsRecovery(storage).write(context, pending);
    const remounted = createTradeTermsRecovery(storage);
    assert.deepEqual(remounted.read(structuredClone(context)), pending);
    assert.deepEqual(createTradeTermsRecovery(storage).read(context), pending);
    assert.equal(remounted.read(context).body.clientRequestId, pending.body.clientRequestId);
  }
});

test('write snapshots and read results cannot mutate the persisted request or reviewed terms', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage);
  const context = scope(), pending = request('send'), expected = structuredClone(pending);
  recovery.write(context, pending);
  pending.body.expectedRevision = 999;
  pending.reviewedTerms.scope = 'Changed after request was reviewed';
  const result = recovery.read(context);
  assert.deepEqual(result, expected);
  result.body.clientRequestId = 'changed-return-value';
  result.reviewedTerms.priceUnits = '999';
  assert.deepEqual(recovery.read(context), expected);
});

test('owner, public key and every reviewed enquiry snapshot field isolate pending recovery', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope();
  recovery.write(context, request());
  const another = holder(9);
  for (const change of [
    s => { s.address = another.address; s.publicKeyBase64 = another.publicKeyBase64; s.enquiry.buyer = another.address; },
    s => { s.publicKeyBase64 = another.publicKeyBase64; },
    s => { s.enquiry.id = id(2); },
    s => { s.enquiry.offerId = id(901); },
    s => { s.enquiry.message += ' Changed context.'; },
    s => { s.enquiry.createdAt = '2026-11-02T01:00:00.000Z'; },
    s => { s.enquiry.offer.title += ' Changed'; },
    s => { s.enquiry.offer.price = '0.000002'; s.enquiry.offer.priceUnits = '2'; },
    s => { s.enquiry.offer.revision = 2; },
  ]) {
    const changed = structuredClone(context); change(changed); noRecovery(recovery, changed);
  }
  assert.deepEqual(recovery.read(context), request());
});

test('a late acknowledgement cannot clear a newer retained request', () => {
  const storage = memoryStorage(), oldHelper = createTradeTermsRecovery(storage), context = scope();
  const previous = request('send', 1), newer = request('send', 2);
  oldHelper.write(context, previous);
  oldHelper.clear(context, previous.body.clientRequestId);
  assert.equal(oldHelper.read(context), null);
  createTradeTermsRecovery(storage).write(context, newer);
  const before = snapshot(storage);
  oldHelper.clear(context, previous.body.clientRequestId);
  assert.equal(snapshot(storage), before);
  assert.deepEqual(createTradeTermsRecovery(storage).read(context), newer);
  oldHelper.clear(context, newer.body.clientRequestId);
  assert.equal(createTradeTermsRecovery(storage).read(context), null);
});

test('malformed or tampered storage fails closed without erasing pending data', () => {
  for (const corrupt of [
    () => '{invalid-json',
    () => 'null',
    () => '[]',
    () => JSON.stringify({ unsupported: true }),
    raw => { const value = JSON.parse(raw); if (Array.isArray(value)) value.push({ privateKey: 'synthetic-forbidden-value' }); else value.privateKey = 'synthetic-forbidden-value'; return JSON.stringify(value); },
  ]) {
    const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope(), pending = request();
    recovery.write(context, pending);
    const [key, raw] = [...storage.data][0];
    storage.data.set(key, corrupt(raw));
    const before = snapshot(storage);
    assert.throws(() => recovery.read(context));
    assert.throws(() => recovery.write(scope(2), request('create', 2)));
    assert.throws(() => recovery.clear(context, pending.body.clientRequestId));
    assert.equal(snapshot(storage), before);
  }
});

test('unavailable reads, writes and readback mismatches stop persistence instead of allowing a new send', () => {
  for (const unavailable of [undefined, null, {}, { getItem() { throw Error('storage denied'); } }, { getItem() { return undefined; }, setItem() {}, removeItem() {} }])
    assert.throws(() => createTradeTermsRecovery(unavailable).read(scope()));
  for (const mode of ['get-throws', 'set-throws', 'readback-null', 'readback-invalid', 'readback-throws']) {
    const storage = memoryStorage(), originalGet = storage.getItem.bind(storage), originalSet = storage.setItem.bind(storage);
    let written = false;
    storage.getItem = key => {
      if (mode === 'get-throws' || (written && mode === 'readback-throws')) throw Error('storage unavailable');
      if (written && mode === 'readback-null') return null;
      if (written && mode === 'readback-invalid') return 'invalid-after-write';
      return originalGet(key);
    };
    storage.setItem = (key, value) => {
      if (mode === 'set-throws') throw Error('quota or storage denied');
      originalSet(key, value); written = true;
    };
    let sendCount = 0;
    assert.throws(() => {
      createTradeTermsRecovery(storage).write(scope(), request());
      sendCount++;
    }, mode);
    assert.equal(sendCount, 0, mode);
  }
});

test('failed clear retains an unresolved request so it remains recoverable', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope(), pending = request();
  recovery.write(context, pending);
  const before = snapshot(storage);
  storage.setItem = () => { throw Error('storage denied'); };
  storage.removeItem = () => { throw Error('storage denied'); };
  assert.throws(() => recovery.clear(context, pending.body.clientRequestId));
  assert.equal(snapshot(storage), before);
  assert.deepEqual(recovery.read(context), pending);
});

test('the 32-entry cap refuses a new context without evicting any unresolved request', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage);
  for (let i = 1; i <= 32; i++) recovery.write(scope(i), request('create', i));
  const before = snapshot(storage);
  assert.throws(() => recovery.write(scope(33), request('create', 33)));
  assert.equal(snapshot(storage), before);
  for (let i = 1; i <= 32; i++) assert.deepEqual(recovery.read(scope(i)), request('create', i));
});

test('the 256KiB byte bound refuses a large bucket before 32 entries without silent eviction', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), retained = [];
  let refused = false;
  for (let i = 1; i <= 32; i++) {
    const context = scope(i), pending = request('create', i);
    context.enquiry.message = 'M'.repeat(2000);
    pending.body.terms = terms({ scope: 'S'.repeat(2048), deliverables: 'D'.repeat(2048), timeline: 'T'.repeat(1024), acceptanceCriteria: 'A'.repeat(2048) });
    const before = snapshot(storage);
    try { recovery.write(context, pending); retained.push([context, pending]); }
    catch (e) { assert.ok(e instanceof Error); assert.equal(snapshot(storage), before); refused = true; break; }
  }
  assert.equal(refused, true);
  assert.ok(retained.length > 0 && retained.length < 32);
  for (const [context, pending] of retained) assert.deepEqual(recovery.read(context), pending);
});

test('unsupported identity secrets and authority fields are rejected before any bytes are persisted', () => {
  for (const change of [
    (s, r) => { s.privateKey = 'synthetic-forbidden-private-key'; },
    (s, r) => { s.identity = { privateKey: 'synthetic-forbidden-private-key' }; },
    (s, r) => { s.enquiry.privateKey = 'synthetic-forbidden-private-key'; },
    (s, r) => { r.privateKey = 'synthetic-forbidden-private-key'; },
    (s, r) => { r.body.privateKey = 'synthetic-forbidden-private-key'; },
    (s, r) => { r.body.terms.nativeTransfer = true; },
  ]) {
    const storage = memoryStorage(), context = scope(), pending = request(); change(context, pending);
    assert.throws(() => createTradeTermsRecovery(storage).write(context, pending));
    assert.equal(storage.data.size, 0);
  }
});

test('canonical request, revision, price, expiry and snapshot validation reject malformed recoveries', () => {
  for (const change of [
    (s, r) => { s.address = 'invalid'; },
    (s, r) => { s.publicKeyBase64 = 'invalid'; },
    (s, r) => { s.enquiry.binding = true; },
    (s, r) => { s.enquiry.settlementAvailable = true; },
    (s, r) => { s.enquiry.offer.priceUnits = '999'; },
    (s, r) => { r.kind = 'delete'; },
    (s, r) => { r.draftId = id(500); },
    (s, r) => { r.body.clientRequestId = 1; },
    (s, r) => { r.body.terms.price = '0.0000001'; },
    (s, r) => { r.body.terms.scope = ''; },
    (s, r) => { r.body.terms.expiresAt = '2026-02-31T00:00:00.000Z'; },
  ]) {
    const storage = memoryStorage(), context = scope(), pending = request(); change(context, pending);
    assert.throws(() => createTradeTermsRecovery(storage).write(context, pending));
    assert.equal(storage.data.size, 0);
  }
  for (const change of [
    r => { r.draftId = null; },
    r => { r.body.expectedRevision = 0; },
    r => { r.body.confirmNonbinding = false; },
    r => { r.reviewedTerms.priceUnits = '999'; },
    r => { r.reviewedTerms.currency = 'USD'; },
  ]) {
    const storage = memoryStorage(), pending = request('send'); change(pending);
    assert.throws(() => createTradeTermsRecovery(storage).write(scope(), pending));
    assert.equal(storage.data.size, 0);
  }
});

test('an unresolved scope cannot be overwritten by a new ID, changed body or another operation', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope(), pending = request();
  recovery.write(context, pending);
  const before = snapshot(storage);
  recovery.write(context, structuredClone(pending));
  assert.equal(snapshot(storage), before);
  for (const replacement of [request('create', 2), request('update', 3), request('send', 4), { ...request(), body: { ...request().body, terms: terms({ scope: 'Changed body under the original unknown request ID.' }) } }]) {
    assert.throws(() => recovery.write(context, replacement));
    assert.equal(snapshot(storage), before);
    assert.deepEqual(recovery.read(context), pending);
  }
});

test('duplicate JSON keys and invalid bucket versions are not treated as empty recovery', () => {
  for (const corrupt of [
    raw => '{"version":1,' + raw.slice(1),
    raw => { const value = JSON.parse(raw); value.version = 999; return JSON.stringify(value); },
  ]) {
    const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope(), pending = request();
    recovery.write(context, pending);
    const [key, raw] = [...storage.data][0];
    storage.data.set(key, corrupt(raw));
    const before = snapshot(storage);
    assert.throws(() => recovery.read(context));
    assert.throws(() => recovery.write(scope(2), request('create', 2)));
    assert.equal(snapshot(storage), before);
  }
});

test('failed new-entry readback restores an earlier unresolved request when storage permits rollback', () => {
  const storage = memoryStorage(), recovery = createTradeTermsRecovery(storage), context = scope(), pending = request();
  recovery.write(context, pending);
  const originalSet = storage.setItem.bind(storage), before = snapshot(storage);
  let first = true;
  storage.setItem = (key, value) => {
    originalSet(key, first ? 'corrupted readback after attempted write' : value);
    first = false;
  };
  assert.throws(() => recovery.write(scope(2), request('create', 2)));
  assert.equal(snapshot(storage), before);
  assert.deepEqual(recovery.read(context), pending);
  assert.equal(recovery.read(scope(2)), null);
});
