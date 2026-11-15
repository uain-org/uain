/** Private Paperclip organization writer for the frozen 120 projects. It is separate
 * from the GET-only BAINK read bridge. Every write is journaled before I/O, looked
 * up by a deterministic external key before any (re)try, and bound only after an
 * exact readback. It never wakes, runs, approves or assigns agents, and its transport
 * can only reach the routes of a qualified contract for the pinned upstream revision.
 *
 * At the pinned revision a directly created agent is `idle` (wakeable). Leadership
 * is therefore hired: the company's board-approval gate is set and read back first,
 * and each hire must read back `pending_approval`. Approval is a later, separately
 * authorized board step that this module cannot reach. */
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HASH, OrganizationError, UUID, digest, exactKeys, need, plain, refuse, text } from './common.mjs';

/** Upstream revision of the private runtime (docs/baink/paperclip-pilot.md). */
export const PINNED_PAPERCLIP_REVISION = 'dce383c733bb1ca31cd34d7dbb82bda597ad7418';
export const PAPERCLIP_REPOSITORY = 'https://github.com/paperclipai/paperclip';
export const CONTRACT_SCHEMA = 'uain-project-organizations/paperclip-contract/v1';

/** Resource -> its own route parameter, display-name field and free-text summary field. */
export const RESOURCES = Object.freeze({
  company: { param: 'companyId', name: 'name', summary: 'description' },
  goal: { param: 'goalId', name: 'title', summary: 'description' },
  project: { param: 'projectId', name: 'name', summary: 'description' },
  agent: { param: 'agentId', name: 'name', summary: 'capabilities' },
  issue: { param: 'issueId', name: 'title', summary: 'description' },
});
/** The closed capability vocabulary. There is deliberately no direct agent create. */
export const CAPABILITIES = Object.freeze({
  'company.list': 'GET', 'company.get': 'GET', 'company.create': 'POST', 'company.update': 'PATCH',
  'goal.list': 'GET', 'goal.get': 'GET', 'goal.create': 'POST',
  'project.list': 'GET', 'project.get': 'GET', 'project.create': 'POST',
  'agent.list': 'GET', 'agent.get': 'GET', 'agent.hire': 'POST',
  'issue.list': 'GET', 'issue.get': 'GET', 'issue.create': 'POST',
});
/** Issue routes are permitted when qualified but organization reconcile never needs them. */
export const REQUIRED_CAPABILITIES = Object.freeze(Object.keys(CAPABILITIES).filter((c) => !c.startsWith('issue.')));
/** A hired agent must read back in this non-invokable state. */
export const PENDING_APPROVAL = 'pending_approval';
/** A route touching any of these can wake, run, sign, pay, approve or read secrets. Never permitted. */
export const FORBIDDEN_SEGMENT = /^(sign|signing|signatures?|custody|native|wallets?|keys?|api-keys|secrets?|wake|wakeup|heartbeats?|runs?|invoke|execute|approvals?|approve|transfers?|payments?|ledger|chain|budgets?|costs?|terminate|pause|resume|archive|branding)$/;
const TEMPLATE = /^\/api(?:\/(?:[a-z][a-z0-9-]{0,39}|:(?:companyId|goalId|projectId|agentId|issueId))){1,6}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const MARKER = 'uain-external-key: ';
const MAX_LIST_ROWS = 1000;
const MAX_ATTEMPTS = 3;
/** Write failures that prove nothing was written (refused upstream, or never sent). */
const DEFINITE = new Set(['paperclip_access_denied', 'paperclip_rejected', 'paperclip_not_found',
  'paperclip_route_not_permitted', 'paperclip_invalid_route', 'paperclip_invalid_body']);

const unqualified = (message) => refuse('paperclip_capability_unqualified', message);
const paramsOf = (path) => [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
const scalar = (v) => v === null || typeof v === 'boolean' || Number.isSafeInteger(v) || (typeof v === 'string' && text(v, 0, 400));

function constants(value, fields, label, { nonEmpty = false } = {}) {
  if (!plain(value) || Object.keys(value).length > 8 || (nonEmpty && !Object.keys(value).length)) unqualified(`${label} is malformed`);
  for (const [k, v] of Object.entries(value)) {
    if (fields && !fields.includes(k)) unqualified(`${label} field ${k} is not an accepted body field`);
    if (!FIELD.test(k) || !scalar(v)) unqualified(`${label} value ${k} is malformed`);
  }
  return value;
}

const BASE_CREATE = ['method', 'path', 'bodyFields', 'externalKey', 'idempotencyField', 'replaySafe', 'fixed', 'responseField'];
const SHAPES = {
  list: ['method', 'path', 'pagination'],
  get: ['method', 'path'],
  update: ['method', 'path', 'bodyFields', 'gate'],
  create: BASE_CREATE,
  projectCreate: [...BASE_CREATE, 'goalLink'],
  hire: [...BASE_CREATE, 'roles', 'hierarchyField', 'expect'],
};

function capabilityOf(name, c) {
  const [resource, verb] = name.split('.');
  const kind = verb === 'create' && resource === 'project' ? 'projectCreate' : verb;
  if (!exactKeys(c, SHAPES[kind])) unqualified(`${name} has an unexpected shape`);
  if (c.method !== CAPABILITIES[name]) unqualified(`${name} method must be ${CAPABILITIES[name]}`);
  if (typeof c.path !== 'string' || !TEMPLATE.test(c.path)) unqualified(`${name} path is not a permitted template`);
  if (c.path.split('/').some((s) => FORBIDDEN_SEGMENT.test(s))) unqualified(`${name} reaches a forbidden route`);
  const params = paramsOf(c.path), own = RESOURCES[resource].param;
  const scoped = resource === 'company' ? [] : ['companyId'];
  const okParams = verb === 'get' || verb === 'update'
    ? params.at(-1) === own && (params.length === 1 || (params.length === 2 && params[0] === 'companyId' && own !== 'companyId'))
    : params.length === scoped.length && params.every((p, i) => p === scoped[i]);
  if (!okParams) unqualified(`${name} path parameters are not scoped`);
  if (verb === 'list' && c.pagination !== null) {
    const p = c.pagination;
    if (!exactKeys(p, ['limitParam', 'offsetParam', 'maxLimit']) || !FIELD.test(p.limitParam) || !FIELD.test(p.offsetParam) ||
      p.limitParam === p.offsetParam || !Number.isSafeInteger(p.maxLimit) || p.maxLimit < 1 || p.maxLimit > 500)
      unqualified(`${name} pagination is malformed`);
  }
  if (verb === 'list' || verb === 'get') return Object.freeze({ ...c });
  const fields = c.bodyFields;
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 128 || !fields.every((f) => typeof f === 'string' && FIELD.test(f)) ||
    new Set(fields).size !== fields.length) unqualified(`${name} bodyFields are malformed`);
  if (verb === 'update') {
    constants(c.gate, fields, `${name} gate`, { nonEmpty: true });
    return Object.freeze({ ...c });
  }
  const ext = c.externalKey, nameField = RESOURCES[resource].name;
  const okKey = exactKeys(ext, ['field', 'format', 'property']) && fields.includes(ext.field) && ext.field !== nameField &&
    ((ext.format === 'trailing-line' && ext.property === null) || (ext.format === 'object-property' && typeof ext.property === 'string' && FIELD.test(ext.property)));
  if (!okKey) unqualified(`${name} has no qualified external key field`);
  if (!fields.includes(nameField)) unqualified(`${name} does not accept ${nameField}`);
  if (c.idempotencyField !== null && !fields.includes(c.idempotencyField)) unqualified(`${name} idempotency field is not accepted`);
  if (typeof c.replaySafe !== 'boolean' || (c.replaySafe && c.idempotencyField === null)) unqualified(`${name} replay safety needs a server idempotency key`);
  if (c.responseField !== null && !(typeof c.responseField === 'string' && FIELD.test(c.responseField))) unqualified(`${name} responseField is malformed`);
  constants(c.fixed, fields, `${name} fixed`);
  if (kind === 'projectCreate' && !(['goalIds', 'goalId'].includes(c.goalLink) && fields.includes(c.goalLink)))
    unqualified(`${name} has no qualified goal link`);
  if (kind === 'hire') {
    if (!exactKeys(c.roles, ['ceo', 'manager']) || !ROLE.test(c.roles.ceo) || !ROLE.test(c.roles.manager) || c.roles.ceo === c.roles.manager ||
      !fields.includes('role')) unqualified(`${name} has no qualified CEO/manager roles`);
    if (typeof c.hierarchyField !== 'string' || !fields.includes(c.hierarchyField)) unqualified(`${name} has no qualified reporting line`);
    constants(c.expect, null, `${name} expect`, { nonEmpty: true });
    if (c.expect.status !== PENDING_APPROVAL) unqualified(`${name} must read back ${PENDING_APPROVAL}`);
  }
  const reserved = [nameField, ext.field, c.idempotencyField, c.goalLink, c.hierarchyField, 'role'].filter(Boolean);
  if (Object.keys(c.fixed).some((k) => reserved.includes(k))) unqualified(`${name} constants overlap managed fields`);
  return Object.freeze({ ...c });
}

/**
 * Validates a sanitized contract fixture. `requireQualified` / `requirePinned` are
 * relaxed only by the offline qualifier when it emits an unqualified report.
 */
export function validateContract(contract, { requireQualified = true, requirePinned = true } = {}) {
  if (!exactKeys(contract, ['schema', 'upstream', 'qualification', 'capabilities']) || contract.schema !== CONTRACT_SCHEMA)
    unqualified('Paperclip contract is missing or malformed');
  const { upstream, qualification: q, capabilities } = contract;
  if (!exactKeys(upstream, ['repository', 'revision']) || upstream.repository !== PAPERCLIP_REPOSITORY || !/^[a-f0-9]{40}$/.test(upstream.revision))
    unqualified('Paperclip contract upstream is malformed');
  if (requirePinned && upstream.revision !== PINNED_PAPERCLIP_REVISION)
    refuse('paperclip_revision_unpinned', 'contract describes a different upstream revision');
  if (!exactKeys(q, ['status', 'method', 'revisionEvidence', 'qualifiedAt', 'evidenceDigest', 'missing', 'sources']) ||
    !['qualified', 'unqualified'].includes(q.status) || !['source-checkout', 'route-capture'].includes(q.method) ||
    !['git-head', 'asserted'].includes(q.revisionEvidence) || Number.isNaN(Date.parse(q.qualifiedAt)) || !HASH.test(q.evidenceDigest) ||
    !Array.isArray(q.missing) || !q.missing.every((m) => typeof m === 'string' && text(m, 1, 200)) ||
    !Array.isArray(q.sources) || q.sources.length > 256 ||
    !q.sources.every((s) => exactKeys(s, ['path', 'sha256']) && text(s.path, 1, 200) && HASH.test(s.sha256)))
    unqualified('Paperclip contract qualification is malformed');
  if (!plain(capabilities)) unqualified('Paperclip contract capabilities are malformed');
  for (const name of Object.keys(capabilities))
    if (!Object.hasOwn(CAPABILITIES, name)) refuse('paperclip_capability_unknown', `unknown capability ${name}`);
  const normalized = Object.fromEntries(Object.keys(capabilities).sort().map((n) => [n, capabilityOf(n, capabilities[n])]));
  if (requireQualified) {
    if (q.status !== 'qualified' || q.missing.length) unqualified('Paperclip contract is not qualified');
    for (const name of REQUIRED_CAPABILITIES) if (!normalized[name]) unqualified(`${name} is not qualified`);
  }
  return Object.freeze({ contract, digest: digest(contract), revision: upstream.revision, capabilities: Object.freeze(normalized) });
}

/** The only body fields a write may carry: the adapter's managed fields, never the
 * full validator surface (e.g. adapterConfig, permissions, runtimeConfig, spend). */
export function sendableFields(name, c) {
  if (CAPABILITIES[name] === 'GET') return [];
  if (name === 'company.update') return Object.keys(c.gate);
  const resource = name.split('.')[0], { name: nameField, summary } = RESOURCES[resource];
  const managed = [nameField, summary, c.externalKey.field, c.idempotencyField, c.goalLink, c.hierarchyField,
    ...(resource === 'agent' ? ['role', 'title'] : []), ...Object.keys(c.fixed)];
  return [...new Set(managed.filter((f) => f && c.bodyFields.includes(f)))];
}

export class PaperclipTransportError extends OrganizationError {
  constructor(code, status = null) {
    super(code, status === null ? code : `${code} (HTTP ${String(status)})`);
    this.status = status;
  }
}

function privateOrigin(value, allowLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse('invalid_paperclip_origin');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === '::1';
  need(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (value === url.origin || value === url.origin + '/') &&
    ((url.protocol === 'https:' && !isIP(host) && host !== 'localhost' && !host.endsWith('.localhost')) ||
      (allowLoopback === true && loopback && ['http:', 'https:'].includes(url.protocol))), 'invalid_paperclip_origin');
  return url.origin;
}

/**
 * A fixed-origin transport whose only reachable routes are the contract's exact
 * method/template pairs. Path parameters must be UUIDs; query keys are only the
 * contract's pagination parameters. The credential appears only in the bearer header.
 */
export function createPaperclipTransport({ origin, apiKey, contract, fetchImpl = globalThis.fetch, allowLoopback = false,
  forbiddenOrigins = [], timeoutMs = 8000, maxBytes = 1048576 } = {}) {
  const spec = validateContract(contract);
  const fixed = privateOrigin(origin, allowLoopback);
  need(Array.isArray(forbiddenOrigins) && forbiddenOrigins.length <= 16, 'invalid_paperclip_transport');
  for (const o of forbiddenOrigins) need(new URL(o).origin !== fixed, 'paperclip_origin_forbidden', 'origin is a native or custody endpoint');
  need(typeof apiKey === 'string' && /^[\x21-\x7e]{16,4096}$/.test(apiKey), 'invalid_paperclip_transport', 'invalid operator credential');
  need(typeof fetchImpl === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000 &&
    Number.isInteger(maxBytes) && maxBytes >= 512 && maxBytes <= 4194304, 'invalid_paperclip_transport');
  const sendable = Object.fromEntries(Object.entries(spec.capabilities).map(([n, c]) => [n, sendableFields(n, c)]));
  const fail = (code, status = null) => {
    throw new PaperclipTransportError(code, status);
  };
  async function request(capability, params = {}, { query, body } = {}) {
    const c = Object.hasOwn(spec.capabilities, capability) ? spec.capabilities[capability] : null;
    if (!c) fail('paperclip_route_not_permitted');
    const names = paramsOf(c.path);
    if (!exactKeys(params, names) || !names.every((n) => typeof params[n] === 'string' && UUID.test(params[n]))) fail('paperclip_invalid_route');
    const url = new URL(c.path.replace(/:([A-Za-z]+)/g, (_, n) => params[n]), fixed);
    if (query !== undefined) {
      const allowed = c.pagination ? [c.pagination.limitParam, c.pagination.offsetParam] : [];
      if (!plain(query) || !Object.entries(query).every(([k, v]) => allowed.includes(k) && Number.isSafeInteger(v) && v >= 0 && v <= 1000000))
        fail('paperclip_invalid_route');
      url.search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    }
    const write = c.method !== 'GET';
    let raw = null;
    if (write) {
      if (!plain(body) || !Object.keys(body).every((k) => sendable[capability].includes(k))) fail('paperclip_invalid_body');
      raw = JSON.stringify(body);
      if (Buffer.byteLength(raw) > 65536) fail('paperclip_invalid_body');
    } else if (body !== undefined) fail('paperclip_invalid_body');
    // Past this point a write may have reached the server: failures are ambiguous
    // unless the status proves nothing was written.
    const unknown = write ? 'paperclip_outcome_unknown' : 'paperclip_unavailable';
    const abort = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new PaperclipTransportError(unknown));
      }, timeoutMs);
    });
    const work = (async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: c.method,
          headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(write ? { 'Content-Type': 'application/json' } : {}) },
          body: raw ?? undefined,
          redirect: 'error',
          signal: abort.signal,
        });
      } catch {
        fail(unknown);
      }
      const status = response.status;
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (status === 401 || status === 403) fail('paperclip_access_denied', status);
        if (status === 404) fail('paperclip_not_found', status);
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) fail('paperclip_rejected', status);
        fail(unknown, status);
      }
      if (response.url && new URL(response.url).origin !== fixed) fail(unknown, status);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) fail(unknown, status);
      const chunks = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maxBytes) fail(unknown, status);
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e instanceof PaperclipTransportError) throw e;
        fail(unknown, status);
      } finally {
        await reader.cancel().catch(() => {});
      }
      try {
        return { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      } catch {
        fail(unknown, status);
      }
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  return Object.freeze({
    origin: fixed,
    revision: spec.revision,
    contractDigest: spec.digest,
    has: (capability) => Object.hasOwn(spec.capabilities, capability),
    request,
  });
}

/** Read-bridge lookup over the registry: only a fully bound company/project pair maps. */
export function createRegistryLookup(registry) {
  need(registry && typeof registry.get === 'function', 'invalid_registry_lookup');
  return (nativeProjectId) => {
    let b;
    try {
      b = registry.get(nativeProjectId);
    } catch (e) {
      if (e?.code === 'project_not_selected') return null;
      throw e;
    }
    return b.paperclipCompanyId && b.paperclipProjectId ? { companyId: b.paperclipCompanyId, projectId: b.paperclipProjectId } : null;
  };
}

class Hold extends Error {
  constructor(code, step) {
    super(code);
    this.code = code;
    this.step = step;
  }
}

const STEPS = Object.freeze([
  { step: 'company', resource: 'company', field: 'paperclipCompanyId', write: 'company.create' },
  { step: 'gate', resource: 'company', field: null, write: 'company.update' },
  { step: 'goal', resource: 'goal', field: 'paperclipGoalId', write: 'goal.create' },
  { step: 'project', resource: 'project', field: 'paperclipProjectId', write: 'project.create' },
  { step: 'ceo', resource: 'agent', field: 'ceoAgentId', write: 'agent.hire' },
  { step: 'manager', resource: 'agent', field: 'managerAgentId', write: 'agent.hire' },
]);
const SENT = ['dispatched', 'unknown', 'confirmed'];
const OPEN = ['dispatched', 'unknown'];
const keyOf = (p, step) => `uain:${p.id}:${step}`;
const keyed = (record, ext, key) => ext.format === 'trailing-line'
  ? typeof record?.[ext.field] === 'string' && record[ext.field].split('\n').at(-1) === MARKER + key
  : plain(record?.[ext.field]) && record[ext.field][ext.property] === key;
const contains = (record, expected) => Object.entries(expected).every(([k, v]) => JSON.stringify(record?.[k]) === JSON.stringify(v));

/**
 * @param transport a createPaperclipTransport() instance built from the same contract
 * @param registry openRegistry(); journal openJournal(); selection validateSelection()
 */
export function createOrganizationAdapter({ transport, registry, journal, selection, contract, now = () => Date.now(),
  maxListPages = 10, owner = `paperclip-organizations-${randomUUID()}`, leaseMs = 120000 } = {}) {
  const spec = validateContract(contract);
  need(transport && typeof transport.request === 'function' && typeof transport.has === 'function', 'invalid_paperclip_adapter');
  need(transport.contractDigest === spec.digest, 'paperclip_contract_mismatch', 'transport permits a different contract');
  for (const name of REQUIRED_CAPABILITIES) if (!transport.has(name)) unqualified(`${name} is not permitted by the transport`);
  need(registry && journal && selection?.projects?.length === 120, 'invalid_paperclip_adapter');
  need(Number.isInteger(maxListPages) && maxListPages >= 1 && maxListPages <= 50 && text(owner, 1, 96), 'invalid_paperclip_adapter');
  const caps = spec.capabilities, gate = caps['company.update'].gate;
  // A 401/403 means this credential (e.g. a Viewer) cannot write. Stop every
  // later call from this adapter instead of producing a retry storm.
  let denied = false;

  const call = async (step, capability, params, options) => {
    if (denied) throw new Hold('paperclip_access_denied', step);
    try {
      return (await transport.request(capability, params, options)).body;
    } catch (e) {
      if (e?.code === 'paperclip_access_denied') denied = true;
      if (e instanceof PaperclipTransportError && caps[capability].method === 'GET')
        throw new Hold(e.code === 'paperclip_not_found' ? 'paperclip_bound_record_missing' : e.code, step);
      throw e;
    }
  };
  const routeParams = (resource, ctx, id) => {
    const out = {};
    for (const n of paramsOf(caps[`${resource}.get`].path)) out[n] = n === RESOURCES[resource].param ? id : ctx.binding.paperclipCompanyId;
    return out;
  };
  const scopeParams = (resource, ctx) => (resource === 'company' ? {} : { companyId: ctx.binding.paperclipCompanyId });

  function desired(s, p, ctx) {
    const create = caps[s.write], key = keyOf(p, s.step), { name: nameField, summary: summaryField } = RESOURCES[s.resource];
    const body = { ...create.fixed };
    let name, summary;
    if (s.step === 'company') {
      name = `UAIN ${p.id}`;
      summary = `Private UAIN project organization for ${p.id} (native ${p.nativeProjectId}). Organizational records only; no native authority, funding or payment.`;
    } else if (s.step === 'goal') {
      name = p.mainKpi;
      summary = `Main KPI for ${p.id}, unchanged from the frozen selection.`;
    } else if (s.step === 'project') {
      name = `${p.id} research`;
      summary = `Project for ${p.id}; source digest ${p.sourceDigest}.`;
      body[create.goalLink] = create.goalLink === 'goalIds' ? [ctx.binding.paperclipGoalId] : ctx.binding.paperclipGoalId;
    } else {
      const ceo = s.step === 'ceo';
      name = ceo ? `CEO ${p.id}` : `Project Manager ${p.id}`;
      summary = ceo ? `Chief Executive Officer for ${p.id}. Preserves the Main KPI; cannot approve plans, verify work or unlock money.`
        : `Project Manager for ${p.id}, reporting to the CEO. Cannot approve plans, verify own work or unlock money.`;
      body.role = ceo ? create.roles.ceo : create.roles.manager;
      body[create.hierarchyField] = ceo ? null : ctx.binding.ceoAgentId;
      if (create.bodyFields.includes('title')) body.title = ceo ? 'Chief Executive Officer' : 'Project Manager';
    }
    body[nameField] = name;
    const ext = create.externalKey;
    if (ext.format === 'trailing-line') body[ext.field] = `${summary}\n\n${MARKER}${key}`;
    else {
      body[ext.field] = { [ext.property]: key };
      if (summaryField !== ext.field && create.bodyFields.includes(summaryField)) body[summaryField] = summary;
    }
    if (create.idempotencyField) body[create.idempotencyField] = key;
    return { key, name, body, create };
  }

  /** Exact identity check on a record from a list or get. Throws a hold on any drift. */
  function verify(s, ctx, want, record, id = record?.id) {
    const nameField = RESOURCES[s.resource].name, create = want.create;
    if (!plain(record) || record.id !== id || !UUID.test(record.id)) throw new Hold('paperclip_readback_mismatch', s.step);
    if (s.resource !== 'company' && record.companyId !== ctx.binding.paperclipCompanyId) throw new Hold('paperclip_cross_company', s.step);
    if (!keyed(record, create.externalKey, want.key)) throw new Hold('paperclip_binding_conflict', s.step);
    if (record[nameField] !== want.name) throw new Hold('paperclip_readback_mismatch', s.step);
    if (s.step === 'project') {
      const link = record[create.goalLink] ?? record.goalIds;
      if (!(link === ctx.binding.paperclipGoalId || (Array.isArray(link) && link.includes(ctx.binding.paperclipGoalId))))
        throw new Hold('paperclip_readback_mismatch', s.step);
    }
    if (s.resource === 'agent') {
      if (record.role !== want.body.role || (record[create.hierarchyField] ?? null) !== want.body[create.hierarchyField])
        throw new Hold('paperclip_hierarchy_mismatch', s.step);
      if (!contains(record, create.expect)) throw new Hold('paperclip_agent_not_pending_approval', s.step);
    }
    return record;
  }
  const proofOf = (resource, record, fetchedAt, extra = {}) => {
    const summary = { id: record.id, companyId: resource === 'company' ? record.id : record.companyId,
      status: typeof record.status === 'string' ? record.status.slice(0, 80) : null, ...extra };
    return { capability: `${resource}.get`, revision: spec.revision, fetchedAt: new Date(fetchedAt).toISOString(),
      record: summary, recordDigest: digest(summary) };
  };

  async function readback(s, ctx, want, id) {
    const record = await call(s.step, `${s.resource}.get`, routeParams(s.resource, ctx, id));
    return { record: verify(s, ctx, want, record, id), proof: proofOf(s.resource, record, now()) };
  }

  /** Bounded external-key lookup. A full final page is refused rather than truncated. */
  async function lookup(s, ctx, want) {
    const capability = `${s.resource}.list`, c = caps[capability], rows = [];
    if (!c.pagination) {
      const page = await call(s.step, capability, scopeParams(s.resource, ctx));
      if (!Array.isArray(page) || page.length > MAX_LIST_ROWS) throw new Hold('paperclip_lookup_unbounded', s.step);
      rows.push(...page);
    } else {
      for (let page = 0; ; page++) {
        if (page >= maxListPages) throw new Hold('paperclip_lookup_unbounded', s.step);
        const { limitParam, offsetParam, maxLimit } = c.pagination;
        const batch = await call(s.step, capability, scopeParams(s.resource, ctx), { query: { [limitParam]: maxLimit, [offsetParam]: page * maxLimit } });
        if (!Array.isArray(batch) || batch.length > maxLimit) throw new Hold('paperclip_lookup_unbounded', s.step);
        rows.push(...batch);
        if (batch.length < maxLimit) break;
      }
    }
    const nameField = RESOURCES[s.resource].name, ext = want.create.externalKey;
    for (const r of rows) {
      if (!plain(r) || typeof r.id !== 'string' || !UUID.test(r.id)) throw new Hold('paperclip_invalid_response', s.step);
      if (s.resource !== 'company' && r.companyId !== ctx.binding.paperclipCompanyId) throw new Hold('paperclip_cross_company', s.step);
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Hold('paperclip_invalid_response', s.step);
    return {
      mine: rows.filter((r) => keyed(r, ext, want.key)),
      sameName: rows.filter((r) => r[nameField] === want.name && !keyed(r, ext, want.key)),
    };
  }

  const attemptOf = (intent) => Number(intent.id.split('.').at(-1));
  const intentsOf = (p, s) => journal.list({ projectId: p.id })
    .filter((i) => i.kind === 'paperclip' && i.operation === `paperclip.${s.step}.${s.field ? 'create' : 'update'}`)
    .sort((a, b) => attemptOf(a) - attemptOf(b));
  /** Outcome observed: settle every still-open attempt of this step with the same proof. */
  const settle = (intents, proof) => {
    for (const i of intents) if (OPEN.includes(i.state)) journal.reconcile(i.id, { found: true, proof });
  };
  /** Next attempt after a never-sent claim is returned to `prepared`. */
  function nextAttempt(intents, s) {
    let last = intents.at(-1) ?? null;
    if (last?.state === 'claimed') last = journal.reconcile(last.id, { found: false });
    const attempt = !last ? 1 : last.state === 'prepared' ? attemptOf(last) : attemptOf(last) + 1;
    if (attempt > MAX_ATTEMPTS) throw new Hold('paperclip_write_attempts_exhausted', s.step);
    return attempt;
  }

  /** Journal, send and classify one write. Returns the response body or throws a hold. */
  async function send(s, p, attempt, capability, params, body) {
    const envelope = { capability, method: caps[capability].method, path: caps[capability].path, params, body };
    const id = `pc.${p.id}.${s.step}.${attempt}`;
    journal.prepare({ id, projectId: p.id, kind: 'paperclip', operation: `paperclip.${s.step}.${s.field ? 'create' : 'update'}`,
      payload: envelope, selectionDigest: selection.digest, sourceDigest: p.sourceDigest,
      // One signer per attempt: Paperclip has no nonce lane; the project lease serializes.
      signer: `paperclip:${p.id}.${s.step}.${attempt}`,
      expectedRevision: s.field ? `${s.field}=null` : 'gate=unset' });
    journal.claim(id, owner);
    journal.recordEnvelope(id, envelope);
    try {
      return { id, response: await call(s.step, capability, params, { body }) };
    } catch (e) {
      if (e instanceof Hold) throw e;
      if (DEFINITE.has(e?.code)) {
        journal.fail(id, e.code, { rejection: { definite: true, code: e.code, status: e.status ?? null } });
        throw new Hold(e.code, s.step);
      }
      journal.markUnknown(id);
      throw new Hold('paperclip_write_outcome_unknown', s.step);
    }
  }

  function bind(s, p, ctx, id) {
    try {
      ctx.binding = registry.bind(p.id, { [s.field]: id }, { expectedRevision: ctx.binding.revision });
    } catch (e) {
      if (e instanceof OrganizationError) throw new Hold(e.code, s.step);
      throw e;
    }
  }

  /** The company's board-approval gate: set (idempotent PATCH) and read back before any hire. */
  async function ensureGate(s, p, ctx) {
    const company = { step: 'gate', resource: 'company' };
    const want = desired(STEPS[0], p, ctx);
    const id = ctx.binding.paperclipCompanyId;
    const intents = intentsOf(p, s);
    const { record } = await readback(company, ctx, want, id);
    if (contains(record, gate)) {
      const proof = proofOf('company', record, now(), { gate: true });
      settle(intents, proof);
      return proof;
    }
    // Re-setting a boolean is idempotent, so an unknown earlier PATCH is superseded, not held.
    for (const i of intents) if (i.state === 'dispatched') journal.markUnknown(i.id);
    const attempt = nextAttempt(intents, s);
    const { id: intentId } = await send(s, p, attempt, 'company.update', routeParams('company', ctx, id), { ...gate });
    let after;
    try {
      ({ record: after } = await readback(company, ctx, want, id));
    } catch (e) {
      journal.markUnknown(intentId);
      throw e;
    }
    if (!contains(after, gate)) {
      journal.markUnknown(intentId);
      throw new Hold('paperclip_gate_not_applied', s.step);
    }
    const proof = proofOf('company', after, now(), { gate: true });
    journal.recordReceipt(intentId, proof);
    settle(intentsOf(p, s), proof);
    return proof;
  }

  async function ensure(s, p, ctx) {
    if (!s.field) return ensureGate(s, p, ctx);
    const want = desired(s, p, ctx);
    const bound = ctx.binding[s.field];
    if (bound) return (await readback(s, ctx, want, bound)).proof;
    const intents = intentsOf(p, s);
    const { mine, sameName } = await lookup(s, ctx, want);
    if (mine.length > 1) throw new Hold('paperclip_duplicate_external_key', s.step);
    if (mine.length === 1) {
      // Our key exists upstream. Adopt it only as the outcome of a write we sent.
      const sent = intents.filter((i) => SENT.includes(i.state));
      if (!sent.length) throw new Hold('paperclip_unjournaled_external_key', s.step);
      const confirmed = sent.find((i) => i.state === 'confirmed');
      if (confirmed && confirmed.receipt?.record?.id !== mine[0].id) throw new Hold('paperclip_binding_conflict', s.step);
      const { proof } = await readback(s, ctx, want, mine[0].id);
      settle(intents, proof);
      bind(s, p, ctx, mine[0].id);
      return proof;
    }
    if (intents.some((i) => i.state === 'confirmed')) throw new Hold('paperclip_bound_record_missing', s.step);
    if (intents.some((i) => OPEN.includes(i.state))) {
      for (const i of intents) if (i.state === 'dispatched') journal.markUnknown(i.id);
      // Possibly created and not yet visible. Only a server-deduplicated create
      // (same idempotency key and body) may be replayed; anything else holds.
      if (!want.create.replaySafe) throw new Hold('paperclip_write_outcome_unknown', s.step);
    }
    if (sameName.length) throw new Hold('paperclip_name_conflict', s.step);
    const attempt = nextAttempt(intents, s);
    const { id, response } = await send(s, p, attempt, s.write, scopeParams(s.resource, ctx), want.body);
    const created = want.create.responseField ? response?.[want.create.responseField] : response;
    if (!plain(created) || typeof created.id !== 'string' || !UUID.test(created.id)) {
      journal.markUnknown(id);
      throw new Hold('paperclip_write_outcome_unknown', s.step);
    }
    let proof;
    try {
      ({ proof } = await readback(s, ctx, want, created.id));
    } catch (e) {
      journal.markUnknown(id);
      throw e;
    }
    journal.recordReceipt(id, proof);
    settle(intentsOf(p, s), proof);
    bind(s, p, ctx, created.id);
    return proof;
  }

  return Object.freeze({
    revision: spec.revision,
    /** Reconciles company -> approval gate -> goal -> project -> CEO hire -> manager hire. Stops at the first hold. */
    async reconcile(projectId) {
      const p = selection.get(projectId);
      const ctx = { binding: registry.get(p.id) };
      const result = (status, hold = null, evidence = []) => ({
        projectId: p.id, nativeProjectId: p.nativeProjectId, status, hold, evidence,
        bindings: Object.fromEntries(STEPS.filter((s) => s.field).map((s) => [s.step, ctx.binding[s.field]])),
        agentRuns: null, wake: false, approvals: null,
      });
      if (denied) return result('held', { code: 'paperclip_access_denied', step: null });
      const leaseKey = `paperclip:${p.id}`;
      if (!journal.acquireLease(leaseKey, owner, leaseMs)) return result('held', { code: 'paperclip_reconcile_busy', step: null });
      const evidence = [];
      let step = null;
      try {
        for (const s of STEPS) {
          step = s.step;
          evidence.push({ step, ...(await ensure(s, p, ctx)) });
        }
        return result('complete', null, evidence);
      } catch (e) {
        if (e instanceof Hold) return result('held', { code: e.code, step: e.step }, evidence);
        // A journal/registry refusal (e.g. a changed payload under a retained intent) holds the project.
        if (e instanceof OrganizationError) return result('held', { code: e.code, step }, evidence);
        throw e;
      } finally {
        journal.releaseLease(leaseKey, owner);
      }
    },
    /** GET-only status from actual readback. Unbound or unreadable values stay null. */
    async projectStatus(projectId) {
      const p = selection.get(projectId);
      const ctx = { binding: registry.get(p.id) };
      const organization = {};
      let approvalGate = null;
      for (const s of STEPS.filter((x) => x.field)) {
        const id = ctx.binding[s.field];
        const entry = { id, status: null, readback: id ? 'unavailable' : null, reason: null, evidence: null };
        organization[s.step] = entry;
        if (!id) continue;
        if (s.resource !== 'company' && !ctx.binding.paperclipCompanyId) {
          entry.reason = 'company_unbound';
          continue;
        }
        try {
          const { record, proof } = await readback(s, ctx, desired(s, p, ctx), id);
          Object.assign(entry, { status: typeof record.status === 'string' ? record.status.slice(0, 80) : null, readback: 'verified', evidence: proof });
          if (s.step === 'company') approvalGate = contains(record, gate);
        } catch (e) {
          if (!(e instanceof Hold || e instanceof PaperclipTransportError)) throw e;
          entry.readback = e.code === 'paperclip_access_denied' || e.code === 'paperclip_unavailable' ? 'unavailable' : 'mismatch';
          entry.reason = e.code;
        }
      }
      const verified = (step) => organization[step].readback === 'verified';
      return {
        projectId: p.id,
        nativeProjectId: p.nativeProjectId,
        revision: spec.revision,
        organization,
        approvalGate,
        hierarchy: { managerReportsToCeo: verified('ceo') && verified('manager') ? true : null },
        intents: journal.list({ projectId: p.id }).filter((i) => i.kind === 'paperclip').map((i) => ({ id: i.id, operation: i.operation, state: i.state })),
        agentRuns: null,
        wake: false,
        approvals: null,
      };
    },
  });
}
