import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentitySessionGate } from './identity-session.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('closed modal identity work cannot publish readiness or download a backup', async () => {
  const gate = createIdentitySessionGate();
  assert.equal(gate.begin(), null);
  gate.activate();
  const token = gate.begin();
  const imported = deferred();
  let published = 0;
  const work = (async () => {
    await imported.promise;
    if (token.isCurrent()) published++;
  })();
  gate.invalidate();
  assert.equal(gate.begin(), null);
  imported.resolve();
  await work;
  assert.equal(published, 0);
  assert.equal(token.isCurrent(), false);
});

test('a newer operation supersedes pending identity work in the same modal', () => {
  const gate = createIdentitySessionGate();
  gate.activate();
  const earlier = gate.begin();
  const latest = gate.begin();
  assert.equal(earlier.isCurrent(), false);
  assert.equal(latest.isCurrent(), true);
});

test('cleanup then remount cannot revive a pending operation from an old session', async () => {
  const gate = createIdentitySessionGate();
  gate.activate();
  const old = gate.begin();
  gate.invalidate();
  gate.activate();
  const current = gate.begin();
  assert.equal(old.isCurrent(), false);
  assert.equal(current.isCurrent(), true);
  gate.invalidate();
  gate.invalidate();
  assert.equal(current.isCurrent(), false);
  assert.equal(gate.begin(), null);
});
