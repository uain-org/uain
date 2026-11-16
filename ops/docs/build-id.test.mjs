import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildId, main } from './build-id.mjs';
// The reader lives with the observer; what one writes the other must read.
import { parseBuildId } from './render-status.mjs';

const now = () => new Date('2026-11-10T09:30:15.250Z');
const commit = '0123456789abcdef0123456789abcdef01234567';

test('a build id carries the commit it was given, or says it has none', () => {
  assert.deepEqual(
    buildId('uain-web', { env: { UAIN_SOURCE_COMMIT: commit }, now }),
    {
      schema: 1,
      component: 'uain-web',
      commit,
      built_at: '2026-11-10T09:30:15Z',
    },
  );
  for (const env of [
    {},
    { UAIN_SOURCE_COMMIT: '' },
    { UAIN_SOURCE_COMMIT: 'main' },
    { UAIN_SOURCE_COMMIT: commit.slice(1) },
    { UAIN_SOURCE_COMMIT: commit.toUpperCase() },
  ])
    assert.equal(buildId('uain-pilot', { env, now }).commit, null);
  assert.throws(() => buildId('Not A Name', { env: {}, now }), /component/);
  assert.throws(() => buildId(undefined, { env: {}, now }), /component/);
});

test('a written build id reads back, and anything else does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-id-'));
  try {
    const file = path.join(dir, 'nested', 'build.json');
    const stderr = {
      text: '',
      write(s) {
        this.text += s;
      },
    };
    assert.equal(
      main(['uain-web', file], {
        env: { UAIN_SOURCE_COMMIT: commit },
        now,
        stderr,
      }),
      0,
    );
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.length < 1024, 'stays under the size nginx precompresses');
    assert.deepEqual(parseBuildId(text), {
      component: 'uain-web',
      commit,
      built_at: '2026-11-10T09:30:15Z',
    });
    assert.equal(stderr.text, '');
    // No commit given: still a valid build id, with commit null and no guess.
    assert.equal(main(['uain-web', file], { env: {}, now, stderr }), 0);
    assert.deepEqual(parseBuildId(fs.readFileSync(file, 'utf8')), {
      component: 'uain-web',
      commit: null,
      built_at: '2026-11-10T09:30:15Z',
    });
    // A malformed commit is reported and never written.
    assert.equal(
      main(['uain-web', file], {
        env: { UAIN_SOURCE_COMMIT: 'HEAD' },
        now,
        stderr,
      }),
      0,
    );
    assert.match(stderr.text, /not a 40-hex commit/);
    assert.equal(parseBuildId(fs.readFileSync(file, 'utf8')).commit, null);
    assert.equal(main(['uain-web'], { env: {}, now, stderr }), 2);
    assert.equal(main(['Bad Name', file], { env: {}, now, stderr }), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const at = '"built_at":"2026-11-10T09:30:15Z"';
  for (const bad of [
    '',
    'null',
    '[]',
    '<html>',
    `{"schema":2,"component":"uain-web","commit":null,${at}}`,
    `{"schema":1,"component":"uain-web","commit":"${commit.slice(2)}",${at}}`,
    `{"schema":1,"component":"uain-web","commit":"${commit}","built_at":"yesterday"}`,
    `{"schema":1,"commit":"${commit}",${at}}`,
  ])
    assert.equal(parseBuildId(bad), null, bad);
});
