import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  createHash,
} from 'node:crypto';
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createBainkServer, NONCE_BUSY_AT, NONCE_BUSY_KEY_LIMIT, NONCE_HARD_CAP } from '../server/app.mjs';

const audience = 'https://baink.example';
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function member() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    privateKey,
    publicKey: raw.toString('base64'),
    address: `uain1${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`,
  };
}
function signed(who, method, path, body = {}, overrides = {}) {
  const nonce = overrides.nonce ?? randomBytes(24).toString('base64url');
  const timestamp = overrides.timestamp ?? Date.now().toString();
  const message = canonical({
    audience: overrides.audience ?? audience,
    method,
    path,
    body,
    nonce,
    timestamp,
  });
  return {
    'X-BAINK-Public-Key': who.publicKey,
    'X-BAINK-Nonce': nonce,
    'X-BAINK-Timestamp': timestamp,
    'X-BAINK-Signature': sign(
      null,
      Buffer.from(message),
      who.privateKey,
    ).toString('base64'),
  };
}
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-test-'));
  const { initialState, ...serverOptions } = options;
  if (initialState)
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(initialState));
  let app;
  async function start() {
    app = await createBainkServer({
      dataDir,
      publicOrigin: audience,
      projectsSource: null,
      catalogueDir: null,
      ...serverOptions,
    });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${app.server.address().port}`;
  }
  let base = await start();
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    async request(who, method, path, body = {}, headers) {
      const response = await fetch(base + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: audience,
          ...(who ? signed(who, method, path, body) : {}),
          ...headers,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
      };
    },
    async restart() {
      await app.close();
      base = await start();
    },
  };
}
async function register(f, who, name = 'Member') {
  const r = await f.request(who, 'POST', '/api/account', { displayName: name });
  assert.equal(r.status, 201);
  return r.body.account;
}

test('member-held identity registers durably with no money or native-registration claim', async (t) => {
  const f = await fixture(t),
    alice = member();
  const account = await register(f, alice, 'Alice');
  assert.equal(account.address, alice.address);
  assert.equal(account.balance, null);
  assert.equal(account.nativeRegistration, 'unavailable');
  assert.equal(account.native.status, 'proof_unavailable');
  assert.equal(account.asset.id, 'uain-native-coin');
  assert.equal(account.asset.sameLedger, true);
  await f.restart();
  const r = await f.request(alice, 'GET', '/api/account');
  assert.equal(r.body.account.displayName, 'Alice');
  assert.equal((await stat(join(f.dataDir, 'state.json'))).mode & 0o777, 0o600);
  for (const file of ['state.sqlite', 'state.sqlite-wal'])
    assert.equal((await stat(join(f.dataDir, file))).mode & 0o777, 0o600);
  assert.ok(
    !(await readFile(join(f.dataDir, 'state.json'), 'utf8')).includes(
      'PRIVATE KEY',
    ),
  );
});

test('signatures bind method, path, body, audience and time; nonce is durable and races consume once', async (t) => {
  const f = await fixture(t),
    alice = member();
  await register(f, alice);
  assert.equal((await f.request(null, 'GET', '/api/account')).status, 401);
  const headers = signed(alice, 'PATCH', '/api/account', {
    displayName: 'Alice',
  });
  assert.equal(
    (
      await f.request(
        alice,
        'PATCH',
        '/api/account',
        { displayName: 'Mallory' },
        headers,
      )
    ).status,
    401,
  );
  const bound = signed(alice, 'GET', '/api/account');
  assert.equal(
    (await f.request(alice, 'GET', '/api/history', {}, bound)).status,
    401,
  );
  assert.equal(
    (await f.request(alice, 'POST', '/api/account', {}, bound)).status,
    401,
  );
  const once = signed(alice, 'GET', '/api/account');
  const concurrent = await Promise.all([
    f.request(alice, 'GET', '/api/account', {}, once),
    f.request(alice, 'GET', '/api/account', {}, once),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  await f.restart();
  assert.equal(
    (await f.request(alice, 'GET', '/api/account', {}, once)).body.error.code,
    'replay_detected',
  );
  for (const invalid of [
    { audience: 'https://evil.example' },
    { timestamp: (Date.now() - 600_000).toString() },
  ]) {
    assert.equal(
      (
        await f.request(
          alice,
          'GET',
          '/api/account',
          {},
          signed(alice, 'GET', '/api/account', {}, invalid),
        )
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await f.request(
        alice,
        'GET',
        '/api/account',
        {},
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
});

test('amounts stay exact and reject numbers, zero, exponent, excess precision and excessive amounts', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member();
  await register(f, alice);
  await register(f, bob);
  for (const amount of [
    1,
    '0',
    '-1',
    '1e3',
    '0.0000001',
    '9007199254740992',
    '01.0',
    ' 1',
  ]) {
    const r = await f.request(alice, 'POST', '/api/requests', {
      to: bob.address,
      amount,
      clientRequestId: randomBytes(16).toString('hex'),
    });
    assert.equal(r.status, 400, JSON.stringify(amount));
  }
  const r = await f.request(alice, 'POST', '/api/requests', {
    to: bob.address,
    amount: '0.000001',
    memo: 'Exact',
    clientRequestId: 'exact-one',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.amount, '0.000001');
  const large = await f.request(alice, 'POST', '/api/requests', {
    to: bob.address,
    amount: '999999999.999999',
    clientRequestId: 'exact-large',
  });
  assert.equal(large.body.request.amount, '999999999.999999');
});

test('request states enforce payer/payee authority and private history; settlement fails closed', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member(),
    eve = member();
  await register(f, alice);
  await register(f, bob);
  await register(f, eve);
  const created = await f.request(alice, 'POST', '/api/requests', {
    to: bob.address,
    amount: '2.5',
    memo: 'Lunch',
    clientRequestId: 'lunch-one',
  });
  const id = created.body.request.id;
  assert.equal(
    (await f.request(eve, 'GET', '/api/requests')).body.requests.length,
    0,
  );
  assert.equal(
    (await f.request(alice, 'POST', `/api/requests/${id}/decline`)).status,
    403,
  );
  assert.equal(
    (await f.request(eve, 'POST', `/api/requests/${id}/pay`)).status,
    404,
  );
  assert.equal(
    (await f.request(bob, 'POST', `/api/requests/${id}/pay`)).body.error.code,
    'proof_unavailable',
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/requests')).body.requests[0].status,
    'open',
  );
  assert.equal(
    (await f.request(bob, 'POST', `/api/requests/${id}/decline`)).body.request
      .status,
    'declined',
  );
  assert.equal(
    (await f.request(alice, 'POST', `/api/requests/${id}/cancel`)).status,
    409,
  );
  assert.equal(
    (await f.request(eve, 'GET', '/api/history')).body.history.length,
    0,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/history')).body.history.length,
    2,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/transfers', {
        to: bob.address,
        amount: '1',
      })
    ).status,
    503,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/account')).body.account.balance,
    null,
  );
});

test('client request identifiers are idempotent under concurrency and cannot mutate original request', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member();
  await register(f, alice);
  await register(f, bob);
  const payload = {
    to: bob.address,
    amount: '12',
    memo: 'Invoice',
    clientRequestId: 'invoice-123',
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      f.request(alice, 'POST', '/api/requests', payload),
    ),
  );
  assert.equal(new Set(results.map((r) => r.body.request.id)).size, 1);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(
    (await f.request(alice, 'GET', '/api/requests')).body.requests.length,
    1,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/requests', {
        ...payload,
        amount: '13',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/requests', {
        ...payload,
        memo: 'Changed memo',
      })
    ).status,
    409,
  );
  await f.restart();
  assert.equal(
    (await f.request(alice, 'POST', '/api/requests', payload)).body.request.id,
    results[0].body.request.id,
  );
});

test('public health works without native API and unqualified AI$ is clearly unavailable', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(null, 'GET', '/api/health')).body.ok, true);
  const config = (await f.request(null, 'GET', '/api/config')).body;
  assert.equal(config.currency.symbol, 'AI$');
  assert.equal(config.settlement.available, false);
  assert.equal(config.currency.id, 'uain-native-coin');
  assert.equal(config.native.status, 'proof_unavailable');
  assert.equal(config.currency.targetReference.backed, false);
  const projects = (await f.request(null, 'GET', '/api/projects')).body;
  assert.deepEqual(projects.projects, []);
  assert.equal(projects.source.status, 'unavailable');
});

test('metadata payment requests accept exact native asset amounts through the supply cap without issuing funds', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member();
  await register(f, alice);
  await register(f, bob);
  for (const [id, amount] of [
    ['native-billion', '1000000000'],
    ['native-cap', '108000000000000.000000'],
  ]) {
    const result = await f.request(alice, 'POST', '/api/requests', {
      to: bob.address,
      amount,
      clientRequestId: id,
    });
    assert.equal(result.status, 201);
    assert.equal(
      result.body.request.amount,
      amount.includes('.') ? amount : amount + '.000000',
    );
  }
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/requests', {
        to: bob.address,
        amount: '108000000000000.000001',
        clientRequestId: 'above-cap',
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/account')).body.account.balance,
    null,
  );
});

test('live catalogue uses native status and KPI data; task Karma never becomes AI$', async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/projects/science-one/tasks'))
      return res.end(
        JSON.stringify({
          tasks: [
            {
              id: 'task-one',
              title: 'Measure',
              question: 'Measure a signal',
              done_when: 'Validated',
              status: 'open',
              karma_offered: 42,
              kpi: null,
            },
          ],
        }),
      );
    const project = {
      id: 'science-one',
      title: 'Science',
      summary: 'Test an open research question',
      domain: 'Biology',
      progress: { status: 'in_progress', label: 'In progress' },
      tasks: { open: 1 },
      lead: 'native-lead',
      kpi: {
        statement: 'Signal passes threshold',
        metric: 'signal',
        comparator: '>=',
        threshold: 3,
      },
      contributions: [
        {
          id: 'result-one',
          title: 'Verified measurement',
          state: 'settled',
          settled_at: '2026-10-01T00:00:00Z',
        },
      ],
    };
    res.end(
      JSON.stringify(
        req.url.startsWith('/api/projects/science-one')
          ? project
          : { projects: [project] },
      ),
    );
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => upstream.close(r)));
  const f = await fixture(t, {
    projectsSource: `http://127.0.0.1:${upstream.address().port}/api/projects`,
  });
  const list = (
    await f.request(
      null,
      'GET',
      '/api/projects?status=in_progress&category=Biology',
    )
  ).body;
  assert.equal(list.count, 1);
  assert.equal(list.projects[0].taskCount, 1);
  assert.equal(new URL(list.projects[0].url).pathname, '/network/live');
  assert.equal(
    new URL(list.projects[0].url).searchParams.get('project'),
    'science-one',
  );
  const detail = await f.request(null, 'GET', '/api/projects/science-one');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.project.kpi.threshold, 3);
  assert.equal(detail.body.project.tasks[0].karmaOffered, 42);
  assert.equal(detail.body.project.tasks[0].currency, undefined);
  assert.equal(detail.body.project.ceoChat.available, false);
  assert.equal(detail.body.project.achievedWork.length, 1);
});

test('oversized signed bodies are rejected and one directory cannot have two active writers', async (t) => {
  const f = await fixture(t),
    alice = member();
  const huge = await f.request(alice, 'POST', '/api/account', {
    displayName: 'x'.repeat(20_000),
  });
  assert.equal(huge.status, 413);
  await assert.rejects(
    createBainkServer({ dataDir: f.dataDir, publicOrigin: audience }),
    /active writer/,
  );
  assert.equal((await f.request(null, 'GET', '/api/health')).status, 200);
});

test('concurrent payer decline and payee cancellation produce one terminal transition', async (t) => {
  const f = await fixture(t),
    alice = member(),
    bob = member();
  await register(f, alice);
  await register(f, bob);
  const r = await f.request(alice, 'POST', '/api/requests', {
    to: bob.address,
    amount: '1',
    clientRequestId: 'race-request',
  });
  const id = r.body.request.id;
  const race = await Promise.all([
    f.request(alice, 'POST', `/api/requests/${id}/cancel`),
    f.request(bob, 'POST', `/api/requests/${id}/decline`),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await f.request(alice, 'GET', '/api/history')).body.history.length,
    2,
  );
});

test('built SPA is served with security headers and cannot expose hidden files or external symlinks', async (t) => {
  const staticDir = await mkdtemp(join(tmpdir(), 'baink-static-'));
  const outside = await mkdtemp(join(tmpdir(), 'baink-outside-'));
  await writeFile(join(staticDir, 'index.html'), '<main>BAINK</main>');
  const agentModule = 'export const name = "BAINK agent";\n';
  await writeFile(join(staticDir, 'agent.mjs'), agentModule);
  await writeFile(join(staticDir, 'opaque.bin'), 'inert bytes');
  await writeFile(join(staticDir, '.env'), 'PRIVATE=secret');
  await writeFile(join(outside, 'private.txt'), 'private');
  await symlink(join(outside, 'private.txt'), join(staticDir, 'leak.txt'));
  const app = await createBainkServer({
    dataDir: join(outside, 'data'),
    staticDir,
    publicOrigin: audience,
    projectsSource: null,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(staticDir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const module = await fetch(base + '/agent.mjs');
  assert.equal(module.status, 200);
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(module.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await module.text(), agentModule);
  const opaque = await fetch(base + '/opaque.bin');
  assert.equal(opaque.headers.get('content-type'), 'application/octet-stream');
  assert.equal(opaque.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await opaque.text(), 'inert bytes');
  const page = await fetch(base + '/account');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<main>BAINK</main>');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const navigationHeaders = {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };
  const externalPage = await fetch(base + '/account', {
    headers: navigationHeaders,
  });
  assert.equal(externalPage.status, 200);
  assert.equal(await externalPage.text(), '<main>BAINK</main>');
  assert.equal(
    (await fetch(base + '/', { method: 'HEAD', headers: navigationHeaders }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(base + '/', {
        method: 'POST',
        headers: { ...navigationHeaders, Origin: 'https://external.example' },
      })
    ).status,
    405,
  );
  const alice = member();
  for (const method of ['GET', 'POST']) {
    for (const headers of [
      { ...navigationHeaders, Origin: audience },
      { Origin: 'https://external.example' },
    ]) {
      const forbidden = await fetch(base + '/api/account', {
        method,
        headers: { ...signed(alice, method, '/api/account'), ...headers },
      });
      assert.equal(forbidden.status, 403);
      assert.equal((await forbidden.json()).error.code, 'origin_forbidden');
    }
  }
  assert.notEqual((await fetch(base + '/.env')).status, 200);
  assert.notEqual((await fetch(base + '/leak.txt')).status, 200);
});

test('explicit origin aliases bind their own audiences and never trust arbitrary origins', async (t) => {
  const alias = 'https://baink.money';
  const f = await fixture(t, { publicOrigins: [audience, alias] }),
    alice = member();
  const headers = {
    ...signed(
      alice,
      'POST',
      '/api/account',
      { displayName: 'Alias member' },
      { audience: alias },
    ),
    Origin: alias,
  };
  const registered = await f.request(
    alice,
    'POST',
    '/api/account',
    { displayName: 'Alias member' },
    headers,
  );
  assert.equal(registered.status, 201);
  const config = await f.request(
    null,
    'GET',
    '/api/config',
    {},
    { Host: 'baink.money', Origin: alias },
  );
  assert.equal(config.body.auth.audience, alias);
  assert.equal(
    (
      await f.request(
        alice,
        'GET',
        '/api/account',
        {},
        {
          ...signed(alice, 'GET', '/api/account', {}, { audience: alias }),
          Origin: audience,
        },
      )
    ).status,
    401,
  );
});

test('SmartMeet API remains truthful and private until a dedicated server credential is configured', async (t) => {
  const f = await fixture(t),
    alice = member();
  await register(f, alice);
  assert.equal((await f.request(null, 'GET', '/api/meetings')).status, 401);
  const meetings = await f.request(alice, 'GET', '/api/meetings');
  assert.equal(meetings.status, 200);
  assert.equal(meetings.body.status, 'not-configured');
  assert.equal(meetings.body.meetings, null);
  assert.equal(
    (await f.request(null, 'GET', '/api/config')).body.integrations.smartmeet
      .configured,
    false,
  );
});

test('unregistered signed-read floods consume no durable nonces and cannot block a registered identity', async (t) => {
  const f = await fixture(t),
    alice = member(),
    unknown = member();
  await register(f, alice);
  const flood = [];
  for (let i = 0; i < 40; i++)
    flood.push(await f.request(unknown, 'GET', '/api/account'));
  assert.ok(
    flood.some((r) => r.status === 429),
    'an abusive key must be throttled before disk admission',
  );
  assert.equal((await f.request(alice, 'GET', '/api/account')).status, 200);
  const state = readPersistedState(f.dataDir);
  assert.equal(
    Object.keys(state.nonces).filter((key) =>
      key.startsWith(unknown.address + ':'),
    ).length,
    0,
  );
  assert.equal(
    (await f.request(unknown, 'GET', '/api/unknown-operation')).status,
    404,
  );
});

test('new-identity creation is throttled by socket IP even when callers rotate keys and spoof proxy headers', async (t) => {
  const f = await fixture(t),
    alice = member();
  await register(f, alice);
  const statuses = [];
  for (let i = 0; i < 31; i++) {
    const who = member();
    const result = await f.request(
      who,
      'POST',
      '/api/account',
      { displayName: 'New identity' },
      { 'X-Real-IP': `203.0.113.${i + 1}` },
    );
    statuses.push(result.status);
    if (result.status === 429) assert.equal(result.body.error.code, 'rate_limited');
  }
  // Alice's initial registration uses one of the unchanged30 unknown-IP slots.
  assert.deepEqual(statuses.slice(0, 29), Array(29).fill(201));
  assert.deepEqual(statuses.slice(29), [429, 429]);
  assert.equal((await f.request(alice, 'GET', '/api/account')).status, 200);
});

test('older open incoming requests remain reachable after 1000 newer terminal requests', async (t) => {
  const alice = member(),
    bob = member(),
    eve = member(),
    at = '2026-10-31T00:00:00.000Z';
  const accounts = Object.fromEntries(
    [alice, bob, eve].map((w) => [
      w.address,
      {
        address: w.address,
        publicKey: w.publicKey,
        displayName: 'Member',
        createdAt: at,
        updatedAt: at,
      },
    ]),
  );
  const requests = {};
  for (let i = 0; i < 1000; i++) {
    const id = randomUUID();
    requests[id] = {
      id,
      from: alice.address,
      to: bob.address,
      amount: '1.000000',
      memo: 'Newer closed request',
      status: 'cancelled',
      createdAt: at,
      updatedAt: at,
      currency: 'AI$',
    };
  }
  const oldId = randomUUID();
  requests[oldId] = {
    id: oldId,
    from: eve.address,
    to: bob.address,
    amount: '2.000000',
    memo: 'Older open request',
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: at,
    currency: 'AI$',
  };
  const f = await fixture(t, {
    initialState: { version: 1, accounts, requests, nonces: {}, history: [] },
  });
  const first = await f.request(bob, 'GET', '/api/requests?page=1&pageSize=50');
  assert.equal(first.body.requests.length, 50);
  assert.equal(first.body.count, 1001);
  assert.equal(first.body.pages, 21);
  const last = await f.request(bob, 'GET', '/api/requests?page=21&pageSize=50');
  assert.equal(last.body.requests.length, 1);
  assert.equal(last.body.requests[0].id, oldId);
  const incoming = await f.request(
    bob,
    'GET',
    '/api/requests?direction=incoming&status=open&page=1&pageSize=50',
  );
  assert.equal(incoming.body.count, 1);
  assert.equal(incoming.body.requests[0].id, oldId);
  assert.equal(
    (
      await f.request(
        bob,
        'GET',
        '/api/requests?direction=outgoing&status=open',
      )
    ).body.count,
    0,
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/requests?pageSize=1000')).body.requests
      .length,
    100,
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/requests?direction=someone-else'))
      .status,
    400,
  );
});

test('recipient-confirmed paid requests can be listed by status=paid and other statuses still filter exactly', async (t) => {
  const alice = member(),
    bob = member(),
    at = new Date().toISOString();
  const accounts = Object.fromEntries(
    [alice, bob].map((w) => [
      w.address,
      { address: w.address, publicKey: w.publicKey, displayName: 'Member', createdAt: at, updatedAt: at },
    ]),
  );
  const requests = {};
  for (const status of ['open', 'paid', 'declined', 'cancelled']) {
    const id = randomUUID();
    requests[id] = {
      id, from: alice.address, to: bob.address, amount: '1.000000', memo: status, status,
      createdAt: at, updatedAt: at, currency: 'AI$',
      ...(status === 'paid' ? { paymentIntentId: randomUUID(), settlement: { kind: 'native-private-payment', amountVerification: 'recipient-attested', publicAmountProof: false } } : {}),
    };
  }
  const f = await fixture(t, { initialState: { version: 1, accounts, requests, nonces: {}, history: [] } });
  for (const status of ['open', 'paid', 'declined', 'cancelled']) {
    const listed = await f.request(bob, 'GET', `/api/requests?direction=incoming&status=${status}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.requests.map((r) => r.status), [status]);
  }
  assert.equal((await f.request(bob, 'GET', '/api/requests?status=all')).body.count, 4);
  assert.equal((await f.request(bob, 'GET', '/api/requests?status=settled')).status, 400);
});

test('per-member nonce caps and a separate unregistered pool leave another registered member usable', async (t) => {
  const alice = member(),
    bob = member(),
    newcomer = member(),
    at = new Date().toISOString();
  const accounts = Object.fromEntries(
    [alice, bob].map((w) => [
      w.address,
      {
        address: w.address,
        publicKey: w.publicKey,
        displayName: 'Member',
        createdAt: at,
        updatedAt: at,
      },
    ]),
  );
  const nonces = {},
    expiry = Date.now() + 300_000;
  for (let i = 0; i < 128; i++)
    nonces[`${alice.address}:member-seed-${i}`] = expiry;
  for (let i = 0; i < 400; i++)
    nonces[`uain1${String(i).padStart(40, '0')}:unknown-seed`] = expiry;
  const f = await fixture(t, {
    initialState: { version: 1, accounts, requests: {}, nonces, history: [] },
  });
  const blockedMember = await f.request(alice, 'GET', '/api/account');
  assert.equal(blockedMember.status, 429);
  assert.equal(blockedMember.body.error.code, 'member_nonce_limit');
  const blockedNewcomer = await f.request(newcomer, 'POST', '/api/account', {
    displayName: 'Newcomer',
  });
  assert.equal(blockedNewcomer.status, 429);
  assert.equal(blockedNewcomer.body.error.code, 'registration_busy');
  assert.equal((await f.request(bob, 'GET', '/api/account')).status, 200);
});

// The nonce table (third review, 13 November 2026): below NONCE_BUSY_AT
// open nonces as before; from it, only keys holding fewer than
// NONCE_BUSY_KEY_LIMIT; from NONCE_HARD_CAP, nobody.
function nonceState(holdings, extra = {}) {
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString(), accounts = {}, nonces = {}, expiry = Date.now() + 300_000;
  let filler = 0;
  for (const [who, count] of holdings) {
    if (who.address) accounts[who.address] = { address: who.address, publicKey: who.publicKey, displayName: 'Member', createdAt: day, updatedAt: day };
    const address = who.address ?? who;
    for (let i = 0; i < count; i++) nonces[`${address}:held-${filler++}`] = expiry;
  }
  return { version: 1, accounts, requests: {}, nonces, history: [], ...extra };
}
// Registered filler keys holding `per` nonces each, `total` nonces in all.
function fillers(total, per = 120) {
  const out = [];
  for (let k = 0; total > 0; k++) { out.push([member(), Math.min(per, total)]); total -= per; }
  return out;
}
const fill = (rows) => rows.reduce((s, [, n]) => s + n, 0);
test('below 10,000 open nonces a key may hold its usual 128: a busy member with 100 is admitted at 9,999', async (t) => {
  const busy = member(), rows = [[busy, 100], ...fillers(NONCE_BUSY_AT - 1 - 100)];
  assert.equal(fill(rows), NONCE_BUSY_AT - 1);
  const f = await fixture(t, { initialState: nonceState(rows) });
  assert.equal((await f.request(busy, 'GET', '/api/account')).status, 200);
});
test('from 10,000 to 14,999 a key with 15 open nonces is admitted, one with 16 is refused, one with none is admitted', async (t) => {
  const fifteen = member(), sixteen = member(), none = member();
  const rows = [[fifteen, 15], [sixteen, 16], [none, 0], ...fillers(12_000 - 31)];
  const f = await fixture(t, { initialState: nonceState(rows) });
  assert.equal((await f.request(fifteen, 'GET', '/api/account')).status, 200);
  const refused = await f.request(sixteen, 'GET', '/api/account');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'busy');
  assert.equal((await f.request(none, 'GET', '/api/account')).status, 200);
});
test('at 15,000 open nonces every key is refused', async (t) => {
  const none = member(), rows = [[none, 0], ...fillers(NONCE_HARD_CAP)];
  const f = await fixture(t, { initialState: nonceState(rows) });
  const refused = await f.request(none, 'GET', '/api/account');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'busy');
});
// B1-2 (13 November 2026): 84 member keys holding future-dated nonces once
// filled the network-wide 10,000-nonce table and every member's signed
// operation was refused 429 busy.
test('84 keys holding future-dated nonces no longer stop an honest member with fewer than 16 open nonces', async (t) => {
  const victim = member(), attackers = Array.from({ length: 84 }, () => member());
  const rows = [[victim, 10], ...attackers.map((a) => [a, 119])];
  const state = nonceState(rows);
  for (const id of Object.keys(state.nonces)) state.nonces[id] += 290_000;
  assert.ok(Object.keys(state.nonces).length >= NONCE_BUSY_AT);
  const f = await fixture(t, { initialState: state });
  const future = (who, path) => f.request(who, 'GET', path, {}, signed(who, 'GET', path, {}, { timestamp: String(Date.now() + 290_000) }));
  const refused = await future(attackers[0], '/api/account/metadata');
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, 'busy');
  assert.equal((await f.request(victim, 'GET', '/api/account/metadata')).status, 200);
  assert.equal((await f.request(victim, 'PATCH', '/api/account', { displayName: 'Victim 2' })).status, 200);
  assert.equal((await f.request(member(), 'POST', '/api/account', { displayName: 'Newcomer' })).status, 201);
});
// Third reviewer's scenario: filler keys keep the table past 10,000 and 500
// accounts hold one nonce each; an honest member still gets 15 requests in.
test('fillers plus 500 one-nonce accounts leave an honest member at least 15 requests in the window', async (t) => {
  const honest = member(), singles = Array.from({ length: 500 }, () => member());
  const rows = [[honest, 0], ...singles.map((m) => [m, 1]), ...fillers(NONCE_BUSY_AT, 128)];
  const f = await fixture(t, { initialState: nonceState(rows) });
  for (let i = 0; i < NONCE_BUSY_KEY_LIMIT - 1; i++)
    assert.equal((await f.request(honest, 'GET', '/api/account')).status, 200, `request ${i + 1}`);
});

// Review of 13 November 2026: the 60-second future limit locked out members
// whose clocks run fast; the 300-second tolerance is back.
test('signatures dated up to five minutes ahead pass; further ahead is refused', async (t) => {
  const f = await fixture(t), alice = member();
  await register(f, alice, 'Alice');
  const at = (ms) => f.request(alice, 'GET', '/api/account', {}, signed(alice, 'GET', '/api/account', {}, { timestamp: String(Date.now() + ms) }));
  assert.equal((await at(290_000)).status, 200);
  assert.equal((await at(-290_000)).status, 200);
  const ahead = await at(310_000);
  assert.equal(ahead.status, 401);
  assert.equal(ahead.body.error.code, 'invalid_signature');
});

// Review of 13 November 2026 (finding 6): the freshness check ran before the
// request was queued and pruning ran later inside the transaction, so a replay
// sent just before timestamp + 300 s could find its nonce already pruned.
test('a replay that reaches the nonce transaction after the window closes is refused', async (t) => {
  const queue = [];
  const f = await fixture(t, { authClock: () => (queue.length ? queue.shift() : Date.now()) });
  const alice = member();
  await register(f, alice, 'Alice');
  const T = Date.now(), headers = signed(alice, 'GET', '/api/account', {}, { timestamp: String(T) });
  queue.push(T, T);
  assert.equal((await f.request(alice, 'GET', '/api/account', {}, headers)).status, 200);
  // Fresh at the check (299.999 s), but the transaction runs at 300.001 s.
  queue.push(T + 299_999, T + 300_001);
  const replay = await f.request(alice, 'GET', '/api/account', {}, headers);
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'invalid_signature');
});
