import { test } from 'node:test';
import assert from 'node:assert/strict';
const { mapLimit } = await import('../dist/src/native/map-limit.js');
test('mapLimit keeps input order, bounds calls in flight and rejects like a loop', async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0, 6, 7, 8, 9], async (n, i) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, n));
    live--; return n * 10 + i;
  }, 3);
  assert.deepEqual(out, [50, 11, 42, 23, 34, 5, 66, 77, 88, 99]);
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], async () => 1), []);
  await assert.rejects(mapLimit([1, 2], async (n) => { if (n === 2) throw Error('boom'); return n; }), /boom/);
});
