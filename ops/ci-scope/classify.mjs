#!/usr/bin/env node
/**
 * Change-scope classifier for deploy.yml and the pre-push check ops/check.sh (plan P5/P6,
 * docs/superpowers/plans/2026-11-06-development-and-release-simplification.md).
 *
 * Input: the changed paths of a range (one per line, or NUL-separated with
 * --null), as `git diff --name-only --no-renames` prints them, so a rename
 * lists both the old and the new path.
 *
 * Output: which production components the range touches and which suites a
 * selector would choose. The workflows act on `mode` and `components` only:
 *
 *   prose   every path is on the exact prose allowlist. No image is built, no
 *           deployment is applied or restarted; only the docs check runs.
 *   scoped  every path matched a known rule. Only the listed components are
 *           built and rolled out.
 *   full    a path is unknown, or changes the deployment/CI machinery itself.
 *           The complete manifest is applied again, and `npm run check` runs
 *           the routine suites. Since 10 November 2026 `components` says which
 *           images to build here too: all of them for an unknown path (it may
 *           be an input of any image), and only the ones whose own inputs
 *           changed when the reason is the machinery alone. A workflow or
 *           manifest change no longer rebuilds and restarts everything: it
 *           cannot alter an image, and the apply rolls out exactly what a
 *           manifest change changes.
 *
 * A rule without `components` means "no UAIN image is built from this path":
 * the deploy builds and rolls out nothing for it. Its `checks` still say which
 * suites `npm run check` runs.
 *
 * `checks` in the deploy summary is a shadow decision (P6); ops/check.sh acts
 * on it for scoped changes.
 *
 * Self-contained (node built-ins only): the workflows run it in a no-network,
 * read-only container, and (formerly) pr-checks.yml ran the base branch's copy so a pull
 * request cannot change the rules that classify it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COMPONENTS = ['web', 'pilot', 'waitlist', 'monitoring'];
export const CHECKS = [
  'docs',
  'site',
  'pilot',
  'research',
  'reset',
  'others',
  'workerSigning',
  'nativeChain',
  'privateExchange',
  'baink',
  'organizations',
  'custody',
];

/**
 * Exact prose allowlist. A Markdown extension alone is not enough (P6).
 * AGENTS.md, CLAUDE.md, ADMIN_HANDOFF.md and docs-crucial/*.md are the agent
 * instructions and the handover notes (10 November 2026): no image, test or
 * script reads them, and a one-line change to them ran every suite and rolled
 * every copy.
 */
const PROSE_FILES = new Set([
  'CHANGELOG.md',
  'remaining_work.md',
  'apps/baink/CHANGELOG.md',
  'AGENTS.md',
  'CLAUDE.md',
  'ADMIN_HANDOFF.md',
]);
// Canonical status data is consumed only by the documentation renderer. Keep
// this explicit: arbitrary JSON, new components and runtime configuration must
// still select their existing checks (or the unknown-path full fallback).
const RELEASE_RECORD_IDS = new Map([
  ['uain', /^[0-9a-f]{8}$/],
  ['baink', /^\d{8}T\d{6}Z-[0-9a-f]{10}$/],
  ['organizations', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/],
  ...['central-reviewer', 'house-solver', 'project-planning', 'organization-starter', 'private-review-broker', 'controlled-holder',
    'trade-steward', 'native-chain', 'private-payment-service'].map(name => [name, /^[0-9a-f]{64}$/]),
]);
export function isProse(path) {
  if (PROSE_FILES.has(path)) return true;
  if (/^docs-crucial\/[^/]+\.md$/.test(path)) return true;
  if (path === 'docs/releases/current.json') return true;
  const record = /^docs\/releases\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (record && RELEASE_RECORD_IDS.get(record[1])?.test(record[2])) return true;
  if (path.startsWith('docs/kenneth/')) return true;
  return path.startsWith('docs/') && path.endsWith('.md');
}

const PILOT_CHECKS = ['pilot', 'research', 'reset'];
// What `npm run check` runs for a full-scope change (ops/check.sh).
const ROUTINE = ['pilot', 'others', 'site'];

/**
 * Ordered rules: the first match decides. `full: true` marks the deployment
 * and CI machinery: the complete manifest is applied again and the routine
 * suites run, but no image is built for it. Patterns are anchored; `**`
 * crosses directories, `*` does not.
 */
export const RULES = [
  // The deployment and CI machinery classifies, builds and verifies every
  // component. None of it is an input of an image (.github is not in the
  // build context; .dockerignore can only change what a build sees, so it
  // selects the two images built from the repository root).
  { name: 'workflows', patterns: ['.github/**'], full: true },
  { name: 'build-context', patterns: ['.dockerignore'], full: true, components: ['web', 'pilot'] },
  // Checked in the web image's build (npm run check:worker), so it is an input of that image.
  { name: 'worker-verifier', patterns: ['ops/ci-scope/verify-worker-bundle.mjs'], full: true, components: ['web'] },
  { name: 'ci-harness', patterns: ['ops/ci/**', 'ops/ci-scope/**'], full: true },
  { name: 'monitoring-compose', patterns: ['deploy/k8s/production/monitoring.yaml'], components: ['monitoring'] },
  { name: 'production-manifests', patterns: ['deploy/k8s/production/**'], full: true },

  // The final signed release (0.15.0) of the retired UAIN Client, frozen in
  // public/worker/: the web image serves it and verifies its signature; the
  // pilot suite's worker-manifest test checks it too.
  {
    name: 'signed-worker',
    patterns: ['public/worker/**'],
    components: ['web'],
    checks: ['site', 'pilot', 'workerSigning'],
  },
  // The chain client codecs: imported by BAINK, the review services and the
  // pilot's tests, and no longer copied into the client download.
  { name: 'chain-client', patterns: ['chain/client/**'], checks: ['pilot', 'others'] },
  // The pilot's package and compiler settings: the pilot image and its suites.
  {
    name: 'pilot-packages',
    patterns: [
      'services/pilot/package.json',
      'services/pilot/package-lock.json',
      'services/pilot/tsconfig*.json',
    ],
    components: ['pilot'],
    checks: ['site', ...PILOT_CHECKS],
  },

  // The connection server image (services/pilot/Dockerfile).
  {
    name: 'pilot',
    patterns: ['services/pilot/src/**', 'services/pilot/scripts/**', 'services/pilot/Dockerfile', 'ops/chain/native-rpc-transport.mjs'],
    components: ['pilot'],
    checks: ['site', ...PILOT_CHECKS],
  },
  { name: 'pilot-tests', patterns: ['services/pilot/test/**'], checks: PILOT_CHECKS },

  // The proxy in the web image forwards the API to the pilot: both sides'
  // contract checks run, while only the web image changes.
  { name: 'web-proxy', patterns: ['ops/nginx/docker.conf'], components: ['web'], checks: ['site', 'pilot'] },

  // The build id both images carry (10 November 2026): the pilot image copies
  // this file and the website build runs it (/api/build, /build.json).
  {
    name: 'build-id',
    patterns: ['ops/docs/build-id.mjs'],
    components: ['web', 'pilot'],
    checks: ['site', ...PILOT_CHECKS, 'others'],
  },

  // Website sources the pilot's tests read (native-onboarding, site-feed,
  // earth-kalki, kalki-status): both suites run, only the web image changes.
  // Before 10 November 2026 a change to one of them ran the site build alone.
  {
    name: 'web-read-by-pilot-tests',
    patterns: [
      'public/llms.txt',
      'public/access-guide.md',
      'public/native-guide.md',
      'public/.well-known/uain.json',
      'lib/network/api-base.ts',
      'lib/network/feed.ts',
      'lib/network/format.ts',
      'lib/observatory/world.ts',
      'lib/observatory/kalki-status.ts',
    ],
    components: ['web'],
    checks: ['site', 'pilot'],
  },

  // The website image (Dockerfile at the root).
  {
    name: 'root-packages',
    patterns: ['package.json', 'package-lock.json'],
    components: ['web'],
    checks: ['site', 'pilot', 'others'],
  },
  {
    name: 'web',
    patterns: [
      'app/**',
      'components/**',
      'lib/**',
      'public/**',
      'scripts/copy-cesium.mjs',
      'scripts/check-social-previews.mjs',
      'scripts/check-owned-discovery.mjs',
      'scripts/record-frame.mjs',
      'Dockerfile',
      'vite.config.ts',
      'next.config.ts',
      'next-env.d.ts',
      'tsconfig.json',
      'components.json',
    ],
    components: ['web'],
    checks: ['site'],
  },

  { name: 'waitlist', patterns: ['apps/waitlist-dashboard/**'], components: ['waitlist'] },
  { name: 'monitoring', patterns: ['ops/monitoring/**'], components: ['monitoring'] },

  // Checked by the test workflow, never part of a production image.
  { name: 'test-only', patterns: ['scripts/*.test.mjs', 'contracts/**'], checks: ['others'] },
  // Shared contract fixtures (amounts, canonical JSON, command signing, field
  // rejections, plans): read only by tests, on both sides of each contract.
  // chain.yml runs the native suites for fixtures/** as well.
  {
    name: 'contract-fixtures',
    patterns: ['fixtures/**'],
    checks: ['nativeChain', 'baink', 'organizations', 'custody', 'pilot'],
  },

  // BAINK (10 November 2026): released on its own host with release:promote,
  // never by the UAIN deploy, so no UAIN component. Its suite runs in "others".
  // Two server files are also read by the pilot's tests.
  {
    name: 'baink-read-by-pilot',
    patterns: ['apps/baink/server/mcp-content.mjs', 'apps/baink/server/central-task-holds.json'],
    checks: ['baink', 'pilot'],
  },
  { name: 'baink', patterns: ['apps/baink/**'], checks: ['baink'] },

  // The native chain (10 November 2026): deployed by the guarded node upgrade,
  // never by the UAIN deploy. chain/client/** has its own rule (above). The
  // native-chain suite also runs BAINK's real-chain pilot e2e, and BAINK's tests
  // pin chain sources (native-bounty-materials), so BAINK's suite runs too.
  // Only the private-exchange suite builds the orchard-tagged Go and the Rust
  // private crates (the 0.4.1 orchard test break showed only there).
  { name: 'chain-migration', patterns: ['chain/migration/**'], checks: ['nativeChain', 'baink', 'pilot'] },
  {
    name: 'chain-private',
    patterns: ['chain/private-exchange/**', 'chain/private-dividend/**', 'chain/privatedividend/**', 'chain/privatewallet/**'],
    checks: ['nativeChain', 'privateExchange', 'baink'],
  },
  { name: 'chain', patterns: ['chain/**'], checks: ['nativeChain', 'baink'] },

  // Not deployed by the UAIN deploy (10 November 2026). None of these paths is
  // an input of the web, pilot or waitlist image or of monitoring; the rules
  // above claim the few files under ops/ that are (ops/nginx/docker.conf,
  // ops/chain/native-rpc-transport.mjs, ops/monitoring/**, ops/ci-scope/
  // verify-worker-bundle.mjs), and classify.test.mjs checks every file a
  // Dockerfile copies by name against them. Before, these paths were unknown:
  // a change to an operator script, to the pre-push check or to a design file
  // rebuilt every image and rolled out every copy. The suites are the ones
  // ops/dev/components.json lists for each area, and where a wider suite reads
  // the files it is named.
  //
  // The pre-push check and the scripts that run every suite on the test host.
  { name: 'check-harness', patterns: ['ops/check*', 'ops/remote-test/**', '.githooks/**'], checks: ROUTINE },
  // The reset tools: their own suite, the pilot's native-reset test and the
  // upgrade test in the operations suite read them.
  { name: 'reset-tools', patterns: ['ops/reset/**'], checks: ['pilot', 'reset', 'others'] },
  // The WDBC reference pack: pinned byte for byte by the pilot's wdbc-reference test.
  { name: 'research-reference', patterns: ['research/reference/**'], checks: PILOT_CHECKS },
  // Exploratory research code outside the network; its unit tests run in the operations suite.
  { name: 'research', patterns: ['research/**'], checks: ['others'] },
  // The retrieval service runs on its own host; the research suite runs its tests.
  { name: 'retrieval', patterns: ['services/retrieval/**'], checks: PILOT_CHECKS },
  // Custody-installed services and their operator scripts (for example
  // services/project-organizations/ops/qualify-native-trade.sh): released by
  // their own reviewed installers, tested in the operations suite.
  {
    name: 'organization-services',
    patterns: ['services/project-organizations/**', 'services/fund-manager/**'],
    checks: ['organizations', 'others'],
  },
  { name: 'central-reviewer', patterns: ['services/central-reviewer/**'], checks: ['others'] },
  // Host scripts, installers, the runner, the press kit, staging's own
  // manifests (deploy-staging.yml) and repository settings.
  {
    name: 'operations',
    patterns: [
      'ops/**',
      'deploy/k8s/staging/**',
      'runner/**',
      'press/**',
      'compose.yaml',
      'compose.*.yaml',
      '.gitignore',
      '.gitattributes',
      '.mcp.json',
      '.claude/**',
      '.oxlintrc.json',
      '.oxfmtrc.json',
    ],
    checks: ['others'],
  },
  // Developer scripts run by hand. The three scripts the web build runs are in
  // the `web` rule above; classify.test.mjs checks package.json against it.
  { name: 'dev-scripts', patterns: ['scripts/**'], checks: ['others', 'site'] },
  // Documents that are not prose (design files, PDFs, recorded evidence, JSON
  // contracts): no image reads them. Pilot and operations tests read some
  // (docs/valuation, docs/contracts, the organizations' reviewed bootstrap).
  { name: 'docs-data', patterns: ['docs/**'], checks: ['pilot', 'others'] },
];

const compiled = new Map();
function matcher(pattern) {
  let re = compiled.get(pattern);
  if (!re) {
    const source = pattern
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    re = new RegExp(`^${source}$`);
    compiled.set(pattern, re);
  }
  return re;
}
export const matches = (pattern, path) => matcher(pattern).test(path);

/** A path git would print for a tracked file: relative, no `.`/`..` segments. */
export function isPlainPath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function ruleFor(path) {
  if (!isPlainPath(path)) return null;
  if (isProse(path)) return { name: 'prose', checks: ['docs'] };
  return RULES.find((rule) => rule.patterns.some((p) => matches(p, path))) ?? null;
}

export function classify(paths) {
  const unique = [...new Set(paths.filter((p) => p !== ''))].sort();
  const components = Object.fromEntries(COMPONENTS.map((c) => [c, false]));
  const checks = Object.fromEntries(CHECKS.map((c) => [c, false]));
  const matched = [];
  const unknown = [];
  const forcing = [];
  let prose = 0;
  for (const path of unique) {
    const rule = ruleFor(path);
    if (!rule) {
      unknown.push(path);
      continue;
    }
    matched.push({ path, rule: rule.name });
    if (rule.name === 'prose') prose += 1;
    if (rule.full) forcing.push(path);
    for (const c of rule.components ?? []) components[c] = true;
    for (const c of rule.checks ?? []) checks[c] = true;
  }

  let mode;
  let reason;
  if (unique.length === 0) {
    mode = 'scoped';
    reason = 'no changed paths: nothing to build; secrets are still synchronised';
  } else if (unknown.length > 0) {
    // An unknown path may be an input of any image: everything is built.
    mode = 'full';
    reason = `unknown path(s) select everything: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', ...' : ''}`;
    for (const c of COMPONENTS) components[c] = true;
    for (const c of CHECKS) checks[c] = true;
  } else if (forcing.length > 0) {
    // The machinery is no image's input: the manifest is applied again and
    // only the images whose own inputs changed in this range are built.
    mode = 'full';
    const selected = COMPONENTS.filter((c) => components[c]);
    reason =
      `deployment or CI machinery changed: ${forcing.slice(0, 5).join(', ')}${forcing.length > 5 ? ', ...' : ''}; ` +
      `the manifest is applied again; ${selected.length ? `built: ${selected.join(', ')}` : 'no image is built'}`;
    for (const c of CHECKS) checks[c] = true;
  } else if (prose === unique.length) {
    mode = 'prose';
    reason = `prose-only: ${unique.length} allowlisted documentation file(s); no runtime input changed`;
  } else {
    mode = 'scoped';
    const selected = COMPONENTS.filter((c) => components[c]);
    reason = selected.length
      ? `components changed: ${selected.join(', ')}`
      : 'test or documentation inputs only: no production image changes';
  }
  return { schemaVersion: 1, mode, reason, components, checks, paths: unique.length, matched, unknown };
}

export function githubOutput(result) {
  const lines = [`mode=${result.mode}`, `reason=${result.reason.replace(/[\r\n]+/g, ' ')}`];
  for (const c of COMPONENTS) lines.push(`${c}=${result.components[c]}`);
  for (const c of CHECKS) lines.push(`check_${c}=${result.checks[c]}`);
  return lines.join('\n') + '\n';
}

export function markdown(result) {
  const yes = (v) => (v ? 'yes' : 'no');
  const out = [
    `### Change scope: \`${result.mode}\``,
    '',
    result.reason,
    '',
    '| Component | Built from source |',
    '|---|---|',
    ...COMPONENTS.map((c) => `| ${c} | ${yes(result.components[c])} |`),
    '',
    'A component that is not built keeps the image it runs and is not rolled out.',
    '',
    `Suites for these paths (the tests ran before the push, npm run check): ${
      CHECKS.filter((c) => result.checks[c]).join(', ') || 'none'
    }`,
  ];
  if (result.unknown.length) out.push('', `Unknown paths (${result.unknown.length}): ${result.unknown.slice(0, 20).map((p) => `\`${p}\``).join(', ')}`);
  return out.join('\n') + '\n';
}

function main(argv) {
  const nul = argv.includes('--null');
  const formatIndex = argv.indexOf('--format');
  const format = formatIndex >= 0 ? argv[formatIndex + 1] : 'json';
  const input = readFileSync(0, 'utf8');
  const paths = input.split(nul ? '\0' : /\r?\n/).filter((p) => p !== '');
  const result = classify(paths);
  if (format === 'github') process.stdout.write(githubOutput(result));
  else if (format === 'markdown') process.stdout.write(markdown(result));
  else if (format === 'json') process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    process.stderr.write(`unknown --format ${format}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
