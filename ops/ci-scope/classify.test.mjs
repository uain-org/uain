import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classify, isProse, ruleFor } from './classify.mjs';

const script = fileURLToPath(new URL('./classify.mjs', import.meta.url));
const only = (result) => Object.entries(result.components).filter(([, v]) => v).map(([k]) => k).sort();
const selected = (result) => Object.entries(result.checks).filter(([, v]) => v).map(([k]) => k).sort();

test('a web-only change selects the web image and never the pilot or waitlist', () => {
  const result = classify(['app/page.tsx', 'components/hero.tsx', 'lib/network/live.ts', 'public/og.png']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), ['web']);
  assert.equal(result.components.pilot, false);
  assert.equal(result.components.waitlist, false);
  assert.equal(result.components.monitoring, false);
  assert.equal(result.checks.site, true);
  assert.equal(result.checks.workerSigning, false);
});

test('a pilot-only change selects the pilot image and its suites', () => {
  const result = classify(['services/pilot/src/api/server.ts']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), ['pilot']);
  assert.equal(result.checks.pilot && result.checks.research && result.checks.reset, true);
});

test('the shared proxy selects the web image and both sides of its contract', () => {
  const result = classify(['ops/nginx/docker.conf']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), ['web']);
  assert.equal(result.checks.site, true);
  assert.equal(result.checks.pilot, true);
});

test('website sources the pilot tests read run the pilot suite too', () => {
  // services/pilot/test/native-onboarding, site-feed, earth-kalki and kalki-status read these.
  for (const path of ['public/llms.txt', 'public/access-guide.md', 'public/native-guide.md', 'public/.well-known/uain.json',
    'lib/network/feed.ts', 'lib/network/format.ts', 'lib/network/api-base.ts', 'lib/observatory/world.ts', 'lib/observatory/kalki-status.ts']) {
    const result = classify([path]);
    assert.equal(result.mode, 'scoped', path);
    assert.deepEqual(only(result), ['web'], path);
    assert.deepEqual(selected(result), ['pilot', 'site'], path);
  }
  // Every such file exists, and each is named in a pilot test: the list cannot rot silently.
  const tests = ['native-onboarding', 'site-feed', 'earth-kalki', 'kalki-status']
    .map((name) => readFileSync(new URL(`../../services/pilot/test/${name}.test.mjs`, import.meta.url), 'utf8')).join('\n');
  for (const name of ['llms.txt', 'access-guide.md', 'native-guide.md', '.well-known/uain.json', 'lib/network/feed.ts',
    'lib/network/format.ts', 'lib/network/api-base.ts', 'lib/observatory/world.ts', 'lib/observatory/kalki-status.ts']) {
    assert.ok(tests.includes(name), `${name} is no longer read by the pilot tests`);
  }
  assert.deepEqual(selected(classify(['lib/network/live.ts'])), ['site']);
});

test('the pilot follower and package files select only the pilot image (the client download no longer copies them)', () => {
  for (const path of [
    'services/pilot/src/runtime/follow.ts',
    'services/pilot/package-lock.json',
    'services/pilot/package.json',
    'services/pilot/tsconfig.json',
  ]) {
    const result = classify([path]);
    assert.equal(result.mode, 'scoped', path);
    assert.deepEqual(only(result), ['pilot'], path);
    assert.equal(result.checks.pilot, true, path);
    assert.equal(result.checks.workerSigning, false, path);
  }
});

test('a production manifest change applies the manifest again and builds no image', () => {
  // The apply rolls out exactly what the manifest change changes. Before 10 November 2026
  // every image was rebuilt and every copy restarted for it.
  for (const path of ['deploy/k8s/production/uain.yaml', 'deploy/k8s/production/render.py',
    'deploy/k8s/production/native-pilot.patch.yaml', 'deploy/k8s/production/prune-images.sh']) {
    const result = classify([path]);
    assert.equal(result.mode, 'full', path);
    assert.deepEqual(only(result), [], path);
    assert.ok(Object.values(result.checks).every(Boolean), path);
    assert.match(result.reason, /machinery changed.*the manifest is applied again; no image is built/, path);
  }
});

test('machinery beside a component change builds that component only', () => {
  const result = classify(['.github/workflows/deploy.yml', 'services/pilot/src/api/server.ts', 'CHANGELOG.md']);
  assert.equal(result.mode, 'full');
  assert.deepEqual(only(result), ['pilot']);
  assert.match(result.reason, /built: pilot$/);
  // What the build itself reads is an input of the images it can change.
  assert.deepEqual(only(classify(['.dockerignore'])), ['pilot', 'web']);
  assert.deepEqual(only(classify(['ops/ci-scope/verify-worker-bundle.mjs'])), ['web']);
  assert.equal(classify(['ops/ci-scope/verify-worker-bundle.mjs']).mode, 'full');
});

test('an unknown path selects everything, even beside known ones', () => {
  for (const unknown of ['newproduct/thing.py', 'README.md', 'services/new-service/main.mjs', 'apps/other/x.js', 'postcss.config.mjs']) {
    const result = classify(['app/page.tsx', '.github/workflows/deploy.yml', unknown]);
    assert.equal(result.mode, 'full', unknown);
    assert.deepEqual(only(result), ['monitoring', 'pilot', 'waitlist', 'web'], unknown);
    assert.deepEqual(result.unknown, [unknown]);
    assert.ok(Object.values(result.checks).every(Boolean), unknown);
    assert.match(result.reason, /unknown/, unknown);
  }
});

test('unusual or unsafe path spellings are unknown, never prose', () => {
  for (const path of ['/docs/a.md', 'docs/../app/page.tsx', './CHANGELOG.md', 'docs//a.md', 'docs\\a.md']) {
    assert.equal(ruleFor(path), null, path);
    assert.equal(classify([path]).mode, 'full', path);
  }
});

test('a change to the CI or deploy machinery cannot classify itself as small', () => {
  for (const path of ['.github/workflows/deploy.yml', 'ops/ci-scope/classify.mjs', 'ops/ci/launcher.py', '.dockerignore']) {
    assert.equal(classify([path]).mode, 'full', path);
  }
});

test('a change to the frozen final client release selects the web image and the signing gate', () => {
  for (const path of ['public/worker/uain-worker.mjs', 'public/worker/manifest.json', 'public/worker/follow.mjs', 'public/worker/signing.mjs']) {
    const result = classify([path]);
    assert.equal(result.mode, 'scoped', path);
    assert.deepEqual(only(result), ['web'], path);
    assert.equal(result.checks.workerSigning, true, path);
    assert.equal(result.checks.pilot, true, path);
  }
});

test('a chain client codec change runs the pilot and BAINK suites and builds no image', () => {
  const result = classify(['chain/client/signing.mjs']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), []);
  assert.equal(result.checks.pilot, true);
  assert.equal(result.checks.others, true);
  assert.equal(result.checks.workerSigning, false);
});

test('the prose-only allowlist is exact', () => {
  const prose = [
    'CHANGELOG.md',
    'remaining_work.md',
    'apps/baink/CHANGELOG.md',
    'docs/overview.md',
    'docs/federation/reconciliation.md',
    'docs/kenneth/README.md',
    'docs/kenneth/coverage.json',
    // The agent instructions and handover notes (10 November 2026): nothing reads them.
    'AGENTS.md',
    'CLAUDE.md',
    'ADMIN_HANDOFF.md',
    'docs-crucial/known-pitfalls.md',
    'docs-crucial/git-and-deployment.md',
  ];
  for (const path of prose) assert.equal(isProse(path), true, path);
  const notProse = [
    'README.md',
    'agents.md',
    'apps/baink/AGENTS.md',
    'docs-crucial/notes.txt',
    'docs-crucial/tools/run.sh',
    'docs-crucial/sub/notes.md',
    'docs-crucial.md',
    'changelog.md',
    'CHANGELOG.md.bak',
    'apps/baink/README.md',
    'apps/baink/docs/smartmeet.md',
    'services/pilot/CHANGELOG.md',
    'docs/html/index.html',
    'docs/contracts/admin-overview.v1.json',
    'docs/overview.MD',
    'docs/overview.md/x.ts',
    'docs',
    'remaining_work.md.orig',
    'ops/README.md',
    'deploy/k8s/production/README.md',
  ];
  for (const path of notProse) assert.equal(isProse(path), false, path);
  assert.equal(classify(prose).mode, 'prose');
  assert.deepEqual(only(classify(prose)), []);
  assert.equal(classify([...prose, 'README.md']).mode, 'full');
});

test('prose beside a runtime change does not skip that change', () => {
  const result = classify(['CHANGELOG.md', 'apps/waitlist-dashboard/src/main.js']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), ['waitlist']);
  assert.equal(result.checks.docs, true);
});

test('canonical release records are documentation and do not redeploy their own status publication', () => {
  const paths = ['CHANGELOG.md', 'docs/releases/current.json', 'docs/releases/CURRENT.md',
    'docs/releases/uain/621b6ba2.json',
    'docs/releases/baink/20261108T233941Z-852919b747.json',
    ...['central-reviewer', 'house-solver', 'project-planning', 'organization-starter', 'private-review-broker', 'controlled-holder', 'organizations',
      'trade-steward', 'native-chain', 'private-payment-service'].map(c => `docs/releases/${c}/${'a'.repeat(64)}.json`),
    `docs/releases/organizations/${'b'.repeat(40)}.json`];
  const result = classify(paths);
  assert.equal(result.mode, 'prose');
  assert.deepEqual(only(result), []);
  assert.deepEqual(Object.entries(result.checks).filter(([,v]) => v).map(([k]) => k), ['docs']);
  assert.deepEqual(only(classify([...paths, 'services/pilot/src/api/server.ts'])), ['pilot']);
  // The renderer of the status view is not prose: its tests run, and nothing is deployed for it.
  const renderer = classify([...paths, 'ops/docs/render-status.mjs']);
  assert.equal(renderer.mode, 'scoped');
  assert.deepEqual(only(renderer), []);
  assert.equal(renderer.checks.others, true);
  // Neither is a file under docs/ that is not a canonical record or Markdown: it is
  // never prose, the suites that read docs data run, and no image is built for it.
  for (const path of ['docs/releases/unknown/621b6ba2.json', 'docs/releases/uain/nested/621b6ba2.json',
    'docs/releases/uain/not-a-release.json', 'docs/releases/uain/621B6BA2.json', 'docs/releases/current.json.bak',
    'docs/releases/observations/unreviewed.json', 'docs/contracts/admin-overview.v1.json',
    `docs/releases/trade-steward/${'a'.repeat(40)}.json`, 'docs/design/landing-2026-10-06/hero.png', 'docs/html/build.py']) {
    assert.equal(isProse(path), false, path);
    const data = classify([path]);
    assert.equal(data.mode, 'scoped', path);
    assert.deepEqual(only(data), [], path);
    assert.deepEqual(selected(data), ['others', 'pilot'], path);
  }
});

test('operator scripts, services with their own release and repository settings deploy nothing', () => {
  // #428 changed services/project-organizations/ops/qualify-native-trade.sh and #439 the
  // pre-push check; each rebuilt every image and restarted every copy (10 November 2026).
  const cases = [
    ['services/project-organizations/ops/qualify-native-trade.sh', ['organizations', 'others']],
    ['services/project-organizations/src/planner.mjs', ['organizations', 'others']],
    ['services/fund-manager/src/policy.mjs', ['organizations', 'others']],
    ['services/central-reviewer/src/runtime.mjs', ['others']],
    ['services/retrieval/embedding_server.py', ['pilot', 'research', 'reset']],
    ['ops/check.sh', ['others', 'pilot', 'site']],
    ['ops/check-remote.sh', ['others', 'pilot', 'site']],
    ['ops/remote-test/run.sh', ['others', 'pilot', 'site']],
    ['.githooks/pre-push', ['others', 'pilot', 'site']],
    ['ops/reset/upgrade.py', ['others', 'pilot', 'reset']],
    ['ops/custody/custody.py', ['others']],
    ['ops/chain/install-shadow-node.sh', ['others']],
    ['ops/release/cli.mjs', ['others']],
    ['ops/docs/render-status.mjs', ['others']],
    ['ops/nginx/uain.global.conf', ['others']],
    ['ops/README.md', ['others']],
    ['runner/src/main.mjs', ['others']],
    ['press/press.mjs', ['others']],
    ['deploy/k8s/staging/uain.yaml', ['others']],
    ['compose.yaml', ['others']],
    ['compose.staging.yaml', ['others']],
    ['.gitattributes', ['others']],
    ['.claude/launch.json', ['others']],
    ['scripts/check-seo.mjs', ['others', 'site']],
    ['research/covering-29-7-3/search.cpp', ['others']],
    ['research/reference/wdbc/wdbc.data', ['pilot', 'research', 'reset']],
  ];
  for (const [path, suites] of cases) {
    const result = classify([path]);
    assert.equal(result.mode, 'scoped', path);
    assert.deepEqual(only(result), [], path);
    assert.deepEqual(selected(result), suites, path);
    assert.equal(isProse(path), false, path);
    assert.match(result.reason, /no production image changes/, path);
  }
  // Together with the registers they still deploy nothing.
  const together = classify([...cases.map(([path]) => path), 'CHANGELOG.md', 'remaining_work.md']);
  assert.equal(together.mode, 'scoped');
  assert.deepEqual(only(together), []);
});

test('the files under ops/ that an image or the monitoring stack reads still select it', () => {
  // The build id: copied into the pilot image and run by the website build. The two
  // tests below found it within the hour it was added, on 10 November 2026.
  const buildId = classify(['ops/docs/build-id.mjs']);
  assert.equal(buildId.mode, 'scoped');
  assert.deepEqual(only(buildId), ['pilot', 'web']);
  assert.deepEqual(selected(buildId), ['others', 'pilot', 'research', 'reset', 'site']);
  assert.deepEqual(only(classify(['ops/docs/build-id.test.mjs'])), []);
  assert.deepEqual(only(classify(['ops/nginx/docker.conf'])), ['web']);
  assert.deepEqual(only(classify(['ops/chain/native-rpc-transport.mjs'])), ['pilot']);
  assert.deepEqual(only(classify(['ops/monitoring/grafana/dashboards/uain.json'])), ['monitoring']);
  assert.deepEqual(only(classify(['ops/ci-scope/verify-worker-bundle.mjs'])), ['web']);
  assert.equal(ruleFor('ops/ci/rollout-wait.py').name, 'ci-harness');
  assert.equal(ruleFor('ops/ci-scope/release.py').full, true);
});

// The "no image is built from this" rules are only safe while every file an image
// is built from is claimed by that image's own rule. These read the build files.
const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
function copied(dockerfile, context = '') {
  const out = [];
  for (const line of read(dockerfile).split('\n')) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== 'COPY' || words.some((w) => w.startsWith('--from='))) continue;
    for (const source of words.slice(1, -1).filter((w) => !w.startsWith('--'))) {
      if (source === '.') continue; // the whole context: the web rule lists what the build reads
      const path = context + source;
      const directory = !path.includes('*') && statSync(new URL(path, root)).isDirectory();
      out.push(directory ? `${path}/probe.file` : path.replaceAll('*', 'x'));
    }
  }
  return out;
}

test('every file a Dockerfile copies by name selects that image', () => {
  const images = [
    ['web', copied('Dockerfile')],
    ['pilot', copied('services/pilot/Dockerfile')],
    ['waitlist', copied('apps/waitlist-dashboard/Dockerfile', 'apps/waitlist-dashboard/')],
  ];
  for (const [component, paths] of images) {
    assert.ok(paths.length >= 2, `${component}: the Dockerfile's COPY lines were not read`);
    for (const path of paths) {
      assert.ok(ruleFor(path)?.components?.includes(component), `${path} is copied into the ${component} image but does not select it`);
    }
  }
  assert.ok(images[0][1].includes('ops/nginx/docker.conf'));
  assert.ok(images[1][1].includes('ops/chain/native-rpc-transport.mjs'));
});

test('every script the web build runs selects the web image', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name) || !scripts[name]) return [];
    seen.add(name);
    const text = scripts[name];
    return [...(text.match(/(?:scripts|ops)\/[A-Za-z0-9._/-]+/g) ?? []), ...[...text.matchAll(/npm run ([a-z:-]+)/g)].flatMap((m) => walk(m[1]))];
  };
  // The root Dockerfile runs build:web and check:worker.
  const files = [...walk('build:web'), ...walk('check:worker')];
  assert.ok(files.includes('scripts/copy-cesium.mjs') && files.includes('ops/ci-scope/verify-worker-bundle.mjs'), files.join(' '));
  for (const path of files) {
    assert.ok(ruleFor(path)?.components?.includes('web'), `${path} runs in the web build but does not select the web image`);
  }
});

test('monitoring inputs select only monitoring', () => {
  for (const path of ['ops/monitoring/prometheus/prometheus.yml', 'deploy/k8s/production/monitoring.yaml']) {
    const result = classify([path]);
    assert.equal(result.mode, 'scoped', path);
    assert.deepEqual(only(result), ['monitoring'], path);
  }
});

test('test-only changes build no image but are not prose', () => {
  const result = classify(['services/pilot/test/ledger.test.mjs', 'contracts/test/anchor.test.mjs']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), []);
  assert.equal(result.checks.pilot, true);
});

test('shared contract fixtures select every consumer suite but no image', () => {
  const result = classify(['fixtures/contracts/amounts.json']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), []);
  for (const check of ['nativeChain', 'baink', 'organizations', 'custody']) assert.equal(result.checks[check], true, check);
  assert.equal(isProse('fixtures/contracts/README.md'), false);
});

test('BAINK changes select only the BAINK suite and no UAIN image', () => {
  const result = classify(['apps/baink/server/server-send.mjs', 'apps/baink/web/main.jsx']);
  assert.equal(result.mode, 'scoped');
  assert.deepEqual(only(result), []);
  assert.deepEqual(selected(result), ['baink']);
  // Read by the pilot's tests as well.
  assert.deepEqual(selected(classify(['apps/baink/server/central-task-holds.json'])), ['baink', 'pilot']);
});

test('chain changes select the native-chain suite, private sources also the private-exchange suite', () => {
  const core = classify(['chain/app/app.go', 'chain/federation/keeper.go']);
  assert.equal(core.mode, 'scoped');
  assert.deepEqual(only(core), []);
  assert.deepEqual(selected(core), ['baink', 'nativeChain']);
  assert.deepEqual(selected(classify(['chain/private-exchange/src/lib.rs'])), ['baink', 'nativeChain', 'privateExchange']);
  assert.deepEqual(selected(classify(['chain/migration/plan.mjs'])), ['baink', 'nativeChain', 'pilot']);
  // The chain client codecs keep their own rule (pilot and BAINK suites); the
  // retired client's download no longer copies them.
  assert.equal(ruleFor('chain/client/signing.mjs').name, 'chain-client');
});

test('the command line reads NUL-separated paths and writes GitHub outputs', () => {
  const out = execFileSync(process.execPath, [script, '--null', '--format', 'github'], {
    input: 'app/page.tsx\0CHANGELOG.md\0',
  }).toString();
  assert.match(out, /^mode=scoped$/m);
  assert.match(out, /^web=true$/m);
  assert.match(out, /^pilot=false$/m);
  assert.match(out, /^waitlist=false$/m);
  assert.match(out, /^monitoring=false$/m);
  assert.match(out, /^reason=components changed: web$/m);
  const md = execFileSync(process.execPath, [script, '--format', 'markdown'], { input: 'docs/overview.md\n' }).toString();
  assert.match(md, /Change scope: `prose`/);
});
