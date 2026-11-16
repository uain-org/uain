#!/usr/bin/env node
// Export GitHub Actions run/job/step timings as RunTiming records (plan P1).
//
//   node ops/dev/timings.mjs [--days 7] [--repo owner/name] [--out records.json]
//        [--summary-out summary.json] [--max-logs 60] [--no-logs] [--json] [--top 3]
//
// RunTiming = {runId, sourceDigest, component, stage, startedAt, durationMs,
//              outcome, environmentClass, resourceClass} plus workflow, name
// and attempt for context. Outcomes: passed, failed, cancelled,
// resource-blocked, unknown. A failed shared-host admission is
// resource-blocked, not a test failure. Logs of failed jobs are scanned in
// memory for the admission marker and never stored or printed.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OUTCOMES = [
  'passed',
  'failed',
  'cancelled',
  'resource-blocked',
  'unknown',
];
export const RESOURCE_GUARD = /Shared-host guard failed/;

const SECRET_PATTERNS = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[redacted-private-key]',
  ],
  [/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [
    /\b((?:password|passwd|secret|api[_-]?key|private[_-]?key)\s*[=:]\s*)\S+/gi,
    '$1[redacted]',
  ],
];

export function redact(value) {
  if (typeof value === 'string')
    return SECRET_PATTERNS.reduce(
      (text, [pattern, replacement]) => text.replace(pattern, replacement),
      value,
    );
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v)]),
    );
  return value;
}

export function classifyStage(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.startsWith('post ') || /prune|remove images|clean ?up/.test(n))
    return 'cleanup';
  if (
    /^(set up job|complete job)$/.test(n) ||
    n.startsWith('run actions/') ||
    /require trusted/.test(n) ||
    /checkout/.test(n)
  )
    return 'setup';
  if (/\bnpm (ci|install)\b|install dependencies/.test(n)) return 'install';
  if (/site build|build and push|\bbuild\b/.test(n)) return 'build';
  if (
    /\btests?\b|suite|isolated container|race|proofs|smoke|vectors|schema reset/.test(
      n,
    )
  )
    return 'test';
  if (/verify|^check |require every/.test(n)) return 'verification';
  if (/apply|deploy|write the .*secret|install|activat|restart|rollout/.test(n))
    return 'activation';
  if (/back ?up|publish|anchor|ledger|maintain/.test(n)) return 'operation';
  return 'other';
}

export function componentForJob(workflow, job) {
  const w = String(workflow ?? '').toLowerCase();
  const j = String(job ?? '').toLowerCase();
  if (/\bpilot \(|research vectors|reset archive/.test(j)) return 'pilot';
  if (/press, contracts and operations/.test(j)) return 'operations';
  if (/site build/.test(j)) return 'web';
  if (/required pr tests/.test(j)) return 'operations';
  if (/native-chain/.test(j)) return 'native-chain';
  if (/private-exchange/.test(j)) return 'private-exchange';
  if (w.startsWith('deploy uain') && /^deploy$/.test(j))
    return 'web+pilot+waitlist';
  if (/staging/.test(w)) return 'web+pilot+waitlist';
  return 'operations';
}

export function environmentFor(job) {
  const labels = job.labels ?? [];
  const selfHosted = labels.includes('self-hosted');
  const distinctive = labels.filter(
    (l) => !['self-hosted', 'linux', 'x64', 'Linux', 'X64'].includes(l),
  );
  return {
    environmentClass: `${selfHosted ? 'self-hosted' : 'github-hosted'}:${distinctive.join(',') || 'default'}`,
    resourceClass: job.runner_name ? job.runner_name : 'unassigned',
  };
}

const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);

export function outcomeOf(conclusion, { resourceBlocked = false } = {}) {
  if (conclusion === 'success') return 'passed';
  if (conclusion === 'cancelled') return 'cancelled';
  if (
    conclusion === 'failure' ||
    conclusion === 'timed_out' ||
    conclusion === 'startup_failure'
  )
    return resourceBlocked ? 'resource-blocked' : 'failed';
  return 'unknown';
}

/** Records for one job: queue, job total and each executed step. */
export function jobRecords(run, job, { resourceBlocked = false } = {}) {
  const env = environmentFor(job);
  const base = {
    runId: run.id,
    sourceDigest: run.head_sha,
    workflow: run.name,
    attempt: job.run_attempt ?? run.run_attempt ?? 1,
    component: componentForJob(run.name, job.name),
    ...env,
  };
  const records = [];
  if (job.conclusion === 'skipped') return records;
  const jobOutcome = job.completed_at
    ? outcomeOf(job.conclusion, { resourceBlocked })
    : 'unknown';
  if (job.created_at) {
    const started =
      Boolean(job.started_at) &&
      Date.parse(job.started_at) >= Date.parse(job.created_at);
    records.push({
      ...base,
      name: job.name,
      stage: 'queue',
      startedAt: job.created_at,
      durationMs: started ? ms(job.created_at, job.started_at) : null,
      outcome: started ? 'passed' : jobOutcome,
    });
  }
  records.push({
    ...base,
    name: job.name,
    stage: 'job',
    startedAt: job.started_at ?? null,
    durationMs: job.completed_at ? ms(job.started_at, job.completed_at) : null,
    outcome: jobOutcome,
  });
  for (const step of job.steps ?? []) {
    if (
      step.conclusion === 'skipped' ||
      (!step.started_at &&
        step.status === 'queued' &&
        job.conclusion !== 'cancelled')
    )
      continue;
    let outcome;
    let end = step.completed_at;
    if (step.conclusion === 'cancelled') outcome = 'cancelled';
    else if (!step.completed_at || !step.conclusion) {
      // A step left open by a cancelled job closes as cancelled at the job's end;
      // otherwise its end is genuinely missing and the outcome is unknown.
      if (job.conclusion === 'cancelled' && job.completed_at) {
        outcome = 'cancelled';
        end = job.completed_at;
      } else {
        outcome = 'unknown';
        end = null;
      }
    } else outcome = outcomeOf(step.conclusion, { resourceBlocked });
    if (!step.started_at && outcome === 'cancelled') continue; // never ran
    records.push({
      ...base,
      name: `${job.name} / ${step.name}`,
      stage: classifyStage(step.name),
      startedAt: step.started_at ?? null,
      durationMs:
        end && step.started_at ? Math.max(0, ms(step.started_at, end)) : null,
      outcome,
    });
  }
  return records;
}

export function runRecord(run, jobs = [], blockedJobIds = new Set()) {
  const failedJobs = jobs.filter((j) =>
    ['failure', 'timed_out'].includes(j.conclusion),
  );
  const blocked =
    failedJobs.length > 0 && failedJobs.every((j) => blockedJobIds.has(j.id));
  const completed = run.status === 'completed';
  return {
    runId: run.id,
    sourceDigest: run.head_sha,
    workflow: run.name,
    attempt: run.run_attempt ?? 1,
    name: run.name,
    component: 'run',
    stage: 'run',
    startedAt: run.run_started_at ?? run.created_at,
    durationMs: completed
      ? ms(run.run_started_at ?? run.created_at, run.updated_at)
      : null,
    outcome: completed
      ? outcomeOf(run.conclusion, { resourceBlocked: blocked })
      : 'unknown',
    environmentClass: 'workflow',
    resourceClass: 'workflow',
    event: run.event,
  };
}

export function buildRecords(runs, jobsByRun, blockedJobIds = new Set()) {
  const records = [];
  for (const run of runs) {
    const jobs = jobsByRun.get(run.id) ?? [];
    records.push(runRecord(run, jobs, blockedJobIds));
    for (const job of jobs)
      records.push(
        ...jobRecords(run, job, { resourceBlocked: blockedJobIds.has(job.id) }),
      );
  }
  return redact(records);
}

/** Two timing records are equivalent for comparison only with the same source, environment and resources. */
export function comparable(a, b) {
  const reasons = [];
  if (a.sourceDigest !== b.sourceDigest) reasons.push('source differs');
  if (a.environmentClass !== b.environmentClass)
    reasons.push('environment differs');
  if (a.resourceClass !== b.resourceClass)
    reasons.push('resource class differs');
  if (a.component !== b.component || a.stage !== b.stage)
    reasons.push('different component or stage');
  return { equivalent: reasons.length === 0, reasons };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function stats(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    totalMs: total,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
  };
}

/** Strip matrix detail so "pilot (write thread, part 2/3)" groups with its siblings. */
export function groupName(name) {
  return String(name)
    .replace(/^test \/ /, '')
    .replace(/\((?:main|write) thread(?:, part \d+\/\d+)?\)/g, '(matrix)')
    .replace(/\s+/g, ' ')
    .trim();
}

const REPRODUCE = {
  pilot: 'ops/remote-test/run.sh --suite pilot',
  web: 'ops/remote-test/run.sh --suite site',
  'native-chain': 'ops/remote-test/native-chain.sh',
  'private-exchange': 'ops/remote-test/private-exchange.sh',
  'web+pilot+waitlist':
    'deploy.yml "Build and push the images" (docker build web, pilot, waitlist)',
  operations: 'sudo /usr/local/sbin/uain-ci-run <workspace> others',
};

function reproduceFor(group) {
  if (group.stage === 'queue')
    return 'node ops/dev/timings.mjs --days 7 (queue stage: job created to runner start)';
  if (/reset archive/.test(group.name))
    return 'sudo /usr/local/sbin/uain-ci-run <workspace> reset <thread> (tests.yml reset job)';
  if (/research vectors/.test(group.name))
    return 'sudo /usr/local/sbin/uain-ci-run <workspace> research <thread> (tests.yml research job)';
  return (
    REPRODUCE[group.component] ?? `gh run view ${group.exampleRunId} --log`
  );
}

/** Per workflow: which job most often bounds the passed run's wall time. */
export function criticalPath(records) {
  const jobsByRun = new Map();
  for (const r of records)
    if (r.stage === 'job' && Number.isFinite(r.durationMs))
      (jobsByRun.get(r.runId) ?? jobsByRun.set(r.runId, []).get(r.runId)).push(
        r,
      );
  const out = {};
  for (const run of records.filter(
    (r) => r.stage === 'run' && r.outcome === 'passed',
  )) {
    const jobs = jobsByRun.get(run.runId) ?? [];
    if (!jobs.length) continue;
    const longest = jobs.reduce((a, b) =>
      b.durationMs > a.durationMs ? b : a,
    );
    const row = (out[run.workflow] ??= {});
    const name = groupName(longest.name);
    (row[name] ??= []).push(longest.durationMs);
  }
  return Object.fromEntries(
    Object.entries(out).map(([workflow, row]) => [
      workflow,
      Object.entries(row)
        .map(([job, values]) => ({
          job,
          runs: values.length,
          ...stats(values),
        }))
        .sort((a, b) => b.runs - a.runs),
    ]),
  );
}

export function summarize(
  records,
  { top = 3, days = null, since = null } = {},
) {
  const runs = records.filter((r) => r.stage === 'run');
  const byWorkflow = {};
  for (const run of runs) {
    const row = (byWorkflow[run.workflow] ??= {
      runs: 0,
      outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
      passedWall: [],
    });
    row.runs++;
    row.outcomes[run.outcome]++;
    if (run.outcome === 'passed') row.passedWall.push(run.durationMs);
  }
  for (const row of Object.values(byWorkflow)) {
    row.passedWall = stats(row.passedWall);
  }
  const byStage = {};
  for (const r of records)
    if (r.stage !== 'run' && r.stage !== 'job')
      (byStage[r.stage] ??= []).push(r.durationMs);
  const stages = Object.fromEntries(
    Object.entries(byStage)
      .map(([stage, values]) => [stage, stats(values)])
      .sort((a, b) => b[1].totalMs - a[1].totalMs),
  );

  const groups = new Map();
  for (const r of records) {
    if (r.stage === 'run' || r.stage === 'job') continue;
    const key =
      r.stage === 'queue'
        ? `queue|${r.workflow}`
        : `${r.component}|${r.stage}|${groupName(r.name)}`;
    const g = groups.get(key) ?? {
      key,
      component: r.stage === 'queue' ? 'runner-queue' : r.component,
      stage: r.stage,
      name:
        r.stage === 'queue'
          ? `queue wait before jobs start (${r.workflow})`
          : groupName(r.name),
      values: [],
      outcomes: {},
      exampleRunId: r.runId,
    };
    g.values.push(r.durationMs);
    g.outcomes[r.outcome] = (g.outcomes[r.outcome] ?? 0) + 1;
    groups.set(key, g);
  }
  const bottlenecks = [...groups.values()]
    .map((g) => ({
      component: g.component,
      stage: g.stage,
      name: g.name,
      ...stats(g.values),
      outcomes: g.outcomes,
      reproduce: reproduceFor(g),
      exampleRunId: g.exampleRunId,
    }))
    .filter((g) => g.count > 0)
    .sort((a, b) => b.totalMs - a.totalMs);

  const blockedJobs = records.filter(
    (r) => r.stage === 'job' && r.outcome === 'resource-blocked',
  );
  const blockedRuns = runs.filter((r) => r.outcome === 'resource-blocked');
  const cancelledJobs = records.filter(
    (r) => r.stage === 'job' && r.outcome === 'cancelled',
  );
  return redact({
    schema: 'uain-run-timing-summary-v1',
    window: { days, since },
    records: records.length,
    runs: runs.length,
    byWorkflow,
    stages,
    topBottlenecks: bottlenecks.slice(0, top),
    bottlenecks: bottlenecks.slice(0, Math.max(top, 15)),
    resourceBlocked: {
      runs: blockedRuns.length,
      jobs: blockedJobs.length,
      jobMinutes:
        Math.round(
          blockedJobs.reduce((s, r) => s + (r.durationMs ?? 0), 0) / 600,
        ) / 100,
      lastStartedAt:
        blockedJobs
          .map((r) => r.startedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
    },
    cancelled: {
      jobs: cancelledJobs.length,
      jobMinutes:
        Math.round(
          cancelledJobs.reduce((s, r) => s + (r.durationMs ?? 0), 0) / 600,
        ) / 100,
    },
    unknownOutcomes: records.filter((r) => r.outcome === 'unknown').length,
    criticalPath: criticalPath(records),
  });
}

const minutes = (value) =>
  value == null ? 'n/a' : `${(value / 60000).toFixed(2)} min`;

export function formatSummary(summary) {
  const lines = [
    `GitHub Actions timings: ${summary.runs} runs, ${summary.records} records${summary.window.since ? ` since ${summary.window.since}` : ''}`,
  ];
  lines.push('Workflows (passed wall time median / p95):');
  for (const [name, row] of Object.entries(summary.byWorkflow)) {
    const counts = Object.entries(row.outcomes)
      .filter(([, n]) => n)
      .map(([o, n]) => `${o} ${n}`)
      .join(', ');
    lines.push(
      `  ${name}: ${row.runs} runs (${counts}); ${minutes(row.passedWall.medianMs)} / ${minutes(row.passedWall.p95Ms)}`,
    );
  }
  lines.push('Stages (total / median / p95, count):');
  for (const [stage, s] of Object.entries(summary.stages))
    lines.push(
      `  ${stage}: ${minutes(s.totalMs)} / ${minutes(s.medianMs)} / ${minutes(s.p95Ms)} (${s.count})`,
    );
  lines.push(`Top ${summary.topBottlenecks.length} bottlenecks by total time:`);
  summary.topBottlenecks.forEach((b, i) =>
    lines.push(
      `  ${i + 1}. [${b.component}/${b.stage}] ${b.name}: total ${minutes(b.totalMs)}, median ${minutes(b.medianMs)}, p95 ${minutes(b.p95Ms)}, n=${b.count}; reproduce: ${b.reproduce}`,
    ),
  );
  lines.push('Critical path (longest job in passed runs):');
  for (const [workflow, rows] of Object.entries(summary.criticalPath ?? {}))
    for (const row of rows.slice(0, 2))
      lines.push(
        `  ${workflow}: ${row.job} in ${row.runs} runs, median ${minutes(row.medianMs)}`,
      );
  lines.push(
    `Resource-blocked: ${summary.resourceBlocked.runs} runs, ${summary.resourceBlocked.jobs} jobs, ${summary.resourceBlocked.jobMinutes} job-minutes. Cancelled jobs: ${summary.cancelled.jobs} (${summary.cancelled.jobMinutes} min). Unknown outcomes: ${summary.unknownOutcomes}.`,
  );
  return lines.join('\n');
}

function gh(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { maxBuffer, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `gh ${args.slice(0, 2).join(' ')} failed: ${redact(String(stderr || error.message)).slice(0, 300)}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

const jsonLines = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

async function pool(items, size, fn) {
  const out = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function exportTimings({
  repo,
  days = 7,
  maxLogs = 60,
  logs = true,
  now = new Date(),
} = {}) {
  const since =
    new Date(now.getTime() - days * 86400000).toISOString().slice(0, 19) + 'Z';
  const runs = jsonLines(
    await gh([
      'api',
      '--paginate',
      '-X',
      'GET',
      `repos/${repo}/actions/runs`,
      '-f',
      'per_page=100',
      '-f',
      `created=>=${since}`,
      '--jq',
      '.workflow_runs[] | {id, name, event, status, conclusion, head_sha, created_at, run_started_at, updated_at, run_attempt}',
    ]),
  );
  const jobsByRun = new Map();
  await pool(runs, 6, async (run) => {
    const jobs = jsonLines(
      await gh([
        'api',
        '--paginate',
        `repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
        '--jq',
        '.jobs[] | {id, name, status, conclusion, created_at, started_at, completed_at, runner_name, labels, run_attempt, steps}',
      ]),
    );
    jobsByRun.set(run.id, jobs);
  });
  const blocked = new Set();
  let scanned = 0;
  if (logs) {
    const failedJobs = [...jobsByRun.values()]
      .flat()
      .filter((j) => ['failure', 'timed_out'].includes(j.conclusion))
      .sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at))
      .slice(0, maxLogs);
    await pool(failedJobs, 4, async (job) => {
      try {
        const text = await gh([
          'api',
          `repos/${repo}/actions/jobs/${job.id}/logs`,
        ]);
        scanned++;
        if (RESOURCE_GUARD.test(text)) blocked.add(job.id);
      } catch {
        // Expired or unavailable logs leave the job classified as failed.
      }
    });
  }
  const records = buildRecords(runs, jobsByRun, blocked);
  return { since, records, logsScanned: scanned };
}

async function defaultRepo() {
  return (
    await gh([
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '-q',
      '.nameWithOwner',
    ])
  ).trim();
}

async function main(argv) {
  const value = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const days = Number(value('--days', 7));
  const top = Number(value('--top', 3));
  const repo = value('--repo') ?? (await defaultRepo());
  const { since, records, logsScanned } = await exportTimings({
    repo,
    days,
    maxLogs: Number(value('--max-logs', 60)),
    logs: !argv.includes('--no-logs'),
  });
  const summary = {
    ...summarize(records, { top, days, since }),
    repo,
    generatedAt: new Date().toISOString(),
    logsScanned,
  };
  if (value('--out'))
    writeFileSync(value('--out'), JSON.stringify(records, null, 2) + '\n');
  if (value('--summary-out'))
    writeFileSync(
      value('--summary-out'),
      JSON.stringify(summary, null, 2) + '\n',
    );
  process.stdout.write(
    (argv.includes('--json')
      ? JSON.stringify(summary, null, 2)
      : formatSummary(summary)) + '\n',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(redact(error.message));
    process.exit(1);
  });
}
