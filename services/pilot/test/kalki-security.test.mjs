import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

async function source(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const saved = { UAIN_KALKI_STATUS_URL: process.env.UAIN_KALKI_STATUS_URL, UAIN_KALKI_KEY: process.env.UAIN_KALKI_KEY };
  process.env.UAIN_KALKI_STATUS_URL = `http://127.0.0.1:${server.address().port}/status`;
  process.env.UAIN_KALKI_KEY = 'test-only-status-key';
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
}

test('round 3: Kalki refuses oversized declared and chunked upstream JSON', async (t) => {
  let declared = true;
  await source(t, (req, res) => {
    const body = JSON.stringify({ projects: [{ id: 'health', name: 'x'.repeat(2 * 1024 * 1024) }] });
    if (declared) res.setHeader('content-length', Buffer.byteLength(body));
    res.write(body);
    res.end();
  });
  for (const variant of ['declared', 'chunked']) {
    declared = variant === 'declared';
    const { kalkiProjects } = await import(`../dist/src/api/kalki.js?security=${variant}`);
    assert.deepEqual(await kalkiProjects(), []);
  }
});

test('round 3: Kalki does not follow redirects carrying its upstream credential', async (t) => {
  let redirected = 0;
  await source(t, (req, res) => {
    if (req.url === '/status') res.writeHead(302, { location: '/unexpected' }).end();
    else { redirected++; res.end(JSON.stringify({ projects: [{ id: 'health', name: 'Unexpected' }] })); }
  });
  const { kalkiProjects } = await import('../dist/src/api/kalki.js?security=redirect');
  assert.deepEqual(await kalkiProjects(), []);
  assert.equal(redirected, 0);
});


test('follow-up pass 3: concurrent cold and expired Kalki reads share one refresh', async (t) => {
  let calls = 0;
  await source(t, (_req, res) => { calls++; res.end(JSON.stringify({ projects: [{ id: 'health', name: 'Verified' }] })); });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const { kalkiProjects } = await import('../dist/src/api/kalki.js?security=shared-refresh');
  for (const expected of [1, 2]) {
    const results = await Promise.all(Array.from({ length: 20 }, () => kalkiProjects()));
    assert.equal(calls, expected);
    assert.ok(results.every(result => result[0]?.name === 'Verified'));
    now += 31_000;
  }
});

test('follow-up pass 3: failed Kalki refresh backs off and never extends stale display', async (t) => {
  let calls = 0, failed = false;
  await source(t, (_req, res) => {
    calls++;
    if (failed) res.writeHead(503).end();
    else res.end(JSON.stringify({ projects: [{ id: 'health', name: 'Verified' }] }));
  });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const { kalkiProjects } = await import('../dist/src/api/kalki.js?security=failed-refresh');
  assert.equal((await kalkiProjects())[0].name, 'Verified');
  failed = true; now += 295_000;
  const stale = await Promise.all(Array.from({ length: 20 }, () => kalkiProjects()));
  assert.equal(calls, 2);
  assert.ok(stale.every(result => result[0]?.name === 'Verified'));
  now += 6_000;
  assert.deepEqual(await kalkiProjects(), []);
  assert.equal(calls, 2, 'cooldown prevents another refresh, but stale data expires');
  now += 4_001;
  assert.deepEqual(await kalkiProjects(), []);
  assert.equal(calls, 3, 'retry resumes after the ten-second failure cooldown');
});
