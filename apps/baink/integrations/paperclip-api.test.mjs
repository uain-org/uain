import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createPaperclipReadBridge } from './paperclip-api.mjs';

const origin = 'https://paperclip.operator.example',
  company = '11111111-1111-4111-8111-111111111111',
  project = '22222222-2222-4222-8222-222222222222',
  agent = '33333333-3333-4333-8333-333333333333',
  issue = '44444444-4444-4444-8444-444444444444',
  other = '55555555-5555-4555-8555-555555555555';
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
function fixture(options = {}) {
  const apiKey = randomBytes(24).toString('base64url'),
    calls = [];
  const rows = {
    project: {
      id: project,
      companyId: company,
      name: 'Real research project',
      status: 'in_progress',
      leadAgentId: agent,
      updatedAt: '2026-10-31T10:00:00Z',
      adapterConfig: { env: { privateValue: apiKey } },
    },
    agent: {
      id: agent,
      companyId: company,
      name: 'Assigned lead',
      title: 'Research manager',
      role: 'manager',
      status: 'idle',
      adapterConfig: { env: { privateValue: apiKey } },
    },
    issues: [
      {
        id: issue,
        companyId: company,
        projectId: project,
        identifier: 'R-1',
        title: 'Check source evidence',
        status: 'todo',
        priority: 'high',
        assigneeAgentId: agent,
        description: apiKey,
        updatedAt: '2026-10-31T10:00:00Z',
      },
    ],
    costs: [
      {
        projectId: project,
        costCentsExact: '12.3456789',
        costCents: 12.3456789,
        eventCount: 3,
        estimatedEventCount: 1,
      },
      {
        projectId: other,
        costCentsExact: '9999',
        costCents: 9999,
        eventCount: 9,
        estimatedEventCount: 0,
      },
    ],
  };
  const fetchImpl = async (url, input) => {
    calls.push({ url: new URL(url), input });
    assert.equal(input.method, 'GET');
    assert.equal(input.redirect, 'error');
    assert.equal(input.headers.Authorization, `Bearer ${apiKey}`);
    const path = new URL(url).pathname;
    if (path === `/api/projects/${project}`) return json(rows.project);
    if (path === `/api/agents/${agent}`) return json(rows.agent);
    if (path === `/api/companies/${company}/issues`) return json(rows.issues);
    if (path === `/api/companies/${company}/costs/by-project`)
      return json(rows.costs);
    throw Error('Unexpected Paperclip route');
  };
  const config = {
    origin,
    allowedOrigins: [origin],
    apiKey,
    allowedCompanyIds: [company],
    projectMap: {
      'native-research': { companyId: company, projectId: project },
    },
    fetchImpl,
    cacheMs: 0,
    ...options,
  };
  return {
    apiKey,
    calls,
    rows,
    config,
    bridge: createPaperclipReadBridge(config),
  };
}

test('missing runtime credentials or project mapping never call a provider or invent a manager', async () => {
  let calls = 0;
  const bridge = createPaperclipReadBridge({
    fetchImpl: async () => {
      calls++;
      throw Error('Must not call');
    },
  });
  const absent = await bridge.project('native-research');
  assert.equal(absent.status, 'not-configured');
  assert.equal(absent.project, null);
  assert.equal(absent.manager.agent, null);
  assert.equal(absent.tasks.items, null);
  assert.equal(absent.costs.costCentsExact, null);
  assert.equal(calls, 0);
  const f = fixture();
  const unmapped = await f.bridge.project('unknown-native');
  assert.equal(unmapped.status, 'unmapped');
  assert.equal(f.calls.length, 0);
});

test('configuration refuses credentialed, unallowlisted, private-IP and malformed origins or cross-company mappings', () => {
  const f = fixture();
  for (const candidate of [
    'http://paperclip.operator.example',
    'https://user:password@paperclip.operator.example',
    'https://paperclip.operator.example/path',
    'https://paperclip.operator.example?x=1',
    'https://paperclip.operator.example#fragment',
    'https://169.254.169.254',
    'https://evil.example',
    'http://127.0.0.1:3100',
  ])
    assert.throws(
      () => createPaperclipReadBridge({ ...f.config, origin: candidate }),
      (error) => error.code === 'invalid_paperclip_configuration',
    );
  assert.throws(
    () =>
      createPaperclipReadBridge({
        ...f.config,
        projectMap: {
          'native-research': { companyId: other, projectId: project },
        },
      }),
    (error) => error.code === 'invalid_paperclip_configuration',
  );
  assert.throws(
    () =>
      createPaperclipReadBridge({
        ...f.config,
        projectMap: { '../escape': { companyId: company, projectId: project } },
      }),
    (error) => error.code === 'invalid_paperclip_configuration',
  );
  assert.equal(
    createPaperclipReadBridge({
      ...f.config,
      origin: 'http://127.0.0.1:3100',
      allowedOrigins: ['http://127.0.0.1:3100'],
      allowLoopback: true,
    }).configured,
    true,
  );
});

test('read-only projections keep real source status, project lead and exact USD cost without leaking credentials or other projects', async () => {
  const f = fixture(),
    result = await f.bridge.project('native-research', {
      page: 1,
      pageSize: 10,
    });
  assert.equal(result.status, 'available');
  assert.equal(result.project.status, 'in_progress');
  assert.equal(result.manager.relationship, 'project_lead');
  assert.equal(result.manager.agent.id, agent);
  assert.equal(result.manager.agent.title, 'Research manager');
  assert.equal(result.tasks.items[0].id, issue);
  assert.equal(result.tasks.count, 1);
  assert.equal(result.costs.costCentsExact, '12.3456789');
  assert.equal(result.costs.currency, 'USD');
  assert.equal(result.capabilities.managerChat, false);
  assert.equal(JSON.stringify(result).includes(f.apiKey), false);
  assert.equal(JSON.stringify(result).includes('adapterConfig'), false);
  assert.equal(JSON.stringify(result).includes('9999'), false);
  assert.equal(f.calls.length, 4);
  const issues = f.calls.find((c) => c.url.pathname.endsWith('/issues'));
  assert.equal(issues.url.searchParams.get('projectId'), project);
  assert.equal(issues.url.searchParams.get('view'), 'index');
});

test('wrong-company or substituted source entities fail closed instead of crossing project scope', async () => {
  const f = fixture();
  f.rows.project.companyId = other;
  const foreign = await f.bridge.project('native-research');
  assert.equal(foreign.status, 'unavailable');
  assert.equal(foreign.project, null);
  assert.equal(f.calls.length, 1);
  const g = fixture();
  g.rows.agent.companyId = other;
  g.rows.issues[0].projectId = other;
  const scoped = await g.bridge.project('native-research');
  assert.equal(scoped.manager.status, 'unavailable');
  assert.equal(scoped.manager.agent, null);
  assert.equal(scoped.tasks.status, 'unavailable');
  assert.equal(scoped.tasks.items, null);
});

test('redirects, authentication errors and diagnostic bodies never leak or masquerade as an empty active project', async () => {
  for (const status of [302, 401, 403, 500]) {
    const f = fixture(),
      bridge = createPaperclipReadBridge({
        ...f.config,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: f.apiKey }), {
            status,
            headers: {
              Location: 'https://evil.example',
              'Content-Type': 'application/json',
            },
          }),
      });
    const result = await bridge.project('native-research');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.project, null);
    assert.equal(JSON.stringify(result).includes(f.apiKey), false);
  }
});

test('streaming bounds, malformed JSON and too many issue rows refuse unqualified projections', async () => {
  const f = fixture({ maxBytes: 1024 }),
    oversized = createPaperclipReadBridge({
      ...f.config,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('x'.repeat(2048)));
              c.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    });
  assert.equal(
    (await oversized.project('native-research')).status,
    'unavailable',
  );
  const malformed = createPaperclipReadBridge({
    ...f.config,
    fetchImpl: async () =>
      new Response('{broken', {
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  assert.equal(
    (await malformed.project('native-research')).status,
    'unavailable',
  );
  const many = fixture();
  many.rows.issues = Array.from({ length: 1001 }, () => many.rows.issues[0]);
  assert.equal(
    (await many.bridge.project('native-research')).tasks.status,
    'unavailable',
  );
});

test('missing cost rows are unknown and imprecise numeric costs are never promoted to exact money', async () => {
  const f = fixture();
  f.rows.costs = [];
  const absent = await f.bridge.project('native-research');
  assert.equal(absent.costs.status, 'not-reported');
  assert.equal(absent.costs.costCentsExact, null);
  const g = fixture();
  delete g.rows.costs[0].costCentsExact;
  const imprecise = await g.bridge.project('native-research');
  assert.equal(imprecise.costs.status, 'unavailable');
  assert.equal(imprecise.costs.costCentsExact, null);
  const h = fixture();
  h.rows.project.leadAgentId = null;
  const manager = await h.bridge.project('native-research');
  assert.equal(manager.manager.status, 'not-assigned');
  assert.equal(manager.manager.agent, null);
});

test('equal reads coalesce, cached projections are isolated, and expired success never hides a source failure', async () => {
  let now = 1000;
  const f = fixture({ cacheMs: 100, now: () => now });
  const first = await Promise.all([
    f.bridge.project('native-research'),
    f.bridge.project('native-research'),
  ]);
  assert.equal(f.calls.length, 4);
  first[0].project.name = 'Caller mutation';
  assert.equal(
    (await f.bridge.project('native-research')).project.name,
    'Real research project',
  );
  now = 1200;
  f.rows.project.companyId = other;
  const expired = await f.bridge.project('native-research');
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.project, null);
});

test('timeouts and concurrency overload are bounded and never launch mutation requests', async () => {
  const f = fixture(),
    bridge = createPaperclipReadBridge({
      ...f.config,
      projectMap: {
        ...f.config.projectMap,
        'second-native': { companyId: company, projectId: project },
      },
      timeoutMs: 30,
      maxConcurrent: 1,
      fetchImpl: async () => new Promise(() => {}),
    });
  const pending = bridge.project('native-research'),
    overload = await bridge.project('second-native');
  assert.equal(overload.status, 'unavailable');
  assert.equal(overload.reason, 'capacity');
  assert.equal((await pending).status, 'unavailable');
});

test('invalid query inputs and project IDs fail before making a source call', async () => {
  const f = fixture();
  for (const options of [
    { page: 0 },
    { pageSize: 101 },
    { status: 'hire' },
    { companyId: other },
  ])
    await assert.rejects(
      () => f.bridge.project('native-research', options),
      (error) => error.code === 'invalid_paperclip_query',
    );
  await assert.rejects(
    () => f.bridge.project('../escape'),
    (error) => error.code === 'invalid_paperclip_query',
  );
  assert.equal(f.calls.length, 0);
});

test('task pages preserve actual filtered count and never attach an issue from another source page', async () => {
  const f = fixture(),
    third = '66666666-6666-4666-8666-666666666666';
  f.rows.issues = [
    f.rows.issues[0],
    { ...f.rows.issues[0], id: other, status: 'done' },
    { ...f.rows.issues[0], id: third, title: 'Another actual task' },
  ];
  const selected = await f.bridge.project('native-research', {
    status: 'todo',
    page: 2,
    pageSize: 1,
  });
  assert.equal(selected.tasks.count, 2);
  assert.equal(selected.tasks.pages, 2);
  assert.equal(selected.tasks.items.length, 1);
  assert.equal(selected.tasks.items[0].id, third);
  assert.equal(
    f.calls
      .find((call) => call.url.pathname.endsWith('/issues'))
      .url.searchParams.get('status'),
    'todo',
  );
});

test('known server credentials are redacted even when a source places them in a whitelisted display field', async () => {
  const f = fixture();
  f.rows.project.name = 'Unexpected ' + f.apiKey;
  f.rows.agent.title = f.apiKey;
  const result = await f.bridge.project('native-research');
  assert.equal(result.status, 'available');
  assert.equal(JSON.stringify(result).includes(f.apiKey), false);
  assert.equal(result.manager.agent.title, '[redacted]');
});

const uuidOf = (n, digit) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${n.toString(16).padStart(12, '0')}`;
/** 120 organizations, each with its own company/project, served by one upstream. */
function registryFixture(options = {}) {
  const apiKey = randomBytes(24).toString('base64url'),
    calls = [],
    orgs = new Map();
  for (let n = 1; n <= 120; n++)
    orgs.set(`P-OPP-${String(n).padStart(5, '0')}`, {
      companyId: uuidOf(n, 'a'),
      projectId: uuidOf(n, 'b'),
    });
  const byProject = new Map(
    [...orgs.values()].map((o) => [o.projectId, o.companyId]),
  );
  const fetchImpl = async (url, input) => {
    calls.push({ url: new URL(url), input });
    assert.equal(input.method, 'GET');
    const path = new URL(url).pathname;
    let m = path.match(/^\/api\/projects\/([^/]+)$/);
    if (m && byProject.has(m[1]))
      return json({
        id: m[1],
        companyId: byProject.get(m[1]),
        name: `Project ${m[1]}`,
        status: 'backlog',
        leadAgentId: null,
      });
    m = path.match(/^\/api\/companies\/([^/]+)\/issues$/);
    if (m) return json([]);
    m = path.match(/^\/api\/companies\/([^/]+)\/costs\/by-project$/);
    if (m)
      return json(
        [...orgs.values()].map((o) => ({
          projectId: o.projectId,
          costCentsExact: o.companyId === m[1] ? '7' : '9999',
        })),
      );
    throw Error('Unexpected Paperclip route');
  };
  const lookups = [];
  const config = {
    origin,
    allowedOrigins: [origin],
    apiKey,
    registryLookup: (nativeId) => {
      lookups.push(nativeId);
      return orgs.get(nativeId) ?? null;
    },
    fetchImpl,
    cacheMs: 0,
    ...options,
  };
  return {
    apiKey,
    calls,
    lookups,
    orgs,
    config,
    bridge: createPaperclipReadBridge(config),
  };
}

test('an injected registry lookup serves all 120 organizations beyond the static map limits, each in its own scope', async () => {
  const f = registryFixture();
  assert.equal(f.bridge.configured, true);
  for (const [nativeId, scope] of f.orgs) {
    const before = f.calls.length;
    const result = await f.bridge.project(nativeId);
    assert.equal(result.status, 'available', nativeId);
    assert.equal(result.project.id, scope.projectId);
    assert.equal(result.source.companyId, scope.companyId);
    assert.equal(result.costs.costCentsExact, '7');
    assert.equal(result.manager.status, 'not-assigned');
    for (const call of f.calls.slice(before)) {
      const path = call.url.pathname;
      assert.ok(
        path === `/api/projects/${scope.projectId}` ||
          path.startsWith(`/api/companies/${scope.companyId}/`),
        path,
      );
      if (path.startsWith('/api/projects/'))
        assert.equal(call.url.searchParams.get('companyId'), scope.companyId);
    }
  }
  assert.equal(f.lookups.length, 120);
  assert.equal(JSON.stringify(f.calls).includes('POST'), false);
});

test('registry lookups that miss, fail, stall or return a malformed scope never reach the upstream', async () => {
  const f = registryFixture();
  const unmapped = await f.bridge.project('P-OPP-99999');
  assert.equal(unmapped.status, 'unmapped');
  assert.equal(unmapped.source.companyId, null);
  for (const registryLookup of [
    () => {
      throw Error('registry closed');
    },
    async () => new Promise(() => {}),
    () => ({ companyId: company, projectId: project, extra: 1 }),
    () => ({ companyId: 'not-a-uuid', projectId: project }),
    () => [company, project],
  ]) {
    const g = registryFixture({ registryLookup, timeoutMs: 30 });
    const result = await g.bridge.project('P-OPP-00001');
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'mapping_unavailable');
    assert.equal(result.source.companyId, null);
    assert.equal(g.calls.length, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('a registry scope whose upstream project belongs to another company fails closed', async () => {
  const f = registryFixture();
  const [first, second] = [...f.orgs.values()];
  const crossed = registryFixture({
    registryLookup: () => ({
      companyId: first.companyId,
      projectId: second.projectId,
    }),
  });
  const result = await crossed.bridge.project('P-OPP-00001');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.project, null);
  assert.equal(crossed.calls.length, 1);
});

test('registry mode cannot be mixed with the static map, and static limits are unchanged without it', () => {
  const f = registryFixture();
  for (const extra of [
    { allowedCompanyIds: [company] },
    {
      allowedCompanyIds: [company],
      projectMap: { 'P-OPP-00001': { companyId: company, projectId: project } },
    },
    { registryLookup: 'not-a-function' },
  ])
    assert.throws(
      () => createPaperclipReadBridge({ ...f.config, ...extra }),
      (error) => error.code === 'invalid_paperclip_configuration',
    );
  const s = fixture();
  assert.throws(
    () =>
      createPaperclipReadBridge({
        ...s.config,
        allowedCompanyIds: Array.from({ length: 11 }, (_, n) => uuidOf(n, 'c')),
      }),
    (error) => error.code === 'invalid_paperclip_configuration',
  );
  const unconfigured = createPaperclipReadBridge({
    registryLookup: () => ({ companyId: company, projectId: project }),
  });
  assert.equal(unconfigured.configured, false);
});

test('static-map results keep their mapped source scope on failure exactly as before', async () => {
  const f = fixture();
  f.rows.project.companyId = other;
  const result = await f.bridge.project('native-research');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.source.companyId, company);
  assert.equal(result.source.projectId, project);
});
