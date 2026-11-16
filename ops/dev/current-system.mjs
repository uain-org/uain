#!/usr/bin/env node
// Build docs/engineering/current-system.md: one current-state record from
// read-only public endpoints, repository release manifests and (optionally)
// a timings summary from ops/dev/timings.mjs. Unavailable values are written
// as "unknown"; nothing is inferred from tests or commit subjects.
//
//   node ops/dev/current-system.mjs [--timings summary.json] [--write]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './timings.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUTPUT = join(ROOT, 'docs/engineering/current-system.md');
const UNKNOWN = 'unknown';

async function probe(url, headers = []) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'manual',
      headers: { 'user-agent': 'uain-current-system/1' },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      url,
      status: response.status,
      ms: Date.now() - started,
      body,
      headers: Object.fromEntries(
        headers.map((h) => [h, response.headers.get(h) ?? UNKNOWN]),
      ),
    };
  } catch (error) {
    return {
      url,
      status: UNKNOWN,
      ms: Date.now() - started,
      body: null,
      error: error.name,
      headers: Object.fromEntries(headers.map((h) => [h, UNKNOWN])),
    };
  }
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  } catch {
    return null;
  }
};

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return UNKNOWN;
  }
}

function latestDeploy() {
  try {
    const out = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'deploy.yml',
        '--branch',
        'main',
        '--limit',
        '5',
        '--json',
        'databaseId,headSha,status,conclusion,createdAt,updatedAt',
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20000,
      },
    );
    const runs = JSON.parse(out);
    const lastSuccess = runs.find((r) => r.conclusion === 'success');
    return { latest: runs[0] ?? null, lastSuccess: lastSuccess ?? null };
  } catch {
    return { latest: null, lastSuccess: null };
  }
}

const v = (value) =>
  value === undefined || value === null || value === ''
    ? UNKNOWN
    : String(value);
const min = (msValue) =>
  Number.isFinite(msValue) ? `${(msValue / 60000).toFixed(2)} min` : UNKNOWN;
const cell = (value) => v(value).replace(/\|/g, '\\|');

export async function collect({ timingsPath } = {}) {
  const observedAt = new Date().toISOString();
  const [ready, health, worker, baink] = await Promise.all([
    probe('https://uain.global/api/ready', ['x-uain-authority']),
    probe('https://uain.global/api/health'),
    probe('https://uain.global/worker/manifest.json'),
    probe('https://baink.money/api/health', ['x-baink-release']),
  ]);
  const holderPins = readdirSync(join(ROOT, 'chain/private-exchange/pins'))
    .filter((name) => name.endsWith('.release.json'))
    .map((name) => ({
      file: `chain/private-exchange/pins/${name}`,
      ...readJson(`chain/private-exchange/pins/${name}`),
    }));
  const chainReleases = existsSync(join(ROOT, 'chain/releases'))
    ? readdirSync(join(ROOT, 'chain/releases'))
        .filter((n) => n.endsWith('.json'))
        .sort()
    : [];
  return {
    observedAt,
    source: {
      head: git(['rev-parse', 'HEAD']),
      originMain: git(['rev-parse', 'origin/main']),
    },
    deploy: latestDeploy(),
    endpoints: { ready, health, worker, baink },
    repo: {
      bainkVersion: readJson('apps/baink/package.json')?.version,
      workerVersion: readJson('public/worker/manifest.json')?.version,
      pilotVersion: readJson('services/pilot/package.json')?.version,
      waitlistVersion: readJson('apps/waitlist-dashboard/package.json')
        ?.version,
      holderPins,
      chainReleases,
    },
    timings: timingsPath ? JSON.parse(readFileSync(timingsPath, 'utf8')) : null,
    timingsPath,
  };
}

// Plan P0 installed the 10 GiB shared-host disk floor at this time.
const DISK_FLOOR_INSTALLED = '2026-11-06T10:36:09Z';
function floorNote(lastBlocked) {
  if (!lastBlocked) return '';
  return lastBlocked < DISK_FLOOR_INSTALLED
    ? ` The latest refusal started at ${lastBlocked}, before the 10 GiB disk floor was installed (${DISK_FLOOR_INSTALLED}, plan P0); later windows show whether refusals stop.`
    : ` The latest refusal started at ${lastBlocked}, after the 10 GiB disk floor was installed (${DISK_FLOOR_INSTALLED}, plan P0).`;
}

export function render(state) {
  const { endpoints: e, repo, deploy, timings } = state;
  const workerMatch =
    e.worker.body?.version && repo.workerVersion
      ? e.worker.body.version === repo.workerVersion
        ? 'matches repository'
        : `differs from repository ${repo.workerVersion}`
      : UNKNOWN;
  const lines = [];
  lines.push('# Current system record');
  lines.push('');
  lines.push(
    `Observed at **${state.observedAt}**. Generated by \`node ops/dev/current-system.mjs --timings <summary.json> --write\` (plan P1). Values not observable from read-only public endpoints, repository manifests or the GitHub API are written as *unknown*; nothing here is inferred from tests, commit subjects or older documents. Earlier dated status documents are historical.`,
  );
  lines.push('');
  lines.push(
    `Source: checkout \`${state.source.head.slice(0, 12)}\`, \`origin/main\` \`${state.source.originMain.slice(0, 12)}\`.`,
  );
  lines.push('');
  lines.push('## Public runtime (read-only probes)');
  lines.push('');
  lines.push('| Service | Endpoint | Observed | Detail |');
  lines.push('|---|---|---|---|');
  lines.push(
    `| UAIN connection server | \`GET /api/ready\` | HTTP ${cell(e.ready.status)} | ok=${cell(e.ready.body?.ok)}, service=${cell(e.ready.body?.service)}, authority header=${cell(e.ready.headers['x-uain-authority'])} |`,
  );
  lines.push(
    `| UAIN connection server | \`GET /api/health\` | HTTP ${cell(e.health.status)} | ok=${cell(e.health.body?.ok)}, server time=${cell(e.health.body?.time)} |`,
  );
  lines.push(
    `| Signed worker | \`GET /worker/manifest.json\` | HTTP ${cell(e.worker.status)} | served version ${cell(e.worker.body?.version)} (${workerMatch}) |`,
  );
  lines.push(
    `| BAINK | \`GET https://baink.money/api/health\` | HTTP ${cell(e.baink.status)} | ok=${cell(e.baink.body?.ok)}, storage=${cell(e.baink.body?.storage)}, settlement available=${cell(e.baink.body?.settlement?.available)} (${cell(e.baink.body?.settlement?.code)}), \`x-baink-release\`=${cell(e.baink.headers['x-baink-release'])} |`,
  );
  lines.push('');
  lines.push('## Deployed versus repository');
  lines.push('');
  lines.push('| Component | Repository | Deployed (observed) | Status |');
  lines.push('|---|---|---|---|');
  const lastDeploy = deploy.lastSuccess;
  lines.push(
    `| web + pilot + waitlist (deploy.yml) | \`origin/main\` ${state.source.originMain.slice(0, 12)} | last successful Deploy UAIN run ${lastDeploy ? `${lastDeploy.databaseId} for \`${lastDeploy.headSha.slice(0, 12)}\` at ${lastDeploy.updatedAt}` : UNKNOWN}; latest run ${deploy.latest ? `${deploy.latest.databaseId} ${deploy.latest.status}/${v(deploy.latest.conclusion || 'pending')} for \`${deploy.latest.headSha.slice(0, 12)}\`` : UNKNOWN} | The public endpoints do not expose the running commit; image tag on the cluster is unknown from here |`,
  );
  lines.push(
    `| BAINK application | package ${v(repo.bainkVersion)} | release id ${cell(e.baink.headers['x-baink-release'])} | Semantic version of the running release is unknown publicly; the release id is authoritative |`,
  );
  lines.push(
    `| Signed worker | manifest ${v(repo.workerVersion)} | ${cell(e.worker.body?.version)} | ${workerMatch} |`,
  );
  for (const pin of repo.holderPins)
    lines.push(
      `| Holder tool \`${v(pin.tool)}\` | ${pin.file}, qualified ${v(pin.qualified)} on ${v(pin.qualifiedDate)} | productionInstalled=${v(pin.productionInstalled)} (manifest field) | Live install state is unknown from public endpoints |`,
    );
  lines.push(
    `| Native chain | rehearsal manifests: ${repo.chainReleases.join(', ') || 'none'} | unknown | No read-only public version endpoint is probed |`,
  );
  lines.push(
    `| Private exchange tools | Cargo lockfiles in chain/private-* | unknown | Not publicly observable |`,
  );
  lines.push(
    `| Reviewer, organizations, custody timers | ops/custody units in repository | unknown | Host-local systemd state; not publicly observable |`,
  );
  lines.push('');
  lines.push('## CI and release timing baseline');
  lines.push('');
  if (!timings) {
    lines.push(
      'Timing baseline: unknown (run `node ops/dev/timings.mjs --days 7 --summary-out <file>` and regenerate).',
    );
  } else {
    lines.push(
      `Measured with \`node ops/dev/timings.mjs --days ${v(timings.window?.days)} --top 5 --max-logs 250 --summary-out <file>\` at ${v(timings.generatedAt)} over runs created since ${v(timings.window?.since)}: ${timings.runs} runs, ${timings.records} RunTiming records, ${v(timings.logsScanned)} failed-job logs scanned in memory for the shared-host admission marker. Baseline summary: [ci-timings-baseline-2026-11-06.json](./ci-timings-baseline-2026-11-06.json). Totals sum parallel jobs, so they measure runner time consumed; the critical path and wall times measure lead time.`,
    );
    lines.push('');
    lines.push(
      '| Workflow | Runs | Outcomes | Passed wall time median / p95 |',
    );
    lines.push('|---|---:|---|---|');
    for (const [name, row] of Object.entries(timings.byWorkflow)) {
      const outcomes = Object.entries(row.outcomes)
        .filter(([, n]) => n)
        .map(([o, n]) => `${o} ${n}`)
        .join(', ');
      lines.push(
        `| ${cell(name)} | ${row.runs} | ${outcomes} | ${min(row.passedWall.medianMs)} / ${min(row.passedWall.p95Ms)} |`,
      );
    }
    lines.push('');
    lines.push('### Top three measured bottlenecks');
    lines.push('');
    timings.topBottlenecks.slice(0, 3).forEach((b, i) => {
      lines.push(
        `${i + 1}. **${cell(b.name)}** (${b.component}, ${b.stage}): ${min(b.totalMs)} total over ${b.count} executions, median ${min(b.medianMs)}, p95 ${min(b.p95Ms)}. Reproduce: \`${b.reproduce}\`.`,
      );
    });
    lines.push('');
    const pr = timings.criticalPath?.['Pull request checks']?.[0];
    const dep = timings.criticalPath?.['Deploy UAIN']?.[0];
    lines.push(
      `Critical path: in passed PR-check runs the longest job was *${v(pr?.job)}* in ${v(pr?.runs)} runs (median ${min(pr?.medianMs)}); in passed Deploy UAIN runs it was *${v(dep?.job)}* in ${v(dep?.runs)} runs (median ${min(dep?.medianMs)}).`,
    );
    lines.push('');
    lines.push(
      `Resource refusals: ${timings.resourceBlocked.runs} runs and ${timings.resourceBlocked.jobs} jobs ended on \`Shared-host guard failed\` (${timings.resourceBlocked.jobMinutes} job-minutes before refusal); these are resource-blocked, not test failures.${floorNote(timings.resourceBlocked.lastStartedAt)} Cancelled jobs: ${timings.cancelled.jobs} (${timings.cancelled.jobMinutes} min). Records with unknown outcome (still running or missing end time): ${timings.unknownOutcomes}.`,
    );
    lines.push('');
    lines.push(
      'Limits: setup, dependency installation, compilation and tests run inside one container step per suite (`ops/ci/container-suite.sh`), so this export cannot yet split install/build from test time inside a suite; that needs instrumentation in the suite script. Runner inventory, Docker storage, cache sizes and peak scratch bytes are not measured here (unknown). Cold versus warm runs are not separated.',
    );
  }
  lines.push('');
  lines.push('## Unknowns to close');
  lines.push('');
  lines.push(
    '- Running commit or image tag of web, pilot and waitlist: not exposed publicly (unknown).',
  );
  lines.push(
    '- Semantic version behind the BAINK release id: not exposed publicly (unknown).',
  );
  lines.push(
    '- Native chain, private tools, holder, reviewer and custody timer versions on hosts: host-local (unknown here).',
  );
  lines.push(
    '- Actual self-hosted runner count and placement: observed runner names only; inventory unknown.',
  );
  lines.push('');
  return redact(lines.join('\n'));
}

async function main(argv) {
  const index = argv.indexOf('--timings');
  const state = await collect({
    timingsPath: index >= 0 ? argv[index + 1] : undefined,
  });
  const markdown = render(state);
  if (argv.includes('--write')) {
    writeFileSync(OUTPUT, markdown);
    console.log(`Wrote ${OUTPUT}`);
  } else process.stdout.write(markdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(redact(error.message));
    process.exit(1);
  });
}
