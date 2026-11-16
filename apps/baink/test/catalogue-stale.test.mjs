import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';
import { audience } from './http-fixture.mjs';

// 10 November 2026 burst test: a slow uain.global made every project-list
// request wait up to 6 s for the catalogue refresh, holding a request slot.
test('a slow catalogue refresh serves the last live catalogue at once; after 15 minutes callers wait', { timeout: 30000 }, async (t) => {
  let mode = 'live', hung = [];
  const source = createServer((req, res) => {
    if (mode === 'hang') { hung.push(res); return; }
    if (mode === 'fail') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ projects: [{ id: 'fictional-one', title: 'Fictional project one', tasks: 2 }] }));
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'baink-catalogue-'));
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const app = await createBainkServer({ dataDir: dir, publicOrigin: audience, projectsSource: `http://127.0.0.1:${source.address().port}/api/projects`, catalogueDir: null, trustProxy: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { Date.now = realNow; for (const res of hung) res.destroy(); source.close(); app.server.closeAllConnections(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  const get = async () => { const began = realNow(); const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/projects`, { headers: { Origin: audience } }); return { ms: realNow() - began, body: await r.json() }; };

  const first = await get();
  assert.equal(first.body.source.status, 'live');
  assert.equal(first.body.projects[0].id, 'fictional-one');
  // Expired cache with a hanging source: answered at once from the last live catalogue.
  mode = 'hang';
  offset = 61_000;
  const stale = await get();
  assert.ok(stale.ms < 1000, `served in ${stale.ms} ms`);
  assert.equal(stale.body.source.status, 'live');
  assert.equal(stale.body.source.fetchedAt, first.body.source.fetchedAt);
  assert.equal(stale.body.projects[0].id, 'fictional-one');
  // A failed refresh keeps the last live catalogue.
  for (const res of hung.splice(0)) res.destroy();
  mode = 'fail';
  await new Promise((r) => setTimeout(r, 200));
  offset = 75_000;
  assert.equal((await get()).body.projects[0].id, 'fictional-one');
  // Older than 15 minutes: callers wait for the fetch and see it fail.
  offset = 16 * 60_000;
  await new Promise((r) => setTimeout(r, 200));
  const old = await get();
  assert.equal(old.body.source.status, 'unavailable');
  assert.equal(old.body.projects.length, 0);
});
