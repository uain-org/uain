import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBainkServer } from '../server/app.mjs';
const options = dataDir => ({ dataDir, projectsSource: null, catalogueDir: null });
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-writer-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function worker(t, dir) {
  const child = fork(new URL('./fixtures/store-writer-process.mjs', import.meta.url), [dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } });
  const [ready] = await once(child, 'message');
  assert.equal(ready.kind, 'ready', stderr);
  return child;
}
function start(child) { const result = once(child, 'message'); child.send('start'); return result.then(([message]) => message); }
async function stop(child) { const result = once(child, 'message'); child.send('close'); assert.equal((await result)[0].kind, 'closed'); }

test('normal close retains the same lock inode, preventing acquisition on an obsolete inode', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  const first = await createBainkServer(options(dir));
  const inode = (await stat(join(dir, 'writer.lock'))).ino;
  await first.close();
  assert.equal((await stat(join(dir, 'writer.lock'))).ino, inode);
  const next = await createBainkServer(options(dir));
  assert.equal((await stat(join(dir, 'writer.lock'))).ino, inode);
  await next.close();
});

test('independent processes allow exactly one writer during simultaneous stale recovery', { timeout: 30000 }, async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'writer.lock'), JSON.stringify({ pid: 2147483647 }));
  const children = await Promise.all(Array.from({ length: 12 }, () => worker(t, dir)));
  const results = await Promise.all(children.map(start));
  const opened = results.flatMap((result, index) => result.kind === 'opened' ? [index] : []);
  assert.equal(opened.length, 1, JSON.stringify(results));
  for (const result of results.filter(result => result.kind === 'rejected')) assert.match(result.message, /active writer/);
  await stop(children[opened[0]]);
});

test('SIGKILL releases ownership and restart preserves existing committed state', { timeout: 15000 }, async t => {
  const dir = await directory(t);
  const owner = await worker(t, dir);
  assert.equal((await start(owner)).kind, 'opened');
  const registered = once(owner, 'message'); owner.send('register');
  const [account] = await registered;
  assert.equal(account.kind, 'registered');
  assert.equal(account.status, 201);
  assert.equal(account.body.account.displayName, 'Durable crash account');
  const state = readPersistedState(dir);
  assert.equal(state.accounts[account.body.account.address].displayName, 'Durable crash account');
  const contender = await worker(t, dir);
  assert.equal((await start(contender)).kind, 'rejected');
  const ended = once(owner, 'exit'); owner.kill('SIGKILL'); await ended;
  const restarted = await worker(t, dir);
  assert.equal((await start(restarted)).kind, 'opened');
  assert.deepEqual(readPersistedState(dir), state);
  await stop(restarted);
});

test('live legacy writer metadata blocks upgrade and invalid metadata fails closed', async t => {
  const dir = await directory(t);
  const path = join(dir, 'writer.lock');
  await writeFile(path, JSON.stringify({ pid: process.pid }));
  await assert.rejects(createBainkServer(options(dir)), /active writer/);
  await writeFile(path, '');
  await assert.rejects(createBainkServer(options(dir)), /inspect writer.lock/);
  assert.equal(await readFile(path, 'utf8'), '');
});


test('writer ownership refuses a symlink without changing its target', async t => {
  const dir = await directory(t);
  const target = join(dir, 'unrelated.json');
  const retained = JSON.stringify({ protocol: 'flock-v1', pid: 2147483647 });
  await writeFile(target, retained);
  await symlink(target, join(dir, 'writer.lock'));
  let app;
  try {
    await assert.rejects(async () => { app = await createBainkServer(options(dir)); }, /ELOOP/);
    assert.equal(await readFile(target, 'utf8'), retained);
  } finally { await app?.close(); }
});


test('writer ownership refuses a hardlink without changing its other name', async t => {
  const dir = await directory(t);
  const target = join(dir, 'unrelated.json');
  const retained = JSON.stringify({ protocol: 'flock-v1', pid: 2147483647 });
  await writeFile(target, retained);
  await link(target, join(dir, 'writer.lock'));
  let app;
  try {
    await assert.rejects(async () => { app = await createBainkServer(options(dir)); }, /unsafe writer.lock/);
    assert.equal(await readFile(target, 'utf8'), retained);
  } finally { await app?.close(); }
});


test('writer ownership refuses a FIFO rather than waiting for lock metadata forever', { timeout: 2000 }, async t => {
  const dir = await directory(t);
  execFileSync('mkfifo', [join(dir, 'writer.lock')]);
  const child = await worker(t, dir);
  const result = await start(child);
  assert.equal(result.kind, 'rejected');
  assert.match(result.message, /unsafe writer.lock/);
});
