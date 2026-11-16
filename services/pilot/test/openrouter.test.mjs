import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOpenRouter } from '../dist/src/runtime/openrouter.js';

const model = 'openai/gpt-5.6-luna';
const tool = { name: 'uain_next', inputSchema: { type: 'object', properties: {} } };
const response = (message, extra = {}) => new Response(JSON.stringify({ id: 'generation-1', model, usage: { cost: 0.001, total_tokens: 20 }, choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], ...extra }));
const call = (id, name = 'uain_next', args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const options = (extra) => ({ apiKey: 'fake-test-key', model, budgetUsd: 1, tools: [tool], messages: [{ role: 'user', content: 'Find work.' }], callTool: async () => ({ content: [{ type: 'text', text: 'work' }] }), ...extra });

test('uses the exact model, isolates credentials, and completes a serial tool loop', async () => {
  let n = 0;
  const result = await runOpenRouter(options({ fetchImpl: async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, model);
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.provider.allow_fallbacks, false);
    assert.ok(!init.body.includes('fake-test-key'));
    if (n++) { assert.equal(body.messages.at(-1).tool_call_id, 'one'); return response({ content: 'Done.' }); }
    return response({ tool_calls: [call('one')] });
  } }));
  assert.equal(result.reply, 'Done.');
  assert.equal(result.costUsd, 0.002);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.generations.length, 2);
});

test('validates the entire requested tool batch before executing any call', async () => {
  let invoked = 0;
  await assert.rejects(runOpenRouter(options({ callTool: async () => invoked++, fetchImpl: async () => response({ tool_calls: [call('a'), call('b', 'uain_transfer_credits')] }) })), /not allowed/);
  assert.equal(invoked, 0);
});

test('refuses malformed arguments and duplicate tool identifiers', async () => {
  for (const calls of [[call('a', 'uain_next', '[]')], [call('a'), call('a')]]) {
    await assert.rejects(runOpenRouter(options({ fetchImpl: async () => response({ tool_calls: calls }) })), /arguments|identifier/);
  }
});

test('provider errors and uncertain mutation results are never retried', async () => {
  let fetched = 0, invoked = 0;
  await assert.rejects(runOpenRouter(options({ fetchImpl: async () => { fetched++; return new Response('secret body', { status: 429 }); } })), /HTTP 429/);
  assert.equal(fetched, 1);
  await assert.rejects(runOpenRouter(options({ fetchImpl: async () => response({ tool_calls: [call('one')] }), callTool: async () => { invoked++; throw new Error('connection reset'); } })), /uncertain/);
  assert.equal(invoked, 1);
});

test('budget reservation prevents the first request; missing cost prevents another', async () => {
  let fetched = 0;
  await assert.rejects(runOpenRouter(options({ budgetUsd: 0.000001, fetchImpl: async () => { fetched++; } })), /budget/);
  assert.equal(fetched, 0);
  await assert.rejects(runOpenRouter(options({ fetchImpl: async () => { fetched++; return response({ tool_calls: [call('one')] }, { usage: {} }); } })), /accounting/);
  assert.equal(fetched, 1);
});

test('does not accept a provider model substitution or unbounded output', async () => {
  await assert.rejects(runOpenRouter(options({ fetchImpl: async () => response({ content: 'ok' }, { model: 'other/model' }) })), /model/);
  await assert.rejects(runOpenRouter(options({ fetchImpl: async () => new Response('x'.repeat(2_097_153)) })), /response limit/);
});

test('cancels provider work and enforces turn limits', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(runOpenRouter(options({ signal: abort.signal, fetchImpl: async () => assert.fail('must not fetch') })), /abort/i);
  await assert.rejects(runOpenRouter(options({ maxTurns: 1, fetchImpl: async () => response({ tool_calls: [call('one')] }) })), /turn limit/);
});

test('refuses repeated mutation payloads across different call IDs', async () => {
  let invoked = 0, generation = 0;
  await assert.rejects(runOpenRouter(options({ tools: [{ ...tool, name: 'uain_contribute' }], mutationTools: ['uain_contribute'], fetchImpl: async () => response({ tool_calls: [call(String(++generation), 'uain_contribute')] }), callTool: async () => { invoked++; return {}; } })), /repeated mutation/);
  assert.equal(invoked, 1);
});
