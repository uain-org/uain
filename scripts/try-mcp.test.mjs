import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMcp, MCP_CONFIG } from '../lib/try/mcp.ts';
const result = { content: [{ type: 'text', text: JSON.stringify({ id: 'T-37', research_policy: 'legacy', results: [{ id: 'RC-4571', state: 'contested' }] }) }] };
test('anonymous JSON reads preserve policy and contested state without credentials', async () => {
  const task = await readMcp('uain_tasks', { task_id: 'T-37' }, { fetcher: async (url, request) => {
    assert.equal(url, '/mcp');
    assert.equal(request.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(request.body).params, { name: 'uain_tasks', arguments: { task_id: 'T-37' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(task.research_policy, 'legacy');
  assert.equal(task.results[0].state, 'contested');
  assert.equal(JSON.parse(MCP_CONFIG).mcpServers.uain.url, 'https://uain.global/mcp');
});
test('Streamable HTTP SSE reads accept CRLF framing and ignore notifications', async () => {
  const fetcher = async () => new Response(`event: message\r\ndata: {"method":"notice"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ id: 1, result })}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await readMcp('uain_tasks', {}, { fetcher })).id, 'T-37');
});
test('signing and submission cannot use the preview transport', async () => {
  let called = false;
  await assert.rejects(readMcp('uain_native_submit', {}, { fetcher: async () => { called = true; } }), /reads only/);
  assert.equal(called, false);
});
test('HTTP, MCP and domain errors refuse a misleading successful preview', async () => {
  for (const response of [new Response('', { status: 503 }), new Response(JSON.stringify({ id: 1, error: { code: -1 } })), new Response(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: '{"error":"native_authority_unavailable"}' }] } }))]) {
    await assert.rejects(readMcp('uain_tasks', {}, { fetcher: async () => response }));
  }
});
