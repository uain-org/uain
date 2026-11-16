import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBainkMcp } from '../server/mcp.mjs';
const request = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'baink_status', arguments: {} },
};
async function fixture(t, options = {}) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handle = createBainkMcp({
    origins: [origin],
    read: async () => ({ ok: true }),
    admit: () => {},
    requesterIp: () => 'client',
    ...options,
  });
  server.on('request', (req, res) =>
    handle(req, res, new URL(req.url, origin)),
  );
  t.after(() => new Promise((r) => server.close(r)));
  return async (body = request) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
}
test('MCP retains8 actual public-read slots until underlying jobs finish', async (t) => {
  let started = 0,
    release;
  const latch = new Promise((r) => (release = r));
  const call = await fixture(t, {
    read: async () => {
      started++;
      await latch;
      return { ok: true };
    },
  });
  const pending = Array.from({ length: 8 }, () => call());
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    function check() {
      if (started === 8) resolve();
      else if (Date.now() > deadline) reject(Error('Jobs did not start'));
      else setTimeout(check, 5);
    }
    check();
  });
  const overflow = await call();
  assert.equal(overflow.status, 503);
  assert.equal(started, 8);
  release();
  const done = await Promise.all(pending);
  assert.ok(done.every((r) => r.body.result.isError === false));
  assert.equal((await call()).status, 200);
});
test('MCP rate admission fails without dispatching a reader', async (t) => {
  let reads = 0;
  const call = await fixture(t, {
    admit() {
      throw Error('private rate detail');
    },
    read: async () => {
      reads++;
      return {};
    },
  });
  const r = await call();
  assert.equal(r.status, 429);
  assert.equal(reads, 0);
  assert.ok(!JSON.stringify(r.body).includes('private rate'));
});
test('MCP rejects oversize/error upstream values without exposing internal failure details', async (t) => {
  for (const read of [
    async () => ({ text: 'x'.repeat(270000) }),
    async () => {
      throw Error('SECRET_UPSTREAM_BODY');
    },
  ]) {
    const call = await fixture(t, { read });
    const r = await call();
    assert.equal(r.body.result.isError, true);
    assert.equal(
      r.body.result.structuredContent.error.code,
      'public_read_unavailable',
    );
    assert.ok(!JSON.stringify(r.body).includes('SECRET_UPSTREAM_BODY'));
  }
});

test('MCP member detail paging follows its advertised schema and preserves exact selectors', async (t) => {
  let observed;
  const call = await fixture(t, {
    read: async (name, args) => {
      observed = { name, args };
      return { members: [] };
    },
  });
  const args = { address: 'uain1' + 'a'.repeat(40), page: 2, pageSize: 2 };
  const r = await call({
    ...request,
    params: { name: 'baink_members', arguments: args },
  });
  assert.equal(r.body.result?.isError, false);
  assert.deepEqual(observed, { name: 'baink_members', args });
});

test('baink_contribution through MCP spends the public contribution budget of the asking address', async (t) => {
  const buckets = [];
  let reads = 0;
  const call = await fixture(t, {
    admit: (bucket) => {
      buckets.push(bucket);
      if (bucket.startsWith('public-contribution-ip:') && buckets.filter((b) => b === bucket).length > 30) throw new Error('limited');
    },
    read: async () => { reads++; return { ok: true }; },
  });
  const ask = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_contribution', arguments: { address: 'uain1' + 'a'.repeat(40) } } };
  for (let i = 0; i < 30; i++) assert.equal((await call(ask)).body.result.isError, false);
  const refused = await call(ask);
  assert.equal(refused.body.result.isError, true);
  assert.match(JSON.stringify(refused.body.result), /rate_limited/);
  assert.equal(reads, 30);
  assert.ok(buckets.includes('public-contribution-ip:client'));
});

// B1-4 (13 November 2026): 4,096 anonymous pings from distinct addresses once
// filled the "mcp" admission map and every new client got 429 for a minute.
test('4,096 anonymous MCP clients from distinct addresses do not lock a new client out of /mcp', async (t) => {
  const { fixture: serverFixture } = await import('./http-fixture.mjs');
  const { request: httpRequest } = await import('node:http');
  const f = await serverFixture(t, { trustProxy: true });
  const ping = (ip) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    const req = httpRequest(f.base + '/mcp', { method: 'POST', headers: { Host: 'baink.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Real-IP': ip, 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
  const codes = {};
  for (let i = 0; i < 4096; i++) { const s = await ping(`2001:db8:${(i >> 8).toString(16)}:${(i & 255).toString(16)}::1`); codes[s] = (codes[s] ?? 0) + 1; }
  assert.equal(codes[200], 4096, JSON.stringify(codes));
  assert.equal(await ping('2001:db8:ffff:1::1'), 200);
  assert.equal(await ping('198.51.100.7'), 200);
});
