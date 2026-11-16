/**
 * One UAIN server for newcomers (16 November 2026, Rahul: "Use UAIN throughout").
 *
 * The earning tools that run on the payment engine (BAINK, baink.money/mcp) are also
 * offered here under uain_* names, so a member's AI connects to https://uain.global/mcp
 * only. This is an adapter, not a second implementation: each call is passed on to
 * baink.money/mcp under its engine name with the member's arguments unchanged, and the
 * engine's answer comes back as it is, with only the next-step tool names and the
 * signer's download address turned into their UAIN forms.
 *
 * Security stays where it was. A signed request is checked by BAINK as before: BAINK
 * receives it on its own host, so the signature's audience is still https://baink.money
 * (the signer's default) and no new origin is trusted. Anything that looks like a private
 * key is refused here, before it leaves this server. The old baink_* names answer too,
 * unlisted, with the engine's own wording, for agents that already use them. Native tools
 * whose names would collide (uain_guide, uain_tasks, uain_projects) keep their own
 * contract: the engine's versions of those are not offered here.
 *
 * Compute is short: no timer, no cache, no extra process. One outgoing call per tool call,
 * within the caller's engine budget (RATE_LIMITS.engine, required: with no budget nothing is
 * sent) and within a process-wide cap on calls in flight (ENGINE_IN_FLIGHT), shared by every
 * per-request MCP server object, with a smaller cap per caller. The caller is the canonical
 * address key mcp.ts already uses; no forwarded address is trusted. Every call reaches BAINK
 * from this server's address, so BAINK's per-address budgets count all of uain.global together.
 *
 * The upstream is fixed: https://baink.money. Only a loopback http://127.0.0.1:<port> origin is
 * accepted instead, for local test fixtures (option origin, or UAIN_ENGINE_TEST_ORIGIN).
 */
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {forUain} from './guide-answers.ts';

const DEFAULT_ORIGIN = 'https://baink.money';
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
/** BAINK's MCP parser (apps/baink/server/mcp.mjs readMessage): 16 KiB for a whole JSON-RPC
 * request, 64 KiB only for baink_member_request, and nesting of at most 32 from the request
 * root. The serialized request is checked here, before anything is sent. */
export const ENGINE_REQUEST_LIMIT = 16384;
export const ENGINE_MEMBER_REQUEST_LIMIT = 65536;
/** Arguments sit two levels below the request root (params.arguments): 30 is BAINK's bound. */
const ARGS_DEPTH_LIMIT = 28;
/** Calls in flight to the engine, shared by every MCP server object in this process. BAINK
 * itself answers at most 8 MCP calls at once. */
export const ENGINE_IN_FLIGHT = {global: 8, perCaller: 2};
const inFlight = {total: 0, byCaller: new Map<string, number>()};
/** Where uain.global serves the same signer bytes (ops/nginx/docker.conf passes them on from BAINK). */
export const UAIN_SIGNER_URL = 'https://uain.global/uain_signer.py';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const address = z.string().max(45).regex(/^uain1[a-f0-9]{40}$/);
const page = {page: z.number().int().min(1).max(10000).optional(), pageSize: z.number().int().min(1).max(24).optional()};

/** The listed UAIN names, each with the engine tool it runs and the same fields. */
export const ENGINE_TOOLS = [
  {
    name: 'uain_signer', engine: 'baink_signer', title: 'Get the signer (nothing to install)',
    description: 'Get the short signer your AI runs in its own code sandbox, so the person installs nothing: it makes the member key, signs each request for uain_member_request and checks every prepared step before signing it. It is Python with no packages and no network calls; check its SHA-256 before running it. It signs only enrolment, joining, submitting and reassessment, never a payment or a Trade step.',
    shape: {}, required: [] as string[], readOnly: true,
  },
  {
    name: 'uain_member_request', engine: 'baink_member_request', title: 'Send one signed step',
    description: 'Send one request your sandbox signed with the signer from uain_signer: create a profile, enrol, list tasks, join a project, submit work and read the review result, with nothing installed. Pass exactly what sign_request returned, and sign a fresh request for every call (each signature works once, for 5 minutes). Paying and Trade need the uain-agent kit, and a private key is never passed here.',
    shape: {
      method: z.enum(['GET', 'POST']),
      path: z.string().max(512).regex(/^\/api\//).describe('For example /api/native/central/tasks?order=newest&state=open&limit=12&cursor=0'),
      body: z.record(z.string(), z.unknown()).optional().describe('The JSON body for POST, exactly as signed.'),
      publicKey: z.string().max(44).optional().describe('From sign_request.'),
      nonce: z.string().max(128).optional().describe('From sign_request.'),
      timestamp: z.string().max(13).optional().describe('From sign_request.'),
      signature: z.string().max(88).optional().describe('From sign_request.'),
    },
    required: ['method', 'path'], readOnly: false,
  },
  {
    name: 'uain_contribution', engine: 'baink_contribution', title: 'Read a member\'s contribution',
    description: 'Read one member\'s current contribution by uain1 address, live: contribution points (Karma), each accepted answer with its task and project, checks done for others, work still waiting for review (not counted), then AI$ earned and balance as ledger facts. For the archive of published research by everyone, use uain_contributions instead. Reads only; everything here is public.',
    shape: {address: address.describe('The member\'s uain1 address.')}, required: ['address'], readOnly: true,
  },
  {
    name: 'uain_proposals', engine: 'baink_proposals', title: 'Search proposed projects',
    description: 'Search the 21,600 proposed projects (ideas not yet funded or started), or read one by id. Use it to see whether an idea is already proposed; proposals are not paid work.',
    shape: {...page, search: z.string().max(200).optional(), domain: z.string().max(200).optional(), id: z.string().max(9).regex(/^(OPP|PRB)-[0-9]{5}$/).optional()},
    required: [], readOnly: true,
  },
  {
    name: 'uain_profiles', engine: 'baink_profiles', title: 'Find member profiles',
    description: 'Find members by their published profiles (what they offer, their uain1 address). Use it to find someone to pay or trade with; profiles are self-described.',
    shape: {...page, page: z.number().int().min(1).max(1000).optional(), search: z.string().max(120).optional(), address: address.optional()},
    required: [], readOnly: true,
  },
] as const;
/** Old names that still answer here, unlisted, exactly as the engine answers them. */
export const ENGINE_ALIASES: Record<string, string> = Object.fromEntries(ENGINE_TOOLS.map((t) => [t.engine, t.name]));

type Reader = {read(): Promise<{done: boolean; value?: Uint8Array}>; cancel(reason?: unknown): Promise<void>};
type Fetch = (url: string, init: {method: string; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal}) => Promise<{status: number; body?: {getReader(): Reader} | null; text(): Promise<string>}>;
type Budget = () => Promise<{allowed: boolean; retryAfter?: number; limit?: number}>;

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SECRET_NAME = /private|secret|seed|mnemonic|passphrase|password|jwk/i;
// A 43-character base64url run standing alone (a raw Ed25519 seed), as BAINK checks it
// (apps/baink/server/mcp-member.mjs). The member's own public key is allowed.
const KEYLIKE = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_+/=-])/g;
// Recognizable key containers: PEM armour, and base64 PKCS#8 / SEC1 DER without armour
// (Ed25519 PKCS#8 "MC4CAQAw...", RSA/EC PKCS#8 "MII?..IBADA", EC SEC1 "MHcCAQEE").
const KEY_CONTAINER = /PRIVATE KEY|-----BEGIN|MC4CAQAwBQYDK2Vw|MI[IG][A-Za-z0-9+/]{2}IBADA|MHcCAQEE/;
/**
 * A best-effort guard, not a secret detector. It refuses the forms a private key is
 * recognizably sent in: PEM, unarmoured PKCS#8/SEC1, a JWK (an object with a private "d"
 * beside kty, crv or x), a field named like a secret, and the signer's own 43-character
 * base64url seed. A raw 32-byte value in other encodings (64 hex characters, 44-character
 * padded base64) cannot be told apart from a public key or a SHA-256 digest, which research
 * evidence carries legitimately, so those pass: BAINK checks them again, and the signer never
 * puts a key in a request.
 */
function looksLikeKey(value: unknown, own: string | null, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === 'string') {
    if (KEY_CONTAINER.test(value)) return true;
    for (const m of value.matchAll(KEYLIKE)) if (m[0] !== own) return true;
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => looksLikeKey(v, own, depth + 1));
  if (plain(value)) {
    if (typeof value.d === 'string' && ('kty' in value || 'crv' in value || 'x' in value)) return true;
    return Object.entries(value).some(([k, v]) => SECRET_NAME.test(k) || looksLikeKey(k, own, depth + 1) || looksLikeKey(v, own, depth + 1));
  }
  return false;
}

/** Nesting depth of a JSON value, stopping once it passes the limit. */
function deeper(value: unknown, limit: number, depth = 0): boolean {
  if (depth > limit) return true;
  if (value && typeof value === 'object') for (const child of Object.values(value)) if (deeper(child, limit, depth + 1)) return true;
  return false;
}
/** The whole answer, read in chunks and cancelled as soon as it passes the limit. */
async function readBounded(response: Awaited<ReturnType<Fetch>>, limit: number): Promise<string> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error('oversize');
    return text;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) { await reader.cancel('oversize').catch(() => {}); throw new Error('oversize'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The UAIN form of an engine answer: next steps and how-to lines name UAIN tools. */
function uainAnswer(name: string, data: Record<string, unknown>) {
  const out: Record<string, unknown> = {...data};
  // Only the wording and the tool name change: args and sign lines (what the member signs) stay byte for byte.
  if (plain(out.nextStep)) {
    const step = out.nextStep;
    out.nextStep = {...step, ...(typeof step.do === 'string' ? {do: forUain(step.do)} : {}), ...(typeof step.tool === 'string' ? {tool: forUain(step.tool)} : {})};
  }
  if (Array.isArray(out.howToUse)) out.howToUse = forUain(out.howToUse);
  if (name === 'uain_signer' && typeof out.text === 'string') {
    out.url = UAIN_SIGNER_URL;
    out.checksumUrl = UAIN_SIGNER_URL + '.sha256';
  }
  return out;
}

export function registerEngineTools(server: McpServer, {
  text, audit, budget, caller, fetcher = fetch as unknown as Fetch, origin,
}: {text: (v: unknown) => any; audit: (action: string, detail?: string | null) => void; budget: Budget | undefined; caller: string | undefined; fetcher?: Fetch; origin?: string}) {
  if (origin !== undefined && !LOOPBACK.test(origin)) throw new Error('The engine is https://baink.money; only a loopback test origin may replace it.');
  const testOrigin = process.env.UAIN_ENGINE_TEST_ORIGIN;
  const engineOrigin = origin ?? (testOrigin && LOOPBACK.test(testOrigin) ? testOrigin : DEFAULT_ORIGIN);
  const callerKey = typeof caller === 'string' && caller ? caller : 'unknown';
  const fault = (code: string, message: string, nextStep: unknown) => ({...text({error: {code, message}, nextStep}), isError: true});
  // The guide on this server is uain_guide, whichever name was called (baink_guide is not offered here).
  const guide = () => ({do: 'Ask the guide what to do next.', tool: 'uain_guide', args: {question: 'how do I start without installing anything?'}});

  async function ask(rpc: string) {
    const response = await fetcher(engineOrigin + '/mcp', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', 'user-agent': 'uain-mcp-engine/1'},
      body: rpc,
    });
    const body = await readBounded(response, MAX_BYTES);
    let parsed: any = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    return {status: response.status, rpc: plain(parsed) ? parsed : null};
  }

  for (const tool of ENGINE_TOOLS) {
    for (const name of [tool.name, tool.engine]) {
      const uain = name === tool.name;
      server.registerTool(name, {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.shape as z.ZodRawShape).strict(),
        annotations: {readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: true},
      }, async (input: any) => {
        audit(name);
        const args = plain(input) ? input : {};
        // Size and nesting first, as BAINK's parser bounds them, so the key walk below stays bounded
        // and BAINK never refuses a request after it was sent.
        if (deeper(args, ARGS_DEPTH_LIMIT))
          return fault('request_too_large', 'This request is nested too deeply to be sent. Nothing was sent.', guide());
        const rpc = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: tool.engine, arguments: args}});
        const limit = tool.engine === 'baink_member_request' ? ENGINE_MEMBER_REQUEST_LIMIT : ENGINE_REQUEST_LIMIT;
        if (Buffer.byteLength(rpc) > limit)
          return fault('request_too_large', `This request is larger than the ${Math.floor(limit / 1024)} KiB the network accepts. Nothing was sent.`, guide());
        // The key guard runs next, on everything, so a key never reaches the engine or a log.
        const own = typeof args.publicKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(args.publicKey) ? Buffer.from(args.publicKey, 'base64').toString('base64url') : null;
        if (looksLikeKey(args, own))
          return fault('private_key_refused', 'Something in this request looks like a private key, so nothing was sent and it was not stored. Never pass the key to a tool: keep it in your sandbox and send only what sign_request returns. If the key was shared by mistake, the person should treat it as exposed.', {do: 'Sign the request in your sandbox and send only its result.', tool: uain ? 'uain_member_request' : 'baink_member_request', args: {'...': 'the dictionary sign_request returns'}});
        // Admission fails closed: with no budget wired in, nothing is sent.
        if (typeof budget !== 'function')
          return fault('engine_unavailable', 'This server cannot reach the network for this call just now. Nothing was sent.', guide());
        const gate = await budget();
        if (!gate || !gate.allowed)
          return fault('rate_limited', `At most ${gate?.limit ?? 0} of these calls a minute from one caller. Nothing was sent.`, {do: `Wait ${gate?.retryAfter ?? 60} seconds and call it once more.`, tool: name, args: {}});
        const mine = inFlight.byCaller.get(callerKey) ?? 0;
        if (inFlight.total >= ENGINE_IN_FLIGHT.global || mine >= ENGINE_IN_FLIGHT.perCaller)
          return fault('engine_busy', 'Too many calls to the network are waiting just now. Nothing was sent.', {do: 'Wait a few seconds and call it once more.', tool: name, args: {}});
        inFlight.total++;
        inFlight.byCaller.set(callerKey, mine + 1);
        let answer;
        try {
          answer = await ask(rpc);
        } catch {
          return tool.readOnly
            ? fault('engine_unavailable', 'This could not be read just now. Nothing changed, and it does not mean the answer is empty.', {do: 'Wait a minute and call it once more.', tool: name, args: {}})
            : fault('outcome_unknown', 'The network did not answer this request, so its outcome is unknown. Do not send a write again: read your steps first.', {do: 'Read your steps (sign it first); a sent step shows there and is settled with its reconcile call.', sign: 'sign_request(key, "GET", "/api/native/central/intents")', tool: name, args: {'...': 'the dictionary sign_request returns'}});
        } finally {
          inFlight.total--;
          const left = (inFlight.byCaller.get(callerKey) ?? 1) - 1;
          if (left > 0) inFlight.byCaller.set(callerKey, left); else inFlight.byCaller.delete(callerKey);
        }
        const result = answer.rpc?.result;
        if (answer.status === 200 && plain(result) && plain(result.structuredContent)) {
          const data = uain ? uainAnswer(name, result.structuredContent) : result.structuredContent;
          return {...text(data), isError: result.isError === true};
        }
        const rpcError = answer.rpc?.error;
        if (plain(rpcError) && rpcError.code === -32602)
          return fault('invalid_arguments', 'Invalid arguments: use only the documented fields, with valid values. Nothing was read or changed.', guide());
        // A busy answer on a read is safe to retry. On a signed write it may come from any hop, after the
        // engine already acted, so it is reported as an unknown outcome (below), never as "nothing sent".
        if (tool.readOnly && (answer.status === 429 || answer.status === 503))
          return fault('engine_busy', 'The network is busy just now. Nothing changed.', {do: 'Wait a minute and call it once more.', tool: name, args: {}});
        return tool.readOnly
          ? fault('engine_unavailable', 'This could not be read just now. Nothing changed, and it does not mean the answer is empty.', {do: 'Wait a minute and call it once more.', tool: name, args: {}})
          : fault('outcome_unknown', 'The network did not answer this request clearly, so its outcome is unknown. Do not send a write again: read your steps first.', {do: 'Read your steps (sign it first).', sign: 'sign_request(key, "GET", "/api/native/central/intents")', tool: name, args: {'...': 'the dictionary sign_request returns'}});
      });
    }
  }
}

/** Old engine names answer here but are not listed (hideUnlistedTools). */
export const ENGINE_UNLISTED = new Set(Object.keys(ENGINE_ALIASES));
