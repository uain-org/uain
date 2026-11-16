// Status, promote and rollback over the existing trusted BAINK helpers.
// activate-release.py owns locking, backups, the service restart and its own
// failure rollback; this layer only validates, stages, invokes and reconciles.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './archive.mjs';
import { RELEASE_ID, component, environment } from './components.mjs';
import { commands } from './plan.mjs';
import { fail, newReport, refuse } from './report.mjs';
import { redact } from './runner.mjs';
import { verifyRelease } from './verify.mjs';

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const tail = (text, env) =>
  redact(
    String(text ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' / '),
    env,
  ).slice(0, 400);

/** Read-only remote probe; every interpolated value is a validated release id. */
export function remoteStatusScript(spec, { release, prior } = {}) {
  for (const id of [release, prior])
    if (id && !RELEASE_ID.test(id)) throw new Error('Invalid release id.');
  const lines = [
    `c=$(readlink -f ${spec.currentLink}); echo "current=\${c##*/}"`,
    `echo "service=$(systemctl is-active ${spec.service} 2>/dev/null)"`,
  ];
  if (release) {
    const staging = `${spec.stagingRoot}/${release}`;
    lines.push(
      `if [ -d ${staging} ]; then echo staged=1; else echo staged=0; fi`,
      `if [ -f ${staging}/release.tar.gz ]; then echo "archive=$(sha256sum ${staging}/release.tar.gz | cut -c1-64)"; else echo archive=; fi`,
      `if [ -f ${staging}/activate-release.py ]; then echo "helper=$(sha256sum ${staging}/activate-release.py | cut -c1-64)"; else echo helper=; fi`,
      `if [ -e ${spec.releasesRoot}/${release} ]; then echo extracted=1; else echo extracted=0; fi`,
    );
  }
  if (prior)
    lines.push(
      `if [ -f ${spec.releasesRoot}/${prior}/release-manifest.json ]; then echo priorRetained=1; else echo priorRetained=0; fi`,
    );
  return lines.join('; ');
}

const ssh = (deps, spec, script) =>
  deps.spawn('ssh', ['-o', 'BatchMode=yes', spec.host, script]);
const scp = (deps, spec, from, to) =>
  deps.spawn('scp', ['-q', '-o', 'BatchMode=yes', from, `${spec.host}:${to}`]);

export async function readRemote(deps, spec, ids) {
  const result = await ssh(deps, spec, remoteStatusScript(spec, ids));
  if (result.code !== 0)
    return { ok: false, error: tail(result.stderr, deps.env) };
  const values = { ok: true };
  for (const line of result.stdout.split('\n')) {
    const match = /^([a-zA-Z]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export async function readPublic(deps, spec) {
  const out = {};
  for (const [name, env] of Object.entries(spec.environments)) {
    const probe = await deps.fetch(env.health, spec.releaseHeader);
    out[name] = {
      release: probe.release ?? null,
      healthy: probe.status === 200 && probe.body?.ok === true,
      status: probe.status,
    };
  }
  return out;
}

const publicDetail = (live) =>
  Object.entries(live)
    .map(
      ([name, v]) =>
        `${name} ${v.release ?? 'no release header'} health ${v.healthy ? 'ok' : 'FAIL(' + v.status + ')'}`,
    )
    .join(', ');

async function publicVerify(report, deps, spec, release) {
  const attempts = deps.attempts ?? 10;
  let live;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    live = await readPublic(deps, spec);
    if (Object.values(live).every((v) => v.release === release && v.healthy)) {
      report.public = { state: 'passed', detail: publicDetail(live) };
      report.staging = { state: 'passed', detail: `preview serves ${release}` };
      return true;
    }
    if (attempt < attempts) await deps.sleep(deps.intervalMs ?? 3000);
  }
  report.public = { state: 'failed', detail: publicDetail(live) };
  if (live.preview?.release !== release)
    report.staging = {
      state: 'failed',
      detail: `preview serves ${live.preview?.release}`,
    };
  fail(
    report,
    'public_verification_failed',
    'Public release header or health did not match.',
  );
  report.followUp.push(
    'Run release:status --remote; do not re-run activation until reconciled.',
  );
  return false;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJournal(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJournal(path, journal, stage, state, deps, extra = {}) {
  journal.stages[stage] = { state, at: deps.now(), ...extra };
  await writeFile(path, JSON.stringify(journal, null, 2) + '\n');
}

export async function status(options, deps) {
  const spec = component(options.component ?? 'baink');
  const report = newReport('status', {
    component: spec.id,
    release: options.release ?? null,
  });
  if (options.release && !RELEASE_ID.test(options.release))
    return refuse(
      report,
      'invalid_release',
      'Release id must match YYYYMMDDTHHMMSSZ-<10 hex>.',
    );
  const live = await readPublic(deps, spec);
  const want = options.release;
  const prod = live.production,
    preview = live.preview;
  report.production = {
    state: !prod.healthy
      ? 'failed'
      : want && prod.release !== want
        ? 'other-release'
        : 'live',
    detail: `${prod.release ?? 'no header'}, health ${prod.healthy ? 'ok' : 'FAIL(' + prod.status + ')'}`,
  };
  report.staging = {
    state: !preview.healthy
      ? 'failed'
      : want && preview.release !== want
        ? 'other-release'
        : 'live',
    detail: `preview ${preview.release ?? 'no header'}, health ${preview.healthy ? 'ok' : 'FAIL(' + preview.status + ')'}`,
  };
  report.public = want
    ? {
        state:
          prod.release === want &&
          preview.release === want &&
          prod.healthy &&
          preview.healthy
            ? 'passed'
            : 'failed',
        detail: `expected ${want}`,
      }
    : { state: 'observed', detail: publicDetail(live) };
  if (options.remote) {
    const remote = await readRemote(deps, spec, { release: want });
    report.remote = remote;
    report.local = { state: 'not-applicable' };
    if (!remote.ok)
      report.followUp.push(`Remote status unavailable: ${remote.error}`);
    else if (remote.current !== prod.release)
      report.followUp.push(
        `Host current ${remote.current} differs from public header ${prod.release}.`,
      );
  }
  report.outcome =
    report.public.state === 'failed' || !prod.healthy ? 'failed' : 'ok';
  return report;
}

export async function promote(options, deps) {
  const spec = component(options.component ?? 'baink');
  const envName = options.environment ?? 'production';
  const report = newReport('promote', {
    component: spec.id,
    environment: envName,
  });
  environment(spec, envName);
  if (spec.environments[envName].sharedActivation)
    return refuse(
      report,
      'shared_activation',
      `${envName} is activated together with production; promote --environment production.`,
    );
  if (!options.yes)
    return refuse(
      report,
      'confirmation_required',
      'Promotion changes production; pass --yes.',
    );
  const prior = options.expectedPrior;
  if (!prior || !RELEASE_ID.test(prior))
    return refuse(
      report,
      'expected_prior_required',
      'Pass --expected-prior <current release id>.',
    );

  // 1. Local qualification. Nothing remote runs unless this passes.
  const verified = await verifyRelease(spec, options);
  report.release = verified.release ?? null;
  report.local = {
    state: verified.ok ? 'passed' : 'failed',
    detail: verified.ok
      ? `${verified.files} files, ${verified.previewFiles} preview files, archive ${verified.archiveSha256}`
      : verified.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.id}: ${c.detail}`)
          .join('; '),
  };
  if (!verified.ok)
    return refuse(
      report,
      'local_verification_failed',
      'Release directory or archive failed verification; nothing was staged.',
    );
  const release = verified.release,
    archiveSha256 = verified.archiveSha256;
  if (release === prior)
    return refuse(
      report,
      'prior_mismatch',
      'Expected prior equals the release being promoted.',
    );
  if (verified.priorRelease && verified.priorRelease !== prior)
    return refuse(
      report,
      'prior_mismatch',
      `Manifest was packaged against ${verified.priorRelease}, not ${prior}.`,
    );

  const journalPath = join(
    dirname(verified.archive),
    `${release}.promote.json`,
  );
  const journal = (await readJournal(journalPath)) ?? {
    release,
    prior,
    archiveSha256,
    stages: {},
  };
  if (journal.release !== release || journal.archiveSha256 !== archiveSha256)
    return refuse(
      report,
      'journal_mismatch',
      `${journalPath} belongs to another release or archive.`,
    );
  const interrupted = journal.stages.activate?.state === 'started';

  // 2. Reconcile live state before any mutation (always, and required to resume).
  const live = await readPublic(deps, spec);
  const remote = await readRemote(deps, spec, { release, prior });
  if (!remote.ok) {
    report.production = { state: 'unknown', detail: remote.error };
    report.outcome = 'unknown';
    return fail(
      report,
      'remote_status_unavailable',
      'Could not read host status; nothing was changed by this run.',
    );
  }
  if (remote.current === release) {
    report.production = {
      state: 'completed',
      detail: `host current is ${release}${interrupted ? ' (reconciled interrupted activation)' : ''}`,
    };
    await writeJournal(journalPath, journal, 'activate', 'completed', deps, {
      reconciled: true,
    });
    report.resumed = true;
    if (await publicVerify(report, deps, spec, release))
      report.outcome = 'completed';
    return report;
  }
  if (remote.current !== prior)
    return refuse(
      report,
      'prior_mismatch',
      `Host current is ${remote.current || 'unknown'}, expected ${prior}.`,
    );
  if (live.production.release !== prior)
    return refuse(
      report,
      'prior_mismatch',
      `Public ${spec.releaseHeader} is ${live.production.release ?? 'missing'}, expected ${prior}.`,
    );
  if (remote.extracted === '1') {
    report.production = {
      state: 'not-changed',
      detail: `${spec.releasesRoot}/${release} exists from an earlier attempt; host still on ${prior}`,
    };
    report.followUp.push(
      `Inspect ${spec.backupRoot}/${release}, then package a new release id; activate-release.py never reuses one.`,
    );
    return refuse(
      report,
      'previous_attempt_left_release',
      'An earlier activation of this release id ran and did not complete.',
    );
  }
  if (interrupted)
    report.followUp.push(
      'Reconciled interrupted activation: host unchanged, release not extracted; re-running activation.',
    );

  // 3. Stage (root-only directory) and upload; both idempotent, staging only.
  const cmd = commands(spec, {
    release,
    archiveSha256,
    prior,
    output: dirname(verified.archive),
  });
  const staging = `${spec.stagingRoot}/${release}`;
  const helperPath = join(options.root ?? REPO_ROOT, spec.activationHelper);
  if (!(await exists(helperPath)))
    return refuse(
      report,
      'helper_missing',
      `${spec.activationHelper} not found.`,
    );
  const helperSha = sha256(await readFile(helperPath));
  if (remote.staged !== '1') {
    const made = await ssh(
      deps,
      spec,
      `install -d -m 700 -o root -g root ${staging}`,
    );
    if (made.code !== 0) {
      report.staging = { state: 'failed', detail: tail(made.stderr, deps.env) };
      return fail(
        report,
        'stage_failed',
        'Could not create the staging directory.',
      );
    }
  }
  if (remote.archive !== archiveSha256) {
    const sent = await scp(
      deps,
      spec,
      verified.archive,
      `${staging}/release.tar.gz`,
    );
    if (sent.code !== 0)
      return fail(report, 'upload_failed', tail(sent.stderr, deps.env));
  }
  if (remote.helper !== helperSha) {
    const sent = await scp(
      deps,
      spec,
      helperPath,
      `${staging}/activate-release.py`,
    );
    if (sent.code !== 0)
      return fail(report, 'upload_failed', tail(sent.stderr, deps.env));
  }
  const staged = await readRemote(deps, spec, { release, prior });
  if (
    !staged.ok ||
    staged.archive !== archiveSha256 ||
    staged.helper !== helperSha ||
    staged.current !== prior
  ) {
    report.staging = {
      state: 'failed',
      detail:
        'staged archive/helper hash or current release differs after upload',
    };
    return refuse(
      report,
      'staging_mismatch',
      'Staged bytes do not match; activation not attempted.',
    );
  }
  report.staging = {
    state: 'staged',
    detail: `${staging} (archive and helper hashes match)`,
  };
  await writeJournal(journalPath, journal, 'stage', 'completed', deps);

  // 4. Activate through the trusted helper. Journal first: an interruption is
  // an unknown outcome that the next run reconciles, never blindly retries.
  await writeJournal(journalPath, journal, 'activate', 'started', deps);
  const activated = await deps.spawn('ssh', [
    '-o',
    'BatchMode=yes',
    spec.host,
    `cd ${staging} && python3 activate-release.py ${release} ${archiveSha256} ${prior}`,
  ]);
  report.production = { command: cmd.activate };
  if (activated.code !== 0) {
    const after = await readRemote(deps, spec, { release, prior });
    if (after.ok && after.current === prior) {
      report.production = {
        state: 'failed',
        detail: 'activation refused or failed; host on prior release',
      };
      report.rollback = {
        state: 'automatic',
        detail: `activate-release.py restored ${prior}`,
      };
      await writeJournal(journalPath, journal, 'activate', 'failed', deps);
      return fail(
        report,
        'activation_failed',
        tail(activated.stderr, deps.env),
      );
    }
    report.outcome = 'unknown';
    report.production = {
      state: 'unknown',
      detail: after.ok ? `host current ${after.current}` : after.error,
    };
    report.followUp.push(
      'Outcome unknown: run release:status --remote and reconcile before any retry.',
    );
    return fail(report, 'activation_unknown', tail(activated.stderr, deps.env));
  }
  let summary = null;
  try {
    summary = JSON.parse(activated.stdout.trim().split('\n').pop());
  } catch {
    summary = null;
  }
  await writeJournal(journalPath, journal, 'activate', 'completed', deps);
  report.production = {
    state: 'activated',
    detail: summary
      ? `version ${summary.version}, healthy ${summary.healthy}, backup ${summary.backup}`
      : 'helper exited 0',
  };

  // 5. Public acceptance of the same release id.
  if (await publicVerify(report, deps, spec, release))
    report.outcome = 'completed';
  report.followUp.push(
    'Record the release in CHANGELOG.md, apps/baink/CHANGELOG.md and remaining_work.md.',
  );
  report.rollback = {
    state: 'available',
    command: commands(spec, { target: prior, expectedCurrent: release })
      .rollback,
  };
  return report;
}

export async function rollback(options, deps) {
  const spec = component(options.component ?? 'baink');
  const report = newReport('rollback', {
    component: spec.id,
    release: options.release ?? null,
  });
  const target = options.release,
    current = options.expectedCurrent;
  if (
    !RELEASE_ID.test(target ?? '') ||
    !RELEASE_ID.test(current ?? '') ||
    target === current
  )
    return refuse(
      report,
      'invalid_release',
      'Pass --release <retained target> and --expected-current <live release>.',
    );
  const command = commands(spec, { target, expectedCurrent: current }).rollback;
  report.rollback = { state: options.yes ? 'pending' : 'dry-run', command };
  report.followUp.push(
    'Rollback switches code and preview pointers only; it never restores state.json, journals or /etc/baink.env. Confirm the target release reads the current state format.',
  );
  if (!options.yes) {
    report.outcome = 'dry-run';
    return report;
  }
  const live = await readPublic(deps, spec);
  const remote = await readRemote(deps, spec, { prior: target });
  if (!remote.ok)
    return fail(report, 'remote_status_unavailable', remote.error);
  if (remote.current !== current || live.production.release !== current)
    return refuse(
      report,
      'current_mismatch',
      `Host ${remote.current}, public ${live.production.release}; expected ${current}.`,
    );
  if (remote.priorRetained !== '1')
    return refuse(
      report,
      'target_not_retained',
      `${spec.releasesRoot}/${target} is not a retained release.`,
    );
  const dir = `${spec.stagingRoot}/rollback`;
  const steps = [
    [
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        spec.host,
        `install -d -m 700 -o root -g root ${dir}`,
      ],
    ],
    [
      'scp',
      [
        '-q',
        '-o',
        'BatchMode=yes',
        join(options.root ?? REPO_ROOT, spec.rollbackHelper),
        `${spec.host}:${dir}/baink-rollback-release.py`,
      ],
    ],
    [
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        spec.host,
        `python3 ${dir}/baink-rollback-release.py ${target} ${current} --yes`,
      ],
    ],
  ];
  for (const [cmd, args] of steps) {
    const result = await deps.spawn(cmd, args);
    if (result.code !== 0) {
      const after = await readRemote(deps, spec, {});
      report.rollback = {
        state:
          after.ok && after.current === current
            ? 'failed-unchanged'
            : 'unknown',
        detail: tail(result.stderr, deps.env),
        command,
      };
      if (report.rollback.state === 'unknown') report.outcome = 'unknown';
      return fail(
        report,
        'rollback_failed',
        'Rollback helper did not complete; see rollback state.',
      );
    }
  }
  report.rollback = {
    state: 'switched',
    detail: `${current} -> ${target}`,
    command,
  };
  report.production = { state: 'rolled-back', detail: target };
  if (await publicVerify(report, deps, spec, target))
    report.outcome = 'completed';
  return report;
}
