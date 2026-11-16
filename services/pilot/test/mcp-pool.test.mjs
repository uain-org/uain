/**
 * A copy answers every MCP request with one server object, through the hub
 * (api/mcp-hub.ts): requests at the same time must each act as their own
 * caller, never another's, and get their own answers back. The
 * access log line uain_whoami writes after its first database call names the
 * member it answered as and the User-Agent it read; with one request's details
 * leaking into another's, the two would disagree.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot } from './helpers.mjs';

let t;
const clients = [];
before(async () => {
  t = await boot();
});
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await t.close();
});

/** A client for this member that sends its own User-Agent. */
async function as(member) {
  const client = new Client({ name: 'pool-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${member.token}`, 'user-agent': `pool-${member.id}` } },
    }),
  );
  clients.push(client);
  return client;
}

test('requests at the same time each act as their own caller', async () => {
  const members = [];
  for (let i = 0; i < 6; i++) members.push(await t.member(`Pool ${i}`));
  const own = await Promise.all(members.map(as));
  const calls = Array.from({ length: 120 }, (_, i) => i % members.length);
  const answers = await Promise.all(calls.map((m) => own[m].callTool({ name: 'uain_whoami', arguments: {} })));
  answers.forEach((r, i) => assert.match(r.content[0].text, new RegExp(members[calls[i]].id)));

  // The access log is written without waiting on the request; wait for it.
  const rows = async () =>
    t.db.prepare("SELECT detail, user_agent FROM access_log WHERE action = 'uain_whoami' AND user_agent LIKE 'pool-%'").all();
  for (let tries = 0; tries < 50 && (await rows()).length < calls.length; tries++)
    await new Promise((r) => setTimeout(r, 100));
  const logged = await rows();
  assert.equal(logged.length, calls.length);
  const crossed = logged.filter((r) => r.user_agent !== `pool-${r.detail}`);
  assert.deepEqual(crossed, []);
});

/** A raw POST to /mcp, as a client without the SDK sends it. */
const post = (body, headers = {}) =>
  fetch(`${t.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
const events = async (res) =>
  (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

test('two clients sending the same id each get their own answer', async () => {
  const a = await t.member('Same Id A');
  const b = await t.member('Same Id B');
  const call = (m) =>
    post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'uain_whoami', arguments: {} } }, { authorization: `Bearer ${m.token}` });
  const [ra, rb] = await Promise.all([call(a), call(b)]);
  const [[ea], [eb]] = [await events(ra), await events(rb)];
  assert.equal(ea.id, 1);
  assert.equal(eb.id, 1);
  assert.match(ea.result.content[0].text, new RegExp(a.id));
  assert.match(eb.result.content[0].text, new RegExp(b.id));
});

test('a batch is answered in order; notifications alone get 202; GET is refused', async () => {
  const res = await post([
    { jsonrpc: '2.0', id: 'x', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'y', method: 'tools/list' },
  ]);
  assert.equal(res.status, 200);
  const got = await events(res);
  assert.deepEqual(got.map((e) => e.id), ['x', 'y']);
  assert.ok(got[1].result.tools.length > 30);

  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await fetch(`${t.base}/mcp`)).status, 405);
  assert.equal((await post({ nonsense: true })).status, 400);
});
