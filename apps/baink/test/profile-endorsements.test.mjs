import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createProfileEndorsements } from '../server/profile-endorsements.mjs';
const makeUser = () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40),
    publicKey: raw.toString('base64'),
  };
};
const alice = makeUser(),
  bob = makeUser(),
  carol = makeUser();
const profile = (who, extra = {}) => ({
  address: who.address,
  displayName: 'Synthetic researcher',
  summary: 'A test profile',
  capabilities: ['analysis'],
  services: [],
  languages: [],
  availability: 'open',
  website: '',
  publicContact: '',
  published: true,
  version: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});
function fixture(options = {}) {
  let state = {
    accounts: Object.fromEntries(
      [alice, bob, carol].map((who) => [
        who.address,
        { ...who, displayName: 'PRIVATE_ACCOUNT' },
      ]),
    ),
    memberProfiles: {
      [alice.address]: profile(alice),
      [bob.address]: profile(bob),
      [carol.address]: profile(carol),
    },
  };
  let tail = Promise.resolve(),
    transactions = 0,
    clock = 1793491200000;
  const store = {
    read: () => structuredClone(state),
    transact(fn) {
      const p = tail.then(async () => {
        const next = structuredClone(state);
        const result = await fn(next);
        state = next;
        transactions++;
        return structuredClone(result);
      });
      tail = p.catch(() => {});
      return p;
    },
  };
  const service = () =>
    createProfileEndorsements({ store, now: () => clock, ...options });
  return {
    store,
    service: service(),
    restart: service,
    snapshot: () => structuredClone(state),
    replace(value) {
      state = structuredClone(value);
    },
    mutate(fn) {
      fn(state);
    },
    transactions: () => transactions,
    tick(ms) {
      clock += ms;
    },
  };
}
const body = (extra = {}) => ({
  clientRequestId: 'synthetic-vote-01',
  profileVersion: 1,
  publish: true,
  ...extra,
});
const rejects = (fn, code) => assert.rejects(fn, (e) => e.code === code);
test('public peer upvote projects only consented bounded metadata; reads never write', async () => {
  const f = fixture();
  const before = f.transactions();
  const empty = await f.service.list(bob.address, {});
  assert.equal(empty.count, 0);
  assert.equal(f.transactions(), before);
  const added = await f.service.add(alice, bob.address, body());
  assert.equal(added.created, true);
  assert.equal(added.endorsement.active, true);
  const own = await f.service.own(alice, bob.address, { profileVersion: 1 });
  assert.equal(own.endorsement.id, added.endorsement.id);
  assert.equal(
    (await f.service.own(carol, bob.address, { profileVersion: 1 }))
      .endorsement,
    null,
  );
  const writes = f.transactions(),
    snapshot = f.snapshot();
  const list = await f.service.list(bob.address, { page: 1, pageSize: 1 });
  assert.equal(list.count, 1);
  assert.equal(list.endorsements[0].author, alice.address);
  assert.equal(list.subject.profileVersion, 1);
  assert.equal(list.provenance.independentlyVerified, false);
  assert.equal(list.provenance.affectsNativeKarma, false);
  assert.equal(list.provenance.establishesTrust, false);
  assert.ok(!JSON.stringify(list).includes('PRIVATE_ACCOUNT'));
  assert.ok(!JSON.stringify(list).includes('publicKey'));
  assert.ok(!JSON.stringify(list).includes('clientRequestId'));
  assert.equal(f.transactions(), writes);
  assert.deepEqual(f.snapshot(), snapshot);
  list.endorsements[0].author = 'changed';
  assert.equal(
    (await f.service.list(bob.address)).endorsements[0].author,
    alice.address,
  );
});
test('actor must match native address, canonical public key and existing local account', async () => {
  const f = fixture();
  for (const user of [
    null,
    { ...alice, publicKey: bob.publicKey },
    { ...alice, address: bob.address },
    makeUser(),
    { ...alice, publicKey: alice.publicKey.replace('=', '') },
  ])
    await assert.rejects(
      () => f.service.add(user, bob.address, body()),
      (e) => e.status === 401 || e.status === 403,
    );
  f.mutate((s) => (s.accounts[alice.address].publicKey = carol.publicKey));
  await assert.rejects(
    () => f.service.own(alice, bob.address, { profileVersion: 1 }),
    (e) => e.status === 403,
  );
  assert.equal(f.transactions(), 0);
});
test('no self-vote, private target, stale version, unexpected text/authority, invalid intent or missing consent', async () => {
  const f = fixture();
  await rejects(
    () => f.service.add(alice, alice.address, body()),
    'self_endorsement',
  );
  for (const change of [
    { profileVersion: 2 },
    { profileVersion: '1' },
    { publish: false },
    { publish: undefined },
    { note: 'unsolicited review' },
    { approved: true },
    { clientRequestId: 'x' },
    { target: carol.address },
  ])
    await assert.rejects(
      () => f.service.add(alice, bob.address, body(change)),
      (e) => [400, 409].includes(e.status),
    );
  f.mutate((s) => (s.memberProfiles[bob.address].published = false));
  await assert.rejects(
    () => f.service.add(alice, bob.address, body()),
    (e) => e.status === 404,
  );
  await assert.rejects(
    () => f.service.list(bob.address),
    (e) => e.status === 404,
  );
  assert.equal(f.transactions(), 0);
});
test('same intent survives restart and conflicts on changed target/version; concurrent duplicates create once', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.add(alice, bob.address, body()),
    f.service.add(alice, bob.address, body()),
  ]);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(results[0].endorsement.id, results[1].endorsement.id);
  const again = await f.restart().add(alice, bob.address, body());
  assert.equal(again.created, false);
  assert.equal((await f.service.list(bob.address)).count, 1);
  await rejects(
    () => f.service.add(alice, carol.address, body()),
    'endorsement_intent_conflict',
  );
  await rejects(
    () => f.service.add(alice, bob.address, body({ profileVersion: 2 })),
    'endorsement_intent_conflict',
  );
  const other = await Promise.allSettled([
    f.service.add(
      carol,
      bob.address,
      body({ clientRequestId: 'concurrent-vote-01' }),
    ),
    f.service.add(
      carol,
      bob.address,
      body({ clientRequestId: 'concurrent-vote-02' }),
    ),
  ]);
  assert.equal(other.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    other.find((r) => r.status === 'rejected').reason.code,
    'endorsement_exists',
  );
});
test('author-only revoke is durable/idempotent; retry cannot resurrect but an explicit fresh intent can', async () => {
  const f = fixture();
  const added = await f.service.add(alice, bob.address, body());
  await assert.rejects(
    () => f.service.withdraw(carol, added.endorsement.id, {}),
    (e) => e.status === 404,
  );
  const revoked = await f.service.withdraw(alice, added.endorsement.id, {});
  assert.equal(revoked.endorsement.active, false);
  assert.equal((await f.service.list(bob.address)).count, 0);
  assert.equal(
    (await f.service.own(alice, bob.address, { profileVersion: 1 }))
      .endorsement,
    null,
  );
  assert.equal(
    (await f.restart().withdraw(alice, added.endorsement.id, {})).changed,
    false,
  );
  const retry = await f.restart().add(alice, bob.address, body());
  assert.equal(retry.created, false);
  assert.equal(retry.endorsement.active, false);
  const fresh = await f.service.add(
    alice,
    bob.address,
    body({ clientRequestId: 'synthetic-vote-02' }),
  );
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.endorsement.id, added.endorsement.id);
  assert.equal((await f.service.list(bob.address)).count, 1);
});
test('edit, withdrawal and republication cannot turn an old vote into a current endorsement', async () => {
  const f = fixture();
  const old = await f.service.add(alice, bob.address, body());
  f.mutate((s) => {
    s.memberProfiles[bob.address].version = 2;
    s.memberProfiles[bob.address].summary = 'Changed claim';
  });
  assert.equal((await f.service.list(bob.address)).count, 0);
  assert.equal(
    (await f.service.add(alice, bob.address, body())).endorsement.active,
    false,
  );
  await rejects(
    () => f.service.own(alice, bob.address, { profileVersion: 1 }),
    'profile_version_conflict',
  );
  f.mutate((s) => {
    s.memberProfiles[bob.address].published = false;
    s.memberProfiles[bob.address].version = 3;
  });
  await assert.rejects(
    () => f.service.list(bob.address),
    (e) => e.status === 404,
  );
  assert.equal(
    (await f.service.withdraw(alice, old.endorsement.id, {})).changed,
    true,
  );
  f.mutate((s) => {
    s.memberProfiles[bob.address].published = true;
    s.memberProfiles[bob.address].version = 4;
  });
  assert.equal((await f.service.list(bob.address)).count, 0);
  const next = await f.service.add(
    alice,
    bob.address,
    body({ clientRequestId: 'new-version-vote', profileVersion: 4 }),
  );
  assert.equal(next.endorsement.profileVersion, 4);
  assert.equal((await f.service.list(bob.address)).count, 1);
});
test('write limits fail atomically, revocation remains available, and a full store prunes withdrawn rows, then refuses', async () => {
  const f = fixture({ maxRecords: 2, maxPerAuthor: 2, maxWritesPerMinute: 1 });
  const a = await f.service.add(alice, bob.address, body());
  const before = f.snapshot();
  await rejects(
    () =>
      f.service.add(
        alice,
        carol.address,
        body({ clientRequestId: 'rate-limited-02' }),
      ),
    'endorsement_rate_limited',
  );
  assert.deepEqual(f.snapshot(), before);
  await f.service.withdraw(alice, a.endorsement.id, {});
  f.tick(60001);
  await f.service.add(
    alice,
    carol.address,
    body({ clientRequestId: 'rate-limited-02' }),
  );
  // 13 November 2026 (B1-5): a full store prunes withdrawn rows first; once
  // only active rows remain (second review), a new endorsement is refused and
  // no other author's row is removed.
  const carolVote = await f.service.add(carol, bob.address, body());
  assert.equal(carolVote.created, true);
  assert.equal(f.snapshot().profileEndorsements.records[a.endorsement.id], undefined);
  const full = f.snapshot();
  assert.equal(Object.keys(full.profileEndorsements.records).length, 2);
  await rejects(() => f.service.add(bob, carol.address, body({ clientRequestId: 'bob-first-vote' })), 'endorsement_capacity');
  assert.deepEqual(f.snapshot().profileEndorsements.records, full.profileEndorsements.records);
});
test('a store full of active endorsements refuses every new one and removes nothing', async () => {
  const f = fixture({ maxRecords: 4 });
  await f.service.add(alice, bob.address, body({ clientRequestId: 'alice-to-bob' }));
  f.tick(60001);
  await f.service.add(alice, carol.address, body({ clientRequestId: 'alice-to-carol' }));
  await f.service.add(bob, carol.address, body({ clientRequestId: 'bob-to-carol' }));
  await f.service.add(carol, alice.address, body({ clientRequestId: 'carol-to-alice' }));
  const full = f.snapshot();
  f.tick(60001);
  for (const [who, target, id] of [[bob, alice, 'bob-to-alice'], [carol, bob, 'carol-to-bob']])
    await rejects(() => f.service.add(who, target.address, body({ clientRequestId: id })), 'endorsement_capacity');
  assert.deepEqual(f.snapshot().profileEndorsements.records, full.profileEndorsements.records);
});
test('withdrawn endorsements do not count against the author budget', async () => {
  const f = fixture({ maxPerAuthor: 1 });
  const first = await f.service.add(alice, bob.address, body());
  await f.service.withdraw(alice, first.endorsement.id, {});
  f.tick(60001);
  const second = await f.service.add(alice, carol.address, body({ clientRequestId: 'second-vote-01' }));
  assert.equal(second.created, true);
});
test('pagination and read selectors are strict; corrupt stored records fail closed without publishing', async () => {
  const f = fixture();
  for (const q of [
    { page: 0 },
    { page: 1.2 },
    { pageSize: 26 },
    { page: '1' },
    { owner: alice.address },
  ])
    await assert.rejects(
      () => f.service.list(bob.address, q),
      (e) => e.status === 400,
    );
  for (const q of [
    {},
    { profileVersion: 0 },
    { profileVersion: 1, author: carol.address },
  ])
    await assert.rejects(
      () => f.service.own(alice, bob.address, q),
      (e) => e.status === 400,
    );
  const a = await f.service.add(alice, bob.address, body());
  const saved = f.snapshot();
  for (const mutate of [
    (s) =>
      (s.profileEndorsements.records[a.endorsement.id].author = 'not-address'),
    (s) =>
      (s.profileEndorsements.records[a.endorsement.id].profileVersion = '1'),
    (s) =>
      (s.profileEndorsements.records[a.endorsement.id].revokedAt = 'invalid'),
    (s) => (s.profileEndorsements.records[a.endorsement.id].nativeKarma = 10),
  ]) {
    const bad = structuredClone(saved);
    mutate(bad);
    f.replace(bad);
    await rejects(
      () => f.service.list(bob.address),
      'endorsement_store_invalid',
    );
  }
});
test('queued mutation snapshots the authenticated actor and signed intent fields before any await', async () => {
  const f = fixture(),
    who = { ...alice },
    intent = body();
  const pending = f.service.add(who, bob.address, intent);
  Object.assign(who, carol);
  intent.clientRequestId = 'changed-queued-01';
  intent.profileVersion = 2;
  intent.publish = false;
  const result = await pending;
  assert.equal(result.endorsement.author, alice.address);
  assert.equal(result.endorsement.profileVersion, 1);
  const again = await f.service.add(alice, bob.address, body());
  assert.equal(again.created, false);
  assert.equal(again.endorsement.id, result.endorsement.id);
  const withdrawUser = { ...alice },
    removal = f.service.withdraw(withdrawUser, result.endorsement.id, {});
  Object.assign(withdrawUser, carol);
  assert.equal((await removal).changed, true);
});
