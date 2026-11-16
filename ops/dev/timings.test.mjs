import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecords,
  jobRecords,
  summarize,
  formatSummary,
  comparable,
  classifyStage,
  componentForJob,
  redact,
  OUTCOMES,
  RESOURCE_GUARD,
} from './timings.mjs';

const run = (over = {}) => ({
  id: 1,
  name: 'Pull request checks',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_sha: 'a'.repeat(40),
  created_at: '2026-11-06T10:00:00Z',
  run_started_at: '2026-11-06T10:00:00Z',
  updated_at: '2026-11-06T10:12:00Z',
  run_attempt: 1,
  ...over,
});
const job = (over = {}) => ({
  id: 11,
  name: 'test / pilot (main thread, part 1/3)',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-06T10:00:00Z',
  started_at: '2026-11-06T10:01:00Z',
  completed_at: '2026-11-06T10:05:00Z',
  runner_name: 'uain-ci-2',
  labels: ['self-hosted', 'linux', 'x64', 'uain-production'],
  run_attempt: 1,
  steps: [
    {
      name: 'Set up job',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-11-06T10:01:00Z',
      completed_at: '2026-11-06T10:01:02Z',
    },
    {
      name: 'Require trusted repository source',
      status: 'completed',
      conclusion: 'skipped',
      started_at: '2026-11-06T10:01:02Z',
      completed_at: '2026-11-06T10:01:02Z',
    },
    {
      name: 'Test the connection server in an isolated container',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-11-06T10:01:02Z',
      completed_at: '2026-11-06T10:05:00Z',
    },
  ],
  ...over,
});
const FIELDS = [
  'runId',
  'sourceDigest',
  'component',
  'stage',
  'startedAt',
  'durationMs',
  'outcome',
  'environmentClass',
  'resourceClass',
];

test('records carry the RunTiming contract and allowed outcomes only', () => {
  const records = buildRecords([run()], new Map([[1, [job()]]]));
  for (const record of records) {
    for (const field of FIELDS) assert.ok(field in record, `${field} missing`);
    assert.ok(OUTCOMES.includes(record.outcome), record.outcome);
  }
  const queue = records.find((r) => r.stage === 'queue');
  assert.equal(queue.durationMs, 60000);
  const test_ = records.find((r) => r.stage === 'test');
  assert.equal(test_.component, 'pilot');
  assert.equal(test_.outcome, 'passed');
  assert.equal(test_.environmentClass, 'self-hosted:uain-production');
  assert.equal(test_.resourceClass, 'uain-ci-2');
  assert.ok(
    !records.some((r) => r.name.includes('Require trusted')),
    'skipped steps are not timed',
  );
});

test('cancelled stage closes as cancelled, never failed or unknown', () => {
  const cancelled = job({
    conclusion: 'cancelled',
    completed_at: '2026-11-06T10:04:00Z',
    steps: [
      {
        name: 'Set up job',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-06T10:01:00Z',
        completed_at: '2026-11-06T10:01:02Z',
      },
      {
        name: 'Test the connection server in an isolated container',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-11-06T10:01:02Z',
        completed_at: null,
      },
      {
        name: 'Post Run actions/checkout@v4',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: '2026-11-06T10:04:00Z',
        completed_at: '2026-11-06T10:04:00Z',
      },
    ],
  });
  const records = jobRecords(run({ conclusion: 'cancelled' }), cancelled, {
    resourceBlocked: true,
  });
  const step = records.find((r) => r.stage === 'test');
  assert.equal(step.outcome, 'cancelled');
  assert.equal(step.durationMs, 178000, 'closed at the cancelled job end');
  assert.equal(
    records.find((r) => r.stage === 'job').outcome,
    'cancelled',
    'a guard marker does not turn cancellation into a block',
  );
  assert.equal(records.find((r) => r.stage === 'cleanup').outcome, 'cancelled');
});

test('missing end time is unknown with no invented duration', () => {
  const open = job({
    status: 'in_progress',
    conclusion: null,
    completed_at: null,
    steps: [
      {
        name: 'Test the connection server in an isolated container',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-11-06T10:01:02Z',
        completed_at: null,
      },
    ],
  });
  const records = jobRecords(
    run({ status: 'in_progress', conclusion: null }),
    open,
  );
  const step = records.find((r) => r.stage === 'test');
  assert.equal(step.outcome, 'unknown');
  assert.equal(step.durationMs, null);
  const total = records.find((r) => r.stage === 'job');
  assert.equal(total.outcome, 'unknown');
  assert.equal(total.durationMs, null);
  const [runRecord] = buildRecords(
    [run({ status: 'in_progress', conclusion: null })],
    new Map([[1, [open]]]),
  );
  assert.equal(runRecord.outcome, 'unknown');
  assert.equal(runRecord.durationMs, null);
});

test('a failed shared-host admission is resource-blocked, not a test failure', () => {
  assert.ok(
    RESOURCE_GUARD.test(
      '2026-11-06T10:13:53Z Shared-host guard failed: Shared disk reserve failed: 99.92 GiB',
    ),
  );
  const failed = job({
    conclusion: 'failure',
    steps: [
      {
        name: 'Test the connection server in an isolated container',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-11-06T10:01:02Z',
        completed_at: '2026-11-06T10:02:00Z',
      },
    ],
  });
  const records = buildRecords(
    [run({ conclusion: 'failure' })],
    new Map([[1, [failed]]]),
    new Set([11]),
  );
  assert.equal(
    records.find((r) => r.stage === 'run').outcome,
    'resource-blocked',
  );
  assert.equal(
    records.find((r) => r.stage === 'job').outcome,
    'resource-blocked',
  );
  assert.equal(
    records.find((r) => r.stage === 'test').outcome,
    'resource-blocked',
  );
  const genuine = buildRecords(
    [run({ conclusion: 'failure' })],
    new Map([[1, [failed]]]),
  );
  assert.equal(genuine.find((r) => r.stage === 'run').outcome, 'failed');
});

test('secrets do not enter records or the summary', () => {
  const secrets = [
    'ghp_' + 'A'.repeat(36),
    'github_pat_' + 'B'.repeat(40),
    'sk-' + 'c'.repeat(30),
    'AKIA' + 'D'.repeat(16),
    'hunter2-db-password',
  ];
  const leaky = job({
    name: `deploy with token ${secrets[0]}`,
    runner_name: `runner ${secrets[1]}`,
    steps: [
      {
        name: `Write the uain-env secret password=${secrets[4]}`,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-06T10:01:02Z',
        completed_at: '2026-11-06T10:02:00Z',
      },
      {
        name: `Call https://user:${secrets[4]}@db.example/x with ${secrets[2]} and ${secrets[3]}`,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-11-06T10:02:00Z',
        completed_at: '2026-11-06T10:03:00Z',
      },
    ],
  });
  const records = buildRecords(
    [run({ name: `Deploy UAIN Bearer ${'e'.repeat(30)}` })],
    new Map([[1, [leaky]]]),
  );
  const summary = summarize(records, { top: 10 });
  const text =
    JSON.stringify(records) + JSON.stringify(summary) + formatSummary(summary);
  for (const secret of [...secrets, 'e'.repeat(30)])
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 8)}`);
  assert.equal(redact('plain step name'), 'plain step name');
});

test('environment or source mismatch prevents an equivalent comparison', () => {
  const [a] = buildRecords([run()], new Map([[1, [job()]]])).filter(
    (r) => r.stage === 'test',
  );
  assert.deepEqual(comparable(a, { ...a }), { equivalent: true, reasons: [] });
  assert.equal(
    comparable(a, { ...a, sourceDigest: 'b'.repeat(40) }).equivalent,
    false,
  );
  assert.equal(
    comparable(a, { ...a, environmentClass: 'github-hosted:ubuntu-latest' })
      .equivalent,
    false,
  );
  assert.equal(
    comparable(a, { ...a, resourceClass: 'uain-production' }).equivalent,
    false,
  );
});

test('stage and component classification of the real workflow step names', () => {
  assert.equal(classifyStage('Run actions/checkout@v4'), 'setup');
  assert.equal(
    classifyStage('Typecheck and site build in an isolated container'),
    'build',
  );
  assert.equal(classifyStage('Build and push the images'), 'build');
  assert.equal(
    classifyStage(
      'Complete schema reset and archive restore in an isolated container',
    ),
    'test',
  );
  assert.equal(
    classifyStage('Verify registry manifests and complete layer bytes'),
    'verification',
  );
  assert.equal(classifyStage('Apply the manifest'), 'activation');
  assert.equal(classifyStage('Prune untagged images'), 'cleanup');
  assert.equal(componentForJob('Deploy UAIN', 'deploy'), 'web+pilot+waitlist');
  assert.equal(componentForJob('Pull request checks', 'Site build'), 'web');
  assert.equal(
    componentForJob('UAIN sovereign chain', 'private-exchange'),
    'private-exchange',
  );
  assert.equal(
    componentForJob(
      'Deploy UAIN',
      'test / reset archive and complete schema (write thread)',
    ),
    'pilot',
  );
});

test('summary ranks bottlenecks by total time and groups matrix shards', () => {
  const jobs = [1, 2, 3].map((shard) =>
    job({
      id: 10 + shard,
      name: `test / pilot (write thread, part ${shard}/3)`,
    }),
  );
  jobs.push(
    job({
      id: 20,
      name: 'Site build',
      steps: [
        {
          name: 'Typecheck and site build in an isolated container',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-06T10:01:00Z',
          completed_at: '2026-11-06T10:02:00Z',
        },
      ],
    }),
  );
  const summary = summarize(buildRecords([run()], new Map([[1, jobs]])), {
    top: 2,
  });
  assert.equal(summary.topBottlenecks.length, 2);
  assert.equal(
    summary.topBottlenecks[0].name,
    'pilot (matrix) / Test the connection server in an isolated container',
  );
  assert.equal(summary.topBottlenecks[0].count, 3);
  assert.ok(
    summary.topBottlenecks[0].reproduce.includes('ops/remote-test/run.sh'),
  );
  assert.equal(summary.byWorkflow['Pull request checks'].outcomes.passed, 1);
});
