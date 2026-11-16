import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_KEY = 'XlRwnWHiN9FuiXUD8Q2gwSlEKLNhetU42uRKQbRuAZs';
export const FILES = ['uain-worker.mjs', 'follow.mjs', 'uain-key.mjs', 'install.sh'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const version = (v) => {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('Invalid client version');
  return v.split('.').map(Number);
};
export function older(a, b) {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
export function verifiedManifest(raw, signature, minimum = '0.14.3') {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: RELEASE_KEY }, format: 'jwk' });
  if (!verify(null, raw, key, Buffer.from(signature.toString().trim(), 'base64url')))
    throw new Error('Client signature refused');
  const manifest = JSON.parse(raw);
  if (older(manifest.version, minimum)) throw new Error('Client downgrade refused');
  for (const name of FILES)
    if (!/^[a-f0-9]{64}$/.test(manifest.files?.[name])) throw new Error(`Missing signed hash: ${name}`);
  return manifest;
}
export function clientOrigin(base, allowLoopback = false) {
  const url = new URL(base);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('UAIN_API must be an origin without credentials or a path');
  if (url.protocol !== 'https:' && !(allowLoopback && local && url.protocol === 'http:'))
    throw new Error('UAIN_API requires HTTPS (HTTP is allowed only for explicit loopback tests)');
  return url.origin;
}
export async function fetchClient(base, destination, { minimum = '0.14.3', allowLoopback = false } = {}) {
  const origin = clientOrigin(base, allowLoopback);
  async function get(name) {
    const response = await fetch(`${origin}/worker/${name}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 4 * 1024 * 1024) throw new Error(`${name}: oversized client file`);
    return bytes;
  }
  const [raw, signature] = await Promise.all([get('manifest.json'), get('manifest.sig')]);
  const manifest = verifiedManifest(raw, signature, minimum);
  const files = await Promise.all(FILES.map(async (name) => {
    const bytes = await get(name);
    if (sha(bytes) !== manifest.files[name]) throw new Error(`Client hash refused: ${name}`);
    return [name, bytes];
  }));
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const release = path.join(destination, sha(raw));
  const temporary = await fs.mkdtemp(path.join(destination, '.verified-'));
  try {
    for (const [name, bytes] of [...files, ['manifest.json', raw], ['manifest.sig', signature]])
      await fs.writeFile(path.join(temporary, name), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(temporary, 'install.json'), JSON.stringify({ base: origin }), { mode: 0o600 });
    try { await fs.rename(temporary, release); }
    catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
    // Validate existing cache bytes too; a previous file is never trusted merely because it exists.
    for (const name of FILES)
      if (sha(await fs.readFile(path.join(release, name))) !== manifest.files[name]) throw new Error(`Cached client hash refused: ${name}`);
    return { directory: release, version: manifest.version };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const installed = await fetchClient(process.env.UAIN_API ?? 'https://uain.global', process.argv[2] ?? '/opt/uain/client-seed');
  console.log(`Verified client ${installed.version}`);
}
