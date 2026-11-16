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

test('leaderboard member profile exposes accepted work instead of only enrolled systems', async () => {
  const { build } = await import('esbuild');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const dir = await mkdtemp(join(tmpdir(), 'uain-member-work-'));
  try {
    const output = await build({
      stdin: { contents: `import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {MemberAccount} from './components/network/member-account'; import * as work from './components/network/accepted-work'; const {AcceptedWork} = work; export const readMemberContribution = work.readMemberContribution; export const renderMember = member => renderToStaticMarkup(createElement(MemberAccount, {member})); export const renderAccepted = view => renderToStaticMarkup(createElement(AcceptedWork, {view, limit:50}));`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'tsx' },
      absWorkingDir: new URL('..', import.meta.url).pathname,
      bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
    });
    const path = join(dir, 'render.cjs');
    await writeFile(path, output.outputFiles[0].text);
    const { renderMember, renderAccepted, readMemberContribution } = createRequire(import.meta.url)(path);
    const html = renderMember({ address: addr('b'), name: 'Fixture member', about: null, public_key: null, karma: 360, created_at: '2026-11-01T00:00:00Z', licence: { status: 'active' }, agents: [] });
    assert.match(html, /Accepted research/);
    assert.match(html, /Reading accepted work/);
    assert.doesNotMatch(html, /No accepted research yet/);
    const items = Array.from({ length: 36 }, (_, n) => ({ task: `T-fixture-${n}`, project: 'P-fixture', submission: `S-fixture-${n}`, points: 10, 'amountAI$': '10' }));
    const view = { schema: 'uain-contribution-v1', member: addr('b'), points: { total: 360, note: 'FIXTURE points' }, accepted: { count: 36, points: 360, items, more: false }, checks: { count: 0, points: 0 }, notCounted: { awaitingReview: [], needsEvidence: [], rejected: [] }, ledger: { 'earnedAI$': null } };
    const accepted = renderAccepted(view);
    assert.equal((accepted.match(/href="\/tasks\//g) ?? []).length, 36);
    assert.match(accepted, /T-fixture-35/);
    assert.doesNotMatch(accepted, /baink_contribution|baink.money/);
    const empty = { ...view, accepted: { count: 0, points: 0, items: [], more: false } };
    assert.equal((await readMemberContribution(addr('b'), { fetcher: async () => Response.json(empty) })).accepted.count, 0);
    for (const response of [new Response('{}', { status: 503 }), new Response('{}', { status: 404 }), Response.json({ ...view, member: addr('a') }), Response.json({ ...view, schema: 'wrong' })])
      await assert.rejects(readMemberContribution(addr('b'), { fetcher: async () => response }));
    const capped = renderAccepted({ ...view, accepted: { ...view.accepted, count: 70, items: Array.from({ length: 50 }, (_, n) => ({ ...items[0], task: `T-fixture-${n}`, submission: `S-${n}` })), more: true } });
    assert.match(capped, /Showing 50 of 70 accepted answers/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
