import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  satisfies,
  describeDatabaseUrl,
  checksFor,
  runDoctor,
} from './doctor.mjs';
import { loadManifest } from './impact.mjs';

test('engine range comparison', () => {
  assert.equal(satisfies('22.13.0', '>=22.13.0'), true);
  assert.equal(satisfies('v22.18.0', '>=22.13.0'), true);
  assert.equal(satisfies('23.0.0', '>=22.13.0'), true);
  assert.equal(satisfies('22.12.9', '>=22.13.0'), false);
  assert.equal(satisfies('20.19.0', '>=22.13.0'), false);
  assert.equal(satisfies('22.0.0', '^22'), null);
});

test('database URL is described without credentials', () => {
  const described = describeDatabaseUrl(
    'postgres://uain_local_test:sup3r-secret@127.0.0.1:55432/uain_local_test',
  );
  assert.deepEqual(described, {
    host: '127.0.0.1',
    port: 55432,
    database: 'uain_local_test',
    hasPassword: true,
  });
  assert.ok(!JSON.stringify(described).includes('sup3r-secret'));
  assert.equal(describeDatabaseUrl('not a url'), null);
});

test('--component limits the checks to the manifest doctor list', () => {
  const manifest = loadManifest();
  for (const [name, component] of Object.entries(manifest.components)) {
    assert.ok(
      Array.isArray(component.doctor) && component.doctor.length,
      `${name} lists doctor checks`,
    );
    assert.deepEqual(checksFor(name, manifest), component.doctor);
  }
  assert.ok(checksFor('pilot').includes('postgres'));
  assert.ok(!checksFor('baink-app').includes('ssh-remote'));
  assert.ok(checksFor().includes('ssh-remote'));
  assert.throws(() => checksFor('no-such-component'), /Unknown component/);
});

test('postgres check never prints the password and gives a remedy when unreachable', async () => {
  const saved = process.env.DATABASE_URL;
  // Reserve a free port, then close it so the connection is refused.
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  try {
    process.env.DATABASE_URL = `postgres://someone:do-not-print-me@127.0.0.1:${port}/other_db`;
    const [other] = await runDoctor(['postgres']);
    assert.equal(
      other.status,
      'warn',
      'doctor does not connect to non-test databases',
    );
    assert.ok(!JSON.stringify(other).includes('do-not-print-me'));
    assert.ok(other.remedy);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test('every failing or warning check carries a remedy', async () => {
  const results = await runDoctor([
    'node',
    'python3',
    'flock',
    'deps:.',
    'deps:services/pilot',
    'go',
    'rustc',
  ]);
  for (const result of results) {
    assert.ok(['ok', 'warn', 'fail'].includes(result.status));
    if (result.status !== 'ok')
      assert.ok(result.remedy, `${result.check} needs a remedy`);
  }
  await assert.rejects(runDoctor(['no-such-check']), /Unknown doctor check/);
});
