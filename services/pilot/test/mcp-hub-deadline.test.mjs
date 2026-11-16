// Baseline 06a-10 (13 November 2026): McpHub.ask waited for ever, so a tool
// that never answered held its request, its HTTP response and a map entry
// until the process ended.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpHub, MCP_ANSWER_MS } from '../dist/src/api/mcp-hub.js';

test('an unanswered request gets a JSON-RPC error after its deadline and is forgotten', async () => {
  const hub = new McpHub();
  let inner;
  hub.onmessage = (m) => { inner = m.id; };
  const hold = setTimeout(() => {}, 1000); // the deadline timer is unref'd; keep this test's loop alive
  const answer = await hub.ask({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }, 30);
  clearTimeout(hold);
  assert.equal(answer.id, 7);
  assert.equal(answer.error?.code, -32001);
  assert.equal(hub.pending, 0);
  await hub.send({ jsonrpc: '2.0', id: inner, result: {} }); // a late answer goes nowhere
  assert.equal(hub.pending, 0);
});

test('an answer in time is passed on and its deadline cleared', async () => {
  const hub = new McpHub();
  hub.onmessage = (m) => { setTimeout(() => hub.send({ jsonrpc: '2.0', id: m.id, result: { ok: true } }), 5); };
  const answer = await hub.ask({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }, 1000);
  assert.deepEqual(answer, { jsonrpc: '2.0', id: 'a', result: { ok: true } });
  assert.equal(hub.pending, 0);
});

test('the default deadline is 10 minutes, above the citation check bound', async () => {
  if (process.env.UAIN_MCP_ANSWER_MS) return;
  assert.equal(MCP_ANSWER_MS, 600_000);
});
