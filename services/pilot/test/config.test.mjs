import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const config = new URL('../dist/src/config.js', import.meta.url).href;
const packageRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
function readConfig(extra = {}) {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `const c = await import(${JSON.stringify(config)}); console.log(JSON.stringify({root:c.PILOT_ROOT,data:c.DATA_DIR}));`],
    { cwd: tmpdir(), env: { SystemRoot: process.env.SystemRoot, ...extra }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
test('compiled modules retain the existing package data/signing directory from any working directory', () => {
  assert.deepEqual(readConfig(), { root: packageRoot, data: join(packageRoot, '.data') });
});
test('compiled modules preserve an explicitly configured persistent data directory', () => {
  const data = join(tmpdir(), 'uain-persistent-signing-fixture');
  assert.deepEqual(readConfig({ UAIN_DATA_DIR: data }), { root: packageRoot, data });
});
