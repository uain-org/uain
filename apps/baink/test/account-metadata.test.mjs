import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, member, signed } from './http-fixture.mjs';

const path = '/api/account/metadata';
const localAccount = (who, displayName = 'Returning member') => ({
  address: who.address,
  publicKey: who.publicKey,
  displayName,
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-31T12:00:00.000Z',
});
function stateFor(who, extraAccounts = {}) {
  return {
    version: 1,
    accounts: { [who.address]: localAccount(who), ...extraAccounts },
    requests: {},
    nonces: {},
    history: [],
    nativeIntents: {},
  };
}
async function disk(f) {
  return readPersistedState(f.dataDir);
}

test('signed metadata projects only the authenticated local holder and leaves native authority unrequested', async (t) => {
  const alice = member(),
    bob = member();
  const state = stateFor(alice, {
    [bob.address]: localAccount(bob, 'Other private holder'),
  });
  Object.assign(state.accounts[alice.address], {
    privateKey: 'private-key-canary',
    native: { proof: 'old-proof-canary' },
    balance: '123456.000000',
    privateMemo: 'private-memo-canary',
  });
  state.privateStoreField = 'private-store-canary';
  const f = await fixture(t, { initialState: state });
  const before = await disk(f),
    result = await f.request(alice, 'GET', path);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    account: {
      ...localAccount(alice),
      currency: 'AI$',
      balance: null,
      nativeRegistration: 'unavailable',
    },
    nativeStatus: 'not-requested',
  });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const serialized = JSON.stringify(result.body);
  for (const secret of [
    'private-key-canary',
    'old-proof-canary',
    '123456',
    'private-memo-canary',
    'private-store-canary',
    bob.address,
    bob.publicKey,
    'Other private holder',
  ])
    assert.equal(serialized.includes(secret), false);
  const after = await disk(f);
  assert.equal(
    Object.keys(after.nonces).length,
    Object.keys(before.nonces).length + 1,
  );
  after.nonces = before.nonces;
  assert.deepEqual(after, before);
  const other = await f.request(bob, 'GET', path);
  assert.equal(other.body.account.displayName, 'Other private holder');
  assert.equal(other.body.account.address, bob.address);
});

test('metadata returns while a configured native executable would remain indefinitely blocked, without starting any source read', async (t) => {
  const who = member(),
    dir = await mkdtemp(join(tmpdir(), 'baink-metadata-blocked-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'native-started'),
    binary = join(dir, 'blocked-reader'),
    genesis = join(dir, 'genesis.json');
  const code = `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);\n`;
  const genesisText = JSON.stringify({ chain_id: 'isolated-metadata-proof' });
  await writeFile(binary, code, { mode: 0o700 });
  await writeFile(genesis, genesisText, { mode: 0o600 });
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  let sourceReads = 0;
  const f = await fixture(t, {
    initialState: stateFor(who),
    nativeConfig: {
      binary,
      binaryHash: sha(code),
      genesis,
      genesisHash: sha(genesisText),
      chainId: 'isolated-metadata-proof',
      rpc: 'http://127.0.0.1:1',
      timeoutMs: 2000,
      maxAgeSeconds: 120,
    },
    nativeResearchOptions: {
      fetchImpl: async () => {
        sourceReads++;
        throw Error('No research discovery');
      },
    },
    paperclipConfig: {
      origin: 'https://private-control.example',
      allowedOrigins: ['https://private-control.example'],
      apiKey: 'fixture-key-not-a-real-secret',
      allowedCompanyIds: ['11111111-1111-4111-8111-111111111111'],
      projectMap: {
        'existing-project': {
          companyId: '11111111-1111-4111-8111-111111111111',
          projectId: '22222222-2222-4222-8222-222222222222',
        },
      },
      fetchImpl: async () => {
        sourceReads++;
        throw Error('No private project read');
      },
    },
  });
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 200);
  assert.equal(result.body.nativeStatus, 'not-requested');
  await assert.rejects(access(marker), { code: 'ENOENT' });
  assert.equal(sourceReads, 0);
});

test('metadata retains signature audience/method/path binding, owner identity, origin and nonce replay checks', async (t) => {
  const who = member(),
    other = member(),
    f = await fixture(t, { initialState: stateFor(who) });
  assert.equal((await f.request(null, 'GET', path)).status, 401);
  const header = signed(who, 'GET', path);
  assert.equal((await f.request(null, 'GET', path, {}, header)).status, 200);
  assert.equal((await f.request(null, 'GET', path, {}, header)).status, 409);
  const forged = signed(other, 'GET', path);
  forged['X-BAINK-Public-Key'] = who.publicKey;
  for (const headers of [
    forged,
    signed(who, 'GET', '/api/account'),
    signed(who, 'POST', path),
    signed(
      who,
      'GET',
      path,
      {},
      { audience: 'https://wrong-audience.example' },
    ),
  ])
    assert.equal((await f.request(null, 'GET', path, {}, headers)).status, 401);
  assert.equal(
    (
      await f.request(
        who,
        'GET',
        path,
        {},
        { Origin: 'https://wrong-origin.example' },
      )
    ).status,
    403,
  );
});

test('unknown signed identities cannot register or reserve a metadata nonce', async (t) => {
  const f = await fixture(t, {
      initialState: {
        version: 1,
        accounts: {},
        requests: {},
        nonces: {},
        history: [],
        nativeIntents: {},
      },
    }),
    who = member(),
    before = await disk(f);
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'account_missing');
  assert.deepEqual(await disk(f), before);
});

test('metadata rejects unsupported methods, query selectors, duplicates and prototype fields', async (t) => {
  const who = member(),
    f = await fixture(t, { initialState: stateFor(who) });
  for (const method of ['POST', 'PATCH', 'DELETE'])
    assert.equal(
      (
        await f.request(who, method, path, {
          __proto__: null,
          displayName: 'do not update',
        })
      ).status,
      404,
    );
  for (const query of [
    '?owner=other',
    '?owner=one&owner=two',
    '?__proto__=other',
    '?constructor=other',
  ])
    assert.equal((await f.request(who, 'GET', path + query)).status, 400);
  assert.equal(
    (await disk(f)).accounts[who.address].displayName,
    'Returning member',
  );
});

test('metadata fails closed on a stored identity mismatch instead of returning another account identity', async (t) => {
  const who = member(),
    other = member(),
    initialState = stateFor(who);
  initialState.accounts[who.address].publicKey = other.publicKey;
  const f = await fixture(t, { initialState });
  const result = await f.request(who, 'GET', path);
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result.body).includes(other.publicKey), false);
});

test('metadata participates in the existing registered identity read rate limit', async (t) => {
  const who = member(),
    f = await fixture(t, { initialState: stateFor(who) });
  for (let i = 0; i < 120; i++)
    assert.equal((await f.request(who, 'GET', path)).status, 200);
  const before = await disk(f),
    result = await f.request(who, 'GET', path);
  assert.equal(result.status, 429);
  assert.deepEqual(await disk(f), before);
});

test('signed GET metadata refuses body selectors and JSON prototype fields rather than selecting another owner', async (t) => {
  const { createBainkServer } = await import('../server/app.mjs');
  const { request } = await import('node:http');
  const who = member(),
    dataDir = await mkdtemp(join(tmpdir(), 'baink-metadata-body-'));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(stateFor(who)));
  const app = await createBainkServer({
    dataDir,
    publicOrigin: 'https://baink.example',
    catalogueDir: null,
    projectsSource: null,
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  for (const body of [
    { owner: 'another-member' },
    JSON.parse('{"__proto__":{"owner":"another-member"}}'),
  ]) {
    const json = JSON.stringify(body);
    const result = await new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: app.server.address().port,
          method: 'GET',
          path,
          headers: {
            Origin: 'https://baink.example',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
            ...signed(who, 'GET', path, body),
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => (raw += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(raw) }),
          );
        },
      );
      req.on('error', reject);
      req.end(json);
    });
    assert.equal(result.status, 400);
  }
  const after = readPersistedState(dataDir);
  assert.deepEqual(after.accounts, stateFor(who).accounts);
});
