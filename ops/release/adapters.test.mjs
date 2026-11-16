import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENTS } from './components.mjs';
import {
  adapterPlan,
  k8sSetImageScript,
  switchArgs,
} from './adapters.mjs';
import { main } from './cli.mjs';
import { REPO_ROOT } from './operate.mjs';
import { sha256 } from './archive.mjs';
import { readFileSync } from 'node:fs';

const HELPER_SHA = sha256(readFileSync(new URL('./switch-release.py', import.meta.url)));

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const X = '1'.repeat(64), Y = '2'.repeat(64);

// A fake host: `handlers` map a predicate on the ssh script to a result.
function host(handlers) {
  const calls = [];
  const spawn = async (command, args) => {
    calls.push([command, args]);
    if (command === 'git') return { code: 0, stdout: 'f'.repeat(40) + '\n', stderr: '' };
    if (command === 'ssh' && /^(install -d .*then )?sha256sum \/var\/lib\/uain-release/.test(args.at(-1)) || (command === 'ssh' && args.at(-1).startsWith('install -d -m 700 -o root -g root /var/lib/uain-release')))
      return { code: 0, stdout: HELPER_SHA + '\n', stderr: '' };
    const script = command === 'ssh' ? args.at(-1) : args.join(' ');
    for (const [match, result] of handlers)
      if (match(script, command)) return typeof result === 'function' ? result(script) : result;
    return { code: 0, stdout: '', stderr: '' };
  };
  return {
    calls,
    deps: {
      spawn,
      fetch: async () => ({ status: 200, release: null, body: { ok: true } }),
      sleep: async () => {},
      now: () => '2026-11-10T00:00:00Z',
      env: {},
      attempts: 2,
      root: REPO_ROOT,
    },
  };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const tags = (web) => ok(`w0.web=10.98.0.1:5000/uain/web:${web}\n`);
const has = (text) => (script) => script.includes(text);

async function run(argv, deps) {
  let out = '', err = '';
  const io = { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } };
  const code = await main(argv, deps, io);
  return { code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() };
}

test('k8s promote switches the image after verifying the registry and the prior', async () => {
  let live = A;
  const { deps, calls } = host([
    [has('/manifests/'), ok('digest=sha256:' + 'd'.repeat(64) + '\n')],
    [has('set image'), (s) => { live = B; return ok(); }],
    [has('get deployment'), () => tags(live)],
  ]);
  const r = await run(['promote', '--component', 'uain-web', '--release', B, '--expected-prior', A, '--yes', '--json'], deps);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outcome, 'completed');
  assert.equal(r.json.production.state, 'activated');
  assert.ok(calls.some(([, a]) => a.at(-1).includes(`web=10.98.0.1:5000/uain/web:${B}`)));
  assert.match(r.json.rollback.command, new RegExp(`--release ${A} --expected-current ${B}`));
});

test('k8s promote refuses a prior mismatch and never sets an image', async () => {
  const { deps, calls } = host([
    [has('/manifests/'), ok('digest=sha256:' + 'd'.repeat(64) + '\n')],
    [has('get deployment'), tags(C)],
  ]);
  const r = await run(['promote', '--component', 'uain-web', '--release', B, '--expected-prior', A, '--yes', '--json'], deps);
  assert.equal(r.code, 2);
  assert.equal(r.json.failures[0].code, 'prior_mismatch');
  assert.ok(!calls.some(([, a]) => String(a.at(-1)).includes('set image')));
});

test('k8s promote refuses an image missing from the registry', async () => {
  const { deps, calls } = host([[has('/manifests/'), { code: 22, stdout: '', stderr: '404' }]]);
  const r = await run(['promote', '--component', 'uain-web', '--release', B, '--expected-prior', A, '--yes', '--json'], deps);
  assert.equal(r.code, 2);
  assert.equal(r.json.failures[0].code, 'local_verification_failed');
  assert.ok(!calls.some(([, a]) => String(a.at(-1)).includes('set image')));
});

test('k8s failed rollout sets the prior back and reports an automatic rollback', async () => {
  let live = A;
  const { deps } = host([
    [has('/manifests/'), ok('digest=sha256:' + 'd'.repeat(64) + '\n')],
    [has(`web:${B}`), () => { live = B; return { code: 1, stdout: '', stderr: 'rollout timed out' }; }],
    [has(`web:${A}`), () => { live = A; return ok(); }],
    [has('get deployment'), () => tags(live)],
  ]);
  const r = await run(['promote', '--component', 'uain-web', '--release', B, '--expected-prior', A, '--yes', '--json'], deps);
  assert.equal(r.code, 1);
  assert.equal(r.json.failures[0].code, 'activation_failed');
  assert.equal(r.json.rollback.state, 'automatic');
});

test('k8s promote requires --yes and --expected-prior', async () => {
  const { deps, calls } = host([]);
  assert.equal((await run(['promote', '--component', 'uain-web', '--release', B, '--expected-prior', A], deps)).code, 2);
  assert.equal((await run(['promote', '--component', 'uain-web', '--release', B, '--yes'], deps)).code, 2);
  assert.equal(calls.length, 0);
});

test('rollback is a dry run without --yes and contacts no host', async () => {
  for (const argv of [
    ['--component', 'uain-pilot', '--release', A, '--expected-current', B],
    ['--component', 'central-reviewer', '--part', 'worker', '--release', X, '--expected-current', Y],
    ['--component', 'organizations', '--release', A, '--expected-current', X],
    ['--component', 'private-payment-service', '--release', X, '--expected-current', Y],
  ]) {
    const { deps, calls } = host([]);
    const r = await run(['rollback', ...argv, '--json'], deps);
    assert.equal(r.code, 0, argv.join(' ') + r.err);
    assert.equal(r.json.outcome, 'dry-run');
    assert.equal(calls.length, 0);
  }
});

test('pilot image switch covers the deployment containers and both cronjobs', () => {
  const script = k8sSetImageScript(COMPONENTS['uain-pilot'], B);
  for (const part of ['deployment/pilot pilot=', 'native-rpc=', 'cronjob/native-projection', 'cronjob/research-index', 'rollout status deployment/pilot'])
    assert.ok(script.includes(part), part);
  assert.ok(!script.includes('rollout status cronjob'));
});

test('unit switch promote uploads the helper, runs it and confirms the host', async () => {
  let live = X;
  const { deps, calls } = host([
    [has('systemctl show -p ExecStart'), () => ok(`exec=/opt/uain-central-reviewer/releases/${live}/services/central-reviewer/src/ \nactive=active\npresent=1 owner=0 mode=755\nmanifest=${Y}\n`)],
    [has('switch-release.py unit'), () => { live = Y; return ok(JSON.stringify({ state: 'switched', backup: '/var/backups/uain-release/x' })); }],
  ]);
  const r = await run(['promote', '--component', 'central-reviewer', '--part', 'worker', '--release', Y, '--expected-prior', X, '--yes', '--json'], deps);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outcome, 'completed');
  const helper = calls.find(([c, a]) => c === 'ssh' && a.at(-1).includes('switch-release.py unit'));
  assert.ok(helper[1].at(-1).includes('--entry services/central-reviewer/src/'));
  assert.ok(helper[1].at(-1).includes(`--from ${X} --to ${Y}`));
  assert.ok(helper[1].at(-1).endsWith("--yes"));
});

test('unit switch maps helper exit 1 to an automatic rollback and exit 2 to a refusal', async () => {
  for (const [code, outcome, failure] of [[1, 'failed', 'activation_failed'], [2, 'refused', 'helper_refused'], [3, 'unknown', 'activation_unknown']]) {
    const { deps } = host([
      [has('systemctl show -p ExecStart'), ok(`exec=/opt/uain-central-reviewer/releases/${X}/ops/custody/ \npresent=1 owner=0 mode=755\n`)],
      [has('switch-release.py unit'), { code, stdout: JSON.stringify({ state: 'x', detail: 'detail' }), stderr: '' }],
    ]);
    const r = await run(['promote', '--component', 'central-reviewer', '--part', 'custody', '--release', Y, '--expected-prior', X, '--yes', '--json'], deps);
    assert.equal(r.json.outcome, outcome);
    assert.equal(r.json.failures[0].code, failure);
    if (code === 1) assert.equal(r.json.rollback.state, 'automatic');
  }
});

test('review broker switches its one unit and refuses a release whose manifest hash is not its id', async () => {
  let live = X;
  const status = (manifest) => () => ok(`exec=/opt/uain-broker/releases/${live}/apps/baink/review-broker/ \nactive=active\npresent=1 owner=0 mode=755\nmanifest=${manifest}\n`);
  const good = host([
    [has('systemctl show -p ExecStart'), status(Y)],
    [has('switch-release.py unit'), () => { live = Y; return ok(JSON.stringify({ state: 'switched' })); }],
  ]);
  const r = await run(['promote', '--component', 'private-review-broker', '--release', Y, '--expected-prior', X, '--yes', '--json'], good.deps);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outcome, 'completed');
  const helper = good.calls.find(([c, a]) => c === 'ssh' && a.at(-1).includes('switch-release.py unit'))[1].at(-1);
  for (const part of ['--unit uain-private-review-broker.service', '--root /opt/uain-broker/releases', '--entry apps/baink/review-broker/', `--from ${X} --to ${Y}`, '--settle 20'])
    assert.ok(helper.includes(part), part);
  assert.ok(good.calls.some(([c, a]) => c === 'ssh' && a.at(-1).includes(`/opt/uain-broker/releases/${Y}/source-manifest.json`)));
  live = X;
  const bad = host([[has('systemctl show -p ExecStart'), status(X)], [has('switch-release.py unit'), ok('{}')]]);
  const refused = await run(['promote', '--component', 'private-review-broker', '--release', Y, '--expected-prior', X, '--yes', '--json'], bad.deps);
  assert.equal(refused.code, 2);
  assert.equal(refused.json.failures[0].code, 'local_verification_failed');
  assert.ok(!bad.calls.some(([c, a]) => c === 'ssh' && a.at(-1).includes('switch-release.py unit')));
});

test('central-reviewer needs --part; promote refuses a release that is not retained', async () => {
  const { deps } = host([[has('readlink') , ok('')], [has('systemctl show'), ok(`exec=/opt/uain-central-reviewer/releases/${X}/ops/custody/ \npresent=0\n`)]]);
  const missing = await run(['promote', '--component', 'central-reviewer', '--release', Y, '--expected-prior', X, '--yes'], deps);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /part_required/);
  const r = await run(['promote', '--component', 'central-reviewer', '--part', 'custody', '--release', Y, '--expected-prior', X, '--yes', '--json'], deps);
  assert.equal(r.code, 2);
  assert.equal(r.json.failures[0].code, 'local_verification_failed');
});

test('symlink arguments carry the lock, timer pause, idle wait and check unit', () => {
  const spec = COMPONENTS.organizations;
  const args = switchArgs(spec, spec.parts.current, X, A, true).join(' ');
  for (const part of ['symlink --link /opt/uain-organizations/current', '--lock /opt/uain-organizations/.release.lock', '--pause-timer uain-survey-attester.timer', '--idle-unit uain-survey-attester.service', '--check-unit uain-survey-attester.service', `--from ${X} --to ${A} --yes`])
    assert.ok(args.includes(part), part);
});

test('private payment promote refuses a stage path that is not the staging script output', async () => {
  const { deps, calls } = host([]);
  const r = await run(['promote', '--component', 'private-payment-service', '--release-dir', '/tmp/x; rm -rf /', '--expected-prior', X, '--yes', '--json'], deps);
  assert.equal(r.code, 2);
  assert.equal(r.json.failures[0].code, 'invalid_stage');
  assert.equal(calls.length, 0);
});

test('private payment promote runs the installer dry run, then --yes, and confirms the source', async () => {
  let source = X;
  const status = () => ok(`source=${source}\nservice=${'3'.repeat(64)}\ndispatch=${'4'.repeat(64)}\n`);
  const { deps, calls } = host([
    [(s) => s.endsWith('--yes') && s.includes('install_private_payment_release.py'), () => { source = Y; return ok('{"plan":1}\n' + JSON.stringify({ installed: true, backup: '/var/backups/uain-custody/p', health: 'ready', height: 9 })); }],
    [has('install_private_payment_release.py'), ok(JSON.stringify({ release: `/opt/uain-private-payment-service/releases/${Y}`, serviceSha256: '5'.repeat(64), changedSources: ['apps/baink/review-broker/reviewer-worker.mjs'] }, null, 1) + '\ndry run: nothing changed\n')],
    [has('private-payment-service.json'), status],
  ]);
  const r = await run(['promote', '--component', 'private-payment-service', '--release-dir', '/root/private-payment-stage-AbC123', '--expected-prior', X, '--yes', '--json'], deps);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.release, Y);
  assert.equal(r.json.outcome, 'completed');
  const install = calls.filter(([, a]) => String(a.at(-1)).includes('install_private_payment_release.py'));
  assert.equal(install.length, 2);
  assert.ok(install[0][1].at(-1).endsWith(`${'3'.repeat(64)} ${'4'.repeat(64)}`));
});

test('private payment rollback rebuilds a stage, uploads the checkout installer and installs it', async () => {
  const INSTALLER_SHA = sha256(readFileSync(new URL('../custody/install_private_payment_release.py', import.meta.url)));
  let source = Y;
  const stage = '/root/private-payment-stage-RoLLbAcK';
  const { deps, calls } = host([
    [(s, c) => c === 'ssh' && s.includes('mktemp -d /root/private-payment-stage-'), ok(`stage=${stage}\n`)],
    [(s, c) => c === 'ssh' && s.startsWith('chown root:root ' + stage), ok(INSTALLER_SHA + '\n')],
    [(s) => s.endsWith('--yes') && s.includes('install_private_payment_release.py'), () => { source = X; return ok(JSON.stringify({ installed: true, backup: '/var/backups/uain-custody/p', health: 'ready', height: 9 })); }],
    [(s, c) => c === 'ssh' && s.includes(`cd ${stage} &&`), ok(JSON.stringify({ release: `/opt/uain-private-payment-service/releases/${X}`, serviceSha256: '5'.repeat(64), changedSources: [] }) + '\ndry run: nothing changed\n')],
    [has('private-payment-service.json'), () => ok(`source=${source}\nservice=${'3'.repeat(64)}\ndispatch=${'4'.repeat(64)}\npresent=1\nbackup=/var/backups/uain-custody/private-payment-release-20261109T174940Z\n`)],
  ]);
  const r = await run(['rollback', '--component', 'private-payment-service', '--release', X, '--expected-current', Y, '--yes', '--json'], deps);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.outcome, 'completed');
  assert.equal(r.json.rollback.state, 'switched');
  const staging = calls.find(([c, a]) => c === 'ssh' && a.at(-1).includes('mktemp -d /root/private-payment-stage-'))[1].at(-1);
  assert.ok(!staging.includes('/opt/uain-custody/install_private_payment_release.py'), 'no host installer path');
  const upload = calls.find(([c]) => c === 'scp');
  assert.ok(upload[1].at(-2).endsWith('ops/custody/install_private_payment_release.py'));
  assert.equal(upload[1].at(-1), `uain-app-1:${stage}/install_private_payment_release.py`);
});

test('private payment rollback refuses when the uploaded installer hash differs', async () => {
  const stage = '/root/private-payment-stage-RoLLbAcK';
  const { deps, calls } = host([
    [(s, c) => c === 'ssh' && s.includes('mktemp -d /root/private-payment-stage-'), ok(`stage=${stage}\n`)],
    [(s, c) => c === 'ssh' && s.startsWith('chown root:root ' + stage), ok('0'.repeat(64) + '\n')],
    [has('private-payment-service.json'), ok(`source=${Y}\nservice=${'3'.repeat(64)}\ndispatch=${'4'.repeat(64)}\npresent=1\nbackup=/var/backups/uain-custody/private-payment-release-20261109T174940Z\n`)],
  ]);
  const r = await run(['rollback', '--component', 'private-payment-service', '--release', X, '--expected-current', Y, '--yes', '--json'], deps);
  assert.equal(r.code, 2);
  assert.equal(r.json.failures[0].code, 'staging_mismatch');
  assert.ok(!calls.some(([c, a]) => c === 'ssh' && String(a.at(-1)).includes('install_private_payment_release.py ' + stage)));
});

test('private payment failed install with prior restored is an automatic rollback', async () => {
  const status = () => ok(`source=${X}\nservice=${'3'.repeat(64)}\ndispatch=${'4'.repeat(64)}\n`);
  const { deps } = host([
    [(s) => s.endsWith('--yes'), { code: 1, stdout: '', stderr: 'install refused: health check failed after install; previous service restored' }],
    [has('install_private_payment_release.py'), ok(JSON.stringify({ release: `/opt/uain-private-payment-service/releases/${Y}`, serviceSha256: '5'.repeat(64), changedSources: [] }) + '\ndry run: nothing changed\n')],
    [has('private-payment-service.json'), status],
  ]);
  const r = await run(['promote', '--component', 'private-payment-service', '--release-dir', '/root/private-payment-stage-AbC123', '--expected-prior', X, '--yes', '--json'], deps);
  assert.equal(r.code, 1);
  assert.equal(r.json.rollback.state, 'automatic');
});

test('native chain verifies a binary hash and refuses promote and rollback', async () => {
  const { deps, calls } = host([]);
  deps.readFile = async () => Buffer.from('uaind');
  const good = await run(['verify', '--component', 'native-chain', '--archive', '/x/uaind', '--sha256', sha256(Buffer.from('uaind')), '--json'], deps);
  assert.equal(good.code, 0);
  const bad = await run(['verify', '--component', 'native-chain', '--archive', '/x/uaind', '--sha256', '0'.repeat(64), '--json'], deps);
  assert.equal(bad.code, 1);
  for (const cmd of ['promote', 'rollback']) {
    const r = await run([cmd, '--component', 'native-chain', '--yes', '--json'], deps);
    assert.equal(r.code, 2);
    assert.equal(r.json.failures[0].code, 'not_supported');
  }
  assert.equal(calls.length, 0);
});

test('adapter plans are read-only: only git and public probes', async () => {
  for (const name of Object.keys(COMPONENTS).filter((n) => COMPONENTS[n].kind)) {
    const { deps, calls } = host([]);
    const plan = await adapterPlan(COMPONENTS[name], { root: REPO_ROOT, part: 'worker' }, deps);
    assert.equal(plan.target.component, name);
    assert.ok(plan.actions.length >= 3);
    assert.ok(calls.every(([c]) => c === 'git'), name);
  }
});

test('the baink component keeps its own path and command line', async () => {
  assert.equal(COMPONENTS.baink.kind, undefined);
  const { deps, calls } = host([]);
  const r = await run(['rollback', '--component', 'baink', '--release', '20261106T095448Z-3bfb533803', '--expected-current', '20261106T104129Z-bf251ab148', '--json'], deps);
  assert.equal(r.json.outcome, 'dry-run');
  assert.match(r.json.rollback.command, /baink-rollback-release\.py/);
  assert.equal(calls.length, 0);
});
