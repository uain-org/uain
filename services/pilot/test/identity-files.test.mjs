/**
 * The ledger's signing key and the log salt, on a data directory every copy
 * of the server shares (compose.yaml runs four). However many copies start
 * on a fresh directory at once, one key and one salt are made and every copy
 * loads them; after that they are never replaced, and a damaged one stops the
 * server rather than being made again.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.mjs';

// The copies share the test's database, as the replicas share production's.
let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const fixture = fileURLToPath(new URL('./fixtures/identity.mjs', import.meta.url));
const freshDir = () => mkdtempSync(join(tmpdir(), 'uain-identity-'));

/**
 * Starts `n` copies on `dir` together; how each ended and what it printed.
 * `started` runs as they are told to go.
 */
async function start(dir, n, started = () => {}) {
  const copies = Array.from({ length: n }, () => {
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, UAIN_DATA_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    // A copy that dies before it is ready is reported by its exit code.
    child.stdin.on('error', () => {});
    const exited = new Promise((resolve) => child.on('close', resolve));
    const ready = new Promise((resolve) => {
      exited.then(resolve);
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('ready\n')) resolve();
      });
    });
    return { child, ready, exited, result: () => ({ out, err }) };
  });
  await Promise.all(copies.map((c) => c.ready));
  for (const c of copies) c.child.stdin.write('go\n');
  started();
  return Promise.all(
    copies.map(async (c) => {
      const code = await c.exited;
      const { out, err } = c.result();
      const last = out.trim().split('\n').pop();
      return { code, err, loaded: code === 0 ? JSON.parse(last) : null };
    }),
  );
}

/** What a copy should print for the files now in `dir`. */
function onDisk(dir) {
  const pem = readFileSync(join(dir, 'ledger.key'), 'utf8');
  const x = createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' }).x;
  const salt = readFileSync(join(dir, 'log.salt'), 'utf8').trim();
  return {
    key: Buffer.from(x, 'base64url').toString('base64'),
    caller: createHash('sha256').update(salt).update('probe').digest('hex').slice(0, 16),
  };
}

const bytes = (dir) => ({
  key: readFileSync(join(dir, 'ledger.key')),
  salt: readFileSync(join(dir, 'log.salt')),
});

let shared;

test('copies starting together on a fresh directory make one key and one salt, and all load them', async () => {
  shared = freshDir();
  const runs = await start(shared, 8);
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const expected = onDisk(shared);
  for (const r of runs) assert.deepEqual(r.loaded, expected);
  // The losing candidates are gone, and the winners are private.
  assert.deepEqual(readdirSync(shared).sort(), ['ledger.key', 'log.salt']);
  if (process.platform !== 'win32')
    for (const name of ['ledger.key', 'log.salt'])
      assert.equal(statSync(join(shared, name)).mode & 0o777, 0o600, name);
});

test('a restart loads the same key and salt and leaves the files as they were', async () => {
  const before = bytes(shared);
  const expected = onDisk(shared);
  const runs = await start(shared, 4);
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.loaded, expected);
  }
  assert.deepEqual(bytes(shared), before);
});

test('a key and salt a volume already holds are loaded as they are', async () => {
  const dir = freshDir();
  // As earlier versions wrote them, and a salt made by hand with a newline.
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(join(dir, 'ledger.key'), pem, { mode: 0o600 });
  writeFileSync(join(dir, 'log.salt'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  const before = bytes(dir);
  const runs = await start(dir, 4);
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.loaded, onDisk(dir));
  }
  assert.deepEqual(bytes(dir), before);
});

test('a key still being written in place is waited for, not replaced', async () => {
  const dir = freshDir();
  // Earlier versions created the file and then wrote it; one may be between the two.
  writeFileSync(join(dir, 'ledger.key'), '', { mode: 0o600 });
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const [run] = await start(dir, 1, () =>
    setTimeout(() => writeFileSync(join(dir, 'ledger.key'), pem), 200),
  );
  assert.equal(run.code, 0, run.err);
  assert.equal(readFileSync(join(dir, 'ledger.key'), 'utf8'), pem);
  assert.deepEqual(run.loaded, onDisk(dir));
});

test('a damaged key stops the server and is not replaced', async () => {
  const dir = freshDir();
  // What a write cut off halfway leaves.
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const damaged = pem.slice(0, pem.length / 2);
  writeFileSync(join(dir, 'ledger.key'), damaged, { mode: 0o600 });
  const [run] = await start(dir, 1);
  assert.notEqual(run.code, 0);
  assert.match(run.err, /ledger\.key/);
  assert.match(run.err, /not be replaced/);
  assert.equal(readFileSync(join(dir, 'ledger.key'), 'utf8'), damaged);
});

test('a damaged salt stops the server and is not replaced', async () => {
  const dir = freshDir();
  // What a write cut off before its first byte leaves.
  writeFileSync(join(dir, 'log.salt'), '', { mode: 0o600 });
  const [run] = await start(dir, 1);
  assert.notEqual(run.code, 0);
  assert.match(run.err, /log\.salt/);
  assert.match(run.err, /not be replaced/);
  assert.equal(readFileSync(join(dir, 'log.salt'), 'utf8'), '');
});
