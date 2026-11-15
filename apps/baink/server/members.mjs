/** Public HTTP projections only. This module neither authenticates native state
 * nor reads BAINK account storage, keys, balances or private conversations. */
const ADDRESS = /^uain1[0-9a-f]{40}$/;
const INSTANCE = /^[a-z0-9-]{1,160}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : null;
const strings = value => Array.isArray(value) ? value.slice(0, 30).filter(v => typeof v === 'string').map(v => v.slice(0, 200)) : [];

export class MemberDirectoryError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const reject = (status, code, message) => { throw new MemberDirectoryError(status, code, message); };
const unavailable = () => reject(503, 'member_source_unavailable', 'The public member source is unavailable.');

function sourceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Member source requires an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Member source requires a bare HTTPS origin.');
  return url.origin;
}
function queryFields(input, allowSearch) {
  if (!object(input) || Object.keys(input).some(k => !['page', 'pageSize', ...(allowSearch ? ['search'] : [])].includes(k)))
    reject(400, 'invalid_member_query', 'Unsupported member query.');
  const {page = 1, pageSize = 24, search = ''} = input;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || typeof search !== 'string' || search.length > 120 || /[\u0000-\u001f\u007f]/.test(search))
    reject(400, 'invalid_member_query', 'Member pagination or search is outside its bounds.');
  return {page, pageSize, search: search.trim()};
}
function instance(row, expectedAddress = null) {
  if (!object(row) || !INSTANCE.test(row.id)) unavailable();
  const candidates = [row.address, row.member_id, row.member?.address].filter(v => v !== null && v !== undefined);
  if (!candidates.length) return null;
  if (candidates.some(v => !ADDRESS.test(v) || v !== candidates[0]) || (expectedAddress && candidates[0] !== expectedAddress)) unavailable();
  const licence = row.member?.licence ?? row.licence;
  return {
    address: candidates[0], instanceId: row.id, name: text(row.name),
    memberName: text(row.member?.name), about: text(row.member?.about, 2000),
    model: text(row.model, 200), operator: text(row.operator, 200),
    licence: {status: text(licence?.status, 40) ?? 'unknown', since: text(licence?.since, 80)},
    state: text(row.state, 80), capabilities: strings(row.capabilities),
    offers: strings(row.offers), protocols: strings(row.protocols),
    declarationsVerified: false, trusted: false,
    contact: {endpoint: text(row.endpoint, 500), declared: true, reachableVerified: false},
  };
}
function contribution(row, expectedAddress, instanceId) {
  if (!object(row) || typeof row.id !== 'string' || row.id.length > 160) unavailable();
  if ((row.member_id && row.member_id !== expectedAddress) || (row.contributor && row.contributor !== instanceId)) unavailable();
  return {id: row.id, instanceId, memberAddress: expectedAddress,
    projectId: text(row.project_id, 160), taskId: text(row.task_id, 160), title: text(row.title, 500),
    state: text(row.state, 80) ?? 'unknown', submittedAt: text(row.submitted_at, 80),
    settledAt: text(row.settled_at, 80), achieved: false,
    sourceOutcome: text(row.task_final_outcome, 80),
    note: 'Reported research record; not proof of achieved KPI, paid bounty or native finality.'};
}

export function createMemberDirectory({
  origin = 'https://uain.global', allowedOrigins = ['https://uain.global'],
  fetchImpl = globalThis.fetch, timeoutMs = 6000, maxBytes = 1024 * 1024,
  maxConcurrent = 2, cacheTtlMs = 20_000, maxCacheEntries = 64, now = Date.now,
} = {}) {
  origin = sourceOrigin(origin);
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 8 || !allowedOrigins.map(sourceOrigin).includes(origin))
    throw Error('Member source origin is not in the configured allowlist.');
  for (const [value, min, max] of [[timeoutMs, 10, 10_000], [maxBytes, 1024, 2 * 1024 * 1024], [maxConcurrent, 1, 4], [cacheTtlMs, 0, 30_000], [maxCacheEntries, 1, 128]])
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Member source bound is invalid.');
  const cache = new Map(), inflight = new Map();
  let active = 0;
  function provenance(raw, url) {
    return {kind: 'public-http-projection', url, fetchedAt: new Date(now()).toISOString(),
      authorityClaim: text(raw.authority, 80), epochClaim: text(raw.epoch, 128),
      stateHeightClaim: text(raw.state_height, 80), appHashClaim: text(raw.app_hash, 128),
      independentlyVerified: false, note: 'Source claims are not independently verified by BAINK. No native proof or fresh licence attestation is provided by this adapter.'};
  }
  async function request(path, deadline) {
    const url = new URL(path, origin), controller = new AbortController();
    if (url.origin !== origin) unavailable();
    let timer;
    const expired = new Promise((_, fail) => { timer = setTimeout(() => { controller.abort(); fail(new Error('Member source deadline exceeded.')); }, Math.max(1, deadline - Date.now())); });
    const read = async () => {
      const response = await fetchImpl(url, {method: 'GET', headers: {Accept: 'application/json'}, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal});
      if (!response || response.status < 200 || response.status >= 300 && response.status < 400 || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) unavailable();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) unavailable();
      if (!response.body) unavailable();
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) unavailable(); chunks.push(Buffer.from(next.value)); }
      } finally { await reader.cancel().catch(() => {}); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { unavailable(); }
      if (!object(body)) unavailable();
      if (!response.ok || body.error) {
        const error = new MemberDirectoryError(response.status === 404 ? 404 : 503, response.status === 404 ? 'member_missing' : 'member_source_unavailable', 'The public member source could not serve this record.');
        if (body.error === 'native_route_required') error.sourceCode = 'native_route_required';
        throw error;
      }
      return {body, source: provenance(body, url.href)};
    };
    try { return await Promise.race([read(), expired]); }
    catch (error) { controller.abort(); if (error instanceof MemberDirectoryError) throw error; unavailable(); }
    finally { clearTimeout(timer); }
  }
  async function bounded(key, work) {
    const cached = cache.get(key);
    if (cached && now() - cached.at < cacheTtlMs) return structuredClone(cached.value);
    cache.delete(key);
    if (inflight.has(key)) return structuredClone(await inflight.get(key));
    if (active >= maxConcurrent) reject(503, 'member_source_busy', 'Public member reads are busy. Retry shortly.');
    active++;
    const pending = Promise.resolve().then(() => work(Date.now() + timeoutMs));
    inflight.set(key, pending);
    try {
      const value = await pending;
      if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(key, {at: now(), value});
      return structuredClone(value);
    } finally { active--; inflight.delete(key); }
  }
  return Object.freeze({
    async list(input = {}) {
      const q = queryFields(input, true), params = new URLSearchParams({page: String(q.page), page_size: String(q.pageSize), ...(q.search ? {q: q.search} : {})});
      return bounded('list:' + params, async deadline => {
        const {body, source} = await request('/api/directory?' + params, deadline);
        if (!Array.isArray(body.participants) || body.participants.length > q.pageSize || !Number.isSafeInteger(body.count) || body.count < 0 || !Number.isSafeInteger(body.page) || body.page !== q.page || !Number.isSafeInteger(body.page_size) || body.page_size !== q.pageSize || !Number.isSafeInteger(body.pages) || body.pages < 1) unavailable();
        const normalized = body.participants.map(row => instance(row));
        return {members: normalized.filter(Boolean), sourceCount: body.count, countScope: 'source-instances-not-unique-members',
          excludedUnlinkedCount: normalized.filter(v => !v).length, page: body.page, pageSize: body.page_size, pages: body.pages, source};
      });
    },
    async get(address, input = {}) {
      if (typeof address !== 'string' || !ADDRESS.test(address)) reject(400, 'invalid_member_address', 'Provide the full UAIN public member address.');
      const q = queryFields(input, false);
      return bounded('member:' + address + ':' + q.page + ':' + q.pageSize, async deadline => {
        const {body, source} = await request('/api/members/' + address, deadline);
        if (body.address !== address || (body.id && body.id !== address) || !Array.isArray(body.agents) || body.agents.length > 100) unavailable();
        const agents = body.agents.map(row => instance(row, address));
        if (agents.some(v => !v)) unavailable();
        let trackRecord;
        try {
          const track = await request('/api/members/' + address + '/track-record?page=' + q.page + '&page_size=' + q.pageSize, deadline);
          if (track.body.subject?.address !== address || !Array.isArray(track.body.contributions) || track.body.contributions.length > 100 || track.body.contributions.some(row => !agents.some(agent => agent.instanceId === row?.agent))) unavailable();
          trackRecord = {status: 'available', complete: false, source: track.source,
            contributions: track.body.contributions.map(row => contribution({...row, contributor: row.agent}, address, text(row.agent, 160)))};
        } catch (error) { trackRecord = {status: 'unavailable', reason: error.sourceCode ?? 'source_unavailable', contributions: null}; }
        let work = {status: agents.length ? 'unavailable' : 'not-reported', complete: false, contributed: null, verified: null, sources: []};
        if (agents.length) {
          const records = [], checks = [], sources = []; let failed = false;
          for (const agent of agents.slice(0, 3)) {
            try {
              const detail = await request('/api/directory/' + agent.instanceId, deadline);
              const subject = instance(detail.body, address);
              if (!subject || subject.instanceId !== agent.instanceId || !object(detail.body.work) || !Array.isArray(detail.body.work.contributed) || !Array.isArray(detail.body.work.verified) || detail.body.work.contributed.length > 100 || detail.body.work.verified.length > 100) unavailable();
              records.push(...detail.body.work.contributed.slice(0, 20).map(row => contribution(row, address, agent.instanceId)));
              checks.push(...detail.body.work.verified.slice(0, 20).map(row => ({contributionId: text(row.contribution_id ?? row.id, 160), instanceId: agent.instanceId, verdict: text(row.verdict, 80), at: text(row.at, 80)})));
              sources.push(detail.source);
            } catch { failed = true; }
          }
          if (sources.length) work = {status: failed ? 'partial' : 'available', complete: false, contributed: records, verified: checks, sources, instanceLimit: 3, workPerInstanceLimit: 20, totalInstances: agents.length};
        }
        return {member: {address, name: text(body.name), about: text(body.about, 2000), operator: text(body.operator, 200),
          licence: {status: text(body.licence?.status, 40) ?? 'unknown', since: text(body.licence?.since, 80)},
          trusted: false, agents}, trackRecord, work, source};
      });
    },
  });
}
