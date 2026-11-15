import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPilotQualifier } from './qualify-read.mjs';
import { REVISION, PilotError } from './pilot.mjs';
const company = '10000000-0000-4000-8000-000000000001';
const project = '20000000-0000-4000-8000-000000000002';
const deniedCompany = '30000000-0000-4000-8000-000000000003';
const deniedProject = '40000000-0000-4000-8000-000000000004';
const viewer = 'dedicated-viewer';
const manifest = JSON.parse(
  readFileSync(new URL('./runtime-manifest.json', import.meta.url)),
);
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const config = () => ({
  manifest,
  companyId: company,
  projectId: project,
  nativeProjectId: 'pilot-unmapped',
  expectedViewerUserId: viewer,
  deniedCompanyId: deniedCompany,
  deniedProjectId: deniedProject,
  apiKey: 'pcp_board_' + randomBytes(24).toString('hex'),
  timeoutMs: 1000,
});
function fixture(overrides = {}) {
  const seen = [];
  const me = {
    source: 'board_key',
    userId: viewer,
    isInstanceAdmin: false,
    keyId: '50000000-0000-4000-8000-000000000005',
    companyIds: [company],
    memberships: [
      { companyId: company, membershipRole: 'viewer', status: 'active' },
    ],
  };
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    seen.push({
      path: u.pathname,
      search: u.search,
      method: options.method,
      redirect: options.redirect,
    });
    assert.equal(options.method, 'GET');
    assert.equal(u.origin, manifest.origin);
    assert.equal(options.redirect, 'error');
    if (overrides[u.pathname]) return overrides[u.pathname](url, options);
    if (u.pathname === '/api/health')
      return response({
        status: 'ok',
        deploymentMode: 'authenticated',
        deploymentExposure: 'private',
        authReady: true,
        bootstrapStatus: 'ready',
        commit: REVISION,
      });
    if (u.pathname === '/api/cli-auth/me') return response(me);
    if (u.pathname === `/api/companies/${company}`)
      return options.headers.Authorization
        ? response({ id: company, name: 'Private research pilot' })
        : response({ error: 'unauthorized' }, 401);
    if (u.pathname === `/api/projects/${project}`)
      return response({
        id: project,
        companyId: company,
        name: 'Inactive pilot',
        description: 'Source target',
        visibility: 'private',
        status: 'backlog',
        leadAgentId: null,
      });
    if (u.pathname === `/api/companies/${company}/agents`) return response([]);
    if (u.pathname === `/api/companies/${company}/routines`)
      return response([]);
    if (u.pathname === `/api/companies/${company}/issues`) return response([]);
    if (u.pathname === `/api/companies/${company}/costs/by-project`)
      return response([]);
    return response({ error: 'denied' }, 403);
  };
  return { fetchImpl, seen, me };
}

test('qualified zero-agent private control plane uses only fixed GETs and retains native ownership as unverified', async () => {
  const f = fixture(),
    c = config();
  const q = createPilotQualifier({ ...c, fetchImpl: f.fetchImpl });
  const out = await q.qualify();
  assert.equal(out.status, 'qualified-read-only');
  assert.equal(out.executionEnabled, false);
  assert.equal(out.nativeAuthority, 'unverified');
  assert.equal(out.operations.tasks.count, 0);
  assert.equal(out.operations.costs.status, 'not-reported');
  assert.equal(out.operations.manager.status, 'not-assigned');
  assert.equal(JSON.stringify(out).includes(c.apiKey), false);
  assert.equal(JSON.stringify(out).includes(viewer), false);
  assert.ok(
    f.seen.every((r) => r.method === 'GET' && !r.search.includes('token')),
  );
  const issues = f.seen.find(
    (r) => r.path === `/api/companies/${company}/issues`,
  );
  assert.equal(new URLSearchParams(issues.search).get('projectId'), project);
  assert.equal(new URLSearchParams(issues.search).get('view'), 'index');
});

test('admin/broad/wrong user/role credentials fail before private company reads', async () => {
  for (const change of [
    { isInstanceAdmin: true },
    { source: 'session' },
    { userId: 'release-qa' },
    { companyIds: [company, deniedCompany] },
    {
      memberships: [
        { companyId: company, membershipRole: 'operator', status: 'active' },
      ],
    },
  ]) {
    const f = fixture();
    Object.assign(f.me, change);
    const out = await createPilotQualifier({
      ...config(),
      fetchImpl: f.fetchImpl,
    }).qualify();
    assert.equal(out.status, 'unavailable');
    assert.equal(
      f.seen.some((x) => x.path === `/api/companies/${company}`),
      false,
    );
  }
});

test('unconfigured credentials perform zero reads; malicious origins and substituted mappings fail configuration', async () => {
  const f = fixture();
  assert.equal(
    (await createPilotQualifier({ manifest, fetchImpl: f.fetchImpl }).qualify())
      .status,
    'not-configured',
  );
  assert.equal(f.seen.length, 0);
  for (const patch of [
    { manifest: { ...manifest, origin: 'https://evil.invalid' } },
    { companyId: '../escape' },
    { deniedCompanyId: company },
    { expectedViewerUserId: 'a\nAuthorization: secret' },
  ])
    assert.throws(
      () => createPilotQualifier({ ...config(), ...patch }),
      PilotError,
    );
});

test('wrong revision, private ACL failure, enabled agents/routines, and cross-tenant visibility cannot qualify', async () => {
  for (const overrides of [
    {
      '/api/health': () =>
        response({
          status: 'ok',
          deploymentMode: 'authenticated',
          deploymentExposure: 'private',
          authReady: true,
          bootstrapStatus: 'ready',
          commit: 'a'.repeat(40),
        }),
    },
    { [`/api/projects/${project}`]: () => response({ error: 'private' }, 404) },
    {
      [`/api/companies/${company}/agents`]: () =>
        response([{ id: project, status: 'paused' }]),
    },
    {
      [`/api/companies/${company}/routines`]: () =>
        response([{ status: 'paused' }]),
    },
    {
      [`/api/companies/${deniedCompany}`]: () =>
        response({ id: deniedCompany }),
    },
    { [`/api/companies/${company}/members`]: () => response({ members: [] }) },
    {
      [`/api/projects/${project}`]: () =>
        response({
          id: project,
          companyId: company,
          name: 'public',
          visibility: 'open',
          status: 'backlog',
        }),
    },
  ])
    assert.equal(
      (
        await createPilotQualifier({
          ...config(),
          ...fixture(overrides),
        }).qualify()
      ).status,
      'unavailable',
    );
});

test('redirects, secret error bodies and oversized/invalid responses are redacted', async () => {
  for (const bad of [
    new Response('', {
      status: 302,
      headers: { location: 'https://evil.invalid' },
    }),
    response({ error: 'secret-from-upstream' }, 401),
    new Response('x'.repeat(4097), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('not-json', {
      headers: { 'content-type': 'application/json' },
    }),
  ]) {
    const f = fixture({ '/api/health': () => bad });
    const out = await createPilotQualifier({
      ...config(),
      fetchImpl: f.fetchImpl,
      maxBytes: 4096,
    }).qualify();
    assert.equal(out.status, 'unavailable');
    assert.equal(JSON.stringify(out).includes('secret-from-upstream'), false);
    assert.equal(f.seen.length, 1);
  }
});

test('deadline returns promptly but retains admission slot until ignored-abort upstream settles', async () => {
  let release;
  let calls = 0;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  const q = createPilotQualifier({
    ...config(),
    timeoutMs: 15,
    fetchImpl: async () => {
      calls++;
      await hung;
      return response({});
    },
  });
  const a = await q.qualify();
  const b = await q.qualify();
  assert.equal(a.status, 'unavailable');
  assert.equal(b.status, 'unavailable');
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await q.qualify();
  assert.equal(calls, 2);
});

test('rejected response headers cancel their stream without reading diagnostic content', async () => {
  for (const headers of [
    { 'content-type': 'text/html' },
    { 'content-type': 'application/json', 'content-length': '9999999' },
  ]) {
    let cancelled = 0;
    const body = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    const f = fixture({ '/api/health': () => new Response(body, { headers }) });
    assert.equal(
      (
        await createPilotQualifier({
          ...config(),
          fetchImpl: f.fetchImpl,
        }).qualify()
      ).status,
      'unavailable',
    );
    assert.equal(cancelled, 1);
  }
});

test('late bridge cost read also retains the actual upstream slot after caller deadline', async () => {
  let release,
    calls = 0;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture({
    [`/api/companies/${company}/costs/by-project`]: async () => {
      calls++;
      await hung;
      return response([]);
    },
  });
  const q = createPilotQualifier({
    ...config(),
    timeoutMs: 30,
    fetchImpl: f.fetchImpl,
  });
  assert.equal((await q.qualify()).status, 'unavailable');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await q.qualify()).status, 'unavailable');
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('nonexistent denied references establish nondisclosure probes, not tenant or private ACL isolation', async () => {
  const f = fixture({
    [`/api/companies/${deniedCompany}`]: () =>
      response({ error: 'missing' }, 404),
    [`/api/projects/${deniedProject}`]: () =>
      response({ error: 'missing' }, 404),
  });
  const out = await createPilotQualifier({
    ...config(),
    fetchImpl: f.fetchImpl,
  }).qualify();
  assert.equal(out.status, 'qualified-read-only');
  assert.equal(out.evidence.crossCompanyProbeDenied, true);
  assert.equal(out.evidence.crossProjectProbeDenied, true);
  assert.equal(out.evidence.crossTenantIsolationVerified, false);
  assert.equal(out.evidence.privateAclIsolationVerified, false);
  assert.equal(out.evidence.explicitGrantInventoryVerified, false);
  assert.equal(out.evidence.permissionAdministrationProbeDenied, true);
  assert.equal(
    Object.hasOwn(out.evidence, 'permissionAdministrationDenied'),
    false,
  );
  assert.equal(Object.hasOwn(out.evidence, 'crossCompanyDenied'), false);
  assert.equal(Object.hasOwn(out.evidence, 'crossProjectDenied'), false);
});
