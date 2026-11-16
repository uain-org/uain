import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';
import { MAX_METADATA_BYTES, MAX_STORE_BYTES, NONCE_HARD_CAP } from '../server/app.mjs';

test('combined metadata capacity refuses growth atomically while signed reads retain nonce headroom', async (t) => {
  const alice = member();
  const initialState = {
    version: 1,
    accounts: {
      [alice.address]: {
        address: alice.address,
        publicKey: alice.publicKey,
        displayName: 'Capacity fixture',
        createdAt: new Date().toISOString(),
      },
    },
    requests: {},
    nonces: {},
    history: [],
    retainedCompatibilityData: 'x'.repeat(MAX_METADATA_BYTES - 1024),
  };
  const f = await fixture(t, { initialState });
  assert.equal((await f.request(alice, 'GET', '/api/account')).status, 200);
  const result = await f.request(alice, 'PATCH', '/api/profile', {
    displayName: 'Too much metadata',
    summary: '€'.repeat(600),
    capabilities: [],
    services: [],
    languages: [],
    availability: 'open',
    website: '',
    publish: false,
    expectedVersion: 0,
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'storage_capacity');
  assert.equal((await f.request(alice, 'GET', '/api/account')).status, 200);
  assert.equal(
    (await f.request(alice, 'GET', '/api/profile')).body.profile,
    null,
  );
  const disk = readPersistedState(f.dataDir);
  assert.equal(disk.memberProfiles?.[alice.address], undefined);
  assert.equal(
    disk.retainedCompatibilityData.length,
    initialState.retainedCompatibilityData.length,
  );
});
test('oversized store fails closed before parsing or replacing retained records', async (t) => {
  await assert.rejects(
    fixture(t, {
      initialState: {
        version: 1,
        accounts: {},
        requests: {},
        nonces: {},
        history: [],
        oversize: 'x'.repeat(MAX_STORE_BYTES + 1024 * 1024),
      },
    }),
    /size|capacity/i,
  );
});

test('legacy metadata over the new write limit requires migration before startup reports healthy', async (t) => {
  await assert.rejects(
    fixture(t, {
      initialState: {
        version: 1,
        accounts: {},
        requests: {},
        nonces: {},
        history: [],
        retainedCompatibilityData: 'x'.repeat(MAX_METADATA_BYTES + 1024 * 1024),
      },
    }),
    /metadata.*migration/i,
  );
});

// Review of 13 November 2026: the nonce table must fit the 3 MiB the store
// keeps above the metadata cap, or a full table refuses metadata writes.
test('a nonce table at its hard cap of maximum-length nonces leaves metadata and payment writes working', async (t) => {
  const alice = member(), bob = member(), carol = member(), day = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const accounts = Object.fromEntries([alice, bob, carol].map((w) => [w.address, { address: w.address, publicKey: w.publicKey, displayName: 'Member', createdAt: day, updatedAt: day }]));
  const nonces = {}, expiry = Date.now() + 300_000;
  for (let i = 0; i < NONCE_HARD_CAP - 2; i++) nonces[`uain1${String(i % 100).padStart(40, '0')}:${String(i).padStart(128, 'n')}`] = expiry;
  const initialState = { version: 1, accounts, requests: {}, nonces, history: [], retainedCompatibilityData: 'x'.repeat(MAX_METADATA_BYTES - 64 * 1024) };
  const f = await fixture(t, { initialState });
  const patch = await f.request(alice, 'PATCH', '/api/account', { displayName: 'Still writable' });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  // A second member makes the payment request, as another member would.
  const pay = await f.request(bob, 'POST', '/api/requests', { to: alice.address, amount: '1.000000', clientRequestId: 'hard-cap-payment' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  // The table is now full: the next signed operation is refused as busy, not as storage.
  const next = await f.request(carol, 'GET', '/api/account');
  assert.equal(next.status, 429);
  assert.equal(next.body.error.code, 'busy');
});

// B1-1 (13 November 2026): member messages once grew one stored row without a
// byte bound, so a burst of maximal messages killed the 64 MB state writer and
// every later write answered storage_unavailable until a manual restart.
test('24 members sending 1,500 maximal messages in parallel never stop another member writing, before or after a restart', async (t) => {
  const f = await fixture(t, { trustProxy: true });
  const ip = (n) => ({ 'X-Real-IP': `198.51.100.${n}` });
  const victim = member(), sink = member();
  assert.equal((await f.request(victim, 'POST', '/api/account', { displayName: 'Victim' }, ip(200))).status, 201);
  assert.equal((await f.request(sink, 'POST', '/api/account', { displayName: 'Sink' }, ip(201))).status, 201);
  const senders = [];
  for (let i = 0; i < 24; i++) {
    const who = member(); who.ip = ip(i + 1);
    assert.equal((await f.request(who, 'POST', '/api/account', { displayName: 's' + i }, who.ip)).status, 201);
    const opened = await f.request(who, 'POST', '/api/messages/conversations', { to: sink.address, clientRequestId: randomBytes(9).toString('base64url') }, who.ip);
    assert.equal(opened.status, 201);
    who.conversation = opened.body.conversation.id;
    senders.push(who);
  }
  const body = '"'.repeat(2000), codes = {};
  async function burst(total) {
    let next = 0;
    await Promise.all(senders.map(async (who) => {
      while (next < total) {
        next++;
        const r = await f.request(who, 'POST', `/api/messages/conversations/${who.conversation}/messages`, { body, clientRequestId: randomBytes(9).toString('base64url') }, who.ip);
        const code = `${r.status}:${r.body?.error?.code ?? 'ok'}`;
        codes[code] = (codes[code] ?? 0) + 1;
        assert.notEqual(r.status, 503, `a message send answered ${code}`);
      }
    }));
  }
  await burst(1500);
  assert.ok(codes['201:ok'] > 0, JSON.stringify(codes));
  let patch = await f.request(victim, 'PATCH', '/api/account', { displayName: 'Victim 2' }, ip(200));
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  // The stored messages stay within their byte budget.
  const stored = Buffer.byteLength(JSON.stringify(readPersistedState(f.dataDir).peerMessages));
  assert.ok(stored < 5 * 1024 * 1024, `peer messages hold ${stored} bytes`);
  // Restart on the same data directory, then the same burst again.
  await f.restart();
  await burst(1500);
  patch = await f.request(victim, 'PATCH', '/api/account', { displayName: 'Victim 3' }, ip(200));
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal((await f.request(member(), 'POST', '/api/account', { displayName: 'Newcomer' }, ip(202))).status, 201);
});

// Second review, 13 November 2026: no member's messages are removed to make
// room for another's, so an older oversized row is never trimmed by others'
// sends. It never grows either: a sender over its own budget rotates its own
// messages, and a sender holding nothing is refused while the network is full.
test('a production store that already holds one oversized peer-message row starts and never grows; its senders rotate only their own', async (t) => {
  const alice = member(), bob = member(), others = Array.from({ length: 12 }, () => member());
  const now = new Date().toISOString();
  const accounts = Object.fromEntries([alice, bob, ...others].map((w) => [w.address, { address: w.address, publicKey: w.publicKey, displayName: 'x', createdAt: now, updatedAt: now }]));
  // 20 MB of messages in the single legacy "conversations" row (the old caps
  // allowed 5,000 messages of 2,000 bytes, a `"` stored as 2 bytes).
  const big = '"'.repeat(2000), conversations = {};
  others.forEach((other, c) => {
    const id = `00000000-0000-4000-8000-${String(c).padStart(12, '0')}`;
    conversations[id] = { id, participants: [alice.address, other.address].sort(), createdAt: now, updatedAt: now, readCursors: { [alice.address]: '0', [other.address]: '0' },
      messages: Array.from({ length: 400 }, (_, i) => ({ id: `${id}-${i}`, conversationId: id, sequence: String(i + 1), from: other.address, body: big, contentType: 'text/plain', createdAt: now, clientRequestId: `seed-${c}-${i}` })) };
  });
  const f = await fixture(t, { initialState: { version: 1, accounts, requests: {}, nonces: {}, history: [], peerMessages: { version: 1, conversations, openKeys: {}, messageKeys: {}, blocks: {}, reports: {} } } });
  const storedBytes = () => Buffer.byteLength(JSON.stringify(readPersistedState(f.dataDir).peerMessages));
  const before = storedBytes();
  const id = Object.keys(conversations)[1];
  // Alice holds no message: the full network refuses her and removes nothing.
  const refused = await f.request(alice, 'POST', `/api/messages/conversations/${id}/messages`, { body: 'hello after upgrade', clientRequestId: 'after-upgrade-1' });
  assert.equal(refused.status, 429, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'message_capacity');
  assert.equal(storedBytes(), before);
  // The heavy sender of that conversation sends: only its own oldest go.
  const sent = await f.request(others[1], 'POST', `/api/messages/conversations/${id}/messages`, { body: 'hello after upgrade', clientRequestId: 'after-upgrade-2' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  // The new message is numbered after everything this conversation ever held.
  assert.equal(sent.body.message.sequence, '401');
  const state = readPersistedState(f.dataDir).peerMessages.conversations;
  for (const [cid, c] of Object.entries(state)) if (cid !== id) assert.equal(c.messages.length, 400);
  assert.ok(storedBytes() < before);
  assert.equal((await f.request(bob, 'PATCH', '/api/account', { displayName: 'Bob' })).status, 200);
  await f.restart();
  assert.equal((await f.request(bob, 'PATCH', '/api/account', { displayName: 'Bob 2' })).status, 200);
});
