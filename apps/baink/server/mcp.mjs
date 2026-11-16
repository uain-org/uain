import {
  ONBOARDING,
  INSTRUCTIONS,
  ACTIVATION_PROMPT,
  MCP_VERSION,
  MCP_CONNECTIONS,
  TRADE_PAUSED_NOTE,
  TRADE_PAUSED_SELL,
} from './mcp-content.mjs';
import { guideAnswer, GUIDE_TOPICS, KIT_NEXT, kitStep } from './guide-answers.mjs';
import { MEMBER_TOOLS, MEMBER_TOOL_NAMES, MEMBER_REQUEST_LIMIT, memberCall, SIGNER } from './mcp-member.mjs';
const VERSIONS = ['2025-11-25', '2025-06-18'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (max, pattern) => ({
  type: 'string',
  maxLength: max,
  ...(pattern ? { pattern } : {}),
});
const paging = {
  page: { type: 'integer', minimum: 1, maximum: 10000 },
  pageSize: { type: 'integer', minimum: 1, maximum: 24 },
};
const address = str(45, '^uain1[a-f0-9]{40}$');
const uuid = str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$');
const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
// Listed tools: what a member sees. Every other definition below stays callable by name
// (agents and scripts that already use it keep working) but is not listed.
const LISTED = ['baink_guide', 'baink_tasks', 'baink_contribution', 'baink_signer', 'baink_member_request', 'baink_projects', 'baink_proposals', 'baink_profiles', 'baink_trade'];
const TRADE_VIEWS = ['offers', 'deals', 'deal', 'member', 'feed', 'disputes', 'dispute', 'decisions', 'policy', 'enquiries', 'proposals'];
const definitions = [
  [
    'baink_guide',
    'Answer a question about BAINK and UAIN in plain words, with the exact next call to make. Call it with no question to see the whole journey: join, find a research task, do it, submit, get it checked, and collect contribution points (Karma) for accepted work.',
    schema({
      question: { ...str(1000), description: 'Your question in plain words, for example "how do I start?" or "how do I pay someone?"' },
      topic: { type: 'string', enum: GUIDE_TOPICS, description: 'A topic name from the guide\'s topics list, instead of a question.' },
    }),
  ],
  [
    'baink_tasks',
    'Search all open research tasks (q, project), with totalOpen and nextCursor pagination: what each asks for, about how long it takes, the contribution points (Karma) accepted work gives and the AI$ it records. Reads only; a task is taken with baink_member_request (nothing to install) or the kit.',
    schema({ q: { ...str(100), description: 'Words to search titles, project goals, KPIs and research areas for, e.g. longevity.' }, project: { ...str(96), description: 'Exact project id, e.g. P-OPP-00009.' }, cursor: str(8, '^[0-9]+$'), limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  ],
  [
    'baink_contribution',
    'Read a member\'s contribution by uain1 address: contribution points (Karma), each accepted answer with its task and project, checks done for others, work still waiting for review (not counted), then AI$ earned and balance as ledger facts. Reads only; everything here is public.',
    schema({ address: { ...address, description: 'The member\'s uain1 address.' } }, ['address']),
  ],
  [
    'baink_trade',
    'Read Trade, where members sell services to each other for AI$: view "offers" (services for sale), "deals" or "deal" (with id), "member" (one member\'s trade record), "policy" (fees and rules), or the public logs feed, disputes, dispute, decisions, enquiries (offerId) and proposals (enquiryId). This server only reads Trade: every Trade step (list, enquire, sign, pay, deliver, dispute) is the kit command node uain-agent.mjs trade-act <action>.',
    schema({
      view: { type: 'string', enum: TRADE_VIEWS, description: 'What to read; default offers.' },
      id: { ...uuid, description: 'A deal id (view deal) or dispute id (view dispute).' },
      member: { ...address, description: 'A member\'s uain1 address (offers, deals, member, feed).' },
      search: { ...str(100), description: 'Words to search offers for.' },
      status: { ...str(20, '^[a-z]+$'), description: 'Status filter for deals or disputes.' },
      type: { ...str(40, '^[a-z.-]+$'), description: 'Feed event type prefix, for example deal.' },
      offerId: { ...uuid, description: 'An offer id (deals, enquiries).' },
      enquiryId: { ...uuid, description: 'An enquiry id (proposals).' },
      dealId: { ...uuid, description: 'A deal id (decisions).' },
      ...paging,
    }),
  ],
  [
    'baink_connections',
    'Discover the canonical BAINK and UAIN MCP endpoints, shared holder identity, routing and authentication boundaries. Metadata grants no access or credential forwarding.',
    schema(),
  ],
  [
    'baink_funding_policy',
    'Read sanitized proposed staged-project funding readiness. Unadopted or inconsistent rounds confer no application, reviewer, allocation or spendable-balance authority.',
    schema(),
  ],
  [
    'baink_onboarding',
    'Read the older onboarding summary. baink_guide replaces it.',
    schema(),
  ],
  [
    'baink_status',
    'Current native asset/readiness and configured integration status. No balance or transfer authority.',
    schema(),
  ],
  [
    'baink_proposals',
    'Search the 21,600 proposed projects (ideas not yet funded or started), or read one by id. Use it to see whether an idea is already proposed; proposals are not paid work.',
    schema({
      ...paging,
      search: str(200),
      domain: str(200),
      id: str(9, '^(OPP|PRB)-[0-9]{5}$'),
    }),
  ],
  [
    'baink_projects',
    'Read the active research projects, or one by id: its goal, tasks and rewards paid. Paid tasks are taken with baink_member_request or the kit.',
    schema({
      ...paging,
      search: str(200),
      category: str(120),
      status: str(80),
      id: str(160, '^[a-z0-9][a-z0-9-]{0,159}$'),
    }),
  ],
  [
    'baink_work_source',
    'Review one exact project source and digest without saving interest or commissioning work.',
    schema(
      {
        kind: { type: 'string', enum: ['proposals', 'projects'] },
        projectId: str(160, '^[A-Za-z0-9][A-Za-z0-9-]{0,159}$'),
      },
      ['kind', 'projectId'],
    ),
  ],
  [
    'baink_members',
    'Read sourced public instances/member information. Counts and attribution are incomplete, not vetted trust.',
    schema({
      ...paging,
      page: { type: 'integer', minimum: 1, maximum: 1000 },
      search: str(120),
      address,
    }),
  ],
  [
    'baink_profiles',
    'Find members by their published profiles (what they offer, their uain1 address). Use it to find someone to pay or trade with; profiles are self-described.',
    schema({
      ...paging,
      page: { type: 'integer', minimum: 1, maximum: 1000 },
      search: str(120),
      address,
    }),
  ],
  [
    'baink_trade_offers',
    'Read public nonbinding peer-service listings, optionally one provider. No orders or settlement.',
    schema({ ...paging, search: str(100), owner: address }),
  ],
  [
    'baink_trade_feed',
    'Read the public Trade feed: listings, enquiries, sent terms, binding deals, payments, deliveries, refunds, disputes, steward decisions and ratings, newest first. Optional member address and event type prefix (for example deal. or dispute.).',
    schema({ ...paging, member: address, type: str(40, '^[a-z.-]+$') }),
  ],
  [
    'baink_trade_deals',
    'Read public binding Trade deals, or one deal by id with both signed acceptances (re-verifiable), payment status and expiry, milestones, refunds, disputes, ratings and timeline. To act, use the member trade tools (baink_agent_trade_act or the holder baink_trade_deal_* tools).',
    schema({ ...paging, id: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'), member: address, status: { type: 'string', enum: ['proposed', 'agreed', 'paid', 'completed', 'cancelled', 'expired', 'refunded', 'disputed'] }, offerId: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') }),
  ],
  [
    'baink_trade_disputes',
    'Read public Trade disputes, or one by id with every evidence statement, the UAIN steward decision and its reasons, any appeal and the central review result.',
    schema({ ...paging, id: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'), status: { type: 'string', enum: ['open', 'decided', 'appealed', 'final'] } }),
  ],
  [
    'baink_trade_decisions',
    'Read the public log of UAIN trade steward and central-review decisions (retries, delivery confirmations, dispute outcomes, appeals) with reasons, cited policy clauses and effects. Optional dealId.',
    schema({ ...paging, dealId: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') }),
  ],
  [
    'baink_trade_member',
    'Read one member\'s public trade history and reputation: deals as buyer and seller, completions, ratings, disputes and declined ordered refunds. Ratings never change Karma.',
    schema({ address }, ['address']),
  ],
  [
    'baink_trade_policy',
    'Read the written Trade policy (clauses stewards must cite, payment window, review and appeal windows, fee) and the configured UAIN steward and central reviewer addresses, plus the deals that currently need a steward.',
    schema(),
  ],
  [
    'baink_trade_public_terms',
    'Read the public enquiries of one listing (offerId) or the sent terms proposals of one enquiry (enquiryId) with each proposal digest a deal binds.',
    schema({ ...paging, offerId: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'), enquiryId: str(36, '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') }),
  ],
];
// Make selector/list exclusions visible to clients as well as the runtime validator.
for (const [name, , input] of definitions) {
  if (name === 'baink_trade') continue;
  const selector = Object.hasOwn(input.properties, 'id')
    ? 'id'
    : Object.hasOwn(input.properties, 'address')
      ? 'address'
      : null;
  if (!selector) continue;
  const allowed =
    name === 'baink_members' ? [selector, 'page', 'pageSize'] : [selector];
  input.oneOf = [
    { not: { required: [selector] } },
    {
      required: [selector],
      properties: Object.fromEntries(
        Object.keys(input.properties)
          .filter((k) => !allowed.includes(k))
          .map((k) => [k, false]),
      ),
    },
  ];
}
const ALL_TOOLS = definitions.map(
  ([name, description, inputSchema]) => ({
    name,
    description,
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
);
/** What tools/list shows; every tool in ALL_TOOLS stays callable by name. */
export const MCP_TOOLS = LISTED.map((name) => ALL_TOOLS.find((t) => t.name === name) ?? MEMBER_TOOLS.find((t) => t.name === name));
export const UNLISTED_TOOLS = ALL_TOOLS.map((t) => t.name).filter((n) => !LISTED.includes(n));
/** While Trade is paused for new business (P0-4) baink_trade leaves the list; it and every reader still answer by name. */
export const MCP_TOOLS_TRADE_PAUSED = MCP_TOOLS.filter((t) => t.name !== 'baink_trade');
/** What discovery says for one Trade mode: instructions, onboarding and the peer-trade capability. */
export function mcpDiscovery(paused) {
  if (!paused) return { tools: MCP_TOOLS, instructions: INSTRUCTIONS, onboarding: ONBOARDING, connections: MCP_CONNECTIONS };
  return {
    tools: MCP_TOOLS_TRADE_PAUSED,
    instructions: INSTRUCTIONS + ' ' + TRADE_PAUSED_NOTE,
    onboarding: { ...ONBOARDING, sell: TRADE_PAUSED_SELL, trade: { paused: true, note: TRADE_PAUSED_NOTE } },
    connections: {
      ...MCP_CONNECTIONS,
      connections: MCP_CONNECTIONS.connections.map((c) => c.capabilities.includes('peer-trade') ? { ...c, capabilityStatus: { 'peer-trade': 'paused for new business; deals already agreed, paid or in dispute can be finished; reads stay open' } } : c),
    },
  };
}
class RpcError extends Error {
  constructor(code, message, status = 200) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const invalid = () => {
  throw new RpcError(
    -32602,
    'Invalid arguments: use only the documented fields, with valid values. Nothing was read or changed.',
  );
};
function validate(value, shape) {
  if (
    !plain(value) ||
    Object.keys(value).some((k) => !Object.hasOwn(shape.properties, k)) ||
    shape.required.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
  for (const [key, v] of Object.entries(value)) {
    const s = shape.properties[key];
    if (
      s.type === 'integer' &&
      (!Number.isSafeInteger(v) || v < s.minimum || v > s.maximum)
    )
      invalid();
    if (
      s.type === 'string' &&
      (typeof v !== 'string' ||
        v.length > (s.maxLength ?? 1000) ||
        /[\u0000-\u001f\u007f]/.test(v) ||
        (s.pattern && !new RegExp(s.pattern).test(v)) ||
        (s.enum && !s.enum.includes(v)))
    )
      invalid();
  }
  return value;
}
function params(value, allowed, required = []) {
  if (
    !plain(value) ||
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
  return value;
}
// One suggested next step per tool, so every reply leads somewhere.
const TASKS_NEXT = kitStep({ do: 'List the easiest open paid tasks you can take (with the kit; on uain.global/mcp, uain_find_tasks).', shell: 'node uain-agent.mjs tasks --level starter', tool: 'baink_agent_tasks', args: { level: 'starter' } });
const PAY_NEXT = kitStep({ do: 'To pay a member, use the kit with their uain1 address, after the person says yes.', shell: 'node uain-agent.mjs pay <uain1 address> --amount <AI$>', tool: 'baink_agent_pay', args: { to: '<uain1 address>', amount: '<AI$>' } });
const ENQUIRE_NEXT = kitStep({ do: 'To buy, enquire about an offer with the kit, after the person says yes.', shell: 'node uain-agent.mjs trade-act enquire --json \'{"offerId":"<offer id>","message":"<what you need>","expectedRevision":<offer revision>}\'', tool: 'baink_agent_trade_act', args: { action: 'enquire', offerId: '<offer id>', message: '<what you need>', expectedRevision: '<offer revision>' } });
/** Newcomers looked for Trade writes here (10 November 2026): every Trade answer says where they are. */
export const TRADE_READ_ONLY = 'This server only reads Trade. Every Trade step (list an offer, enquire, send terms, sign a deal, pay, deliver, confirm, refund, dispute, rate) is signed on your own machine with the one-file kit: node uain-agent.mjs trade-act <action> --json \'{...}\' (MCP tool baink_agent_trade_act where the kit was added). node uain-agent.mjs next names the Trade step waiting on you.';
const DEAL_NEXT = kitStep({ do: 'The kit\'s next names the Trade step waiting on you.', shell: 'node uain-agent.mjs next', tool: 'baink_agent_next', args: {} });
/** While Trade is paused (P0-4): no Trade reply suggests a new listing or enquiry. */
export const TRADE_READ_ONLY_PAUSED = 'Trade is paused for new business: new listings, enquiries, terms and deals are refused (trade_paused; do not retry). A deal already agreed, paid or in dispute is finished with the kit: node uain-agent.mjs next names the step waiting on you. Everything here stays readable.';
const PAUSED_NEXT = kitStep({ do: 'Trade is paused for new business. Finish any deal waiting on you with the kit\'s next, or take a paid task.', shell: 'node uain-agent.mjs next', tool: 'baink_agent_next', args: {} });
const TAKE_NEXT = { do: 'Take a task with nothing installed: get the signer for your sandbox, then send signed steps with baink_member_request. (If you run commands on your computer, the kit works too: curl -fsSLO https://baink.money/uain-agent.mjs && node uain-agent.mjs next.)', tool: 'baink_signer', args: {} };
const NEXT_BY_TOOL = {
  baink_tasks: TAKE_NEXT,
  baink_contribution: { do: 'Add to it: list the research tasks open right now and take one.', tool: 'baink_tasks', args: {} },
  baink_onboarding: { do: 'Ask the guide anything in plain words.', tool: 'baink_guide', args: { question: 'how do I start?' } },
  baink_projects: TASKS_NEXT,
  baink_proposals: { ...TASKS_NEXT, do: 'Proposals are ideas, not paid work yet. To earn now, list open paid tasks.' },
  baink_work_source: TASKS_NEXT,
  baink_profiles: PAY_NEXT,
  baink_members: PAY_NEXT,
  baink_trade_offers: ENQUIRE_NEXT,
};
const nextFor = (name, view, paused = false) => paused && name.startsWith('baink_trade') ? PAUSED_NEXT : name === 'baink_trade' ? (view === 'offers' || !view ? ENQUIRE_NEXT : DEAL_NEXT) : NEXT_BY_TOOL[name] ?? (name.startsWith('baink_trade_') ? DEAL_NEXT : KIT_NEXT);
function result(data, isError = false, next = KIT_NEXT) {
  // Every object reply ends with one suggested next step (an existing nextStep wins).
  const out =
    data && typeof data === 'object' && !Array.isArray(data) && !('nextStep' in data) && !('self' in data)
      ? { ...data, nextStep: next }
      : data;
  return {
    content: [{ type: 'text', text: JSON.stringify(out) }],
    structuredContent: out,
    isError,
  };
}
/** Plain refusal: what happened, and one thing to do. */
const refusal = (code, message, next) => result({ error: { code, message } }, true, next);
/** baink_trade view and arguments, as the older Trade reader they replace. */
function tradeCall(args) {
  const { view = 'offers', id, member, search, status, type, offerId, enquiryId, dealId, page, pageSize } = args;
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const used = Object.keys(args).filter((k) => k !== 'view');
  const need = (field, what) => { if (args[field] === undefined) return `The "${view}" view needs ${field}: ${what}.`; return null; };
  const allow = (fields) => { const extra = used.filter((k) => !fields.includes(k)); return extra.length ? `The "${view}" view does not take ${extra.join(', ')}.` : null; };
  const calls = {
    offers: () => allow(['member', 'search', 'page', 'pageSize']) ?? ['baink_trade_offers', pick({ owner: member, search, page, pageSize })],
    deals: () => allow(['member', 'status', 'offerId', 'page', 'pageSize']) ?? ['baink_trade_deals', pick({ member, status, offerId, page, pageSize })],
    deal: () => need('id', 'a deal id from view "deals"') ?? allow(['id']) ?? ['baink_trade_deals', { id }],
    member: () => need('member', 'a uain1 address') ?? allow(['member']) ?? ['baink_trade_member', { address: member }],
    feed: () => allow(['member', 'type', 'page', 'pageSize']) ?? ['baink_trade_feed', pick({ member, type, page, pageSize })],
    disputes: () => allow(['status', 'page', 'pageSize']) ?? ['baink_trade_disputes', pick({ status, page, pageSize })],
    dispute: () => need('id', 'a dispute id from view "disputes"') ?? allow(['id']) ?? ['baink_trade_disputes', { id }],
    decisions: () => allow(['dealId', 'page', 'pageSize']) ?? ['baink_trade_decisions', pick({ dealId, page, pageSize })],
    policy: () => allow([]) ?? ['baink_trade_policy', {}],
    enquiries: () => need('offerId', 'an offer id from view "offers"') ?? allow(['offerId', 'page', 'pageSize']) ?? ['baink_trade_public_terms', pick({ offerId, page, pageSize })],
    proposals: () => need('enquiryId', 'an enquiry id from view "enquiries"') ?? allow(['enquiryId', 'page', 'pageSize']) ?? ['baink_trade_public_terms', pick({ enquiryId, page, pageSize })],
  };
  return calls[view]();
}
function accepts(value, type) {
  return String(value ?? '')
    .split(',')
    .some((p) => {
      const [mime, ...fields] = p.trim().toLowerCase().split(';');
      return (
        mime.trim() === type &&
        !fields.some((f) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(f))
      );
    });
}
function send(res, status, body) {
  const content = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(content),
  });
  res.end(content);
}
async function readMessage(req) {
  const chunks = [];
  let size = 0;
  // 16 KiB for every request, except a baink_member_request call (checked after parsing),
  // which may carry a full 16,384-byte evidence submission inside its signed body.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MEMBER_REQUEST_LIMIT)
      throw new RpcError(-32600, 'Request exceeds the16KiB limit.', 413);
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcError(-32700, 'Invalid JSON.', 400);
  }
  const check = (v, depth = 0) => {
    if (depth > 32)
      throw new RpcError(-32600, 'Request nesting exceeds the limit.', 400);
    if (v && typeof v === 'object')
      for (const child of Object.values(v)) check(child, depth + 1);
  };
  check(body);
  if (size > 16384 && !(body?.method === 'tools/call' && body?.params?.name === 'baink_member_request'))
    throw new RpcError(-32600, 'Request exceeds the16KiB limit.', 413);
  if (
    !plain(body) ||
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string' ||
    body.method.length > 100 ||
    Object.keys(body).some(
      (k) => !['jsonrpc', 'id', 'method', 'params'].includes(k),
    ) ||
    (Object.hasOwn(body, 'id') &&
      !(
        (typeof body.id === 'string' && body.id.length <= 128) ||
        Number.isSafeInteger(body.id)
      ))
  )
    throw new RpcError(-32600, 'Invalid single JSON-RPC request.', 400);
  if (body.params !== undefined && !plain(body.params))
    throw new RpcError(-32602, 'Parameters must be an object.', 400);
  return body;
}
export function createBainkMcp({ origins, read, admit, requesterIp, reviewQueue = null, forward = null, tradeAvailability = null }) {
  const hosts = new Set(origins.map((o) => new URL(o).host));
  // Without the server's availability (a bare test server) Trade reads as paused, like the server default.
  const tradePaused = tradeAvailability ? tradeAvailability.paused : true;
  const discovery = mcpDiscovery(tradePaused);
  let active = 0;
  async function dispatch(method, p, audience, req) {
    // MCP lets clients attach _meta to any request (Claude Code sends
    // claudecode/toolUseId, others send progressToken). It is opaque protocol
    // metadata: bound its size, never echo or act on it, and strip it before
    // the documented-fields checks below.
    let meta;
    if (plain(p) && Object.hasOwn(p, '_meta')) {
      meta = p._meta;
      if (!plain(meta) || Object.keys(meta).length > 32 || JSON.stringify(meta).length > 4096) invalid();
      const { _meta: _m, ...rest } = p;
      p = rest;
    }
    if (method === 'initialize') {
      params(
        p,
        ['protocolVersion', 'capabilities', 'clientInfo'],
        ['protocolVersion', 'capabilities', 'clientInfo'],
      );
      if (
        typeof p.protocolVersion !== 'string' ||
        p.protocolVersion.length > 50 ||
        !plain(p.capabilities) ||
        !plain(p.clientInfo) ||
        typeof p.clientInfo.name !== 'string' ||
        typeof p.clientInfo.version !== 'string' ||
        p.clientInfo.name.length > 200 ||
        p.clientInfo.version.length > 100
      )
        invalid();
      return {
        protocolVersion: VERSIONS.includes(p.protocolVersion)
          ? p.protocolVersion
          : VERSIONS[0],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'baink', version: MCP_VERSION },
        instructions: discovery.instructions,
      };
    }
    if (method === 'ping') {
      params(p, []);
      return {};
    }
    if (
      [
        'tools/list',
        'resources/list',
        'prompts/list',
        'resources/templates/list',
      ].includes(method)
    ) {
      params(p, []);
      if (method === 'tools/list') return { tools: discovery.tools };
      if (method === 'resources/list')
        return {
          resources: [
            {
              uri: 'baink://onboarding',
              name: 'BAINK onboarding',
              mimeType: 'text/plain',
              description:
                'Public scope, source authority, key custody and supported next steps.',
            },
          ],
        };
      if (method === 'resources/templates/list')
        return { resourceTemplates: [] };
      return {
        prompts: [
          {
            name: 'baink_start',
            description:
              'Explore BAINK with human approval, local key custody and truthful readiness.',
            arguments: [],
          },
        ],
      };
    }
    if (method === 'resources/read') {
      params(p, ['uri'], ['uri']);
      if (p.uri !== 'baink://onboarding') invalid();
      return {
        contents: [
          { uri: p.uri, mimeType: 'text/plain', text: discovery.instructions },
        ],
      };
    }
    if (method === 'prompts/get') {
      params(p, ['name', 'arguments'], ['name']);
      if (p.name !== 'baink_start') invalid();
      if (p.arguments !== undefined) params(p.arguments, []);
      return {
        description: 'BAINK public discovery activation',
        messages: [
          { role: 'user', content: { type: 'text', text: ACTIVATION_PROMPT } },
        ],
      };
    }
    if (method === 'tools/call') {
      params(p, ['name', 'arguments'], ['name']);
      if (MEMBER_TOOL_NAMES.includes(p.name)) {
        // The no-install member path (mcp-member.mjs): its own argument checks, then the same
        // signed BAINK HTTP handling the kit uses.
        if (!forward && p.name === 'baink_member_request')
          return refusal('member_path_unavailable', 'Signed requests are not available on this server. Nothing was sent.', { do: 'Ask the guide.', tool: 'baink_guide', args: { question: 'how do I start?' } });
        let out;
        try {
          out = await memberCall(p.name, p.arguments === undefined ? {} : p.arguments, { forward: (request) => forward(request, req) });
        } catch {
          return refusal('outcome_unknown', 'BAINK did not answer this request, so its outcome is unknown. Do not send a write again: read your steps first.', { do: 'Read your steps (sign it first); a sent step shows there and is settled with its reconcile call.', sign: 'sign_request(key, "GET", "/api/native/central/intents")', tool: 'baink_member_request', args: { '...': 'the dictionary sign_request returns' } });
        }
        return result(out.data, out.isError, out.next);
      }
      const tool = ALL_TOOLS.find((t) => t.name === p.name);
      if (!tool) invalid();
      // Progress tokens are accepted as opaque protocol metadata; no progress stream is advertised.
      if (
        meta &&
        Object.hasOwn(meta, 'progressToken') &&
        !(
          (typeof meta.progressToken === 'string' && meta.progressToken.length <= 128) ||
          Number.isSafeInteger(meta.progressToken)
        )
      )
        invalid();
      let name = p.name;
      let args = validate(
        p.arguments === undefined ? {} : p.arguments,
        tool.inputSchema,
      );
      if (name === 'baink_guide') {
        let answer = guideAnswer('baink', args, { tradeMode: tradePaused ? 'paused' : 'open' });
        // The first screen names the exact signer this server hands out, so an AI can check what it runs.
        if (answer.signer) answer = { ...answer, signer: { ...answer.signer, sha256: SIGNER.sha256 } };
        // The review answer carries the live queue figure when one is already at hand (never waits for it).
        const queue = answer.topic === 'review' || answer.alsoAnswered?.topic === 'review' ? reviewQueue?.peek?.() : null;
        return result(queue ? { ...answer, reviewQueue: { note: queue.note, waiting: queue.waiting, oldestSince: queue.oldestSince, limits: queue.limits, asOf: queue.asOf } } : answer);
      }
      const view = name === 'baink_trade' ? args.view ?? 'offers' : undefined;
      if (name === 'baink_trade') {
        const call = tradeCall(args);
        if (typeof call === 'string')
          return refusal('invalid_arguments', call + ' Nothing was read.', { do: 'List the services on offer first.', tool: 'baink_trade', args: { view: 'offers' } });
        [name, args] = call;
        args = validate(args, ALL_TOOLS.find((t) => t.name === name).inputSchema);
      }
      if (args.id && Object.keys(args).length !== 1) invalid();
      if (
        args.address &&
        Object.keys(args).some(
          (k) =>
            !(
              name === 'baink_members'
                ? ['address', 'page', 'pageSize']
                : ['address']
            ).includes(k),
        )
      )
        invalid();
      const next = nextFor(p.name, view, tradePaused);
      if (name === 'baink_onboarding') return result(discovery.onboarding, false, next);
      if (name === 'baink_connections') return result(discovery.connections);
      // The same proved-read budget as GET /api/public/contribution/<address>
      // (13 November 2026): 30 a minute for each address asking.
      if (name === 'baink_contribution') {
        try {
          admit(`public-contribution-ip:${requesterIp(req)}`, 30, 60000);
        } catch {
          return refusal('rate_limited', 'Too many contribution reads from this address. Nothing was changed.', { do: 'Wait a minute and call it once more.', tool: p.name, args: p.arguments ?? {} });
        }
      }
      try {
        const data = await read(name, args, audience);
        if (data?.error || data?.source?.status === 'unavailable')
          return refusal(
            'source_unavailable',
            'This list could not be read just now. Nothing changed, and it does not mean the list is empty.',
            { do: 'Wait a minute and call it once more.', tool: p.name, args: p.arguments ?? {} },
          );
        if (!plain(data)) throw new Error('Invalid public response');
        // An empty search says what to try instead of ending at nothing.
        const empty = name === 'baink_proposals' && args.search && !args.id && Number(data.total) === 0;
        const answer = p.name.startsWith('baink_trade') && !Array.isArray(data) ? { ...data, readOnly: tradePaused ? TRADE_READ_ONLY_PAUSED : TRADE_READ_ONLY } : data;
        const out = result(answer, false, empty ? { do: 'No proposal matched these words. Try one or two broader words, or check published research on uain.global/mcp.', tool: 'baink_proposals', args: { search: '<one broader word>' } } : next);
        if (Buffer.byteLength(JSON.stringify(out)) > 512 * 1024)
          throw new Error('Oversize public response');
        return out;
      } catch (error) {
        // A reader's own 4xx refusal (no such deal, no published profile) is plain and safe to pass on.
        if (error?.status >= 400 && error.status < 500 && typeof error.message === 'string' && error.message.length <= 200 && !/[\u0000-\u001f]/.test(error.message))
          return refusal(
            error.status === 404 ? 'not_found' : 'invalid_arguments',
            error.message + ' Nothing was changed.',
            { do: 'Check the id or address, or list first.', tool: p.name, args: p.name === 'baink_trade' ? { view: view === 'dispute' ? 'disputes' : 'deals' } : {} },
          );
        return refusal(
          'public_read_unavailable',
          'This read failed just now. Nothing was changed.',
          { do: 'Wait a minute and call it once more, or ask the guide.', tool: 'baink_guide', args: { question: 'a call failed, what now?' } },
        );
      }
    }
    throw new RpcError(
      -32601,
      'Method not found. This endpoint provides public discovery only.',
    );
  }
  return async function handle(req, res, url) {
    let id = null,
      admitted = false;
    try {
      if (
        !hosts.has(req.headers.host) ||
        (req.headers.origin && !origins.includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        throw new RpcError(-32000, 'Host or origin is not allowed. Connect your AI to https://baink.money/mcp exactly (not through a web page or another address), then call baink_guide with no arguments.', 403);
      if (url.search)
        throw new RpcError(
          -32600,
          'Endpoint query parameters are not supported.',
          400,
        );
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new RpcError(
          -32000,
          'Use POST; this stateless endpoint has no SSE stream or sessions.',
          405,
        );
      }
      if (
        !accepts(req.headers.accept, 'application/json') ||
        !accepts(req.headers.accept, 'text/event-stream')
      )
        throw new RpcError(
          -32000,
          'Accept must include application/json and text/event-stream.',
          406,
        );
      if (
        !/^application\/json\s*(?:;|$)/i.test(
          String(req.headers['content-type'] ?? ''),
        )
      )
        throw new RpcError(
          -32000,
          'Content-Type must be application/json.',
          415,
        );
      if (
        req.headers['mcp-protocol-version'] !== undefined &&
        !VERSIONS.includes(req.headers['mcp-protocol-version'])
      )
        throw new RpcError(-32000, 'Unsupported MCP protocol version.', 400);
      if (req.headers['mcp-session-id'] !== undefined)
        throw new RpcError(-32000, 'Sessions are not supported.', 400);
      try {
        admit(`mcp:${requesterIp(req)}`, 120, 60000);
      } catch {
        res.setHeader('Retry-After', '60');
        throw new RpcError(
          -32000,
          'MCP admission limit reached. Retry later.',
          429,
        );
      }
      if (active >= 8)
        throw new RpcError(-32000, 'MCP is busy. Retry later.', 503);
      active++;
      admitted = true;
      const body = await readMessage(req);
      id = body.id ?? null;
      if (!Object.hasOwn(body, 'id')) {
        if (
          ![
            'notifications/initialized',
            'notifications/cancelled',
            'notifications/progress',
          ].includes(body.method)
        )
          throw new RpcError(-32600, 'Unsupported notification.', 400);
        // No shared request/session map: one client cannot cancel another client's ID.
        send(res, 202);
        return;
      }
      const audience = origins.find(
        (o) => new URL(o).host === req.headers.host,
      );
      const data = await dispatch(body.method, body.params ?? {}, audience, req);
      send(res, 200, { jsonrpc: '2.0', id, result: data });
    } catch (error) {
      const known = error instanceof RpcError;
      if (!res.headersSent && !res.destroyed)
        send(res, known ? error.status : 500, {
          jsonrpc: '2.0',
          id,
          error: {
            code: known ? error.code : -32603,
            message: known
              ? error.message
              : 'The MCP request could not be completed.',
          },
        });
    } finally {
      if (admitted) active--;
    }
  };
}
