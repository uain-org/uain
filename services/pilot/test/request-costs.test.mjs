/**
 * What every request used to write, now counted per server and sent in
 * batches: the request budget and last seen. Sessions are still looked up on
 * every request, so logging out ends one at once.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { boot } from './helpers.mjs';

let t;
let limits;
before(async () => {
  t = await boot({ UAIN_RATE_REQUESTS_PER_MIN: '10' });
  limits = await import('../dist/src/storage/ratelimit.js');
});
after(async () => {
  await t.close();
});

async function elsewhere(sql, params) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

test('the request budget is shared: counts reach the table, and other servers count against it', async () => {
  const key = 'caller-a';
  for (let i = 0; i < 4; i++) assert.equal((await limits.hit('requests', key)).allowed, true);
  await limits.syncCounts();
  const row = (await elsewhere("SELECT count FROM rate_windows WHERE id = 'requests:caller-a'")).rows[0];
  assert.equal(Number(row.count), 4);
  // Another server counted 6 more for the same caller in the same window.
  await elsewhere("UPDATE rate_windows SET count = count + 6 WHERE id = 'requests:caller-a'");
  assert.equal((await limits.hit('requests', key)).allowed, true); // not yet synced: 5 known here
  await limits.syncCounts(); // now 4 + 6 + 1 = 11 > 10
  const refused = await limits.hit('requests', key);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfter >= 1);
});

test('within one server the budget is exact', async () => {
  const results = await Promise.all(Array.from({ length: 25 }, () => limits.hit('requests', 'caller-b')));
  assert.equal(results.filter((r) => r.allowed).length, 10);
});

test('last seen reaches the database with the next batch', async () => {
  const m = await t.member('Seen Op');
  await t.db.prepare("UPDATE participants SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(m.id);
  assert.ok(await t.db.authenticate(m.token));
  await t.db.flushSeen();
  const row = await t.db.prepare('SELECT last_seen_at FROM participants WHERE id = ?').get(m.id);
  assert.ok(row.last_seen_at && Date.now() - Date.parse(row.last_seen_at) < 60_000, JSON.stringify(row));
});

test('a session that logged out is refused at once', async () => {
  const m = await t.member('Leaving Op');
  assert.ok(await t.db.authenticate(m.token));
  await t.db.logout(m.token);
  assert.equal(await t.db.authenticate(m.token), null);
});
