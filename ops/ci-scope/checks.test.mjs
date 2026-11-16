import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addedLines, check } from './docs-check.mjs';
import { verifyBundle } from './verify-worker-bundle.mjs';
import { build } from '../docs/render-status.mjs';

const patch = (file, lines, start = 10) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -${start},0 +${start},${lines.length} @@`, ...lines.map((l) => '+' + l), ''].join('\n');

test('docs check reads only added lines with their line numbers', () => {
  const files = addedLines(patch('docs/a.md', ['one', 'two'], 4) + '-removed\n');
  assert.deepEqual(files.get('docs/a.md'), [
    { line: 4, text: 'one' },
    { line: 5, text: 'two' },
  ]);
});

test('docs check flags secrets without printing them', () => {
  const secret = 'xoxb-' + '1234567890-abcdefghij';
  const problems = check(patch('docs/a.md', [`token ${secret}`, '-----BEGIN PRIVATE KEY-----']), () => true);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => !p.includes(secret)));
});

test('docs check flags conflict markers and broken relative links only', () => {
  const exists = (p) => p === 'docs/overview.md' || p === 'remaining_work.md';
  const problems = check(
    patch('docs/federation/x.md', [
      '<<<<<<< HEAD',
      '[ok](../overview.md#how) [ok2](/remaining_work.md) [web](https://uain.global/x) [anchor](#here)',
      '[gone](missing.md)',
      '```',
      '[in code](nowhere.md)',
      '```',
    ]),
    exists,
  );
  assert.deepEqual(problems, ['docs/federation/x.md:10: merge-conflict marker', 'docs/federation/x.md:12: link target not found: missing.md']);
});

test('prose CLI validates release schema, pointers and generated output, including deletions', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-prose-')));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const release = '20261108T233941Z-852919b747';
  mkdirSync(join(root, 'docs/releases/baink'), {recursive:true});
  mkdirSync(join(root, 'ops/docs'), {recursive:true});
  cpSync(fileURLToPath(new URL('../docs/render-status.mjs', import.meta.url)), join(root, 'ops/docs/render-status.mjs'));
  cpSync(fileURLToPath(new URL('./docs-check.mjs', import.meta.url)), join(root, 'copied-docs-check.mjs'));
  writeFileSync(join(root, 'CHANGELOG.md'), '# Verified change\n');
  const record = {schema:1,component:'baink',release_id:release,status:'deployed',evidence:['CHANGELOG.md']};
  const recordPath = join(root, `docs/releases/baink/${release}.json`);
  const pointers = {schema:1,current:{baink:release}};
  const reset = () => {
    writeFileSync(join(root, 'CHANGELOG.md'), '# Verified change\n');
    writeFileSync(recordPath, JSON.stringify(record));
    writeFileSync(join(root, 'docs/releases/current.json'), JSON.stringify(pointers));
    writeFileSync(join(root, 'docs/releases/CURRENT.md'), build(root));
  };
  const run = changed => {
    writeFileSync(join(root, 'change.patch'), changed);
    return spawnSync(process.execPath, [join(root,'copied-docs-check.mjs'), '--repo', root, '--diff', join(root,'change.patch')], {encoding:'utf8'});
  };
  const changed = patch('docs/releases/current.json', [JSON.stringify(pointers)]);
  reset(); assert.equal(run(changed).status, 0);
  writeFileSync(join(root,'docs/releases/CURRENT.md'), 'stale\n');
  assert.equal(run(changed).status, 1, 'stale generated output must fail');
  reset(); writeFileSync(recordPath, '{broken');
  assert.equal(run(changed).status, 1, 'malformed record must fail');
  reset(); writeFileSync(join(root,'docs/releases/current.json'), JSON.stringify({schema:1,current:{baink:'20261101T000000Z-0000000000'}}));
  assert.equal(run(changed).status, 1, 'dangling pointer must fail');
  reset(); unlinkSync(join(root,'CHANGELOG.md'));
  assert.equal(run(changed).status, 1, 'missing evidence must fail');
  reset(); unlinkSync(recordPath);
  assert.equal(run(`--- a/docs/releases/baink/${release}.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-${JSON.stringify(record)}\n`).status, 1, 'deletion must still validate retained pointers');
  reset(); writeFileSync(recordPath, JSON.stringify({...record, status:'private-value-must-not-escape'}));
  const refused = run(changed); assert.equal(refused.status, 1);
  assert.ok(!(refused.stdout + refused.stderr).includes('private-value-must-not-escape'));
  // Actual Git intent-to-add diffs captured from empty and NUL-containing files:
  // neither has ---/+++ markers or added lines for the original prose parser.
  reset();
  const newRecord = 'docs/releases/baink/20261109T000000Z-0000000000.json';
  const header = `diff --git a/${newRecord} b/${newRecord}\nnew file mode 100644\n`;
  writeFileSync(join(root,newRecord), '');
  assert.equal(run(header + 'index 0000000..e69de29\n').status, 1, 'new empty records require validation');
  writeFileSync(join(root,newRecord), Buffer.from('{"schema":1}\0'));
  assert.equal(run(header + `index 0000000..778bc75\nBinary files /dev/null and b/${newRecord} differ\n`).status, 1, 'binary records require validation');
  // Ordinary prose does not acquire a new dependency on a renderer or releases.
  rmSync(join(root,'ops'), {recursive:true});
  assert.equal(run(patch('docs/overview.md',['ordinary prose'])).status, 0);
});

function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-bundle-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  writeFileSync(join(dir, 'uain-worker.mjs'), `const VERSION = '9.9.9';\nconst RELEASE_KEY = '${x}';\n`);
  writeFileSync(join(dir, 'follow.mjs'), 'export const follow = 1;\n');
  const files = Object.fromEntries(
    ['uain-worker.mjs', 'follow.mjs'].map((n) => [n, createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')]),
  );
  const manifest = Buffer.from(JSON.stringify({ version: '9.9.9', files }, null, 2) + '\n');
  writeFileSync(join(dir, 'manifest.json'), manifest);
  writeFileSync(join(dir, 'manifest.sig'), sign(null, manifest, privateKey).toString('base64url'));
  return dir;
}

test('a correctly signed worker bundle verifies', () => {
  assert.deepEqual(verifyBundle(bundle()), { version: '9.9.9', files: 2 });
});

test('a worker file changed without signing again fails the build', () => {
  const dir = bundle();
  writeFileSync(join(dir, 'follow.mjs'), 'export const follow = 2;\n');
  assert.throws(() => verifyBundle(dir), /follow\.mjs: served bytes differ/);
});

test('a manifest edited without a new signature fails the build', () => {
  const dir = bundle();
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.files['follow.mjs'] = '0'.repeat(64);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => verifyBundle(dir), /does not sign/);
});

test('a bundle signed by another key fails the build', () => {
  const dir = bundle();
  const other = bundle();
  cpSync(join(other, 'manifest.sig'), join(dir, 'manifest.sig'));
  assert.throws(() => verifyBundle(dir), /does not sign/);
});
