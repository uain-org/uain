import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';

const mod = await import('../dist/src/native/public-visibility.js').catch(() => ({}));
const client = new pg.Client({ connectionString: process.env.UAIN_TEST_PG ?? 'postgres://postgres@127.0.0.1:5432/postgres' });
before(async () => {
  await client.connect();
  // The same existing overlay schema, isolated from every persistent table.
  await client.query('CREATE TEMP TABLE project_archives (project_id text PRIMARY KEY, reason text NOT NULL, archived_at text NOT NULL)');
});
beforeEach(async () => { await client.query('DELETE FROM pg_temp.project_archives'); });
after(async () => { await client.end(); });
const read = () => {
  assert.equal(typeof mod.readNativePublicVisibility, 'function', 'native public visibility overlay reader required');
  return mod.readNativePublicVisibility((sql, args) => client.query(sql, args));
};
const archive = async ids => {
  await client.query("INSERT INTO pg_temp.project_archives SELECT id, 'Test removed from public listings', '2026-10-06T00:00:00Z' FROM unnest($1::text[]) id", [ids]);
};

test('the existing five archive records hide only withdrawn projects and permit new projects', async () => {
  const withdrawn = ['curing-peptic-ulcer-disease-reasoning-from-the-e', 'curing-chronic-hepatitis-c-reasoning-from-the-ev', 'crisis-hotlines-verified', 'feed-safety-following-the-uain-ledger-without-lo', 'checkable-claims-a-reproducible-digest-of-uain-s'];
  await archive(withdrawn);
  const snapshot = await read();
  for (const id of withdrawn) assert.equal(snapshot.isProjectVisible(id), false, id);
  for (const id of ['alzheimer-s-disease-open-questions-answered-from', 'breast-and-lung-cancer-open-questions-with-no-pu', 'longevity-and-ageing-open-questions-on-open-data', 'new-original-research']) assert.equal(snapshot.isProjectVisible(id), true, id);
  assert.equal(snapshot.archivedProjectIds.length, 5);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM pg_temp.project_archives')).rows[0].n, 5, 'reads preserve archive records');
});

test('archive and restoration change cache versions immediately without changing previous snapshots', async () => {
  const initial = await read();
  await archive(['P']);
  const hidden = await read();
  assert.notEqual(hidden.version, initial.version);
  assert.equal(hidden.isProjectVisible('P'), false);
  assert.equal(initial.isProjectVisible('P'), true);
  await client.query("UPDATE pg_temp.project_archives SET reason='Updated explanation', archived_at='2026-10-13T00:00:00Z'");
  assert.equal((await read()).version, hidden.version, 'administrative copy does not change public visibility');
  await client.query("DELETE FROM pg_temp.project_archives WHERE project_id='P'");
  const restored = await read();
  assert.equal(restored.version, initial.version);
  assert.equal(restored.isProjectVisible('P'), true);
  assert.equal(hidden.isProjectVisible('P'), false);
  assert.throws(() => hidden.archivedProjectIds.push('another'), TypeError);
});

test('replacing archived identities changes the version even when archive counts are equal', async () => {
  await archive(['A', 'B']);
  const first = await read();
  await client.query("UPDATE pg_temp.project_archives SET project_id='C' WHERE project_id='B'");
  const second = await read();
  assert.notEqual(second.version, first.version);
  assert.equal(second.isProjectVisible('B'), true);
  assert.equal(second.isProjectVisible('C'), false);
});

test('malformed or oversized archive identities refuse a visibility snapshot', async () => {
  for (const id of ['invalid/id', 'X'.repeat(257)]) {
    await archive([id]);
    await assert.rejects(read, /bounded project archive/);
    await client.query('DELETE FROM pg_temp.project_archives');
  }
});

test('an oversized archive overlay refuses an incomplete visibility snapshot', async () => {
  await client.query("INSERT INTO pg_temp.project_archives SELECT 'P-'||n, 'Test', '2026-10-13T00:00:00Z' FROM generate_series(1,10001) n");
  await assert.rejects(read, /bounded project archive/);
});

test('an unavailable overlay cannot silently expose archived projects', async () => {
  assert.equal(typeof mod.readNativePublicVisibility, 'function');
  await assert.rejects(() => mod.readNativePublicVisibility(() => client.query('SELECT * FROM pg_temp.absent_visibility_overlay')), /does not exist/);
});
