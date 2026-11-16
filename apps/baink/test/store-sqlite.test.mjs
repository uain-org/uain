import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadStore } from '../server/app.mjs';
import { createGroupCommitStore } from '../server/store.mjs';
import { coalesce, createChangeTracker, diffStates, readPersistedState, stateDigest, canonicalState, StateDatabase, StateWriter } from '../server/store-sqlite.mjs';

const fictional = (n) => `uain1${String(n).padStart(40, '0')}`;
function legacyState(extra = {}) {
  const accounts = {}, requests = {}, history = [];
  for (let i = 0; i < 30; i++) accounts[fictional(i)] = { address: fictional(i), displayName: `Fictional ${i}`, createdAt: '2026-11-10T00:00:00.000Z' };
  for (let i = 0; i < 12; i++) { requests[`r-${i}`] = { id: `r-${i}`, from: fictional(i), to: fictional(i + 1), amount: '0.000001', memo: `memo ${i} ✓` }; history.push({ id: `h-${i}`, at: i }); }
  return { version: 1, accounts, requests, nonces: { [`${fictional(1)}:n1`]: Date.now() + 60_000 }, history, nativeIntents: {}, centralEarningIntents: { z: { id: 'z', member: fictional(2), status: 'finalized' }, a: { id: 'a', member: fictional(3), status: 'finalized' } }, peerMessages: { conversations: { c1: { id: 'c1', messages: [{ body: 'hello' }] } } }, ...extra };
}
async function dir(t) { const d = await mkdtemp(join(tmpdir(), 'baink-sqlite-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const plain = (s) => JSON.parse(JSON.stringify(s));

test('first start imports state.json, verifies counts and content hash, and leaves the file unchanged', async (t) => {
  const d = await dir(t), state = legacyState(), bytes = JSON.stringify(state);
  await writeFile(join(d, 'state.json'), bytes, { mode: 0o600 });
  const store = await loadStore(d);
  assert.deepEqual(plain(store.read()), state);
  assert.equal(store.account(fictional(3)).displayName, 'Fictional 3');
  await store.close();
  const db = new DatabaseSync(join(d, 'state.sqlite'), { readOnly: true });
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  db.close();
  assert.equal(meta.content_sha256, stateDigest(state));
  assert.deepEqual(JSON.parse(meta.import_counts), { version: 1, accounts: 30, requests: 12, nonces: 1, history: 12, nativeIntents: 0, centralEarningIntents: 2, peerMessages: 1 });
  // No commit happened, so the clean close did not rewrite the source file.
  assert.equal(await readFile(join(d, 'state.json'), 'utf8'), bytes);
  assert.equal((await stat(join(d, 'state.sqlite'))).mode & 0o777, 0o600);
  // Insertion order of map keys survives the round trip ("z" before "a").
  assert.deepEqual(Object.keys(readPersistedState(d).centralEarningIntents), ['z', 'a']);
});

test('commits write only changed rows and a clean close exports state.json for the previous release', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState()), { mode: 0o600 });
  const store = await loadStore(d);
  const before = readPersistedState(d);
  await store.transactNonces((s) => { s.nonces[`${fictional(4)}:n2`] = Date.now() + 60_000; });
  await store.transact((s) => { s.accounts[fictional(5)].displayName = 'Renamed'; s.accounts[fictional(99)] = { address: fictional(99), displayName: 'New' }; delete s.accounts[fictional(6)]; });
  await store.transactRequestCreate((s) => { s.requests['r-new'] = { id: 'r-new', memo: 'appended' }; s.history.push({ id: 'h-new' }); });
  const after = readPersistedState(d);
  assert.equal(after.accounts[fictional(5)].displayName, 'Renamed');
  assert.equal(after.accounts[fictional(99)].displayName, 'New');
  assert.equal(after.accounts[fictional(6)], undefined);
  assert.equal(Object.keys(after.accounts).at(-1), fictional(99));
  assert.equal(after.requests['r-new'].memo, 'appended');
  assert.equal(after.history.length, before.history.length + 1);
  assert.deepEqual(after.centralEarningIntents, before.centralEarningIntents);
  assert.deepEqual(after, plain(store.read()));
  await store.close();
  const exported = JSON.parse(await readFile(join(d, 'state.json'), 'utf8'));
  assert.deepEqual(exported, after);
  assert.equal((await stat(join(d, 'state.json'))).mode & 0o777, 0o600);
  // The export is not re-imported on the next start (its hash is recorded).
  const again = await loadStore(d);
  assert.deepEqual(plain(again.read()), after);
  await again.close();
  assert.equal((await readdir(d)).filter((f) => f.includes('before-reimport')).length, 0);
});

test('a state.json changed by an older release after rollback is re-imported, keeping the replaced database', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState()), { mode: 0o600 });
  let store = await loadStore(d);
  await store.transact((s) => { s.accounts[fictional(1)].displayName = 'Written by SQLite release'; });
  await store.close();
  // Rollback: the previous release reads the export and writes its own change.
  const old = JSON.parse(await readFile(join(d, 'state.json'), 'utf8'));
  assert.equal(old.accounts[fictional(1)].displayName, 'Written by SQLite release');
  old.accounts[fictional(2)].displayName = 'Written by previous release';
  await writeFile(join(d, 'state.json'), JSON.stringify(old), { mode: 0o600 });
  // Roll forward: the newer state.json wins, nothing written before is lost.
  store = await loadStore(d);
  assert.equal(store.account(fictional(1)).displayName, 'Written by SQLite release');
  assert.equal(store.account(fictional(2)).displayName, 'Written by previous release');
  await store.close();
  assert.equal((await readdir(d)).filter((f) => f.startsWith('state.sqlite.before-reimport-')).length, 1);
});

test('after a crash the database, not the older state.json export, is the state', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState()), { mode: 0o600 });
  const store = await loadStore(d);
  await store.transact((s) => { s.accounts[fictional(7)].displayName = 'Committed before crash'; });
  // Simulate a crash: no close, no export. Another process opens the data.
  const snapshot = readPersistedState(d);
  assert.equal(snapshot.accounts[fictional(7)].displayName, 'Committed before crash');
  assert.notEqual(JSON.parse(await readFile(join(d, 'state.json'), 'utf8')).accounts[fictional(7)].displayName, 'Committed before crash');
  await store.close();
});

test('two hundred concurrent writers of every kind are all durable and reload exactly', async (t) => {
  const d = await dir(t);
  const store = await loadStore(d);
  const work = [];
  for (let i = 0; i < 200; i++) {
    const address = fictional(1000 + i);
    if (i % 4 === 0) work.push(store.transact((s) => { s.accounts[address] = { address, displayName: `Writer ${i}` }; return i; }));
    else if (i % 4 === 1) work.push(store.transactNonces((s) => { s.nonces[`${address}:n${i}`] = Date.now() + 300_000; }));
    else if (i % 4 === 2) work.push(store.transactRequestCreate((s) => { s.requests[`req-${i}`] = { id: `req-${i}`, from: address }; s.history.push({ request: `req-${i}` }); }));
    else work.push(store.transactMessages((s) => { s.peerMessages ??= { conversations: {} }; s.peerMessages.conversations[`c-${i}`] = { id: `c-${i}`, messages: [{ body: `m${i}` }] }; }));
  }
  const results = await Promise.allSettled(work);
  // The bounded queue may refuse with storage_busy; every acknowledged write must persist.
  const acknowledged = results.map((r, i) => r.status === 'fulfilled' ? i : -1).filter((i) => i >= 0);
  for (const r of results) if (r.status === 'rejected') assert.equal(r.reason.code, 'storage_busy');
  assert.ok(acknowledged.length >= 128);
  const live = plain(store.read());
  await store.close();
  const reopened = await loadStore(d);
  const reloaded = plain(reopened.read());
  assert.deepEqual(reloaded, live);
  assert.equal(canonicalState(reloaded), canonicalState(JSON.parse(await readFile(join(d, 'state.json'), 'utf8'))));
  for (const i of acknowledged) {
    const address = fictional(1000 + i);
    if (i % 4 === 0) assert.equal(reloaded.accounts[address].displayName, `Writer ${i}`);
    else if (i % 4 === 1) assert.ok(reloaded.nonces[`${address}:n${i}`]);
    else if (i % 4 === 2) assert.equal(reloaded.requests[`req-${i}`].from, address);
    else assert.equal(reloaded.peerMessages.conversations[`c-${i}`].messages[0].body, `m${i}`);
  }
  await reopened.close();
});

test('the change tracker turns hinted transactions into row operations without rewriting other sections', async () => {
  const base = legacyState(), tracker = createChangeTracker({ initialState: base, maxStoreBytes: 1e8, maxMetadataBytes: 1e8, fail: (s, c) => { throw Object.assign(new Error(c), { status: s, code: c }); } });
  const persisted = [];
  const store = createGroupCommitStore({ initialState: base, initialStateOwned: true, validate: tracker.validate, persist: async (next) => { persisted.push(tracker.changesTo(next)); tracker.settle(next); } });
  await store.transactNonces((s) => { s.nonces['x:n'] = 1; });
  await store.transact((s) => { s.centralEarningIntents.a.status = 'expired'; });
  assert.deepEqual(persisted[0], [['set', 'nonces', 'x:n', '1']]);
  assert.deepEqual(persisted[1], [['set', 'centralEarningIntents', 'a', JSON.stringify({ id: 'a', member: fictional(3), status: 'expired' })]]);
  // A full diff from the original agrees with the incremental chain.
  const full = diffStates(base, plain(store.read()));
  assert.ok(full.some((op) => op[1] === 'nonces') && full.some((op) => op[1] === 'centralEarningIntents'));
  await store.close();
});

test('capacity is measured incrementally and refuses growth without changing durable rows', async (t) => {
  const base = legacyState();
  const size = JSON.stringify(base).length;
  const tracker = createChangeTracker({ initialState: base, maxStoreBytes: size + 4096, maxMetadataBytes: size + 2048, fail: (s, c) => { throw Object.assign(new Error(c), { status: s, code: c }); } });
  const store = createGroupCommitStore({ initialState: base, initialStateOwned: true, validate: tracker.validate, persist: async (next) => tracker.settle(next) });
  await store.transact((s) => { s.accounts.small = { note: 'x'.repeat(100) }; });
  await assert.rejects(store.transact((s) => { s.accounts.big = { note: 'x'.repeat(4000) }; }), /storage_capacity/);
  assert.equal(store.read().accounts.big, undefined);
  assert.ok(tracker.validate.measure(tracker.durable).metadata < size + 2048);
  await store.close();
});

test('reads copy only what they touch and never expose committed records', async () => {
  const store = createGroupCommitStore({ initialState: legacyState(), validate: () => {}, persist: async () => {} });
  const view = store.read();
  assert.ok('value' in Object.getOwnPropertyDescriptor(view, 'accounts'));
  view.accounts[fictional(1)].displayName = 'Changed only in this view';
  delete view.requests;
  view.extra = true;
  const fresh = store.read();
  assert.equal(fresh.accounts[fictional(1)].displayName, 'Fictional 1');
  assert.ok(fresh.requests['r-1']);
  assert.equal('extra' in fresh, false);
  assert.deepEqual(Object.keys(fresh), Object.keys(legacyState()));
  // A transaction that returns its own draft root receives a detached copy.
  const returned = await store.transact((s) => { s.accounts[fictional(2)].displayName = 'Committed'; return s; });
  returned.accounts[fictional(2)].displayName = 'Alias';
  assert.equal(store.read().accounts[fictional(2)].displayName, 'Committed');
  await store.close();
});

test('committed state versions are released once durable (no retained history of states)', async (t) => {
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose_gc');
  const gc = runInNewContext('gc');
  const d = await dir(t);
  const nonces = {};
  for (let i = 0; i < 400; i++) nonces[`${fictional(i)}:${'n'.repeat(40)}${i}`] = Date.now() + 300_000;
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState({ nonces })), { mode: 0o600 });
  const store = await loadStore(d);
  const commit = (i) => store.transactNonces((s) => { s.nonces[`${fictional(i % 400)}:${'m'.repeat(40)}${i}`] = Date.now() + 300_000; delete s.nonces[Object.keys(s.nonces)[0]]; });
  for (let i = 0; i < 200; i++) await commit(i);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 200; i < 2200; i++) await commit(i);
  gc(); gc();
  const grown = process.memoryUsage().heapUsed - before;
  // 2,000 versions of a 400-entry nonce map would retain well over 40 MB.
  assert.ok(grown < 12 * 1024 * 1024, `heap grew ${Math.round(grown / 1048576)} MB`);
  await store.close();
});

test('a slow disk delays only the commit: pages, reads and timers keep running', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState()), { mode: 0o600 });
  // Every commit takes 400 ms, like an fsync behind a busy disk.
  const store = await loadStore(d, { commitDelayMs: 400 });
  const started = performance.now();
  let acknowledged = null;
  const write = store.transactNonces((s) => { s.nonces[`${fictional(7)}:slow`] = Date.now() + 60_000; }).then(() => { acknowledged = performance.now() - started; });
  // While the commit is in the worker, the main thread still answers.
  const lags = [];
  for (let i = 0; i < 5; i++) { const at = performance.now(); await new Promise((r) => setTimeout(r, 20)); lags.push(performance.now() - at - 20); }
  assert.ok(Math.max(...lags) < 150, `event loop paused ${Math.round(Math.max(...lags))} ms during a slow commit`);
  assert.equal(acknowledged, null, 'the write was acknowledged before its commit finished');
  assert.equal(store.read().nonces[`${fictional(7)}:slow`], undefined, 'readers saw a write that was not yet durable');
  await write;
  assert.ok(acknowledged >= 380, `acknowledged after ${Math.round(acknowledged)} ms, before the slow commit finished`);
  assert.ok(readPersistedState(d).nonces[`${fictional(7)}:slow`]);
  await store.close();
});

test('the state writer refuses every call after it stops, so the store fails closed', async (t) => {
  const d = await dir(t);
  new StateDatabase(d).close();
  const writer = new StateWriter(d);
  await writer.ready;
  await writer.commit([['section', 'accounts', 'map'], ['set', 'accounts', 'a', JSON.stringify({ address: 'a' })]]);
  await writer.worker.terminate();
  await assert.rejects(writer.commit([['set', 'accounts', 'b', '{}']]), /state writer stopped/);
  await writer.close();
  assert.deepEqual(Object.keys(readPersistedState(d).accounts), ['a']);
  // A writer that cannot open its database never becomes ready.
  const missing = new StateWriter(join(d, 'no-such-directory'));
  await assert.rejects(missing.ready);
  await missing.close();
});

test('the state writer starts when BAINK runs from --input-type=module --eval (the packaged runtime check)', async (t) => {
  const d = await dir(t);
  const module = pathToFileURL(join(import.meta.dirname, '..', 'server', 'store-sqlite.mjs')).href;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { StateDatabase, StateWriter } from ${JSON.stringify(module)};
    new StateDatabase(${JSON.stringify(d)}).close();
    const writer = new StateWriter(${JSON.stringify(d)});
    await writer.ready;
    await writer.commit([['section', 'accounts', 'map']]);
    await writer.close();
    console.log('WRITER_OK');`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /WRITER_OK/);
});

// 13 November 2026 (B1-1): a group of transactions that each rewrote the same
// row sent that row once per transaction to the 64 MB writer in one call.
test('a commit carries each row once and applies exactly as the uncoalesced op list', async (t) => {
  const ops = [
    ['section', 'm', 'map'], ['set', 'm', 'a', '1'], ['set', 'm', 'b', '2'], ['set', 'm', 'a', '3'],
    ['del', 'm', 'b'], ['set', 'm', 'b', '4'], ['set', 'm', 'b', '5'], ['set', 'm', 'c', '6'], ['set', 'm', 'a', '7'],
    ['section', 'h', 'array'], ['set', 'h', '0', '"x"'], ['set', 'h', '1', '"y"'], ['set', 'h', '0', '"z"'], ['trim', 'h', 1], ['set', 'h', '1', '"w"'],
    ['set', 'm', 'c', '8'], ['drop', 'm'], ['section', 'm', 'map'], ['set', 'm', 'q', '9'], ['set', 'm', 'q', '10'],
  ];
  const folded = coalesce(ops);
  assert.equal(folded.filter((op) => op[0] === 'set' && op[1] === 'm' && op[2] === 'q').length, 1);
  assert.ok(folded.length < ops.length);
  const plainDb = new StateDatabase(await dir(t)), foldedDb = new StateDatabase(await dir(t));
  plainDb.commit(ops); foldedDb.commit(folded);
  assert.deepEqual(foldedDb.load(), plainDb.load());
  assert.deepEqual(Object.keys(foldedDb.load().m), Object.keys(plainDb.load().m));
  plainDb.close(); foldedDb.close();
  // Through the store: 32 concurrent sends to one big row all reach the disk.
  const d = await dir(t);
  await writeFile(join(d, 'state.json'), JSON.stringify(legacyState({ peerMessages: { conversations: { c1: { id: 'c1', messages: [] } } } })), { mode: 0o600 });
  const store = await loadStore(d);
  await Promise.all(Array.from({ length: 32 }, (_, i) => store.transactMessages((s) => { s.peerMessages.conversations.c1.messages.push({ i, body: 'x'.repeat(1000) }); })));
  assert.equal(readPersistedState(d).peerMessages.conversations.c1.messages.length, 32);
  await store.close();
});

test('a writer that dies on its own reports once so the process can exit; a clean close does not', async (t) => {
  const d = await dir(t);
  new StateDatabase(d).close();
  const failures = [];
  const writer = new StateWriter(d, { onFailure: (error) => failures.push(error.message) });
  await writer.ready;
  await writer.worker.terminate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /state writer stopped/);
  await writer.close();
  assert.equal(failures.length, 1);
  const clean = new StateWriter(d, { onFailure: (error) => failures.push(error.message) });
  await clean.ready;
  await clean.close();
  assert.equal(failures.length, 1);
});
