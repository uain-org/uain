import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probePilot } from '../dist/src/operations/monitor.js';

const bodies = {
  '/api/health': { ok: true, service: 'uain-pilot' },
  '/api/ready': { ok: true, service: 'uain-pilot' },
  '/api/descriptor': { schema_version: '0.3.0-pilot', identity: { name: 'United AI Network' } },
  '/api/ledger/head': { id: null, hash: '0'.repeat(64), count: 0 },
  '/api/ledger/key': { algorithm: 'Ed25519', raw_base64: Buffer.alloc(32, 1).toString('base64') },
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const mock = async url => response(bodies[new URL(url).pathname]);

test('launch probe accepts a healthy empty ledger without needing an identity or provider key', async () => {
  const requests = [];
  const report = await probePilot('http://127.0.0.1:8787', { fetchImpl: async (url, options) => {
    requests.push(options);
    return mock(url);
  } });
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 5);
  assert.ok(requests.every(r => r.redirect === 'error' && r.method === 'GET' && !r.headers));
  assert.equal(JSON.stringify(report).includes('raw_base64'), false);
});
test('process health cannot hide an unavailable database', async () => {
  const report = await probePilot('https://staging.example', { fetchImpl: async url =>
    new URL(url).pathname === '/api/ready' ? response({ ok: false }, 503) : mock(url) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === 'health').ok, true);
  assert.deepEqual(report.checks.find(c => c.name === 'readiness').error, 'http_status');
});
test('a 200 response with invalid ledger or readiness data fails contract validation', async () => {
  const report = await probePilot('https://staging.example', { fetchImpl: async url =>
    new URL(url).pathname === '/api/ledger/head' ? response({ id: 9, count: 10, hash: 'bad' }) : mock(url) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === 'ledger_head').error, 'invalid_contract');
});
test('oversized and timed-out responses fail with bounded generic diagnostics', async () => {
  const oversized = await probePilot('https://staging.example', { fetchImpl: async () =>
    new Response('x'.repeat(70_000)) });
  assert.ok(oversized.checks.every(c => c.error === 'body_limit'));
  const timed = await probePilot('https://staging.example', { timeoutMs: 10, fetchImpl: (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      // A real HTTP socket keeps Node alive. This transport mock needs its own
      // bounded referenced handle because AbortSignal.timeout() is unref'd.
      const socket = setTimeout(() => reject(new Error('mock did not abort')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(socket); reject(signal.reason); }, { once: true });
    }) });
  assert.ok(timed.checks.every(c => c.error === 'timeout'));
});
test('targets reject embedded credentials, query secrets, paths and non-loopback HTTP', async () => {
  let called = false;
  for (const base of ['https://user:secret@host', 'https://host?key=secret', 'https://host/path', 'http://host', 'file:///tmp'])
    await assert.rejects(probePilot(base, { fetchImpl: async () => { called = true; return response({}); } }), /origin/);
  assert.equal(called, false);
});
