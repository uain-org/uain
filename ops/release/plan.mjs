// Read-only, deterministic release planning. Given the same source tree,
// arguments and live release header, the plan is byte-identical. It never
// receives a mutation runner: its spawner is wrapped by readOnlySpawner.
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RELEASE_ID, component, environment } from './components.mjs';
import { readOnlySpawner } from './runner.mjs';

export const PLAN_SCHEMA_VERSION = 1;

async function git(spawn, args, cwd) {
  const result = await spawn('git', args, { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Shell-quoted command text for operators; values are pre-validated tokens. */
export const commands = (
  spec,
  { release, archiveSha256, prior, output, target, expectedCurrent },
) => {
  const staging = `${spec.stagingRoot}/${release}`;
  return {
    stage: `ssh ${spec.host} "install -d -m 700 -o root -g root ${staging}"`,
    upload: `scp ${output}/${release}.tar.gz ${spec.host}:${staging}/release.tar.gz && scp ${spec.activationHelper} ${spec.host}:${staging}/activate-release.py`,
    activate: `ssh ${spec.host} "cd ${staging} && python3 activate-release.py ${release} ${archiveSha256} ${prior}"`,
    rollback: `ssh ${spec.host} "install -d -m 700 -o root -g root ${spec.stagingRoot}/rollback" && scp ${spec.rollbackHelper} ${spec.host}:${spec.stagingRoot}/rollback/ && ssh ${spec.host} "python3 ${spec.stagingRoot}/rollback/baink-rollback-release.py ${target} ${expectedCurrent} --yes"`,
  };
};

export async function buildPlan(options, deps) {
  const spec = component(options.component ?? 'baink');
  const envName = options.environment ?? 'production';
  const env = environment(spec, envName);
  const root = options.root;
  const spawn = readOnlySpawner(deps.spawn);
  const sourceCommit = await git(spawn, ['rev-parse', 'HEAD'], root);
  const tree = await git(spawn, ['rev-parse', `HEAD:${spec.appDir}`], root);
  const porcelain =
    (await git(spawn, ['status', '--porcelain', '--', spec.appDir], root)) ??
    '';
  const diff = porcelain
    ? ((await git(spawn, ['diff', 'HEAD', '--', spec.appDir], root)) ?? '')
    : '';
  const sourceDigest = {
    tree,
    dirty: porcelain.length > 0,
    digest: createHash('sha256')
      .update(`${tree}\n${porcelain}\n${diff}`)
      .digest('hex'),
  };
  const version = JSON.parse(
    await readFile(join(root, spec.appDir, 'package.json'), 'utf8'),
  ).version;

  const live = await deps.fetch(env.health, spec.releaseHeader);
  const expectedPriorRelease = {
    value: RELEASE_ID.test(live.release ?? '') ? live.release : null,
    source: `${spec.releaseHeader} header of ${env.health}`,
    healthOk: live.status === 200 && live.body?.ok === true,
    ...(options.expectedPrior && options.expectedPrior !== live.release
      ? {
          conflict: `--expected-prior ${options.expectedPrior} differs from live ${live.release}`,
        }
      : {}),
  };
  const prior = expectedPriorRelease.value ?? '<EXPECTED_PRIOR_RELEASE>';
  const dir = options.releaseDir ? resolve(options.releaseDir) : null;
  const output =
    options.output ?? (dir ? dirname(dir) : '<repo>/output/baink-YYYY-MM-DD');
  const release = options.release ?? (dir ? basename(dir) : '<RELEASE>');
  let archiveSha256 = options.archiveSha256 ?? null;
  if (!archiveSha256 && RELEASE_ID.test(release))
    try {
      archiveSha256 = (
        await readFile(join(output, release + '.tar.gz.sha256'), 'utf8')
      ).split(/\s+/)[0];
    } catch {
      archiveSha256 = null;
    }
  const cmd = commands(spec, {
    release,
    archiveSha256: archiveSha256 ?? '<ARCHIVE_SHA256>',
    prior,
    output,
    target: prior,
    expectedCurrent: release,
  });
  const app = spec.appDir;
  const versionOk = spec.versionPattern.test(version);

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    sourceCommit,
    sourceDigest,
    target: {
      component: spec.id,
      host: spec.host,
      url: env.url,
      health: env.health,
    },
    environment: envName,
    inputs: {
      version,
      versionAccepted: versionOk,
      node: deps.nodeVersion ?? process.version,
      basePaths: Object.fromEntries(spec.builds.map((b) => [b.outDir, b.base])),
      output,
      release,
    },
    checks: [
      { id: 'app-tests', command: `npm --prefix ${app} test` },
      ...spec.builds.map((b) => ({
        id: b.id,
        command:
          `BAINK_BASE_PATH=${b.base} npm --prefix ${app} run build` +
          (b.outDir === 'dist' ? '' : ` -- --outDir ${b.outDir}`),
      })),
      {
        id: 'release-verify',
        command: `npm run release:verify -- --component ${spec.id} --release-dir ${output}/${release}`,
      },
      {
        id: 'public-acceptance',
        command: `npm run release:status -- --component ${spec.id} --release ${release}`,
      },
    ],
    artifactPaths: {
      builds: spec.builds.map((b) => `${app}/${b.outDir}`),
      releaseDir: `${output}/${release}`,
      archive: `${output}/${release}.tar.gz`,
      archiveSha256: `${output}/${release}.tar.gz.sha256`,
      promoteJournal: `${output}/${release}.promote.json`,
    },
    expectedPriorRelease,
    actions: [
      {
        id: 'build',
        mutates: 'local',
        command: 'see checks build-root, build-preview',
      },
      {
        id: 'package',
        mutates: 'local',
        command: `node ${spec.packager} ${output} ${prior}`,
      },
      {
        id: 'verify',
        mutates: false,
        command: `npm run release:verify -- --component ${spec.id} --release-dir ${output}/${release}`,
      },
      {
        id: 'promote',
        mutates: 'remote',
        command: `npm run release:promote -- --component ${spec.id} --environment production --release-dir ${output}/${release} --expected-prior ${prior} --yes`,
      },
      { id: 'promote.stage', mutates: 'remote-staging', command: cmd.stage },
      { id: 'promote.upload', mutates: 'remote-staging', command: cmd.upload },
      { id: 'promote.activate', mutates: 'production', command: cmd.activate },
      {
        id: 'public-verify',
        mutates: false,
        command: `npm run release:status -- --component ${spec.id} --release ${release}`,
      },
    ],
    mutations: [
      {
        kind: 'service-restart',
        target: spec.service,
        host: spec.host,
        by: 'activate-release.py',
      },
      {
        kind: 'symlink-switch',
        target: spec.currentLink,
        by: 'activate-release.py',
      },
      {
        kind: 'preview-swap',
        target: spec.previewLink,
        by: 'activate-release.py',
        note: 'after primary health passes; there is no separate preview staging tier',
      },
      {
        kind: 'backup',
        target: `${spec.backupRoot}/${release}`,
        by: 'activate-release.py',
      },
      { kind: 'config', change: false, note: '/etc/baink.env is preserved' },
      {
        kind: 'signing',
        change: false,
        note: 'no native or financial signing',
      },
      {
        kind: 'migration',
        change: false,
        note: 'activation does not migrate /var/lib/baink state',
      },
    ],
    notes: [
      ...(env.sharedActivation
        ? [
            'The preview at ' +
              env.url +
              ' is activated together with production; promote only accepts --environment production.',
          ]
        : []),
      ...(versionOk
        ? []
        : [
            `Version ${version} does not match ${spec.versionPattern}; activate-release.py will refuse it.`,
          ]),
      ...(sourceDigest.dirty
        ? [`${app} has uncommitted changes; package from a clean commit.`]
        : []),
    ],
  };
}
