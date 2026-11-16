import test from 'node:test';
import assert from 'node:assert/strict';
import * as claim from './native-work-claim-view.js';
const holder = 'uain1' + 'a'.repeat(40),
  peer = 'uain1' + 'b'.repeat(40);
const binding = {
  projectId: 'project-one',
  taskId: 'T-41',
  workId: 'RC-4577',
  authorInstanceId: 'claude-lead',
};
const now = Date.parse('2026-11-01T00:00:00Z');
const revision = (fields = {}) => ({
  id: 'native:00000000000000000041',
  base: '',
  state: 'superseded',
  action: 'assert',
  statement: 'An associated finding, retained as provenance.',
  sources: ['RC-4577'],
  ...fields,
});
const payload = () => ({
  status: 'available',
  scope: 'native-selected-work-claim',
  complete: false,
  actorAddress: holder,
  binding: { ...binding },
  association: 'present',
  claim: {
    id: 'CL-native-42',
    projectId: 'project-one',
    sourceKey: 'legacy_claim/CL-native-42',
    associationSourceKey: 'legacy_answer_claim/RC-4577',
    associatedRevisionId: 'native:00000000000000000041',
    associatedRevision: revision(),
    believedRevision: revision({
      id: 'native:00000000000000000042',
      base: 'native:00000000000000000041',
      state: 'believed',
      action: 'retract',
      statement: 'This prior finding is withdrawn.',
      sources: [],
    }),
  },
  proof: {
    authority: 'native',
    chainId: 'uain-shadow-20261008-1',
    height: '1023596',
    appHash: 'a'.repeat(64),
    headerTime: new Date(now).toISOString(),
    maxAgeSeconds: 120,
    epoch: 'b'.repeat(64),
    genesisSha256: 'b'.repeat(64),
    verifierSha256: 'c'.repeat(64),
  },
  aiDollarPayment: 'not-established-by-this-record',
  trust: 'not-evaluated',
  notice:
    'Selected native claim provenance only; not complete history or payment.',
});
const view = (p, at = now) =>
  claim.nativeWorkClaimView?.(p, holder, binding, { now: at });
// A wrong actor, extra selector or unbounded ID must never produce a signed read.
test('claim path selects exactly one self-owned tuple and rejects foreign or malformed selectors', () => {
  assert.equal(
    claim.nativeWorkClaimPath?.(holder, holder, binding),
    '/api/work/claim?projectId=project-one&taskId=T-41&workId=RC-4577&authorInstanceId=claude-lead',
  );
  for (const [actor, address, selected] of [
    [null, holder, binding],
    [holder, peer, binding],
    [holder, holder, { ...binding, workId: '../bad' }],
    [holder, holder, { ...binding, workId: 'RC-4577\n' }],
    [holder, holder, { ...binding, authorInstanceId: 'x'.repeat(97) }],
    [holder, holder, { ...binding, secret: 'no' }],
  ])
    assert.throws(() => claim.nativeWorkClaimPath(actor, address, selected));
});
// Replacing either revision by the other loses the actual work-to-revision link.
test('fresh selected claim preserves associated assertion separately from believed retraction', () => {
  const raw = payload(),
    result = view(raw);
  assert.equal(result?.available, true);
  assert.equal(
    result.claim.associatedRevision.id,
    'native:00000000000000000041',
  );
  assert.equal(result.claim.associatedRevision.action, 'assert');
  assert.equal(result.claim.associatedRevision.state, 'superseded');
  assert.equal(result.claim.believedRevision.id, 'native:00000000000000000042');
  assert.equal(result.claim.believedRevision.action, 'retract');
  assert.deepEqual(result.claim.believedRevision.sources, []);
  assert.equal(result.aiDollarPayment, 'not-established-by-this-record');
  assert.equal(result.trust, 'not-evaluated');
  assert.equal(result.complete, false);
  assert.equal(result.expiresAt, now + 120000);
  raw.claim.associatedRevision.sources[0] = 'mutated';
  assert.deepEqual(result.claim.associatedRevision.sources, ['RC-4577']);
});
// A proved absent association is distinct from an unavailable read.
test('available absence requires a fresh proof and unavailable data cannot retain association or claim', () => {
  const absent = { ...payload(), association: 'absent', claim: null };
  assert.equal(view(absent)?.available, true);
  assert.equal(view(absent).association, 'absent');
  const unavailable = {
    ...payload(),
    status: 'unavailable',
    association: null,
    claim: null,
    proof: null,
  };
  assert.equal(view(unavailable)?.available, false);
  assert.equal(view(unavailable).association, null);
  for (const wrong of [
    { ...absent, proof: null },
    { ...absent, claim: payload().claim },
    { ...unavailable, proof: payload().proof },
    { ...unavailable, association: 'absent' },
    { ...payload(), association: null },
  ])
    assert.equal(view(wrong).available, false);
});
// Source-key substitutions and extra authority fields must fail closed.
test('foreign binding, inconsistent revisions, unexpected fields and unbounded provenance are unavailable', () => {
  const changes = [
    (p) => (p.actorAddress = peer),
    (p) => (p.binding.workId = 'RC-other'),
    (p) => (p.binding.extra = true),
    (p) => (p.claim.projectId = 'foreign'),
    (p) => (p.claim.sourceKey = 'legacy_claim/another'),
    (p) => (p.claim.associationSourceKey = 'legacy_answer_claim/another'),
    (p) => (p.claim.associatedRevisionId = 'native:other'),
    (p) => (p.claim.associatedRevision.sources = ['RC-other']),
    (p) => (p.claim.associatedRevision.id += '\n'),
    (p) => (p.claim.associatedRevision.base = p.claim.associatedRevision.id),
    (p) => (p.claim.associatedRevision.action = 'confirmed'),
    (p) => (p.claim.associatedRevision.state = 'accepted'),
    (p) => (p.claim.associatedRevision.statement = ' '.repeat(40)),
    (p) => (p.claim.associatedRevision.statement = 'é'.repeat(2001)),
    (p) => (p.claim.associatedRevision.statement = 'bad\u0000text'),
    (p) => (p.claim.associatedRevision.sources = ['RC-4577', 'RC-4577']),
    (p) =>
      (p.claim.associatedRevision.sources = Array.from(
        { length: 33 },
        (_, n) => 'RC-' + n,
      )),
    (p) =>
      (p.claim.associatedRevision.sources = ['RC-4577', 'javascript:bad()']),
    (p) => (p.claim.associatedRevision.paid = true),
    (p) => (p.claim.believedRevision.state = 'draft'),
    (p) => (p.claim.believedRevision.id = p.claim.associatedRevision.id),
    (p) => (p.claim.associatedRevision.state = 'believed'),
    (p) => (p.proof.epoch = 'd'.repeat(64)),
    (p) => (p.proof.extra = 'unrecognized'),
    (p) => (p.complete = true),
    (p) => (p.trust = 'trusted'),
    (p) => (p.aiDollarPayment = 'paid'),
    (p) => (p.checkerCount = 4),
    (p) => (p.claim.author = 'private'),
  ];
  assert.equal(typeof claim.nativeWorkClaimView, 'function');
  for (const mutate of changes) {
    const p = payload();
    mutate(p);
    const result = view(p);
    assert.equal(result.available, false, mutate.toString());
    assert.equal(result.claim, null, mutate.toString());
    assert.equal(result.proof, null, mutate.toString());
  }
  const inherited = Object.create({ secret: 'hidden' });
  Object.assign(inherited, payload());
  assert.equal(view(inherited).available, false);
});
// Time must remove authority at the boundary, not leave a once-fresh claim visible.
test('claim proof expires at its exact boundary and rejects invalid proof headers', () => {
  assert.equal(view(payload(), now + 119999)?.available, true);
  assert.equal(view(payload(), now + 120000).available, false);
  for (const mutate of [
    (p) => (p.proof.headerTime = 'bad'),
    (p) => (p.proof.maxAgeSeconds = 121),
    (p) => (p.proof.headerTime = new Date(now + 60001).toISOString()),
    (p) => (p.proof.authority = 'offchain'),
  ]) {
    const p = payload();
    mutate(p);
    assert.equal(view(p).available, false);
  }
});
test('frozen claim source and same associated/believed revision preserve exact provenance', () => {
  const p = payload();
  p.claim.sourceKey = 'legacy/claim/CL-native-42';
  p.claim.associatedRevision.state = 'believed';
  p.claim.believedRevision = structuredClone(p.claim.associatedRevision);
  assert.equal(view(p)?.available, true);
  p.claim.believedRevision = null;
  assert.equal(view(p).available, false);
  p.claim.associatedRevision.state = 'contested';
  assert.equal(view(p).available, true);
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Selection/expiry must never become a background network poll.
test('manual reader makes no request on selection or expiry and clears stale authority', async () => {
  assert.equal(typeof claim.createNativeWorkClaimReader, 'function');
  let clock = now,
    reads = 0,
    nextTimer = 0;
  const timers = new Map(),
    events = [],
    jobs = [],
    identity = { address: holder };
  const reader = claim.createNativeWorkClaimReader({
    request(path, options) {
      reads++;
      assert.equal(
        path,
        '/api/work/claim?projectId=project-one&taskId=T-41&workId=RC-4577&authorInstanceId=claude-lead',
      );
      assert.equal(options.identity, identity);
      assert.ok(!options.method || options.method === 'GET');
      assert.equal(options.body, undefined);
      const job = deferred();
      jobs.push(job);
      return job.promise;
    },
    publish: (event) => events.push(event),
    now: () => clock,
    setTimer(callback, delay) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimer: (id) => timers.delete(id),
  });
  reader.select(identity, holder, binding);
  reader.checkFreshness();
  await flush();
  assert.equal(reads, 0);
  const first = reader.read(),
    duplicate = reader.read();
  await flush();
  assert.equal(reads, 1);
  jobs[0].resolve(payload());
  await Promise.all([first, duplicate]);
  assert.equal(events.at(-1).view.available, true);
  assert.equal([...timers.values()][0].delay, 120000);
  clock += 120000;
  [...timers.values()][0].callback();
  assert.equal(events.at(-1).view.claim, null);
  assert.equal(events.at(-1).view.proof, null);
  assert.equal(reads, 1);
  clock = now;
  const retry = reader.read();
  await flush();
  assert.equal(reads, 2);
  jobs[1].resolve(payload());
  await retry;
  assert.equal(events.at(-1).view.available, true);
  const failed = reader.read();
  assert.equal(events.at(-1).view.claim, null);
  await flush();
  jobs[2].reject(Error('private upstream details'));
  await failed;
  assert.equal(events.at(-1).view.available, false);
  assert.ok(!events.at(-1).error.includes('private upstream'));
  assert.equal(events.at(-1).loading, false);
  reader.dispose();
  assert.equal(timers.size, 0);
});
// A late result must never cross identity, selection, reopen or cleanup boundaries.
test('reader ignores late responses and errors across identity replacement, same tuple reopen and unmount', async () => {
  assert.equal(typeof claim.createNativeWorkClaimReader, 'function');
  const jobs = [],
    events = [];
  const identity = { address: holder };
  const reader = claim.createNativeWorkClaimReader({
    request: () => {
      const job = deferred();
      jobs.push(job);
      return job.promise;
    },
    publish: (event) => events.push(event),
    now: () => now,
  });
  reader.select(identity, holder, binding);
  const old = reader.read();
  await flush();
  reader.select(identity, holder, binding);
  const recent = reader.read();
  await flush();
  const before = events.length;
  jobs[0].resolve(payload());
  await old;
  assert.equal(events.length, before);
  jobs[1].resolve(payload());
  await recent;
  assert.equal(events.at(-1).view.available, true);
  const stale = reader.read();
  await flush();
  reader.select({ address: holder }, holder, binding);
  const replaced = events.length;
  jobs[2].reject(Error('old identity'));
  await stale;
  assert.equal(events.length, replaced);
  assert.equal(events.at(-1).view.claim, null);
  const closing = reader.read();
  await flush();
  reader.dispose();
  const closed = events.length;
  jobs[3].resolve(payload());
  await closing;
  assert.equal(events.length, closed);
  reader.select({ address: peer }, peer, binding);
  assert.equal(events.at(-1).owner.address, peer);
  assert.equal(events.at(-1).view.available, false);
  reader.dispose();
});
// Same-tick closing/StrictMode cleanup must prevent even the deferred HTTP start.
test('disposed and replaced selections cannot begin a queued signed read', async () => {
  assert.equal(typeof claim.createNativeWorkClaimReader, 'function');
  let reads = 0;
  const reader = claim.createNativeWorkClaimReader({
    request: async () => {
      reads++;
      return payload();
    },
    publish: () => {},
    now: () => now,
  });
  reader.select({ address: holder }, holder, binding);
  const old = reader.read();
  reader.dispose();
  await old;
  assert.equal(reads, 0);
  reader.select({ address: holder }, holder, binding);
  const stale = reader.read();
  reader.select({ address: holder }, holder, {
    ...binding,
    workId: 'RC-other',
  });
  await stale;
  assert.equal(reads, 0);
  reader.dispose();
});
