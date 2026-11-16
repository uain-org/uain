import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';
const origin = 'https://baink.example';
const headers = {
  Host: 'baink.example',
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
  Origin: origin,
  'MCP-Protocol-Version': '2025-11-25',
};
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-mcp-'));
  const { initialState, ...serverOptions } = options;
  if (initialState)
    await writeFile(join(dataDir, 'state.json'), JSON.stringify(initialState));
  const app = await createBainkServer({
    dataDir,
    publicOrigin: origin,
    projectsSource: null,
    catalogueDir: null,
    // These suites read open Trade explicitly; trade-availability.test.mjs covers paused (the default).
    tradeMode: 'open',
    memberDirectoryOptions: {
      fetchImpl: async () => {
        throw Error('Controlled unavailable source');
      },
    },
    ...serverOptions,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function raw(body, extra = {}, path = '/mcp', method = 'POST') {
    const sent = Object.fromEntries(
      Object.entries({ ...headers, ...extra }).filter(
        ([, v]) => v !== undefined,
      ),
    );
    return new Promise((resolve, reject) => {
      const req = httpRequest(base + path, { method, headers: sent }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({
            status: res.statusCode,
            body,
            headers: new Headers(res.headers),
          });
        });
      });
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
  }
  return {
    dataDir,
    raw,
    async post(method, params = {}, extra = {}, id = 1) {
      return raw(
        JSON.stringify({
          jsonrpc: '2.0',
          ...(id === undefined ? {} : { id }),
          method,
          params,
        }),
        extra,
      );
    },
  };
}
test('MCP initializes without native access; lists only public read tools, resources and prompt', async (t) => {
  const f = await fixture(t);
  const init = await f.post('initialize', {
    protocolVersion: '2025-11-25',
    clientInfo: { name: 'test', version: '1' },
    capabilities: {},
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.body.result.serverInfo.name, 'baink');
  assert.deepEqual(Object.keys(init.body.result.capabilities).sort(), [
    'prompts',
    'resources',
    'tools',
  ]);
  assert.equal(init.headers.get('mcp-session-id'), null);
  const tools = (await f.post('tools/list')).body.result.tools;
  // 11 November 2026 (P0-2): the no-install member path adds the signer and the signed relay;
  // the relay is the one listed tool that is not read-only (it forwards signed member steps).
  assert.deepEqual(tools.map((t) => t.name), ['baink_guide', 'baink_tasks', 'baink_contribution', 'baink_signer', 'baink_member_request', 'baink_projects', 'baink_proposals', 'baink_profiles', 'baink_trade']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'baink_member_request', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(
    (await f.post('resources/list')).body.result.resources.map((r) => r.uri),
    ['baink://onboarding'],
  );
  assert.equal(
    (await f.post('prompts/list')).body.result.prompts[0].name,
    'baink_start',
  );
});
test('MCP static onboarding and short activation preserve key custody, proposal and finance boundaries', async (t) => {
  const f = await fixture(t);
  const r = await f.post('tools/call', {
    name: 'baink_onboarding',
    arguments: {},
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, false);
  const data = r.body.result.structuredContent;
  assert.equal(data.scope, 'public-read-only');
  assert.equal(data.asset.id, 'uain-native-coin');
  assert.equal(data.privateKeysAccepted, false);
  assert.equal(data.executionAvailable, false);
  assert.equal(data.settlementAvailable, false);
  assert.match(JSON.stringify(data), /untrusted/i);
  const resource = await f.post('resources/read', {
    uri: 'baink://onboarding',
  });
  assert.match(resource.body.result.contents[0].text, /private key/i);
  const prompt = await f.post('prompts/get', { name: 'baink_start' });
  assert.match(prompt.body.result.messages[0].content.text, /approval/i);
  assert.doesNotMatch(
    prompt.body.result.messages[0].content.text,
    /guaranteed earnings/i,
  );
});
test('MCP reuses public readers and never converts unavailable sources to earned money or active jobs', async (t) => {
  const f = await fixture(t);
  const status = (
    await f.post('tools/call', { name: 'baink_status', arguments: {} })
  ).body.result;
  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.settlement.available, false);
  assert.equal(status.structuredContent.native.status, 'proof_unavailable');
  for (const name of ['baink_projects', 'baink_proposals']) {
    const r = await f.post('tools/call', {
      name,
      arguments: { page: 1, pageSize: 2 },
    });
    assert.equal(r.body.result.isError, true, name);
    assert.equal(
      r.body.result.structuredContent.error.code,
      'source_unavailable',
    );
  }
  const profiles = (
    await f.post('tools/call', {
      name: 'baink_profiles',
      arguments: { page: 1, pageSize: 2 },
    })
  ).body.result;
  assert.equal(profiles.isError, false);
  assert.deepEqual(profiles.structuredContent.profiles, []);
  const offers = (
    await f.post('tools/call', {
      name: 'baink_trade_offers',
      arguments: { pageSize: 2 },
    })
  ).body.result;
  assert.equal(offers.isError, false);
  assert.deepEqual(offers.structuredContent.offers, []);
});
test('MCP rejects private tools, arbitrary paths, private keys, extra args and invalid filters without echo', async (t) => {
  const f = await fixture(t);
  for (const args of [
    { name: 'uain_native_submit', arguments: {} },
    { name: 'baink_status', arguments: null },
    {
      name: 'baink_onboarding',
      arguments: { privateKey: 'DO_NOT_ECHO_SECRET' },
    },
    { name: 'baink_projects', arguments: { url: 'http://127.0.0.1/private' } },
    { name: 'baink_profiles', arguments: { page: 1.5 } },
    { name: 'baink_trade_offers', arguments: { pageSize: 25 } },
    { name: 'baink_profiles', arguments: { address: 'wrong' } },
    {
      name: 'baink_work_source',
      arguments: { kind: 'files', projectId: '../../etc/passwd' },
    },
    { name: 'baink_status', arguments: {}, task: { ttl: 1000 } },
  ]) {
    const r = await f.post('tools/call', args);
    assert.equal(r.body.error.code, -32602, JSON.stringify(args));
    assert.ok(!JSON.stringify(r.body).includes('DO_NOT_ECHO_SECRET'));
  }
  assert.equal(
    (await f.post('resources/read', { uri: 'file:///etc/baink.env' })).body
      .error.code,
    -32602,
  );
  assert.equal(
    (
      await f.post('prompts/get', {
        name: 'baink_start',
        arguments: { privateKey: 'secret' },
      })
    ).body.error.code,
    -32602,
  );
});
test('MCP validates Host/Origin and fetch context before any dispatch', async (t) => {
  const f = await fixture(t);
  for (const extra of [
    { Host: 'attacker.example' },
    { Origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'cross-site' },
    { Origin: 'null' },
  ]) {
    const r = await f.post('tools/list', {}, extra);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, -32000);
  }
  const r = await f.post('tools/list', {}, { Origin: undefined });
  // Native machine clients have no Origin header; configured Host still binds.
  assert.equal(r.status, 200);
});
test('MCP enforces version, media negotiation and exact endpoint query', async (t) => {
  const f = await fixture(t);
  for (const [extra, code] of [
    [{ 'MCP-Protocol-Version': '1900-01-01' }, 400],
    [{ Accept: 'application/json' }, 406],
    [{ Accept: 'application/json;q=0, text/event-stream' }, 406],
    [{ 'Content-Type': 'text/plain' }, 415],
  ]) {
    assert.equal((await f.post('tools/list', {}, extra)).status, code);
  }
  const r = await f.raw(
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    {},
    '/mcp?privateKey=secret',
  );
  assert.equal(r.status, 400);
  assert.equal((await f.raw('', {}, '/mcp', 'GET')).status, 405);
  assert.equal((await f.raw('', {}, '/MCP', 'GET')).status, 405);
  assert.equal((await f.raw('', {}, '/mcp', 'DELETE')).status, 405);
});
test('MCP malformed, batched, null IDs and oversized/deep input fail as JSON-RPC', async (t) => {
  const f = await fixture(t);
  for (const [body, code] of [
    ['{', -32700],
    ['[]', -32600],
    ['null', -32600],
    ['{"jsonrpc":"2.0","id":null,"method":"tools/list"}', -32600],
    ['{"jsonrpc":"2.0","id":{},"method":"tools/list"}', -32600],
  ]) {
    const r = await f.raw(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, code);
  }
  assert.equal(
    (
      await f.raw(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'ping',
          params: { text: 'x'.repeat(17000) },
        }),
      )
    ).status,
    413,
  );
  let nested = {};
  for (let i = 0; i < 35; i++) nested = { nested };
  assert.equal((await f.post('ping', nested)).status, 400);
});
test('MCP stateless notifications are202; duplicate client IDs cannot cancel other requests', async (t) => {
  const f = await fixture(t);
  for (const method of [
    'notifications/initialized',
    'notifications/cancelled',
  ]) {
    const r = await f.raw(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params: method.endsWith('cancelled') ? { requestId: 1 } : {},
      }),
    );
    assert.equal(r.status, 202);
    assert.equal(r.body, null);
  }
  const rs = await Promise.all([f.post('ping'), f.post('tools/list')]);
  assert.deepEqual(
    rs.map((r) => r.body.id),
    [1, 1],
  );
  assert.deepEqual(rs[0].body.result, {});
  assert.ok(rs[1].body.result.tools);
  assert.equal((await f.post('private/write')).body.error.code, -32601);
});
test('MCP public reads leave all durable state including nonces unchanged', async (t) => {
  const f = await fixture(t);
  const before = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))).catch(
    () => null,
  );
  for (const name of [
    'baink_onboarding',
    'baink_status',
    'baink_profiles',
    'baink_trade_offers',
    'baink_members',
  ])
    await f.post('tools/call', { name, arguments: {} });
  const after = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))).catch(
    () => null,
  );
  assert.equal(after, before);
});

test('MCP actual per-IP budget admits120 then rejects121 without trusting a caller IP override', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++)
    assert.equal(
      (await f.post('ping', {}, { 'X-Real-IP': `192.0.2.${i}` })).status,
      200,
    );
  assert.equal((await f.post('ping')).status, 429);
});
test('MCP protects populated private records, exposes only published profile and preserves bytes', async (t) => {
  const hidden = 'uain1' + 'a'.repeat(40),
    visible = 'uain1' + 'b'.repeat(40);
  const profile = (address, published) => ({
    address,
    published,
    displayName: published ? 'Published example' : 'HIDDEN_DRAFT',
    summary: 'Example synthetic description',
    capabilities: [],
    services: [],
    languages: [],
    availability: 'open',
    website: '',
    publicContact: '',
    version: 1,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  });
  const state = {
    version: 1,
    accounts: { [hidden]: { displayName: 'PRIVATE_ACCOUNT' } },
    requests: { secret: { memo: 'PRIVATE_REQUEST' } },
    history: [{ memo: 'PRIVATE_HISTORY' }],
    nonces: { secret: Date.now() },
    nativeIntents: {},
    memberProfiles: {
      [hidden]: profile(hidden, false),
      [visible]: profile(visible, true),
    },
    workSelections: { hidden: 'PRIVATE_SELECTION' },
  };
  const f = await fixture(t, { initialState: state });
  const before = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir)));
  const list = (
    await f.post('tools/call', { name: 'baink_profiles', arguments: {} })
  ).body.result;
  assert.equal(list.isError, false);
  assert.equal(list.structuredContent.profiles.length, 1);
  assert.equal(list.structuredContent.profiles[0].address, visible);
  assert.equal(
    list.structuredContent.profiles[0].provenance.independentlyVerified,
    false,
  );
  const missing = (
    await f.post('tools/call', {
      name: 'baink_profiles',
      arguments: { address: hidden },
    })
  ).body.result;
  assert.equal(missing.isError, true);
  for (const marker of [
    'HIDDEN_DRAFT',
    'PRIVATE_ACCOUNT',
    'PRIVATE_REQUEST',
    'PRIVATE_HISTORY',
    'PRIVATE_SELECTION',
  ])
    assert.ok(!JSON.stringify([list, missing]).includes(marker));
  assert.equal(await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))), before);
});

test('MCP negotiates only implemented versions and does not claim legacy batch support', async (t) => {
  const f = await fixture(t);
  const r = await f.post('initialize', {
    protocolVersion: '2025-03-26',
    clientInfo: { name: 'legacy', version: '1' },
    capabilities: {},
  });
  assert.equal(r.body.result.protocolVersion, '2025-11-25');
  assert.equal(
    (await f.post('tools/list', {}, { 'MCP-Protocol-Version': '2025-03-26' }))
      .status,
    400,
  );
});
test('MCP accepts the opaque _meta clients attach to any request (Claude Code toolUseId)', async (t) => {
  const f = await fixture(t);
  const call = await f.post('tools/call', { name: 'baink_onboarding', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_01abc' } });
  assert.equal(call.status, 200);
  assert.equal(call.body.result.isError, false, JSON.stringify(call.body));
  assert.ok(!JSON.stringify(call.body).includes('toolu_01abc'), 'metadata is never echoed');
  assert.equal(call.body.result.structuredContent.nextStep.tool, 'baink_guide');
  const progress = await f.post('tools/call', { name: 'baink_status', arguments: {}, _meta: { progressToken: 7 } });
  assert.equal(progress.body.result.isError, false);
  const listed = await f.post('tools/list', { _meta: { 'claudecode/x': 1 } });
  assert.ok(listed.body.result.tools.length >= 5);
  for (const _meta of ['text', [1], { progressToken: { nested: true } }]) {
    const bad = await f.post('tools/call', { name: 'baink_status', arguments: {}, _meta });
    assert.equal(bad.body.error.code, -32602, JSON.stringify(_meta));
  }
});

test('MCP front door answers plain questions with the exact next call', async (t) => {
  const f = await fixture(t);
  const call = async (args) => (await f.post('tools/call', { name: 'baink_guide', arguments: args })).body.result;
  const start = await call({});
  assert.equal(start.isError, false);
  assert.ok(start.structuredContent.journey.length >= 5 && start.structuredContent.journey.length <= 8);
  assert.match(JSON.stringify(start.structuredContent.journey), /uain-agent\.mjs/);
  assert.ok(Buffer.byteLength(JSON.stringify(start.structuredContent)) < 8000);
  for (const [question, topic, tool] of [
    ['What is this and how do I start?', 'start', 'baink_signer'], // 11 November 2026: no install first
    ['How much have I earned and how do I pay someone?', 'earned', 'baink_agent_status'],
    ['Something I submitted was rejected, what now?', 'rejected', 'baink_agent_history'],
    ['I have an idea for a new project', 'idea', 'baink_proposals'],
    ['How do I sell a service?', 'trade', 'baink_trade'],
  ]) {
    const r = await call({ question });
    assert.equal(r.isError, false, question);
    assert.equal(r.structuredContent.topic, topic, question);
    assert.equal(r.structuredContent.nextStep.tool, tool, question);
    assert.ok(r.structuredContent.answer.length < 800, question);
  }
  assert.equal((await call({ question: 'How much have I earned and how do I pay someone?' })).structuredContent.alsoAnswered.topic, 'pay');
  const none = await call({ question: 'xyzzy plugh' });
  assert.equal(none.structuredContent.match, 'none');
  assert.ok(none.structuredContent.related.length >= 3);
  assert.equal((await call({ topic: 'value' })).structuredContent.topic, 'value');
  const begin = (await call({ question: 'how do I start?' })).structuredContent;
  assert.match(begin.nextStep.do, /node uain-agent\.mjs next/, 'the start step still names the optional kit');
  assert.match(begin.answer, /Independent/);
  assert.equal((await f.post('tools/call', { name: 'baink_guide', arguments: { topic: 'nope' } })).body.error.code, -32602);
});
test('MCP Trade reads through one tool; the older Trade readers stay callable but unlisted', async (t) => {
  const f = await fixture(t);
  const trade = async (args) => (await f.post('tools/call', { name: 'baink_trade', arguments: args })).body.result;
  const offers = await trade({});
  assert.equal(offers.isError, false);
  assert.deepEqual(offers.structuredContent.offers, []);
  assert.equal(offers.structuredContent.nextStep.tool, 'baink_agent_trade_act');
  // baink_tasks: with the ledger unreadable (this fixture has none) the list is refused as unreadable, never shown empty.
  const tasks = (await f.post('tools/call', { name: 'baink_tasks', arguments: {} })).body.result;
  assert.equal(tasks.isError, true);
  assert.equal(tasks.structuredContent.error.code, 'source_unavailable');
  assert.match(tasks.structuredContent.error.message, /does not mean the list is empty/);
  assert.equal((await f.raw(undefined, {}, '/api/public/tasks', 'GET')).status, 503);
  // Newcomers looked for Trade writes here: every Trade answer says this server only reads and names the kit command.
  for (const view of [{}, { view: 'deals' }, { view: 'policy' }, { view: 'feed' }]) {
    const r = (await trade(view)).structuredContent;
    assert.match(r.readOnly, /^This server only reads Trade\./, JSON.stringify(view));
    assert.match(r.readOnly, /node uain-agent\.mjs trade-act <action>/);
  }
  assert.match((await f.post('tools/list')).body.result.tools.find((x) => x.name === 'baink_trade').description, /only reads Trade: every Trade step .* node uain-agent\.mjs trade-act <action>/);
  assert.deepEqual((await trade({ view: 'deals' })).structuredContent.deals, []);
  const policy = await trade({ view: 'policy' });
  assert.equal(policy.isError, false);
  const missing = await trade({ view: 'deal' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, 'invalid_arguments');
  assert.match(missing.structuredContent.error.message, /needs id/);
  assert.equal(missing.structuredContent.nextStep.tool, 'baink_trade');
  const extra = await trade({ view: 'policy', member: 'uain1' + 'c'.repeat(40) });
  assert.equal(extra.isError, true);
  const absent = await trade({ view: 'deal', id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(absent.isError, true);
  assert.equal(absent.structuredContent.error.code, 'not_found');
  for (const name of ['baink_trade_offers', 'baink_trade_policy', 'baink_onboarding', 'baink_status', 'baink_connections']) {
    const r = await f.post('tools/call', { name, arguments: {} });
    assert.equal(r.body.result.isError, false, name);
  }
  const tools = (await f.post('tools/list')).body.result.tools;
  for (const tool of tools) {
    assert.match(tool.description, /^[A-Z][a-z]+ /, tool.name + ' starts with a verb');
    assert.ok(tool.description.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length <= 3, tool.name + ' is short');
    assert.ok(!/\b(native|central|shield|attested|custody|fence|holder|intent|epoch|projection)\b/i.test(tool.description), tool.name + ' uses plain words');
  }
});
