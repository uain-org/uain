#!/usr/bin/env node
// Release rehearsal on a throwaway target on uain-app-1 (never a production path).
//
//   node ops/release/rehearse.mjs baink   real promote/rollback code, real
//        activate-release.py and baink-rollback-release.py, inside a throwaway
//        container (--network none) whose `systemctl` starts a stub server
//        that answers /api/health with the release header. Every ssh/scp the
//        command layer issues for the BAINK host is redirected into that
//        container; anything else is refused, so the BAINK host is never
//        contacted.
//   node ops/release/rehearse.mjs unit    the central-reviewer style adapter
//        and switch-release.py against a transient systemd unit in
//        /run/systemd/system and release folders under /opt/uain-test/.
//
// Each run: promote with an injected activation failure (expect automatic
// rollback), a good promote, then a confirmed rollback. Prints one JSON
// summary and removes everything it created.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive, releaseEpoch, sha256 } from './archive.mjs';
import { COMPONENTS } from './components.mjs';
import { adapterFor } from './adapters.mjs';
import { promote, rollback, REPO_ROOT } from './operate.mjs';
import { spawnProcess } from './runner.mjs';

const HOST = 'uain-app-1';
const tag = randomBytes(4).toString('hex');
const q = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const ssh = (script, input) =>
  new Promise((resolve) => {
    const child = nodeSpawn('ssh', ['-o', 'BatchMode=yes', HOST, script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
const must = async (script, input) => {
  const r = await ssh(script, input);
  if (r.code !== 0) throw new Error(`${script.slice(0, 120)}: ${r.stderr.trim()}`);
  return r.stdout;
};
const brief = (r) => ({
  outcome: r.outcome,
  release: r.release ?? null,
  production: r.production?.state,
  rollback: r.rollback?.state,
  public: r.public?.state,
  failures: r.failures.map((f) => f.code),
});

// ------------------------------------------------------------------ BAINK
const STUB = `import http.server, json, os, pathlib
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        cur = pathlib.Path(os.path.realpath('/opt/baink/current'))
        ok = not (cur / 'FAIL_HEALTH').exists()
        body = json.dumps({'ok': ok}).encode()
        self.send_response(200 if ok else 503)
        self.send_header('x-baink-release', cur.name)
        self.send_header('content-type', 'application/json')
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 8798), H).serve_forever()
`;
const SHIM = `#!/bin/sh
p=/run/stub.pid
case "$1" in
  start) if [ -f $p ] && kill -0 $(cat $p) 2>/dev/null; then exit 0; fi
         nohup python3 /opt/stub.py >/dev/null 2>&1 & echo $! > $p; sleep 0.3 ;;
  stop) if [ -f $p ]; then kill $(cat $p) 2>/dev/null; rm -f $p; sleep 0.3; fi ;;
  is-active) if [ -f $p ] && kill -0 $(cat $p) 2>/dev/null; then echo active; else echo inactive; exit 3; fi ;;
esac
exit 0
`;
const PROBE = `import json, urllib.request, urllib.error
try:
    r = urllib.request.urlopen('http://127.0.0.1:8798/api/health', timeout=5); s = r.status; h = r.headers.get('x-baink-release'); b = r.read()
except urllib.error.HTTPError as e:
    s = e.code; h = e.headers.get('x-baink-release'); b = e.read()
except Exception:
    s = 0; h = None; b = b'null'
print(json.dumps({'status': s, 'release': h, 'body': json.loads(b or b'null')}))
`;

async function bainkRelease(output, release, prior, { fail = false } = {}) {
  const spec = COMPONENTS.baink;
  const dir = join(output, release);
  const files = { 'server/index.mjs': `export const release = '${release}'\n`, 'dist/index.html': '<html>rehearsal</html>' };
  if (fail) files.FAIL_HEALTH = 'injected activation failure\n';
  const manifest = { release, version: '0.3.99', host: spec.host, prior_release: prior, files: {}, preview_files: {}, native_financial_activation: false, private_member_keys_in_release: false };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
    manifest.files[name] = sha256(Buffer.from(text));
  }
  await mkdir(join(dir, 'preview'), { recursive: true });
  await writeFile(join(dir, 'preview', 'index.html'), '<html>preview</html>');
  manifest.preview_files['index.html'] = sha256(Buffer.from('<html>preview</html>'));
  await writeFile(join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const gz = await createArchive(dir, { mtime: releaseEpoch(release) });
  await writeFile(join(output, release + '.tar.gz'), gz);
  await writeFile(join(output, release + '.tar.gz.sha256'), `${sha256(gz)}  ${release}.tar.gz\n`);
  return dir;
}

async function rehearseBaink() {
  const spec = COMPONENTS.baink;
  const ctr = `uain-release-rehearsal-${tag}`;
  const now = Date.now();
  const id = (n) => new Date(now + n * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z-' + randomBytes(5).toString('hex');
  const [PRIOR, BAD, GOOD] = [id(0), id(1), id(2)];
  const output = await mkdtemp(join(tmpdir(), 'baink-rehearsal-'));
  const steps = [];
  try {
    await must(`docker run -d --name ${ctr} --network none --memory 256m --cpus 0.5 python:3.12-slim-bookworm sleep 3600`);
    await bainkRelease(output, PRIOR, null);
    // Seed the container: prior release, current/preview links, state, env, stub, shim.
    const tar = await new Promise((resolve) => {
      const c = nodeSpawn('tar', ['-C', output, '-czf', '-', '--no-xattrs', PRIOR], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const chunks = []; c.stdout.on('data', (d) => chunks.push(d)); c.on('close', () => resolve(Buffer.concat(chunks)));
    });
    await must(`docker exec -i ${ctr} sh -c 'mkdir -p /opt/baink/releases && tar -C /opt/baink/releases -xzf - && chown -R 0:0 /opt/baink/releases'`, tar);
    await must(`docker exec -i ${ctr} sh -c 'cat > /opt/stub.py'`, STUB);
    await must(`docker exec -i ${ctr} sh -c 'cat > /usr/local/bin/systemctl && chmod 755 /usr/local/bin/systemctl'`, SHIM);
    await must(`docker exec -i ${ctr} sh -c 'cat > /opt/probe.py'`, PROBE);
    await must(`docker exec ${ctr} sh -c ${q([
      'set -e',
      'mkdir -p /var/lib/baink-deployments /var/backups/baink /var/www/baink-preview /var/lib/baink',
      `ln -s /opt/baink/releases/${PRIOR} /opt/baink/current`,
      `ln -s /opt/baink/releases/${PRIOR}/preview /var/www/baink-preview/baink`,
      "echo '{}' > /var/lib/baink/state.json && chmod 600 /var/lib/baink/state.json",
      'echo REHEARSAL=1 > /etc/baink.env && chmod 600 /etc/baink.env',
      'systemctl start baink.service',
    ].join('; '))}`);

    const spawn = async (command, args) => {
      if (command === 'ssh' && args[2] === spec.host)
        return ssh(`docker exec ${ctr} sh -c ${q(args[3])}`);
      if (command === 'scp' && args.at(-1).startsWith(spec.host + ':')) {
        const target = args.at(-1).slice(spec.host.length + 1);
        return ssh(`docker exec -i ${ctr} sh -c ${q(`cat > ${target}`)}`, await readFile(args.at(-2)));
      }
      return { code: 126, stdout: '', stderr: `rehearsal refused ${command} ${args.join(' ')}` };
    };
    const fetch = async () => {
      const r = await ssh(`docker exec ${ctr} python3 /opt/probe.py`);
      try { return JSON.parse(r.stdout); } catch { return { status: 0, release: null, body: null }; }
    };
    const deps = { spawn, fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date().toISOString(), env: process.env, attempts: 5, intervalMs: 1000 };

    await bainkRelease(output, BAD, PRIOR, { fail: true });
    const bad = await promote({ component: 'baink', releaseDir: join(output, BAD), expectedPrior: PRIOR, yes: true, root: REPO_ROOT }, deps);
    steps.push({ step: 'promote with injected activation failure', release: BAD, ...brief(bad), live: (await fetch()).release });

    await bainkRelease(output, GOOD, PRIOR);
    const good = await promote({ component: 'baink', releaseDir: join(output, GOOD), expectedPrior: PRIOR, yes: true, root: REPO_ROOT }, deps);
    steps.push({ step: 'promote', release: GOOD, ...brief(good), live: (await fetch()).release });

    const dry = await rollback({ component: 'baink', release: PRIOR, expectedCurrent: GOOD, yes: false, root: REPO_ROOT }, deps);
    steps.push({ step: 'rollback dry run', ...brief(dry), live: (await fetch()).release });
    const back = await rollback({ component: 'baink', release: PRIOR, expectedCurrent: GOOD, yes: true, root: REPO_ROOT }, deps);
    steps.push({ step: 'rollback --yes', ...brief(back), live: (await fetch()).release });
    const preview = (await ssh(`docker exec ${ctr} readlink /var/www/baink-preview/baink`)).stdout.trim();
    steps.push({ step: 'preview link after rollback', preview });
  } finally {
    await ssh(`docker rm -f ${ctr} >/dev/null 2>&1; true`);
    await rm(output, { recursive: true, force: true });
  }
  return { scenario: 'baink', host: HOST, target: `container uain-release-rehearsal-${tag} (python:3.12-slim-bookworm, --network none)`, ids: { PRIOR, BAD, GOOD }, steps };
}

// ------------------------------------------------------------------ unit
async function rehearseUnit() {
  const base = `/opt/uain-test/release-rehearsal-${tag}`;
  const unit = `uain-release-rehearsal-${tag}.service`;
  const unitFile = `/run/systemd/system/${unit}`;
  const [A, B, C] = ['a', 'b', 'c'].map((c) => sha256(Buffer.from(c + tag)));
  const spec = {
    ...COMPONENTS['central-reviewer'],
    id: `rehearsal-${tag}`,
    releasesRoot: `${base}/releases`,
    manifestFile: undefined,
    helperDir: `${base}/helper`,
    backupDir: `${base}/backups`,
    publicChecks: [],
    settle: 4,
    parts: { svc: { unit, unitFile, entry: 'app/' } },
  };
  const steps = [];
  const deps = { spawn: spawnProcess, fetch: async () => ({ status: 0 }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date().toISOString(), env: process.env };
  const adapter = adapterFor(spec);
  try {
    await must([
      'set -e',
      `mkdir -p ${base}/releases/${A}/app ${base}/releases/${B}/app ${base}/releases/${C}/app`,
      `printf '#!/bin/sh\\nexec sleep infinity\\n' > ${base}/releases/${A}/app/run.sh`,
      `printf '#!/bin/sh\\necho injected activation failure >&2\\nsleep 1\\nexit 1\\n' > ${base}/releases/${B}/app/run.sh`,
      `printf '#!/bin/sh\\nexec sleep infinity\\n' > ${base}/releases/${C}/app/run.sh`,
      `chmod 755 ${base}/releases/*/app/run.sh && chown -R 0:0 ${base} && chmod -R go-w ${base}`,
      `printf '[Unit]\\nDescription=UAIN release rehearsal (throwaway)\\n[Service]\\nExecStart=/bin/sh ${base}/releases/${A}/app/run.sh\\nRestart=on-failure\\nRestartSec=1\\nMemoryMax=16M\\n' > ${unitFile}`,
      `systemctl daemon-reload && systemctl start ${unit} && sleep 1 && systemctl is-active ${unit}`,
    ].join('; '));
    const opts = (o) => ({ component: spec.id, part: 'svc', root: REPO_ROOT, ...o });
    const exec = async () => (await ssh(`grep -o 'releases/[0-9a-f]*' ${unitFile}; systemctl is-active ${unit}`)).stdout.trim().replace(/\n/g, ' ');
    const bad = await adapter.promote(spec, opts({ release: B, expectedPrior: A, yes: true }), deps);
    steps.push({ step: 'promote with injected activation failure', release: B, ...brief(bad), live: await exec() });
    const good = await adapter.promote(spec, opts({ release: C, expectedPrior: A, yes: true }), deps);
    steps.push({ step: 'promote', release: C, ...brief(good), live: await exec() });
    const dry = await adapter.rollback(spec, opts({ release: A, expectedCurrent: C, yes: false }), deps);
    steps.push({ step: 'rollback dry run', ...brief(dry), live: await exec() });
    const back = await adapter.rollback(spec, opts({ release: A, expectedCurrent: C, yes: true }), deps);
    steps.push({ step: 'rollback --yes', ...brief(back), live: await exec() });
    const backups = (await ssh(`ls ${base}/backups | wc -l`)).stdout.trim();
    steps.push({ step: 'unit backups kept', count: Number(backups) });
  } finally {
    await ssh(`systemctl stop ${unit} 2>/dev/null; rm -f ${unitFile} /run/lock/uain-release-${unit}.lock; systemctl daemon-reload; systemctl reset-failed ${unit} 2>/dev/null; rm -rf ${base}; true`);
  }
  return { scenario: 'unit', host: HOST, target: `${unitFile} with releases under ${base}`, ids: { A, B, C }, steps };
}

const which = process.argv[2];
const result = which === 'baink' ? await rehearseBaink() : which === 'unit' ? await rehearseUnit() : null;
if (!result) {
  process.stderr.write('Usage: node ops/release/rehearse.mjs baink|unit\n');
  process.exitCode = 2;
} else process.stdout.write(JSON.stringify({ ranAt: new Date().toISOString(), ...result }, null, 2) + '\n');
