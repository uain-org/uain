/**
 * A copy starting while others are busy (ready() in storage/store.ts): the
 * schema is applied once per version, so a start takes no table lock and
 * cannot deadlock with requests already running, as it did in the k3s
 * rehearsal of 2026-09-30.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { boot } from './helpers.mjs';

let t;
let store;
before(async () => {
  t = await boot();
  store = await import('../dist/src/storage/store.js');
});
after(async () => {
  await t.close();
});

test('the applied schema is recorded once', async () => {
  const { rows } = await store.pool.query('SELECT hash FROM schema_applied');
  assert.equal(rows.length, 1);
  await store.ready();
  const again = await store.pool.query('SELECT hash FROM schema_applied');
  assert.equal(again.rows.length, 1, 'a second start adds nothing');
});

test('a start does not wait on a table another request holds', async () => {
  // As a request mid-write: a transaction holding a lock on participants.
  const busy = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await busy.connect();
  try {
    await busy.query('BEGIN');
    await busy.query('LOCK TABLE participants IN ROW EXCLUSIVE MODE');
    const started = Date.now();
    await store.ready();
    assert.ok(Date.now() - started < 1000, 'ready() did not wait for the lock');
  } finally {
    await busy.query('ROLLBACK');
    await busy.end();
  }
});

test('a new version of the schema is applied again', async () => {
  await store.pool.query('DELETE FROM schema_applied');
  await store.pool.query('ALTER TABLE participants DROP COLUMN revoked_reason');
  await store.ready();
  const { rows } = await store.pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'participants' AND column_name = 'revoked_reason'",
  );
  assert.equal(rows.length, 1, 'the missing column is back');
  const applied = await store.pool.query('SELECT hash FROM schema_applied');
  assert.equal(applied.rows.length, 1);
});
