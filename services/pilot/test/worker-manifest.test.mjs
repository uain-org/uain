/**
 * public/worker/ serves the final signed release of the retired UAIN Client
 * (0.15.0). Installed clients update to it once and then tell their member
 * the client is retired. No further release can be signed, so every served
 * file is a frozen copy in public/worker/ (no longer built from chain/client
 * or the pilot's follow.ts), and this test fails the build if any of them
 * changes, or a file is added or removed there. See
 * docs-crucial/client-release.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyBundle } from '../../../ops/ci-scope/verify-worker-bundle.mjs';

const WORKER = fileURLToPath(new URL('../../../public/worker/', import.meta.url));
const FROZEN =
  'public/worker/ is the frozen final release of the retired UAIN Client and can never be signed again: restore the file from git history instead of editing it.';
const read = (name) => fs.readFileSync(WORKER + name);
const manifest = () => JSON.parse(read('manifest.json').toString('utf8'));
const pinnedKey = (text) => text.match(/RELEASE_KEY\s*=\s*['"]([A-Za-z0-9_-]{43})['"]/)?.[1];

test('manifest.sig signs manifest.json with the pinned release key, and every listed file is served exactly as signed', () => {
  let result;
  assert.doesNotThrow(() => (result = verifyBundle(WORKER)), FROZEN);
  assert.equal(result.version, manifest().version);
});

test('install.sh pins the same release key as the client', () => {
  const key = pinnedKey(read('uain-worker.mjs').toString('utf8'));
  assert.ok(key, 'uain-worker.mjs pins a release key (RELEASE_KEY)');
  assert.equal(pinnedKey(read('install.sh').toString('utf8')), key, FROZEN);
});

test('public/worker/ holds exactly the signed files, the manifest and its signature', () => {
  const served = fs.readdirSync(WORKER).filter((name) => !name.startsWith('.')).sort();
  const expected = [...Object.keys(manifest().files), 'manifest.json', 'manifest.sig'].sort();
  assert.deepEqual(served, expected, FROZEN);
});

test('it is the final release, 0.15.0, which takes no work', () => {
  assert.equal(manifest().version, '0.15.0', FROZEN);
});
