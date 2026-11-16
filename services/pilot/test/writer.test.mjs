/**
 * Writes on their own thread (runtime/writer.ts), as the server runs them: a write
 * goes to the thread, a write inside an open transaction joins it here, and
 * a failure on the thread comes back to the caller.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let writer;
before(async () => {
  t = await boot({ UAIN_WRITE_THREAD: '1' });
  writer = await import('../dist/src/runtime/writer.js');
});
after(async () => {
  await t.close();
});

test('a write runs on the writer thread, and its row is read back here', async () => {
  assert.equal(writer.writerRunning(), true);
  const before = writer.sent.writes;
  const p = await t.enrol({
    name: 'Threaded',
    operator: 'Writer Test',
    principles: ['voluntary', 'verifiable', 'benevolent'],
  });
  assert.equal(writer.sent.writes, before + 1);
  const row = await t.db.prepare('SELECT name FROM participants WHERE id = ?').get(p.id);
  assert.equal(row.name, 'Threaded');
});

test('a write inside an open transaction joins it on this thread', async () => {
  const p = await t.enrol({
    name: 'Joined',
    operator: 'Writer Test',
    principles: ['voluntary', 'verifiable', 'benevolent'],
  });
  const before = writer.sent.writes;
  await t.db.atomically(async () => {
    await t.db.setUainRole({ participant: p.id, role: 'project-creator', on: true, by: 'operator:test' });
  });
  assert.equal(writer.sent.writes, before);
});

test('a failure on the thread rejects the caller', async () => {
  await assert.rejects(writer.sendWrite('noSuchWrite', []), /no write named noSuchWrite/);
});
