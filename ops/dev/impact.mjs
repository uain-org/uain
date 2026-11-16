#!/usr/bin/env node
// Shadow impact classifier over ops/dev/components.json (plan P2).
// It reports which components, checks and release targets a change touches.
// It never suppresses the current gates: unknown paths fall back to every
// check, and the workflows keep running their full suites regardless.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PATH = fileURLToPath(
  new URL('./components.json', import.meta.url),
);

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const globCache = new Map();

/** Minimal glob: `**` crosses directories, `*` and `?` stay within one, `{a,b}` alternates. */
export function globToRegExp(glob) {
  let cached = globCache.get(glob);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) throw new Error(`Unclosed brace in glob ${glob}`);
      out +=
        '(?:' +
        glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegExp)
          .join('|') +
        ')';
      i = end;
    } else out += escapeRegExp(c);
  }
  cached = new RegExp('^' + out + '$');
  globCache.set(glob, cached);
  return cached;
}

function escapeRegExp(text) {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function matches(path, globs = []) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function normalize(path) {
  return String(path).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * resolveImpact(changedPaths, manifest) ->
 *   {components, checks, releaseTargets, reasons, conservativeFallback, ...}
 */
export function resolveImpact(changedPaths, manifest = loadManifest()) {
  const checkOrder = Object.keys(manifest.checks);
  const components = new Set();
  const checks = new Set();
  const releaseTargets = new Set();
  const reasons = [];
  const unknown = [];
  const policyReview = [];
  const disabled = new Map();
  let allChecks = false;
  let proseOnly = true;

  const addComponent = (name, { withChecks = true, release = true } = {}) => {
    const component = manifest.components[name];
    if (!component)
      throw new Error(`Manifest references unknown component ${name}`);
    components.add(name);
    if (withChecks)
      for (const check of component.checks ?? []) checks.add(check);
    if (release && component.releaseTarget)
      releaseTargets.add(component.releaseTarget);
  };
  const addChecks = (list = []) => list.forEach((check) => checks.add(check));

  const paths = [...new Set(changedPaths.map(normalize).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
  for (const path of paths) {
    let classified = false;
    let pathIsProse = false;
    let executableDoc = false;

    for (const entry of manifest.executableDocs ?? []) {
      if (!matches(path, entry.paths)) continue;
      executableDoc = true;
      classified = true;
      for (const consumer of entry.consumers) {
        addComponent(consumer);
        reasons.push({
          path,
          kind: 'executable-doc',
          component: consumer,
          detail: entry.reason,
        });
      }
    }

    for (const entry of manifest.policy ?? []) {
      if (!matches(path, entry.paths)) continue;
      classified = true;
      addChecks(['policy-review']);
      const governs =
        entry.governs === '*'
          ? Object.keys(manifest.components)
          : entry.governs;
      policyReview.push({ path, governs, reason: entry.reason });
      reasons.push({
        path,
        kind: 'policy',
        component: 'docs',
        detail: `${entry.reason}; governs ${entry.governs === '*' ? 'every component' : governs.join(', ')}`,
      });
    }

    const prose = manifest.prose ?? {};
    if (!executableDoc && matches(path, prose.globs)) {
      classified = true;
      pathIsProse = true;
      components.add('docs');
      addChecks(prose.checks);
      reasons.push({
        path,
        kind: 'prose',
        component: 'docs',
        detail: 'Prose only; no runtime deployment',
      });
    } else if (!executableDoc && matches(path, prose.dataGlobs)) {
      classified = true;
      components.add('docs');
      addChecks(prose.dataChecks);
      reasons.push({
        path,
        kind: 'docs-data',
        component: 'docs',
        detail: 'Machine-readable record under docs; not prose-only',
      });
    } else if (!executableDoc && matches(path, prose.executableGlobs)) {
      classified = true;
      components.add('docs');
      addChecks(prose.executableChecks);
      reasons.push({
        path,
        kind: 'docs-executable',
        component: 'docs',
        detail: 'Executable or generating script under docs; not prose-only',
      });
    }

    if (!pathIsProse && !executableDoc) {
      // Specific components win; fallbackOnly components (operations, docs) catch the rest.
      const hits = [];
      for (const [name, component] of Object.entries(manifest.components)) {
        const kind = matches(path, component.lockfiles)
          ? 'lockfile'
          : matches(path, component.buildInputs)
            ? 'build-input'
            : matches(path, component.runtimeOutputs)
              ? 'runtime-output'
              : matches(path, component.sources) &&
                  !matches(path, component.exclude)
                ? 'source'
                : null;
        if (kind && !(name === 'docs' && classified))
          hits.push({ name, component, kind });
      }
      const specific = hits.filter((hit) => !hit.component.fallbackOnly);
      for (const { name, component, kind } of specific.length
        ? specific
        : hits) {
        classified = true;
        addComponent(name);
        reasons.push({
          path,
          kind,
          component: name,
          detail: component.description,
        });
        for (const feature of component.disabledFeatures ?? []) {
          if (!matches(path, feature.paths)) continue;
          const seen = disabled.get(feature.id) ?? {
            id: feature.id,
            component: name,
            flag: feature.flag,
            state: feature.default ?? 'disabled',
            paths: [],
            reason: feature.reason,
          };
          seen.paths.push(path);
          disabled.set(feature.id, seen);
        }
      }
    }

    for (const contract of manifest.contracts ?? []) {
      if (!matches(path, contract.paths)) continue;
      classified = true;
      pathIsProse = false;
      addChecks(contract.checks);
      if (contract.selectsAllChecks) allChecks = true;
      const releasing = new Set(
        contract.releaseConsumers ?? contract.consumers,
      );
      for (const consumer of contract.consumers) {
        addComponent(consumer, {
          withChecks: contract.includeConsumerChecks !== false,
          release: releasing.has(consumer),
        });
      }
      reasons.push({
        path,
        kind: 'contract',
        contract: contract.id,
        component: contract.consumers.join(', '),
        detail:
          contract.description +
          (contract.selectsAllChecks ? '; re-qualifies every suite' : ''),
      });
    }

    if (!classified) {
      unknown.push(path);
      reasons.push({
        path,
        kind: 'unknown',
        component: null,
        detail:
          'Not in ops/dev/components.json; conservative fallback selects every check',
      });
    }
    if (!pathIsProse) proseOnly = false;
  }

  const conservativeFallback = unknown.length > 0;
  if (conservativeFallback || allChecks)
    checkOrder.forEach((check) => checks.add(check));
  if (conservativeFallback) {
    for (const component of Object.values(manifest.components))
      if (component.releaseTarget) releaseTargets.add(component.releaseTarget);
  }
  const componentOrder = Object.keys(manifest.components);
  const releaseOrder = componentOrder
    .map((name) => manifest.components[name].releaseTarget)
    .filter(Boolean);
  for (const check of checks)
    if (!manifest.checks[check])
      throw new Error(`Manifest references unknown check ${check}`);
  return {
    mode: manifest.mode ?? 'shadow',
    components: componentOrder.filter((name) => components.has(name)),
    checks: checkOrder.filter((check) => checks.has(check)),
    releaseTargets: releaseOrder.filter((target) => releaseTargets.has(target)),
    reasons,
    conservativeFallback,
    unknownPaths: unknown,
    proseOnly: paths.length > 0 && proseOnly,
    policyReview,
    disabledFeatures: [...disabled.values()],
    currentGates: manifest.currentGates,
  };
}

/** Changed paths for a git range (`a..b`, `a...b`), one commit (first-parent diff), or the branch against origin/main. */
export function changedPathsFromGit(spec, cwd = process.cwd()) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let output;
  if (!spec) {
    output =
      git(['diff', '--name-only', 'origin/main...HEAD']) +
      git(['diff', '--name-only', 'HEAD']);
  } else if (spec.includes('..')) {
    output = git(['diff', '--name-only', spec]);
  } else {
    const parents = git(['rev-list', '--parents', '-n', '1', spec])
      .trim()
      .split(/\s+/);
    output =
      parents.length > 1
        ? git(['diff', '--name-only', parents[1], parents[0]])
        : git(['show', '--name-only', '--format=', spec]);
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatImpact(impact, manifest, label) {
  const lines = [];
  lines.push(`Impact (${impact.mode} mode${label ? `, ${label}` : ''})`);
  if (impact.conservativeFallback)
    lines.push(
      `CONSERVATIVE FALLBACK: ${impact.unknownPaths.length} unmapped path(s); every check selected.`,
    );
  if (impact.proseOnly)
    lines.push(
      'Prose-only change: documentation validation; no runtime deployment.',
    );
  lines.push(`Components: ${impact.components.join(', ') || 'none'}`);
  lines.push(`Release targets: ${impact.releaseTargets.join(', ') || 'none'}`);
  lines.push('Checks:');
  for (const check of impact.checks)
    lines.push(`  - ${check}: ${manifest.checks[check].command}`);
  for (const feature of impact.disabledFeatures)
    lines.push(
      `Disabled feature ${feature.id} (${feature.flag}) touched; it remains ${feature.state}.`,
    );
  for (const policy of impact.policyReview)
    lines.push(`Policy review: ${policy.path} (${policy.reason})`);
  lines.push('Reasons:');
  for (const reason of impact.reasons)
    lines.push(
      `  ${reason.path}: ${reason.kind}${reason.contract ? ` [${reason.contract}]` : ''} -> ${reason.component ?? 'unknown'}`,
    );
  lines.push(`Current gates: ${impact.currentGates}`);
  return lines.join('\n');
}

async function main(argv) {
  const json = argv.includes('--json');
  const filesIndex = argv.indexOf('--files');
  const rest = argv.filter(
    (arg, index) =>
      !arg.startsWith('--') && (filesIndex < 0 || index < filesIndex),
  );
  const manifest = loadManifest();
  let paths;
  let label;
  if (filesIndex >= 0) {
    paths = argv.slice(filesIndex + 1).filter((arg) => !arg.startsWith('--'));
    label = 'explicit files';
  } else if (argv.includes('--stdin')) {
    paths = readFileSync(0, 'utf8').split('\n');
    label = 'stdin';
  } else {
    label = rest[0] ?? 'origin/main...HEAD plus working tree';
    paths = changedPathsFromGit(rest[0]);
  }
  const impact = resolveImpact(paths, manifest);
  process.stdout.write(
    (json
      ? JSON.stringify(impact, null, 2)
      : formatImpact(impact, manifest, label)) + '\n',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
