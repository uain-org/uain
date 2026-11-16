import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  loadManifest,
  resolveImpact,
  changedPathsFromGit,
  globToRegExp,
} from './impact.mjs';

const manifest = loadManifest();
const allChecks = Object.keys(manifest.checks);
const TARGETS = [
  'web',
  'pilot',
  'waitlist',
  'baink-app',
  'holder',
  'reviewer',
  'organizations',
  'native-chain',
  'private-exchange',
  'worker',
  'operations',
  'contracts',
  'press',
  'research-experiments',
  'docs',
];

test('manifest defines every planned target and only known checks', () => {
  assert.deepEqual(
    Object.keys(manifest.components).sort((a, b) => a.localeCompare(b)),
    [...TARGETS].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(manifest.mode, 'shadow');
  assert.match(manifest.currentGates, /pre-push npm run check/);
  const referenced = [
    ...Object.values(manifest.components).flatMap((c) => c.checks),
    ...manifest.contracts.flatMap((c) => c.checks),
    ...['checks', 'dataChecks', 'executableChecks'].flatMap(
      (k) => manifest.prose[k],
    ),
  ];
  for (const check of referenced)
    assert.ok(manifest.checks[check], `unknown check ${check}`);
  for (const contract of manifest.contracts)
    for (const consumer of contract.consumers)
      assert.ok(manifest.components[consumer], `${contract.id} -> ${consumer}`);
});

test('glob matching', () => {
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('apps/baink/web/README.md'));
  assert.ok(globToRegExp('apps/baink/**').test('apps/baink/web/main.jsx'));
  assert.ok(
    !globToRegExp('ops/custody/central_*.py').test(
      'ops/custody/sub/central_x.py',
    ),
  );
  assert.ok(globToRegExp('compose*.yaml').test('compose.staging.yaml'));
});

test('unknown path selects the conservative fallback: every check and every release target', () => {
  const impact = resolveImpact(
    ['scratch/new-idea.bin', 'apps/baink/web/main.jsx'],
    manifest,
  );
  assert.equal(impact.conservativeFallback, true);
  assert.deepEqual(impact.unknownPaths, ['scratch/new-idea.bin']);
  assert.deepEqual(impact.checks, allChecks);
  const targets = Object.values(manifest.components)
    .map((c) => c.releaseTarget)
    .filter(Boolean);
  const byName = (a, b) => a.localeCompare(b);
  assert.deepEqual(
    [...impact.releaseTargets].sort(byName),
    [...targets].sort(byName),
  );
  assert.ok(
    impact.reasons.some(
      (r) => r.kind === 'unknown' && r.path === 'scratch/new-idea.bin',
    ),
  );
});

test('research/ has owners: the WDBC reference pack is the pilot\'s, experiments are their own', () => {
  const reference = resolveImpact(['research/reference/wdbc/wdbc.data'], manifest);
  assert.equal(reference.conservativeFallback, false);
  assert.deepEqual(reference.components, ['pilot']);
  assert.ok(reference.checks.includes('pilot-suite'));
  const experiment = resolveImpact(['research/covering-29-7-3/search.cpp'], manifest);
  assert.equal(experiment.conservativeFallback, false);
  assert.deepEqual(experiment.components, ['research-experiments']);
  assert.deepEqual(experiment.checks, ['research-experiments']);
});

test('shared lockfile affects all of its consumers', () => {
  const pilotLock = resolveImpact(
    ['services/pilot/package-lock.json'],
    manifest,
  );
  for (const component of ['pilot', 'web'])
    assert.ok(pilotLock.components.includes(component), component);
  for (const check of ['pilot-suite', 'site-build'])
    assert.ok(pilotLock.checks.includes(check), check);
  assert.equal(pilotLock.conservativeFallback, false);

  const goSum = resolveImpact(['chain/go.sum'], manifest);
  assert.deepEqual(goSum.components, ['native-chain', 'private-exchange']);
  assert.deepEqual(goSum.releaseTargets, ['native-chain', 'private-exchange']);

  const root = resolveImpact(['package-lock.json'], manifest);
  assert.ok(root.components.includes('web'));
  assert.ok(root.checks.includes('lint'));
});

test('a change to the frozen final client release selects the signing gate', () => {
  for (const path of [
    'public/worker/uain-worker.mjs',
    'public/worker/follow.mjs',
    'public/worker/wallet-crypto.mjs',
  ]) {
    const impact = resolveImpact([path], manifest);
    assert.ok(impact.checks.includes('worker-signing-gate'), path);
    assert.ok(impact.releaseTargets.includes('worker'), path);
  }
  // Pilot and chain client sources are no longer copied into the download.
  for (const path of ['services/pilot/src/runtime/follow.ts', 'chain/client/signing.mjs']) {
    const impact = resolveImpact([path], manifest);
    assert.ok(!impact.checks.includes('worker-signing-gate'), path);
    assert.ok(!impact.releaseTargets.includes('worker'), path);
  }
  const route = resolveImpact(['services/pilot/src/api/waitlist.ts'], manifest);
  assert.ok(!route.checks.includes('worker-signing-gate'));
  assert.deepEqual(route.releaseTargets, ['web', 'pilot']);
});

test('docs containing executable or generated inputs are not prose-only', () => {
  const prose = resolveImpact(
    ['docs/overview.md', 'apps/baink/docs/release-update.md'],
    manifest,
  );
  assert.equal(prose.proseOnly, true);
  assert.deepEqual(prose.components, ['docs']);
  assert.deepEqual(prose.releaseTargets, []);
  assert.deepEqual(prose.checks, ['docs-validation']);

  const valuation = resolveImpact(
    ['docs/valuation/inputs/alzheimers.json'],
    manifest,
  );
  assert.equal(valuation.proseOnly, false);
  assert.ok(valuation.components.includes('pilot'));
  assert.ok(valuation.checks.includes('pilot-suite'));

  const reviewed = resolveImpact(
    [
      'docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/README.md',
    ],
    manifest,
  );
  assert.equal(reviewed.proseOnly, false);
  assert.ok(reviewed.components.includes('organizations'));

  const script = resolveImpact(['docs/deck/build-decks.mjs'], manifest);
  assert.equal(script.proseOnly, false);
  assert.ok(script.checks.includes('docs-executable'));

  const record = resolveImpact(
    ['docs/baink/implementation-register.json'],
    manifest,
  );
  assert.equal(record.proseOnly, false);
  assert.ok(record.checks.includes('docs-data'));
});

test('disabled native project pilot remains disabled', () => {
  const impact = resolveImpact(
    [
      'apps/baink/web/NativeProjectPilot.jsx',
      'apps/baink/server/native-project-pilot.mjs',
    ],
    manifest,
  );
  assert.equal(impact.disabledFeatures.length, 1);
  const [feature] = impact.disabledFeatures;
  assert.equal(feature.id, 'native-project-pilot');
  assert.equal(feature.flag, 'BAINK_NATIVE_PROJECT_PILOT_ENABLED');
  assert.equal(feature.state, 'disabled');
  assert.deepEqual(impact.releaseTargets, ['baink-app']);
  assert.ok(!JSON.stringify(impact).includes('"enabled"'));
});

test('CI harness change re-qualifies every suite without falling back', () => {
  const impact = resolveImpact(['.github/workflows/deploy.yml'], manifest);
  assert.equal(impact.conservativeFallback, false);
  assert.deepEqual(impact.checks, allChecks);
});

test('central policy across Go, JavaScript and Python selects the cross-policy check', () => {
  for (const path of [
    'chain/federation/central_earning.go',
    'apps/baink/server/funding-policy.mjs',
    'ops/custody/central_fund_manager.py',
  ]) {
    const impact = resolveImpact([path], manifest);
    assert.ok(impact.checks.includes('central-policy-cross'), path);
    for (const component of ['native-chain', 'baink-app', 'organizations'])
      assert.ok(impact.components.includes(component), `${path} ${component}`);
  }
});

test('reverse-proxy and holder codec cross-edges', () => {
  const proxy = resolveImpact(['ops/nginx/docker.conf'], manifest);
  for (const component of ['web', 'pilot', 'waitlist', 'baink-app'])
    assert.ok(proxy.components.includes(component));
  assert.ok(proxy.checks.includes('reverse-proxy'));
  const codec = resolveImpact(['chain/client/private-review.mjs'], manifest);
  for (const target of [
    'holder',
    'baink-app',
    'reviewer',
    'native-chain',
    'private-exchange',
  ])
    assert.ok(codec.releaseTargets.includes(target), target);
  assert.ok(codec.checks.includes('codec-contract'));
});

// Three recent real diffs on main, recorded here so the test does not depend
// on local history; when the commits are present, the lists are re-derived.
const REAL = {
  '20b80f3e': {
    files: [
      'CHANGELOG.md',
      'apps/baink/CHANGELOG.md',
      'apps/baink/package.json',
      'apps/baink/server/app.mjs',
      'apps/baink/server/survey-templates.json',
      'apps/baink/web/CentralEarning.jsx',
      'apps/baink/web/WalletSetup.jsx',
      'apps/baink/web/identity.js',
      'apps/baink/web/main.jsx',
      'apps/baink/web/survey-draft.js',
      'apps/baink/web/survey-draft.test.mjs',
      'docs/baink/context.md',
      'docs/baink/project-organizations-2026-11-06/decisions.md',
      'docs/kenneth/README.md',
      'ops/custody/organization_starter.py',
      'ops/custody/project_organizations.py',
      'ops/custody/survey_attester.py',
      'ops/custody/test_project_organizations.py',
      'ops/custody/uain-organization-starter.service',
      'ops/custody/uain-organization-starter.timer',
      'ops/custody/uain-survey-attester.service',
      'ops/custody/uain-survey-attester.timer',
      'remaining_work.md',
      'services/project-organizations/ops/starter-authority.mjs',
      'services/project-organizations/ops/survey-templates.mjs',
      'services/project-organizations/ops/verify-survey.mjs',
      'services/project-organizations/src/native.mjs',
      'services/project-organizations/src/survey.mjs',
      'services/project-organizations/test/survey.test.mjs',
    ],
    releaseTargets: ['baink-app', 'organizations'],
    mustCheck: [
      'baink-tests',
      'organizations-tests',
      'central-policy-cross',
      'qualification-tests',
      'policy-review',
    ],
    mustNotCheck: [
      'pilot-suite',
      'site-build',
      'worker-signing-gate',
      'native-chain',
      'private-exchange',
    ],
  },
  da2eed63: {
    files: [
      'CHANGELOG.md',
      'CLAUDE.md',
      'docs/baink/context.md',
      'docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/README.md',
      'docs/baink/project-organizations-2026-11-06/decisions.md',
      'docs/baink/project-organizations-2026-11-06/production-runbook.md',
      'docs/baink/project-organizations-2026-11-06/survey-qualification/OPP-00002-live-20261106.json',
      'docs/baink/project-organizations-2026-11-06/survey-qualification/README.md',
      'docs/superpowers/plans/2026-11-06-project-organizations.md',
      'ops/custody/fleet_attestation.py',
      'ops/custody/test_fleet_attestation.py',
      'remaining_work.md',
      'services/central-reviewer/src/worker.mjs',
      'services/project-organizations/ops/qualify-survey-live.mjs',
      'services/project-organizations/src/fund-model.mjs',
      'services/project-organizations/src/leadership.mjs',
      'services/project-organizations/src/scheduler.mjs',
      'services/project-organizations/src/survey-sources.mjs',
      'services/project-organizations/src/survey.mjs',
      'services/project-organizations/src/task-proposal.mjs',
      'services/project-organizations/src/verification.mjs',
      'services/project-organizations/test/fixtures/survey-fixture.mjs',
      'services/project-organizations/test/integration.test.mjs',
      'services/project-organizations/test/leadership.test.mjs',
      'services/project-organizations/test/native-daemon-e2e-stage.mjs',
      'services/project-organizations/test/prior-art.test.mjs',
      'services/project-organizations/test/survey.test.mjs',
      'services/project-organizations/test/task-proposal.test.mjs',
      'services/project-organizations/verifiers/prior-art-survey.mjs',
    ],
    releaseTargets: ['reviewer', 'organizations'],
    mustCheck: [
      'organizations-tests',
      'reviewer-tests',
      'policy-review',
      'docs-data',
    ],
    mustNotCheck: ['pilot-suite', 'site-build', 'baink-tests', 'native-chain'],
  },
  bbf9a5ef: {
    files: [
      'CHANGELOG.md',
      'apps/baink/CHANGELOG.md',
      'apps/baink/docs/release-update.md',
      'apps/baink/test/release-update-browser.mjs',
      'apps/baink/web/CentralEarning.jsx',
      'apps/baink/web/NativeEarning.jsx',
      'apps/baink/web/NativeInstance.jsx',
      'apps/baink/web/NativeMembership.jsx',
      'apps/baink/web/NativeProjectPilot.jsx',
      'apps/baink/web/NativeWallet.jsx',
      'apps/baink/web/PeerWorkspace.jsx',
      'apps/baink/web/ReleaseUpdateNotice.jsx',
      'apps/baink/web/TradePaymentReview.jsx',
      'apps/baink/web/identity.js',
      'apps/baink/web/main.jsx',
      'apps/baink/web/release-busy.js',
      'apps/baink/web/release-update.js',
      'apps/baink/web/release-update.test.mjs',
      'docs/baink/context.md',
      'remaining_work.md',
    ],
    releaseTargets: ['baink-app'],
    mustCheck: ['baink-tests', 'docs-validation'],
    mustNotCheck: [
      'pilot-suite',
      'site-build',
      'organizations-tests',
      'native-chain',
      'worker-signing-gate',
      'holder-tests',
    ],
  },
};

function hasCommit(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

for (const [sha, expected] of Object.entries(REAL)) {
  test(`real diff ${sha} classifies with explanations`, () => {
    if (hasCommit(sha))
      assert.deepEqual(
        changedPathsFromGit(sha).sort((a, b) => a.localeCompare(b)),
        [...expected.files].sort((a, b) => a.localeCompare(b)),
      );
    const impact = resolveImpact(expected.files, manifest);
    assert.equal(impact.conservativeFallback, false);
    assert.equal(impact.proseOnly, false);
    assert.deepEqual(impact.releaseTargets, expected.releaseTargets);
    for (const check of expected.mustCheck)
      assert.ok(impact.checks.includes(check), `${sha} should run ${check}`);
    for (const check of expected.mustNotCheck)
      assert.ok(
        !impact.checks.includes(check),
        `${sha} should not need ${check}`,
      );
    for (const file of expected.files)
      assert.ok(
        impact.reasons.some((r) => r.path === file && r.detail),
        `${sha} explains ${file}`,
      );
  });
}
