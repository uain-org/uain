// The real UAIN MCP server in native mode (16 November 2026): it lists the engine tools under
// uain_* names, keeps old baink_* names unlisted but callable, and counts engine calls against
// the caller's own engine budget before anything is sent.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  // A closed loopback port (the only test origin the adapter accepts), so no call leaves this machine.
  t = await boot({ UAIN_ENGINE_TEST_ORIGIN: 'http://127.0.0.1:9', UAIN_RATE_ENGINE_CALLS_PER_MIN: '3' });
});
after(() => t?.close?.());

test('native MCP lists uain_signer and uain_member_request and answers the old names unlisted', async () => {
  const { buildMcpServer } = await import('../dist/src/api/mcp.js');
  const before = process.env.UAIN_AUTHORITY;
  process.env.UAIN_AUTHORITY = 'native';
  let server;
  try {
    server = buildMcpServer({ caller: 'fixture-engine-caller', userAgent: 'test', bearer: () => null, agent: () => null });
  } finally {
    if (before === undefined) delete process.env.UAIN_AUTHORITY; else process.env.UAIN_AUTHORITY = before;
  }
  const client = new Client({ name: 'engine-http', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of ['uain_guide', 'uain_find_tasks', 'uain_signer', 'uain_member_request', 'uain_contribution', 'uain_proposals', 'uain_profiles'])
      assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => n.startsWith('baink_')), 'old names are not listed');
    assert.equal((await call('uain_guide', {})).nextStep.tool, 'uain_signer');
    // The engine cannot be reached here: an honest refusal, never an empty answer.
    assert.equal((await call('uain_signer', {})).error.code, 'engine_unavailable');
    assert.equal((await call('baink_signer', {})).error.code, 'engine_unavailable', 'the old name answers too');
    assert.equal((await call('uain_profiles', {})).error.code, 'engine_unavailable');
    assert.equal((await call('uain_profiles', {})).error.code, 'rate_limited', 'the fourth engine call in a minute is refused before sending');
  } finally { await client.close(); await server.close(); }
});
