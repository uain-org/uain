// MCP-only client runtime. It never executes shell commands or downloads code.
import { createHash } from 'node:crypto';

export interface RunnerTool { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface RunnerReport {
  model: string; costUsd: number; tokens: number; toolCalls: number; reply: string;
  generations: Array<{ id: string; model: string; costUsd: number | null }>;
}
export interface RunnerOptions {
  apiKey: string; model?: string; tools: RunnerTool[];
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  budgetUsd: number; maxTurns?: number; maxToolCalls?: number; maxTokens?: number;
  prices?: { prompt: number; completion: number }; mutationTools?: string[];
  signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch;
}
interface Completion {
  id?: string; model?: string;
  usage?: { cost?: number; total_tokens?: number };
  choices?: Array<{ finish_reason?: string; message?: ChatMessage }>;
}
export type RunnerFailure = Error & { report: RunnerReport };

export const OPENROUTER_MODEL = 'openai/gpt-5.6-luna';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TRANSCRIPT_BYTES = 131_072;
const MAX_RESPONSE_BYTES = 2_097_152;
const canonical = (v: unknown): string => JSON.stringify(v, function (_, value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
});
const finitePositive = (v: number, name: string): void => {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid ${name}`);
};

async function responseJson(response: Response): Promise<Completion> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Provider response limit exceeded');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid provider JSON'); }
}

export async function runOpenRouter({
  apiKey, model = OPENROUTER_MODEL, tools, callTool, messages,
  budgetUsd, maxTurns = 6, maxToolCalls = 12, maxTokens = 1024,
  prices = { prompt: 2, completion: 8 }, mutationTools = [],
  signal, timeoutMs = 60_000, fetchImpl = globalThis.fetch,
}: RunnerOptions): Promise<RunnerReport> {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('OpenRouter key required');
  if (model !== OPENROUTER_MODEL) throw new Error('Only the configured Luna model is supported');
  finitePositive(budgetUsd, 'budget');
  finitePositive(prices.prompt, 'prompt price ceiling');
  finitePositive(prices.completion, 'completion price ceiling');
  for (const [value, name, maximum] of [[maxTurns, 'turn limit', 30], [maxToolCalls, 'tool limit', 100], [maxTokens, 'completion token limit', 8192], [timeoutMs, 'deadline', 300_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  }
  const allowed = new Map();
  for (const tool of tools) {
    if (!/^uain_[a-z_]+$/.test(tool.name) || allowed.has(tool.name)) throw new Error('Invalid tool inventory');
    allowed.set(tool.name, tool);
  }
  const definitions = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const transcript: ChatMessage[] = structuredClone(messages);
  if (!Array.isArray(transcript) || !transcript.length || transcript.some(m => !['system', 'user'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Invalid initial messages');
  const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const report: RunnerReport = { model, costUsd: 0, tokens: 0, toolCalls: 0, generations: [], reply: '' };
  const identifiers = new Set<string>(), mutations = new Set<string>(), writes = new Set(mutationTools);
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      abort.throwIfAborted();
      const body = JSON.stringify({ model, messages: transcript, tools: definitions,
        max_tokens: maxTokens, stream: false, parallel_tool_calls: false,
        provider: { allow_fallbacks: false, require_parameters: true,
          max_price: { prompt: prices.prompt, completion: prices.completion } },
      });
      const bytes = Buffer.byteLength(body);
      if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error('Transcript limit exceeded');
      // UTF-8 bytes conservatively bound text tokens, including tool definitions.
      // This reservation is a client guard, not a substitute for a key billing limit.
      const reservation = (bytes * prices.prompt + maxTokens * prices.completion) / 1_000_000;
      if (report.costUsd + reservation > budgetUsd) throw new Error('Insufficient remaining budget for this request');
      let response;
      try {
        response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body, signal: abort });
      } catch { throw new Error('Provider request failed or aborted; billing outcome is uncertain'); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenRouter HTTP ${response.status}; no retry performed`); }
      const result = await responseJson(response);
      const cost = result.usage?.cost;
      if (typeof result.id === 'string') report.generations.push({ id: result.id, model: typeof result.model === 'string' ? result.model : 'unknown', costUsd: typeof cost === 'number' ? cost : null });
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('Missing or invalid provider cost accounting; stopping');
      report.costUsd += cost;
      const tokens = result.usage?.total_tokens;
      if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) report.tokens += tokens;
      if (report.costUsd > budgetUsd || cost > reservation) throw new Error('Provider accounting exceeded the budget reservation; stopping');
      if (result.model !== model) throw new Error('Provider returned a different model');
      const choice = result.choices?.[0], message = choice?.message;
      if (!message || message.role !== 'assistant' || !choice || typeof choice.finish_reason !== 'string' || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Incomplete provider response; stopping');
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) throw new Error('Invalid provider tool calls');
      if (report.toolCalls + calls.length > maxToolCalls) throw new Error('Tool call limit exceeded');
      const batch = calls.map(call => {
        if (typeof call.id !== 'string' || !call.id || identifiers.has(call.id)) throw new Error('Duplicate or invalid tool identifier');
        identifiers.add(call.id);
        if (call.type !== 'function' || !allowed.has(call.function?.name)) throw new Error('Requested tool is not allowed');
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments); } catch { throw new Error('Invalid tool arguments'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
        if (writes.has(call.function.name)) {
          const digest = createHash('sha256').update(call.function.name + canonical(args)).digest('hex');
          if (mutations.has(digest)) throw new Error('Refusing repeated mutation payload');
          mutations.add(digest);
        }
        return { id: call.id, name: call.function.name, args };
      });
      transcript.push({ role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) { report.reply = String(message.content ?? ''); return report; }
      for (const call of batch) {
        abort.throwIfAborted();
        let result;
        try { result = await callTool(call.name, call.args, abort); }
        catch { throw new Error('MCP call failed or aborted; outcome is uncertain. Inspect the ledger before resuming.'); }
        report.toolCalls++;
        const content = JSON.stringify(result);
        if (content === undefined) throw new Error('Tool returned no JSON result');
        if (Buffer.byteLength(content) > MAX_TRANSCRIPT_BYTES) throw new Error('Tool result exceeds transcript limit');
        transcript.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    throw new Error('Runner turn limit reached');
  } catch (error) {
    if (!(error instanceof Error)) throw new Error('Runner failed');
    (error as RunnerFailure).report = report;
    throw error;
  }
}
