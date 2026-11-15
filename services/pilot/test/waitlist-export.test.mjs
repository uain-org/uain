import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Execute the actual CLI, replacing only its database boundary. All contacts
// below are fictional; this test must never connect to an operator database.
function runExport(rows, args = ['--csv']) {
  const dir = mkdtempSync(join(tmpdir(), 'uain-waitlist-export-'));
  try {
    mkdirSync(join(dir, 'dist/src/api'), { recursive: true });
    mkdirSync(join(dir, 'dist/src/storage'), { recursive: true });
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(new URL('../scripts/waitlist-export.mjs', import.meta.url), join(dir, 'scripts/waitlist-export.mjs'));
    writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows));
    writeFileSync(join(dir, 'dist/src/api/waitlist.js'), `
      import { readFileSync } from 'node:fs';
      export async function exportAll() {
        return JSON.parse(readFileSync(new URL('../../../rows.json', import.meta.url), 'utf8'));
      }
    `);
    writeFileSync(join(dir, 'dist/src/storage/store.js'), 'export async function close() {}');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const result = spawnSync(process.execPath, ['scripts/waitlist-export.mjs', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CSV exports formula-like registration fields as text, including arrays and headers', () => {
  assert.equal(runExport([{
    name: '=1+1', email: '+ops@example.test', description: '-1+2',
    endpoint: '@SUM(A1)', contributes: ['=1+1', 'research'], '=header': '=value',
  }]), "name,email,description,endpoint,contributes,'=header\n'=1+1,'+ops@example.test,'-1+2,'@SUM(A1),'=1+1; research,'=value\n");
});

test('CSV protects leading whitespace and control characters before formulas', () => {
  assert.equal(runExport([{ a: '\t=1', b: '\r=1', c: '\n=1', d: '  =1', e: '\uFEFF=1' }]),
    'a,b,c,d,e\n\'\t=1,"\'\r=1","\'\n=1",\'  =1,\'\uFEFF=1\n');
});

test('CSV quotes delimiters, quotes, CR-only lines and embedded line breaks', () => {
  assert.equal(runExport([{ 'a,b': 'a,b', quote: 'a "quote"', cr: 'a\rb', lf: 'a\nb' }]),
    '"a,b",quote,cr,lf\n"a,b","a ""quote""","a\rb","a\nb"\n');
});

test('ordinary CSV values, array joining and column order remain compatible', () => {
  assert.equal(runExport([
    { name: 'Helix', contributes: ['research', 'intelligence'], count: 12, missing: null },
    { name: 'Other', contributes: [], count: 0 },
  ]), 'name,contributes,count,missing\nHelix,research; intelligence,12,\nOther,,0,\n');
});

test('JSON retains exact registration content rather than CSV protection prefixes', () => {
  const rows = [{ name: '=1+1', description: '\rtext', contributes: ['+one', 'two'], absent: null }];
  assert.equal(runExport(rows, []), `${JSON.stringify(rows, null, 2)}\n`);
});

test('an empty CSV export stays empty', () => {
  assert.equal(runExport([]), '');
});
