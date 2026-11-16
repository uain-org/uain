// Fixed component adapters, each with its own trusted executor, never a generic
// shell hook. BAINK (no `kind`) uses operate.mjs/plan.mjs/verify.mjs; every
// other component has a `kind` handled by adapters.mjs. The worker client is
// being retired and has no adapter.
export const RELEASE_ID = /^\d{8}T\d{6}Z-[a-f0-9]{10}$/;
export const SHA256 = /^[a-f0-9]{64}$/;

export const COMPONENTS = {
  baink: {
    id: 'baink',
    appDir: 'apps/baink',
    host: 'universa-and-others-mar-14',
    service: 'baink.service',
    versionPattern: /^0\.3\.\d+$/,
    stagingRoot: '/var/lib/baink-deployments',
    currentLink: '/opt/baink/current',
    releasesRoot: '/opt/baink/releases',
    previewLink: '/var/www/baink-preview/baink',
    backupRoot: '/var/backups/baink',
    packager: 'apps/baink/deploy/package-release.mjs',
    activationHelper: 'apps/baink/deploy/activate-release.py',
    rollbackHelper: 'ops/release/baink-rollback-release.py',
    releaseHeader: 'x-baink-release',
    builds: [
      { id: 'build-root', base: '/', outDir: 'dist' },
      { id: 'build-preview', base: '/baink/', outDir: 'dist-preview' },
    ],
    environments: {
      production: {
        url: 'https://baink.money/',
        health: 'https://baink.money/api/health',
      },
      // The preview is not a separate staging tier: activate-release.py swaps
      // it in the same activation, after the primary health check passes.
      preview: {
        url: 'https://aidollar.money/baink/',
        health: 'https://aidollar.money/baink/api/health',
        sharedActivation: true,
      },
    },
  },
};

const HEX40 = /^[a-f0-9]{40}$/;
const HEX40_OR_64 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UAIN_HOST = 'uain-app-1';
const UAIN_PUBLIC = [
  { url: 'https://uain.global/' },
  { url: 'https://uain.global/api/ready', bodyOk: true },
  { url: 'https://uain.global/network/live' },
];

// k3s on uain-app-1, deployed by .github/workflows/deploy.yml; ids are image tags.
COMPONENTS['uain-web'] = {
  id: 'uain-web',
  kind: 'k8s',
  recordComponent: 'uain',
  host: UAIN_HOST,
  namespace: 'uain',
  registry: '10.98.0.1:5000/uain',
  image: 'web',
  releaseId: HEX40,
  workloads: [{ type: 'deployment', name: 'web', containers: ['web'] }],
  sourcePaths: ['app', 'components', 'lib', 'public'],
  publicChecks: UAIN_PUBLIC.slice(0, 1).concat(UAIN_PUBLIC.slice(2)),
};

COMPONENTS['uain-pilot'] = {
  id: 'uain-pilot',
  kind: 'k8s',
  recordComponent: 'uain',
  host: UAIN_HOST,
  namespace: 'uain',
  registry: '10.98.0.1:5000/uain',
  image: 'pilot',
  releaseId: HEX40,
  workloads: [
    { type: 'deployment', name: 'pilot', containers: ['pilot', 'native-rpc'] },
    { type: 'cronjob', name: 'native-projection', containers: ['native-projection'] },
    { type: 'cronjob', name: 'research-index', containers: ['research-index'] },
  ],
  sourcePaths: ['services/pilot'],
  publicChecks: [
    { url: 'https://uain.global/api/ready', bodyOk: true },
    { url: 'https://uain.global/api/health', bodyOk: true },
    { url: 'https://uain.global/api/descriptor' },
  ],
  notes: ['Rollback changes the pilot image only; database migrations are not reversed.'],
};

// Custody-installed services on uain-app-1. Their own installers create the
// immutable release directories; the adapter switches between retained ones.
COMPONENTS['central-reviewer'] = {
  id: 'central-reviewer',
  kind: 'unit',
  host: UAIN_HOST,
  releaseId: /^[a-f0-9]{64}$/,
  releasesRoot: '/opt/uain-central-reviewer/releases',
  manifestFile: '/opt/uain-central-reviewer/manifest-<id>.json',
  parts: {
    worker: {
      unit: 'uain-central-reviewer.service',
      unitFile: '/etc/systemd/system/uain-central-reviewer.service',
      entry: 'services/central-reviewer/src/',
    },
    custody: {
      unit: 'uain-central-reviewer-custody.service',
      unitFile: '/etc/systemd/system/uain-central-reviewer-custody.service',
      entry: 'ops/custody/',
    },
  },
  settle: 10,
  sourcePaths: ['services/central-reviewer', 'ops/custody'],
  installNote: 'create the release directory with its reviewed installer (for example install_custody.py); this layer never builds one',
  publicChecks: [{ url: 'https://baink.money/api/native/review/health' }],
  notes: ['The worker and the custody server run separate release directories; --part picks one. The worker keeps its pinned Node runtime path.'],
};

// The private payment review broker: one unit, one release directory whose
// name is the sha256 of the source-manifest.json inside it.
COMPONENTS['private-review-broker'] = {
  id: 'private-review-broker',
  kind: 'unit',
  host: UAIN_HOST,
  releaseId: /^[a-f0-9]{64}$/,
  releasesRoot: '/opt/uain-broker/releases',
  manifestFile: '/opt/uain-broker/releases/<id>/source-manifest.json',
  parts: {
    broker: {
      unit: 'uain-private-review-broker.service',
      unitFile: '/etc/systemd/system/uain-private-review-broker.service',
      entry: 'apps/baink/review-broker/',
    },
  },
  settle: 20,
  sourcePaths: ['apps/baink/review-broker', 'apps/baink/review-service', 'apps/baink/server', 'chain/client'],
  installNote: 'create /opt/uain-broker/releases/<id> from the import closure of apps/baink/review-broker/broker.mjs with its source-manifest.json; this layer never builds one',
  publicChecks: [{ url: 'https://baink.money/api/native/review/health' }],
  notes: ['Restart only while the broker has no job in hand; then read available, brokerReady and rootReady from the public health route.'],
};

COMPONENTS.organizations = {
  id: 'organizations',
  kind: 'symlink',
  host: UAIN_HOST,
  releaseId: HEX40_OR_64,
  releasesRoot: '/opt/uain-organizations/releases',
  parts: {
    current: {
      link: '/opt/uain-organizations/current',
      lock: '/opt/uain-organizations/.release.lock',
      pauseTimers: ['uain-survey-attester.timer'],
      idleUnits: ['uain-survey-attester.service'],
      checkUnit: 'uain-survey-attester.service',
    },
  },
  sourcePaths: ['services/project-organizations'],
  installNote: 'create /opt/uain-organizations/releases/<id> with its reviewed release script; this layer never builds one',
  notes: ['The check runs the survey attester once on the new release; a failure switches back.'],
};

COMPONENTS['private-payment-service'] = {
  id: 'private-payment-service',
  kind: 'installer',
  host: UAIN_HOST,
  releaseId: /^[a-f0-9]{64}$/,
  releasesRoot: '/opt/uain-private-payment-service/releases',
  policy: '/etc/uain-custody/private-payment-service.json',
  service: '/opt/uain-custody/private_payment_service.py',
  dispatch: '/opt/uain-custody/public_review_dispatch.py',
  backupRoot: '/var/backups/uain-custody',
  installerSource: 'ops/custody/install_private_payment_release.py',
  python: '/opt/uain-custody/venv/bin/python',
  sourcePaths: ['ops/custody', 'apps/baink/review-broker'],
  publicChecks: [{ url: 'https://baink.money/api/native/review/health' }],
  notes: ['The release id is the source release directory name; the installer owns the lock, backups, health check and automatic restore.'],
};

// Plan and verify only: activation is the guardian handover.
COMPONENTS['native-chain'] = {
  id: 'native-chain',
  kind: 'plan-only',
  releaseId: /^\d+\.\d+\.\d+$/,
  sourcePaths: ['chain'],
  runbook: 'ops/chain/upgrade-consensus-v2-profile.py and the 2-of-3 guardian handover',
  buildNote: 'build uaind from chain/ on uain-app-1 with the pinned Go toolchain',
  publicChecks: [],
  notes: ['The validator is upgraded only through the guardian handover; this layer never stops, replaces or restarts uaind.'],
};

export function component(name) {
  const found = Object.hasOwn(COMPONENTS, name) ? COMPONENTS[name] : null;
  if (!found)
    throw Object.assign(
      new Error(
        `Unknown component ${JSON.stringify(name)}; supported: ${Object.keys(COMPONENTS).join(', ')}.`,
      ),
      { code: 'unknown_component' },
    );
  return found;
}

export function environment(spec, name) {
  const found = Object.hasOwn(spec.environments, name)
    ? spec.environments[name]
    : null;
  if (!found)
    throw Object.assign(
      new Error(
        `Unknown environment ${JSON.stringify(name)}; supported: ${Object.keys(spec.environments).join(', ')}.`,
      ),
      { code: 'unknown_environment' },
    );
  return found;
}
