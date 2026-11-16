#!/usr/bin/env node
// Read-only development environment check (plan P2).
// It never reads .env contents, prints credentials, installs anything or
// writes to a database or remote host. Each failing check prints a remedy.
//
//   node ops/dev/doctor.mjs [--component <name>] [--json] [--skip-remote]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './impact.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCAL_TEST_DB = {
  host: '127.0.0.1',
  port: 55432,
  database: 'uain_local_test',
};
const REMOTE_ALIAS = 'uain-app-1';

export function satisfies(version, range) {
  const want = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? '').trim());
  if (!want) return null;
  const have = String(version).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > Number(want[i + 1])) return true;
    if ((have[i] ?? 0) < Number(want[i + 1])) return false;
  }
  return true;
}

function run(command, args, timeoutMs = 8000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    missing: result.error?.code === 'ENOENT',
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

/** Describe a database URL without its credentials. */
export function describeDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, ''),
      hasPassword: Boolean(url.password),
    };
  } catch {
    return null;
  }
}

function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok, detail) => {
      socket.destroy();
      done({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () => finish(false, 'timed out'));
    socket.once('connect', () => finish(true, 'accepting connections'));
    socket.once('error', (error) => finish(false, error.code ?? 'error'));
  });
}

const checks = {
  async node() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const range = pkg.engines?.node;
    const ok = satisfies(process.versions.node, range);
    return {
      status: ok ? 'ok' : 'fail',
      detail: `node ${process.versions.node}; engines ${range}`,
      remedy: 'Install Node 22.13.0 or later (for example `nvm install 22`).',
    };
  },

  async deps(dir) {
    const base = join(ROOT, dir);
    const label = dir === '.' ? 'root' : dir;
    if (!existsSync(join(base, 'package-lock.json')))
      return {
        status: 'warn',
        detail: `${label}: no package-lock.json`,
        remedy: 'Nothing to install.',
      };
    const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
    const wanted = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const remedy = `npm ${dir === '.' ? '' : `--prefix ${dir} `}ci`;
    if (!existsSync(join(base, 'node_modules')))
      return {
        status: 'fail',
        detail: `${label}: node_modules missing`,
        remedy,
      };
    const missing = wanted.filter(
      (name) => !existsSync(join(base, 'node_modules', name, 'package.json')),
    );
    if (missing.length)
      return {
        status: 'fail',
        detail: `${label}: ${missing.length}/${wanted.length} dependencies missing (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''})`,
        remedy,
      };
    const lock = JSON.parse(
      readFileSync(join(base, 'package-lock.json'), 'utf8'),
    );
    const stale = wanted.filter((name) => {
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      if (!locked) return false;
      const installed = JSON.parse(
        readFileSync(join(base, 'node_modules', name, 'package.json'), 'utf8'),
      ).version;
      return installed !== locked;
    });
    if (stale.length)
      return {
        status: 'fail',
        detail: `${label}: ${stale.length} installed version(s) differ from the lockfile (${stale.slice(0, 4).join(', ')})`,
        remedy,
      };
    return {
      status: 'ok',
      detail: `${label}: ${wanted.length} dependencies installed at locked versions`,
    };
  },

  async docker() {
    const result = run(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      8000,
    );
    if (result.missing)
      return {
        status: 'warn',
        detail: 'docker not installed',
        remedy:
          'Optional locally: the suites run on uain-app-1 through ops/remote-test/run.sh (docs-crucial/commands-and-testing.md prefers it over local Docker).',
      };
    if (!result.ok)
      return {
        status: 'warn',
        detail: result.timedOut
          ? 'docker daemon did not answer within 8s'
          : 'docker daemon not reachable',
        remedy:
          'Start Docker Desktop or the docker service, or use ops/remote-test/run.sh.',
      };
    return { status: 'ok', detail: `docker server ${result.stdout}` };
  },

  async flock() {
    const flock = run('sh', ['-c', 'command -v flock']);
    const findmnt = run('sh', ['-c', 'command -v findmnt']);
    const linux = process.platform === 'linux';
    if (flock.ok && (findmnt.ok || !linux))
      return {
        status: 'ok',
        detail: `flock at ${flock.stdout}${findmnt.ok ? `; findmnt at ${findmnt.stdout}` : ''}`,
      };
    const missing = [!flock.ok && 'flock', linux && !findmnt.ok && 'findmnt']
      .filter(Boolean)
      .join(', ');
    if (!linux)
      return {
        status: 'warn',
        detail: `${missing} not found on ${process.platform}; the CI launcher and holder runtime need util-linux on Linux`,
        remedy:
          'Run Linux-only suites with ops/remote-test/run.sh on uain-app-1, or `brew install util-linux` for local scripts.',
      };
    return {
      status: 'fail',
      detail: `${missing} not found`,
      remedy: 'Install util-linux (for example `apt-get install util-linux`).',
    };
  },

  async postgres() {
    // Repository convention: the disposable test cluster at 127.0.0.1:55432
    // (services/pilot/scripts/setup-local-test.mjs). The .env file is never
    // read here; an exported DATABASE_URL is described without credentials.
    const described = process.env.DATABASE_URL
      ? describeDatabaseUrl(process.env.DATABASE_URL)
      : null;
    const target = described ?? LOCAL_TEST_DB;
    const source = described
      ? 'exported DATABASE_URL'
      : 'repository test convention';
    const isTestTarget =
      target.host === LOCAL_TEST_DB.host &&
      target.port === LOCAL_TEST_DB.port &&
      target.database === LOCAL_TEST_DB.database;
    const envFile = existsSync(join(ROOT, '.env'))
      ? '.env present (not read)'
      : '.env absent';
    const reach = await tcpReachable(target.host, target.port);
    const where = `${target.host}:${target.port}/${target.database} via ${source}; ${envFile}`;
    if (!isTestTarget)
      return {
        status: 'warn',
        detail: `${where}: not the local test database; doctor does not connect to other databases`,
        remedy:
          'Point DATABASE_URL at the disposable test cluster (127.0.0.1:55432/uain_local_test) for `npm run test:pilot`.',
      };
    if (!reach.ok)
      return {
        status: 'fail',
        detail: `${where}: ${reach.detail}`,
        remedy:
          'Start the disposable cluster in work/dev-postgres and run `npm run setup:local-db` (see docs/local-development.md), or run the suite remotely with `ops/remote-test/run.sh --suite pilot`.',
      };
    return { status: 'ok', detail: `${where}: ${reach.detail}` };
  },

  async 'ssh-remote'() {
    if (process.argv.includes('--skip-remote'))
      return {
        status: 'warn',
        detail: 'skipped (--skip-remote)',
        remedy: 'Rerun without --skip-remote to test remote-harness access.',
      };
    const result = run(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'StrictHostKeyChecking=yes',
        REMOTE_ALIAS,
        'true',
      ],
      12000,
    );
    if (result.missing)
      return {
        status: 'fail',
        detail: 'ssh not installed',
        remedy: 'Install an OpenSSH client.',
      };
    if (!result.ok)
      return {
        status: 'fail',
        detail: `${REMOTE_ALIAS} not reachable with BatchMode (exit ${result.status ?? (result.timedOut ? 'timeout' : 'unknown')})`,
        remedy: `Add the ${REMOTE_ALIAS} alias and key from docs/production-host.md to ~/.ssh/config and load the key in your agent; the remote harness (ops/remote-test/run.sh) needs it.`,
      };
    return {
      status: 'ok',
      detail: `${REMOTE_ALIAS} accepts non-interactive ssh`,
    };
  },

  async python3() {
    const result = run('python3', ['--version']);
    if (!result.ok)
      return {
        status: 'fail',
        detail: 'python3 not found',
        remedy:
          'Install Python 3 (custody, organizations and operations tests use it).',
      };
    return { status: 'ok', detail: result.stdout };
  },

  async go() {
    const mod = readFileSync(join(ROOT, 'chain/go.mod'), 'utf8');
    const wanted = /^go\s+(\S+)/m.exec(mod)?.[1];
    const result = run('go', ['env', 'GOVERSION']);
    if (!result.ok)
      return {
        status: 'fail',
        detail: `go not found; chain/go.mod requires go ${wanted}`,
        remedy: `Install Go ${wanted} or later, or run the native suites through CI.`,
      };
    const have = result.stdout.replace(/^go/, '');
    const ok = satisfies(
      have,
      `>=${wanted}${wanted.split('.').length === 2 ? '.0' : ''}`,
    );
    return {
      status: ok ? 'ok' : 'fail',
      detail: `go ${have}; chain/go.mod requires ${wanted}`,
      remedy: `Install Go ${wanted} or later.`,
    };
  },

  async rustc() {
    // ops/ci/container-suite.sh pins rustc 1.89.0 for the private tools.
    const result = run('rustc', ['--version']);
    if (!result.ok)
      return {
        status: 'warn',
        detail:
          'rustc not found; private-exchange builds use pinned rustc 1.89.0',
        remedy:
          'Install with `rustup toolchain install 1.89.0`, or rely on the private-exchange CI job.',
      };
    const ok = result.stdout.startsWith('rustc 1.89.0 ');
    return {
      status: ok ? 'ok' : 'warn',
      detail: result.stdout,
      remedy:
        'The CI suite requires exactly rustc 1.89.0: `rustup override set 1.89.0` in chain/.',
    };
  },
};

export function checksFor(component, manifest = loadManifest()) {
  if (!component) {
    const all = new Set([
      'node',
      'python3',
      'docker',
      'flock',
      'postgres',
      'ssh-remote',
      'go',
      'rustc',
    ]);
    for (const dir of packageDirs()) all.add(`deps:${dir}`);
    return [...all];
  }
  const entry = manifest.components[component];
  if (!entry)
    throw new Error(
      `Unknown component ${component}. Known: ${Object.keys(manifest.components).join(', ')}`,
    );
  return entry.doctor ?? ['node'];
}

function packageDirs() {
  const dirs = ['.'];
  for (const top of ['services', 'apps'])
    for (const name of readdirSync(join(ROOT, top)))
      if (existsSync(join(ROOT, top, name, 'package-lock.json')))
        dirs.push(`${top}/${name}`);
  for (const dir of ['chain', 'contracts', 'runner'])
    if (existsSync(join(ROOT, dir, 'package-lock.json'))) dirs.push(dir);
  return dirs;
}

export async function runDoctor(names) {
  const results = [];
  for (const name of names) {
    const [check, argument] = name.split(':');
    const fn = checks[check];
    if (!fn) throw new Error(`Unknown doctor check ${name}`);
    let result;
    try {
      result = await fn(argument);
    } catch (error) {
      result = {
        status: 'fail',
        detail: `check crashed: ${error.message}`,
        remedy: 'Report this doctor failure.',
      };
    }
    results.push({ check: name, ...result });
  }
  return results;
}

async function main(argv) {
  const index = argv.indexOf('--component');
  const component = index >= 0 ? argv[index + 1] : undefined;
  const results = await runDoctor(checksFor(component));
  if (argv.includes('--json'))
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  else {
    console.log(
      `UAIN doctor${component ? ` (component ${component})` : ''}: read-only`,
    );
    for (const result of results) {
      console.log(
        `${result.status.toUpperCase().padEnd(4)} ${result.check.padEnd(26)} ${result.detail}`,
      );
      if (result.status !== 'ok' && result.remedy)
        console.log(`     remedy: ${result.remedy}`);
    }
    const failed = results.filter((r) => r.status === 'fail').length;
    const warned = results.filter((r) => r.status === 'warn').length;
    console.log(
      `${results.length} checks: ${results.length - failed - warned} ok, ${warned} warn, ${failed} fail`,
    );
  }
  process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
