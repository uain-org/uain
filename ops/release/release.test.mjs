import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createArchive,
  readArchive,
  releaseEpoch,
  sha256,
} from './archive.mjs';
import { COMPONENTS } from './components.mjs';
import { buildPlan } from './plan.mjs';
import { readOnlySpawner, redact } from './runner.mjs';
import { verifyRelease } from './verify.mjs';
import { promote, rollback, REPO_ROOT } from './operate.mjs';
import { main } from './cli.mjs';

const spec = COMPONENTS.baink;
const PRIOR = '20261106T095448Z-3bfb533803';
const RELEASE = '20261106T120000Z-0123456789';
const OTHER = '20261106T104129Z-bf251ab148';
const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));

async function fixture({ release = RELEASE, prior = PRIOR, extra } = {}) {
  const output = await mkdtemp(join(tmpdir(), 'output-baink-'));
  const dir = join(output, release);
  const files = {
    'dist/index.html': '<html>root</html>',
    'dist/assets/app.js': 'console.log(1)',
    'server/index.mjs': 'export {}',
    'package.json': '{"version":"0.3.33"}',
  };
  const preview = { 'index.html': '<html>preview</html>' };
  const manifest = {
    release,
    version: '0.3.33',
    host: spec.host,
    prior_release: prior,
    files: {},
    preview_files: {},
    native_financial_activation: false,
    private_member_keys_in_release: false,
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
    manifest.files[name] = sha256(Buffer.from(text));
  }
  for (const [name, text] of Object.entries(preview)) {
    await mkdir(join(dir, 'preview', name, '..'), { recursive: true });
    await writeFile(join(dir, 'preview', name), text);
    manifest.preview_files[name] = sha256(Buffer.from(text));
  }
  await writeFile(
    join(dir, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  if (extra) await extra(dir);
  const archive = join(output, release + '.tar.gz');
  const bytes = await createArchive(dir, { mtime: releaseEpoch(release) });
  await writeFile(archive, bytes);
  await writeFile(archive + '.sha256', sha256(bytes) + '  release.tar.gz\n');
  return { output, dir, archive, sha: sha256(bytes) };
}

/** A fake BAINK host and public edge. Records every spawn. */
function host({
  current = PRIOR,
  publicRelease,
  activation = 'ok',
  remoteDown = false,
  ...state
} = {}) {
  const host = {
    current,
    staged: '0',
    archive: '',
    helper: '',
    extracted: '0',
    priorRetained: '1',
    public: publicRelease ?? current,
    ...state,
  };
  const calls = [];
  const deps = {
    env: {},
    now: () => '2026-11-06T12:00:00Z',
    sleep: async () => {},
    attempts: 2,
    root: REPO_ROOT,
    fetch: async () => ({
      status: 200,
      release: host.public,
      body: { ok: true },
    }),
    spawn: async (command, args) => {
      const script = args.at(-1);
      const kind =
        command === 'scp'
          ? 'scp'
          : script.includes('echo "current=')
            ? 'status'
            : script.includes('install -d')
              ? 'stage'
              : script.includes('activate-release.py')
                ? 'activate'
                : script.includes('baink-rollback-release.py')
                  ? 'rollback'
                  : 'other';
      calls.push({ kind, command, args });
      if (kind === 'status') {
        if (remoteDown)
          return { code: 255, stdout: '', stderr: 'ssh: connect timed out' };
        return {
          code: 0,
          stdout: Object.entries(host)
            .filter(([k]) => k !== 'public')
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
          stderr: '',
        };
      }
      if (kind === 'stage') host.staged = '1';
      if (kind === 'scp') {
        const digest = sha256(await readFile(args.at(-2)));
        if (args.at(-1).endsWith('release.tar.gz')) host.archive = digest;
        else host.helper = digest;
      }
      if (kind === 'activate') {
        host.extracted = '1';
        if (activation === 'fail')
          return {
            code: 1,
            stdout: '',
            stderr: 'AssertionError: New service failed health check.',
          };
        if (activation === 'drop') {
          host.current = RELEASE;
          return { code: 255, stdout: '', stderr: 'Connection reset' };
        }
        host.current = RELEASE;
        host.public = RELEASE;
        return {
          code: 0,
          stdout:
            JSON.stringify({
              release: RELEASE,
              version: '0.3.33',
              healthy: true,
              backup: '/var/backups/baink/' + RELEASE,
            }) + '\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { host, calls, deps };
}

const kinds = (calls) => calls.map((c) => c.kind);

test('plan is deterministic and cannot spawn mutation helpers', async () => {
  const calls = [];
  const deps = {
    nodeVersion: 'v22.13.0',
    fetch: async () => ({ status: 200, release: PRIOR, body: { ok: true } }),
    spawn: async (command, args) => {
      calls.push([command, ...args]);
      return {
        code: 0,
        stdout: args[0] === 'status' ? '' : 'abc123\n',
        stderr: '',
      };
    },
  };
  const a = await buildPlan(
    { component: 'baink', environment: 'production', root: REPO_ROOT },
    deps,
  );
  const b = await buildPlan(
    { component: 'baink', environment: 'production', root: REPO_ROOT },
    deps,
  );
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  for (const call of calls) {
    assert.equal(call[0], 'git');
    assert.ok(
      ['rev-parse', 'status', 'diff'].includes(call[1]),
      call.join(' '),
    );
  }
  for (const key of [
    'schemaVersion',
    'sourceCommit',
    'sourceDigest',
    'target',
    'environment',
    'inputs',
    'checks',
    'artifactPaths',
    'expectedPriorRelease',
    'actions',
    'mutations',
  ])
    assert.ok(key in a, key);
  assert.equal(a.expectedPriorRelease.value, PRIOR);
  assert.ok(
    a.mutations.some(
      (m) => m.kind === 'service-restart' && m.target === 'baink.service',
    ),
  );
  assert.ok(a.mutations.some((m) => m.kind === 'preview-swap'));
  const preview = await buildPlan(
    { component: 'baink', environment: 'preview', root: REPO_ROOT },
    deps,
  );
  assert.match(preview.notes.join(' '), /activated together with production/);

  const guarded = readOnlySpawner(async () => assert.fail('spawned'));
  for (const [cmd, args] of [
    ['ssh', ['host', 'systemctl stop baink.service']],
    ['scp', ['a', 'b']],
    ['git', ['push']],
    ['python3', ['activate-release.py']],
  ])
    assert.throws(() => guarded(cmd, args), { code: 'plan_mutation_refused' });
});

test('archive is byte-deterministic and extracts with the activation helper filter', async () => {
  const { dir, archive } = await fixture();
  const one = await createArchive(dir, { mtime: releaseEpoch(RELEASE) });
  const two = await createArchive(dir, { mtime: releaseEpoch(RELEASE) });
  assert.ok(one.equals(two));
  assert.ok(one.equals(await readFile(archive)));
  const names = [...readArchive(one).files.keys()];
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(names, [...names].sort(order));
  const python = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import sys, tarfile, tempfile, pathlib
with tempfile.TemporaryDirectory() as out:
    with tarfile.open(sys.argv[1], 'r:gz') as bundle:
        for m in bundle.getmembers(): assert m.uid == 0 and m.gid == 0 and not m.pax_headers, m.name
        bundle.extractall(out, filter='data')
    print('\\n'.join(sorted(str(p.relative_to(out)) for p in pathlib.Path(out).rglob('*') if p.is_file())))
`,
      archive,
    ],
    { encoding: 'utf8' },
  );
  if (python.status === null) return; // python3 unavailable
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(
    python.stdout.trim().split('\n'),
    names.filter((n) => !readArchive(one).dirs.has(n)).sort(order),
  );
  const verified = await verifyRelease(spec, { releaseDir: dir });
  assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  assert.equal(verified.reproducible, true);
});

test('AppleDouble entries are refused in the directory and in the archive', async () => {
  const { dir } = await fixture();
  await writeFile(join(dir, 'dist', '._index.html'), 'mac');
  await assert.rejects(createArchive(dir), /AppleDouble/);
  const result = await verifyRelease(spec, { releaseDir: dir });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.checks), /AppleDouble/);

  // An archive as macOS tar makes it: ._ entries and an xattr pax header.
  const clean = await fixture();
  const python = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import sys, tarfile, io, pathlib
root = pathlib.Path(sys.argv[1])
with tarfile.open(sys.argv[2], 'w:gz', format=tarfile.PAX_FORMAT) as out:
    for p in sorted(root.rglob('*')):
        out.add(p, arcname='./' + str(p.relative_to(root)), recursive=False)
    data = b'mac'
    info = tarfile.TarInfo('./dist/._index.html'); info.size = len(data)
    out.addfile(info, io.BytesIO(data))
`,
      clean.dir,
      clean.archive,
    ],
    { encoding: 'utf8' },
  );
  if (python.status === null) return;
  assert.equal(python.status, 0, python.stderr);
  const archived = await verifyRelease(spec, { releaseDir: clean.dir });
  assert.equal(archived.ok, false);
  assert.match(JSON.stringify(archived.checks), /AppleDouble|sha256 differs/);
  assert.throws(
    () => readArchive(Buffer.from(gzipWithXattr())),
    /extended metadata/,
  );
});

// A gzip tar whose only member carries a LIBARCHIVE.xattr pax record.
function gzipWithXattr() {
  const result = spawnSync('python3', [
    '-I',
    '-c',
    `
import sys, tarfile, io
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.PAX_FORMAT) as out:
    info = tarfile.TarInfo('dist/a.js'); info.size = 1
    info.pax_headers = {'LIBARCHIVE.xattr.com.apple.provenance': 'AQ'}
    out.addfile(info, io.BytesIO(b'x'))
sys.stdout.buffer.write(buf.getvalue())
`,
  ]);
  return result.stdout;
}

test('promote refuses without --yes, for preview, and without an expected prior', async () => {
  const { dir } = await fixture();
  const { calls, deps } = host();
  for (const options of [
    { releaseDir: dir, expectedPrior: PRIOR },
    {
      releaseDir: dir,
      expectedPrior: PRIOR,
      yes: true,
      environment: 'preview',
    },
    { releaseDir: dir, yes: true },
  ]) {
    const report = await promote(options, deps);
    assert.equal(report.outcome, 'refused');
  }
  assert.deepEqual(calls, []);
});

test('missing artifact refuses before any remote call or service stop', async () => {
  const { dir, archive } = await fixture();
  await rm(archive);
  const { calls, deps } = host();
  const report = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    deps,
  );
  assert.equal(report.outcome, 'refused');
  assert.equal(report.failures[0].code, 'local_verification_failed');
  assert.equal(report.local.state, 'failed');
  assert.equal(report.production.state, 'not-run');
  assert.deepEqual(calls, []);
});

test('wrong expected prior refuses after a read-only status, before staging', async () => {
  const { dir } = await fixture({ prior: null });
  const { calls, deps } = host({ current: OTHER });
  const report = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    deps,
  );
  assert.equal(report.outcome, 'refused');
  assert.equal(report.failures[0].code, 'prior_mismatch');
  assert.deepEqual(kinds(calls), ['status']);

  // A manifest packaged against a different prior refuses locally.
  const packaged = await fixture({ prior: OTHER });
  const second = host();
  const again = await promote(
    { releaseDir: packaged.dir, expectedPrior: PRIOR, yes: true },
    second.deps,
  );
  assert.equal(again.failures[0].code, 'prior_mismatch');
  assert.deepEqual(second.calls, []);

  // Public header disagreeing with the host also refuses.
  const third = host({ publicRelease: OTHER });
  const split = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    third.deps,
  );
  assert.equal(split.failures[0].code, 'prior_mismatch');
  assert.deepEqual(kinds(third.calls), ['status']);
});

test('promote stages, activates the verified archive and accepts publicly', async () => {
  const { dir, sha, output } = await fixture();
  const { calls, deps, host: state } = host();
  const report = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    deps,
  );
  assert.equal(report.outcome, 'completed', JSON.stringify(report.failures));
  assert.deepEqual(kinds(calls), [
    'status',
    'stage',
    'scp',
    'scp',
    'status',
    'activate',
  ]);
  assert.equal(state.archive, sha);
  const activation = calls.find((c) => c.kind === 'activate').args.at(-1);
  assert.equal(
    activation,
    `cd /var/lib/baink-deployments/${RELEASE} && python3 activate-release.py ${RELEASE} ${sha} ${PRIOR}`,
  );
  for (const key of ['local', 'staging', 'production', 'public'])
    assert.notEqual(report[key].state, 'not-run', key);
  assert.equal(report.public.state, 'passed');
  assert.match(report.rollback.command, /baink-rollback-release\.py/);
  const journal = JSON.parse(
    await readFile(join(output, RELEASE + '.promote.json'), 'utf8'),
  );
  assert.equal(journal.stages.activate.state, 'completed');

  // Re-running is resumable: the host already serves the release.
  const again = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    deps,
  );
  assert.equal(again.outcome, 'completed');
  assert.equal(again.resumed, true);
  assert.deepEqual(kinds(calls).slice(6), ['status']);
});

test('interrupted promote resumes only after status reconciliation', async () => {
  // Interrupted mid-activation; the host did switch.
  const a = await fixture();
  const first = host({ activation: 'drop' });
  const dropped = await promote(
    { releaseDir: a.dir, expectedPrior: PRIOR, yes: true },
    first.deps,
  );
  assert.equal(dropped.outcome, 'unknown');
  assert.equal(
    JSON.parse(
      await readFile(join(a.output, RELEASE + '.promote.json'), 'utf8'),
    ).stages.activate.state,
    'started',
  );
  first.host.public = RELEASE;
  const before = first.calls.length;
  const resumed = await promote(
    { releaseDir: a.dir, expectedPrior: PRIOR, yes: true },
    first.deps,
  );
  assert.equal(resumed.outcome, 'completed');
  assert.deepEqual(kinds(first.calls.slice(before)), ['status']);
  assert.match(resumed.production.detail, /reconciled interrupted activation/);

  // Interrupted before the helper changed anything: reconcile, then re-run.
  const b = await fixture();
  await writeFile(
    join(b.output, RELEASE + '.promote.json'),
    JSON.stringify({
      release: RELEASE,
      prior: PRIOR,
      archiveSha256: b.sha,
      stages: { activate: { state: 'started' } },
    }),
  );
  const second = host({
    staged: '1',
    archive: b.sha,
    helper: sha256(await readFile(join(REPO_ROOT, spec.activationHelper))),
  });
  const rerun = await promote(
    { releaseDir: b.dir, expectedPrior: PRIOR, yes: true },
    second.deps,
  );
  assert.equal(rerun.outcome, 'completed');
  assert.deepEqual(kinds(second.calls), ['status', 'status', 'activate']);
  assert.match(rerun.followUp.join(' '), /Reconciled interrupted activation/);

  // The helper extracted and rolled back: never reuse the release id.
  const c = await fixture();
  const third = host({ extracted: '1', staged: '1', archive: c.sha });
  const refused = await promote(
    { releaseDir: c.dir, expectedPrior: PRIOR, yes: true },
    third.deps,
  );
  assert.equal(refused.failures[0].code, 'previous_attempt_left_release');
  assert.deepEqual(kinds(third.calls), ['status']);

  // Host status unreadable: unknown, nothing changed.
  const d = await fixture();
  const fourth = host({ remoteDown: true });
  const unknown = await promote(
    { releaseDir: d.dir, expectedPrior: PRIOR, yes: true },
    fourth.deps,
  );
  assert.equal(unknown.outcome, 'unknown');
  assert.deepEqual(kinds(fourth.calls), ['status']);
});

test('failed activation reports the helper rollback distinctly', async () => {
  const { dir } = await fixture();
  const { deps } = host({ activation: 'fail' });
  const report = await promote(
    { releaseDir: dir, expectedPrior: PRIOR, yes: true },
    deps,
  );
  assert.equal(report.outcome, 'failed');
  assert.equal(report.production.state, 'failed');
  assert.equal(report.rollback.state, 'automatic');
  assert.equal(report.public.state, 'not-run');
  assert.equal(report.local.state, 'passed');
});

test('rollback is a dry run without --yes and guarded with it', async () => {
  const dry = host({ current: RELEASE });
  const plan = await rollback(
    { release: PRIOR, expectedCurrent: RELEASE },
    dry.deps,
  );
  assert.equal(plan.outcome, 'dry-run');
  assert.match(
    plan.rollback.command,
    new RegExp(`baink-rollback-release.py ${PRIOR} ${RELEASE} --yes`),
  );
  assert.deepEqual(dry.calls, []);

  const wrong = host({ current: OTHER });
  const refused = await rollback(
    { release: PRIOR, expectedCurrent: RELEASE, yes: true },
    wrong.deps,
  );
  assert.equal(refused.failures[0].code, 'current_mismatch');
  assert.deepEqual(kinds(wrong.calls), ['status']);

  const gone = host({ current: RELEASE, priorRetained: '0' });
  const missing = await rollback(
    { release: PRIOR, expectedCurrent: RELEASE, yes: true },
    gone.deps,
  );
  assert.equal(missing.failures[0].code, 'target_not_retained');
});

test('stderr and reports never print environment values', async () => {
  const secret = 'sk-live-very-secret-value-123';
  const env = { BAINK_ADMIN_TOKEN: secret, PATH: '/usr/bin' };
  assert.equal(
    redact(`token ${secret} and BAINK_ADMIN_TOKEN=${secret}`, env).includes(
      secret,
    ),
    false,
  );

  const { dir } = await fixture();
  const { deps } = host({ activation: 'fail' });
  deps.env = env;
  const inner = deps.spawn;
  deps.spawn = async (command, args) => {
    const result = await inner(command, args);
    if (result.code !== 0)
      result.stderr += `\nBAINK_ADMIN_TOKEN=${secret} ${secret}`;
    return result;
  };
  let out = '',
    err = '';
  const io = {
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  };
  const code = await main(
    ['promote', '--release-dir', dir, '--expected-prior', PRIOR, '--yes'],
    deps,
    io,
  );
  assert.equal(code, 1);
  assert.equal((out + err).includes(secret), false);
  const json = await main(
    [
      'promote',
      '--release-dir',
      dir,
      '--expected-prior',
      PRIOR,
      '--yes',
      '--json',
    ],
    deps,
    io,
  );
  assert.equal(json, 2); // now refused: the failed attempt left the release extracted
  assert.equal((out + err).includes(secret), false);

  // The real process: bad input and unknown component print a message only.
  for (const args of [
    ['promote', '--bogus'],
    ['status', '--component', 'nope'],
  ]) {
    const child = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, BAINK_ADMIN_TOKEN: secret },
    });
    assert.notEqual(child.status, 0);
    assert.equal((child.stdout + child.stderr).includes(secret), false);
    assert.doesNotMatch(
      child.stderr,
      /process\.env|BAINK_ADMIN_TOKEN|\n\s+at /,
    );
  }
});
