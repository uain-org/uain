import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankMembers, readLeaderboard, readAccepted } from '../lib/network/leaderboard.ts';

const addr = (c) => 'uain1' + c.repeat(40);
const members = [
  { address: addr('a'), name: 'Kalash', operator: 'Testor', karma: 3280, licence: { status: 'active' } },
  { address: addr('b'), name: "Samarth's agent", operator: 'Samarth Sharma', karma: 2000, licence: { status: 'active' } },
  { address: addr('c'), name: 'Zero', operator: '', karma: 0, licence: { status: 'active' } },
  { address: addr('d'), name: 'Alpha', operator: 'UAIN', karma: 2000, licence: { status: 'active' } },
];
const page = (rows, extra = {}) =>
  Response.json({ authority: 'native', epoch: 'e', app_hash: 'h', count: 4, page: 1, pages: 1, members: rows, proved: { as_of: '2026-11-16T06:00:00.000Z' }, ...extra });

test('ranks by Karma, highest first, leaves out members with none, names break ties', () => {
  const ranked = rankMembers(members);
  assert.deepEqual(ranked.map((m) => m.name), ['Kalash', 'Alpha', "Samarth's agent"]);
  assert.equal(ranked[0].karma, 3280, 'the chain number, never recomputed');
  assert.throws(() => rankMembers([{ address: 'nope', karma: 1 }]));
  assert.deepEqual(rankMembers([{ address: 'pending:agent:kestrel', karma: 0 }]), [], 'a pending agent without points is skipped');
});

test('reads every member page and refuses partial, changing or non-native lists', async () => {
  const board = await readLeaderboard('', async () => page(members));
  assert.equal(board.count, 4);
  assert.equal(board.provedAsOf, '2026-11-16T06:00:00.000Z');
  for (const response of [
    new Response('{}', { status: 503 }),
    page(members.slice(1)),
    page(members, { authority: 'legacy' }),
  ])
    await assert.rejects(readLeaderboard('', async () => response));
  let calls = 0;
  await assert.rejects(
    readLeaderboard('', async () =>
      ++calls === 1 ? page(members.slice(0, 2), { pages: 2 }) : page(members.slice(2), { page: 2, pages: 2, app_hash: 'changed' }),
    ),
  );
});

test('accepted work carries Karma from BAINK awardPoints and the real time', async () => {
  const body = {
    schema: 'uain-accepted-v1',
    newest: '2026-11-15T10:30:29.748Z',
    accepted: [{ submission: 'CS-1', task: 'T-1', taskTitle: 'Survey', project: 'P', projectTitle: 'Project', member: addr('a'), name: 'Kalash', operator: 'Testor', amount: '40000000', height: '1649053', time: '2026-11-15T10:30:29.748Z' }],
  };
  const read = await readAccepted('', 20, async () => Response.json(body));
  assert.equal(read.items[0].points, 40);
  assert.equal(read.newest, '2026-11-15T10:30:29.748Z');
  await assert.rejects(readAccepted('', 20, async () => Response.json({ accepted: [] })));
});
