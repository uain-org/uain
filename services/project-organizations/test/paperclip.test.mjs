import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELECTION_PATH, validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import {
  CONTRACT_SCHEMA, PAPERCLIP_REPOSITORY, PINNED_PAPERCLIP_REVISION, createOrganizationAdapter, createPaperclipTransport,
  createRegistryLookup, validateContract,
} from '../src/paperclip.mjs';

const selection = validateSelection(JSON.parse(readFileSync(SELECTION_PATH, 'utf8')));
const origin = 'https://paperclip.operator.example';
const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uain-paperclip-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const [A, B] = selection.ids;
const MARK = (id, step) => `uain-external-key: uain:${id}:${step}`;

/** Sanitized fixture shaped like the qualifier's output for the pinned revision. */
function fixtureContract() {
  const ext = { field: 'description', format: 'trailing-line', property: null };
  const create = { externalKey: ext, idempotencyField: null, replaySafe: false, responseField: null };
  return {
    schema: CONTRACT_SCHEMA,
    upstream: { repository: PAPERCLIP_REPOSITORY, revision: PINNED_PAPERCLIP_REVISION },
    qualification: {
      status: 'qualified', method: 'source-checkout', revisionEvidence: 'git-head', qualifiedAt: '2026-11-06T00:00:00.000Z',
      evidenceDigest: 'a'.repeat(64), missing: [], sources: [],
    },
    capabilities: {
      'company.list': { method: 'GET', path: '/api/companies', pagination: { limitParam: 'limit', offsetParam: 'offset', maxLimit: 50 } },
      'company.get': { method: 'GET', path: '/api/companies/:companyId' },
      'company.create': {
        method: 'POST', path: '/api/companies', bodyFields: ['name', 'description', 'budgetMonthlyCents', 'defaultResponsibleUserId'],
        ...create, fixed: { budgetMonthlyCents: 0 },
      },
      'company.update': {
        method: 'PATCH', path: '/api/companies/:companyId', bodyFields: ['name', 'description', 'status', 'requireBoardApprovalForNewAgents'],
        gate: { requireBoardApprovalForNewAgents: true },
      },
      'goal.list': { method: 'GET', path: '/api/companies/:companyId/goals', pagination: null },
      'goal.get': { method: 'GET', path: '/api/goals/:goalId' },
      'goal.create': {
        method: 'POST', path: '/api/companies/:companyId/goals', bodyFields: ['title', 'description', 'level', 'status', 'parentId'],
        ...create, fixed: { level: 'company', status: 'active' },
      },
      'project.list': { method: 'GET', path: '/api/companies/:companyId/projects', pagination: null },
      'project.get': { method: 'GET', path: '/api/projects/:projectId' },
      'project.create': {
        method: 'POST', path: '/api/companies/:companyId/projects',
        bodyFields: ['name', 'description', 'status', 'visibility', 'goalId', 'goalIds', 'leadAgentId', 'idempotencyKey'],
        ...create, idempotencyField: 'idempotencyKey', replaySafe: true,
        fixed: { status: 'backlog', visibility: 'private', leadAgentId: null }, goalLink: 'goalIds',
      },
      'agent.list': { method: 'GET', path: '/api/companies/:companyId/agents', pagination: null },
      'agent.get': { method: 'GET', path: '/api/agents/:agentId' },
      'agent.hire': {
        method: 'POST', path: '/api/companies/:companyId/agent-hires',
        bodyFields: ['name', 'role', 'title', 'reportsTo', 'capabilities', 'metadata', 'adapterType', 'adapterConfig'],
        externalKey: { field: 'metadata', format: 'object-property', property: 'uainExternalKey' },
        idempotencyField: null, replaySafe: false, responseField: 'agent', fixed: {},
        roles: { ceo: 'ceo', manager: 'pm' }, hierarchyField: 'reportsTo', expect: { status: 'pending_approval' },
      },
      'issue.list': { method: 'GET', path: '/api/companies/:companyId/issues', pagination: null },
    },
  };
}

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const PLURAL = { goals: 'goal', projects: 'project', 'agent-hires': 'agent', issues: 'issue' };

/** In-memory Paperclip with the pinned revision's hire, approval-gate and project-idempotency behaviour. */
function fakePaperclip() {
  const operatorKey = randomBytes(24).toString('base64url'), viewerKey = randomBytes(24).toString('base64url');
  const db = { company: new Map(), goal: new Map(), project: new Map(), agent: new Map(), issue: new Map() };
  const receipts = new Map();
  const calls = [], hooks = [];
  const options = { endlessCompanies: false, ignoreGate: false };
  function route(method, url, body) {
    const path = url.pathname;
    const page = (rows) => {
      if (!url.searchParams.has('limit')) return rows;
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      if (options.endlessCompanies) return Array.from({ length: limit }, () => ({ id: randomUUID(), name: 'Other', description: '' }));
      return rows.slice(offset, offset + limit);
    };
    if (path === '/api/companies') {
      if (method === 'GET') return json(200, page([...db.company.values()]));
      const row = { id: randomUUID(), status: 'active', requireBoardApprovalForNewAgents: false, ...body };
      db.company.set(row.id, row);
      return json(201, row);
    }
    let m = path.match(/^\/api\/companies\/([^/]+)$/);
    if (m) {
      const row = db.company.get(m[1]);
      if (!row) return json(404, { error: 'not found' });
      if (method === 'PATCH') {
        if (!options.ignoreGate) Object.assign(row, body);
        return json(200, row);
      }
      return json(200, row);
    }
    m = path.match(/^\/api\/companies\/([^/]+)\/(goals|projects|agents|agent-hires|issues)$/);
    if (m) {
      const company = db.company.get(m[1]);
      if (!company) return json(404, { error: 'not found' });
      if (method === 'GET') {
        const kind = m[2] === 'agents' ? 'agent' : PLURAL[m[2]];
        return json(200, page([...db[kind].values()].filter((r) => r.companyId === m[1])));
      }
      if (m[2] === 'agents') return json(409, { error: 'direct agent creation is not used' });
      const kind = PLURAL[m[2]];
      if (kind === 'project' && body.idempotencyKey) {
        const receipt = `${m[1]}:${body.idempotencyKey}`, { idempotencyKey: _k, ...rest } = body;
        const prior = receipts.get(receipt);
        if (prior) return prior.fingerprint === JSON.stringify(rest) ? json(200, db.project.get(prior.id)) : json(409, { error: 'different inputs' });
        const row = { id: randomUUID(), ...rest, companyId: m[1] };
        db.project.set(row.id, row);
        receipts.set(receipt, { id: row.id, fingerprint: JSON.stringify(rest) });
        return json(201, row);
      }
      if (kind === 'agent') {
        const row = { id: randomUUID(), ...body, companyId: m[1], status: company.requireBoardApprovalForNewAgents ? 'pending_approval' : 'idle' };
        db.agent.set(row.id, row);
        return json(201, { agent: row, approval: company.requireBoardApprovalForNewAgents ? { id: randomUUID(), status: 'pending' } : null });
      }
      const row = { id: randomUUID(), status: 'active', ...body, companyId: m[1] };
      db[kind].set(row.id, row);
      return json(201, row);
    }
    m = path.match(/^\/api\/(goals|projects|agents)\/([^/]+)$/);
    if (m && method === 'GET') {
      const row = db[m[1] === 'agents' ? 'agent' : PLURAL[m[1]]].get(m[2]);
      return row ? json(200, row) : json(404, { error: 'not found' });
    }
    return json(404, { error: 'no route' });
  }
  async function fetchImpl(input, init) {
    const url = new URL(input), method = init.method, body = init.body ? JSON.parse(init.body) : undefined;
    assert.equal(init.redirect, 'error');
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const auth = init.headers.Authorization;
    if (auth !== `Bearer ${operatorKey}` && auth !== `Bearer ${viewerKey}`) return json(401, { error: 'unauthorized' });
    if (auth === `Bearer ${viewerKey}` && method !== 'GET') return json(403, { error: `viewer ${viewerKey} cannot write` });
    const i = hooks.findIndex((h) => h.method === method && h.match.test(url.pathname));
    if (i >= 0) return hooks.splice(i, 1)[0].action({ commit: () => route(method, url, body), body });
    return route(method, url, body);
  }
  const posts = () => calls.filter((c) => c.method !== 'GET');
  return { operatorKey, viewerKey, db, calls, hooks, options, fetchImpl, posts };
}

function harness({ server = fakePaperclip(), dir = tempDir(), key, contract = fixtureContract(), transportOptions = {}, adapterOptions = {} } = {}) {
  const registry = openRegistry({ directory: join(dir, 'registry'), selection });
  const journal = openJournal({ directory: join(dir, 'journal') });
  const transport = createPaperclipTransport({
    origin, apiKey: key ?? server.operatorKey, contract, fetchImpl: server.fetchImpl, timeoutMs: 60, ...transportOptions,
  });
  const adapter = createOrganizationAdapter({ transport, registry, journal, selection, contract, ...adapterOptions });
  const close = () => {
    registry.close();
    journal.close();
  };
  return { server, dir, registry, journal, transport, adapter, close };
}
const reopen = (h, extra = {}) => {
  h.close();
  return harness({ server: h.server, dir: h.dir, ...extra });
};
const keyIn = (body) => (body.description ?? '').split('\n').at(-1).match(/uain:(OPP-\d{5}):/)?.[1] ?? body.metadata?.uainExternalKey?.split(':')[1];

test('reconciles all 120 projects into distinct gated companies with goal, project and pending CEO/manager hires', async () => {
  const h = harness();
  for (const id of selection.ids) {
    const r = await h.adapter.reconcile(id);
    assert.equal(r.status, 'complete', `${id} ${JSON.stringify(r.hold)}`);
    assert.equal(r.agentRuns, null);
    assert.equal(r.wake, false);
    assert.equal(r.approvals, null);
  }
  const { db } = h.server;
  assert.equal(db.company.size, 120);
  assert.equal(db.goal.size, 120);
  assert.equal(db.project.size, 120);
  assert.equal(db.agent.size, 240);
  const companies = new Set();
  for (const id of selection.ids) {
    const p = selection.get(id), b = h.registry.get(id);
    companies.add(b.paperclipCompanyId);
    const company = db.company.get(b.paperclipCompanyId), goal = db.goal.get(b.paperclipGoalId), project = db.project.get(b.paperclipProjectId);
    const ceo = db.agent.get(b.ceoAgentId), manager = db.agent.get(b.managerAgentId);
    assert.equal(company.description.split('\n').at(-1), MARK(id, 'company'));
    assert.equal(company.requireBoardApprovalForNewAgents, true);
    assert.equal(company.budgetMonthlyCents, 0);
    assert.equal(goal.title, p.kpi.statement, 'Main KPI text is unchanged');
    assert.equal(goal.companyId, b.paperclipCompanyId);
    assert.deepEqual(project.goalIds, [b.paperclipGoalId]);
    assert.equal(project.visibility, 'private');
    assert.equal(ceo.role, 'ceo');
    assert.equal(ceo.reportsTo, null);
    assert.deepEqual(ceo.metadata, { uainExternalKey: `uain:${id}:ceo` });
    assert.equal(manager.role, 'pm');
    assert.equal(manager.reportsTo, b.ceoAgentId);
    for (const agent of [ceo, manager]) {
      assert.equal(agent.companyId, b.paperclipCompanyId);
      assert.equal(agent.status, 'pending_approval', 'hired leadership is not invokable');
    }
  }
  assert.equal(companies.size, 120);
  // Every write went to the project's own company and only through permitted routes.
  for (const c of h.server.posts()) {
    assert.match(c.path, /^\/api\/companies(?:\/[0-9a-f-]{36}(?:\/(?:goals|projects|agent-hires))?)?$/);
    if (c.method === 'PATCH') {
      assert.deepEqual(c.body, { requireBoardApprovalForNewAgents: true });
      continue;
    }
    const cid = c.path.split('/')[3];
    if (cid) assert.equal(cid, h.registry.get(keyIn(c.body)).paperclipCompanyId);
  }
  assert.equal(h.server.calls.some((c) => /wake|heartbeat|invoke|approve|approvals|resume|costs|keys|\/agents$/.test(c.path) && c.method !== 'GET'), false);
  // Every company is gated before its first hire.
  for (const id of selection.ids) {
    const cid = h.registry.get(id).paperclipCompanyId;
    const idx = (pred) => h.server.calls.findIndex(pred);
    assert.ok(idx((c) => c.method === 'PATCH' && c.path.endsWith(cid)) < idx((c) => c.path === `/api/companies/${cid}/agent-hires`));
  }
  assert.ok(h.server.calls.some((c) => c.path === '/api/companies' && c.query.offset === '100' && c.query.limit === '50'));
  const lookup = createRegistryLookup(h.registry);
  for (const id of selection.ids) {
    const b = h.registry.get(id);
    assert.deepEqual(lookup(selection.get(id).nativeProjectId), { companyId: b.paperclipCompanyId, projectId: b.paperclipProjectId });
  }
  assert.equal(lookup('OPP-99999'), null);
  h.close();
});

test('restart reconciles from bindings and readback without any duplicate provisioning', async () => {
  let h = harness();
  for (const id of [A, B]) assert.equal((await h.adapter.reconcile(id)).status, 'complete');
  const writes = h.server.posts().length;
  assert.equal(writes, 12);
  h = reopen(h);
  for (const id of [A, B]) {
    const r = await h.adapter.reconcile(id);
    assert.equal(r.status, 'complete');
    assert.equal(r.evidence.length, 6);
  }
  assert.equal(h.server.posts().length, writes);
  assert.equal(h.server.db.company.size, 2);
  h.close();
});

test('a claimed but never-sent intent resumes with the same payload; a changed payload is refused', async () => {
  const p = selection.get(A);
  const intent = (payload) => ({ id: `pc.${A}.company.1`, projectId: A, kind: 'paperclip', operation: 'paperclip.company.create', payload,
    selectionDigest: selection.digest, sourceDigest: p.sourceDigest, signer: `paperclip:${A}.company.1`, expectedRevision: 'paperclipCompanyId=null' });
  const h = harness();
  h.journal.prepare(intent({ x: 'stale' }));
  h.journal.claim(`pc.${A}.company.1`, 'dead-process');
  const r = await h.adapter.reconcile(A);
  assert.deepEqual(r.hold, { code: 'intent_payload_conflict', step: 'company' });
  assert.equal(h.server.posts().length, 0);
  h.close();
  const clean = harness();
  clean.journal.prepare(intent({ capability: 'company.create', method: 'POST', path: '/api/companies', params: {}, body: {
    budgetMonthlyCents: 0, name: `UAIN ${A}`,
    description: `Private UAIN project organization for ${A} (native ${p.nativeProjectId}). Organizational records only; no native authority, funding or payment.\n\n${MARK(A, 'company')}`,
  } }));
  clean.journal.claim(`pc.${A}.company.1`, 'dead-process');
  const resumed = await clean.adapter.reconcile(A);
  assert.equal(resumed.status, 'complete', JSON.stringify(resumed.hold));
  assert.equal(clean.server.db.company.size, 1);
  assert.equal(clean.journal.get(`pc.${A}.company.1`).state, 'confirmed');
  clean.close();
});

test('an ambiguous hire that committed is adopted by its metadata key on the next reconcile, never re-posted', async () => {
  const h = harness();
  h.server.hooks.push({ method: 'POST', match: /\/agent-hires$/, action: ({ commit }) => {
    commit();
    return json(502, { error: 'gateway' });
  } });
  const first = await h.adapter.reconcile(A);
  assert.deepEqual(first.hold, { code: 'paperclip_write_outcome_unknown', step: 'ceo' });
  assert.equal(h.journal.get(`pc.${A}.ceo.1`).state, 'unknown');
  assert.equal(h.registry.get(A).ceoAgentId, null);
  const hires = () => h.server.posts().filter((c) => c.path.endsWith('/agent-hires')).length;
  assert.equal(hires(), 1);
  assert.equal((await h.adapter.reconcile(A)).status, 'complete');
  assert.equal(hires(), 2, 'only the manager is hired after adopting the CEO');
  assert.equal(h.server.db.agent.size, 2);
  assert.equal(h.journal.get(`pc.${A}.ceo.1`).state, 'confirmed');
  h.close();
});

test('an ambiguous non-idempotent create that is not visible holds without a blind resend until the late commit appears', async () => {
  const h = harness();
  let late;
  h.server.hooks.push({ method: 'POST', match: /^\/api\/companies$/, action: ({ commit }) => {
    late = commit;
    return new Promise(() => {}); // timeout; the server commits later
  } });
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_write_outcome_unknown', step: 'company' });
  for (let i = 0; i < 3; i++) assert.equal((await h.adapter.reconcile(A)).hold.code, 'paperclip_write_outcome_unknown');
  assert.equal(h.server.posts().length, 1);
  assert.equal(h.server.db.company.size, 0);
  late();
  assert.equal((await h.adapter.reconcile(A)).status, 'complete');
  assert.equal(h.server.db.company.size, 1);
  assert.equal(h.server.posts().filter((c) => c.path === '/api/companies').length, 1);
  h.close();
});

test('an ambiguous project create is replayed with the same idempotency key and deduplicated by the server', async () => {
  const h = harness();
  // The first create commits but its response is lost, and the next list is stale.
  h.server.hooks.push({ method: 'POST', match: /\/projects$/, action: ({ commit }) => {
    commit();
    return new Promise(() => {});
  } });
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_write_outcome_unknown', step: 'project' });
  h.server.hooks.push({ method: 'GET', match: /\/projects$/, action: () => json(200, []) });
  const r = await h.adapter.reconcile(A);
  assert.equal(r.status, 'complete', JSON.stringify(r.hold));
  const projectPosts = h.server.posts().filter((c) => c.path.endsWith('/projects'));
  assert.equal(projectPosts.length, 2);
  assert.deepEqual(projectPosts[0].body, projectPosts[1].body, 'the replay is byte-identical');
  assert.equal(projectPosts[1].body.idempotencyKey, `uain:${A}:project`);
  assert.equal(h.server.db.project.size, 1);
  assert.equal(h.journal.get(`pc.${A}.project.1`).state, 'confirmed');
  assert.equal(h.journal.get(`pc.${A}.project.2`).state, 'confirmed');
  // A create that never committed is replayed and created exactly once.
  h.server.hooks.push({ method: 'POST', match: /\/projects$/, action: () => json(503, { error: 'busy' }) });
  assert.equal((await h.adapter.reconcile(B)).hold.code, 'paperclip_write_outcome_unknown');
  assert.equal((await h.adapter.reconcile(B)).status, 'complete');
  assert.equal(h.server.db.project.size, 2);
  h.close();
});

test('the approval gate is set and read back before any hire; an unapplied or reverted gate holds every hire', async () => {
  const ambiguous = harness();
  ambiguous.server.hooks.push({ method: 'PATCH', match: /^\/api\/companies\/[^/]+$/, action: () => json(500, { error: 'x' }) });
  assert.deepEqual((await ambiguous.adapter.reconcile(A)).hold, { code: 'paperclip_write_outcome_unknown', step: 'gate' });
  assert.equal(ambiguous.server.posts().filter((c) => c.path.endsWith('/agent-hires')).length, 0);
  assert.equal((await ambiguous.adapter.reconcile(A)).status, 'complete', 'an idempotent gate PATCH is superseded, not held');
  assert.equal(ambiguous.journal.get(`pc.${A}.gate.1`).state, 'confirmed');
  ambiguous.close();
  const ignored = harness();
  ignored.server.options.ignoreGate = true;
  assert.deepEqual((await ignored.adapter.reconcile(A)).hold, { code: 'paperclip_gate_not_applied', step: 'gate' });
  assert.equal(ignored.server.db.agent.size, 0);
  ignored.close();
  const reverted = harness();
  reverted.server.hooks.push({ method: 'POST', match: /\/agent-hires$/, action: ({ commit }) => {
    for (const c of reverted.server.db.company.values()) c.requireBoardApprovalForNewAgents = false;
    return commit();
  } });
  assert.deepEqual((await reverted.adapter.reconcile(A)).hold, { code: 'paperclip_agent_not_pending_approval', step: 'ceo' });
  assert.equal(reverted.registry.get(A).ceoAgentId, null);
  assert.equal(reverted.server.db.agent.size, 1);
  assert.equal((await reverted.adapter.reconcile(A)).hold.code, 'paperclip_agent_not_pending_approval');
  assert.equal(reverted.server.db.agent.size, 1, 'no manager is hired under an invokable CEO');
  reverted.close();
});

test('a same-name record without our external key is not ownership and holds before any write', async () => {
  const h = harness();
  const id = randomUUID();
  h.server.db.company.set(id, { id, name: `UAIN ${A}`, description: 'someone else', status: 'active' });
  const r = await h.adapter.reconcile(A);
  assert.deepEqual(r.hold, { code: 'paperclip_name_conflict', step: 'company' });
  assert.equal(h.server.posts().length, 0);
  assert.equal(h.registry.get(A).paperclipCompanyId, null);
  h.close();
});

test('conflicting bindings, unjournaled keys, duplicate keys and substituted create responses all hold without binding', async () => {
  const h = harness();
  const foreign = randomUUID();
  h.server.db.company.set(foreign, { id: foreign, name: 'Other', description: 'x', status: 'active' });
  h.registry.bind(A, { paperclipCompanyId: foreign });
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_binding_conflict', step: 'company' });
  assert.equal(h.server.posts().length, 0);
  const seeded = randomUUID();
  h.server.db.company.set(seeded, { id: seeded, name: `UAIN ${B}`, description: `x\n\n${MARK(B, 'company')}`, status: 'active' });
  assert.deepEqual((await h.adapter.reconcile(B)).hold, { code: 'paperclip_unjournaled_external_key', step: 'company' });
  const C = selection.ids[2], one = randomUUID(), two = randomUUID();
  for (const id of [one, two]) h.server.db.company.set(id, { id, name: `UAIN ${C}`, description: `x\n\n${MARK(C, 'company')}`, status: 'active' });
  assert.deepEqual((await h.adapter.reconcile(C)).hold, { code: 'paperclip_duplicate_external_key', step: 'company' });
  assert.equal(h.server.posts().length, 0);
  h.close();
  const s = harness();
  assert.equal((await s.adapter.reconcile(B)).status, 'complete');
  const bCompany = s.registry.get(B).paperclipCompanyId;
  s.server.hooks.push({ method: 'POST', match: /^\/api\/companies$/, action: () => json(201, { id: bCompany }) });
  assert.deepEqual((await s.adapter.reconcile(A)).hold, { code: 'paperclip_binding_conflict', step: 'company' });
  assert.equal(s.registry.get(A).paperclipCompanyId, null);
  assert.equal(s.journal.get(`pc.${A}.company.1`).state, 'unknown');
  s.close();
});

test('cross-company list rows and readbacks are refused; projectStatus reports mismatch rather than foreign data', async () => {
  const h = harness();
  assert.equal((await h.adapter.reconcile(B)).status, 'complete');
  h.server.hooks.push({ method: 'GET', match: /\/goals$/, action: () => json(200, [{ ...h.server.db.goal.get(h.registry.get(B).paperclipGoalId) }]) });
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_cross_company', step: 'goal' });
  assert.equal(h.server.posts().filter((c) => c.path.endsWith('/goals')).length, 1, 'only B\'s goal was ever posted');
  assert.equal((await h.adapter.reconcile(A)).status, 'complete');
  const a = h.registry.get(A), b = h.registry.get(B);
  h.server.db.agent.get(a.managerAgentId).companyId = b.paperclipCompanyId;
  const status = await h.adapter.projectStatus(A);
  assert.equal(status.organization.company.readback, 'verified');
  assert.equal(status.organization.manager.readback, 'mismatch');
  assert.equal(status.organization.manager.reason, 'paperclip_cross_company');
  assert.equal(status.organization.manager.status, null);
  assert.equal(status.hierarchy.managerReportsToCeo, null);
  await assert.rejects(h.transport.request('issue.create', { companyId: a.paperclipCompanyId }, { body: {} }), (e) => e.code === 'paperclip_route_not_permitted');
  await assert.rejects(h.transport.request('agent.get', { agentId: '../wakeup' }), (e) => e.code === 'paperclip_invalid_route');
  await assert.rejects(h.transport.request('goal.list', { companyId: a.paperclipCompanyId, projectId: a.paperclipProjectId }), (e) => e.code === 'paperclip_invalid_route');
  await assert.rejects(h.transport.request('company.list', {}, { query: { status: 1 } }), (e) => e.code === 'paperclip_invalid_route');
  await assert.rejects(h.transport.request('company.create', {}, { body: { name: 'x', adapterConfig: {} } }), (e) => e.code === 'paperclip_invalid_body');
  // Only managed fields are sendable, even when the validator accepts more.
  await assert.rejects(h.transport.request('company.update', { companyId: a.paperclipCompanyId }, { body: { status: 'archived' } }), (e) => e.code === 'paperclip_invalid_body');
  for (const extra of [{ adapterConfig: { command: 'x' } }, { adapterType: 'process' }])
    await assert.rejects(h.transport.request('agent.hire', { companyId: a.paperclipCompanyId }, { body: { name: 'x', ...extra } }), (e) => e.code === 'paperclip_invalid_body');
  h.close();
});

test('a Viewer credential is denied once, latches without a retry storm, and a later operator adapter continues safely', async () => {
  const server = fakePaperclip();
  let h = harness({ server, key: server.viewerKey });
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_access_denied', step: 'company' });
  assert.equal(server.posts().length, 1);
  const before = server.calls.length;
  for (const id of selection.ids.slice(1)) assert.equal((await h.adapter.reconcile(id)).hold.code, 'paperclip_access_denied');
  assert.equal(server.calls.length, before, 'no upstream calls after denial');
  assert.equal((await h.adapter.projectStatus(A)).organization.company.id, null);
  assert.equal(server.calls.length, before);
  assert.equal(h.journal.get(`pc.${A}.company.1`).state, 'failed');
  h = reopen(h);
  assert.equal((await h.adapter.reconcile(A)).status, 'complete');
  assert.equal(h.journal.get(`pc.${A}.company.2`).state, 'confirmed');
  assert.equal(server.db.company.size, 1);
  h.close();
});

test('credentials are redacted from transport errors and hold results', async () => {
  const server = fakePaperclip();
  const leak = harness({ server, transportOptions: { fetchImpl: async () => {
    throw Error(`connect failed for ${server.operatorKey}`);
  } } });
  const r = await leak.adapter.reconcile(A);
  assert.equal(r.hold.code, 'paperclip_unavailable');
  assert.equal(JSON.stringify(r).includes(server.operatorKey), false);
  leak.close();
  const echo = harness({ server, transportOptions: { fetchImpl: async () => json(500, { error: server.operatorKey }) } });
  await assert.rejects(echo.transport.request('company.list', {}), (e) => !e.message.includes(server.operatorKey) && !JSON.stringify(e).includes(server.operatorKey));
  echo.close();
  const viewer = harness({ server, key: server.viewerKey });
  await assert.rejects(viewer.transport.request('company.create', {}, { body: { name: 'x' } }),
    (e) => e.code === 'paperclip_access_denied' && e.status === 403 && !e.message.includes(server.viewerKey));
  viewer.close();
});

test('lookups are bounded: endless full pages hold instead of truncating or creating', async () => {
  const h = harness({ adapterOptions: { maxListPages: 3 } });
  h.server.options.endlessCompanies = true;
  assert.deepEqual((await h.adapter.reconcile(A)).hold, { code: 'paperclip_lookup_unbounded', step: 'company' });
  assert.equal(h.server.calls.length, 3);
  assert.equal(h.server.posts().length, 0);
  h.close();
});

test('projectStatus returns actual IDs, gate and readback evidence; unbound values stay null and no run or approval is claimed', async () => {
  const h = harness();
  const empty = await h.adapter.projectStatus(A);
  for (const entry of Object.values(empty.organization)) assert.deepEqual(entry, { id: null, status: null, readback: null, reason: null, evidence: null });
  assert.equal(empty.approvalGate, null);
  assert.equal(h.server.calls.length, 0);
  await h.adapter.reconcile(A);
  const s = await h.adapter.projectStatus(A);
  const b = h.registry.get(A);
  assert.equal(s.organization.ceo.id, b.ceoAgentId);
  assert.equal(s.organization.ceo.status, 'pending_approval');
  assert.equal(s.approvalGate, true);
  assert.equal(s.organization.company.evidence.revision, PINNED_PAPERCLIP_REVISION);
  assert.match(s.organization.project.evidence.recordDigest, /^[a-f0-9]{64}$/);
  assert.equal(s.hierarchy.managerReportsToCeo, true);
  assert.equal(s.agentRuns, null);
  assert.equal(s.approvals, null);
  assert.equal(s.wake, false);
  assert.equal(s.intents.length, 6);
  assert.ok(s.intents.every((i) => i.state === 'confirmed'));
  assert.equal(h.server.posts().length, 6);
  await assert.rejects(h.adapter.projectStatus('OPP-99999'), (e) => e.code === 'project_not_selected');
  h.close();
});

test('overlapping reconcilers for the same project do not both provision', async () => {
  const h = harness();
  const other = createOrganizationAdapter({ transport: h.transport, registry: h.registry, journal: h.journal, selection, contract: fixtureContract() });
  const [x, y] = await Promise.all([h.adapter.reconcile(A), other.reconcile(A)]);
  assert.deepEqual([x.status, y.status].sort((a, b) => a.localeCompare(b)), ['complete', 'held']);
  assert.equal([x, y].find((r) => r.status === 'held').hold.code, 'paperclip_reconcile_busy');
  assert.equal(h.server.db.company.size, 1);
  h.close();
});

test('missing, unqualified, unpinned or unsafe contracts are refused before any request', () => {
  const server = fakePaperclip();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Error('must not call');
  };
  const dir = tempDir();
  const registry = openRegistry({ directory: join(dir, 'r'), selection }), journal = openJournal({ directory: join(dir, 'j') });
  const build = (contract) => createOrganizationAdapter({
    transport: createPaperclipTransport({ origin, apiKey: server.operatorKey, contract, fetchImpl }), registry, journal, selection, contract,
  });
  refuses(() => build(undefined), 'paperclip_capability_unqualified');
  const variants = {
    unqualified: (c) => Object.assign(c.qualification, { status: 'unqualified', missing: ['agent.hire'] }),
    missingHire: (c) => delete c.capabilities['agent.hire'],
    missingGate: (c) => delete c.capabilities['company.update'],
    emptyGate: (c) => (c.capabilities['company.update'].gate = {}),
    gateNotAccepted: (c) => (c.capabilities['company.update'].gate = { spentMonthlyCents: 0 }),
    invokableHire: (c) => (c.capabilities['agent.hire'].expect = { status: 'idle' }),
    noReportingLine: (c) => (c.capabilities['agent.hire'].hierarchyField = 'managerId'),
    replayWithoutKey: (c) => (c.capabilities['goal.create'].replaySafe = true),
    wakeRoute: (c) => (c.capabilities['agent.get'].path = '/api/agents/:agentId/wakeup'),
    approveRoute: (c) => (c.capabilities['agent.hire'].path = '/api/companies/:companyId/approvals'),
    signingRoute: (c) => (c.capabilities['company.get'].path = '/api/custody/:companyId'),
    unscopedWrite: (c) => (c.capabilities['goal.create'].path = '/api/goals'),
    wrongMethod: (c) => (c.capabilities['company.update'].method = 'POST'),
    keyIsName: (c) => (c.capabilities['company.create'].externalKey.field = 'name'),
    unacceptedConstant: (c) => (c.capabilities['company.create'].fixed = { adapterConfig: 'x' }),
  };
  for (const [label, mutate] of Object.entries(variants)) {
    const c = fixtureContract();
    mutate(c);
    assert.throws(() => build(c), (e) => e.code === 'paperclip_capability_unqualified', label);
  }
  for (const extra of ['agent.create', 'agent.wake', 'agent.approve']) {
    const unknown = fixtureContract();
    unknown.capabilities[extra] = { method: 'POST', path: '/api/companies/:companyId/agents' };
    refuses(() => build(unknown), 'paperclip_capability_unknown');
  }
  const unpinned = fixtureContract();
  unpinned.upstream.revision = 'b'.repeat(40);
  refuses(() => build(unpinned), 'paperclip_revision_unpinned');
  const other = fixtureContract();
  delete other.capabilities['issue.list'];
  refuses(() => createOrganizationAdapter({
    transport: createPaperclipTransport({ origin, apiKey: server.operatorKey, contract: fixtureContract(), fetchImpl }),
    registry, journal, selection, contract: other,
  }), 'paperclip_contract_mismatch');
  assert.equal(validateContract(fixtureContract()).revision, PINNED_PAPERCLIP_REVISION);
  assert.equal(calls, 0);
  registry.close();
  journal.close();
});

test('the transport origin is fixed and private and cannot be a native or custody endpoint', () => {
  const contract = fixtureContract(), apiKey = randomBytes(24).toString('base64url');
  for (const bad of ['http://paperclip.operator.example', 'https://u:p@paperclip.operator.example', 'https://paperclip.operator.example/api',
    'https://10.0.0.5', 'http://127.0.0.1:3100', 'https://localhost'])
    refuses(() => createPaperclipTransport({ origin: bad, apiKey, contract }), 'invalid_paperclip_origin');
  assert.equal(createPaperclipTransport({ origin: 'http://127.0.0.1:3100', apiKey, contract, allowLoopback: true }).origin, 'http://127.0.0.1:3100');
  refuses(() => createPaperclipTransport({ origin, apiKey, contract, forbiddenOrigins: [origin + '/'] }), 'paperclip_origin_forbidden');
  refuses(() => createPaperclipTransport({ origin, apiKey: 'short', contract }), 'invalid_paperclip_transport');
});
