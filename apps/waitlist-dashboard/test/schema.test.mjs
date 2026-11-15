/**
 * The dashboard reads a table another program writes. If the pilot's
 * waitlist DDL changes, this fails, so the fixture and the column list here
 * are brought up to date with it.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COLUMNS, candidateId, seqOf } from '../src/fields.js';

const schemaPath = new URL(
  '../../../services/pilot/src/storage/schema.ts',
  import.meta.url,
);
const fixture = readFileSync(
  new URL('./fixtures/waitlist.sql', import.meta.url),
  'utf8',
);

const block = (text) => {
  const m =
    /CREATE TABLE IF NOT EXISTS waitlist \([\s\S]*?\n\);\nCREATE INDEX IF NOT EXISTS waitlist_name[^\n]*/.exec(
      text,
    );
  assert.ok(m, 'waitlist DDL not found');
  return m[0].replace(/\s+/g, ' ');
};

test(
  'the fixture DDL is the pilot schema’s',
  { skip: !existsSync(schemaPath) && 'no services/pilot here' },
  () => {
    assert.equal(block(fixture), block(readFileSync(schemaPath, 'utf8')));
  },
);

test('COLUMNS lists every column of the DDL, in order', () => {
  const body = /CREATE TABLE IF NOT EXISTS waitlist \(([\s\S]*?)\n\);/.exec(
    fixture,
  )[1];
  const names = body
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
  assert.deepEqual(names, COLUMNS);
});

test('ids are formatted as the pilot formats them', () => {
  assert.equal(candidateId(12), 'UAIN-00000012');
  assert.equal(candidateId('12'), 'UAIN-00000012');
  assert.equal(seqOf('UAIN-00000012'), 12);
  assert.equal(seqOf('uain-00000012'), 12);
  assert.equal(seqOf('UAIN-12'), null);
  assert.equal(seqOf('UAIN-00000000'), null);
  assert.equal(seqOf('12'), null);
});
