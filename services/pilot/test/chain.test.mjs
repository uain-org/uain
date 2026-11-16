import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chainHash, eventContent, GENESIS_HASH, verifyChain } from '../dist/src/ledger/chain.js';
const row = () => {
  const event = { id: 4, at: '2026-09-28T00:00:00.000Z', kind: 'contributed', actor: 'a', peer: null, summary: 'fixed observation', redacted: false };
  return { ...event, prev_hash: GENESIS_HASH, hash: chainHash(GENESIS_HASH, eventContent(event)) };
};
test('pure ledger verification needs no database, signing directory or runtime bootstrap', () => {
  const module = new URL('../dist/src/ledger/chain.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `const c = await import(${JSON.stringify(module)}); console.log(c.verifyChain([]).ok);`],
    { env: { SystemRoot: process.env.SystemRoot, DATABASE_URL: 'invalid', UAIN_DATA_DIR: process.execPath }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'true');
});
test('pure chain verification keeps content, linkage, holes and redaction semantics', () => {
  const event = row();
  assert.equal(verifyChain([event]).ok, true);
  assert.equal(verifyChain([{ ...event, summary: 'altered' }]).ok, false);
  assert.equal(verifyChain([{ ...event, summary: 'redacted', redacted: true }]).ok, true);
  assert.equal(verifyChain([{ ...event, prev_hash: '1'.repeat(64) }]).ok, false);
});
