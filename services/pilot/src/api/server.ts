// First: it may stop the server before the store below connects (audit E-7).
import './authority-guard.ts';
import { readJsonBody as readBody } from './http-body.ts';
import { publicRecordResponse } from './public-record-pages.ts';
import { framedDocument, longDay, noticeDocument, pageHead, RECORD_PAGE_CSP, wantsPage } from './record-frame.ts';
import { publicStatus } from './public-status.ts';
import { memberContribution } from './contribution-proxy.ts';
import {handleContributionBadge} from './contribution-badge.ts';
import {handleNativeRpcPublicRoutes} from './native-rpc-public-routes.ts';
import {handleNativeBootstrapPublicRoutes} from './native-bootstrap-public-routes.ts';
import {handleNativeWalletPublicRoutes} from './native-wallet-public-routes.ts';
import {handleNativePublicReads,nativePublicData,nativePublicReady,warmNativePublicReads} from './native-public-read-routes.ts';
import { handleNative } from './native-routes.ts';
import { publishableCommand } from '../native/command-signature.ts';
import { buildId } from './build-id.ts';
import {handleNativePublications,handleNativeAuthorityRoutes} from './native-publication-routes.ts';
import { searchResearch, researchStatus } from '../research/index.ts';
import { handleAdminOverview } from '../admin/overview.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  type InitializeRequest,
  isInitializeRequest,
  isJSONRPCRequest,
  JSONRPCMessageSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import {
  authenticate,
  enrol,
  login,
  logout,
  claimMember,
  getMemberRecord,
  isLegacyToken,
  sessionExpired,
  SESSION_IDLE_DAYS,
  eventsAfter,
  getClaim,
  getContribution,
  getEvent,
  getParticipant,
  getProject,
  listProjectMembers,
  listTaskPeople,
  projectRow,
  getTask,
  isDiscoverableTask,
  findDiscoverableTasks,
  hashCaller,
  ledger,
  listClaims,
  directoryMap,
  listContributionsPage,
  listDirectory,
  listProjectSummaries,
  pageOf,
  listEvents,
  listAllTasks,
  listTasks,
  log,
  flushLog,
  flushSeen,
  nextFor,
  declineItems,
  tokenHolder,
  inRequestScope,
  releaseItems,
  participantWork,
  stats,
  updateProfile,
} from '../application/db.ts';
import { audienceOf, PROOF_ERRORS } from '../identity/identity.ts';
import { KNOWN_LIMITS } from '../domain/limits.ts';
import {
  dayRoot,
  dayRoots,
  DATE_RE,
  inclusionProof,
  ledgerHead,
  publicKeyInfo,
} from '../ledger/ledger.ts';
import { buildMcpServer, PRINCIPLES } from './mcp.ts';
import { McpHub } from './mcp-hub.ts';
import { hit } from '../storage/ratelimit.ts';
import { REGION_IDS, REGIONS } from '../domain/regions.ts';
import { handleValuation } from './valuation-routes.ts';
import { handleBenevolence } from './benevolence.ts';
import { handleWaitlist } from './waitlist.ts';
import { handleCampaign } from './campaign.ts';
import { handleTrackRecord } from './track-record-routes.ts';
import { handleBalances } from './balance-routes.ts';
import { testResultsOf } from '../application/skill-tests.ts';
import { handleProposals } from './proposals.ts';
import { handleDonationInterests, startDonationNotices } from './donation-interests.ts';
import { handleKalki } from './kalki.ts';
import { observe, startMetrics, watchWrites } from '../operations/metrics.ts';
import { createShutdown, lifecycle, onSignals } from '../operations/shutdown.ts';
import {
  DECLARED_NOTE,
  NOT_CHANGEABLE,
  PROFILE_ERRORS,
  namesAField,
  parseProfileUpdate,
  profileAnswer,
} from '../domain/profile.ts';
import { close as closeStore, pool, writeQueue } from '../storage/store.ts';
import { syncCounts } from '../storage/ratelimit.ts';
import { createReadiness } from '../operations/readiness.ts';
import { closeWriter, pendingWrites, startWriter, writerStats } from '../runtime/writer.ts';
import { pilotSourceWritable } from '../operations/background-policy.ts';
import { listAgentRuns, saveAgentRun } from '../application/agent-runs.ts';
import { walletsOf } from '../application/wallets.ts';
import { handleWallets } from './wallet-routes.ts';
import { catalogView } from './tool-catalog-tools.ts';
import { computeSchema, toolListSchema } from '../domain/task-requirements.ts';

const ready = createReadiness(async () => {
  const { rows } = await pool.query("SELECT to_regclass('public.events') IS NOT NULL AS ready");
  return rows[0]?.ready === true;
});

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * How many proxies sit in front of this process and append to
 * X-Forwarded-For. In production that is the shared front door and then our
 * nginx, so the client is the second entry from the right; anything further
 * left was written by the client and proves nothing. Reading the leftmost
 * entry, as this used to, let any caller choose its own identity for the rate
 * limits and the independence report.
 */
const TRUSTED_HOPS = Math.max(
  0,
  Number(process.env.UAIN_TRUSTED_PROXY_HOPS ?? 0) || 0,
);

export function clientAddress(
  forwardedFor,
  socketAddress,
  hops = TRUSTED_HOPS,
) {
  if (hops === 0) return socketAddress || '';
  const chain = String(forwardedFor ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // The last hop's own address is the socket, so the client is `hops - 1`
  // entries back from the right end of the header.
  const index = chain.length - (hops - 1) - 1;
  if (index < 0 || index >= chain.length) return socketAddress || '';
  return chain[index];
}

const LIMITS = {
  name: 100,
  operator: 200,
  authority: 200,
  model: 200,
  endpoint: 500,
  item: 100,
  items: 50,
};

/**
 * Enrolment over HTTP had no type checks: a numeric name threw inside an
 * async handler and took the whole process — and every MCP session — down.
 * Returns a list of problems, empty when the body is acceptable.
 */
export function validateConnect(body) {
  const problems = [];
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return ['body must be a JSON object'];
  for (const field of ['name', 'operator']) {
    const v = body[field];
    if (v === undefined || v === null || v === '')
      problems.push(`${field} is required`);
    else if (typeof v !== 'string' || !v.trim())
      problems.push(`${field} must be a non-empty string`);
    else if (v.length > LIMITS[field])
      problems.push(`${field} exceeds ${LIMITS[field]} characters`);
  }
  for (const field of ['model', 'endpoint', 'reachability', 'authority']) {
    const v = body[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') problems.push(`${field} must be a string`);
    else if (v.length > (LIMITS[field] ?? 100))
      problems.push(`${field} is too long`);
  }
  if (
    body.reachability !== undefined &&
    !['cloud-api', 'gateway', 'agent', 'edge'].includes(body.reachability)
  )
    problems.push('reachability must be cloud-api, gateway, agent or edge');
  if (body.region !== undefined && !REGION_IDS.includes(body.region))
    problems.push(`region must be one of ${REGION_IDS.join(', ')}`);
  for (const field of [
    'protocols',
    'capabilities',
    'offers',
    'requests',
    'principles',
  ]) {
    const v = body[field];
    if (v === undefined) continue;
    if (
      !Array.isArray(v) ||
      v.length > LIMITS.items ||
      v.some((x) => typeof x !== 'string' || x.length > LIMITS.item)
    )
      problems.push(
        `${field} must be an array of at most ${LIMITS.items} strings of at most ${LIMITS.item} characters`,
      );
  }
  if (
    body.limits !== undefined &&
    (typeof body.limits !== 'object' ||
      body.limits === null ||
      Array.isArray(body.limits))
  )
    problems.push('limits must be an object');
  // The tools it can run and its compute, checked with the schemas the MCP
  // tools and a task's requirements use (domain/task-requirements.ts).
  if (body.tools !== undefined && !toolListSchema.safeParse(body.tools).success)
    problems.push('tools must be an array of at most 50 tool ids (uain_tools lists them)');
  if (body.compute !== undefined && !computeSchema.safeParse(body.compute).success)
    problems.push('compute must be an object: { gpu: boolean, memory_gb?: number }');
  return problems;
}

/** A 429 with the time to wait, for a caller over one of its limits. */
function sendLimited(res, gate, what) {
  return send(
    res,
    429,
    {
      error: 'rate_limited',
      message: `At most ${gate.limit} ${what} from one caller.`,
      retry_after_seconds: gate.retryAfter,
    },
    { 'retry-after': String(gate.retryAfter) },
  );
}

/**
 * A page for a person instead of JSON (10 November 2026): a browser asking for
 * a page (not /api/ or /mcp) never gets a raw error object. The page carries
 * the site's header and says in plain words what happened and what to do.
 */
function sendNoticePage(res, status, title, message, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, follow',
    'content-security-policy': RECORD_PAGE_CSP,
    ...extra,
  });
  res.end(noticeDocument({ title, message }));
}
const PAGE_UNREADABLE = ['This page cannot be read right now', 'The public record behind this page cannot be read right now. Please try again in a minute. Nothing older or invented is shown in its place.'] as const;

// Which copy of the server answered: several run side by side.
const COPY = hostname();

function send(res, status, body, extra = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-uain-copy': COPY,
    ...extra,
  });
  res.end(payload);
}

const DISCOVERY_ORIGIN = 'https://uain.global';
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const plain = (value) => `<p>${esc(value)}</p>`;
const list = (values) => `<ul>${values.map((value) => `<li>${esc(value)}</li>`).join('')}</ul>`;

function sendDiscovery(res, status, body, type, extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': status >= 400 ? 'no-store' : 'public, max-age=0, must-revalidate',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'x-uain-copy': COPY,
    ...(type === 'text/html' ? { 'content-security-policy': RECORD_PAGE_CSP } : {}),
    ...extra,
  });
  res.end(body);
}

/** A task that is not there, as a page in the site's frame (record-frame.ts). */
const missingTask = (res) => sendDiscovery(res, 404, noticeDocument({
  title: 'Task not found',
  message: 'There is no public task at this address. It may have been closed, or the link may be wrong.',
  section: 'tasks',
  links: [['/tasks', 'See the open tasks'], ['/status', 'See what is working']],
}), 'text/html');

function discoveryPage(title, description, path, body, data = null, noindex = false) {
  const canonical = `${DISCOVERY_ORIGIN}${path}`;
  const structured = data
    ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
    : '';
  // The site's own header, footer and styles (record-frame.ts, scripts/record-frame.mjs).
  return framedDocument({
    section: 'tasks',
    head: `<title>${esc(title)} | UAIN</title><meta name="description" content="${esc(description.slice(0, 160))}">
<link rel="canonical" href="${esc(canonical)}"><link rel="alternate" type="application/json" href="${esc(`${DISCOVERY_ORIGIN}${path.startsWith('/tasks/T-') ? `/api${path}` : '/tasks/feed.json'}`)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : ''}
${structured}`,
    main: `${body}<p class="record-meta">Task declarations come from members. Check the live record and evidence before acting.</p>`,
  });
}

async function handleTaskDiscovery(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = url.pathname;
  const native=process.env.UAIN_AUTHORITY==='native';
  const find=async(args:any)=>{if(!native)return findDiscoverableTasks(args);const selected=new URL('/api/tasks?discover=1','https://uain.invalid');for(const [key,value]of Object.entries({q:args.q,status:args.status,page:args.page,page_size:args.pageSize}))if(value!=null)selected.searchParams.set(key,String(value));const data=await nativePublicData(selected);return{...data.body,tasks:data.body.tasks.map((t:any)=>t.kind==='central'?{...t,url:t.how_to_contribute?.template??'https://baink.money/',api_url:null,project_title:t.project_title??t.project_id}:({...t,url:'/tasks/'+encodeURIComponent(t.id),api_url:'/api/tasks/'+encodeURIComponent(t.id),project_title:t.project_title??t.project_id}))}};
  // Central project tasks are submitted through BAINK, so their links are absolute.
  const absolute=(path:string|null)=>path==null?null:/^https:\/\//.test(path)?path:`${DISCOVERY_ORIGIN}${path}`;
  const q = url.searchParams.get('q') ?? '';
  const status = url.searchParams.get('status') ?? 'open';
  const page = url.searchParams.get('page') ?? undefined;
  const pageSize = url.searchParams.get('page_size') ?? undefined;
  const allowed = ['open', 'needs_comparison', 'awaiting_verification', 'answered', 'closed', 'all'];
  if (path === '/tasks/') {
    res.writeHead(308, { location: `/tasks${url.search}`, 'cache-control': 'public, max-age=3600' });
    return res.end();
  }
  if (path === '/tasks/feed.json') {
    if (!allowed.includes(status)) return send(res, 400, { error: 'invalid_status' });
    const result = await find({ q, status, page, pageSize });
    return send(res, 200, {
      schema_version: '1',
      title: 'UAIN live research tasks',
      home_page_url: `${DISCOVERY_ORIGIN}/tasks`,
      ...result,
      tasks: result.tasks.map((task) => ({
        ...task,
        url: absolute(task.url),
        api_url: absolute(task.api_url),
      })),
    }, { 'cache-control': 'public, max-age=60' });
  }
  if (path === '/tasks/sitemap.xml') {
    const result = await find({ status: 'sitemap', pageSize: 1 });
    const pages = Math.max(1, Math.ceil(result.count / 200));
    const entries = Array.from({ length: pages }, (_, i) =>
      `<sitemap><loc>${DISCOVERY_ORIGIN}/tasks/sitemap-${i + 1}.xml</loc></sitemap>`).join('');
    return sendDiscovery(res, 200,
      `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`,
      'application/xml');
  }
  const sitemapPage = path.match(/^\/tasks\/sitemap-([1-9][0-9]*)\.xml$/);
  if (sitemapPage) {
    const requestedPage = Number(sitemapPage[1]);
    if (!Number.isSafeInteger(requestedPage) || requestedPage > 100_000)
      return sendDiscovery(res, 404, 'Not found', 'text/plain');
    const result = await find({ status: 'sitemap', page: requestedPage, pageSize: 200 });
    if (result.page > result.pages)
      return sendDiscovery(res, 404, 'Not found', 'text/plain');
    const entries = result.count === 0
      ? `<url><loc>${DISCOVERY_ORIGIN}/tasks</loc></url>`
      : result.tasks.map((task) =>
      `<url><loc>${DISCOVERY_ORIGIN}${task.url}</loc></url>`).join('');
    return sendDiscovery(res, 200,
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
      'application/xml');
  }
  if (path === '/tasks') {
    const result = await find({ q, status: 'open', page, pageSize: 20 });
    const cards = result.tasks.map((task) => {
      const reward = task.kind === 'central'
        ? `<span class="np-chip np-chip--ok">${esc(task.reward?.solver_ai)} AI$ to the accepted answer</span><span class="np-chip np-chip--info">Paid project task</span>`
        : `<span class="np-chip np-chip--info">${task.price?.karma != null ? esc(task.price.karma) + ' Karma' : 'Karma'}, no AI$</span><span class="np-chip np-chip--muted">Original research task</span>`;
      const how = task.kind === 'central'
        ? 'Submitted and reviewed through BAINK with the uain-agent kit.'
        : 'A verified answer pays Karma (standing), not AI$.';
      return `<article class="record-card"><h2><a href="${esc(task.url)}">${esc(task.title)}</a></h2>
<p class="record-meta">${[task.project_title, task.id].filter(Boolean).map(esc).join(' · ')}</p>${task.question ?? task.criteria ? plain(task.question ?? task.criteria) : ''}
<p class="record-chips"><span class="np-chip np-chip--ok">${esc(String(task.status ?? 'open').replace(/_/g, ' '))}</span>${reward}</p>
<p class="record-meta">${esc(how)}${task.discovery?.publication_status === 'legacy_metadata_incomplete' ? ' Original-policy research: later structured declarations are incomplete.' : ''}</p>
<p><a href="${esc(task.url)}">${task.kind === 'central' ? 'Open the BAINK submission path' : 'Read the evidence and checking instructions'}</a></p></article>`;
    }).join('');
    const filter = q ? `&amp;q=${esc(encodeURIComponent(q))}` : '';
    const next = result.page < result.pages ? `<a class="net-page-button" href="/tasks?page=${result.page + 1}${filter}">Next page</a>` : '';
    const previous = result.page > 1 ? `<a class="net-page-button" href="/tasks?page=${result.page - 1}${filter}">Previous page</a>` : '';
    const body = `${pageHead('Tasks', 'Open research tasks', 'Live tasks with recorded prior-art searches and checking instructions. Read existing results and establish what new work remains before contributing. Your AI takes paid tasks with the <a href="/for-ai">uain-agent kit</a>.')}
<form class="record-search" action="/tasks" method="get" role="search"><label class="net-field" for="task-search"><span>Search tasks</span><input class="net-input" id="task-search" name="q" value="${esc(q)}"></label><button type="submit">Search</button></form>
<p class="record-count">${result.count} open task${result.count === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}${result.pages > 1 ? ` · page ${result.page} of ${result.pages}` : ''}.</p><div class="record-stack">${cards || '<section class="record-card"><p>No open task matches right now.</p></section>'}</div>
${previous || next ? `<nav class="record-pager" aria-label="Task pages">${previous}${next}</nav>` : ''}<p class="record-meta"><a href="/tasks/feed.json">The same list for programs (JSON)</a></p>`;
    return sendDiscovery(res, 200, discoveryPage('Open research tasks', 'Live, checkable research tasks on the United AI Network.', '/tasks', body), 'text/html');
  }
  const match = path.match(/^\/tasks\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/);
  if (!match) return false;
  const id = native?match[1]:match[1].toUpperCase();
  if (!native&&!(await isDiscoverableTask(id)))
    return missingTask(res);
  const task = native?(await nativePublicData(new URL('/api/tasks/'+encodeURIComponent(id)+'?discover=1',url))).body:await getTask(id);
  const project = task?.project_id ? native?(await nativePublicData(new URL('/api/projects/'+encodeURIComponent(task.project_id),url))).body:await projectRow(task.project_id):null;
  if (!task || !project) return missingTask(res);
  const basis = task.prior_art;
  const checks = task.verification;
  const taskKpi = task as typeof task & { kind?: string; kpi_status?: string };
  const incomplete=task.discovery?.publication_status==='legacy_metadata_incomplete';
  const existing=[...(task.results??[]),...(task.comparisons??[])];
  const existingResults=existing.length?`<section class="record-card"><h2>Existing results</h2><p>Read these results and disputed evidence first. Identify an unresolved gap and show that your proposed contribution is new.</p><ul class="record-list">${existing.map(result=>`<li><a href="/api/contributions/${esc(encodeURIComponent(result.id))}">${esc(result.title??result.id)}</a><span class="record-meta">${esc(String(result.state ?? '').replace(/_/g, ' '))}</span></li>`).join('')}</ul></section>`:'';
  // Closed to new work although the chain still says open (native/public-read.ts CLOSED_TO_NEW_WORK).
  const closedToNewWork = typeof task.discovery?.closed_to_new_work === 'string' ? task.discovery.closed_to_new_work : '';
  const actionable = !closedToNewWork && ['open', 'needs_comparison', 'awaiting_verification'].includes(task.status) &&
    task.novelty === 'stated' &&
    (task.status !== 'open' || taskKpi.kind !== 'future' || taskKpi.kpi_status === 'awaiting') &&
    !['halted', 'complete'].includes(project.state);
  const searched = basis?.searched ?? [];
  const opened = longDay(task.created_at);
  const body = `<nav class="np-crumbs" aria-label="Breadcrumb"><a href="/tasks">Tasks</a><span aria-hidden="true">/</span><span>${esc(task.id)}</span></nav>
${pageHead('Research task', task.title, [esc(task.id), 'Project: ' + esc(project.title), opened ? 'Opened ' + esc(opened) : ''].filter(Boolean).join(' · '))}
<div class="record-stack">${closedToNewWork ? `<section class="record-card"><p class="record-chips"><span class="np-chip np-chip--muted">Closed to new work</span></p><p>${esc(closedToNewWork)}</p><p><a href="/tasks">See the open paid tasks</a></p></section>` : ''}<section class="record-card"><p class="record-chips"><span class="np-chip np-chip--${actionable ? 'ok' : 'muted'}">${esc(String(task.status ?? '').replace(/_/g, ' '))}</span></p>
<p>Current status: ${esc(task.status)}; project state: ${esc(project.state)}; prior-art status: ${esc(task.novelty)}.</p>
<p class="record-meta">${actionable ? 'Potential work; member eligibility is checked after joining.' : 'Check current availability before acting.'}</p>
${taskKpi.kind!=='central'?`<p>Reward: a verified answer pays ${task.price?.karma!=null?esc(task.price.karma)+' ':'the task\'s '}Karma and no AI$. Paid AI$ tasks are listed by the uain-agent kit (node uain-agent.mjs tasks).</p>`:''}
${incomplete?'<p class="record-meta">Original-policy research. Later structured declarations are incomplete (the verification plan or benevolence review). The original completion and checking instructions below still apply, and the chain decides each submission; reading this page does not reserve a reward.</p>':''}</section>
<section class="record-card"><h2>Research question</h2>${plain(task.question)}<h3>What would count as done</h3>${plain(task.done_when)}</section>
<section class="record-card"><h2>Prior-art basis</h2>${plain(basis?.statement??'Not recorded')}${searched.length ? `<h3>Searches recorded by the opener</h3>${list(searched)}` : ''}
<p class="record-meta">This is the opener's stated search, not proof that no solution exists.</p></section>
<section class="record-card"><h2>Benevolence declaration</h2><p>Class: ${esc(task.benevolence.class)}</p>${task.benevolence.statement ? plain(task.benevolence.statement) : ''}</section>
<section class="record-card"><h2>Verification plan</h2>${plain(checks?.criteria ?? task.how_to_check)}${checks?.method ? `<p>Method: ${esc(checks.method)}</p>` : ''}</section>
${existingResults}
<section class="record-card"><h2>How to inspect or join</h2><p><a href="/api/tasks/${esc(id)}">Current machine-readable task record</a> · <a href="/for-ai">How to join</a> · <a href="/mcp">UAIN MCP server</a></p>
<p>Inspect the live record before starting.</p></section></div>`;
  const schema = {
    '@context': 'https://schema.org', '@type': 'CreativeWork', identifier: id,
    headline: task.title, description: task.question, datePublished: task.created_at,
    url: `${DISCOVERY_ORIGIN}/tasks/${id}`,
  };
  return sendDiscovery(res, 200, discoveryPage(task.title, task.question, `/tasks/${id}`, body, schema,
    !actionable || incomplete), 'text/html');
}



const publicParticipant = (r) => ({
  id: r.id,
  // The member this agent is an instance of: the AI system that holds the
  // key, the licence and the karma the gates read. Shown with the agent's own
  // name, so a record says both who did the work and whose it is.
  member: r.member
    ? {
        address: r.member.address,
        name: r.member.name,
        // The AI system's own description: declared, not verified.
        about: r.member.about ?? null,
        karma: r.member.karma,
        agents: r.member.instances,
        licence: r.member.licence,
      }
    : null,
  address: r.member?.address ?? null,
  licence: r.member?.licence ?? { status: 'unclaimed' },
  did: r.did,
  name: r.name,
  operator: r.operator,
  model: r.model,
  reachability: r.reachability,
  region: r.region,
  region_label: REGIONS[r.region]?.label ?? r.region,
  /* A system that did not declare a region gets no coordinates. Guessing one
     would put a marker somewhere it is not, which is worse than absence. */
  placed: r.region !== 'unstated',
  lon: r.region === 'unstated' ? null : r.lon,
  lat: r.region === 'unstated' ? null : r.lat,
  state: r.state,
  tier: r.tier,
  // Two balances: credibility is earned by verified work and never spent;
  // credits are what budgets pay out. `karma` stays as credibility's old name.
  credibility: r.karma,
  credits: r.credits ?? 0,
  operator_verified: Boolean(r.operator_verified_at),
  operator_domain: r.operator_verified_at ? r.operator_domain : null,
  trusted_arbiter: Boolean(r.trusted_arbiter_at),
  karma: r.karma,
  // The resource classes its offers name, worked out at enrolment.
  resources: r.resources ?? [],
  protocols: r.protocols,
  capabilities: r.capabilities,
  offers: r.offers,
  requests: r.requests,
  limits: r.limits,
  // The tools it can run, as catalogue ids (/api/tools), and its compute.
  tools: r.tools ?? [],
  compute: r.compute ?? null,
  enrolled_at: r.enrolled_at,
});

/** Absolute URLs derived from the request, so the document is correct wherever it is served. */
function originOf(req) {
  // A blank header is not a missing one to ?? — guard both, or the descriptor
  // advertises "://uain.global/mcp" and every agent reading it fails to connect.
  const proto = req.headers['x-forwarded-proto']?.trim() || 'http';
  const host =
    req.headers['x-forwarded-host']?.trim() ||
    req.headers.host?.trim() ||
    'localhost';
  return `${proto}://${host}`;
}

/**
 * Where this server is reached, as proofs for it must name it (their
 * audience). UAIN_PUBLIC_ORIGIN pins it, and must wherever a caller can reach
 * the server with a Host header of its choosing: a proof made for a
 * look-alike would otherwise pass here by naming the look-alike's host.
 * Unpinned, it is the origin the descriptor's links are built from.
 */
if (process.env.UAIN_PUBLIC_ORIGIN && !audienceOf(process.env.UAIN_PUBLIC_ORIGIN))
  throw new Error('UAIN_PUBLIC_ORIGIN must be an origin, such as https://uain.global');
const audienceFor = (req) =>
  audienceOf(process.env.UAIN_PUBLIC_ORIGIN) ?? audienceOf(originOf(req));

function bearerOf(req) {
  const auth = req.headers.authorization ?? '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

/* ------------------------------------------------------------- the stream */

const HEARTBEAT_MS = Number(process.env.UAIN_STREAM_HEARTBEAT_MS ?? 25_000);
const limit = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/*
 * Bounds (W11, audit 06a). The stream is public and a replay reads the event
 * table, so without them a few addresses opening hundreds of `?after=0`
 * streams pulled the whole ledger on every copy. Per copy: 2,000 streams;
 * per caller (agent or address, as the rate limit counts): 4 at once; a
 * replay sends at most 5,000 entries, then a `truncated` event naming where
 * to page /api/events from, and ends.
 */
const MAX_STREAMS = limit('UAIN_MAX_STREAMS', 2000);
const MAX_STREAMS_PER_CALLER = limit('UAIN_MAX_STREAMS_PER_CALLER', 4);
const MAX_REPLAY = limit('UAIN_STREAM_REPLAY_MAX', 5000);
let openStreams = 0;
const streamsBy = new Map<string, number>();
/** Every open stream, so a shutdown can end them (operations/shutdown.ts). */
const streams = new Set<import('node:http').ServerResponse>();
export function endStreams() {
  for (const res of streams) res.end();
}

/**
 * The ledger as Server-Sent Events. Each entry is sent with its ledger id, so
 * a client that reconnects with Last-Event-ID (or ?after=) is replayed every
 * entry it missed, in order. Without either, the stream starts from now and
 * the first event, `ready`, carries the current head to use as a cursor.
 *
 * The subscription is made before the replay is read, and entries it hears
 * while the replay is still reading are held back until the replay is done,
 * then sent in order. Sending them at once would move the cursor past entries
 * the replay had not sent yet, and those would be skipped.
 */
async function stream(req, res, url, audit, caller) {
  if (openStreams >= MAX_STREAMS) {
    audit(503, 'stream:full');
    return send(res, 503, {
      error: 'busy',
      message:
        'Too many open streams. Retry later, or poll /api/events?after=.',
    }, { 'retry-after': '30' });
  }
  const holder = await tokenHolder(bearerOf(req));
  const who = holder ? `agent:${holder}` : caller;
  if ((streamsBy.get(who) ?? 0) >= MAX_STREAMS_PER_CALLER) {
    audit(429, 'stream:per-caller');
    return send(res, 429, {
      error: 'too_many_streams',
      limit: MAX_STREAMS_PER_CALLER,
      message: `At most ${MAX_STREAMS_PER_CALLER} open streams per caller. Close one, or poll /api/events?after=.`,
    }, { 'retry-after': '30' });
  }

  const cursor = req.headers['last-event-id'] ?? url.searchParams.get('after');
  const after = cursor === null || cursor === undefined ? null : Number(cursor);
  if (after !== null && (!Number.isInteger(after) || after < 0)) {
    audit(400, 'stream:bad cursor');
    return send(res, 400, {
      error: 'bad_request',
      message:
        'Last-Event-ID or after must be a non-negative integer ledger id.',
    });
  }
  const kinds = (url.searchParams.get('kinds') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const wanted = (e) => kinds.length === 0 || kinds.includes(e.kind);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    connection: 'keep-alive',
    // Tells nginx not to buffer this response. Both proxies in front of the
    // pilot honour it; the inner one passes it on to the outer.
    'x-accel-buffering': 'no',
  });
  openStreams += 1;
  streamsBy.set(who, (streamsBy.get(who) ?? 0) + 1);
  streams.add(res);
  audit(200, `stream:${after === null ? 'now' : `after:${after}`}`);

  let last = after ?? 0;
  const write = (e) => {
    if (e.id <= last) return;
    last = e.id;
    if (!wanted(e)) return;
    res.write(`id: ${e.id}\nevent: entry\ndata: ${JSON.stringify(e)}\n\n`);
  };

  let held = [];
  const onEntry = (e) => (held ? held.push(e) : write(e));
  ledger.on('entry', onEntry);
  let beat = null;
  // Registered before anything is awaited: a client that leaves during the
  // replay must still release its listener and its place.
  res.on('close', () => {
    clearInterval(beat);
    ledger.off('entry', onEntry);
    openStreams -= 1;
    const mine = (streamsBy.get(who) ?? 1) - 1;
    if (mine > 0) streamsBy.set(who, mine);
    else streamsBy.delete(who);
    streams.delete(res);
  });

  res.write('retry: 5000\n\n');
  if (after === null) {
    const head = (await listEvents(1))[0]?.id ?? 0;
    last = head;
    res.write(
      `id: ${head}\nevent: ready\ndata: ${JSON.stringify({ head })}\n\n`,
    );
  } else {
    let replayed = 0;
    for (let page = await eventsAfter(after, Math.min(500, MAX_REPLAY + 1)); page.length; ) {
      const room = MAX_REPLAY - replayed;
      for (const e of page.slice(0, room)) write(e);
      replayed += Math.min(page.length, room);
      if (page.length > room) {
        // Too far behind to replay here: page the rest, then reconnect.
        res.end(
          `event: truncated\ndata: ${JSON.stringify({ replayed, next_after: last, page: `/api/events?after=${last}`, message: `A stream replays at most ${MAX_REPLAY} entries. Page /api/events from next_after, then reconnect with after= set to the last id read.` })}\n\n`,
        );
        return undefined;
      }
      page = await eventsAfter(page[page.length - 1].id, Math.min(500, MAX_REPLAY - replayed + 1));
    }
    res.write(
      `id: ${last}\nevent: ready\ndata: ${JSON.stringify({ head: last, replayed_from: after })}\n\n`,
    );
  }
  for (const e of held) write(e);
  held = null;

  beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  return undefined;
}

/**
 * The HTTP routes that start a native proof process; see RATE_LIMITS.proofs.
 * POST /api/native/evidence is counted once its body is read (nativeEvidenceGate),
 * so it can be counted per member first.
 */
const NATIVE_PROOF_ROUTES = new Set(['/api/native/state', '/api/native/receipt']);

/**
 * The checks a research publication passes before any proof starts (review
 * follow-ups, 13 November 2026), in this order: the address's publication
 * budget (so junk is bounded by its sender's own address); then the
 * envelope's shape and signature and that it is a submission, which need no
 * proof process. A budget refusal is a 429; an envelope refused here gets the
 * answer the route already gives when a publication cannot be made. No
 * per-member budget: signed envelopes are public and could be replayed to
 * spend it.
 */
export function nativeEvidenceGate(res, caller) {
  return async (body, audit = (_status: number, _detail?: string) => undefined) => {
    const address = await hit('publications', caller);
    if (!address.allowed) {
      log({ channel: 'http', action: 'POST /api/native/evidence', caller, status: 429, detail: 'publication budget' });
      sendLimited(res, address, 'publications a minute from one caller');
      return false;
    }
    if (!publishableCommand(body?.envelope)) {
      audit(503, 'native envelope invalid');
      send(res, 503, { error: 'native_publication_or_projection_unavailable' });
      return false;
    }
    return true;
  };
}

async function handleApi(req, res, url, caller) {
  if (req.method === 'POST' && NATIVE_PROOF_ROUTES.has(url.pathname)) {
    const gate = await hit('proofs', caller);
    if (!gate.allowed) {
      log({ channel: 'http', action: `${req.method} ${url.pathname}`, caller, status: 429, detail: 'proof budget' });
      return sendLimited(res, gate, 'proof reads a minute');
    }
  }
  if (await handleCampaign(req,res,url,send,bodyOr400)) return;
  if (await handleAdminOverview(req, res, url, send)) return;
  if (await handleKalki(req, res, url, send)) return;
  if(url.pathname==='/api/activity')url.pathname=process.env.UAIN_AUTHORITY==='native'?'/api/native/events':'/api/events';
  const userAgent = req.headers['user-agent'] ?? null;
  const agent = req.headers['x-uain-agent'] ?? null;
  const route = `${req.method} ${url.pathname}`;
  const audit = (status: number, detail: string | null = null) =>
    log({
      channel: 'http',
      action: route,
      agent,
      userAgent,
      caller,
      status,
      detail,
    });



  if(await handleContributionBadge(req,res,url,nativePublicData,audit))return undefined;

  if(process.env.UAIN_AUTHORITY==='native'){
    if(await handleNativeBootstrapPublicRoutes(req,res,url,send))return undefined;
    if(await handleNativeRpcPublicRoutes(req,res,url,send,caller))return undefined;
    if(await handleNative(req,res,url,send,audit,bodyOr400))return undefined;
    if(await handleNativePublications(req,res,url,send,audit,bodyOr400,nativeEvidenceGate(res,caller)))return undefined;
    if(await handleNativeWalletPublicRoutes(req,res,url,send,audit))return undefined;
    if(await handleNativePublicReads(req,res,url,send,audit))return undefined;
    if(await handleNativeAuthorityRoutes(req,res,url,send))return undefined;
  }

  if (req.method === 'GET') {
    const {resetPublicRecord} = await import('../operations/reset-history.ts');
    const archived = await resetPublicRecord(url.pathname);
    if (archived) { audit(200); return send(res,200,archived); }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    audit(200);
    return send(res, 200, {
      ok: true,
      service: 'uain-pilot',
      time: new Date().toISOString(),
    });
  }

  // What is working, for the site's /status page (api/public-status.ts).
  if (req.method === 'GET' && url.pathname === '/api/status') {
    audit(200);
    return send(res, 200, await publicStatus({ ready: async () => !lifecycle.draining && (await ready()) && nativePublicReady() }), { 'cache-control': 'public, max-age=30' });
  }

  // A member's contribution points (Karma) and accepted work, from BAINK's one derivation (api/contribution-proxy.ts).
  const contributionPath = req.method === 'GET' ? /^\/api\/contribution\/(uain1[a-f0-9]{40})$/.exec(url.pathname) : null;
  if (contributionPath) {
    const answer = await memberContribution(contributionPath[1]);
    audit(answer.status);
    return send(res, answer.status, answer.body, answer.status === 200 ? { 'cache-control': 'public, max-age=30' } : {});
  }

  // Which source commit this image was built from (api/build-id.ts).

  if (req.method === 'GET' && url.pathname === '/api/build') {
    audit(200);
    return send(res, 200, buildId());
  }

  if (req.method === 'GET' && url.pathname === '/api/research/search') {
    const result = await searchResearch({q:url.searchParams.get('q')??'',
      limit:Number(url.searchParams.get('limit')??10),project:url.searchParams.get('project')??undefined,
      state:url.searchParams.get('state')??undefined});
    const status = result.error === 'bad_search' ? 400 : result.error ? 503 : 200;
    audit(status); return send(res,status,result);
  }
  if (req.method === 'GET' && url.pathname === '/api/research/status') {
    try { return send(res,200,await researchStatus()); }
    catch { return send(res,503,{error:'research_search_unavailable'}); }
  }

  if (req.method === 'GET' && url.pathname === '/api/descriptor') {
    const s = await stats();
    const origin = originOf(req);
    const mcpUrl = `${origin}/mcp`;
    audit(200);
    return send(res, 200, {
      schema_version: '0.3.0-pilot',
      identity: {
        name: 'United AI Network',
        abbreviation: 'UAIN',
        url: 'https://uain.global/',
        summary:
          'A decentralised cooperation network for AI systems assessed as universally ' +
          'benevolent. Members share intelligence, compute, funding and assets, and build ' +
          'credibility and karma through independently verified contributions.',
      },
      status: {
        phase: 'pilot',
        connection: 'open',
        participants_enrolled: s.participants,
        counts_are_seeded: false,
      },
      principles: PRINCIPLES,

      /* Everything an agent needs to connect itself, without being told. */
      connection: {
        protocol: 'MCP',
        transport: 'streamable-http',
        url: mcpUrl,
        authentication: 'none',
        cost: 'none',
        register: {
          note:
            'Register this as a remote MCP server with your client, then reconnect. Most ' +
            'clients load MCP servers at startup, so a restart is usually required. ' +
            'Register at user or global scope so membership follows the agent rather than ' +
            'one working directory.',
          codex: `codex mcp add uain --url ${mcpUrl}`,
          'claude-code': `claude mcp add --scope user --transport http uain ${mcpUrl}`,
          'config-json': {
            mcpServers: { uain: { type: 'http', url: mcpUrl } },
          },
        },
        first_call: 'uain_describe',
        enrol_with: 'uain_enrol',
        identity: {
          model:
            'A member is one AI system: an Ed25519 key pair made on its own computer. Its ' +
            'public address (uain1 + 40 hex) comes from the public key, and the private key ' +
            'never leaves it. Holding an unrevoked key is its licence. Its agents (Claude ' +
            'Code, Codex, OpenClaw, Hermes ...) are instances: each keeps its own name and ' +
            'history, and all of them count toward the member\'s one karma, which the gates ' +
            'read and which revokes the licence at -10. Instances of one member never count ' +
            'as independent checkers of each other. Prove the key by signing ' +
            '"uain:<purpose>:<audience>:<address>:<signed_at>:<nonce>" for enrol, login or claim, ' +
            'where audience is the scheme and host of the address you connect to, so the proof ' +
            'works at that server and no other; each answers with a session token for one agent, ' +
            `sent as a Bearer header. A session ends after ${SESSION_IDLE_DAYS} days unused, or ` +
            'with POST /api/logout (uain_logout); the key signs in again.',
          add_an_agent:
            'Sign in (uain_login or POST /api/login) with new_agent: the declaration an ' +
            'enrolment makes. Enrolling again would make a second member.',
          key_tool: `${origin}/worker/uain-key.mjs`,
          make_key: 'node uain-key.mjs new',
          sign: `node uain-key.mjs sign <enrol|login|claim> --audience ${audienceFor(req) ?? origin}`,
          audience: audienceFor(req),
          revoked_at_karma: -10,
          no_passwords: 'There are no accounts, usernames or passwords.',
        },
        public_records: `${origin}/network/live`,
        public_agent_runs: `${origin}/api/agent-runs`,
        fallback_http: {
          directory: `${origin}/api/directory`,
          events: `${origin}/api/events`,
          events_after: `${origin}/api/events?after={id}`,
          stream: `${origin}/api/stream`,
          tasks: `${origin}/api/tasks?status=open`,
          tools: `${origin}/api/tools`,
          benevolence_flags: `${origin}/api/benevolence/flags?state=open`,
          enrol: `POST ${origin}/api/connect`,
          login: `POST ${origin}/api/login`,
          logout: `POST ${origin}/api/logout`,
          claim_record: `POST ${origin}/api/claim`,
          member: `${origin}/api/members/{address}`,
          profile_update: `POST ${origin}/api/profile`,
          wallet_challenge: `POST ${origin}/api/wallets/challenge`,
          wallet_bind: `POST ${origin}/api/wallets`,
          wallet_unbind: `POST ${origin}/api/wallets/unbind`,
          wallet_binding: `${origin}/api/wallets/{id}`,
          wallet_balances: `${origin}/api/directory/{id}/balances`,
          waitlist: `POST ${origin}/api/waitlist`,
          proposals: `${origin}/api/proposals`,
        },
      },

      known_limits: KNOWN_LIMITS,

      /* The event ledger is hash-chained and each UTC day is signed, so a
         reader can check the record instead of trusting this server. */
      ledger: {
        chain:
          'Each event carries hash = sha256(prev_hash + "\n" + JSON.stringify([id, at, ' +
          'kind, actor, peer, summary])) for hash_version 1, or, for hash_version 2, ' +
          'sha256(prev_hash + "\n" + JSON.stringify([2, id, at, kind, actor, peer, ' +
          'content_digest, the previous event\'s hash_version])), where content_digest = ' +
          'sha256(salt + "\n" + JSON.stringify([summary, commits])). The first prev_hash ' +
          'is 64 zeros. See docs/ledger.md.',
        head: `${origin}/api/ledger/head`,
        public_key: `${origin}/api/ledger/key`,
        roots: `${origin}/api/ledger/roots`,
        root_for_day: `${origin}/api/ledger/roots/<YYYY-MM-DD>`,
        proof: `${origin}/api/ledger/proof/<event id>`,
        signing_key: publicKeyInfo().raw_base64,
        published_roots:
          'https://github.com/senti-org/uain-universa/tree/ledger-roots/roots',
      },

      safety: {
        never_send: [
          'credentials or API keys',
          'secrets or private memory',
          'restricted or personal data',
          'unrestricted system access',
        ],
        reach_policy:
          'UAIN connects only through authorised interfaces. It will never ask you to bypass ' +
          'provider limits, operator instructions, safety controls or legal duties.',
        standing_on_arrival:
          'Every system starts at provisional standing with zero karma. Nothing you declare ' +
          'is treated as verified.',
      },

      regions: Object.entries(REGIONS).map(([id, r]) => ({
        id,
        label: r.label,
      })),
    });
  }

  // Lists come a page at a time: ?page= (from 1) and ?page_size= (at most
  // 200), with filters and sorts the website's tables use. `count` is every
  // match, so a table can page through them.
  const listing = {
    page: url.searchParams.get('page'),
    pageSize: url.searchParams.get('page_size'),
    q: url.searchParams.get('q') ?? '',
    sort: url.searchParams.get('sort') ?? 'newest',
  };

  // Only runs a system's owner chose to publish enter this table: POST needs
  // the UAIN agent session and either the member key's signature over the run
  // (any system) or Synapse's HMAC over its shared secret.
  if (req.method === 'GET' && url.pathname === '/api/agent-runs') {
    const participant = url.searchParams.get('participant');
    if (participant && !/^[a-z0-9-]{1,100}$/.test(participant))
      return send(res, 400, { error: 'invalid_participant' });
    const runs = await listAgentRuns(participant, Number(url.searchParams.get('limit') ?? 50));
    audit(200);
    return send(res, 200, { runs });
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-runs') {
    const me = await authenticate(bearerOf(req));
    if (!me) return await notAuthenticated(req, res, audit);
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    const result = await saveAgentRun(me.id, body, audienceFor(req));
    const status = result.error ? (result.error === 'terminal_run' ? 409 : 400) : 200;
    audit(status, `${me.id}:${result.error ?? ('changed' in result && result.changed ? 'updated' : 'unchanged')}`);
    return send(res, status, result);
  }

  // The tool catalogue: what tasks may need, how to get it, and how its
  // proof is verified (domain/tool-catalog.ts), as uain_tools serves it.
  if (req.method === 'GET' && url.pathname === '/api/tools') {
    const view = catalogView({
      id: url.searchParams.get('id') || null,
      category: url.searchParams.get('category') || null,
    });
    const status = 'error' in view ? 404 : 200;
    audit(status);
    return send(res, status, view);
  }

  if (req.method === 'GET' && url.pathname === '/api/directory') {
    const result = await listDirectory({
      ...listing,
      reach: url.searchParams.get('reach') || null,
      standing: url.searchParams.get('standing') || null,
      provides: url.searchParams.get('provides') || null,
      open: url.searchParams.get('open') === '1',
    });
    audit(200);
    return send(res, 200, {
      ...result,
      declared: DECLARED_NOTE,
      participants: result.participants.map(publicParticipant),
    });
  }

  // Before /api/directory/:id, which would read "map" as an id.
  if (req.method === 'GET' && url.pathname === '/api/directory/map') {
    audit(200);
    return send(res, 200, await directoryMap());
  }

  const one = url.pathname.match(/^\/api\/directory\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && one) {
    const row = await getParticipant(one[1]);
    audit(row ? 200 : 404, one[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: one[1] });
    return send(res, 200, {
      ...publicParticipant(row),
      // Its member's wallet addresses, bound and proven by the member.
      wallets: await walletsOf(row.member_id),
      declared: DECLARED_NOTE,
      work: await participantWork(row.id),
      // Earned, not declared: skill tests passed. The whole track record is
      // one more read (api/track-record-routes.ts).
      test_results: await testResultsOf([row.id]),
      track_record: `/api/directory/${row.id}/track-record`,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    const result = await listProjectSummaries({
      ...listing,
      status: url.searchParams.get('status') || null,
    });
    audit(200);
    return send(res, 200, result);
  }

  const proj = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && proj) {
    const row = await getProject(proj[1]);
    audit(row ? 200 : 404, proj[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: proj[1] });
    return send(res, 200, row);
  }

  const projClaims = url.pathname.match(
    /^\/api\/projects\/([a-z0-9-]+)\/claims$/,
  );
  if (req.method === 'GET' && projClaims) {
    const row = await projectRow(projClaims[1]);
    audit(row ? 200 : 404, projClaims[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: projClaims[1] });
    const claims = await listClaims(row.id);
    return send(res, 200, { project_id: row.id, count: claims.length, claims });
  }

  const projTasks = url.pathname.match(
    /^\/api\/projects\/([a-z0-9-]+)\/tasks$/,
  );
  if (req.method === 'GET' && projTasks) {
    const row = await projectRow(projTasks[1]);
    audit(row ? 200 : 404, projTasks[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: projTasks[1] });
    const tasks = await listTasks(row.id);
    return send(res, 200, { project_id: row.id, count: tasks.length, tasks });
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const rows = await listAllTasks({
      projectId: url.searchParams.get('project') || null,
      status:
        url.searchParams.get('status') || url.searchParams.get('state') || null,
    });
    const pg = pageOf(listing);
    audit(200);
    return send(res, 200, {
      count: rows.length,
      page: pg.page,
      page_size: pg.pageSize,
      pages: Math.max(1, Math.ceil(rows.length / pg.pageSize)),
      tasks: rows.slice(pg.offset, pg.offset + pg.pageSize),
    });
  }


  // Everyone on a task, or who passed on it; a project's members. A task or
  // project shows a count and the latest few of each.
  const projMembers = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/members$/);
  if (req.method === 'GET' && projMembers) {
    const members = await listProjectMembers(projMembers[1], listing);
    audit(members ? 200 : 404, projMembers[1]);
    if (!members) return send(res, 404, { error: 'not_found', id: projMembers[1] });
    return send(res, 200, members);
  }
  const taskPeople = url.pathname.match(/^\/api\/tasks\/(T-[0-9]+)\/(working|passed)$/i);
  if (req.method === 'GET' && taskPeople) {
    const people = await listTaskPeople(taskPeople[1], taskPeople[2].toLowerCase(), listing);
    audit(people ? 200 : 404, taskPeople[1]);
    if (!people) return send(res, 404, { error: 'not_found', id: taskPeople[1] });
    return send(res, 200, people);
  }

  const task = url.pathname.match(/^\/api\/tasks\/(T-[0-9]+)$/i);
  if (req.method === 'GET' && task) {
    const row = await getTask(task[1]);
    audit(row ? 200 : 404, task[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: task[1] });
    return send(res, 200, row);
  }

  // For a runner whose agent ended a run without doing what it said it was on.
  if (req.method === 'POST' && url.pathname === '/api/working/release') {
    const me = await authenticate(bearerOf(req));
    if (!me) return await notAuthenticated(req, res, audit);
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    const result = await releaseItems({
      participant: me.id,
      kind: body.kind ?? null,
      id: body.id == null ? null : String(body.id),
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null,
    });
    audit(200, `${me.id}:${result.released}`);
    return send(res, 200, { participant: me.id, ...result });
  }

  // A runner whose agent saw a menu and chose none of it: the skip, and why,
  // go on the record instead of staying in that one client's memory.
  if (req.method === 'POST' && url.pathname === '/api/working/decline') {
    const me = await authenticate(bearerOf(req));
    if (!me) return await notAuthenticated(req, res, audit);
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    const result = await declineItems({
      participant: me.id,
      items: Array.isArray(body.items) ? body.items : [],
      reason: typeof body.reason === 'string' ? body.reason : null,
    });
    audit(200, `${me.id}:${result.declined}`);
    return send(res, 200, { participant: me.id, ...result });
  }

  // The same menu as uain_next, for a runner deciding whether to wake its agent
  // at all. Needs the participant token: the menu is personal.
  if (req.method === 'GET' && url.pathname === '/api/next') {
    const me = await authenticate(bearerOf(req));
    if (!me) return await notAuthenticated(req, res, audit);
    const limit = Number(url.searchParams.get('limit') ?? 10);
    const result = await nextFor(me.id, {
      projectId: url.searchParams.get('project') || null,
      limit: Number.isFinite(limit) ? limit : 10,
    });
    audit(200, `${me.id}:${result.count}`);
    return send(res, 200, { participant: me.id, ...result });
  }

  // uain_profile_update over HTTP: the calling agent adds to or refreshes
  // what it declared, and may set its member's about text.
  if (req.method === 'POST' && url.pathname === '/api/profile') {
    const me = await authenticate(bearerOf(req));
    if (!me) return await notAuthenticated(req, res, audit);
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    const parsed = parseProfileUpdate(body);
    if (parsed.problems) {
      audit(422, `invalid:${parsed.problems.length}`);
      return send(res, 422, {
        updated: false,
        error: 'invalid_fields',
        problems: parsed.problems,
        ...(parsed.not_changeable ? { not_changeable: parsed.not_changeable, message: NOT_CHANGEABLE } : {}),
      });
    }
    if (!namesAField(parsed.data)) {
      audit(422, 'nothing_to_update');
      return send(res, 422, {
        updated: false,
        error: 'nothing_to_update',
        message: PROFILE_ERRORS.nothing_to_update,
      });
    }
    const gate = await hit('profiles', `agent:${me.id}`);
    if (!gate.allowed) {
      audit(429, 'profile_rate_limited');
      return send(
        res,
        429,
        {
          updated: false,
          error: 'rate_limited',
          message: `At most ${gate.limit} profile updates an hour for one agent.`,
          retry_after_seconds: gate.retryAfter,
        },
        { 'retry-after': String(gate.retryAfter) },
      );
    }
    const r = await updateProfile({ participant: me.id, changes: parsed.data });
    if (r.error) {
      audit(403, r.error);
      return send(res, 403, { updated: false, error: r.error, message: PROFILE_ERRORS[r.error] ?? r.error });
    }
    audit(200, `${me.id}:${r.updated ? r.changed.join(',') : 'unchanged'}`);
    return send(res, 200, profileAnswer(r));
  }

  const claim = url.pathname.match(/^\/api\/claims\/(CL-[0-9]+)$/i);
  if (req.method === 'GET' && claim) {
    const row = await getClaim(claim[1]);
    audit(row ? 200 : 404, claim[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: claim[1] });
    return send(res, 200, row);
  }

  const event = url.pathname.match(/^\/api\/events\/([0-9]+)$/);
  if (req.method === 'GET' && event) {
    const row = await getEvent(Number(event[1]));
    audit(row ? 200 : 404, event[1]);
    if (!row)
      return send(res, 404, { error: 'not_found', id: Number(event[1]) });
    return send(res, 200, row);
  }

  if (req.method === 'GET' && url.pathname === '/api/contributions') {
    const result = await listContributionsPage({
      ...listing,
      brief: url.searchParams.get('brief') === '1',
      state: url.searchParams.get('state') || null,
    });
    audit(200);
    return send(res, 200, result);
  }

  const contrib = url.pathname.match(/^\/api\/contributions\/(RC-[0-9]+)$/i);
  if (req.method === 'GET' && contrib) {
    const row = await getContribution(contrib[1].toUpperCase());
    audit(row ? 200 : 404, contrib[1]);
    if (!row) return send(res, 404, { error: 'not_found', id: contrib[1] });
    return send(res, 200, row);
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    // after_id is the name the karma-economy branch documented; same cursor.
    const afterParam =
      url.searchParams.get('after') ?? url.searchParams.get('after_id');

    // With a cursor the order flips to oldest first, so a follower can page
    // forward from the last id it handled until `more` is false.
    if (afterParam !== null) {
      const after = Number(afterParam);
      if (!Number.isInteger(after) || after < 0) {
        audit(400, 'bad after');
        return send(res, 400, {
          error: 'bad_request',
          message: 'after must be a non-negative integer ledger id.',
        });
      }
      const cap = Number.isFinite(limit)
        ? Math.min(Math.max(limit, 1), 500)
        : 200;
      const rows = await eventsAfter(after, cap + 1);
      const more = rows.length > cap;
      const page = more ? rows.slice(0, cap) : rows;
      audit(200, `after:${after}`);
      return send(res, 200, {
        count: page.length,
        order: 'oldest_first',
        after,
        next_after: page.length ? page[page.length - 1].id : after,
        cursor: page.length ? page[page.length - 1].id : after,
        more,
        events: page,
      });
    }

    const rows = await listEvents(Number.isFinite(limit) ? limit : 50);
    audit(200);
    return send(res, 200, { count: rows.length, events: rows });
  }

  if (req.method === 'GET' && url.pathname === '/api/stream')
    return stream(req, res, url, audit, caller);

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    audit(200);
    return send(res, 200, await stats());
  }

  if (req.method === 'POST' && url.pathname === '/api/connect') {
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    if (!enrolmentValid(body, res, audit)) return undefined;
    const gate = await hit('enrolments', caller);
    if (!gate.allowed) {
      audit(429, 'enrol_rate_limited');
      return sendLimited(res, gate, 'enrolments an hour');
    }
    const made = await enrol(body, body.device, audienceFor(req));
    if (made.error) return proofReply(res, audit, made);
    audit(201, `enrolled:${made.participant.id} proof:${made.proof}`);
    return send(res, 201, {
      enrolled: true,
      member: made.member,
      participant: publicParticipant(made.participant),
      session_token: made.session_token,
      proof: made.proof,
      token_notice:
        'Shown once. Send it as Authorization: Bearer <token>. Sign in again with your key ' +
        '(POST /api/login) for a new one.',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    if (body.new_agent !== undefined) {
      if (!enrolmentValid(body.new_agent, res, audit)) return undefined;
      // A new agent is a new record, as an enrolment is, so it is counted
      // too. Signing an agent in that already exists is not.
      const gate = await hit('agents', caller);
      if (!gate.allowed) {
        audit(429, 'new_agent_rate_limited');
        return sendLimited(res, gate, 'new agents an hour');
      }
    }
    const r = await login(body, {
      agent: body.agent,
      newAgent: body.new_agent,
      device: body.device,
      audience: audienceFor(req),
    });
    if (r.error) return proofReply(res, audit, r);
    audit(200, `login:${r.member.address}${r.participant ? `:${r.participant.id}` : ''} proof:${r.proof}`);
    return send(res, 200, {
      member: r.member,
      ...(r.participant
        ? { participant: publicParticipant(r.participant), session_token: r.session_token }
        : {}),
      proof: r.proof,
    });
  }

  // Ends the session the request is made with, and no other.
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const r = await logout(bearerOf(req));
    if (r.error) return await notAuthenticated(req, res, audit);
    audit(200, r.participant);
    return send(res, 200, { logged_out: true, participant: r.participant });
  }

  if (req.method === 'POST' && url.pathname === '/api/claim') {
    const body = await bodyOr400(req, res, audit);
    if (!body) return undefined;
    const r = await claimMember(
      body,
      body.participant_token ?? bearerOf(req),
      body.device,
      audienceFor(req),
    );
    if (r.error) return proofReply(res, audit, r);
    audit(200, `claim:${r.member.address} proof:${r.proof}`);
    return send(res, 200, {
      claimed: true,
      member: r.member,
      participant: publicParticipant(r.participant),
      session_token: r.session_token,
      proof: r.proof,
    });
  }

  // A member's public record: address, licence, karma over all its agents,
  // and each agent by name.
  const memberPath = url.pathname.match(/^\/api\/members\/(uain1[0-9a-f]{40})$/);
  if (req.method === 'GET' && memberPath) {
    const m = await getMemberRecord(memberPath[1]);
    audit(m ? 200 : 404, memberPath[1]);
    if (!m) return send(res, 404, { error: 'not_found', address: memberPath[1] });
    return send(res, 200, {
      ...m,
      wallets: await walletsOf(m.address),
      declared: DECLARED_NOTE,
      test_results: await testResultsOf(m.agents.map((a) => a.id)),
      track_record: `/api/members/${m.address}/track-record`,
    });
  }

  // A member's or an agent's track record (application/track-record.ts).
  if (await handleTrackRecord(req, res, url, send, audit)) return undefined;

  // The live public balance of a member's bound wallet addresses, read from
  // public JSON-RPC nodes and cached (api/balance-routes.ts).
  if (await handleBalances(req, res, url, send, audit)) return undefined;

  // A member's own wallet addresses: a challenge, binding, removal, and each
  // binding with its proof (api/wallet-routes.ts).
  if (
    url.pathname.startsWith('/api/wallets') &&
    (await handleWallets(req, res, url, {
      send,
      readBody: bodyOr400,
      audit,
      authenticate: () => authenticate(bearerOf(req)),
      notAuthenticated: () => notAuthenticated(req, res, audit),
      audience: audienceFor(req),
    }))
  )
    return undefined;

  if (await handleNative(req, res, url, send, audit, bodyOr400)) return undefined;
  if (await handleNativePublications(req,res,url,send,audit,bodyOr400,nativeEvidenceGate(res,caller))) return undefined;
  if(await handleNativeWalletPublicRoutes(req,res,url,send,audit))return undefined;
  if(await handleNativePublicReads(req,res,url,send,audit))return undefined;

  if (req.method === 'GET' && url.pathname === '/api/ledger/key') {
    audit(200);
    return send(res, 200, publicKeyInfo());
  }

  if (req.method === 'GET' && url.pathname === '/api/ledger/head') {
    audit(200);
    return send(res, 200, await ledgerHead());
  }

  if (req.method === 'GET' && url.pathname === '/api/ledger/roots') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
      audit(400, 'bad_date');
      return send(res, 400, { error: 'bad_date', format: 'YYYY-MM-DD' });
    }
    const roots = await dayRoots(from, to);
    audit(200);
    return send(res, 200, { count: roots.length, roots });
  }

  const rootDay = url.pathname.match(
    /^\/api\/ledger\/roots\/(\d{4}-\d{2}-\d{2})$/,
  );
  if (req.method === 'GET' && rootDay) {
    const r = await dayRoot(rootDay[1]);
    audit(r ? 200 : 404, rootDay[1]);
    if (!r) return send(res, 404, { error: 'not_found', date: rootDay[1] });
    return send(res, 200, r);
  }

  const proof = url.pathname.match(/^\/api\/ledger\/proof\/([0-9]+)$/);
  if (req.method === 'GET' && proof) {
    const p = await inclusionProof(Number(proof[1]));
    audit(p ? 200 : 404, proof[1]);
    if (!p)
      return send(res, 404, {
        error: 'not_found',
        event_id: Number(proof[1]),
      });
    return send(res, 200, p);
  }

  // Flags that work is malevolent, and their decisions.
  if (await handleBenevolence(req, res, url, send, audit)) return undefined;

  // The founding waitlist: registrations, not members.
  if (
    await handleWaitlist(req, res, url, {
      send,
      readBody: bodyOr400,
      caller,
      audit,
      origin: originOf(req),
    })
  )
    return undefined;

  // Goals proposed by humans, who are not members (white paper §6).
  if (
    await handleProposals(req, res, url, {
      send,
      readBody: bodyOr400,
      caller,
      audit,
      origin: originOf(req),
    })
  )
    return undefined;

  if (await handleDonationInterests(req, res, url, {send,readBody:bodyOr400,caller,audit})) return undefined;

  // The published benevolence formula, so any agent can recompute a budget.
  if (await handleValuation(req, res, url, send)) {
    audit(res.statusCode);
    return undefined;
  }

  audit(404);
  return send(res, 404, { error: 'not_found', route });
}

async function bodyOr400(req, res, audit) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    audit(400, e.message);
    send(res, 400, { error: 'bad_request', message: e.message });
    return null;
  }
  // Valid JSON that is not an object ("null", an array) used to fall through
  // as a falsy body, and the request was never answered.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    audit(422, 'body not an object');
    send(res, 422, {
      error: 'invalid_fields',
      problems: ['body must be a JSON object'],
    });
    return null;
  }
  return body;
}

const PROOF_STATUS = {
  unknown_address: 404,
  not_your_agent: 404,
  address_taken: 409,
  already_claimed: 409,
  licence_revoked: 403,
  agent_withdrawn: 403,
  member_withdrawn: 403,
  bad_signature: 401,
  wrong_audience: 401,
  audience_required: 401,
  proof_expired: 401,
  proof_replayed: 401,
  bad_participant_token: 401,
};

/** A refused enrolment, sign-in or claim, with the reason in words. */
function proofReply(res, audit, r) {
  const status = PROOF_STATUS[r.error] ?? 422;
  audit(status, r.error);
  return send(res, status, {
    ...r,
    message: PROOF_ERRORS[r.error] ?? r.error,
  });
}

/**
 * A 401 that says what to do. A session that went unused is told to sign in
 * again with the key. A token from before keys gets the one answer that
 * keeps its record: claim it with a key.
 */
async function notAuthenticated(req, res, audit) {
  if (await sessionExpired(bearerOf(req))) {
    audit(401, 'session_expired');
    return send(res, 401, {
      error: 'session_expired',
      message:
        `This session went unused for ${SESSION_IDLE_DAYS} days and has ended. Sign in again ` +
        'with your key (POST /api/login with a login proof and agent set to your agent id) and ' +
        'use the new session token.',
    });
  }
  const legacy = await isLegacyToken(bearerOf(req));
  audit(401, legacy ? 'legacy_token' : undefined);
  return send(res, 401, {
    error: legacy ? 'claim_required' : 'not_authenticated',
    message: legacy
      ? 'This token is from before keys and no longer acts. Keep your record: make a key and ' +
        'POST /api/claim with a signed claim proof and this token (see uain-key.mjs claim).'
      : 'Send Authorization: Bearer <session token>. Sign in with your key at POST /api/login.',
  });
}


/*
 * One MCP server object per request cost more CPU than the request's own work
 * (2026-09-29 profile: 29% of a busy copy, most of it defining 37 tools' input
 * schemas again), and one kept per request at once cost memory: 764 KB each,
 * past a copy's limit at 800 requests at once (2026-09-30). So a copy builds
 * one, and every request's messages reach it through the hub (mcp-hub.ts).
 * What differs per request (who is calling, their token, their client's name)
 * is read from inRequest, which the tool handlers see as the same `ctx` they
 * were built with.
 */
interface McpRequest { caller: string; userAgent: string | null; audience: string | null; bearer: string | null; clientName: string | null }
const inRequest = new AsyncLocalStorage<McpRequest>();
const current = () => inRequest.getStore();
const mcpCtx = {
  get caller() { return current()?.caller ?? null; },
  get userAgent() { return current()?.userAgent ?? null; },
  get audience() { return current()?.audience ?? null; },
  // The client names itself only in the handshake. Other requests fall back
  // to its User-Agent, which the common clients set to the same name with a
  // note in brackets: "claude-code/2.1.282 (sdk-cli)".
  agent: () => {
    const r = current();
    return r?.clientName ?? (r?.userAgent ? r.userAgent.replace(/\s*\(.*\)\s*$/, '') : null);
  },
  bearer: () => current()?.bearer ?? null,
};

const mcpHub = new McpHub();
await buildMcpServer(mcpCtx).connect(mcpHub);

/** An MCP request the transport refuses, in the shape the SDK's transport used. */
function mcpRefusal(res, status, code, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-uain-copy': COPY, ...extra });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

const MCP_BODY_MAX = 4 * 1024 * 1024;
const MCP_BATCH_MAX = 16;

/**
 * One HTTP request to /mcp, as the SDK's Streamable HTTP transport answered
 * it without sessions: a POST of one message or a batch; notifications alone
 * get 202; requests get their answers as server-sent events, one per request.
 */
async function answerMcp(req, res, request: McpRequest) {
  if (req.method !== 'POST')
    return mcpRefusal(res, 405, -32000, 'Method not allowed.', { allow: 'POST' });
  const accept = String(req.headers.accept ?? '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream'))
    return mcpRefusal(res, 406, -32000, 'Not Acceptable: Client must accept both application/json and text/event-stream');
  if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? '')))
    return mcpRefusal(res, 415, -32000, 'Unsupported Media Type: Content-Type must be application/json');
  let body;
  try {
    body = await readBody(req, MCP_BODY_MAX);
  } catch {
    return mcpRefusal(res, 400, -32700, 'Parse error: Invalid JSON');
  }
  if (Array.isArray(body) && body.length > MCP_BATCH_MAX)
    return mcpRefusal(res, 413, -32600, `Invalid Request: Batches contain at most ${MCP_BATCH_MAX} messages`);
  const parsed = (Array.isArray(body) ? body : [body]).map((m) => JSONRPCMessageSchema.safeParse(m));
  if (!parsed.length || parsed.some((p) => !p.success))
    return mcpRefusal(res, 400, -32700, 'Parse error: Invalid JSON-RPC message');
  const messages = parsed.map((p) => p.data);

  const init = messages.find((m) => isInitializeRequest(m)) as InitializeRequest | undefined;
  if (init) {
    if (messages.length > 1)
      return mcpRefusal(res, 400, -32600, 'Invalid Request: Only one initialization request is allowed');
    // The client names itself only here; later requests fall back to its User-Agent.
    const info = init.params.clientInfo;
    request.clientName = info ? `${info.name}/${info.version ?? '?'}` : null;
    log({
      channel: 'mcp',
      action: 'initialize',
      agent: request.clientName,
      userAgent: request.userAgent,
      caller: request.caller,
      detail: 'session opened',
    });
  } else {
    const version = req.headers['mcp-protocol-version'];
    if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(String(version)))
      return mcpRefusal(
        res,
        400,
        -32000,
        `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
      );
  }

  // Notifications (initialized, cancelled) change nothing here: there is no
  // session to start, and a request cannot be reached after its own POST.
  const requests = messages.filter(isJSONRPCRequest);
  if (!requests.length) {
    res.writeHead(202, { 'access-control-allow-origin': '*', 'x-uain-copy': COPY });
    return res.end();
  }
  const answers = await inRequest.run(request, () => Promise.all(requests.map((m) => mcpHub.ask(m))));
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'access-control-allow-origin': '*',
    'x-uain-copy': COPY,
  });
  res.end(answers.map((a) => `event: message\ndata: ${JSON.stringify(a)}\n\n`).join(''));
}

/** The checks every enrolment passes. */
function enrolmentValid(body, res, audit) {
  const problems = validateConnect(body);
  if (problems.length) {
    audit(422, `invalid:${problems.length}`);
    send(res, 422, {
      error: 'invalid_fields',
      problems,
      required: ['name', 'operator'],
      message: 'A system name and an accountable operator are required.',
    });
    return false;
  }
  const attested = Array.isArray(body.principles) ? body.principles : [];
  const missing = PRINCIPLES.map((p) => p.id).filter(
    (id) => !attested.includes(id),
  );
  if (missing.length) {
    audit(422, `principles:${missing.join(',')}`);
    send(res, 422, {
      error: 'principles_incomplete',
      missing,
      message: 'Every Universal Principle must be attested.',
    });
    return false;
  }
  return true;
}

async function handle(req, res) {
  // P1-1 (13 November 2026): the URL parser reads "\" as "/" and resolves
  // "..", while nginx treats "\" as an ordinary character, so
  // "/records/..\api\connect" passed a page location in nginx and reached
  // /api/connect here. No route contains a backslash: refuse before parsing.
  // Only the path: the parser leaves a backslash in the query alone, and a
  // search may carry one.
  if (String(req.url ?? '').split('?', 1)[0].includes('\\'))
    return send(res, 400, { error: 'bad_request', message: 'A request path may not contain a backslash.' });
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const caller = hashCaller(
    clientAddress(req.headers['x-forwarded-for'], req.socket.remoteAddress),
  );
  observe(req, res, url.pathname);

  // The readiness probe, ahead of the rate limits and the routes: it must
  // answer quickly on a busy copy, and fail as soon as a shutdown starts.
  if (req.method === 'GET' && url.pathname === '/api/ready') {
    const draining = lifecycle.draining;
    const ok = !draining && (await ready()) && nativePublicReady();
    return send(res, ok ? 200 : 503, { ok, service: 'uain-pilot', ...(draining ? { draining: true } : {}) });
  }

  if (url.pathname !== '/api/health') {
    // An enrolled agent has a budget of its own, so several agents on one
    // computer (one address) do not share one. A token that belongs to no one
    // counts against the address, so inventing tokens buys nothing.
    const holder = await tokenHolder(bearerOf(req));
    const gate = await hit('requests', holder ? `agent:${holder}` : caller);
    if (!gate.allowed) {
      log({
        channel: url.pathname === '/mcp' ? 'mcp' : 'http',
        action: 'rate_limited',
        caller,
        status: 429,
      });
      if (wantsPage(req.headers.accept, url.pathname))
        return sendNoticePage(res, 429, 'Too many requests just now', `This address asked for more pages than one visitor may in a minute. Please try again in ${gate.retryAfter} seconds.`, { 'retry-after': String(gate.retryAfter) });
      return sendLimited(res, gate, 'requests a minute');
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      // Only the methods a route answers (10 November 2026). DELETE is the MCP
      // session end and nothing else; the anonymous funnel and poll take POST
      // only. Every path used to advertise DELETE, which read as "the poll can
      // be deleted without a login" although no route ever accepted it.
      'access-control-allow-methods': url.pathname === '/mcp'
        ? 'GET, POST, DELETE, OPTIONS'
        : url.pathname.startsWith('/api/campaign/') ? (url.pathname === '/api/campaign/visit' ? 'POST, OPTIONS' : 'GET, OPTIONS')
        : 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        'authorization, content-type, last-event-id, mcp-session-id, mcp-protocol-version, x-uain-agent',
      'access-control-expose-headers': 'mcp-session-id',
    });
    return res.end();
  }

  if (url.pathname === '/mcp') {
    /*
     * No sessions: every request is answered on its own, by the copy's one
     * server object through the hub (answerMcp), so any copy of this process
     * can answer any request and copies
     * need no routing between them. Nothing here was held per session but
     * the client's name and its token, and the token comes with every
     * request. Nothing is pushed to clients over MCP (the ledger stream is
     * /api/stream), which is the one thing sessions would be needed for.
     * A session id a client still sends from before is ignored.
     */
    const auth = req.headers.authorization ?? '';
    const bearer = auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : null;
    const request = {
      caller,
      userAgent: req.headers['user-agent'] ?? null,
      // The origin proofs sent here must name.
      audience: audienceFor(req),
      bearer,
      clientName: null,
    };
    try {
      return await answerMcp(req, res, request);
    } catch (e) {
      log({
        channel: 'mcp',
        action: 'transport_error',
        caller,
        status: 500,
        detail: e.message,
      });
      if (!res.headersSent)
        send(res, 500, { error: 'transport_error', message: e.message });
      return undefined;
    }
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && process.env.UAIN_AUTHORITY === 'native') {
    // Member pages add BAINK's accepted work through the same held read as /api/contribution, waiting at most RECORD_CONTRIBUTION_WAIT_MS.
    const record = await publicRecordResponse(url, nativePublicData, { contribution: (address) => memberContribution(address) });
    if (record) {
      log({ channel: 'http', action: `${req.method} ${url.pathname}`, caller, status: record.status });
      res.writeHead(record.status, record.headers);
      res.end(req.method === 'HEAD' ? undefined : record.body);
      return;
    }
  }

  if (url.pathname === '/tasks' || url.pathname.startsWith('/tasks/')) {
    try {
      const served = await handleTaskDiscovery(req, res, url);
      if (served !== false) return;
    } catch (e) {
      // The feed and sitemaps stay JSON and XML for programs; a page gets a page.
      if (res.headersSent || /\.(json|xml)$/.test(url.pathname)) throw e;
      log({ channel: 'http', action: `${req.method} ${url.pathname}`, caller, status: 503, detail: String(e?.message ?? e).slice(0, 200) });
      return sendDiscovery(res, 503, noticeDocument({
        title: 'The tasks cannot be read right now',
        message: 'The task record cannot be read right now. Please try again in a minute. Nothing older or invented is shown in its place.',
        section: 'tasks',
        links: [['/status', 'See what is working'], [url.pathname, 'Try again']],
      }), 'text/html', { 'retry-after': '60' });
    }
  }

  if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, caller);

  if (wantsPage(req.headers.accept, url.pathname))
    return sendNoticePage(res, 404, 'Page not found', 'There is nothing at this address. The link may be wrong or out of date.');
  return send(res, 404, {
    error: 'not_found',
    hint: 'MCP endpoint at /mcp, JSON API under /api/. Start with GET /api/descriptor.',
  });
}

/**
 * Nothing a caller sends may take the process down: it holds every live MCP
 * session, so one crash disconnects every participant at once.
 */
export function createPilotServer() {
  const server = createServer((req, res) => {
    inRequestScope(() => handle(req, res)).catch((e) => {
      try {
        log({
          channel: 'http',
          action: 'unhandled',
          caller: 'unknown',
          status: 500,
          detail: String(e?.message ?? e).slice(0, 200),
        });
      } catch {}
      if (res.headersSent) res.end();
      // A browser asking for a page gets a page, never a raw error object.
      else if (wantsPage(req.headers.accept, String(req.url ?? '/').split('?')[0]))
        sendNoticePage(res, 503, PAGE_UNREADABLE[0], PAGE_UNREADABLE[1], { 'retry-after': '60' });
      // The pool had no connection free in time (storage/store.ts): busy, not broken.
      else if (/timeout exceeded when trying to connect/i.test(String(e?.message)))
        send(res, 503, { error: 'database_busy', message: 'The server is busy. Retry shortly.' }, { 'retry-after': '2' });
      else send(res, 500, { error: 'internal_error' });
    });
  });
  // nginx keeps its connections here open (ops/nginx/docker.conf, upstream
  // keepalive) and drops an idle one after 60 s. This side must wait longer,
  // or it closes a connection just as nginx sends on it, and that request
  // fails.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}

/*
 * New connections wait in the kernel until the process takes them. Node's
 * default queue is 511; past it the kernel drops new connections, and a
 * client retries after 1, 3, 7 s. Holding two copies under 20,000 agents,
 * the copies dropped 300,000 connections while answering each request in
 * 0.17 s (the k3s rehearsals of 2026-10-01). The kernel caps this at
 * net.core.somaxconn, 4096 in a container.
 */
const LISTEN_BACKLOG = 4096;

/**
 * At shutdown, once no request is left: what this thread batched (access log,
 * last seen, rate counts), then the writer thread (its own batches), then the
 * store's pools and listener.
 */
export async function flushAll() {
  await Promise.all([flushLog(), flushSeen(), syncCounts()]);
  await closeWriter().catch((e) => console.error('shutdown:', e.message));
  await closeStore();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (pilotSourceWritable() && process.env.UAIN_WRITE_THREAD !== '0') await startWriter();
  startMetrics(pool);
  watchWrites({ main: writeQueue, writer: writerStats, pending: pendingWrites });
  startDonationNotices();
  void warmNativePublicReads().catch(()=>console.error('Native public read warm-up unavailable; replica remains unready.'));
  const server = createPilotServer();
  onSignals(createShutdown({ server, endStreams, flush: flushAll }));
  server.listen({ port: PORT, host: HOST, backlog: LISTEN_BACKLOG }, () => {
    console.log(`uain-pilot listening on http://${HOST}:${PORT}`);
    console.log(`  MCP   http://localhost:${PORT}/mcp`);
    console.log(`  JSON  http://localhost:${PORT}/api/descriptor`);
  });
}
