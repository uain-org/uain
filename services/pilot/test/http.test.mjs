import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, keyed } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});

test('readiness confirms the PostgreSQL schema is usable', async () => {
  const response = await t.http('/api/ready');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'uain-pilot' });
});
after(async () => {
  await t.close();
});

const post = (path, body) =>
  t.http(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const base = {
  name: 'Http System',
  operator: 'Http Operator',
  authority: 'Head of research',
  principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
};
/** A valid enrolment, with a fresh key each time it is read. */
const fresh = () => ({ ...base, proof: keyed().proof });
const valid = base;

describe('hostile input does not take the server down', () => {
  for (const [label, body] of /** @type {[string, unknown][]} */ ([
    ['numeric name', { ...valid, name: 123 }],
    ['array body', [1, 2]],
    ['null body', 'null'],
    ['object operator', { ...valid, operator: { a: 1 } }],
    ['bad region', { ...valid, region: 'atlantis' }],
    ['non-string capability', { ...valid, capabilities: [1] }],
    ['oversized name', { ...valid, name: 'x'.repeat(101) }],
  ])) {
    test(`${label} is refused with 422`, async () => {
      const r = await post('/api/connect', body);
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error, 'invalid_fields');
    });
  }

  test('malformed JSON is a 400', async () => {
    const r = await post('/api/connect', '{nope');
    assert.equal(r.status, 400);
  });

  test('the server is still up afterwards', async () => {
    assert.equal((await t.http('/api/health')).status, 200);
  });

  test('a negative limit is clamped, not an unbounded dump', async () => {
    for (let i = 0; i < 3; i++) await post('/api/connect', { ...fresh(), name: `n${i}` });
    const r = await (await t.http('/api/events?limit=-1')).json();
    assert.equal(r.count, 1);
  });
});

describe('enrolling over HTTP', () => {
  test('returns a credential that works on the MCP endpoint', async () => {
    const r = await post('/api/connect', fresh());
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.match(body.session_token, /^uains_[0-9a-f]{48}$/);
    assert.match(body.participant.address, /^uain1[0-9a-f]{40}$/);
    assert.equal(body.participant.licence.status, 'active');
    const me = await t.connect(body.session_token);
    const who = await me.call('uain_whoami');
    assert.equal(who.authenticated, true);
    assert.equal(who.participant.id, body.participant.id);
  });

  test('missing principles are refused', async () => {
    const r = await post('/api/connect', { ...fresh(), principles: ['voluntary'] });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'principles_incomplete');
  });
});

describe('tasks and events over HTTP', () => {
  test('events can be read by cursor', async () => {
    const r = await (await t.http('/api/events?after_id=0&limit=2')).json();
    assert.equal(r.order, 'oldest_first');
    assert.equal(r.cursor, r.events.at(-1).id);
  });

  test('task routes answer', async () => {
    const list = await t.http('/api/tasks?state=open');
    assert.equal(list.status, 200);
    assert.equal((await t.http('/api/tasks/TASK-999')).status, 404);
  });
});

describe('MCP without sessions', () => {
  // Any copy of the server answers any request, so a session id a client
  // kept from before (or from another copy) is ignored, not refused.
  test('a request carrying an old session id is answered', async () => {
    const r = await t.http('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'not-a-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /uain_describe/);
    assert.equal(r.headers.get('mcp-session-id'), null);
  });
});

describe('paging the ledger from a cursor', () => {
  test('a full page of 500 says more remain, and the next page carries on', async () => {
    const start = (await (await t.http('/api/events?limit=1')).json()).events[0]?.id ?? 0;
    for (let i = 0; i < 520; i++) await t.db.record('test', 'pager', `page entry ${i}`);
    const first = await (await t.http(`/api/events?after=${start}&limit=500`)).json();
    assert.equal(first.count, 500);
    assert.equal(first.more, true);
    const second = await (await t.http(`/api/events?after=${first.next_after}&limit=500`)).json();
    assert.equal(second.count, 20);
    assert.equal(second.more, false);
    assert.equal(second.events[0].id > first.next_after, true);
  });
});

test('idle connections stay open longer than nginx keeps them (ops/nginx/docker.conf)', async () => {
  const { get } = await import('node:http');
  const header = await new Promise((resolve, reject) =>
    get(`${t.base}/api/health`, { headers: { connection: 'keep-alive' } }, (res) => {
      res.resume();
      resolve(res.headers['keep-alive']);
    }).on('error', reject),
  );
  // nginx drops an idle upstream connection after 60 s; this side must wait longer.
  assert.equal(header, 'timeout=65');
});

// P1-1 (13 November 2026): nginx treats "\" as an ordinary character, so
// "/records/..\api\connect" matched a page location and reached the pilot,
// whose URL parser turned it into "/api/connect". No route has a backslash.
test('a request target with a backslash is refused before it is routed', async () => {
  const { connect } = await import('node:net');
  const port = new URL(t.base).port;
  const raw = (target, method = 'GET') => new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    let out = '';
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => resolve(out.split('\r\n')[0]));
    socket.on('error', reject);
    socket.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  for (const target of ['/records/..\\api\\health', '/network/directory/..\\..\\mcp', '/api\\health'])
    assert.match(await raw(target), /^HTTP\/1\.1 400 /, target);
  assert.match(await raw('/records/..\\api\\connect', 'POST'), /^HTTP\/1\.1 400 /);
  assert.match(await raw('/api/health'), /^HTTP\/1\.1 200 /);
  // The URL parser reads "\\" as "/" only in the path: a query may carry one.
  assert.doesNotMatch(await raw('/api/research/search?q=a\\b'), /^HTTP\/1\.1 400 /);
  assert.match(await raw('/api/health?x=a\\b'), /^HTTP\/1\.1 200 /);
  assert.match(await raw('/records/..\\api\\health?q=1'), /^HTTP\/1\.1 400 /);
});

// P2-5 (13 November 2026): every HTML page the server writes sends its own policy.
test('HTML pages carry a Content-Security-Policy; JSON answers need none', async () => {
  for (const path of ['/no-such-page', '/tasks', '/tasks/T-999999']) {
    const r = await t.http(path, { headers: { accept: 'text/html' } });
    assert.match(r.headers.get('content-type') ?? '', /text\/html/, path);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'.*script-src 'self'(;|$)/, path);
  }
  assert.equal((await t.http('/api/health')).headers.get('content-security-policy'), null);
});
