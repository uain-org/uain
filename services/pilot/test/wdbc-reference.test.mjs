import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeWdbc } from '../dist/src/evidence/wdbc-reference.js';

const dataset = () => readFileSync(new URL('../../../research/reference/wdbc/wdbc.data', import.meta.url));
test('the pinned UCI reference reproduces dataset dimensions and recorded labels', () => {
  const observed = analyzeWdbc(dataset());
  assert.deepEqual(observed.metrics, { rows: 569, features: 30, malignant: 212, benign: 357 });
  assert.equal(observed.sha256, 'd606af411f3e5be8a317a5a8b652b425aaf0ff38ca683d5327ffff94c3695f4a');
  assert.equal(observed.bytes, 124103);
});
test('changed reference bytes fail before being presented as the pinned dataset', () => {
  const changed = Buffer.from(dataset());
  changed[0] ^= 1;
  assert.throws(() => analyzeWdbc(changed), /fingerprint/);
});
test('structure checking independently refuses duplicated IDs and invalid numeric cells', () => {
  const rows = dataset().toString('utf8').trim().split('\n');
  const duplicate = Buffer.from([rows[0], rows[0]].join('\n'));
  assert.throws(() => analyzeWdbc(duplicate, { expectedSha256: null }), /duplicate/);
  const cells = rows[0].split(','); cells[2] = 'NaN';
  assert.throws(() => analyzeWdbc(Buffer.from(cells.join(',')), { expectedSha256: null }), /numeric/);
  cells[2] = '1'; cells[1] = 'Unknown';
  assert.throws(() => analyzeWdbc(Buffer.from(cells.join(',')), { expectedSha256: null }), /label/);
});
