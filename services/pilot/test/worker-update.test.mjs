/**
 * The UAIN Client installs only releases signed with UAIN's release key.
 *
 * A copy is installed in a temporary folder and its own update check,
 * `uain-client update`, is run against a local stand-in for uain.global. A
 * signed release is taken. A tampered file, a manifest signed with another
 * key or changed after signing, a broken signature, a missing manifest, an
 * older release and a file that does not parse are each refused, and the
 * files on disk stay as they were. install.sh is held to the same rule.
 *
 * The stand-in signs with a key of its own, which replaces UAIN's in the
 * copies it serves, as the pinned key would be in a real release. Needs no
 * database. The client files are the frozen final release in public/worker/
 * (0.15.0), so this checks what members' clients actually receive.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { newKey } from '../../../public/worker/uain-key.mjs';
/** Each file of the frozen final release, by the name it is served under. */
const WORKER = path.join(path.dirname(new URL(import.meta.url).pathname), '../../../public/worker');
const SOURCES = Object.fromEntries(
  Object.keys(JSON.parse(fs.readFileSync(path.join(WORKER, 'manifest.json'), 'utf8')).files).map((name) => [name, path.join(WORKER, name)]),
);
const clientVersion = () =>
  fs.readFileSync(SOURCES['uain-worker.mjs'], 'utf8').match(/const VERSION = '([^']+)'/)?.[1] ?? null;
const pinnedKey = (file) =>
  fs.readFileSync(file, 'utf8').match(/RELEASE_KEY\s*=\s*['"]([A-Za-z0-9_-]{43})['"]/)?.[1] ?? null;

const exec = promisify(execFile);
const VERSION = clientVersion();
const UAIN_KEY = pinnedKey(SOURCES['uain-worker.mjs']);
const releaseKey = newKey();
const strangerKey = newKey();

const source = (name) => fs.readFileSync(SOURCES[name], 'utf8');
const pinned = (text) => text.replaceAll(UAIN_KEY, releaseKey.public_key);
/** The client at version `v`, pinning the stand-in's release key. */
const client = (v = VERSION) =>
  pinned(source('uain-worker.mjs')).replace(
    `const VERSION = '${VERSION}';`,
    `const VERSION = '${v}';`,
  );
const sha = (text) => createHash('sha256').update(text).digest('hex');
const signWith = (key, bytes) =>
  sign(
    null,
    bytes,
    createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.public_key, d: key.private_key },
      format: 'jwk',
    }),
  ).toString('base64url');

/** A release: every signed file, including the private client dependencies. */
const releaseOf = (worker) => ({
  'uain-worker.mjs': worker,
  'follow.mjs': source('follow.mjs'),
  'uain-key.mjs': source('uain-key.mjs'),
  'install.sh': pinned(source('install.sh')),
  ...Object.fromEntries(Object.keys(SOURCES).filter(name=>!['uain-worker.mjs','follow.mjs','uain-key.mjs','install.sh'].includes(name)).map(name=>[name,source(name)])),
});

/** What the stand-in serves under /worker/. */
let served = {};
let nativeDescriptor = false;
let unexpectedNativeRequests = [];
/** Serve `files` with a manifest for `version`, signed with `key`. */
function publish(files, { version, key = releaseKey } = {}) {
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        version,
        files: Object.fromEntries(Object.entries(files).map(([f, t]) => [f, sha(t)])),
        signed_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  served = {
    ...files,
    'manifest.json': manifest,
    'manifest.sig': `${signWith(key, manifest)}\n`,
  };
}

const site = createServer((req, res) => {
  if (nativeDescriptor && req.url === '/api/descriptor') {
    return res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({authority:'native'}));
  }
  if (nativeDescriptor && !req.url.startsWith('/worker/')) unexpectedNativeRequests.push(req.url);
  const f = req.url.replace(/^\/worker\//, '');
  if (!(f in served)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/plain' }).end(served[f]);
});
let SITE;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uain-signed-update-'));
const DEST = path.join(tmp, '.uain/worker');
const env = { ...process.env, HOME: tmp, UAIN_HOME: path.join(tmp, '.uain') };
delete env.UAIN_NO_UPDATE;
delete env.UAIN_KEY_FILE;

const onDisk = (f) => fs.readFileSync(path.join(DEST, f), 'utf8');
const staged = () => fs.readdirSync(DEST).filter((f) => f.includes('.new'));

/** Runs the installed copy's own update check; resolves to its exit code and output. */
async function update() {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [path.join(DEST, 'uain-worker.mjs'), 'update'],
      { env },
    );
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code, out: `${e.stdout}${e.stderr}` };
  }
}

before(async () => {
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  SITE = `http://127.0.0.1:${site.address().port}`;
  fs.mkdirSync(DEST, { recursive: true });
  for (const [f, text] of Object.entries(releaseOf(client())))
    if (f !== 'install.sh') fs.writeFileSync(path.join(DEST, f), text);
  fs.writeFileSync(path.join(DEST, 'install.json'), JSON.stringify({ base: SITE }));
});

after(() => {
  site.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a copy that matches the signed release is up to date', async () => {
  publish(releaseOf(client()), { version: VERSION });
  const u = await update();
  assert.equal(u.code, 0, u.out);
  assert.match(u.out, /No update: up to date\./);
});

test('a newer signed release is installed', async () => {
  publish(releaseOf(client('9.0.1')), { version: '9.0.1' });
  const u = await update();
  assert.equal(u.code, 0, u.out);
  assert.match(u.out, new RegExp(`Updated ${VERSION.replaceAll('.', '\\.')} → 9\\.0\\.1\\.`));
  assert.equal(onDisk('uain-worker.mjs'), client('9.0.1'));
  assert.match((await update()).out, /No update: up to date\./);
});

/** Each refusal leaves the copy exactly as it was, with nothing staged. */
async function refused(pattern) {
  const u = await update();
  assert.equal(u.code, 1, u.out);
  assert.match(u.out, pattern);
  assert.equal(onDisk('uain-worker.mjs'), client('9.0.1'), 'the working copy is untouched');
  assert.equal(onDisk('uain-key.mjs'), source('uain-key.mjs'));
  assert.deepEqual(staged(), [], 'nothing left staged');
}

test('a file that does not match the signed manifest is refused', async () => {
  publish(releaseOf(client('9.0.2')), { version: '9.0.2' });
  served['uain-worker.mjs'] = `${client('9.0.2')}\n// and something extra\n`;
  await refused(
    /Update refused: uain-worker\.mjs does not match the signed manifest\. Kept 9\.0\.1; nothing was replaced\./,
  );
  // A release changing two files, one of them tampered with: the worker,
  // which matches, is not installed either. All or nothing.
  publish(
    { ...releaseOf(client('9.0.2')), 'uain-key.mjs': `${source('uain-key.mjs')}// v2\n` },
    { version: '9.0.2' },
  );
  served['uain-key.mjs'] = `${source('uain-key.mjs')}// not v2\n`;
  await refused(/Update refused: uain-key\.mjs does not match the signed manifest\./);
});

test('a manifest signed with another key is refused', async () => {
  publish(releaseOf(client('9.0.2')), { version: '9.0.2', key: strangerKey });
  await refused(
    /Update refused: the signature does not match UAIN's release key\. Kept 9\.0\.1; nothing was replaced\./,
  );
});

test('the retired client takes no more work: going online, setup and add explain the kit instead', async () => {
  const r = (args, extraEnv = {}) => exec(process.execPath, [path.join(DEST, 'uain-worker.mjs'), ...args], { env: { ...env, ...extraEnv } }).then(({ stdout, stderr }) => stdout + stderr, (e) => `${e.stdout}${e.stderr}`);
  for (const args of [['--no-caffeinate'], ['run'], ['setup', '--yes'], ['add', '--yes'], ['native', 'state'], ['private', 'pay']]) {
    const out = await r(args);
    assert.match(out, /The UAIN Client is retired/, args.join(' '));
    assert.match(out, /uain-client move-to-kit/);
    assert.match(out, /baink\.money\/uain-agent\.mjs/);
  }
});

test('move-to-kit copies the member key into the kit, owner-only, and never overwrites another identity', async () => {
  const r = (args, extraEnv = {}) => exec(process.execPath, [path.join(DEST, 'uain-worker.mjs'), ...args], { env: { ...env, ...extraEnv } }).then(({ stdout, stderr }) => stdout + stderr, (e) => `${e.stdout}${e.stderr}`);
  const keyFile = path.join(tmp, '.uain/key.json'), kitHome = path.join(tmp, 'kit-home');
  const k = newKey();
  fs.writeFileSync(keyFile, JSON.stringify({ address: k.address, public_key: k.public_key, private_key: k.private_key }), { mode: 0o600 });
  const out = await r(['move-to-kit'], { UAIN_AGENT_HOME: kitHome });
  assert.match(out, new RegExp('Moved: the kit now signs as ' + k.address));
  const file = path.join(kitHome, 'default', 'identity.json'), id = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([id.format, id.algorithm, id.address, id.public_key, id.private_key], ['baink-identity-v2', 'Ed25519', k.address, k.public_key, k.private_key]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(out, new RegExp(k.private_key), 'the private key is never printed');
  assert.match(await r(['move-to-kit'], { UAIN_AGENT_HOME: kitHome }), /Already moved/);
  fs.writeFileSync(file, JSON.stringify({ ...id, address: 'uain1' + 'f'.repeat(40) }));
  assert.match(await r(['move-to-kit'], { UAIN_AGENT_HOME: kitHome }), /different identity/);
  fs.rmSync(keyFile); fs.rmSync(kitHome, { recursive: true, force: true });
});
test('a manifest changed after it was signed is refused', async () => {
  publish(releaseOf(client('9.0.2')), { version: '9.0.2' });
  const evil = `${client('9.0.2')}\n// not what was signed\n`;
  served['manifest.json'] = Buffer.from(
    served['manifest.json']
      .toString()
      .replace(sha(client('9.0.2')), sha(evil)),
  );
  served['uain-worker.mjs'] = evil;
  await refused(/Update refused: the signature does not match UAIN's release key\./);
});

test('a broken or missing signature is refused', async () => {
  publish(releaseOf(client('9.0.2')), { version: '9.0.2' });
  served['manifest.sig'] = 'not a signature';
  await refused(/Update refused: the signature does not match UAIN's release key\./);
  served['manifest.sig'] = '';
  await refused(/Update refused: the signature does not match UAIN's release key\./);
  delete served['manifest.sig'];
  await refused(/Could not check for an update: manifest\.sig: HTTP 404\./);
});

test('a release without a manifest is not installed', async () => {
  publish(releaseOf(client('9.0.2')), { version: '9.0.2' });
  delete served['manifest.json'];
  await refused(/Could not check for an update: manifest\.json: HTTP 404\./);
});

test('an older signed release is refused, so a fix cannot be rolled back', async () => {
  publish(releaseOf(client('0.1.0')), { version: '0.1.0' });
  await refused(
    /Update refused: the published release, 0\.1\.0, is older than this one\. Kept 9\.0\.1; nothing was replaced\./,
  );
});

test('a signed release that does not parse is refused', async () => {
  publish(releaseOf('this is not javascript {'), { version: '9.0.3' });
  await refused(/Update refused: the published uain-worker\.mjs does not parse\./);
});

test('a missing key module is fetched only as the signed manifest lists it', async () => {
  fs.rmSync(path.join(DEST, 'uain-key.mjs'));
  publish(releaseOf(client('9.0.1')), { version: '9.0.1' });
  served['uain-key.mjs'] = `${source('uain-key.mjs')}\n// and something extra\n`;
  const u = await update();
  assert.notEqual(u.code, 0, u.out);
  assert.match(
    u.out,
    /Could not fetch uain-key\.mjs: refused, uain-key\.mjs does not match the signed manifest\./,
  );
  assert.ok(!fs.existsSync(path.join(DEST, 'uain-key.mjs')), 'nothing written');
  assert.deepEqual(
    fs.readdirSync(DEST).filter((f) => f.startsWith('uain-key.')),
    [],
  );

  publish(releaseOf(client('9.0.1')), { version: '9.0.1', key: strangerKey });
  const v = await update();
  assert.notEqual(v.code, 0, v.out);
  assert.match(v.out, /Could not fetch uain-key\.mjs: refused, the signature does not match/);
  assert.ok(!fs.existsSync(path.join(DEST, 'uain-key.mjs')), 'nothing written');

  publish(releaseOf(client('9.0.1')), { version: '9.0.1' });
  const w = await update();
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /No update: up to date\./);
  assert.equal(onDisk('uain-key.mjs'), source('uain-key.mjs'));
});

test('install.sh installs nothing and points to the kit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uain-install-retired-'));
  const r = await exec('sh', [SOURCES['install.sh']], { env: { ...process.env, HOME: home, UAIN_BASE: SITE } }).then(() => ({ code: 0, out: '' }), (e) => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));
  assert.equal(r.code, 1);
  assert.match(r.out, /The UAIN Client is retired\. Nothing was installed\./);
  assert.match(r.out, /baink\.money\/uain-agent\.mjs/);
  assert.equal(fs.existsSync(path.join(home, '.uain')), false, 'nothing was written');
  fs.rmSync(home, { recursive: true, force: true });
});


