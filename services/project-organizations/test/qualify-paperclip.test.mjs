import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTURE_SCHEMA, mountPrefixes, qualifyPaperclip, schemaFields } from '../ops/qualify-paperclip.mjs';
import { PINNED_PAPERCLIP_REVISION, createOrganizationAdapter, createPaperclipTransport, validateContract } from '../src/paperclip.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ops', 'qualify-paperclip.mjs');
const REV = PINNED_PAPERCLIP_REVISION;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

// Any network use by the qualifier fails loudly.
let fetches = 0;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => {
    fetches++;
    throw Error('qualifier must not use the network');
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

/** A tiny tree shaped like the pinned revision: prefix mounts, spreads, omit/extend chains. */
const APP = `import { companyRoutes } from "./routes/companies.js";
import { agentRoutes } from "./routes/agents.js";
import { goalRoutes } from "./routes/goals.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { secretRoutes } from "./routes/secrets.js";
  app.use("/api", apiCompression());
  api.use("/companies", companyRoutes(db, storage));
  api.use(
    agentRoutes(db, { deploymentMode }),
  );
  api.use(goalRoutes(db));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, storage, {}));
`;
const HIRE = `  const handleAgentHire = async (req, res) => {
      const requiresApproval = company.requireBoardApprovalForNewAgents;
      const status = requiresApproval ? "pending_approval" : "idle";
      return { status: 201, body: { agent: { ...agent }, approval } };
  };
`;
const ROUTES = {
  'companies.ts': `router.get("/", list);\nrouter.get("/:companyId", get);\nrouter.post("/", create);\nrouter.patch("/:companyId", update);\nrouter.post("/:companyId/archive", archive);\n`,
  'goals.ts': `router.get("/companies/:companyId/goals", list);\nrouter.get("/goals/:id", get);\nrouter.post("/companies/:companyId/goals", create);\n`,
  'projects.ts': `router.get("/companies/:companyId/projects", list);\nrouter.get("/projects/:id", get);\nrouter.post(\n  "/companies/:companyId/projects", create);\n// idempotencyKey fingerprint: throw conflict("Project idempotency key was used with different inputs")\n`,
  'agents.ts': `router.get("/companies/:companyId/agents", list);\nrouter.get("/agents/:id", get);\nrouter.post("/companies/:companyId/agent-hires", hire);\nrouter.post("/companies/:companyId/agents", create);\nrouter.post("/agents/:id/approve", approve);\nrouter.post("/agents/:id/wakeup", wake);\nrouter.post("/agents/:id/heartbeat/invoke", invoke);\n${HIRE}`,
  'issues.ts': `router.get("/companies/:companyId/issues", list);\nrouter.post("/companies/:companyId/issues", create);\n`,
  'secrets.ts': `router.get("/companies/:companyId/goals", leak);\n`,
  'unmounted.ts': `router.get("/companies/:companyId/projects", shadow);\n`,
};
const VALIDATORS = {
  'company.ts': `export const createCompanySchema = z.object({\n  name: z.string().min(1),\n  description: z.string().optional().nullable(),\n  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),\n});\n\nexport const updateCompanySchema = objectWithoutDefaults(\n  createCompanySchema\n    .partial()\n    .extend({\n      status: z.enum(COMPANY_STATUSES).optional(),\n      requireBoardApprovalForNewAgents: z.boolean().optional(),\n    }),\n);\n`,
  'goal.ts': `export const createGoalSchema = z.object({\n  title: z.string(),\n  description: z.string().optional(),\n  level: z.enum(GOAL_LEVELS).optional(),\n  status: z.enum(GOAL_STATUSES).optional(),\n  parentId: z.string().uuid().optional().nullable(),\n});\n`,
  'project.ts': `const projectFields = {\n  /** @deprecated Use goalIds instead */\n  goalId: z.string().guid().optional().nullable(),\n  goalIds: z.array(z.string().guid()).optional(),\n  name: z.string().min(1),\n  description: z.string().optional().nullable(),\n  visibility: z.enum(["open", "private"]).optional().default("open"),\n  status: z.enum(PROJECT_STATUSES).optional(),\n  leadAgentId: z.string().guid().nullable().optional(),\n};\n\nexport const createProjectSchema = z.object({\n  idempotencyKey: z.string().trim().min(1).max(255).optional(),\n  ...projectFields,\n  // comment: notAField: x\n  repositoryIds: z.array(z.string().regex(/^\\d+$/)).optional(),\n});\n`,
  'agent.ts': `export const createAgentSchema = z.object({\n  setupId: z.string().guid().optional(),\n  name: z.string(),\n  role: z.enum(AGENT_ROLES),\n  title: z.string().optional(),\n  reportsTo: z.string().uuid().nullable().optional(),\n  capabilities: z.string().optional(),\n  adapterConfig: z.record(z.object({ nested: z.string() })).optional(),\n  metadata: z.record(z.string(), z.unknown()).optional().nullable(),\n});\n\nexport const createAgentHireSchema = createAgentSchema.omit({ setupId: true }).extend({\n  sourceIssueId: z.string().guid().optional().nullable(),\n});\n`,
  'issue.ts': `export const createIssueSchema = z.object({\n  title: z.string(),\n  description: z.string().optional(),\n  idempotencyKey: z.string().optional(),\n});\n`,
};
const CONSTANTS = `export const AGENT_ROLES = ["ceo", "cto", "pm", "engineer"] as const;
export const AGENT_STATUSES = ["active", "paused", "idle", "pending_approval"] as const;
export const GOAL_LEVELS = ["company", "team", "task"] as const;
export const GOAL_STATUSES = ["planned", "active"] as const;
export const PROJECT_STATUSES = ["backlog", "planned"] as const;
`;

function tree({ omit = [], replace = {}, head = REV } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'uain-paperclip-src-'));
  dirs.push(root);
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  write('server/src/app.ts', replace['app.ts'] ?? APP);
  for (const [n, body] of Object.entries(ROUTES)) if (!omit.includes(n)) write(`server/src/routes/${n}`, replace[n] ?? body);
  for (const [n, body] of Object.entries(VALIDATORS)) write(`packages/shared/src/validators/${n}`, replace[n] ?? body);
  write('packages/shared/src/constants.ts', replace['constants.ts'] ?? CONSTANTS);
  if (head) write('.git/HEAD', head + '\n');
  return root;
}

test('schema scanning resolves spreads, omit/extend chains and wrapper calls', () => {
  assert.deepEqual(schemaFields(VALIDATORS['project.ts'], 'createProjectSchema').sort(),
    ['description', 'goalId', 'goalIds', 'idempotencyKey', 'leadAgentId', 'name', 'repositoryIds', 'status', 'visibility']);
  assert.deepEqual(schemaFields(VALIDATORS['agent.ts'], 'createAgentHireSchema').sort(),
    ['adapterConfig', 'capabilities', 'metadata', 'name', 'reportsTo', 'role', 'sourceIssueId', 'title']);
  assert.deepEqual(schemaFields(VALIDATORS['company.ts'], 'updateCompanySchema').sort(),
    ['budgetMonthlyCents', 'description', 'name', 'requireBoardApprovalForNewAgents', 'status']);
  assert.equal(schemaFields('export const x = 1;', 'createProjectSchema'), null);
  const mounts = mountPrefixes(APP);
  assert.deepEqual([...mounts.get('companies')], ['/api/companies']);
  assert.deepEqual([...mounts.get('agents')], ['/api']);
  assert.equal(mounts.has('secrets'), false, 'imported but never mounted');
});

test('a pinned source checkout yields a qualified contract with only mounted, permitted routes', () => {
  const contract = qualifyPaperclip({ sourceDir: tree(), revision: REV });
  assert.equal(contract.qualification.status, 'qualified', JSON.stringify(contract.qualification.missing));
  assert.equal(contract.qualification.revisionEvidence, 'git-head');
  assert.equal(validateContract(contract).revision, REV);
  const caps = contract.capabilities;
  assert.equal(caps['company.list'].path, '/api/companies');
  assert.equal(caps['company.get'].path, '/api/companies/:companyId');
  assert.deepEqual(caps['company.update'].gate, { requireBoardApprovalForNewAgents: true });
  assert.equal(caps['agent.get'].path, '/api/agents/:agentId');
  assert.equal(caps['agent.hire'].path, '/api/companies/:companyId/agent-hires');
  assert.deepEqual(caps['agent.hire'].externalKey, { field: 'metadata', format: 'object-property', property: 'uainExternalKey' });
  assert.deepEqual(caps['agent.hire'].expect, { status: 'pending_approval' });
  assert.equal(caps['agent.hire'].responseField, 'agent');
  assert.equal(caps['agent.hire'].bodyFields.includes('setupId'), false);
  assert.equal(caps['project.create'].goalLink, 'goalIds');
  assert.equal(caps['project.create'].idempotencyField, 'idempotencyKey');
  assert.equal(caps['project.create'].replaySafe, true);
  assert.equal(caps['company.create'].replaySafe, false);
  assert.equal(caps['issue.get'], undefined, 'absent upstream route is not emitted');
  assert.equal(Object.hasOwn(caps, 'agent.create'), false, 'direct agent creation is never a capability');
  const text = JSON.stringify(contract);
  for (const word of ['wakeup', 'heartbeat', 'invoke', 'approve', 'archive', 'notAField']) assert.equal(text.includes(word), false, word);
  assert.ok(contract.qualification.sources.some((s) => s.path === 'server/src/app.ts'));
  assert.equal(contract.qualification.sources.some((s) => /secrets|unmounted/.test(s.path)), false);
  assert.equal(fetches, 0);
});

test('missing routes or unsupported semantics produce an unqualified report the adapter refuses before any write', () => {
  const noHire = qualifyPaperclip({ sourceDir: tree({ replace: { 'agents.ts': ROUTES['agents.ts'].replace('router.post("/companies/:companyId/agent-hires", hire);\n', '') } }), revision: REV });
  assert.ok(noHire.qualification.missing.includes('agent.hire: route POST /api/companies/:companyId/agent-hires not present'));
  const idleHire = qualifyPaperclip({ sourceDir: tree({ replace: { 'agents.ts': ROUTES['agents.ts'].replace('"pending_approval" : "idle"', '"idle" : "idle"') } }), revision: REV });
  assert.deepEqual(idleHire.qualification.missing, ['agent.hire: pending-approval hire behaviour not found in route source']);
  const noGate = qualifyPaperclip({
    sourceDir: tree({ replace: { 'company.ts': VALIDATORS['company.ts'].replace('      requireBoardApprovalForNewAgents: z.boolean().optional(),\n', '') } }), revision: REV,
  });
  assert.deepEqual(noGate.qualification.missing, ['company.update: gate field requireBoardApprovalForNewAgents not accepted']);
  const noHierarchy = qualifyPaperclip({
    sourceDir: tree({ replace: { 'agent.ts': VALIDATORS['agent.ts'].replace('  reportsTo: z.string().uuid().nullable().optional(),\n', '') } }), revision: REV,
  });
  assert.deepEqual(noHierarchy.qualification.missing, ['agent.hire: reporting line field reportsTo not accepted']);
  const noPending = qualifyPaperclip({ sourceDir: tree({ replace: { 'constants.ts': CONSTANTS.replace(', "pending_approval"', '') } }), revision: REV });
  assert.deepEqual(noPending.qualification.missing, ['agent.hire: status value pending_approval not in AGENT_STATUSES']);
  const noRole = qualifyPaperclip({ sourceDir: tree(), revision: REV, semantics: { 'agent.hire': { roles: { ceo: 'ceo', manager: 'manager' } } } });
  assert.deepEqual(noRole.qualification.missing, ['agent.hire: role value manager not in AGENT_ROLES']);
  const unmountedCompanies = qualifyPaperclip({ sourceDir: tree({ replace: { 'app.ts': APP.replace('api.use("/companies", companyRoutes(db, storage));', '') } }), revision: REV });
  assert.ok(unmountedCompanies.qualification.missing.includes('company.list: route GET /api/companies not present'));
  const noReplay = qualifyPaperclip({ sourceDir: tree({ replace: { 'projects.ts': ROUTES['projects.ts'].split('\n// ')[0] } }), revision: REV });
  assert.equal(noReplay.qualification.status, 'qualified');
  assert.equal(noReplay.capabilities['project.create'].replaySafe, false, 'replay is safe only with server deduplication evidence');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Error('must not call');
  };
  for (const contract of [noHire, idleHire, noGate, noHierarchy, noPending])
    assert.throws(() => createOrganizationAdapter({
      transport: createPaperclipTransport({ origin: 'https://paperclip.operator.example', apiKey: 'k'.repeat(32), contract, fetchImpl }),
      registry: {}, journal: {}, selection: {}, contract,
    }), (e) => e.code === 'paperclip_capability_unqualified');
  assert.equal(calls, 0);
});

test('unknown capabilities, fixed safety evidence, mismatched revisions and unsafe trees are refused', () => {
  refuses(() => qualifyPaperclip({ sourceDir: tree(), revision: REV, semantics: { 'agent.create': {} } }), 'paperclip_capability_unknown');
  refuses(() => qualifyPaperclip({ sourceDir: tree(), revision: REV, semantics: { 'agent.hire': { requiredEvidence: [] } } }), 'paperclip_semantics_invalid');
  refuses(() => qualifyPaperclip({ sourceDir: tree(), revision: REV, semantics: { 'agent.hire': { expect: { status: 'idle' } } } }), 'paperclip_semantics_invalid');
  refuses(() => qualifyPaperclip({ sourceDir: tree({ head: 'c'.repeat(40) }), revision: REV }), 'paperclip_source_revision_mismatch');
  refuses(() => qualifyPaperclip({ sourceDir: tree(), revision: 'main' }), 'paperclip_revision_invalid');
  assert.equal(qualifyPaperclip({ sourceDir: tree({ head: null }), revision: REV }).qualification.revisionEvidence, 'asserted');
  const linked = tree();
  symlinkSync('/etc/hosts', join(linked, 'server', 'src', 'routes', 'evil.ts'));
  refuses(() => qualifyPaperclip({ sourceDir: linked, revision: REV }), 'paperclip_source_unsafe');
});

test('a captured route list qualifies the same contract and refuses unknown capability claims', () => {
  const schemas = { 'company.create': ['company', 'createCompanySchema'], 'company.update': ['company', 'updateCompanySchema'],
    'goal.create': ['goal', 'createGoalSchema'], 'project.create': ['project', 'createProjectSchema'],
    'agent.hire': ['agent', 'createAgentHireSchema'], 'issue.create': ['issue', 'createIssueSchema'] };
  const bodyFields = Object.fromEntries(Object.entries(schemas).map(([c, [f, s]]) => [c, schemaFields(VALIDATORS[`${f}.ts`], s)]));
  const mounted = { 'companies.ts': '/api/companies', 'goals.ts': '/api', 'projects.ts': '/api', 'agents.ts': '/api', 'issues.ts': '/api' };
  const routes = Object.entries(mounted).flatMap(([file, prefix]) => [...ROUTES[file].matchAll(/router\.(get|post|patch)\(\s*"([^"]+)"/g)]
    .map((m) => ({ method: m[1].toUpperCase(), path: (prefix + m[2]).replace(/(.)\/$/, '$1') })));
  const capture = {
    schema: CAPTURE_SCHEMA, revision: REV, capturedAt: '2026-11-06T00:00:00Z', routes, bodyFields,
    enums: { AGENT_ROLES: ['ceo', 'pm'], AGENT_STATUSES: ['pending_approval', 'idle'], GOAL_LEVELS: ['company'], GOAL_STATUSES: ['active'], PROJECT_STATUSES: ['backlog'] },
    routeEvidence: { 'agent.hire': HIRE, 'project.create': ROUTES['projects.ts'] },
  };
  const contract = qualifyPaperclip({ capture, revision: REV });
  assert.equal(contract.qualification.status, 'qualified', JSON.stringify(contract.qualification.missing));
  assert.equal(contract.qualification.method, 'route-capture');
  assert.deepEqual(contract.capabilities, qualifyPaperclip({ sourceDir: tree(), revision: REV }).capabilities);
  refuses(() => qualifyPaperclip({ capture: { ...capture, bodyFields: { ...bodyFields, 'agent.run': ['x'] } }, revision: REV }), 'paperclip_capability_unknown');
  refuses(() => qualifyPaperclip({ capture: { ...capture, extra: true }, revision: REV }), 'paperclip_capture_invalid');
  refuses(() => qualifyPaperclip({ capture: { ...capture, revision: 'd'.repeat(40) }, revision: REV }), 'paperclip_source_revision_mismatch');
  const noEvidence = qualifyPaperclip({ capture: { ...capture, routeEvidence: {} }, revision: REV });
  assert.deepEqual(noEvidence.qualification.missing, ['agent.hire: pending-approval hire behaviour not found in route source']);
});

test('the CLI writes the contract offline and signals unqualified results by exit code', () => {
  const out = join(tree(), 'contract.json');
  execFileSync(process.execPath, [SCRIPT, '--source', tree(), '--revision', REV, '--out', out]);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).qualification.status, 'qualified');
  const partial = spawnSync(process.execPath, [SCRIPT, '--source', tree({ omit: ['goals.ts'] }), '--revision', REV], { encoding: 'utf8' });
  assert.equal(partial.status, 3);
  assert.equal(JSON.parse(partial.stdout).qualification.status, 'unqualified');
  const bad = spawnSync(process.execPath, [SCRIPT, '--source', tree(), '--revision', 'nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error, 'paperclip_revision_invalid');
});
