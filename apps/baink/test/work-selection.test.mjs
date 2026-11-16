import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkSelections,
  selectionDigest,
  WorkSelectionError,
} from '../server/work-selection.mjs';

function member() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    address:
      'uain1' + createHash('sha256').update(raw).digest('hex').slice(0, 40),
    publicKey: raw.toString('base64'),
  };
}
function source(patch = {}) {
  return {
    kind: 'proposals',
    projectId: 'OPP-00001',
    title: 'Original target',
    description: 'Question',
    category: 'Research',
    status: 'inactive',
    sourceRevision: 'revision-1',
    sourceAuthority: 'catalogue',
    sourceUrl: 'https://uain.global/network/live?project=OPP-00001',
    sourceAvailable: true,
    taskCount: null,
    ...patch,
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'baink-selection-test-')),
    path = join(directory, 'state.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alice = member(),
    bob = member();
  let state = { accounts: { [alice.address]: alice, [bob.address]: bob } },
    tail = Promise.resolve(),
    clock = Date.parse('2026-10-31T12:00:00Z'),
    calls = 0,
    current = source(),
    outage = false;
  const store = {
    read: () => structuredClone(state),
    transact: (operation) => {
      const result = tail.then(async () => {
        const draft = structuredClone(state),
          value = await operation(draft);
        await writeFile(path + '.tmp', JSON.stringify(draft), { mode: 0o600 });
        await rename(path + '.tmp', path);
        state = draft;
        return structuredClone(value);
      });
      tail = result.catch(() => {});
      return result;
    },
  };
  const resolveSource = async () => {
    calls++;
    if (outage) throw Error('Private upstream diagnostic must not escape');
    return structuredClone(current);
  };
  const build = () =>
    createWorkSelections({ store, resolveSource, now: () => clock });
  return {
    alice,
    bob,
    store,
    service: build(),
    calls: () => calls,
    setSource: (value) => {
      current = value;
    },
    outage: () => {
      outage = true;
    },
    advance: (ms) => {
      clock += ms;
    },
    restart: async () => {
      await tail;
      state = JSON.parse(await readFile(path, 'utf8'));
      return build();
    },
  };
}
const body = (
  snapshot = source(),
  clientRequestId = 'selection-intent-one',
) => ({
  clientRequestId,
  kind: snapshot.kind,
  projectId: snapshot.projectId,
  sourceDigest: selectionDigest(snapshot),
});
const refusal = (status, code) => (error) =>
  error instanceof WorkSelectionError &&
  error.status === status &&
  error.code === code;

test('the source digest binds the normalized eleven fields while ignoring volatile or private extra data', () => {
  const literal =
    '{"category":"Research","description":"Question","kind":"proposals","projectId":"OPP-00001","sourceAuthority":"catalogue","sourceAvailable":true,"sourceRevision":"revision-1","sourceUrl":"https://uain.global/network/live?project=OPP-00001","status":"inactive","taskCount":null,"title":"Original target"}';
  assert.equal(
    selectionDigest(source()),
    createHash('sha256').update(literal).digest('hex'),
  );
  assert.equal(
    selectionDigest(
      source({
        fetchedAt: 'later',
        privateConfiguration: { value: 'not retained' },
      }),
    ),
    selectionDigest(source()),
  );
  assert.notEqual(
    selectionDigest(source({ title: 'Changed target' })),
    selectionDigest(source()),
  );
});

test('a private selection saves the immutable reviewed source without claiming native work or exposing a local directory', async (t) => {
  const f = await fixture(t);
  f.setSource(
    source({
      fetchedAt: 'ignored',
      privateConfiguration: { never: 'retained' },
    }),
  );
  const result = await f.service.select(f.alice, body());
  assert.equal(result.created, true);
  assert.equal(result.selection.owner, f.alice.address);
  assert.equal(result.selection.availability, 'selected');
  assert.equal(result.selection.source.title, 'Original target');
  assert.equal(result.selection.claim, false);
  assert.equal(result.selection.settlementAvailable, false);
  assert.equal(result.selection.ownerPublicKey, undefined);
  assert.equal(result.selection.source.privateConfiguration, undefined);
  assert.equal(result.selection.source.fetchedAt, undefined);
  assert.equal(f.service.list(f.bob).count, 0);
  await assert.rejects(
    async () => f.service.inspect(f.bob, result.selection.id),
    refusal(404, 'selection_missing'),
  );
  f.setSource(source({ title: 'New source title' }));
  assert.equal(
    f.service.list(f.alice).selections[0].source.title,
    'Original target',
  );
  const inspected = await f.service.inspect(f.alice, result.selection.id);
  assert.equal(inspected.current.changed, true);
  assert.equal(inspected.current.source.title, 'New source title');
});

test('unknown, unavailable, malformed and stale source selections never persist a record', async (t) => {
  const f = await fixture(t);
  f.setSource(null);
  await assert.rejects(
    f.service.select(f.alice, body()),
    refusal(404, 'source_missing'),
  );
  assert.equal(f.service.list(f.alice).count, 0);
  f.setSource(source({ sourceAvailable: false }));
  await assert.rejects(
    f.service.select(f.alice, body()),
    refusal(503, 'source_unavailable'),
  );
  f.setSource(source({ projectId: 'another-project' }));
  await assert.rejects(
    f.service.select(f.alice, body()),
    refusal(503, 'source_unavailable'),
  );
  f.setSource(source({ title: 'Changed target' }));
  await assert.rejects(
    f.service.select(f.alice, body()),
    refusal(409, 'source_stale'),
  );
  f.outage();
  await assert.rejects(
    f.service.select(f.alice, body()),
    refusal(503, 'source_unavailable'),
  );
  assert.equal(f.service.list(f.alice).count, 0);
});

test('idempotent retries survive withdrawal, source disappearance and restart without resurrection', async (t) => {
  const f = await fixture(t),
    intent = body(),
    saved = await f.service.select(f.alice, intent),
    id = saved.selection.id;
  const withdrawn = await f.service.withdraw(f.alice, id, {});
  assert.equal(withdrawn.changed, true);
  assert.equal((await f.service.withdraw(f.alice, id, {})).changed, false);
  const before = f.calls();
  f.setSource(null);
  const retry = await f.service.select(f.alice, intent);
  assert.equal(retry.created, false);
  assert.equal(retry.selection.id, id);
  assert.equal(retry.selection.availability, 'withdrawn');
  assert.equal(f.calls(), before);
  const restarted = await f.restart();
  const restored = await restarted.select(f.alice, intent);
  assert.equal(restored.selection.availability, 'withdrawn');
  assert.equal(f.calls(), before);
  await assert.rejects(
    restarted.select(f.alice, { ...intent, sourceDigest: 'f'.repeat(64) }),
    refusal(409, 'idempotency_conflict'),
  );
  f.setSource(source());
  const selected = await restarted.select(
    f.alice,
    body(source(), 'explicit-reselection'),
  );
  assert.notEqual(selected.selection.id, id);
  assert.equal(restarted.list(f.alice).count, 1);
  assert.equal(restarted.list(f.alice, { availability: 'all' }).count, 2);
});

test('concurrent duplicate selects persist one record and another active intent cannot replace its source snapshot', async (t) => {
  const f = await fixture(t),
    results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.select(f.alice, body())),
    );
  assert.equal(new Set(results.map((r) => r.selection.id)).size, 1);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal(f.service.list(f.alice).count, 1);
  await assert.rejects(
    f.service.select(f.alice, body(source(), 'different-intent-id')),
    refusal(409, 'selection_exists'),
  );
});

test('every method checks the bound existing account key and strict private pagination', async (t) => {
  const f = await fixture(t),
    saved = await f.service.select(f.alice, body()),
    id = saved.selection.id,
    forged = { ...f.alice, publicKey: f.bob.publicKey };
  for (const action of [
    () => f.service.list(forged),
    () => f.service.select(forged, body()),
    () => f.service.withdraw(forged, id, {}),
    () => f.service.inspect(forged, id),
  ])
    await assert.rejects(
      async () => action(),
      refusal(401, 'invalid_identity'),
    );
  await assert.rejects(
    f.service.select(member(), body()),
    refusal(404, 'account_missing'),
  );
  await assert.rejects(
    f.service.withdraw(f.bob, id, {}),
    refusal(404, 'selection_missing'),
  );
  for (const query of [
    { page: 0 },
    { pageSize: 26 },
    { availability: 'published' },
    { owner: f.bob.address },
  ])
    assert.throws(
      () => f.service.list(f.alice, query),
      refusal(400, 'invalid_query'),
    );
  await assert.rejects(
    f.service.withdraw(f.alice, id, { sourceDigest: 'f'.repeat(64) }),
    refusal(400, 'invalid_body'),
  );
});

test('source bounds and URL safety fail closed and never retain unrelated object fields', () => {
  for (const patch of [
    { title: 'x'.repeat(1001) },
    { description: 'x'.repeat(5001) },
    { taskCount: -1 },
    { taskCount: 1.5 },
    { sourceUrl: 'https://user:password@uain.global/project' },
    { sourceUrl: 'https://uain.global/project#fragment' },
    { sourceUrl: 'https://uain.global/project?token=private' },
    { sourceUrl: 'javascript:alert(1)' },
    { title: '\ud800' },
  ])
    assert.throws(
      () => selectionDigest(source(patch)),
      refusal(503, 'source_unavailable'),
    );
  assert.match(
    selectionDigest(source({ sourceUrl: 'http://127.0.0.1:8798/project' })),
    /^[a-f0-9]{64}$/,
  );
});

test('the member active cap refuses; retained and global caps prune withdrawn choices, then refuse without removing another owner\'s choice', async (t) => {
  const f = await fixture(t),
    one = (await f.service.select(f.alice, body())).selection;
  const seed = (owner, n, availability) =>
    Array.from({ length: n }, (_, i) => ({
      ...one,
      id: randomUUID(),
      owner,
      ownerPublicKey:
        owner === f.alice.address ? f.alice.publicKey : f.bob.publicKey,
      clientRequestId: `seed-selection-${i}`,
      projectId: `seed-${i}`,
      availability,
    }));
  await f.store.transact((state) => {
    const data = state.workSelections;
    data.selections = Object.fromEntries(
      seed(f.alice.address, 100, 'selected').map((s) => [s.id, s]),
    );
  });
  await assert.rejects(
    f.service.select(f.alice, body(source(), 'active-cap-intent')),
    refusal(429, 'selection_capacity'),
  );
  assert.equal(f.service.list(f.alice).count, 100);
  await f.store.transact((state) => {
    state.workSelections.selections = Object.fromEntries(
      seed(f.alice.address, 200, 'withdrawn').map((s) => [s.id, s]),
    );
  });
  // 13 November 2026 (B1-5): withdrawn choices no longer count; the owner's
  // oldest withdrawn choice gives way.
  const retained = await f.service.select(f.alice, body(source(), 'retained-cap-intent'));
  assert.equal(retained.created, true);
  assert.equal(f.service.list(f.alice, { availability: 'all' }).count, 200);
  await f.store.transact((state) => {
    state.workSelections.selections = Object.fromEntries(
      seed(f.bob.address, 1000, 'withdrawn').map((s) => [s.id, s]),
    );
  });
  assert.equal((await f.service.select(f.alice, body(source(), 'global-cap-intent'))).created, true);
  assert.equal(Object.keys(f.store.read().workSelections.selections).length, 1000);
  // Second review, 13 November 2026: once only active choices fill the
  // network, a new choice is refused and no other owner's choice is removed.
  await f.store.transact((state) => {
    state.workSelections.selections = Object.fromEntries(
      seed(f.bob.address, 1000, 'selected').map((s) => [s.id, s]),
    );
  });
  const full = structuredClone(f.store.read().workSelections.selections);
  await assert.rejects(
    f.service.select(f.alice, body(source(), 'active-full-intent')),
    refusal(429, 'selection_capacity'),
  );
  assert.deepEqual(f.store.read().workSelections.selections, full);
  // The same with many small owners, the asking member among them.
  await f.store.transact((state) => {
    const rows = [...seed(f.alice.address, 5, 'selected')];
    for (let o = 0; o < 199; o++) rows.push(...seed('uain1' + String(o).padStart(40, '0'), 5, 'selected').map((s, i) => ({ ...s, clientRequestId: `other-${o}-${i}` })));
    state.workSelections.selections = Object.fromEntries(rows.map((s) => [s.id, s]));
  });
  const many = structuredClone(f.store.read().workSelections.selections);
  await assert.rejects(
    f.service.select(f.alice, body(source(), 'many-owners-intent')),
    refusal(429, 'selection_capacity'),
  );
  assert.deepEqual(f.store.read().workSelections.selections, many);
});

test('source deadlines retain actual resolver capacity until ignored or slow upstream work settles', async () => {
  const waits = new Map();
  let active = 0,
    calls = 0,
    maxActive = 0;
  const service = createWorkSelections({
    store: {
      read: () => ({ accounts: {} }),
      transact: async (fn) => fn({ accounts: {} }),
    },
    sourceTimeoutMs: 20,
    resolveSource: (kind, id) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => waits.set(id, resolve)).finally(() => {
        active--;
      });
    },
  });
  const first = Array.from({ length: 4 }, (_, i) =>
    service.review('projects', `project-${i}`),
  );
  await Promise.all(
    first.map((promise) =>
      assert.rejects(promise, refusal(503, 'source_unavailable')),
    ),
  );
  assert.equal(active, 4);
  await assert.rejects(
    service.review('projects', 'project-0'),
    refusal(503, 'source_unavailable'),
  );
  await assert.rejects(
    service.review('projects', 'project-4'),
    refusal(503, 'source_unavailable'),
  );
  assert.equal(calls, 4);
  assert.equal(maxActive, 4);
  waits.get('project-0')(source({ kind: 'projects', projectId: 'project-0' }));
  await new Promise((resolve) => setImmediate(resolve));
  const next = service.review('projects', 'project-4');
  // Register the replacement upstream before resolving it, without allowing
  // a loaded event loop to consume the real 20ms response deadline first.
  await Promise.resolve();
  for (const [id, resolve] of waits)
    resolve(source({ kind: 'projects', projectId: id }));
  assert.equal((await next).source.projectId, 'project-4');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 0);
  assert.equal(maxActive, 4);
});
