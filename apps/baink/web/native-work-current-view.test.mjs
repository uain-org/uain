import test from 'node:test';
import assert from 'node:assert/strict';
import * as current from './native-work-current-view.js';
import { createNativeWorkCurrent } from '../server/native-work-current.mjs';
import { nativeWorkCurrentFixture } from '../test/fixtures/native-work-current-fixture.mjs';
const holder = 'uain1' + 'a'.repeat(40),
  peer = 'uain1' + 'b'.repeat(40);
const binding = {
  projectId: 'project-one',
  taskId: 'T-41',
  workId: 'RC-4577',
  authorInstanceId: 'claude-lead',
};
const now = Date.parse('2026-11-01T00:00:00Z');
const payload = () => ({
  scope: 'native-current-work-status',
  status: 'available',
  complete: false,
  actorAddress: holder,
  binding: { ...binding },
  work: {
    id: binding.workId,
    projectId: binding.projectId,
    taskId: binding.taskId,
    authorInstanceId: binding.authorInstanceId,
    memberAddress: holder,
    kind: 'work',
    state: 'contested',
    pending: '',
    withheld: '',
    statusSourceKey: 'legacy_work_status/RC-4577',
    recordSourceKey: 'legacy_work/RC-4577',
  },
  project: {
    id: binding.projectId,
    state: 'verifying',
    sourceKey: 'legacy_project/project-one',
  },
  task: {
    id: binding.taskId,
    state: 'open',
    kind: 'research',
    outcome: '',
    sourceKey: 'legacy_task/T-41',
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
  claimBelief: 'not-evaluated',
  aiDollarPayment: 'not-established-by-this-record',
  notice: 'Selected native operational status only.',
});
test('manual current-work path is signed-holder self-only with exactly the selected tuple', () => {
  assert.equal(typeof current.nativeWorkCurrentPath, 'function');
  assert.equal(
    current.nativeWorkCurrentPath(holder, holder, binding),
    '/api/work/current?projectId=project-one&taskId=T-41&workId=RC-4577&authorInstanceId=claude-lead',
  );
  for (const [actor, address, tuple] of [
    [null, holder, binding],
    [holder, peer, binding],
    [holder, holder, { ...binding, workId: '../RC-4577' }],
    [holder, holder, { ...binding, owner: peer }],
    [holder, holder, { ...binding, authorInstanceId: 'x'.repeat(161) }],
  ])
    assert.throws(() => current.nativeWorkCurrentPath(actor, address, tuple));
});
test('one fresh exact operational tuple projects bounded state/source fields without money or beliefs', () => {
  const view = current.nativeWorkCurrentView(payload(), holder, binding, {
    now,
  });
  assert.equal(view.available, true);
  assert.equal(view.work.state, 'contested');
  assert.equal(view.work.statusSourceKey, 'legacy_work_status/RC-4577');
  assert.equal(view.work.paid, undefined);
  assert.equal(view.work.claim, undefined);
  assert.equal(view.work.checks, undefined);
  assert.equal(view.aiDollarPayment, 'not-established-by-this-record');
  assert.equal(view.claimBelief, 'not-evaluated');
  assert.equal(view.expiresAt, now + 120000);
});
test('malformed200, foreign actor/tuple/source, history scope and unexpected financial claims fail closed', () => {
  const cases = [{}, null];
  for (const mutate of [
    (p) => (p.actorAddress = peer),
    (p) => (p.binding.workId = 'RC-999'),
    (p) => (p.work.memberAddress = peer),
    (p) => (p.work.authorInstanceId = 'another-author'),
    (p) => (p.work.projectId = 'other-project'),
    (p) => (p.task.id = 'T-99'),
    (p) => (p.project.id = 'other-project'),
    (p) => (p.work.statusSourceKey = 'legacy_work_status/RC-999'),
    (p) => (p.work.recordSourceKey = 'legacy_claim/CL-1'),
    (p) => (p.task.sourceKey = 'legacy_task/T-99'),
    (p) => (p.scope = 'native-committed-legacy-records'),
    (p) => (p.complete = true),
    (p) => (p.aiDollarPayment = 'paid'),
    (p) => (p.claimBelief = 'believed'),
    (p) => (p.proof.epoch = 'd'.repeat(64)),
  ]) {
    const p = payload();
    mutate(p);
    cases.push(p);
  }
  for (const p of cases) {
    const view = current.nativeWorkCurrentView(p, holder, binding, { now });
    assert.equal(view.available, false);
    assert.equal(view.work, null);
    assert.equal(view.proof, null);
  }
});
test('current-work authority expires exactly and invalid headers cannot retain a current status', () => {
  assert.equal(
    current.nativeWorkCurrentView(payload(), holder, binding, {
      now: now + 119999,
    }).available,
    true,
  );
  assert.equal(
    current.nativeWorkCurrentView(payload(), holder, binding, {
      now: now + 120000,
    }).available,
    false,
  );
  for (const mutate of [
    (p) => (p.proof.headerTime = 'bad'),
    (p) => (p.proof.maxAgeSeconds = 121),
    (p) => (p.proof.headerTime = new Date(now + 60001).toISOString()),
  ]) {
    const p = payload();
    mutate(p);
    assert.equal(
      current.nativeWorkCurrentView(p, holder, binding, { now }).available,
      false,
    );
  }
  const missing = payload();
  Object.assign(missing, {
    status: 'unavailable',
    work: null,
    task: null,
    project: null,
    proof: null,
  });
  assert.equal(
    current.nativeWorkCurrentView(missing, holder, binding, { now }).available,
    false,
  );
});
test('selection generations reject late A responses/errors, same-work reopen, holder replacement and logout', () => {
  const gate = current.createNativeWorkCurrentGate();
  let shown = '';
  const first = gate.begin(holder, holder, binding);
  const second = gate.begin(holder, holder, { ...binding, workId: 'RC-4578' });
  assert.equal(
    gate.apply(first, () => (shown = 'late A')),
    false,
  );
  assert.equal(
    gate.apply(second, () => (shown = 'B')),
    true,
  );
  assert.equal(shown, 'B');
  const reopened = gate.begin(holder, holder, {
    ...binding,
    workId: 'RC-4578',
  });
  assert.equal(
    gate.apply(second, () => (shown = 'late old B error')),
    false,
  );
  gate.invalidate();
  assert.equal(
    gate.apply(reopened, () => (shown = 'after logout')),
    false,
  );
  const replaced = gate.begin(peer, peer, binding);
  assert.equal(
    gate.apply(reopened, () => (shown = 'wrong holder')),
    false,
  );
  assert.equal(
    gate.apply(replaced, () => (shown = 'peer')),
    true,
  );
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
test('current-work reader makes no automatic request and clears status at exact expiry or failed manual refresh', async () => {
  assert.equal(typeof current.createNativeWorkCurrentReader, 'function');
  let clock = now;
  const jobs = [],
    events = [],
    timers = new Map();
  let timerId = 0;
  const identity = { address: holder };
  const reader = current.createNativeWorkCurrentReader({
    request: (path, options) => {
      assert.equal(
        path,
        '/api/work/current?projectId=project-one&taskId=T-41&workId=RC-4577&authorInstanceId=claude-lead',
      );
      assert.equal(options.identity, identity);
      const job = deferred();
      jobs.push(job);
      return job.promise;
    },
    publish: (event) => events.push(event),
    now: () => clock,
    setTimer: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
  });
  reader.select(identity, holder, binding);
  assert.equal(jobs.length, 0);
  reader.checkFreshness();
  assert.equal(jobs.length, 0);
  const reading = reader.read(),
    overlap = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 1);
  jobs[0].resolve(payload());
  await Promise.all([reading, overlap]);
  assert.equal(events.at(-1).view.available, true);
  assert.equal([...timers.values()][0].delay, 120000);
  clock = now + 120000;
  [...timers.values()][0].callback();
  assert.equal(events.at(-1).view.available, false);
  assert.equal(events.at(-1).view.work, null);
  clock = now;
  const again = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  jobs[1].resolve(payload());
  await again;
  assert.equal(events.at(-1).view.available, true);
  const failed = reader.read();
  assert.equal(events.at(-1).view.work, null);
  await new Promise((resolve) => setImmediate(resolve));
  jobs[2].reject(Error('network failure'));
  await failed;
  assert.equal(events.at(-1).view.available, false);
  assert.equal(events.at(-1).loading, false);
  reader.dispose();
  assert.equal(timers.size, 0);
});
test('manual reader drops late results/errors across selection, same tuple reopen, holder replacement and dispose', async () => {
  const jobs = [],
    events = [];
  const reader = current.createNativeWorkCurrentReader({
    request: () => {
      const job = deferred();
      jobs.push(job);
      return job.promise;
    },
    publish: (event) => events.push(event),
    now: () => now,
  });
  const identity = { address: holder };
  reader.select(identity, holder, binding);
  const old = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  reader.select(identity, holder, binding);
  const currentRead = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  jobs[0].resolve(payload());
  await old;
  assert.equal(
    events.some((event) => event.view.available),
    false,
  );
  jobs[1].resolve(payload());
  await currentRead;
  assert.equal(events.at(-1).view.available, true);
  const lateError = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  reader.select({ address: peer }, peer, binding);
  const count = events.length;
  jobs[2].reject(Error('old holder failure'));
  await lateError;
  assert.equal(events.length, count);
  const closing = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  reader.dispose();
  const closedCount = events.length;
  jobs[3].resolve(payload());
  await closing;
  assert.equal(events.length, closedCount);
});
test('actual backend operational projection qualifies frozen fallback and compact status without payment fields', async () => {
  for (const compact of [false, true]) {
    const f = nativeWorkCurrentFixture();
    let reads = 0;
    if (compact) {
      const work = f.state.records['legacy/work/RC-4577'];
      f.state.records['legacy_work_status/RC-4577'] = {
        id: work.id,
        project: work.project,
        task: work.task,
        member: work.member,
        kind: work.kind,
        comparison: false,
        state: 'rejected',
        pending: '',
        withheld: 'known',
        paid: true,
      };
    }
    const service = createNativeWorkCurrent({
      native: {
        configured: true,
        pins: f.pins,
        timeoutMs: 8000,
        publicState: async () => {
          reads++;
          return structuredClone(f.context);
        },
      },
      now: () => now,
    });
    const response = await service.get(f.actor, f.query);
    const view = current.nativeWorkCurrentView(
      response,
      f.actor.address,
      f.query,
      { now },
    );
    assert.equal(view.available, true);
    assert.equal(reads, 1);
    assert.equal(view.work.state, compact ? 'rejected' : 'settled');
    assert.equal(
      view.work.statusSourceKey,
      compact ? 'legacy_work_status/RC-4577' : 'legacy/work/RC-4577',
    );
    assert.equal(view.task.kind, 'instant');
    assert.equal(view.task.outcome, '');
    assert.equal(view.work.paid, undefined);
    assert.equal(view.aiDollarPayment, 'not-established-by-this-record');
  }
});
test('visibility freshness check clears expired current data without issuing another read', async () => {
  let clock = now,
    reads = 0;
  const events = [];
  const reader = current.createNativeWorkCurrentReader({
    request: async () => {
      reads++;
      return payload();
    },
    publish: (event) => events.push(event),
    now: () => clock,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  reader.select({ address: holder }, holder, binding);
  await reader.read();
  assert.equal(events.at(-1).view.available, true);
  clock = now + 120001;
  reader.checkFreshness();
  assert.equal(events.at(-1).view.work, null);
  assert.equal(events.at(-1).view.available, false);
  assert.equal(reads, 1);
  reader.dispose();
});
