import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createBainkServer } from '../server/app.mjs';

const origin = 'https://baink.example';
async function fixture(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-kit-gate-'));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({ version: 1, accounts: {}, requests: {}, nonces: {}, history: [], nativeIntents: {} }));
  const app = await createBainkServer({ dataDir, publicOrigin: origin, projectsSource: null, catalogueDir: null, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const port = app.server.address().port;
  return (path, { method = 'GET', agent, origin: from = origin } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { Host: 'baink.example', Origin: from, 'Content-Type': 'application/json', ...(agent ? { 'User-Agent': agent } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, body, latest: res.headers['x-uain-agent-latest'] }); });
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

test('reads from a uain-agent kit older than the minimum get a plain upgrade message; writes, browsers and current kits pass', async (t) => {
  const request = await fixture(t, { minKitVersion: '0.2.5', latestKitVersion: '0.2.6' });
  const old = await request('/api/config', { agent: 'uain-agent/0.2.0' });
  assert.equal(old.status, 426);
  assert.equal(old.body.error.code, 'kit_outdated');
  assert.match(old.body.error.message, /0\.2\.0.*out of date.*0\.2\.5 or later.*curl -fsSLO https:\/\/baink\.example\/uain-agent\.mjs/);
  assert.equal(old.latest, '0.2.6', 'every API answer names the latest kit');
  assert.equal((await request('/api/config', { agent: 'uain-agent/0.2.5' })).status, 200);
  assert.equal((await request('/api/config', { agent: 'uain-agent/0.10.0' })).status, 200, 'versions compare numerically');
  assert.equal((await request('/api/config')).status, 200, 'browsers and other clients are never gated');
  // An old kit whose saved address is not an allowed origin still learns it only has to update (10 November 2026).
  const strange = await request('/api/account', { agent: 'uain-agent/0.2.0', origin: 'http://elsewhere.example' });
  assert.equal(strange.status, 426); assert.equal(strange.body.error.code, 'kit_outdated');
  assert.equal((await request('/api/config', { agent: 'uain-agent/0.2.5', origin: 'http://elsewhere.example' })).status, 403, 'a current kit still meets the origin check');
  const write = await request('/api/native/central/prepare', { method: 'POST', agent: 'uain-agent/0.2.0' });
  assert.notEqual(write.body?.error?.code, 'kit_outdated', 'a step already in flight can still settle');
});

test('without a configured minimum no kit is gated', async (t) => {
  const request = await fixture(t, {});
  assert.equal((await request('/api/config', { agent: 'uain-agent/0.0.1' })).status, 200);
});
