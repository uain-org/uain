#!/usr/bin/env node
/**
 * Verifies the built client bundle the way a member's client does before it
 * installs an update: manifest.sig must sign manifest.json's exact bytes with
 * the release key the served uain-worker.mjs pins, and every file the
 * manifest lists must be served with exactly that SHA-256.
 *
 *   node ops/ci-scope/verify-worker-bundle.mjs dist/client/worker
 *
 * Run by `npm run check:worker` in the website image build. public/worker/ holds
 * the frozen final release (0.15.0) of the retired UAIN Client; no further
 * release can be signed, so its files must never change.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyBundle(dir, read = (name) => readFileSync(join(dir, name))) {
  const manifestBytes = read('manifest.json');
  const signature = read('manifest.sig').toString('utf8').trim();
  const client = read('uain-worker.mjs').toString('utf8');
  const key = client.match(/RELEASE_KEY\s*=\s*['"]([A-Za-z0-9_-]{43})['"]/)?.[1];
  if (!key) throw new Error('uain-worker.mjs pins no RELEASE_KEY');
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  if (!verify(null, manifestBytes, publicKey, Buffer.from(signature, 'base64url'))) {
    throw new Error('manifest.sig does not sign manifest.json with the pinned release key');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const version = client.match(/const VERSION = '([^']+)'/)?.[1];
  if (manifest.version !== version) throw new Error(`manifest is for ${manifest.version}, the client is ${version}`);
  const files = Object.entries(manifest.files ?? {});
  if (files.length === 0) throw new Error('manifest lists no files');
  for (const [name, expected] of files) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`manifest lists an unsafe name: ${name}`);
    const actual = createHash('sha256').update(read(name)).digest('hex');
    if (actual !== expected) throw new Error(`${name}: served bytes differ from the signed manifest; public/worker/ is the frozen final release and must not change`);
  }
  return { version, files: files.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? 'dist/client/worker';
  try {
    const { version, files } = verifyBundle(dir);
    console.log(`worker bundle ${version}: signature and ${files} file hashes verified`);
  } catch (error) {
    console.error(`worker bundle verification failed: ${error.message}`);
    process.exit(1);
  }
}
