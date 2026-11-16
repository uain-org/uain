import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { fetchPublicSource, isPublicAddress, sourceTransport } from '../dist/src/integrations/source-http.js';

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const result = (status = 200, location) => ({ status, headers: new Headers(location ? { location } : {}) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('public address classification is conservative across IPv4 and IPv6', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of ['127.0.0.1', '255.255.255.255', '192.0.0.9', '198.51.100.1',
    '203.0.113.1', '::', '::ffff:8.8.8.8', '64:ff9b::7f00:1', '2001::1', '2002::1',
    '3fff::1', 'fe80::1%eth0', 'not-an-ip']) assert.equal(isPublicAddress(address), false, address);
});

test('public relative redirects work but a redirect loop stops after six requests', async () => {
  const paths = [];
  const r = await fetchPublicSource('https://paper.example/start', { resolver, transport: async (url) => {
    paths.push(url); return paths.length === 1 ? result(302, '/end') : result();
  } });
  assert.equal(r.status, 200);
  assert.deepEqual(paths, ['https://paper.example/start', 'https://paper.example/end']);
  let calls = 0;
  await assert.rejects(fetchPublicSource('https://paper.example/loop', { resolver, transport: async () => {
    calls++; return result(307, '/loop');
  } }), { code: 'SOURCE_REDIRECT' });
  assert.equal(calls, 6);
});

test('DNS is revalidated on every redirect, including a redirect to the same hostname', async () => {
  let lookups = 0, calls = 0;
  await assert.rejects(fetchPublicSource('https://paper.example/x', {
    resolver: async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '10.0.0.1' }],
    transport: async () => { calls++; return result(302, '/again'); },
  }), { code: 'UNSAFE_SOURCE_URL' });
  assert.equal(calls, 1);
  assert.equal(lookups, 2);
});

test('redirect schemes, userinfo, private IPv6 and HTTPS downgrade are refused', async () => {
  for (const location of ['file:///etc/passwd', 'https://u:secret@paper.example/x',
    'https://[::1]/x', 'http://paper.example/x', 'https://paper.example:8080/x']) {
    let calls = 0;
    await assert.rejects(fetchPublicSource('https://paper.example/x', {
      resolver, transport: async () => { calls++; return result(302, location); },
    }), { code: 'UNSAFE_SOURCE_URL' });
    assert.equal(calls, 1);
  }
});

test('a redirect DNS failure does not label the original source missing', async () => {
  let lookups = 0;
  await assert.rejects(fetchPublicSource('https://paper.example/x', {
    resolver: async () => {
      if (++lookups === 1) return resolver();
      throw Object.assign(new Error('absent'), { code: 'ENOTFOUND' });
    }, transport: async () => result(302, 'https://absent.example/x'),
  }), (e) => e.code === 'ENOTFOUND' && !e.source_missing);
});

test('deadlines cover DNS and transport, with no connection after late DNS', async () => {
  let calls = 0;
  await assert.rejects(fetchPublicSource('https://paper.example/x', {
    timeoutMs: 20, resolver: async () => { await pause(60); return resolver(); },
    transport: async () => { calls++; return result(); },
  }), { code: 'SOURCE_TIMEOUT' });
  await pause(70);
  assert.equal(calls, 0);
  await assert.rejects(fetchPublicSource('https://paper.example/x', {
    timeoutMs: 20, resolver, transport: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), { code: 'SOURCE_TIMEOUT' });
});

test('shared fetch concurrency stays at eight across independent callers', async () => {
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => fetchPublicSource('https://paper.example/x', {
    resolver, transport: async () => {
      active++; peak = Math.max(peak, active);
      await pause(10); active--; return result();
    },
  })));
  assert.equal(peak, 8);
  assert.equal(active, 0);
});

test('queue overflow is bounded and cancellation frees active and waiting slots', async () => {
  const abort = new AbortController();
  const promises = Array.from({ length: 80 }, () => fetchPublicSource('https://paper.example/x', {
    resolver, signal: abort.signal,
    transport: (_url, { signal }) => new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  }));
  const settled = Promise.allSettled(promises);
  await pause(10);
  abort.abort();
  const rows = await settled;
  assert.equal(rows.filter((r) => r.reason?.code === 'SOURCE_BUSY').length, 8);
  assert.equal((await fetchPublicSource('https://paper.example/x', { resolver,
    transport: async () => result() })).status, 200);
});

// Exercise the real native transport against an explicitly created loopback
// fixture. The public-only policy remains active in fetchPublicSource; the
// fixture adapter below is trusted test code and never contacts public hosts.
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return (url, options) => sourceTransport(
    `http://paper.example:${server.address().port}${new URL(url).pathname}`, {
      ...options, lookup: (_host, _opts, callback) => callback(null, '127.0.0.1', 4),
    });
}

test('native transport reads bounded JSON and retains original Host header', async (t) => {
  const transport = await fixture(t, (req, res) => {
    assert.match(req.headers.host, /^paper\.example:/);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.end('{"value":42}');
  });
  const r = await fetchPublicSource('https://paper.example/x', { resolver, transport, readBody: true });
  assert.deepEqual(await r.json(), { value: 42 });
});

test('bounded text artifacts use the same public-only retrieval policy', async (t) => {
  const transport = await fixture(t, (_req, res) => res.end('one,two\n3,4\n'));
  const r = await fetchPublicSource('https://paper.example/data.csv', { resolver, transport, readBody: true, maxBytes: 32 });
  assert.equal(await r.text(), 'one,two\n3,4\n');
});

test('native transport rejects oversized declared and streamed bodies', async (t) => {
  const transport = await fixture(t, (req, res) => {
    if (req.url === '/declared') res.setHeader('content-length', '1024');
    res.end('x'.repeat(128));
  });
  for (const path of ['declared', 'streamed'])
    await assert.rejects(fetchPublicSource(`https://paper.example/${path}`, {
      resolver, transport, readBody: true, maxBytes: 32,
    }), { code: 'SOURCE_TOO_LARGE' });
});

test('native transport cancels slow bodies and rejects compressed responses', async (t) => {
  const transport = await fixture(t, (req, res) => {
    if (req.url === '/compressed') { res.setHeader('content-encoding', 'gzip'); res.end('compressed'); }
    else { res.write('{'); }
  });
  await assert.rejects(fetchPublicSource('https://paper.example/slow', {
    resolver, transport, readBody: true, timeoutMs: 30,
  }), { code: 'SOURCE_TIMEOUT' });
  await assert.rejects(fetchPublicSource('https://paper.example/compressed', {
    resolver, transport, readBody: true,
  }), { code: 'SOURCE_ENCODING' });
});
