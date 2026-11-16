import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';
let t, pool;
before(async () => { t = await boot(); ({ pool } = await import('../dist/src/storage/store.js')); });
after(async () => { await t.close(); });
test('archives hide public projects without deleting rows or changing signed events', async () => {
  const member = await t.member('archive-check');
  await pool.query("INSERT INTO projects (id,title,summary,lead,state,stop_conditions,opened_at) VALUES ('archive-check','Archive check','Test',$1,'proposal','[]',$2)", [member.id, new Date().toISOString()]);
  const before = (await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n;
  await pool.query("INSERT INTO project_archives VALUES ('archive-check','Operator withdrawal',$1)", [new Date().toISOString()]);
  const response = await t.http('/api/projects');
  assert.equal(response.status, 200);
  assert.equal((await t.http('/api/projects/archive-check')).status, 404);
  assert.ok(!JSON.stringify(await response.json()).includes('archive-check'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM projects WHERE id='archive-check'")).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n, before);
});
