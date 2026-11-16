// Static and stand-in checks on the workflows and remote test scripts that run
// on the production app host (security review, 13 November 2026: IN-1 to IN-4).
// A secret on a command line can be read from /proc/*/cmdline by every local
// process; branch code run as root on the host must not reach the custody,
// k3s or runner credentials.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflows = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));

test('no workflow puts a secret on a command line', () => {
  assert.ok(workflows.includes('deploy.yml') && workflows.includes('ledger-root.yml'));
  for (const file of workflows) {
    const text = read(`.github/workflows/${file}`);
    assert.doesNotMatch(text, /--from-literal/, `${file}: --from-literal puts the value in kubectl's argv`);
    assert.doesNotMatch(text, /x-access-token:\$\{?/, `${file}: a token in a git URL is in git's argv and the clone's config`);
  }
});

/** The `run: |` body of the named step, dedented as the runner writes it. */
function stepScript(file, name) {
  const lines = read(`.github/workflows/${file}`).split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `${file}: step "${name}" found`);
  while (!/^\s+run: \|\s*$/.test(lines[i])) i += 1;
  const indent = lines[i].search(/\S/) + 2;
  const body = [];
  for (i += 1; i < lines.length; i += 1) {
    if (lines[i].trim() && lines[i].search(/\S/) < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n') + '\n';
}

const ENV_KEYS = ['UAIN_PG_PASSWORD', 'UAIN_WAITLIST_DB_PASSWORD', 'UAIN_WAITLIST_ADMIN_PASSWORD_HASH',
  'UAIN_WAITLIST_SESSION_SECRET', 'UAIN_SLACK_WAITLIST_WEBHOOK', 'UAIN_STORAGE_ACCESS_KEY_ID',
  'UAIN_STORAGE_SECRET_ACCESS_KEY', 'UAIN_SYNAPSE_SHARED_SECRET', 'UAIN_ETHEREUM_RPC_URL', 'UAIN_SOLANA_RPC_URL'];

// A stand-in kubectl: records its argv, and for `create secret` the mode and
// exact bytes of every --from-file source; `apply -f -` records its stdin.
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = process.env.STUB_LOG;
const files = {};
for (const a of args) {
  const m = /^--from-file=([^=]+)=(.*)$/.exec(a);
  if (m) files[m[1]] = { mode: (fs.statSync(m[2]).mode & 0o777).toString(8), b64: fs.readFileSync(m[2]).toString('base64'), path: m[2] };
}
fs.appendFileSync(out, JSON.stringify({ args, files }) + '\\n');
if (args.includes('apply')) fs.appendFileSync(out, JSON.stringify({ stdin: fs.readFileSync(0, 'utf8') }) + '\\n');
else if (args.includes('create') && args.includes('secret')) process.stdout.write('kind: Secret\\n');
process.exit(Number(process.env.STUB_FAIL_CREATE && args.includes('secret') ? 1 : 0));
`;

function runSecretStep(values, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'uain-env-step-'));
  const bin = join(dir, 'bin'), temp = join(dir, 'runner-temp'), log = join(dir, 'kubectl.log');
  for (const d of [bin, temp]) spawnSync('mkdir', ['-p', d]);
  writeFileSync(join(bin, 'kubectl'), STUB); chmodSync(join(bin, 'kubectl'), 0o755);
  writeFileSync(log, '');
  const script = join(dir, 'step.sh');
  writeFileSync(script, stepScript('deploy.yml', 'Write the uain-env secret'));
  // The runner's own shell for `run:` steps.
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, STUB_LOG: log, ...values, ...extraEnv },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const left = readdirSync(temp);
  rmSync(dir, { recursive: true, force: true });
  return { res, calls, left };
}

test('the uain-env step hands kubectl every value byte-exact through private files', () => {
  const values = Object.fromEntries(ENV_KEYS.map((k, i) => [k, `v${i}=a$b \${HOME} "q" 'r' \`x\` \\n end `]));
  values.UAIN_SLACK_WAITLIST_WEBHOOK = '';
  values.UAIN_SOLANA_RPC_URL = 'https://rpc.example/?k=abc==&x=$PATH';
  const { res, calls, left } = runSecretStep(values);
  assert.equal(res.status, 0, res.stderr);
  const create = calls.find((c) => c.args?.includes('generic'));
  assert.deepEqual(create.args.slice(0, 5), ['-n', 'uain', 'create', 'secret', 'generic']);
  assert.equal(create.args[5], 'uain-env');
  assert.deepEqual(create.args.slice(-3), ['--dry-run=client', '-o', 'yaml']);
  // Same keys in the same order; nothing else on the command line.
  assert.deepEqual(Object.keys(create.files), ENV_KEYS);
  assert.equal(create.args.length, 6 + ENV_KEYS.length + 3);
  for (const key of ENV_KEYS) {
    assert.equal(Buffer.from(create.files[key].b64, 'base64').toString('utf8'), values[key], key);
    assert.equal(create.files[key].mode, '600', key);
  }
  for (const call of calls) {
    for (const arg of call.args ?? []) {
      for (const v of Object.values(values)) if (v) assert.ok(!arg.includes(v), 'no value in argv');
    }
  }
  assert.ok(calls.some((c) => c.stdin === 'kind: Secret\n'), 'create piped into apply');
  assert.deepEqual(left, [], 'the value files are removed');
});

test('the uain-env step still refuses an empty database password and cleans up after a failure', () => {
  const values = Object.fromEntries(ENV_KEYS.map((k) => [k, 'x']));
  const empty = runSecretStep({ ...values, UAIN_PG_PASSWORD: '' });
  assert.equal(empty.res.status, 1);
  assert.match(empty.res.stdout, /::error::UAIN_PG_PASSWORD is not set/);
  assert.deepEqual(empty.calls, []);
  const failed = runSecretStep(values, { STUB_FAIL_CREATE: '1' });
  assert.notEqual(failed.res.status, 0);
  assert.deepEqual(failed.left, [], 'the value files are removed on failure too');
});

test('ledger-root passes the write token to git only through the environment', () => {
  const script = stepScript('ledger-root.yml', 'Commit to the ledger-roots branch');
  const uses = script.split('\n').filter((l) => /\$\{?TOKEN\b/.test(l));
  assert.equal(uses.length, 1, uses.join('\n'));
  // printf is a shell builtin: the token reaches base64 on stdin, not argv.
  assert.match(uses[0], /GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$\(printf 'x-access-token:%s' "\$TOKEN" \| base64 \| tr -d '\\n'\)"/);
  assert.match(script, /export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader GIT_CONFIG_VALUE_0\n/);
  assert.match(script, /URL="https:\/\/github\.com\/\$\{REPO\}\.git"/);
  assert.doesNotMatch(script, /extraheader.*git (-C \S+ )?config|git (-C \S+ )?config .*extraheader|-c http\./);
});

// IN-1: branch code run by systemd-run as root on the app host.
const SANDBOXED = ['native-chain.sh', 'private-exchange.sh', 'server-send.sh', 'devnet-e2e.sh'];
const MASKED = ['/etc/uain-custody', '/var/lib/uain-custody', '/opt/uain-custody', '/etc/uain-failover',
  '/etc/rancher', '/var/lib/rancher', '/var/lib/kubelet', '/run/k3s', '/run/containerd', '/root/.ssh',
  '/root/.kube', '/home/runner', '/opt/actions-runner', '/run/docker.sock'];
const DROPPED = ['CAP_SYS_ADMIN', 'CAP_SYS_PTRACE', 'CAP_SYS_MODULE', 'CAP_SYS_RAWIO', 'CAP_SYS_BOOT',
  'CAP_NET_ADMIN', 'CAP_NET_RAW', 'CAP_MKNOD'];

/** Each systemd-run command with its continuation lines joined. */
function systemdRuns(text) {
  return text.replace(/\\\n\s*/g, ' ').split('\n').filter((l) => /^\s*systemd-run\b/.test(l));
}

test('every remote-test systemd-run unit is sandboxed away from host credentials', () => {
  const scripts = readdirSync(join(root, 'ops/remote-test')).filter((f) => f.endsWith('.sh'));
  const withUnits = scripts.filter((f) => systemdRuns(read(`ops/remote-test/${f}`)).length);
  assert.deepEqual(withUnits.sort(), [...SANDBOXED].sort());
  for (const file of SANDBOXED) {
    const text = read(`ops/remote-test/${file}`);
    const [cmd, ...more] = systemdRuns(text);
    assert.equal(more.length, 0, file);
    assert.match(cmd, / --property=NoNewPrivileges=yes /, file);
    const paths = / --property='InaccessiblePaths=([^']+)' /.exec(cmd);
    assert.ok(paths, `${file}: InaccessiblePaths`);
    const entries = paths[1].split(' ');
    for (const e of entries) assert.match(e, /^-\/[\w./-]+$/, `${file}: ${e} is absolute with the ignore-missing prefix`);
    assert.deepEqual(entries.map((e) => e.slice(1)), MASKED, file);
    const caps = / --property='CapabilityBoundingSet=~([^']+)' /.exec(cmd);
    assert.ok(caps, `${file}: CapabilityBoundingSet`);
    assert.deepEqual(caps[1].split(' '), DROPPED, file);
    // Nothing the suite itself uses is masked.
    const body = text.replace(paths[0], ' ');
    for (const p of MASKED) assert.ok(!body.includes(p), `${file} uses ${p}, which the unit masks`);
  }
});

// IN-2: branch code in docker containers on the host network.
test('remote-test containers that run branch code drop raw sockets and privilege gain', () => {
  for (const file of ['run.sh', 'rehearse.sh']) {
    const runs = read(`ops/remote-test/${file}`).replace(/\\\n\s*/g, ' ').split('\n')
      .filter((l) => /docker run --rm\b/.test(l));
    assert.equal(runs.length, 1, file);
    for (const flag of ['--security-opt no-new-privileges', '--pids-limit 2048', '--cap-drop NET_RAW',
      '--cap-drop NET_ADMIN', '--cap-drop MKNOD', '--cap-drop AUDIT_WRITE', '--cap-drop SETPCAP']) {
      assert.ok(runs[0].includes(` ${flag} `), `${file}: ${flag}`);
    }
    // apk runs package scripts and triggers (busybox's, on /usr/bin) after chroot(".").
    assert.doesNotMatch(runs[0], /--cap-drop (SYS_CHROOT|ALL|CHOWN|DAC_OVERRIDE|FOWNER|FSETID|SETUID|SETGID)\b/, file);
    assert.doesNotMatch(runs[0], /--privileged|--cap-add|docker\.sock/, file);
  }
  assert.match(read('ops/remote-test/run.sh'), /--exclude '\.env\*'/, 'run.sh never copies .env files');
});

test('the remote-test scripts parse', () => {
  for (const file of readdirSync(join(root, 'ops/remote-test')).filter((f) => f.endsWith('.sh'))) {
    const res = spawnSync('bash', ['-n', join(root, 'ops/remote-test', file)], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${file}: ${res.stderr}`);
  }
});

// D-8 (open-source audit, 13 November 2026): every workflow runs on the
// self-hosted runners on the production app host.

/** Each job's name, its job-level `if:` (or null) and its lines. */
function jobs(file) {
  const lines = read(`.github/workflows/${file}`).split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, `${file}: jobs`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const head = /^ {2}([\w-]+):\s*$/.exec(lines[i]);
    if (head) out.push({ name: head[1], if: null, lines: [] });
    else if (/^\S/.test(lines[i])) break;
    else if (out.length) {
      out.at(-1).lines.push(lines[i]);
      const cond = /^ {4}if:\s*(.+?)\s*$/.exec(lines[i]);
      if (cond) out.at(-1).if = cond[1].replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1');
    }
  }
  return out;
}

test('every action is pinned to a full commit id, with its version in a comment', () => {
  const pinned = new Map();
  let count = 0;
  for (const file of workflows) {
    for (const line of read(`.github/workflows/${file}`).split('\n')) {
      const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
      if (!m) continue;
      if (m[1].startsWith('./')) continue; // a workflow in this repository, at this commit
      count += 1;
      const ref = /^([\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@([0-9a-f]{40})$/.exec(m[1]);
      assert.ok(ref, `${file}: "${m[1]}" is not pinned to a full commit id`);
      assert.match(m[2], /^\s+# v\d+\.\d+\.\d+\s*$/, `${file}: "${m[1]}" names its version in a trailing comment`);
      const seen = pinned.get(ref[1]) ?? new Set();
      pinned.set(ref[1], seen.add(`${ref[2]}${m[2].trim()}`));
    }
  }
  assert.ok(count > 0);
  for (const [action, ids] of pinned) assert.equal(ids.size, 1, `${action} is pinned to one commit everywhere: ${[...ids].join(', ')}`);
});

test('no workflow runs on pull requests, so none carries a fork guard', () => {
  for (const file of workflows) {
    const text = read(`.github/workflows/${file}`);
    const on = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(text)?.[1] ?? /^on:\s*(.+)$/m.exec(text)?.[1] ?? '';
    assert.doesNotMatch(on, /\bpull_request(_target)?\b/, `${file}: self-hosted runners on the production host never run pull request code`);
    // Without that trigger a fork check is dead code that reads like protection.
    assert.doesNotMatch(text, /github\.event\.pull_request|event_name\s*==\s*'pull_request'|Require trusted repository source/, `${file}: dead fork guard`);
  }
});

// Each workflow that touches production (or staging) and the one ref its jobs may run from.
const DEPLOY_REF = {
  'deploy.yml': 'main', 'backup.yml': 'main', 'ledger-root.yml': 'main',
  'ledger-anchor.yml': 'main', 'maintenance.yml': 'main', 'deploy-staging.yml': 'staging',
};
// Jobs that run on any ref only to fail visibly when the ref is wrong.
const REFUSES = { 'deploy.yml': { release: 'Require the path the change scope chose' } };

test('every job that touches production runs only from main', () => {
  for (const file of workflows) {
    const text = read(`.github/workflows/${file}`);
    if (/\bsecrets\.|KUBECONFIG|kubectl|contents:\s*write|uain-anchorer/.test(text)) {
      assert.ok(DEPLOY_REF[file], `${file} touches production: list it in DEPLOY_REF and guard its jobs`);
    }
  }
  for (const [file, branch] of Object.entries(DEPLOY_REF)) {
    assert.ok(workflows.includes(file), file);
    const guard = `github.ref == 'refs/heads/${branch}'`;
    for (const job of jobs(file)) {
      if (REFUSES[file]?.[job.name]) continue;
      assert.ok(job.if, `${file}: job ${job.name} has no if: ${guard}`);
      // A conjunct of the whole condition, so no other clause can lift it.
      assert.ok(job.if.split('&&').map((c) => c.trim()).includes(guard) && !job.if.includes('||'),
        `${file}: job ${job.name} runs only when ${guard} (has: ${job.if})`);
    }
  }
});

test('the release decision refuses a deploy run from any ref but main', () => {
  const script = stepScript('deploy.yml', REFUSES['deploy.yml'].release);
  const run = (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'uain-release-step-'));
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...env },
    });
    rmSync(dir, { recursive: true, force: true });
    return res;
  };
  const passed = { SCOPE: 'success', MODE: 'full', REASON: 'test', DOCS: 'skipped', DEPLOY: 'success' };
  assert.equal(run({ ...passed, REF: 'refs/heads/main' }).status, 0);
  for (const ref of ['refs/heads/feature', 'refs/tags/main', 'refs/heads/main-copy', '']) {
    const res = run({ ...passed, REF: ref });
    assert.equal(res.status, 1, ref);
    assert.match(res.stdout, /::error::Production deploys run only from main/, ref);
  }
  assert.equal(run({ ...passed, REF: 'refs/heads/main', DEPLOY: 'skipped' }).status, 1, 'a skipped deploy on main fails');
});
