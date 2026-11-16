import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchClient, older, clientOrigin, verifiedManifest } from '../fetch-client.mjs';
import { signedFixture } from './fixture.mjs';

test('signed client install rejects altered signatures, files, caches and downgrades', async () => {
  const bundle = await signedFixture();
  let changed = null;
  const server = createServer((req, res) => {
    const name = req.url.slice('/worker/'.length);
    const bytes = bundle[name];
    if (!bytes) { res.writeHead(404).end(); return; }
    res.end(changed === name ? Buffer.from('tampered') : bytes);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'uain-runner-test-'));
  try {
    const good = await fetchClient(base, temporary, { allowLoopback: true });
    assert.match(good.version, /^\d+\.\d+\.\d+$/);
    changed = 'manifest.sig';
    await assert.rejects(fetchClient(base, temporary, { allowLoopback: true }), /signature refused/);
    changed = 'uain-key.mjs';
    await assert.rejects(fetchClient(base, temporary, { allowLoopback: true }), /hash refused/);
    changed = null;
    await fs.writeFile(path.join(good.directory, 'uain-key.mjs'), 'tampered cached key module');
    await assert.rejects(fetchClient(base, temporary, { allowLoopback: true }), /Cached client hash refused/);
    assert.throws(() => verifiedManifest(bundle['manifest.json'], bundle['manifest.sig'], '999.0.0'), /downgrade refused/);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
test('origin and version validation reject external HTTP, credential URLs and nonversions', () => {
  assert.equal(clientOrigin('https://uain.global'), 'https://uain.global');
  for (const base of ['http://uain.global', 'https://secret@uain.global', 'https://uain.global/worker', 'http://10.0.0.1'])
    assert.throws(() => clientOrigin(base, true));
  assert.equal(older('0.14.3', '0.15.0'), true);
  assert.equal(older('0.14.3', '0.14.3'), false);
  assert.throws(() => older('../../key.json', '0.14.3'));
});
