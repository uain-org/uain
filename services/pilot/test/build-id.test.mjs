import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot } from './helpers.mjs';
import { readBuildId } from '../dist/src/api/build-id.js';
import { buildId as writeBuildId } from '../../../ops/docs/build-id.mjs';

// GET /api/build says which source commit the running image was built from
// (10 November 2026), so the live site can be matched to a release.
const commit = '0123456789abcdef0123456789abcdef01234567';
const unknown = { schema: 1, component: 'uain-pilot', commit: null, built_at: null };

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

test('a build id file is read exactly, and anything else reads as unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uain-build-id-'));
  try {
    const file = join(dir, 'build.json');
    assert.deepEqual(readBuildId(file), unknown, 'no file: a server started outside an image');
    // What the Dockerfile's step writes is what the server reads.
    const now = () => new Date('2026-11-10T09:30:15Z');
    writeFileSync(file, JSON.stringify(writeBuildId('uain-pilot', { env: { UAIN_SOURCE_COMMIT: commit }, now })));
    assert.deepEqual(readBuildId(file), { schema: 1, component: 'uain-pilot', commit, built_at: '2026-11-10T09:30:15Z' });
    writeFileSync(file, JSON.stringify(writeBuildId('uain-pilot', { env: {}, now })));
    assert.deepEqual(readBuildId(file), { ...unknown, built_at: '2026-11-10T09:30:15Z' }, 'built without a commit');
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ schema: 2, component: 'uain-pilot', commit, built_at: '2026-11-10T09:30:15Z' }),
      JSON.stringify({ schema: 1, component: 'uain-web', commit, built_at: '2026-11-10T09:30:15Z' }),
      JSON.stringify({ schema: 1, component: 'uain-pilot', commit, built_at: 'today' }),
      JSON.stringify({ schema: 1, component: 'uain-pilot', commit, built_at: '2026-11-10T09:30:15Z', pad: 'x'.repeat(5000) }),
    ]) {
      writeFileSync(file, bad);
      assert.deepEqual(readBuildId(file), unknown, bad.slice(0, 60));
    }
    writeFileSync(file, JSON.stringify({ schema: 1, component: 'uain-pilot', commit: 'HEAD', built_at: '2026-11-10T09:30:15Z' }));
    assert.equal(readBuildId(file).commit, null, 'a malformed commit is never served');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native authority lets the build id through like health and readiness', async () => {
  // Imported after boot(): the store reads its settings when first loaded.
  const { handleNativeAuthorityRoutes } = await import('../dist/src/api/native-publication-routes.js');
  const saved = process.env.UAIN_AUTHORITY;
  process.env.UAIN_AUTHORITY = 'native';
  try {
    const res = { setHeader() {} };
    const sent = [];
    const send = (_res, status, body) => sent.push([status, body]);
    const at = (path) => new URL(path, 'https://uain.invalid');
    assert.equal(await handleNativeAuthorityRoutes({ method: 'GET' }, res, at('/api/build'), send), false);
    assert.equal(await handleNativeAuthorityRoutes({ method: 'GET' }, res, at('/api/health'), send), false);
    // The member profile's contribution view (P0-3, 12 November 2026) passes too; a malformed address does not.
    assert.equal(await handleNativeAuthorityRoutes({ method: 'GET' }, res, at('/api/contribution/uain1' + 'a'.repeat(40)), send), false);
    assert.equal(await handleNativeAuthorityRoutes({ method: 'GET' }, res, at('/api/accepted'), send), false, 'accepted work is a native read (16 November 2026)');
    assert.deepEqual(sent, []);
    assert.equal(await handleNativeAuthorityRoutes({ method: 'GET' }, res, at('/api/contribution/uain1xyz'), send), true);
    sent.length = 0;
    // Anything else is still refused there, and so is writing to the build id.
    assert.equal(await handleNativeAuthorityRoutes({ method: 'POST' }, res, at('/api/build'), send), true);
    assert.equal(sent[0][0], 409);
  } finally {
    if (saved === undefined) delete process.env.UAIN_AUTHORITY;
    else process.env.UAIN_AUTHORITY = saved;
  }
});

test('GET /api/build answers with the build id shape and no guess', async () => {
  const response = await t.http('/api/build');
  assert.equal(response.status, 200);
  // The test server runs from the source tree, not an image: nothing is known.
  assert.deepEqual(await response.json(), unknown);
  assert.equal((await t.http('/api/build', { method: 'POST', body: '{}' })).status, 404);
});
