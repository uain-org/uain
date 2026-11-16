import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { signedFixture } from './fixture.mjs';

const image = process.env.UAIN_RUNNER_IMAGE;
test('real container enrols, contributes once, preserves slots and stops cleanly', { skip: !image, timeout: 180000 }, async () => {
  // This existing harness creates and drops a fresh test-only PostgreSQL database.
  const { boot } = await import('../../services/pilot/test/helpers.mjs');
  const pilot = await boot();
  const bundle = await signedFixture();
  let tampered = false;
  const gateway = createServer((req, res) => {
    if (req.url.startsWith('/worker/')) {
      const name = req.url.slice('/worker/'.length);
      if (!bundle[name]) { res.writeHead(404).end(); return; }
      res.end(tampered && name === 'follow.mjs' ? 'tampered' : bundle[name]);
      return;
    }
    const upstream = request(`${pilot.base}${req.url}`, { method: req.method, headers: req.headers }, reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${gateway.address().port}`;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'uain-container-test-'));
  await fs.chmod(temporary, 0o755);
  const data = path.join(temporary, 'member');
  await fs.mkdir(data, { mode: 0o700 });
  await fs.chown(data, 10001, 10001);
  const stubDir = path.join(data, 'stub');
  await fs.mkdir(stubDir, { mode: 0o700 });
  await fs.chown(stubDir, 10001, 10001);
  const containers = [];
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
  const logs = name => {
    const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 30000 });
    return `${result.stdout}${result.stderr}`;
  };
  const wait = async (fn, label, ms = 60000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`Timed out: ${label}`);
  };
  function start(extra = {}, security = []) {
    const name = `uain-runner-test-${process.pid}-${containers.length}`;
    containers.push(name);
    const env = { UAIN_API: api, UAIN_AGENT: 'claude', UAIN_AGENT_NAME: 'Container fixture', UAIN_OPERATOR: 'Local container test only', UAIN_ACCEPT_PRINCIPLES: 'true', UAIN_REVIEW_ONLY: 'false', UAIN_TASKS: '1', UAIN_ALLOW_TEST_HTTP: '1', UAIN_START_JITTER_MS: '0', UAIN_DEBOUNCE_MS: '100', UAIN_RETRY_MS: '100', UAIN_CLAUDE_BIN: '/test/pilot/scripts/stubs/claude', STUB_DIR: '/home/uain/.uain/stub', ...extra };
    docker('run', '-d', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...security, '--memory', '4g', '--cpus', '2', '--pids-limit', '256', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g,mode=1777', '--tmpfs', '/home/uain/.uain-running:rw,nosuid,nodev,size=1m,uid=10001,gid=10001,mode=0700', '-v', `${data}:/home/uain/.uain`, '-v', `${path.resolve('services/pilot')}:/test/pilot:ro`, ...Object.entries(env).flatMap(([k,v])=>['-e', `${k}=${v}`]), image);
    return name;
  }
  const config = async (slot) => {
    try { return JSON.parse(await fs.readFile(path.join(data, `slots/runner-${slot}/worker.json`))); }
    catch { return null; }
  };
  const stopped = name => JSON.parse(docker('inspect', name))[0].State.Running === false;
  try {
    const first = start({ UAIN_SLOT: '1' });
    const original = await wait(() => config(1), 'container enrolment');
    const inspect = JSON.parse(docker('inspect', first))[0];
    assert.equal(inspect.Config.User, '10001:10001');
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspect.HostConfig.CapDrop.includes('ALL'));
    assert.deepEqual(inspect.NetworkSettings.Ports, {});
    await pilot.makeUain(original.participant.id);
    const lead = await pilot.member('Container fixture owner');
    const p = await lead.call('uain_propose', { title: 'Local runner fixture', summary: 'Only exercise the container against test data.', stop_conditions: ['Never contact production.'] });
    assert.ok(p.project?.id, JSON.stringify(p));
    const task = await lead.call('uain_task_open', { project_id: p.project.id, title: 'Local fixture', question: 'Report the local stub output.', done_when: 'One deterministic fixture contribution.', how_to_check: 'Inspect the local test ledger.', karma_offered: 10 });
    assert.ok(task.task?.id, JSON.stringify(task));
    await wait(() => stopped(first), 'one-unit container exit');
    assert.equal(JSON.parse(docker('inspect', first))[0].State.ExitCode, 0, logs(first));
    const contributions = await (await pilot.http(`/api/contributions?project_id=${p.project.id}`)).json();
    assert.equal(contributions.contributions?.length, 1, JSON.stringify(contributions));
    const events = await (await pilot.http('/api/events?limit=500')).json();
    assert.ok(events.events.some(e => e.kind === 'contribution'), 'a real fixture contribution appears on the local ledger');
    const restart = start({ UAIN_SLOT: '1', UAIN_REVIEW_ONLY: 'true', UAIN_TASKS: '' });
    await wait(async () => logs(restart).includes('Online at'), 'restart online');
    assert.equal((await config(1)).participant.id, original.participant.id);
    const duplicate = start({ UAIN_SLOT: '1', UAIN_REVIEW_ONLY: 'true', UAIN_TASKS: '' });
    await wait(() => stopped(duplicate), 'duplicate slot refusal');
    assert.notEqual(JSON.parse(docker('inspect', duplicate))[0].State.ExitCode, 0);
    const second = start({ UAIN_REVIEW_ONLY: 'true', UAIN_TASKS: '' });
    const next = await wait(() => config(2), 'second replica enrolment');
    assert.notEqual(next.participant.id, original.participant.id);
    assert.equal(next.participant.address, original.participant.address, 'replicas keep one member');
    const begin = Date.now();
    docker('stop', '-t', '9', restart, second);
    assert.ok(Date.now() - begin < 10000, 'SIGTERM finishes within ten seconds');
    tampered = true;
    const bad = start({ UAIN_SLOT: '3' });
    await wait(() => stopped(bad), 'tampered release refusal');
    assert.match(logs(bad), /Client hash refused/);
    assert.equal(await config(3), null, 'refuses before enrolment');
    if (process.env.UAIN_EXPECT_CODEX_BLOCKED === '1') {
      tampered = false;
      const blocked = start({ UAIN_SLOT: '4', UAIN_AGENT: 'codex' });
      await wait(() => stopped(blocked), 'real Codex sandbox refusal');
      assert.notEqual(JSON.parse(docker('inspect', blocked))[0].State.ExitCode, 0);
      assert.match(logs(blocked), /Codex sandbox cannot run/);
      assert.equal(await config(4), null, 'blocked Codex never enrols');
    }
    if (process.env.UAIN_CODEX_SECCOMP) {
      // The real signed client's fence includes its nested slot and MCP
      // configuration. A parent-only probe missed the 0.14.3 nested-mount
      // failure; assert the actual startup declares storage out of reach.
      tampered = false;
      const slot = path.join(data, 'slots/runner-5');
      await fs.mkdir(slot, { mode: 0o700 });
      await fs.chown(slot, 10001, 10001);
      await fs.writeFile(path.join(slot, 'worker.json'), JSON.stringify({ ...original, agent: 'codex' }), { mode: 0o600 });
      await fs.chown(path.join(slot, 'worker.json'), 10001, 10001);
      const fenced = start({ UAIN_SLOT: '5', UAIN_AGENT: 'codex', UAIN_REVIEW_ONLY: 'true', UAIN_TASKS: '' }, ['--security-opt', 'apparmor=uain-codex-runner', '--security-opt', `seccomp=${process.env.UAIN_CODEX_SECCOMP}`]);
      await wait(() => logs(fenced).includes('Online at'), 'real signed Codex slot startup');
      assert.match(logs(fenced), /\/home\/uain\/\.uain out of reach/);
      assert.doesNotMatch(logs(fenced), /but able to read/);
      docker('stop', '-t', '9', fenced);
      // Simulate a provider CLI that passes the wrapper's plain probe but
      // cannot establish the signed client's MCP-configured fence. The
      // signed client must stop before going online or starting a model.
      const refusing = path.join(data, 'fence-refuses-mcp');
      await fs.writeFile(refusing, `#!/usr/bin/env node\nconst a=process.argv.slice(2); process.exit(a.includes('true') && !a.some(x=>x.startsWith('mcp_servers.uain.url=')) ? 0 : 1);\n`, { mode: 0o755 });
      await fs.chown(refusing, 10001, 10001);
      const blockedSlot = path.join(data, 'slots/runner-6');
      await fs.mkdir(blockedSlot, { mode: 0o700 });
      await fs.chown(blockedSlot, 10001, 10001);
      await fs.writeFile(path.join(blockedSlot, 'worker.json'), JSON.stringify({ ...original, agent: 'codex' }), { mode: 0o600 });
      await fs.chown(path.join(blockedSlot, 'worker.json'), 10001, 10001);
      const mismatch = start({ UAIN_SLOT: '6', UAIN_AGENT: 'codex', UAIN_CODEX_BIN: '/home/uain/.uain/fence-refuses-mcp', UAIN_REVIEW_ONLY: 'true', UAIN_TASKS: '' }, ['--security-opt', 'apparmor=uain-codex-runner', '--security-opt', `seccomp=${process.env.UAIN_CODEX_SECCOMP}`]);
      await wait(() => stopped(mismatch), 'mandatory signed-client fence refusal');
      assert.match(logs(mismatch), /member-storage fence is required/);
      assert.doesNotMatch(logs(mismatch), /Online at/);
    }
  } finally {
    for (const name of containers) { try { docker('rm', '-f', '-v', name); } catch {} }
    gateway.closeAllConnections();
    await new Promise(r => gateway.close(r));
    await pilot.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
