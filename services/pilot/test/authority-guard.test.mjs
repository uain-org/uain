// Audit E-7 (15 November 2026): with UAIN_AUTHORITY unset the server ran pilot mode, with the whole
// anonymous enrol and write surface. In the production image (NODE_ENV=production) it must now refuse
// to start instead; local development and the tests (no NODE_ENV) keep the pilot default.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorityStartupRefusal } from '../dist/src/api/authority-guard.js';

const REFUSAL = /Refusing to start: this production image needs UAIN_AUTHORITY/;
const NO_ORIGIN = /Refusing to start: this production image needs UAIN_PUBLIC_ORIGIN/;
const ORIGIN = 'https://uain.test';
// Nothing here may reach a real database: an unreachable one fails fast if the guard lets a start through.
function start(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'uain-authority-'));
  try {
    return spawnSync(process.execPath, ['dist/src/api/server.js'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', HOST: '127.0.0.1', UAIN_DATA_DIR: dir, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', ...extra },
      encoding: 'utf8',
      timeout: 20000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the rule: a production image needs an explicit authority; elsewhere pilot stays the default', () => {
  assert.match(authorityStartupRefusal({ NODE_ENV: 'production' }), REFUSAL);
  assert.match(authorityStartupRefusal({ NODE_ENV: 'production', UAIN_AUTHORITY: '' }), REFUSAL);
  assert.equal(authorityStartupRefusal({ NODE_ENV: 'production', UAIN_AUTHORITY: 'native', UAIN_PUBLIC_ORIGIN: ORIGIN }), null);
  assert.equal(authorityStartupRefusal({ NODE_ENV: 'production', UAIN_AUTHORITY: 'pilot', UAIN_PUBLIC_ORIGIN: ORIGIN }), null);
  assert.equal(authorityStartupRefusal({}), null, 'local development and the tests');
  assert.equal(authorityStartupRefusal({ NODE_ENV: 'development' }), null);
});

test('the production image refuses to start without UAIN_AUTHORITY, before it touches the store', () => {
  const r = start({ NODE_ENV: 'production' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, REFUSAL);
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|pg-pool|database/i, 'the store was never reached');
});

test('with an explicit authority, or outside the image, the guard lets the start through', () => {
  for (const extra of [{ NODE_ENV: 'production', UAIN_AUTHORITY: 'pilot', UAIN_PUBLIC_ORIGIN: ORIGIN }, {}]) {
    const r = start(extra);
    assert.doesNotMatch(r.stderr ?? '', REFUSAL, JSON.stringify(extra));
    assert.doesNotMatch(r.stderr ?? '', NO_ORIGIN, JSON.stringify(extra));
  }
});

test('a script or worker that imports the server code in the image is not stopped by the guard', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./dist/src/api/authority-guard.js');process.stdout.write('imported')"], {
    env: { PATH: process.env.PATH, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'imported');
});

// Audit P2-7 (15 November 2026): without UAIN_PUBLIC_ORIGIN the origin sign-in proofs must name fell
// back to the request's Host header. The production image must now pin it, as it must name its authority.
test('the production image refuses to start without UAIN_PUBLIC_ORIGIN, before it touches the store (P2-7)', () => {
  for (const authority of ['pilot', 'native']) {
    assert.match(authorityStartupRefusal({ NODE_ENV: 'production', UAIN_AUTHORITY: authority }), NO_ORIGIN);
    assert.match(authorityStartupRefusal({ NODE_ENV: 'production', UAIN_AUTHORITY: authority, UAIN_PUBLIC_ORIGIN: '' }), NO_ORIGIN);
  }
  assert.equal(authorityStartupRefusal({ UAIN_AUTHORITY: 'pilot' }), null, 'local development and the tests keep the Host fallback');
  const r = start({ NODE_ENV: 'production', UAIN_AUTHORITY: 'pilot' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, NO_ORIGIN);
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|pg-pool|database/i, 'the store was never reached');
});
