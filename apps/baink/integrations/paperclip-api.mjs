import { isIP } from 'node:net';

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const ISSUE_STATES = new Set([
  'all',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
  'blocked',
]);
export class PaperclipReadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (code = 'invalid_paperclip_configuration') => {
  throw new PaperclipReadError(
    code === 'invalid_paperclip_query' ? 400 : 503,
    code,
    code === 'invalid_paperclip_query'
      ? 'Invalid Paperclip read selection.'
      : 'Paperclip configuration is invalid.',
  );
};
const valid = (condition, code) => {
  if (!condition) fail(code);
};
function fixedOrigin(value, allowLoopback) {
  valid(typeof value === 'string');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''),
    loopback = host === '127.0.0.1' || host === '::1';
  valid(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      (value === url.origin || value === url.origin + '/') &&
      ((url.protocol === 'https:' &&
        !isIP(host) &&
        host !== 'localhost' &&
        !host.endsWith('.localhost')) ||
        (allowLoopback &&
          loopback &&
          ['http:', 'https:'].includes(url.protocol))),
  );
  return url.origin;
}
function optionsOf(options = {}) {
  valid(
    options &&
      typeof options === 'object' &&
      !Array.isArray(options) &&
      Object.keys(options).every((k) =>
        ['page', 'pageSize', 'status'].includes(k),
      ),
    'invalid_paperclip_query',
  );
  const number = (value, fallback, max) => {
    if (value === undefined) return fallback;
    valid(
      (typeof value === 'number' ||
        (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) &&
        Number.isInteger(Number(value)) &&
        Number(value) >= 1 &&
        Number(value) <= max,
      'invalid_paperclip_query',
    );
    return Number(value);
  };
  const status = options.status ?? 'all';
  valid(
    typeof status === 'string' && ISSUE_STATES.has(status),
    'invalid_paperclip_query',
  );
  return {
    page: number(options.page, 1, 10000),
    pageSize: number(options.pageSize, 30, 100),
    status,
  };
}
export function paperclipConfigFromEnv(env = {}) {
  let projectMap = {};
  try {
    if (env.BAINK_PAPERCLIP_PROJECT_MAP_JSON)
      projectMap = JSON.parse(env.BAINK_PAPERCLIP_PROJECT_MAP_JSON);
  } catch {
    fail();
  }
  return {
    origin: env.BAINK_PAPERCLIP_ORIGIN,
    allowedOrigins: env.BAINK_PAPERCLIP_ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    apiKey: env.BAINK_PAPERCLIP_API_KEY,
    allowedCompanyIds: env.BAINK_PAPERCLIP_COMPANY_IDS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    projectMap,
    allowLoopback: env.BAINK_PAPERCLIP_ALLOW_LOOPBACK === '1',
  };
}

/** Server-only, deliberately GET-only. Explicit mappings publish no native
 * authority and confer no execution, spending or manager-chat permission.
 * `registryLookup(nativeProjectId) -> {companyId, projectId} | null` optionally
 * replaces the static 10-company/100-project map with the organization registry
 * for the fixed 120 organizations; the two sources are never mixed. */
export function createPaperclipReadBridge(configuration = {}) {
  valid(
    configuration &&
      typeof configuration === 'object' &&
      !Array.isArray(configuration),
  );
  const {
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    allowLoopback = false,
  } = configuration;
  valid(typeof fetchImpl === 'function' && typeof now === 'function');
  const origin = configuration.origin
    ? fixedOrigin(configuration.origin, allowLoopback === true)
    : null;
  const rawAllowedOrigins = configuration.allowedOrigins ?? [];
  valid(Array.isArray(rawAllowedOrigins) && rawAllowedOrigins.length <= 10);
  const allowedOrigins = rawAllowedOrigins.map((value) =>
    fixedOrigin(value, allowLoopback === true),
  );
  if (origin && allowedOrigins.length) valid(allowedOrigins.includes(origin));
  const apiKey =
    typeof configuration.apiKey === 'string' ? configuration.apiKey.trim() : '';
  if (apiKey) valid(/^[\x21-\x7e]{16,4096}$/.test(apiKey));
  const companies = configuration.allowedCompanyIds ?? [];
  valid(
    Array.isArray(companies) &&
      companies.length <= 10 &&
      companies.every((id) => typeof id === 'string' && UUID.test(id)),
  );
  const mapping = configuration.projectMap ?? {};
  valid(
    mapping &&
      typeof mapping === 'object' &&
      !Array.isArray(mapping) &&
      Object.keys(mapping).length <= 100,
  );
  const registryLookup = configuration.registryLookup ?? null;
  valid(
    registryLookup === null ||
      (typeof registryLookup === 'function' &&
        companies.length === 0 &&
        Object.keys(mapping).length === 0),
  );
  const projectMap = Object.create(null);
  for (const [nativeId, entry] of Object.entries(mapping)) {
    valid(
      NATIVE_ID.test(nativeId) &&
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.keys(entry).sort().join(',') === 'companyId,projectId' &&
        UUID.test(entry.companyId ?? '') &&
        UUID.test(entry.projectId ?? '') &&
        companies.includes(entry.companyId),
    );
    projectMap[nativeId] = Object.freeze({
      companyId: entry.companyId,
      projectId: entry.projectId,
    });
  }
  const timeoutMs = configuration.timeoutMs ?? 4000,
    maxBytes = configuration.maxBytes ?? 1048576,
    cacheMs = configuration.cacheMs ?? 15000,
    maxConcurrent = configuration.maxConcurrent ?? 2;
  valid(
    Number.isInteger(timeoutMs) &&
      timeoutMs >= 10 &&
      timeoutMs <= 8000 &&
      Number.isInteger(maxBytes) &&
      maxBytes >= 512 &&
      maxBytes <= 2097152 &&
      Number.isInteger(cacheMs) &&
      cacheMs >= 0 &&
      cacheMs <= 60000 &&
      Number.isInteger(maxConcurrent) &&
      maxConcurrent >= 1 &&
      maxConcurrent <= 4,
  );
  const configured = Boolean(
      origin &&
      allowedOrigins.includes(origin) &&
      apiKey &&
      (registryLookup || companies.length),
    ),
    cache = new Map(),
    pending = new Map();
  let active = 0;
  const text = (value, max = 400) =>
    typeof value === 'string'
      ? value
          .replaceAll(apiKey || '\0', '[redacted]')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
          .slice(0, max)
      : null;
  const staticScope = (nativeId) => projectMap[nativeId] ?? null;
  const source = (nativeId, scope) => ({
    provider: 'paperclip',
    origin,
    nativeProjectId: nativeId,
    companyId: scope?.companyId ?? null,
    projectId: scope?.projectId ?? null,
    fetchedAt: null,
    readOnly: true,
  });
  function empty(
    nativeId,
    status,
    reason = status,
    scope = registryLookup ? null : staticScope(nativeId),
  ) {
    return {
      status,
      reason,
      nativeProjectId: nativeId,
      project: null,
      manager: {
        status: 'unavailable',
        relationship: 'project_lead',
        agent: null,
      },
      tasks: { status: 'unavailable', items: null, count: null, pages: null },
      costs: {
        status: 'unavailable',
        currency: 'USD',
        costCentsExact: null,
        eventCount: null,
        estimatedEventCount: null,
      },
      source: source(nativeId, scope),
      capabilities: { readOnly: true, managerChat: false, writes: false },
    };
  }
  /** One bounded registry read per request; anything but an exact pair fails closed. */
  async function lookupScope(nativeId) {
    let timer;
    try {
      const found = await Promise.race([
        Promise.resolve().then(() => registryLookup(nativeId)),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('registry deadline')),
            timeoutMs,
          );
        }),
      ]);
      if (found === null || found === undefined) return null;
      if (
        !found ||
        typeof found !== 'object' ||
        Array.isArray(found) ||
        Object.keys(found).sort().join(',') !== 'companyId,projectId' ||
        !UUID.test(found.companyId ?? '') ||
        !UUID.test(found.projectId ?? '')
      )
        throw Error('registry mapping invalid');
      return Object.freeze({
        companyId: found.companyId,
        projectId: found.projectId,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  async function get(path, query, deadline) {
    const url = new URL(path, origin);
    if (query) url.search = new URLSearchParams(query).toString();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Paperclip deadline');
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(Error('Paperclip deadline'));
      }, remaining);
    });
    const work = (async () => {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: 'error',
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw Error('Paperclip read refused');
      }
      if (response.url && new URL(response.url).origin !== origin)
        throw Error('Paperclip response origin differs');
      if (
        !/^application\/json(?:\s*;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw Error('Paperclip JSON required');
      const declared = response.headers.get('content-length');
      if (
        declared !== null &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)
      )
        throw Error('Paperclip response bound');
      const chunks = [],
        stream = response.body.getReader();
      let length = 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          length += value.length;
          if (length > maxBytes) throw Error('Paperclip response bound');
          chunks.push(Buffer.from(value));
        }
      } finally {
        await stream.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
  const counted = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  async function load(nativeId, status, scope) {
    const deadline = Date.now() + timeoutMs;
    let raw;
    try {
      raw = await get(
        `/api/projects/${scope.projectId}`,
        { companyId: scope.companyId },
        deadline,
      );
      if (
        !raw ||
        raw.id !== scope.projectId ||
        raw.companyId !== scope.companyId ||
        typeof raw.name !== 'string' ||
        typeof raw.status !== 'string'
      )
        throw Error('Paperclip project scope differs');
    } catch {
      return empty(nativeId, 'unavailable', 'source_unavailable', scope);
    }
    const result = empty(nativeId, 'available', null, scope);
    result.project = {
      id: scope.projectId,
      companyId: scope.companyId,
      name: text(raw.name),
      status: text(raw.status, 80),
      updatedAt: text(raw.updatedAt, 80),
    };
    if (raw.leadAgentId === null || raw.leadAgentId === undefined)
      result.manager.status = 'not-assigned';
    else if (
      typeof raw.leadAgentId === 'string' &&
      UUID.test(raw.leadAgentId)
    ) {
      try {
        const manager = await get(
          `/api/agents/${raw.leadAgentId}`,
          { companyId: scope.companyId },
          deadline,
        );
        if (
          manager?.id !== raw.leadAgentId ||
          manager.companyId !== scope.companyId ||
          typeof manager.name !== 'string' ||
          typeof manager.status !== 'string'
        )
          throw Error('Paperclip manager scope differs');
        result.manager = {
          status: 'available',
          relationship: 'project_lead',
          agent: {
            id: manager.id,
            name: text(manager.name),
            title: text(manager.title, 160),
            role: text(manager.role, 80),
            status: text(manager.status, 80),
          },
        };
      } catch {}
    }
    try {
      const query = { projectId: scope.projectId, view: 'index' };
      if (status !== 'all') query.status = status;
      const issues = await get(
        `/api/companies/${scope.companyId}/issues`,
        query,
        deadline,
      );
      if (
        !Array.isArray(issues) ||
        issues.length > 1000 ||
        new Set(issues.map((row) => row?.id)).size !== issues.length ||
        issues.some(
          (row) =>
            !row ||
            !UUID.test(row.id ?? '') ||
            row.companyId !== scope.companyId ||
            row.projectId !== scope.projectId ||
            typeof row.title !== 'string' ||
            typeof row.status !== 'string' ||
            (row.assigneeAgentId !== null &&
              row.assigneeAgentId !== undefined &&
              !UUID.test(row.assigneeAgentId)),
        )
      )
        throw Error('Paperclip issues scope differs');
      const items = issues
        .filter((row) => status === 'all' || row.status === status)
        .map((row) => ({
          id: row.id,
          identifier: text(row.identifier, 100),
          title: text(row.title),
          status: text(row.status, 80),
          priority: text(row.priority, 80),
          assigneeAgentId: row.assigneeAgentId ?? null,
          updatedAt: text(row.updatedAt, 80),
        }));
      result.tasks = {
        status: 'available',
        items,
        count: items.length,
        pages: null,
        bounded: true,
        sourceLimit: 1000,
      };
    } catch {}
    try {
      const costs = await get(
        `/api/companies/${scope.companyId}/costs/by-project`,
        null,
        deadline,
      );
      if (
        !Array.isArray(costs) ||
        costs.length > 1000 ||
        costs.some(
          (row) =>
            !row ||
            (row.companyId !== undefined && row.companyId !== scope.companyId),
        )
      )
        throw Error('Paperclip costs scope differs');
      const matching = costs.filter((row) => row.projectId === scope.projectId);
      if (matching.length > 1) throw Error('Paperclip duplicate cost scope');
      if (!matching.length) result.costs.status = 'not-reported';
      else {
        const row = matching[0];
        let amount = null,
          precision = null;
        if (
          typeof row.costCentsExact === 'string' &&
          /^(0|[1-9][0-9]{0,19})(?:\.[0-9]{1,7})?$/.test(row.costCentsExact)
        ) {
          amount = row.costCentsExact;
          precision = 'exact-source';
        } else if (
          row.costCentsExact === undefined &&
          Number.isSafeInteger(row.costCents) &&
          row.costCents >= 0
        ) {
          amount = String(row.costCents);
          precision = 'integer-source';
        }
        if (amount !== null)
          result.costs = {
            status: 'available',
            currency: 'USD',
            costCentsExact: amount,
            precision,
            eventCount: counted(row.eventCount),
            estimatedEventCount: counted(row.estimatedEventCount),
            window: 'source-default-current-month',
          };
      }
    } catch {}
    result.partial =
      result.manager.status === 'unavailable' ||
      result.tasks.status === 'unavailable' ||
      result.costs.status === 'unavailable';
    result.source = {
      ...source(nativeId, scope),
      fetchedAt: new Date(now()).toISOString(),
      cacheMaxAgeMs: cacheMs,
    };
    return result;
  }
  function present(result, options) {
    const answer = structuredClone(result);
    answer.tasks.page = options.page;
    answer.tasks.pageSize = options.pageSize;
    if (answer.tasks.items !== null) {
      answer.tasks.pages = Math.max(
        1,
        Math.ceil(answer.tasks.count / options.pageSize),
      );
      answer.tasks.items = answer.tasks.items.slice(
        (options.page - 1) * options.pageSize,
        options.page * options.pageSize,
      );
    }
    return answer;
  }
  return Object.freeze({
    configured,
    readOnly: true,
    async project(nativeId, options = {}) {
      valid(
        typeof nativeId === 'string' && NATIVE_ID.test(nativeId),
        'invalid_paperclip_query',
      );
      const selected = optionsOf(options);
      if (!configured)
        return present(empty(nativeId, 'not-configured'), selected);
      let scope;
      if (registryLookup) {
        try {
          scope = await lookupScope(nativeId);
        } catch {
          return present(
            empty(nativeId, 'unavailable', 'mapping_unavailable'),
            selected,
          );
        }
        if (!scope) return present(empty(nativeId, 'unmapped'), selected);
      } else {
        if (!Object.hasOwn(projectMap, nativeId))
          return present(empty(nativeId, 'unmapped'), selected);
        scope = projectMap[nativeId];
      }
      // The scope is part of the key so a cached read never outlives its mapping.
      const key = [
          nativeId,
          selected.status,
          scope.companyId,
          scope.projectId,
        ].join(':'),
        previous = cache.get(key);
      if (previous && now() < previous.expires)
        return present(previous.value, selected);
      if (pending.has(key)) return present(await pending.get(key), selected);
      if (active >= maxConcurrent)
        return present(
          empty(nativeId, 'unavailable', 'capacity', scope),
          selected,
        );
      active++;
      const job = load(nativeId, selected.status, scope)
        .then((value) => {
          if (cache.size >= 16) cache.delete(cache.keys().next().value);
          cache.set(key, {
            value,
            expires:
              now() +
              (value.status === 'available'
                ? cacheMs
                : Math.min(cacheMs, 2000)),
          });
          return value;
        })
        .finally(() => {
          active--;
          pending.delete(key);
        });
      pending.set(key, job);
      return present(await job, selected);
    },
  });
}
