import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Same deny profile and plain-command probes as the signed client's codexFence(). No model call. */
export function codexPreflight(memberHome, binary = process.env.UAIN_CODEX_BIN ?? 'codex') {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'uain-runner-probe-'));
  const canary = path.join(memberHome, `.runner-canary-${process.pid}`);
  const profile = [
    '-c', 'default_permissions="uain-unit"',
    '-c', 'permissions.uain-unit.extends=":workspace"',
    '-c', `permissions.uain-unit.filesystem={ ${JSON.stringify(memberHome)} = "deny" }`,
    '-c', 'permissions.uain-unit.network.enabled=true',
    '-c', 'approval_policy="never"', '-P', 'uain-unit', '-C', work,
  ];
  const run = (command) => spawnSync(binary, ['sandbox', ...profile, '--', ...command], { cwd: work, timeout: 20000, encoding: 'utf8' });
  try {
    fs.writeFileSync(canary, 'not a secret\n', { mode: 0o600 });
    const allowed = run(['true']);
    if (allowed.status !== 0) throw new Error(`Codex sandbox cannot run on this host/container: ${(allowed.stderr ?? '').slice(0, 1000)}`);
    if (run(['cat', canary]).status === 0) throw new Error('Codex sandbox did not fence member storage');
  } finally {
    fs.rmSync(canary, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
}
