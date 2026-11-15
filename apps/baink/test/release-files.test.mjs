// The release packager refuses local junk, naming the path (12 November 2026). On 11 November a
// first 0.3.91 package carried shared/__pycache__ and was discarded before promote. FIXTURE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReleaseFiles, junkReason, ReleaseTreeError } from '../deploy/release-files.mjs';

async function tree(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'baink-release-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    if (body === null) await mkdir(join(root, name), { recursive: true });
    else await writeFile(join(root, name), body);
  }
  return root;
}

test('a clean tree is collected in full and in order', async (t) => {
  const root = await tree(t, { 'a.mjs': 'a', 'sub/b.mjs': 'b', 'sub/signer.py': 'c', 'sub/deep/c.json': '{}' });
  const rows = await collectReleaseFiles(root, 'shared');
  assert.deepEqual(rows.map(([name]) => name).sort(), ['a.mjs', 'sub/b.mjs', 'sub/deep/c.json', 'sub/signer.py']);
  for (const [name, path] of rows) assert.equal(path, join(root, name));
});

for (const [kind, name, expect] of [
  ['a __pycache__ folder', 'sub/__pycache__/', 'a Python cache folder'],
  ['a .pyc file', 'sub/uain_signer.cpython-312.pyc', 'a compiled Python file'],
  ['a .pyo file', 'old.pyo', 'a compiled Python file'],
  ['a .DS_Store file', 'sub/deep/.DS_Store', 'a macOS folder-view file'],
  ['a ._ AppleDouble file', '._uain_signer.py', 'a macOS resource-fork file (AppleDouble)'],
]) {
  test(`the packager refuses ${kind} and names its path`, async (t) => {
    const folder = name.endsWith('/');
    const root = await tree(t, { 'sub/ok.mjs': 'ok', 'sub/deep/ok.json': '{}', [name.replace(/\/$/, '')]: folder ? null : 'junk' });
    if (folder) await writeFile(join(root, name, 'uain_signer.cpython-312.pyc'), 'junk');
    await assert.rejects(collectReleaseFiles(root, 'shared'), (e) => {
      assert.ok(e instanceof ReleaseTreeError);
      assert.equal(e.path, 'shared/' + name.replace(/\/$/, ''));
      assert.match(e.message, new RegExp(`^Release refused: ${e.path.replace(/[.]/g, '\\.')} is ${expect.replace(/[()]/g, '\\$&')}`));
      assert.match(e.message, /package again/);
      return true;
    });
  });
}

test('junk names are recognised exactly; ordinary names are not junk', () => {
  assert.equal(junkReason('__pycache__', true), 'a Python cache folder');
  assert.equal(junkReason('__pycache__', false), null, 'a file named so is not the cache folder (other checks still apply)');
  for (const name of ['uain_signer.py', 'pycache.mjs', 'x.pyc.md', 'DS_Store', 'a._b.mjs', 'review.mjs']) assert.equal(junkReason(name), null, name);
  assert.equal(junkReason('X.PYC'), 'a compiled Python file');
});

test('hidden and secret files and symlinks are still refused, now with the path', async (t) => {
  const hidden = await tree(t, { 'sub/.env': 'x' });
  await assert.rejects(collectReleaseFiles(hidden, 'server'), /^ReleaseTreeError: Release refused: server\/sub\/\.env is a hidden or secret artifact/);
  const secret = await tree(t, { 'tls.pem': 'x' });
  await assert.rejects(collectReleaseFiles(secret, 'server'), /server\/tls\.pem is a hidden or secret artifact/);
  const linked = await tree(t, { 'real.mjs': 'x' });
  await symlink(join(linked, 'real.mjs'), join(linked, 'link.mjs'));
  await assert.rejects(collectReleaseFiles(linked, 'server'), /server\/link\.mjs is a symlink/);
});

test('package-release.mjs collects every packaged tree through this walk', async () => {
  const source = await readFile(new URL('../deploy/package-release.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ collectReleaseFiles \} from '\.\/release-files\.mjs';/);
  assert.match(source, /const collect = \(folder\) => collectReleaseFiles\(/);
  assert.doesNotMatch(source, /readdir\(/, 'no second walk that could skip the check');
});
