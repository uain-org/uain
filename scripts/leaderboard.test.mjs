import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankWork, readLeaderboard } from '../lib/network/leaderboard.ts';
const work = [
  {
    id: 'C1',
    contributor: 'a',
    state: 'contested',
    verifications: [{ verifier: 'b' }, { verifier: 'b' }],
  },
  {
    id: 'C2',
    contributor: 'b',
    state: 'settled',
    verifications: [{ verifier: 'a' }],
  },
  { id: 'C3', contributor: 'a', state: 'submitted', verifications: [] },
];
test('rank settled work separately and count each reviewed contribution once', () => {
  const result = rankWork(work);
  assert.equal(result.contributors[0].id, 'b');
  assert.deepEqual(result.contributors[1], {
    id: 'a',
    settled: [],
    contested: ['C1'],
    other: ['C3'],
  });
  assert.deepEqual(result.checkers, [
    { id: 'a', work: ['C2'] },
    { id: 'b', work: ['C1'] },
  ]);
});
const page = (rows, extra = {}) =>
  Response.json({
    authority: 'native',
    epoch: 'e',
    app_hash: 'h',
    count: 3,
    page: 1,
    pages: 1,
    contributions: rows,
    ...extra,
  });
test('unavailable, retired, partial, duplicate and changing-epoch reads refuse a ranking', async () => {
  for (const response of [
    new Response('{}', { status: 409 }),
    new Response('{}', { status: 503 }),
    page(work.slice(1)),
    page([work[0], work[0], work[2]]),
    page(work, { authority: 'legacy' }),
  ])
    await assert.rejects(readLeaderboard('', async () => response));
  let calls = 0;
  await assert.rejects(
    readLeaderboard('', async () =>
      ++calls === 1
        ? page(work.slice(0, 1), { pages: 2 })
        : page(work.slice(1), { page: 2, pages: 2, epoch: 'different' }),
    ),
  );
});
test('changed native state between pages refuses mixed rankings', async () => {
  let calls = 0;
  await assert.rejects(
    readLeaderboard('', async () =>
      ++calls === 1
        ? page(work.slice(0, 1), { pages: 2 })
        : page(work.slice(1), { page: 2, pages: 2, app_hash: 'changed' }),
    ),
  );
});
test('complete pages and empty native census return honest rankings', async () => {
  let calls = 0;
  const result = await readLeaderboard('', async () =>
    ++calls === 1
      ? page(work.slice(0, 1), { pages: 2 })
      : page(work.slice(1), { page: 2, pages: 2 }),
  );
  assert.equal(result.count, 3);
  assert.equal(calls, 2);
  assert.deepEqual(
    (await readLeaderboard('', async () => page([], { count: 0 })))
      .contributors,
    [],
  );
});
