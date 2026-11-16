// Release adapters for the components other than BAINK. BAINK keeps its own
// path (operate.mjs, plan.mjs, verify.mjs); cli.mjs routes a component here
// when its spec has a `kind`.
//
// Every adapter offers the same five commands with the same guarantees:
//   plan     read-only and deterministic: git plus public probes, no ssh.
//   verify   read-only: proves the target release exists where it will run.
//   status   read-only: live release on the host (--remote) and public checks.
//   promote  needs --yes and --expected-prior; refuses unless the host runs
//            exactly that prior; on a failed activation it restores the prior
//            automatically and reports it.
//   rollback a dry run (no host contact) unless --yes; then the same guarded
//            switch, from --expected-current back to --release.
// Every value interpolated into a remote script is a validated id or a fixed
// path from components.mjs, never free text.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './archive.mjs';
import { fail, newReport, refuse } from './report.mjs';
import { readOnlySpawner, redact } from './runner.mjs';

const SWITCH_HELPER = 'ops/release/switch-release.py';

const tail = (text, env) =>
  redact(
    String(text ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' / '),
    env,
  ).slice(0, 400);

const sshArgs = (spec, script) => ['-o', 'BatchMode=yes', spec.host, script];
const ssh = (deps, spec, script) => deps.spawn('ssh', sshArgs(spec, script));

function parseLines(stdout) {
  const out = {};
  for (const line of String(stdout).split('\n')) {
    const match = /^([a-zA-Z0-9_.-]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

function lastJson(stdout) {
  try {
    return JSON.parse(String(stdout).trim().split('\n').pop());
  } catch {
    return null;
  }
}

const idOk = (spec, id) => typeof id === 'string' && spec.releaseId.test(id);

async function publicChecks(deps, spec) {
  const rows = [];
  for (const check of spec.publicChecks ?? []) {
    const probe = await deps.fetch(check.url, check.header ?? 'x-none');
    const ok =
      probe.status === (check.status ?? 200) &&
      (!check.bodyOk || probe.body?.ok === true);
    rows.push({ url: check.url, status: probe.status, ok });
  }
  return rows;
}

async function publicVerify(report, deps, spec) {
  if (!spec.publicChecks?.length) {
    report.public = {
      state: 'not-observable',
      detail: 'no public route reports this component',
    };
    return true;
  }
  const attempts = deps.attempts ?? 10;
  let rows;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    rows = await publicChecks(deps, spec);
    if (rows.every((r) => r.ok)) break;
    if (attempt < attempts) await deps.sleep(deps.intervalMs ?? 3000);
  }
  const detail = rows.map((r) => `${r.url} ${r.status}`).join(', ');
  if (rows.every((r) => r.ok)) {
    report.public = { state: 'passed', detail };
    return true;
  }
  report.public = { state: 'failed', detail };
  fail(report, 'public_verification_failed', 'A public route did not answer.');
  return false;
}

// ---------------------------------------------------------------- k8s images
// The website and the pilot run as images in k3s on uain-app-1, deployed by
// .github/workflows/deploy.yml. A release id is the 40-hex image tag (the
// commit that built it). Promote and rollback set the image of every listed
// workload, wait for the Deployment rollouts, and on a failed rollout set the
// prior tag back. The next deploy.yml run then sees drift from its
// `uain-release` record and deploys in full, which is the safe direction.

function k8sImage(spec, tag) {
  return `${spec.registry}/${spec.image}:${tag}`;
}

export function k8sStatusScript(spec) {
  const lines = [];
  spec.workloads.forEach((w, i) => {
    const path =
      w.type === 'cronjob'
        ? '{range .spec.jobTemplate.spec.template.spec.containers[*]}{.name}={.image}{"\\n"}{end}'
        : '{range .spec.template.spec.containers[*]}{.name}={.image}{"\\n"}{end}';
    lines.push(
      `kubectl -n ${spec.namespace} get ${w.type} ${w.name} -o jsonpath='${path}' | sed 's/^/w${i}./'`,
    );
  });
  return lines.join('; ');
}

async function k8sLive(deps, spec) {
  const result = await ssh(deps, spec, k8sStatusScript(spec));
  if (result.code !== 0)
    return { ok: false, error: tail(result.stderr, deps.env) };
  const values = parseLines(result.stdout);
  const tags = new Set();
  const containers = [];
  spec.workloads.forEach((w, i) => {
    for (const name of w.containers) {
      const image = values[`w${i}.${name}`] ?? '';
      const prefix = `${spec.registry}/${spec.image}:`;
      const tag = image.startsWith(prefix) ? image.slice(prefix.length) : null;
      containers.push({ workload: `${w.type}/${w.name}`, container: name, tag });
      tags.add(tag);
    }
  });
  const only = tags.size === 1 ? [...tags][0] : null;
  return { ok: true, current: only, containers, consistent: tags.size === 1 };
}

export function k8sRegistryScript(spec, tag) {
  return (
    `curl -fsS -o /dev/null -D - -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' ` +
    `http://${spec.registry.replace(/\/.*$/, '')}/v2/${spec.registry.replace(/^[^/]*\//, '')}/${spec.image}/manifests/${tag} | tr -d '\\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: */digest=/p'`
  );
}

export function k8sSetImageScript(spec, tag) {
  const sets = spec.workloads.map(
    (w) =>
      `kubectl -n ${spec.namespace} set image ${w.type}/${w.name} ${w.containers
        .map((c) => `${c}=${k8sImage(spec, tag)}`)
        .join(' ')}`,
  );
  const waits = spec.workloads
    .filter((w) => w.type === 'deployment')
    .map(
      (w) =>
        `kubectl -n ${spec.namespace} rollout status deployment/${w.name} --timeout=${spec.rolloutTimeout ?? '600s'}`,
    );
  return ['set -e', ...sets, ...waits].join('; ');
}

const k8s = {
  async verify(spec, options, deps) {
    const report = newReport('verify', {
      component: spec.id,
      release: options.release ?? null,
    });
    if (!idOk(spec, options.release))
      return refuse(report, 'invalid_release', 'Pass --release <40-hex image tag>.');
    const result = await ssh(deps, spec, k8sRegistryScript(spec, options.release));
    const digest = parseLines(result.stdout).digest;
    if (result.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
      report.local = {
        state: 'failed',
        detail: `${k8sImage(spec, options.release)} not in the registry${result.code ? ': ' + tail(result.stderr, deps.env) : ''}`,
      };
      return fail(report, 'image_missing', 'Image tag not found in the registry.');
    }
    report.local = { state: 'passed', detail: `${k8sImage(spec, options.release)} ${digest}` };
    report.digest = digest;
    report.outcome = 'ok';
    return report;
  },

  async status(spec, options, deps) {
    const report = newReport('status', { component: spec.id, release: options.release ?? null });
    const rows = await publicChecks(deps, spec);
    report.public = {
      state: rows.every((r) => r.ok) ? 'passed' : 'failed',
      detail: rows.map((r) => `${r.url} ${r.status}`).join(', '),
    };
    if (options.remote) {
      const live = await k8sLive(deps, spec);
      report.remote = live;
      report.production = live.ok
        ? {
            state: !live.consistent
              ? 'mixed'
              : options.release && live.current !== options.release
                ? 'other-release'
                : 'live',
            detail: live.containers.map((c) => `${c.workload}:${c.container}=${c.tag}`).join(', '),
          }
        : { state: 'unknown', detail: live.error };
    }
    report.outcome =
      report.public.state === 'failed' || ['unknown', 'mixed', 'other-release'].includes(report.production.state)
        ? 'failed'
        : 'ok';
    return report;
  },

  async promote(spec, options, deps) {
    return k8sSwitch(spec, options, deps, 'promote', options.expectedPrior);
  },

  async rollback(spec, options, deps) {
    return k8sSwitch(spec, options, deps, 'rollback', options.expectedCurrent);
  },
};

async function k8sSwitch(spec, options, deps, command, prior) {
  const target = options.release;
  const report = newReport(command, { component: spec.id, release: target ?? null, environment: 'production' });
  const flag = command === 'promote' ? '--expected-prior' : '--expected-current';
  if (!idOk(spec, target) || !idOk(spec, prior) || target === prior)
    return refuse(report, command === 'promote' ? 'expected_prior_required' : 'invalid_release',
      `Pass --release <40-hex tag> and ${flag} <live 40-hex tag>.`);
  const cmd = `ssh ${spec.host} "${k8sSetImageScript(spec, target)}"`;
  if (command === 'rollback') {
    report.rollback = { state: options.yes ? 'pending' : 'dry-run', command: cmd };
    report.followUp.push('Rollback changes images only; it never restores the database, secrets or native state.');
    if (!options.yes) {
      report.outcome = 'dry-run';
      return report;
    }
  } else if (!options.yes)
    return refuse(report, 'confirmation_required', 'Promotion changes production; pass --yes.');

  const verified = await k8s.verify(spec, { release: target }, deps);
  report.local = verified.local;
  if (verified.outcome !== 'ok')
    return refuse(report, 'local_verification_failed', 'Target image is not in the registry; nothing changed.');
  const live = await k8sLive(deps, spec);
  if (!live.ok) {
    report.outcome = 'unknown';
    return fail(report, 'remote_status_unavailable', live.error);
  }
  if (live.consistent && live.current === target) {
    report.production = { state: 'completed', detail: `every container already runs ${target}` };
    report.resumed = true;
    if (await publicVerify(report, deps, spec)) report.outcome = 'completed';
    return report;
  }
  if (!live.consistent || live.current !== prior)
    return refuse(report, command === 'promote' ? 'prior_mismatch' : 'current_mismatch',
      `Live tags ${[...new Set(live.containers.map((c) => c.tag))].join(', ')}; expected ${prior}.`);

  const switched = await ssh(deps, spec, k8sSetImageScript(spec, target));
  if (switched.code !== 0) {
    const back = await ssh(deps, spec, k8sSetImageScript(spec, prior));
    const after = await k8sLive(deps, spec);
    if (back.code === 0 && after.ok && after.consistent && after.current === prior) {
      report.production = { state: 'failed', detail: `rollout of ${target} did not complete; images set back to ${prior}` };
      report.rollback = { state: 'automatic', detail: `restored ${prior}` };
      return fail(report, 'activation_failed', tail(switched.stderr, deps.env));
    }
    report.outcome = 'unknown';
    report.production = { state: 'unknown', detail: after.ok ? after.containers.map((c) => c.tag).join(', ') : after.error };
    report.followUp.push('Outcome unknown: run release:status --remote and reconcile before any retry.');
    return fail(report, 'activation_unknown', tail(back.stderr || switched.stderr, deps.env));
  }
  report.production = { state: command === 'promote' ? 'activated' : 'rolled-back', detail: `${prior} -> ${target}` };
  if (command === 'rollback') report.rollback = { state: 'switched', detail: `${prior} -> ${target}`, command: cmd };
  if (await publicVerify(report, deps, spec)) report.outcome = 'completed';
  report.followUp.push(
    'deploy.yml compares the next deploy with its uain-release record and deploys in full after a manual switch.',
    'Record the release under docs/releases/uain/ and in CHANGELOG.md.',
  );
  if (command === 'promote')
    report.rollback = { state: 'available', command: `npm run release:rollback -- --component ${spec.id} --release ${prior} --expected-current ${target} --yes` };
  return report;
}

// ------------------------------------------------- unit and symlink switches
// Custody-installed services run from immutable release directories that their
// own installers create. The adapter never builds or uploads a release; it
// switches between retained directories with ops/release/switch-release.py.

function partOf(spec, options) {
  const names = Object.keys(spec.parts ?? {});
  const name = options.part ?? (names.length === 1 ? names[0] : null);
  if (!name || !Object.hasOwn(spec.parts, name))
    throw Object.assign(new Error(`Pass --part ${names.join('|')}.`), { code: 'part_required' });
  return { name, ...spec.parts[name] };
}

export function switchStatusScript(spec, part, release) {
  const lines = [];
  if (spec.kind === 'unit')
    lines.push(
      `echo "exec=$(systemctl show -p ExecStart --value ${part.unit} | grep -o '${spec.releasesRoot}/[0-9a-f]*/${part.entry ?? ''}' | sort -u | tr '\\n' ' ')"`,
      `echo "active=$(systemctl is-active ${part.unit})"`,
      `echo "since=$(systemctl show -p ActiveEnterTimestamp --value ${part.unit})"`,
    );
  else
    lines.push(
      `c=$(readlink -f ${part.link}); echo "current=\${c##*/}"`,
      ...(part.checkUnit ? [`echo "check=$(systemctl show -p Result --value ${part.checkUnit})"`] : []),
    );
  if (release) {
    const dir = `${spec.releasesRoot}/${release}`;
    lines.push(
      `if [ -d ${dir} ] && [ ! -L ${dir} ]; then echo "present=1 owner=$(stat -c %u ${dir}) mode=$(stat -c %a ${dir})"; else echo present=0; fi`,
    );
    if (spec.manifestFile)
      lines.push(
        `m=${spec.manifestFile.replace('<id>', release)}; if [ -f $m ]; then echo "manifest=$(sha256sum $m | cut -c1-64)"; else echo manifest=; fi`,
      );
  }
  return lines.join('; ');
}

async function switchLive(deps, spec, part, release) {
  const result = await ssh(deps, spec, switchStatusScript(spec, part, release));
  if (result.code !== 0) return { ok: false, error: tail(result.stderr, deps.env) };
  const v = parseLines(result.stdout);
  const fields = {};
  for (const token of String(v.present ?? '').split(/\s+/).slice(1)) {
    const [k, val] = token.split('=');
    fields[k] = val;
  }
  let current = v.current ?? null;
  if (spec.kind === 'unit') {
    const ids = (v.exec ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p.slice(spec.releasesRoot.length + 1).split('/')[0])
      .filter((id) => spec.releaseId.test(id));
    current = ids.length === 1 ? ids[0] : null;
    v.ids = ids;
  }
  return {
    ok: true,
    current,
    ids: v.ids,
    active: v.active,
    since: v.since,
    check: v.check,
    present: String(v.present ?? '').startsWith('1'),
    owner: fields.owner,
    mode: fields.mode,
    manifest: v.manifest,
  };
}

export function switchArgs(spec, part, from, to, yes) {
  const args =
    spec.kind === 'unit'
      ? ['unit', '--unit', part.unit, '--unit-file', part.unitFile, '--root', spec.releasesRoot, ...(part.entry ? ['--entry', part.entry] : [])]
      : [
          'symlink', '--link', part.link, '--root', spec.releasesRoot,
          ...(part.lock ? ['--lock', part.lock] : []),
          ...(part.pauseTimers ?? []).flatMap((t) => ['--pause-timer', t]),
          ...(part.idleUnits ?? []).flatMap((u) => ['--idle-unit', u]),
          ...(part.checkUnit ? ['--check-unit', part.checkUnit] : []),
        ];
  args.push('--from', from, '--to', to);
  if (spec.settle != null && spec.kind === 'unit') args.push('--settle', String(spec.settle));
  if (spec.backupDir && spec.kind === 'unit') args.push('--backup-dir', spec.backupDir);
  if (spec.systemctl) args.push('--systemctl', spec.systemctl);
  if (yes) args.push('--yes');
  return args;
}

const helperDir = (spec) => spec.helperDir ?? `/var/lib/uain-release/${spec.id}`;

function verifyReport(spec, options, live, report) {
  const problems = [];
  if (!live.present) problems.push(`${spec.releasesRoot}/${options.release} is not a retained directory`);
  if (live.present && live.owner !== '0') problems.push(`owner uid ${live.owner}, not root`);
  if (live.present && /[2367]$|[2367].$/.test(live.mode ?? '')) problems.push(`mode ${live.mode} is group or world writable`);
  let manifest = 'no manifest file; id not checked against content';
  if (spec.manifestFile && live.manifest) {
    if (live.manifest !== options.release) problems.push(`manifest sha256 ${live.manifest} differs from the id`);
    else manifest = 'manifest sha256 equals the id';
  }
  report.local = problems.length
    ? { state: 'failed', detail: problems.join('; ') }
    : { state: 'passed', detail: `${spec.releasesRoot}/${options.release} retained, root-owned; ${manifest}` };
  return problems;
}

const switching = {
  async verify(spec, options, deps) {
    const report = newReport('verify', { component: spec.id, release: options.release ?? null });
    if (!idOk(spec, options.release))
      return refuse(report, 'invalid_release', 'Pass --release <release id>.');
    const part = partOf(spec, options);
    const live = await switchLive(deps, spec, part, options.release);
    if (!live.ok) {
      report.outcome = 'unknown';
      return fail(report, 'remote_status_unavailable', live.error);
    }
    const problems = verifyReport(spec, options, live, report);
    if (problems.length) return fail(report, 'release_missing', problems.join('; '));
    report.outcome = 'ok';
    return report;
  },

  async status(spec, options, deps) {
    const report = newReport('status', { component: spec.id, release: options.release ?? null });
    report.public = { state: 'not-observable', detail: 'no public route reports this component' };
    if (spec.publicChecks?.length) {
      const rows = await publicChecks(deps, spec);
      report.public = { state: rows.every((r) => r.ok) ? 'passed' : 'failed', detail: rows.map((r) => `${r.url} ${r.status}`).join(', ') };
    }
    if (options.remote) {
      report.parts = {};
      for (const name of Object.keys(spec.parts)) {
        const part = partOf(spec, { part: name });
        const live = await switchLive(deps, spec, part);
        report.parts[name] = live;
      }
      const states = Object.entries(report.parts).map(([name, live]) =>
        live.ok ? `${name} ${live.current ?? (live.ids?.join('+') || 'unknown')}${live.active ? ' ' + live.active : ''}` : `${name} unavailable`);
      report.production = { state: 'observed', detail: states.join(', ') };
      if (options.release) {
        const part = partOf(spec, options);
        report.production.state = report.parts[part.name]?.current === options.release ? 'live' : 'other-release';
      }
    }
    report.outcome = report.public.state === 'failed' || report.production.state === 'other-release' ? 'failed' : 'ok';
    return report;
  },

  async promote(spec, options, deps) {
    return switchRelease(spec, options, deps, 'promote', options.expectedPrior);
  },

  async rollback(spec, options, deps) {
    return switchRelease(spec, options, deps, 'rollback', options.expectedCurrent);
  },
};

async function switchRelease(spec, options, deps, command, prior) {
  const target = options.release;
  const part = partOf(spec, options);
  const report = newReport(command, { component: spec.id, release: target ?? null, environment: 'production', part: part.name });
  const flag = command === 'promote' ? '--expected-prior' : '--expected-current';
  if (!idOk(spec, target) || !idOk(spec, prior) || target === prior)
    return refuse(report, command === 'promote' ? 'expected_prior_required' : 'invalid_release',
      `Pass --release <id> and ${flag} <live id>.`);
  const dir = helperDir(spec);
  const remoteArgs = switchArgs(spec, part, prior, target, true);
  const cmd = `ssh ${spec.host} "${spec.python ?? 'python3'} ${dir}/switch-release.py ${remoteArgs.join(' ')}"`;
  if (command === 'rollback') {
    report.rollback = { state: options.yes ? 'pending' : 'dry-run', command: cmd };
    report.followUp.push('Rollback switches code only; it never restores state, configuration, keys or native state.');
    if (!options.yes) {
      report.outcome = 'dry-run';
      return report;
    }
  } else if (!options.yes)
    return refuse(report, 'confirmation_required', 'Promotion changes production; pass --yes.');

  const live = await switchLive(deps, spec, part, target);
  if (!live.ok) {
    report.outcome = 'unknown';
    return fail(report, 'remote_status_unavailable', live.error);
  }
  if (verifyReport(spec, { release: target }, live, report).length)
    return refuse(report, 'local_verification_failed', 'Target release is not retained on the host; nothing changed.');
  if (live.current === target) {
    report.production = { state: 'completed', detail: `${part.name} already runs ${target}` };
    report.resumed = true;
    if (await publicVerify(report, deps, spec)) report.outcome = 'completed';
    return report;
  }
  if (live.current !== prior)
    return refuse(report, command === 'promote' ? 'prior_mismatch' : 'current_mismatch',
      `Host runs ${live.current ?? (live.ids?.join(', ') || 'unknown')}, expected ${prior}.`);

  const helperPath = join(options.root, SWITCH_HELPER);
  const helperSha = sha256(await readFile(helperPath));
  const staged = await ssh(deps, spec,
    `install -d -m 700 -o root -g root ${dir} && if [ -f ${dir}/switch-release.py ]; then sha256sum ${dir}/switch-release.py | cut -c1-64; fi`);
  if (staged.code !== 0) return fail(report, 'stage_failed', tail(staged.stderr, deps.env));
  if (staged.stdout.trim() !== helperSha) {
    const sent = await deps.spawn('scp', ['-q', '-o', 'BatchMode=yes', helperPath, `${spec.host}:${dir}/switch-release.py`]);
    if (sent.code !== 0) return fail(report, 'upload_failed', tail(sent.stderr, deps.env));
    const check = await ssh(deps, spec, `sha256sum ${dir}/switch-release.py | cut -c1-64`);
    if (check.stdout.trim() !== helperSha)
      return refuse(report, 'staging_mismatch', 'Uploaded helper hash differs; nothing switched.');
  }
  report.staging = { state: 'staged', detail: `${dir}/switch-release.py ${helperSha.slice(0, 12)}` };

  const ran = await ssh(deps, spec, `${spec.python ?? 'python3'} ${dir}/switch-release.py ${remoteArgs.join(' ')}`);
  const summary = lastJson(ran.stdout) ?? {};
  report.production = { command: cmd };
  if (ran.code === 2) {
    report.production = { state: 'not-changed', detail: summary.detail ?? tail(ran.stderr, deps.env) };
    return refuse(report, 'helper_refused', summary.detail ?? 'switch-release.py refused');
  }
  if (ran.code === 1) {
    report.production = { state: 'failed', detail: summary.detail ?? 'activation failed' };
    report.rollback = { state: 'automatic', detail: `switch-release.py restored ${prior}` };
    return fail(report, 'activation_failed', summary.detail ?? tail(ran.stderr, deps.env));
  }
  if (ran.code !== 0) {
    report.outcome = 'unknown';
    report.production = { state: 'unknown', detail: summary.detail ?? tail(ran.stderr, deps.env) };
    report.followUp.push('Outcome unknown: run release:status --remote and reconcile before any retry.');
    return fail(report, 'activation_unknown', summary.detail ?? tail(ran.stderr, deps.env));
  }
  const after = await switchLive(deps, spec, part);
  if (!after.ok || after.current !== target) {
    report.outcome = 'unknown';
    report.production = { state: 'unknown', detail: `helper exited 0 but host reports ${after.current ?? after.error}` };
    return fail(report, 'activation_unknown', 'Host state after the switch does not match.');
  }
  report.production = {
    state: command === 'promote' ? 'activated' : 'rolled-back',
    detail: `${part.name} ${prior} -> ${target}${summary.backup ? ', unit backup ' + summary.backup : ''}`,
  };
  if (command === 'rollback') report.rollback = { state: 'switched', detail: `${prior} -> ${target}`, command: cmd };
  else
    report.rollback = {
      state: 'available',
      command: `npm run release:rollback -- --component ${spec.id}${Object.keys(spec.parts).length > 1 ? ' --part ' + part.name : ''} --release ${prior} --expected-current ${target} --yes`,
    };
  if (await publicVerify(report, deps, spec)) report.outcome = 'completed';
  report.followUp.push(`Record the release under docs/releases/${spec.recordComponent ?? spec.id}/ and in CHANGELOG.md.`);
  return report;
}

// -------------------------------------------- private payment service (custody)
// The custody installer (ops/custody/install_private_payment_release.py) owns
// staging checks, the service lock, backups, the health check and automatic
// restore. The release id is its source release directory name; the adapter
// guards on it and passes the live service and dispatcher hashes the
// installer re-checks under its lock. Rollback rebuilds a stage from the
// installer's own backup of the target (service, dispatcher, policy) and the
// retained source release, and installs it the same way.

const STAGE_DIR = /^\/root\/private-payment-stage-[A-Za-z0-9]+$/;

export function installerStatusScript(spec, release) {
  const lines = [
    `echo "source=$(${spec.python} -I -c 'import json;print(json.load(open("${spec.policy}"))["source"].rsplit("/",1)[-1])')"`,
    `echo "service=$(sha256sum ${spec.service} | cut -c1-64)"`,
    `echo "dispatch=$(sha256sum ${spec.dispatch} | cut -c1-64)"`,
  ];
  if (release)
    lines.push(
      `if [ -d ${spec.releasesRoot}/${release} ] && [ ! -L ${spec.releasesRoot}/${release} ]; then echo present=1; else echo present=0; fi`,
      `b=$(grep -l '"source": "${spec.releasesRoot}/${release}"' ${spec.backupRoot}/private-payment-release-*/private-payment-service.json 2>/dev/null | sort | tail -1); echo "backup=\${b%/*}"`,
    );
  return lines.join('; ');
}

async function installerLive(deps, spec, release) {
  const result = await ssh(deps, spec, installerStatusScript(spec, release));
  if (result.code !== 0) return { ok: false, error: tail(result.stderr, deps.env) };
  const v = parseLines(result.stdout);
  const valid = (x) => /^[a-f0-9]{64}$/.test(x ?? '');
  if (!valid(v.source) || !valid(v.service) || !valid(v.dispatch))
    return { ok: false, error: 'could not read the live policy source or service hashes' };
  return { ok: true, current: v.source, service: v.service, dispatch: v.dispatch, present: v.present === '1', backup: v.backup || null };
}

export function rollbackStageScript(spec, backup, release) {
  return [
    'set -e',
    `[ "$(${spec.python} -I -c 'import json;print(json.load(open("${backup}/private-payment-service.json"))["source"])')" = "${spec.releasesRoot}/${release}" ]`,
    `s=$(umask 077; mktemp -d /root/private-payment-stage-XXXXXXXX)`,
    `mkdir -p $s/source && cp -a ${spec.releasesRoot}/${release}/. $s/source/ && rm -f $s/source/adoption.json`,
    `cp ${backup}/private_payment_service.py ${backup}/public_review_dispatch.py $s/`,
    `chown -R root:root $s && chmod -R go-rwx $s`,
    'echo "stage=$s"',
  ].join('; ');
}

const installer = {
  async verify(spec, options, deps) {
    const report = newReport('verify', { component: spec.id, release: options.release ?? options.releaseDir ?? null });
    if (options.releaseDir) {
      if (!STAGE_DIR.test(options.releaseDir))
        return refuse(report, 'invalid_stage', 'Stage must be /root/private-payment-stage-<id> from stage_private_payment_release.sh.');
      const live = await installerLive(deps, spec);
      if (!live.ok) return fail(report, 'remote_status_unavailable', live.error);
      const plan = await ssh(deps, spec, `cd ${options.releaseDir} && ${spec.python} -I install_private_payment_release.py ${options.releaseDir} ${live.service} ${live.dispatch}`);
      const parsed = (() => { try { return JSON.parse(plan.stdout.replace(/\ndry run: nothing changed\s*$/, '')); } catch { return null; } })();
      if (plan.code !== 0 || !parsed?.release) {
        report.local = { state: 'failed', detail: tail(plan.stdout + '\n' + plan.stderr, deps.env) };
        return fail(report, 'stage_refused', 'The installer refused the stage in its dry run.');
      }
      report.release = parsed.release.split('/').pop();
      report.local = { state: 'passed', detail: `installer dry run: release ${report.release}, service ${parsed.serviceSha256.slice(0, 12)}, changed ${parsed.changedSources.join(', ') || 'none'}` };
      report.outcome = 'ok';
      return report;
    }
    if (!idOk(spec, options.release))
      return refuse(report, 'invalid_release', 'Pass --release <source release id> or --release-dir <stage>.');
    const live = await installerLive(deps, spec, options.release);
    if (!live.ok) return fail(report, 'remote_status_unavailable', live.error);
    if (!live.present) {
      report.local = { state: 'failed', detail: `${spec.releasesRoot}/${options.release} not retained` };
      return fail(report, 'release_missing', 'Source release not retained.');
    }
    report.local = { state: 'passed', detail: `retained; installer backup ${live.backup ?? 'none (cannot roll back to it)'}` };
    report.outcome = 'ok';
    return report;
  },

  async status(spec, options, deps) {
    const report = newReport('status', { component: spec.id, release: options.release ?? null });
    const rows = await publicChecks(deps, spec);
    report.public = rows.length
      ? { state: rows.every((r) => r.ok) ? 'passed' : 'failed', detail: rows.map((r) => `${r.url} ${r.status}`).join(', ') }
      : { state: 'not-observable' };
    if (options.remote) {
      const live = await installerLive(deps, spec);
      report.remote = live;
      report.production = live.ok
        ? { state: options.release && live.current !== options.release ? 'other-release' : 'live', detail: `source ${live.current}, service ${live.service.slice(0, 12)}, dispatcher ${live.dispatch.slice(0, 12)}` }
        : { state: 'unknown', detail: live.error };
    }
    report.outcome = report.public.state === 'failed' || ['other-release', 'unknown'].includes(report.production.state) ? 'failed' : 'ok';
    return report;
  },

  async promote(spec, options, deps) {
    const report = newReport('promote', { component: spec.id, environment: 'production' });
    if (!options.yes) return refuse(report, 'confirmation_required', 'Promotion changes production; pass --yes.');
    if (!idOk(spec, options.expectedPrior))
      return refuse(report, 'expected_prior_required', 'Pass --expected-prior <live source release id>.');
    if (!STAGE_DIR.test(options.releaseDir ?? ''))
      return refuse(report, 'invalid_stage', 'Pass --release-dir /root/private-payment-stage-<id> (stage_private_payment_release.sh).');
    return installRun(spec, options.releaseDir, options.expectedPrior, report, deps);
  },

  async rollback(spec, options, deps) {
    const report = newReport('rollback', { component: spec.id, release: options.release ?? null });
    const target = options.release, current = options.expectedCurrent;
    if (!idOk(spec, target) || !idOk(spec, current) || target === current)
      return refuse(report, 'invalid_release', 'Pass --release <retained source id> and --expected-current <live source id>.');
    report.rollback = {
      state: options.yes ? 'pending' : 'dry-run',
      command: `rebuild a stage from the newest ${spec.backupRoot}/private-payment-release-*/ whose policy source is ${target}, then install_private_payment_release.py <stage> <live service sha> <live dispatcher sha> --yes`,
    };
    report.followUp.push('Rollback restores the service, dispatcher and policy source only; never the vault, journals or native state.');
    if (!options.yes) {
      report.outcome = 'dry-run';
      return report;
    }
    const live = await installerLive(deps, spec, target);
    if (!live.ok) return fail(report, 'remote_status_unavailable', live.error);
    if (live.current !== current) return refuse(report, 'current_mismatch', `Live source ${live.current}, expected ${current}.`);
    if (!live.present || !live.backup) return refuse(report, 'target_not_retained', `No retained release and installer backup for ${target}.`);
    const staged = await ssh(deps, spec, rollbackStageScript(spec, live.backup, target));
    const stage = parseLines(staged.stdout).stage;
    if (staged.code !== 0 || !STAGE_DIR.test(stage ?? '')) return fail(report, 'stage_failed', tail(staged.stderr, deps.env));
    // The installer is not installed on the host: every stage carries its own
    // copy from the checkout (as stage_private_payment_release.sh does).
    const installerPath = join(options.root, spec.installerSource);
    const installerSha = sha256(await readFile(installerPath));
    const placedAt = `${stage}/install_private_payment_release.py`;
    const sent = await deps.spawn('scp', ['-q', '-o', 'BatchMode=yes', installerPath, `${spec.host}:${placedAt}`]);
    if (sent.code !== 0) return fail(report, 'upload_failed', tail(sent.stderr, deps.env));
    const placed = await ssh(deps, spec, `chown root:root ${placedAt} && chmod 600 ${placedAt} && sha256sum ${placedAt} | cut -c1-64`);
    if (placed.code !== 0 || placed.stdout.trim() !== installerSha)
      return refuse(report, 'staging_mismatch', 'Uploaded installer hash differs; nothing installed.');
    report.staging = { state: 'staged', detail: `${stage} from ${live.backup}, installer ${installerSha.slice(0, 12)}` };
    const result = await installRun(spec, stage, current, report, deps, live);
    if (result.outcome === 'completed') result.rollback = { state: 'switched', detail: `${current} -> ${target}` };
    return result;
  },
};

async function installRun(spec, stage, prior, report, deps, known) {
  const live = known ?? (await installerLive(deps, spec));
  if (!live.ok) {
    report.outcome = 'unknown';
    return fail(report, 'remote_status_unavailable', live.error);
  }
  if (live.current !== prior) return refuse(report, 'prior_mismatch', `Live source ${live.current}, expected ${prior}.`);
  const base = `cd ${stage} && ${spec.python} -I install_private_payment_release.py ${stage} ${live.service} ${live.dispatch}`;
  const dry = await ssh(deps, spec, base);
  let plan = null;
  try { plan = JSON.parse(dry.stdout.replace(/\ndry run: nothing changed\s*$/, '')); } catch { plan = null; }
  const release = plan?.release?.split('/').pop();
  report.release = release ?? null;
  if (dry.code !== 0 || !spec.releaseId.test(release ?? '')) {
    report.local = { state: 'failed', detail: tail(dry.stdout + '\n' + dry.stderr, deps.env) };
    return refuse(report, 'local_verification_failed', 'The installer refused the stage in its dry run; nothing changed.');
  }
  report.local = { state: 'passed', detail: `installer dry run: service ${plan.serviceSha256.slice(0, 12)}, changed ${plan.changedSources.join(', ') || 'none'}` };
  if (release === prior) return refuse(report, 'prior_mismatch', 'The stage builds the live source release; nothing to promote.');
  const ran = await ssh(deps, spec, base + ' --yes');
  const summary = lastJson(ran.stdout);
  const after = await installerLive(deps, spec);
  if (ran.code !== 0 || !summary?.installed) {
    if (after.ok && after.current === prior && after.service === live.service) {
      report.production = { state: 'failed', detail: 'installer refused or its health check failed; prior restored' };
      report.rollback = { state: 'automatic', detail: `installer restored ${prior}` };
      return fail(report, 'activation_failed', tail(ran.stdout + '\n' + ran.stderr, deps.env));
    }
    report.outcome = 'unknown';
    report.production = { state: 'unknown', detail: after.ok ? `source ${after.current}` : after.error };
    return fail(report, 'activation_unknown', tail(ran.stderr || ran.stdout, deps.env));
  }
  if (!after.ok || after.current !== release) {
    report.outcome = 'unknown';
    report.production = { state: 'unknown', detail: 'installer reported success but the live policy source differs' };
    return fail(report, 'activation_unknown', 'Live source does not match the installed release.');
  }
  report.production = { state: 'activated', detail: `source ${prior} -> ${release}, health ${summary.health} at ${summary.height}, backup ${summary.backup}` };
  report.rollback = { state: 'available', command: `npm run release:rollback -- --component ${spec.id} --release ${prior} --expected-current ${release} --yes` };
  if (await publicVerify(report, deps, spec)) report.outcome = 'completed';
  report.followUp.push('Record the release in CHANGELOG.md with the service and dispatcher hashes.');
  return report;
}

// ------------------------------------------------------ native chain (plan only)
// The uaind binary and its validator are activated through the guardian
// handover owned by the chain operators. The command layer only plans and
// verifies a binary; promote and rollback refuse.

const planOnly = {
  async verify(spec, options, deps) {
    const report = newReport('verify', { component: spec.id, release: options.release ?? null });
    if (!options.archive || !/^[a-f0-9]{64}$/.test(options.sha256 ?? ''))
      return refuse(report, 'invalid_input', 'Pass --archive <uaind binary or archive> --sha256 <expected sha256>.');
    let bytes;
    try {
      bytes = await (deps.readFile ?? readFile)(options.archive);
    } catch (error) {
      return fail(report, 'archive_missing', error.message);
    }
    const actual = sha256(bytes);
    report.archiveSha256 = actual;
    report.local = actual === options.sha256
      ? { state: 'passed', detail: `${options.archive} sha256 ${actual}` }
      : { state: 'failed', detail: `sha256 ${actual}, expected ${options.sha256}` };
    if (actual !== options.sha256) return fail(report, 'sha256_mismatch', 'Binary hash differs.');
    report.outcome = 'ok';
    report.followUp.push(`Activation is the guardian handover (${spec.runbook}); release:promote does not run it.`);
    return report;
  },
  async status(spec, options, deps) {
    const report = newReport('status', { component: spec.id });
    const rows = await publicChecks(deps, spec);
    report.public = rows.length
      ? { state: rows.every((r) => r.ok) ? 'passed' : 'failed', detail: rows.map((r) => `${r.url} ${r.status}`).join(', ') }
      : { state: 'not-observable' };
    report.outcome = report.public.state === 'failed' ? 'failed' : 'ok';
    return report;
  },
  async promote(spec) {
    return refuse(newReport('promote', { component: spec.id }), 'not_supported',
      `${spec.id} is plan-and-verify only; activation is the guardian handover (${spec.runbook}).`);
  },
  async rollback(spec) {
    return refuse(newReport('rollback', { component: spec.id }), 'not_supported',
      `${spec.id} is plan-and-verify only; rollback is part of the guardian handover (${spec.runbook}).`);
  },
};

// ------------------------------------------------------------------ plan
// Read-only and deterministic: git (through readOnlySpawner) and public probes.

export async function adapterPlan(spec, options, deps) {
  const spawn = readOnlySpawner(deps.spawn);
  const git = async (args) => {
    const r = await spawn('git', args, { cwd: options.root });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const sourceCommit = await git(['rev-parse', 'HEAD']);
  const trees = {};
  for (const path of spec.sourcePaths ?? []) trees[path] = await git(['rev-parse', `HEAD:${path}`]);
  const porcelain = spec.sourcePaths?.length ? ((await git(['status', '--porcelain', '--', ...spec.sourcePaths])) ?? '') : '';
  const rows = await publicChecks(deps, spec);
  const target = options.release ?? (spec.kind === 'k8s' ? sourceCommit : '<RELEASE>');
  const prior = options.expectedPrior ?? '<EXPECTED_PRIOR_RELEASE>';
  const part = spec.parts ? (() => { try { return partOf(spec, options); } catch { return null; } })() : null;
  const partFlag = spec.parts && Object.keys(spec.parts).length > 1 ? ` --part ${part?.name ?? '<part>'}` : '';
  const base = `--component ${spec.id}${partFlag}`;
  const actions = {
    k8s: () => [
      { id: 'build', mutates: 'remote', command: 'merge to main: deploy.yml builds, pushes and rolls out the changed images' },
      { id: 'verify', mutates: false, command: `npm run release:verify -- ${base} --release ${target}` },
      { id: 'status', mutates: false, command: `npm run release:status -- ${base} --remote` },
      { id: 'promote', mutates: 'production', command: `npm run release:promote -- ${base} --release ${target} --expected-prior ${prior} --yes`, detail: `ssh ${spec.host} "${k8sSetImageScript(spec, target)}"` },
      { id: 'rollback', mutates: 'production', command: `npm run release:rollback -- ${base} --release ${prior} --expected-current ${target} [--yes]` },
    ],
    unit: () => [
      { id: 'install', mutates: 'remote-staging', command: spec.installNote },
      { id: 'verify', mutates: false, command: `npm run release:verify -- ${base} --release ${target}` },
      { id: 'promote', mutates: 'production', command: `npm run release:promote -- ${base} --release ${target} --expected-prior ${prior} --yes` },
      { id: 'rollback', mutates: 'production', command: `npm run release:rollback -- ${base} --release ${prior} --expected-current ${target} [--yes]` },
    ],
    installer: () => [
      { id: 'stage', mutates: 'remote-staging', command: 'ops/custody/stage_private_payment_release.sh <checkout> <changed source path>...' },
      { id: 'verify', mutates: false, command: `npm run release:verify -- ${base} --release-dir <stage>` },
      { id: 'promote', mutates: 'production', command: `npm run release:promote -- ${base} --release-dir <stage> --expected-prior ${prior} --yes` },
      { id: 'rollback', mutates: 'production', command: `npm run release:rollback -- ${base} --release ${prior} --expected-current <new source id> [--yes]` },
    ],
    'plan-only': () => [
      { id: 'build', mutates: 'local', command: spec.buildNote },
      { id: 'verify', mutates: false, command: `npm run release:verify -- ${base} --archive <uaind> --sha256 <expected>` },
      { id: 'activate', mutates: 'production', command: `guardian handover, not this command layer (${spec.runbook})` },
    ],
  };
  actions.symlink = actions.unit;
  return {
    schemaVersion: 1,
    sourceCommit,
    sourceDigest: { trees, dirty: porcelain.length > 0 },
    target: { component: spec.id, kind: spec.kind, host: spec.host ?? null, part: part?.name ?? null },
    environment: 'production',
    inputs: { release: target, expectedPrior: prior },
    publicChecks: rows,
    actions: actions[spec.kind](),
    notes: [
      ...(spec.notes ?? []),
      ...(porcelain ? [`${(spec.sourcePaths ?? []).join(', ')} has uncommitted changes.`] : []),
    ],
  };
}

export const ADAPTERS = { k8s, unit: switching, symlink: switching, installer, 'plan-only': planOnly };

export function adapterFor(spec) {
  const found = ADAPTERS[spec.kind];
  if (!found) throw Object.assign(new Error(`No adapter for kind ${spec.kind}.`), { code: 'unknown_kind' });
  return found;
}
