import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, findSecrets, main, observe } from './render-status.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const BAINK_A = '20261106T093354Z-40552e7ba4';
const BAINK_B = '20261106T095448Z-3bfb533803';

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function record(overrides = {}) {
  return {
    schema: 1,
    component: 'baink',
    release_id: BAINK_B,
    version: '0.3.32',
    source_commit: null,
    deployed_at: '2026-11-06T10:00:00Z',
    prior: BAINK_A,
    status: 'publicly-verified',
    evidence: ['CHANGELOG.md'],
    ...overrides,
  };
}

function fixture({
  records = [
    record(),
    record({
      release_id: BAINK_A,
      version: '0.3.31',
      prior: null,
      status: 'deployed',
    }),
  ],
  current = { baink: BAINK_B },
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-status-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n');
  fs.mkdirSync(path.join(root, 'docs/releases/baink'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/releases/uain'), { recursive: true });
  for (const r of records) {
    const dir = path.join(root, 'docs/releases', r.component);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${r.release_id}.json`),
      `${JSON.stringify(r, null, 2)}\n`,
    );
  }
  fs.writeFileSync(
    path.join(root, 'docs/releases/current.json'),
    JSON.stringify({ schema: 1, current }),
  );
  return root;
}

// Tables are padded for the formatter; compare with runs of spaces collapsed.
const squash = (text) => text.replace(/ {2,}/g, ' ');

function sink() {
  let text = '';
  return {
    write: (s) => (text += s),
    get text() {
      return text;
    },
  };
}

async function run(root, args = [], options = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(['--root', root, ...args], {
    stdout,
    stderr,
    ...options,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('output is deterministic and idempotent', async () => {
  const root = fixture();
  const first = await run(root);
  assert.equal(first.code, 0);
  const bytes = fs.readFileSync(
    path.join(root, 'docs/releases/CURRENT.md'),
    'utf8',
  );
  const stat = fs.statSync(path.join(root, 'docs/releases/CURRENT.md')).mtimeMs;
  const second = await run(root);
  assert.equal(second.code, 0);
  assert.match(second.stdout, /unchanged/);
  assert.equal(
    fs.readFileSync(path.join(root, 'docs/releases/CURRENT.md'), 'utf8'),
    bytes,
  );
  assert.equal(
    fs.statSync(path.join(root, 'docs/releases/CURRENT.md')).mtimeMs,
    stat,
  );
  assert.equal(build(root), bytes);
  assert.match(bytes, /^<!-- GENERATED FILE\. Do not edit\./);
  assert.match(
    squash(bytes),
    /\| baink \| `20261106T095448Z-3bfb533803` \| 0\.3\.32 \| publicly-verified \|/,
  );
});

test('record file order does not change the output', async () => {
  const a = fixture();
  const b = fixture({
    records: [
      record({
        release_id: BAINK_A,
        version: '0.3.31',
        prior: null,
        status: 'deployed',
      }),
      record(),
    ],
  });
  assert.equal(build(a), build(b));
});

test('--check passes when current and fails when stale or missing', async () => {
  const root = fixture();
  assert.equal((await run(root, ['--check'])).code, 1, 'missing file is stale');
  await run(root);
  assert.equal((await run(root, ['--check'])).code, 0);
  fs.appendFileSync(path.join(root, 'docs/releases/CURRENT.md'), 'hand edit\n');
  const stale = await run(root, ['--check']);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /out of date/);
});

test("the repository's own CURRENT.md is up to date", async () => {
  const result = await run(repoRoot, ['--check']);
  assert.equal(result.code, 0, result.stderr);
});

test('a current pointer to an absent release is refused', async () => {
  const root = fixture({ current: { baink: '20261106T104129Z-bf251ab148' } });
  const result = await run(root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /has no record/);
  assert.equal(
    fs.existsSync(path.join(root, 'docs/releases/CURRENT.md')),
    false,
  );
});

test('a current pointer to a staged or rolled-back release is refused', async () => {
  for (const status of ['staged', 'rolled-back']) {
    const root = fixture({ records: [record({ status })] });
    const result = await run(root);
    assert.equal(result.code, 2);
    assert.match(result.stderr, new RegExp(`recorded status is ${status}`));
  }
});

test('statuses outside the schema, such as test results, are refused', async () => {
  for (const status of ['tests-passed', 'live', 'done']) {
    const result = await run(fixture({ records: [record({ status })] }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /is not one of/);
  }
  const extra = await run(
    fixture({ records: [record({ tests: '1146 pass' })] }),
  );
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /unknown field tests/);
});

test('records must be stored under their own id and point at existing evidence', async () => {
  const root = fixture();
  fs.renameSync(
    path.join(root, `docs/releases/baink/${BAINK_A}.json`),
    path.join(root, 'docs/releases/baink/20261101T000000Z-0000000000.json'),
  );
  assert.match(
    (await run(root)).stderr,
    /must be stored as baink\/20261106T093354Z-40552e7ba4\.json/,
  );
  const missing = await run(
    fixture({ records: [record({ evidence: ['docs/nowhere.md'] })] }),
  );
  assert.match(missing.stderr, /does not exist/);
  const empty = await run(fixture({ records: [record({ evidence: [] })] }));
  assert.match(empty.stderr, /non-empty/);
  const escape = await run(
    fixture({ records: [record({ evidence: ['../outside.md'] })] }),
  );
  assert.match(escape.stderr, /repository-relative/);
});

test('secret-like content in a record is refused', async () => {
  const samples = [
    '-----BEGIN PRIVATE KEY-----MIIEv',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'BEGIN PRIVATE KEY',
    'key sk-abcdefghijklmnop1234',
    'Authorization: Bearer abcdefgh12345678',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-1234567890-abcdefghij',
    'AKIAABCDEFGHIJKLMNOP',
    'token=abcdef1234567890',
    'password: hunter2hunter2',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ];
  for (const sample of samples) {
    assert.ok(findSecrets(sample).length > 0, `not detected: ${sample}`);
    const result = await run(fixture({ records: [record({ note: sample })] }));
    assert.equal(result.code, 2, sample);
    assert.match(result.stderr, /looks like it contains a secret/);
    assert.doesNotMatch(
      result.stderr,
      /hunter2|abcdefgh12345678/,
      'the secret itself is not echoed',
    );
  }
  // Ordinary release facts are not mistaken for secrets.
  for (const benign of [
    BAINK_B,
    'archive SHA256 9f6f7180b6864ef5d2c188f40a5b76f34422cef148914ac1d353499554e990b4',
    'disk-floor task-501 tokens counted',
  ]) {
    assert.deepEqual(findSecrets(benign), [], benign);
  }
});

test("the repository's own records contain no secrets", () => {
  for (const dir of [
    'docs/releases',
    'docs/releases/baink',
    'docs/releases/uain',
  ]) {
    for (const file of fs.readdirSync(path.join(repoRoot, dir))) {
      if (!file.endsWith('.json')) continue;
      assert.deepEqual(
        findSecrets(fs.readFileSync(path.join(repoRoot, dir, file), 'utf8')),
        [],
        file,
      );
    }
  }
});

test('without an observation the live column stays unknown, whatever the record says', async () => {
  const root = fixture();
  await run(root);
  const text = fs.readFileSync(
    path.join(root, 'docs/releases/CURRENT.md'),
    'utf8',
  );
  assert.match(
    squash(text),
    /\| baink \| not observed \| unknown \| unknown \|/,
  );
  assert.match(
    squash(text),
    /\| uain \| not observed \| unknown \| unknown \|/,
  );
});

// `uain` is observed from the build ids its two images serve (10 November 2026).
const WEB_BUILD = 'https://uain.global/build.json';
const PILOT_BUILD = 'https://uain.global/api/build';
const buildBody = (component, commit, built_at) =>
  JSON.stringify({ schema: 1, component, commit, built_at });
const builds = (bodies) => async (url) => {
  const body = bodies[url];
  if (body === undefined) throw new TypeError('fetch failed');
  if (typeof body === 'number') return { status: body, text: async () => '' };
  return { status: 200, text: async () => body };
};

test('uain is observed as the commit of the image built last', async () => {
  const now = () => new Date('2026-11-10T12:00:00Z');
  const older = 'a1'.repeat(20);
  const newer = 'b2'.repeat(20);
  // A deploy that rebuilt only the connection server: the website keeps its older commit.
  let obs = await observe('uain', {
    now,
    fetchImpl: builds({
      [WEB_BUILD]: buildBody('uain-web', older, '2026-11-10T08:00:00Z'),
      [PILOT_BUILD]: buildBody('uain-pilot', newer, '2026-11-10T11:00:00Z'),
    }),
  });
  assert.deepEqual(obs, {
    schema: 1,
    component: 'uain',
    url: PILOT_BUILD,
    observed_at: '2026-11-10T12:00:00Z',
    observed: newer.slice(0, 8),
  });
  // And the other way round.
  obs = await observe('uain', {
    now,
    fetchImpl: builds({
      [WEB_BUILD]: buildBody('uain-web', newer, '2026-11-10T11:00:00Z'),
      [PILOT_BUILD]: buildBody('uain-pilot', older, '2026-11-10T08:00:00Z'),
    }),
  });
  assert.equal(obs.observed, newer.slice(0, 8));
  assert.equal(obs.url, WEB_BUILD);
});

test('uain stays unknown unless both images answer with a commit', async () => {
  const now = () => new Date('2026-11-10T12:00:00Z');
  const commit = 'c3'.repeat(20);
  const at = '2026-11-10T11:00:00Z';
  const good = buildBody('uain-web', commit, at);
  const cases = [
    [{ [WEB_BUILD]: good }, 'request_failed', PILOT_BUILD],
    [{ [WEB_BUILD]: 404, [PILOT_BUILD]: good }, 'http_404', WEB_BUILD],
    [{ [WEB_BUILD]: good, [PILOT_BUILD]: 503 }, 'http_503', PILOT_BUILD],
    [
      { [WEB_BUILD]: good, [PILOT_BUILD]: '<html>not json</html>' },
      'build_id_missing_or_invalid',
      PILOT_BUILD,
    ],
    [
      { [WEB_BUILD]: buildBody('uain-web', null, at), [PILOT_BUILD]: good },
      'commit_not_in_image',
      WEB_BUILD,
    ],
    [
      {
        [WEB_BUILD]: good,
        [PILOT_BUILD]: buildBody('uain-pilot', 'C3'.repeat(20), at),
      },
      'build_id_missing_or_invalid',
      PILOT_BUILD,
    ],
    [
      { [WEB_BUILD]: good, [PILOT_BUILD]: `${good}${' '.repeat(5000)}` },
      'build_id_missing_or_invalid',
      PILOT_BUILD,
    ],
  ];
  for (const [bodies, error, url] of cases) {
    const obs = await observe('uain', { now, fetchImpl: builds(bodies) });
    assert.equal(obs.observed, 'unknown', error);
    assert.equal(obs.error, error);
    assert.equal(obs.url, url);
  }
});

test('an observed uain build is compared with the pointer in the generated view', async () => {
  const now = () => new Date('2026-11-10T12:00:00Z');
  const commit = 'd4'.repeat(20);
  const id = commit.slice(0, 8);
  const uain = record({
    component: 'uain',
    release_id: id,
    version: null,
    source_commit: commit,
    prior: null,
    status: 'deployed',
  });
  const root = fixture({
    records: [record({ prior: null }), uain],
    current: { baink: BAINK_B, uain: id },
  });
  const both = builds({
    [WEB_BUILD]: buildBody('uain-web', commit, '2026-11-10T11:00:00Z'),
    [PILOT_BUILD]: buildBody('uain-pilot', commit, '2026-11-10T11:01:00Z'),
  });
  const fetchImpl = async (url, init) =>
    url.startsWith('https://uain.global/')
      ? both(url, init)
      : { status: 200, headers: new Headers({ 'x-baink-release': BAINK_B }) };
  const result = await run(root, ['--observe'], { fetchImpl, now });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`uain: observed ${id}`));
  const text = squash(
    fs.readFileSync(path.join(root, 'docs/releases/CURRENT.md'), 'utf8'),
  );
  assert.ok(
    text.includes(`| uain | 2026-11-10T12:00:00Z | \`${id}\` | yes |`),
    text,
  );
  assert.equal((await run(root, ['--check'])).code, 0);
});

test('a failed observation is recorded as unknown', async () => {
  const now = () => new Date('2026-11-06T11:00:00.123Z');
  const failures = [
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => ({
      status: 503,
      headers: new Headers({ 'x-baink-release': BAINK_B }),
    }),
    async () => ({ status: 200, headers: new Headers() }),
    async () => ({
      status: 200,
      headers: new Headers({ 'x-baink-release': 'not-a-release' }),
    }),
  ];
  for (const fetchImpl of failures) {
    const obs = await observe('baink', { fetchImpl, now });
    assert.equal(obs.observed, 'unknown');
    assert.equal(obs.observed_at, '2026-11-06T11:00:00Z');
    assert.ok(obs.error);
  }
  const root = fixture();
  const result = await run(root, ['--observe'], {
    fetchImpl: failures[0],
    now,
  });
  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(
    path.join(root, 'docs/releases/CURRENT.md'),
    'utf8',
  );
  assert.match(
    squash(text),
    /\| baink \| 2026-11-06T11:00:00Z \| unknown \| unknown \|/,
  );
  // The saved observation renders the same way on a later plain run.
  assert.equal((await run(root, ['--check'])).code, 0);
});

test('a successful observation is compared with the pointer, not substituted for it', async () => {
  const now = () => new Date('2026-11-06T11:00:00Z');
  const other = '20261106T104129Z-bf251ab148';
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers({ 'x-baink-release': other }),
  });
  const root = fixture();
  assert.equal((await run(root, ['--observe'], { fetchImpl, now })).code, 0);
  const text = fs.readFileSync(
    path.join(root, 'docs/releases/CURRENT.md'),
    'utf8',
  );
  assert.match(
    squash(text),
    new RegExp(
      `\\| baink \\| 2026-11-06T11:00:00Z \\| \`${other}\` \\| no \\|`,
    ),
  );
  assert.match(
    squash(text),
    /\| baink \| `20261106T095448Z-3bfb533803` \| 0\.3\.32 \|/,
  );
  const same = async () => ({
    status: 200,
    headers: new Headers({ 'x-baink-release': BAINK_B }),
  });
  await run(root, ['--observe'], { fetchImpl: same, now });
  assert.match(
    squash(
      fs.readFileSync(path.join(root, 'docs/releases/CURRENT.md'), 'utf8'),
    ),
    /\| yes \|/,
  );
});

test('--observe does not write anything when the records are invalid', async () => {
  const root = fixture({ current: { baink: '20261106T104129Z-bf251ab148' } });
  let called = false;
  const result = await run(root, ['--observe'], {
    fetchImpl: async () => {
      called = true;
      return { status: 200, headers: new Headers() };
    },
  });
  assert.equal(result.code, 2);
  assert.equal(called, false);
  assert.equal(
    fs.existsSync(path.join(root, 'docs/releases/observations')),
    false,
  );
});

for (const [component, id] of [['central-reviewer', 'a'.repeat(64)], ['organizations', 'b'.repeat(40)], ['organizations', 'b'.repeat(64)], ['house-solver', 'd'.repeat(64)], ['controlled-holder', 'e'.repeat(64)], ['project-planning', 'f'.repeat(64)], ['organization-starter', '1a'.repeat(32)], ['private-review-broker', '7b'.repeat(32)], ['trade-steward', '9c'.repeat(32)], ['private-payment-service', '5d'.repeat(32)]]) {
  test(`${component} supports immutable release records and an optional current pointer`, async () => {
    const r = record({ component, release_id: id, prior: null, version: null, source_commit: 'c'.repeat(40), status: 'deployed' });
    const root = fixture({ records: [r], current: { [component]: id } });
    const text = squash(build(root));
    assert.match(text, new RegExp(`\\| ${component} \\| \`${id}\` \\| n/a \\| deployed \\|`));
    assert.match(text, new RegExp(`\\| ${component} \\| not observable \\| unknown \\| unknown \\|`));
    await assert.rejects(observe(component), /no live observation source/);
    const pointers = path.join(root, 'docs/releases/current.json');
    fs.writeFileSync(pointers, JSON.stringify({ schema: 1, current: {} }));
    assert.match(build(root), new RegExp(`${id}.*deployed`));
  });
  test(`${component} refuses wrong identifier lengths and inactive current releases`, () => {
    for (const bad of [id.slice(1), id + '0', id.toUpperCase()]) {
      const root = fixture({ records: [record({ component, release_id: bad, prior: null })], current: {} });
      assert.throws(() => build(root), /does not match/);
    }
    const root = fixture({ records: [record({ component, release_id: id, prior: null, status: 'staged' })], current: { [component]: id } });
    assert.throws(() => build(root), /recorded status is staged/);
  });
}
