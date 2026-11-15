import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// Import the actual compiled module with only its store replaced. No database,
// clock delays or network: gates deterministically hold a counter write open.
const batches = [];
const persisted = new Map();
const stub = `export const prepare = () => ({ all: (...args) => globalThis.__rateBarrierStore(...args) });`;
globalThis.__rateBarrierStore = (ids, times, counts) => new Promise((resolve, reject) => {
  batches.push({ ids, counts, reject, release() {
    resolve(ids.map((id, i) => {
      const count = (persisted.get(id) ?? 0) + counts[i];
      persisted.set(id, count);
      return { id, started: times[i], count };
    }));
  } });
});
const source = readFileSync(new URL('../dist/src/storage/ratelimit.js', import.meta.url), 'utf8')
  .replace(/['"]\.\/store\.js['"]/, JSON.stringify('data:text/javascript,' + encodeURIComponent(stub)));
const limits = await import('data:text/javascript,' + encodeURIComponent(source));
const turn = () => new Promise(resolve => setImmediate(resolve));

test('awaited sync drains earlier writes and hits arriving in flight, restoring failed batches exactly once', async () => {
  await limits.hit('requests', 'barrier');
  const first = limits.syncCounts();
  await turn();
  assert.equal(batches.length, 1);
  let done = false;
  const second = limits.syncCounts().then(() => { done = true; });
  await turn();
  assert.equal(done, false, 'second sync must wait for the earlier write');
  await limits.hit('requests', 'barrier');
  const third = limits.syncCounts();
  batches[0].release();
  await turn();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1].counts, [1], 'hit during first write is sent once');
  assert.equal(done, false, 'second sync also waits for its own batch');
  batches[1].release();
  await Promise.all([first, second, third]);
  assert.equal(persisted.get('requests:barrier'), 2);

  await limits.hit('requests', 'recovery');
  const failed = limits.syncCounts();
  await turn();
  await limits.hit('requests', 'recovery');
  const retry = limits.syncCounts();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    batches[2].reject(new Error('controlled write failure'));
    await turn();
  } finally { console.error = originalError; }
  assert.equal(errors.length, 1);
  assert.deepEqual(batches[3].counts, [2], 'restored count plus new hit');
  batches[3].release();
  await Promise.all([failed, retry]);
  await limits.syncCounts();
  assert.equal(batches.length, 4, 'empty flush never replays a persisted batch');
  assert.equal(persisted.get('requests:recovery'), 2);
});
