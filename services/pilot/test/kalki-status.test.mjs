import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

test('Kalki badges reflect paused and milestone state without inventing activity', async () => {
  const source = await readFile(new URL('../../../lib/observatory/kalki-status.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const { kalkiStatus } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  assert.equal(kalkiStatus({ paused: true, milestone: { status: 'running' } }), 'Paused');
  assert.equal(kalkiStatus({ paused: false, milestone: null }), 'Between steps');
  assert.equal(kalkiStatus({ paused: false, milestone: { status: 'running' } }), 'Running now');
  assert.equal(kalkiStatus(undefined), 'Status unavailable');
});
