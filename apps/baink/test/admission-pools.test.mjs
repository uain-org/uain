import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBainkServer } from '../server/app.mjs';
import { member, signed, audience } from './http-fixture.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

// 10 November 2026 burst test: proof reads queued for seconds filled the 64
// request slots, and BAINK then refused pages and health with 503 busy.
test('queued native proof reads use their own 48 slots and leave the 64 general slots free', { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-pools-'));
  let app, release;
  const sockets = [];
  t.after(async () => { release?.(); for (const s of sockets) s.destroy(); if (app) { app.server.closeAllConnections(); await app.close(); } await rm(dir, { recursive: true, force: true }); });
  const people = Array.from({ length: 49 }, () => member());
  const genesis = JSON.stringify({ chain_id: 'isolated-pools' }), binary = join(dir, 'reader'), genesisFile = join(dir, 'genesis.json');
  await writeFile(binary, 'synthetic pinned transport fixture', { mode: 0o700 });
  await writeFile(genesisFile, genesis, { mode: 0o600 });
  const config = { binary, binaryHash: hash('synthetic pinned transport fixture'), genesis: genesisFile, genesisHash: hash(genesis), chainId: 'isolated-pools', rpc: 'http://127.0.0.1:1', timeoutMs: 8000, maxAgeSeconds: 120 };
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 1, accounts: Object.fromEntries(people.map((p) => [p.address, { address: p.address, publicKey: p.publicKey, displayName: 'Fictional fixture', createdAt: '2026-01-01T00:00:00Z' }])), requests: {}, nonces: {}, history: [], nativeIntents: {} }), { mode: 0o600 });
  // The proof reader never answers until the test releases it.
  const gate = new Promise((resolve) => { release = resolve; });
  const transport = { profile: { chainId: config.chainId, genesisSha256: config.genesisHash, verifierSha256: config.binaryHash, maxAgeSeconds: 120 }, prepare: async () => {}, close: async () => {}, read: async () => { throw Error('synthetic single-reader refusal'); }, async readBatch(members, { signal }) { await Promise.race([gate, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }))]); throw Error('synthetic proof unavailable'); } };
  app = await createBainkServer({ dataDir: dir, publicOrigin: audience, projectsSource: null, catalogueDir: null, trustProxy: true, nativeConfig: config, nativeStateTransport: transport, nativeAccountBatchingEnabled: true });
  let inFlightNative = 0;
  app.server.on('request', (req) => { if (req.url === '/api/account' && req.headers['x-baink-public-key']) inFlightNative++; });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, base = `http://127.0.0.1:${port}`;
  const get = (who, path, ip) => fetch(base + path, { headers: { Origin: audience, 'X-Real-IP': ip, ...(who ? signed(who, 'GET', path, {}) : {}) } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), () => ({ status: 0 }));
  // 48 members wait for a proof (three per client IP, below the per-IP 16).
  const queued = people.slice(0, 48).map((p, i) => get(p, '/api/account', `198.51.100.${1 + Math.floor(i / 3)}`));
  for (const deadline = Date.now() + 10000; inFlightNative < 48; ) { assert.ok(Date.now() < deadline, 'proof reads queued'); await new Promise((r) => setTimeout(r, 5)); }
  await new Promise((r) => setTimeout(r, 50));
  // A 49th proof read is refused: the native pool is still bounded.
  const refused = await get(people[48], '/api/account', '198.51.100.200');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'busy');
  // 30 slow general requests (slow bodies from distinct IPs) are all admitted:
  // before this change 48 + 16 filled the shared 64 slots.
  for (let i = 0; i < 30; i++) {
    const received = once(app.server, 'request'), socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write(`POST /api/account HTTP/1.1\r\nHost: baink.example\r\nX-Real-IP: 203.0.113.${1 + Math.floor(i / 10)}\r\nContent-Type: application/json\r\nContent-Length: 16000\r\n\r\n{`);
    await received;
  }
  const health = await get(null, '/api/health', '192.0.2.10');
  assert.equal(health.status, 200, 'pages and health stay available while proofs queue');
  release();
  for (const s of sockets) s.destroy();
  const answers = await Promise.all(queued);
  assert.ok(answers.every((a) => a.status !== 0), 'queued proof reads are answered, not dropped');
});
