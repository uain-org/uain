import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadiness } from '../dist/src/operations/readiness.js';

test('readiness distinguishes a usable schema from missing schema or failed store', async () => {
  assert.equal(await createReadiness(async () => true)(), true);
  assert.equal(await createReadiness(async () => false)(), false);
  assert.equal(await createReadiness(async () => { throw new Error('private connection data'); })(), false);
});

test('bounded probes share in-flight work and do not accumulate timed-out DB queries', async () => {
  let calls = 0, finish;
  const check = createReadiness(() => { calls++; return new Promise(r => { finish = r; }); }, { timeoutMs: 20 });
  assert.deepEqual(await Promise.all([check(), check()]), [false, false]);
  assert.equal(await check(), false);
  assert.equal(calls, 1);
  finish(true);
  await new Promise(r => setImmediate(r));
  assert.equal(await check(), false);
  assert.equal(calls, 2);
  finish(true);
});
