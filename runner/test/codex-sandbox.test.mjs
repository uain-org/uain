import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const image = process.env.UAIN_RUNNER_IMAGE;
const seccomp = process.env.UAIN_CODEX_SECCOMP;
test('real Codex container fences storage and keeps outer privileges restricted', { skip: !image || !seccomp, timeout: 60000 }, () => {
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import {spawnSync} from 'node:child_process';
    import {codexPreflight} from '/opt/uain/preflight.mjs';
    assert.equal(process.getuid(),10001);
    const status=fs.readFileSync('/proc/self/status','utf8');
    assert.match(status,/CapEff:\\s+0000000000000000/);
    assert.match(status,/NoNewPrivs:\\s+1/);
    assert.match(status,/Seccomp:\\s+2/);
    assert.match(fs.readFileSync('/proc/self/attr/current','utf8'),/uain-codex-runner/);
    assert.throws(()=>fs.writeFileSync('/opt/uain/outer-write-probe','refused'));
    fs.mkdirSync('/tmp/outer-mount-probe');
    assert.notEqual(spawnSync('mount',['-t','tmpfs','tmpfs','/tmp/outer-mount-probe']).status,0);
    codexPreflight('/home/uain/.uain');
    console.log('CODEX_CONTAINER_FENCE_PASSED');
  `;
  const output = execFileSync('docker', ['run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', 'apparmor=uain-codex-runner', '--security-opt', `seccomp=${seccomp}`, '--memory', '4g', '--cpus', '2', '--pids-limit', '256', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g,mode=1777', '--tmpfs', '/home/uain/.uain:rw,nosuid,nodev,uid=10001,gid=10001,mode=0700', '--entrypoint', 'node', image, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 50000 });
  assert.match(output,/CODEX_CONTAINER_FENCE_PASSED/);
});
