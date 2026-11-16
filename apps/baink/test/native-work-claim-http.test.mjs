import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, member, signed } from './http-fixture.mjs';

const binding = {
  projectId: 'existing-research-project',
  taskId: 'T-41',
  workId: 'RC-4577',
  authorInstanceId: 'claude-lead',
};
const path = '/api/work/claim?' + new URLSearchParams(binding);
const localState = (who) => ({
  version: 1,
  accounts: {
    [who.address]: {
      address: who.address,
      publicKey: who.publicKey,
      displayName: 'Private local holder',
      createdAt: '2026-10-31T12:00:00.000Z',
      updatedAt: '2026-10-31T12:00:00.000Z',
    },
  },
  requests: {},
  nonces: {},
  history: [],
  nativeIntents: {},
});
const disk = async (f) =>
  readPersistedState(f.dataDir);

test('selected claim requires a registered holder signature bound to the complete query, audience and origin', async (t) => {
  const who = member(),
    f = await fixture(t, { initialState: localState(who) });
  assert.equal((await f.request(null, 'GET', path)).status, 401);
  for (const headers of [
    signed(who, 'GET', '/api/work/claim'),
    signed(who, 'GET', path.replace('RC-4577', 'RC-4578')),
    signed(who, 'POST', path),
    signed(who, 'GET', path, {}, { audience: 'https://other.example' }),
  ])
    assert.equal((await f.request(null, 'GET', path, {}, headers)).status, 401);
  assert.equal(
    (await f.request(who, 'GET', path, {}, { Origin: 'https://other.example' }))
      .status,
    403,
  );
  const headers = signed(who, 'GET', path);
  assert.equal((await f.request(null, 'GET', path, {}, headers)).status, 200);
  assert.equal((await f.request(null, 'GET', path, {}, headers)).status, 409);
});

test('selected claim has no target override, duplicate inputs, missing binding or write method', async (t) => {
  const who = member(),
    f = await fixture(t, { initialState: localState(who) });
  for (const suffix of [
    '&member=uain1' + 'a'.repeat(40),
    '&workId=RC-4578',
    '&__proto__=x',
    '&owner=other',
  ])
    assert.equal((await f.request(who, 'GET', path + suffix)).status, 400);
  for (const bad of [
    '/api/work/claim',
    path.replace('&taskId=T-41', ''),
    path.replace('RC-4577', '../other'),
  ])
    assert.equal((await f.request(who, 'GET', bad)).status, 400);
  for (const method of ['POST', 'PATCH', 'DELETE'])
    assert.equal((await f.request(who, method, path, {})).status, 404);
});

test('unconfigured selected claim stays unavailable and cannot disclose metadata or establish payment', async (t) => {
  const who = member(),
    f = await fixture(t, { initialState: localState(who) });
  const before = await disk(f),
    result = await f.request(who, 'GET', path);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.body.scope, 'native-selected-work-claim');
  assert.equal(result.body.complete, false);
  assert.equal(result.body.proof, null);
  assert.equal(result.body.association, null);
  assert.equal(result.body.trust, 'not-evaluated');
  assert.equal(result.body.aiDollarPayment, 'not-established-by-this-record');
  for (const key of ['claim'])
    assert.equal(result.body[key], null);
  assert.equal(
    JSON.stringify(result.body).includes('Private local holder'),
    false,
  );
  for (const key of ['balance', 'paid', 'amount', 'reward'])
    assert.equal(Object.hasOwn(result.body, key), false);
  const after = await disk(f);
  assert.equal(
    Object.keys(after.nonces).length,
    Object.keys(before.nonces).length + 1,
  );
  after.nonces = before.nonces;
  assert.deepEqual(after, before);
});

test('unknown selected-claim caller cannot register an account or consume a durable nonce', async (t) => {
  const who = member(),
    f = await fixture(t, {
      initialState: { ...localState(who), accounts: {} },
    }),
    before = await disk(f);
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'account_missing');
  assert.deepEqual(await disk(f), before);
});

test('selected claim refuses a corrupted local account key binding before native proof work', async (t) => {
  const who = member(),
    other = member(),
    state = localState(who);
  state.accounts[who.address].publicKey = other.publicKey;
  const f = await fixture(t, { initialState: state });
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'claim_read_unavailable');
  assert.equal(JSON.stringify(result.body).includes(other.publicKey), false);
});
