import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';

test('public native research status never falls back to private BAINK identity or changes metadata', async (t) => {
  let fetches = 0;
  const f = await fixture(t, {
      nativeResearchOptions: {
        fetchImpl: async () => {
          fetches++;
          throw Error('No unpinned discovery');
        },
      },
    }),
    who = member();
  await f.request(who, 'POST', '/api/account', {
    displayName: 'Unpublished local identity',
  });
  const before = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir)));
  const result = await f.request(
    null,
    'GET',
    `/api/members/${who.address}/native-record`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.scope, 'native-committed-legacy-records');
  assert.equal(result.body.complete, false);
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.body.member, null);
  assert.equal(result.body.records, null);
  assert.equal(result.body.proof, null);
  assert.equal(
    JSON.stringify(result.body).includes('Unpublished local identity'),
    false,
  );
  assert.equal(Object.hasOwn(result.body, 'balance'), false);
  assert.equal(fetches, 0);
  assert.equal(await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))), before);
});

test('native research read is unsigned, bounded to its route, and rejects unrecognized query/body input', async (t) => {
  const f = await fixture(t),
    address = 'uain1' + 'a'.repeat(40);
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        `/api/members/${address}/native-record?owner=other`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        `/api/members/${address}/native-record?__proto__=ignored`,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.request(null, 'POST', `/api/members/${address}/native-record`, {}))
      .status,
    404,
  );
  assert.equal(
    (await f.request(null, 'GET', '/api/members/not-an-address/native-record'))
      .status,
    404,
  );
});
