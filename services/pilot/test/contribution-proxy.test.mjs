// The member profile's contribution view (P0-3, 12 November 2026): this server passes BAINK's one
// derivation on unchanged (GET /api/contribution/:address), held 30 seconds, never recomputed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberContribution, resetMemberContribution, CONTRIBUTION_TTL_MS, CONTRIBUTION_STALE_MS } from '../dist/src/api/contribution-proxy.js';

const M = 'uain1' + 'a'.repeat(40);
const VIEW = { schema: 'uain-contribution-v1', member: M, points: { total: 20 }, accepted: { count: 1 } };

test('a contribution view is passed on unchanged and held for 30 seconds', async () => {
  resetMemberContribution();
  let asked = 0, at = 1_000_000;
  const fetcher = async (url) => {
    asked++;
    assert.equal(url, `https://baink.money/api/public/contribution/${M}`);
    return { status: 200, text: async () => JSON.stringify(VIEW) };
  };
  const now = () => at;
  const first = await memberContribution(M, { fetcher, now, env: {} });
  assert.deepEqual(first, { status: 200, body: VIEW });
  await memberContribution(M, { fetcher, now, env: {} });
  assert.equal(asked, 1, 'held within the window');
  at += CONTRIBUTION_TTL_MS;
  await memberContribution(M, { fetcher, now, env: {} });
  assert.equal(asked, 2, 'asked again after the window');
});

test('a bad address, a failed read or a foreign answer is unavailable, never an empty record', async () => {
  resetMemberContribution();
  assert.equal((await memberContribution('uain1xyz', { env: {} })).status, 400);
  const down = await memberContribution(M, { fetcher: async () => { throw new Error('refused'); }, env: {} });
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'contribution_unavailable');
  const other = await memberContribution(M, { fetcher: async () => ({ status: 200, text: async () => JSON.stringify({ ...VIEW, member: 'uain1' + 'b'.repeat(40) }) }), env: {} });
  assert.equal(other.status, 503, 'an answer about another member is refused');
  const busy = await memberContribution(M, { fetcher: async () => ({ status: 503, text: async () => '{}' }), env: {} });
  assert.equal(busy.status, 503);
});

test('the BAINK read never follows a redirect (P2-6, 13 November 2026)', async () => {
  resetMemberContribution();
  let init;
  await memberContribution(M, { fetcher: async (_url, i) => { init = i; return { status: 200, text: async () => JSON.stringify(VIEW) }; }, env: {} });
  assert.equal(init.redirect, 'error');
  resetMemberContribution();
});

test('a stale view is shown at once while a fresh one is asked for; past the stale window the profile waits', async () => {
  resetMemberContribution();
  let at = 2_000_000, release, version = 1;
  const view = () => ({ ...VIEW, points: { total: version } });
  let slow = false;
  const fetcher = async () => {
    if (slow) await new Promise((r) => { release = r; });
    return { status: 200, text: async () => JSON.stringify(view()) };
  };
  const now = () => at;
  assert.equal((await memberContribution(M, { fetcher, now, env: {} })).body.points.total, 1);
  at += CONTRIBUTION_TTL_MS + 1; slow = true; version = 2;
  const stale = await memberContribution(M, { fetcher, now, env: {} });
  assert.equal(stale.body.points.total, 1, 'the held view answers without waiting for BAINK');
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal((await memberContribution(M, { fetcher, now, env: {} })).body.points.total, 2, 'the refresh replaced it');
  at += CONTRIBUTION_STALE_MS + 1; slow = false; version = 3;
  assert.equal((await memberContribution(M, { fetcher, now, env: {} })).body.points.total, 3, 'too old to show: waits for a fresh view');
});
