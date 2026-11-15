/**
 * The default build writes the deployable contracts only. The draft token
 * (draft/UAINCredits.sol) must not be deployed, so no script may leave a
 * deploy-ready artifact of it in build/.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DRAFT_SOURCES, SOURCES, compile, compileDraft, writeBuild } from '../scripts/compile.mjs';

test('the default compile covers LedgerAnchor and not the draft token', () => {
  assert.deepEqual(Object.keys(compile()), ['LedgerAnchor']);
  assert.deepEqual(Object.values(SOURCES), ['LedgerAnchor']);
  assert.ok(!Object.values(SOURCES).includes('UAINCredits'));
});

test('the default build writes only LedgerAnchor.json and clears a stale draft artifact', () => {
  const out = mkdtempSync(join(tmpdir(), 'uain-build-'));
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'UAINCredits.json'), '{"stale":true}');
    writeBuild(out);
    assert.deepEqual(readdirSync(out), ['LedgerAnchor.json']);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the draft token compiles only through compileDraft, in memory', () => {
  assert.deepEqual(Object.values(DRAFT_SOURCES), ['UAINCredits']);
  assert.deepEqual(Object.keys(compileDraft()), ['UAINCredits']);
});
