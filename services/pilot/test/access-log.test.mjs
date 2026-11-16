/**
 * The access log keeps 30 days. Pruning must not change the adoption numbers,
 * which count over all time, and must keep the enrolment rows the operator's
 * independence report reads.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

/** A row as log() writes it, at a time of the test's choosing. */
const row = (at, action, agent, caller) =>
  t.db
    .prepare(
      `INSERT INTO access_log (at, channel, action, agent, user_agent, caller_hash, status, detail)
       VALUES (?, 'http', ?, ?, NULL, ?, 200, ?)`,
    )
    .run(at, action, agent, caller, action === 'uain_enrol' ? 'enrolled:x' : null);

describe('access log retention', () => {
  test('pruning keeps the all-time numbers and the enrolment rows', async () => {
    // Old and recent rows, with callers and agents on both sides of the
    // cutoff, and distinct counts so the top lists have one order.
    for (let i = 0; i < 7; i++) await row(ago(40), 'GET /api/projects', 'alpha', 'c1');
    for (let i = 0; i < 5; i++) await row(ago(35), 'uain_next', 'beta', 'c2');
    for (let i = 0; i < 3; i++) await row(ago(1), 'uain_next', 'alpha', 'c3');
    await row(ago(2), 'GET /api/tasks', null, 'c1');
    await row(ago(45), 'uain_enrol', 'gamma', 'c4');

    const before = await t.db.accessStats();
    const gone = await t.db.pruneAccessLog(ago(30));
    assert.equal(gone, 12);
    assert.deepEqual(await t.db.accessStats(), before);

    const enrol = await t.db
      .prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'uain_enrol'")
      .get();
    assert.equal(enrol.n, 1);
    const old = await t.db
      .prepare('SELECT COUNT(*) AS n FROM access_log WHERE at < ?')
      .get(ago(30));
    assert.equal(old.n, 1);

    // A second prune finds nothing and changes nothing.
    assert.equal(await t.db.pruneAccessLog(ago(30)), 0);
    assert.deepEqual(await t.db.accessStats(), before);
  });
});
