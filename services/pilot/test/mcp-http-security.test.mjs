import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { boot } from './helpers.mjs';

let system;
before(async () => { system = await boot(); });
after(async () => { await system?.close(); });
const batch = (length) => Array.from({ length }, (_, id) => ({ jsonrpc: '2.0', id, method: 'ping' }));
const post = body => system.http('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

test('MCP refuses batches over 16 messages before dispatch', async () => {
  const response = await post(batch(17));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, -32600);
});
test('MCP retains bounded batches and individual requests', async () => {
  const response = await post(batch(16));
  assert.equal(response.status, 200);
  assert.equal((await response.text()).match(/^event: message$/gm).length, 16);
  assert.equal((await post(batch(1)[0])).status, 200);
});
