import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeProjectLeadsFromEnv, validateNativeProjectLeads } from '../server/native-project-access.mjs';

const tuple = { instanceId: 'current-lead', memberAddress: 'uain1' + 'a'.repeat(40) };
const fromEnv = (value) => nativeProjectLeadsFromEnv({ BAINK_PAPERCLIP_NATIVE_LEADS_JSON: value });

test('native lead environment preserves exact bounded tuples and leaves absent policy optional', () => {
  assert.deepEqual(nativeProjectLeadsFromEnv({}), {});
  const selected = fromEnv(JSON.stringify({ 'existing-project': tuple }));
  assert.deepEqual(selected, { 'existing-project': tuple });
  assert.equal(validateNativeProjectLeads(selected).get('existing-project').memberAddress, tuple.memberAddress);
  const maximum = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ['project-' + i, tuple]));
  assert.equal(validateNativeProjectLeads(maximum).size, 1000);
  assert.throws(() => validateNativeProjectLeads({ ...maximum, 'one-too-many': tuple }), /native.*lead/i);
});

test('malformed, oversized and control-bearing native lead environment fails closed with generic errors', () => {
  for (const value of ['', '{', 'null', '[]', JSON.stringify({ 'UPPER.Project': tuple }), JSON.stringify({ 'existing-project': { ...tuple, origin: 'https://private-canary.example' } }), JSON.stringify({ 'existing-project': { ...tuple, memberAddress: 123 } }), '{}'.padEnd(512 * 1024 + 1)]) {
    assert.throws(() => fromEnv(value), (error) => error.message === 'Invalid native project lead configuration.');
  }
});

test('real server entrypoint rejects malformed native lead environment without echoing operator input', async () => {
  let failure;
  try {
    await promisify(execFile)(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], {
      env: { BAINK_PAPERCLIP_NATIVE_LEADS_JSON: 'secret-canary-invalid', BAINK_PORT: '8798' },
      timeout: 2000,
      maxBuffer: 16384,
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 1);
  assert.match(failure.stderr, /Invalid native project lead configuration/);
  assert.equal(failure.stderr.includes('secret-canary-invalid'), false);
});
