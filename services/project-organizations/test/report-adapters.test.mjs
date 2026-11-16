/** FIXTURE configuration only: fake native reader transport, fake Paperclip fetch, fictional
 * chain ids, addresses and paths in temporary directories. No production value is used and
 * nothing contacts a network, chain or Paperclip. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS } from '../src/native.mjs';
import { CONTRACT_SCHEMA, PAPERCLIP_REPOSITORY, PINNED_PAPERCLIP_REVISION } from '../src/paperclip.mjs';
import { ADAPTERS_CONFIG_SCHEMA, EXAMPLE_CONFIG, createAdapters, validateAdaptersConfig } from '../ops/adapters.example.mjs';
import { main, parseArgs, produceReports } from '../ops/report.mjs';

const refuses = (code) => (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true);
const ADAPTERS_MODULE = fileURLToPath(new URL('../ops/adapters.example.mjs', import.meta.url));
const selection = await loadSelection();
const dirs = [];
const tempDir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'uain-report-adapters-')));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const sink = () => {
  const lines = [];
  return { lines, write: (s) => lines.push(JSON.parse(s)) };
};

const READER_CHAIN = 'uain-fixture-report-reader';
const PROD_CHAIN = 'uain-fixture-report-production';
const KEY_ENV = 'UAIN_FIXTURE_PAPERCLIP_KEY';
const addr = (c) => 'uain1' + c.repeat(40);

function fixtureContract() {
  const ext = { field: 'description', format: 'trailing-line', property: null };
  const create = { externalKey: ext, idempotencyField: null, replaySafe: false, responseField: null };
  return {
    schema: CONTRACT_SCHEMA,
    upstream: { repository: PAPERCLIP_REPOSITORY, revision: PINNED_PAPERCLIP_REVISION },
    qualification: { status: 'qualified', method: 'source-checkout', revisionEvidence: 'git-head', qualifiedAt: '2026-11-06T00:00:00.000Z', evidenceDigest: 'a'.repeat(64), missing: [], sources: [] },
    capabilities: {
      'company.list': { method: 'GET', path: '/api/companies', pagination: { limitParam: 'limit', offsetParam: 'offset', maxLimit: 50 } },
      'company.get': { method: 'GET', path: '/api/companies/:companyId' },
      'company.create': { method: 'POST', path: '/api/companies', bodyFields: ['name', 'description', 'budgetMonthlyCents'], ...create, fixed: { budgetMonthlyCents: 0 } },
      'company.update': { method: 'PATCH', path: '/api/companies/:companyId', bodyFields: ['name', 'description', 'status', 'requireBoardApprovalForNewAgents'], gate: { requireBoardApprovalForNewAgents: true } },
      'goal.list': { method: 'GET', path: '/api/companies/:companyId/goals', pagination: null },
      'goal.get': { method: 'GET', path: '/api/goals/:goalId' },
      'goal.create': { method: 'POST', path: '/api/companies/:companyId/goals', bodyFields: ['title', 'description', 'level', 'status'], ...create, fixed: { level: 'company', status: 'active' } },
      'project.list': { method: 'GET', path: '/api/companies/:companyId/projects', pagination: null },
      'project.get': { method: 'GET', path: '/api/projects/:projectId' },
      'project.create': { method: 'POST', path: '/api/companies/:companyId/projects', bodyFields: ['name', 'description', 'status', 'visibility', 'goalIds', 'leadAgentId', 'idempotencyKey'],
        ...create, idempotencyField: 'idempotencyKey', replaySafe: true, fixed: { status: 'backlog', visibility: 'private', leadAgentId: null }, goalLink: 'goalIds' },
      'agent.list': { method: 'GET', path: '/api/companies/:companyId/agents', pagination: null },
      'agent.get': { method: 'GET', path: '/api/agents/:agentId' },
      'agent.hire': { method: 'POST', path: '/api/companies/:companyId/agent-hires', bodyFields: ['name', 'role', 'title', 'reportsTo', 'capabilities', 'metadata'],
        externalKey: { field: 'metadata', format: 'object-property', property: 'uainExternalKey' }, idempotencyField: null, replaySafe: false, responseField: 'agent', fixed: {},
        roles: { ceo: 'ceo', manager: 'pm' }, hierarchyField: 'reportsTo', expect: { status: 'pending_approval' } },
    },
  };
}

/** FIXTURE reader transport in the BAINK `publicState` shape: every record proven absent. */
function fakeReaderTransport(readerConfig, calls) {
  return {
    configured: true, pins: { chainId: readerConfig.chainId },
    async publicState(selection) {
      calls.push(selection);
      return {
        state: { chain_id: readerConfig.chainId, height: '50', header_time: new Date().toISOString(), event_count: '0', app_hash: 'c'.repeat(64),
          signed_header: { header: { height: '50' } }, member: null, records: Object.fromEntries((selection.keys ?? []).map((k) => [k, null])) },
        proof: { authority: 'native', chainId: readerConfig.chainId, height: '50', appHash: 'c'.repeat(64) },
      };
    },
    async close() { calls.closed = true; },
  };
}

/** Writes a complete fixture deployment and returns its config object. */
function deployment() {
  const root = tempDir();
  const d = (...p) => {
    const path = join(root, ...p);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  };
  const registryDirectory = d('registry');
  openRegistry({ directory: registryDirectory, selection }).close();
  const journalDirectory = d('journal');
  openJournal({ directory: journalDirectory }).close();
  const leadershipDirectory = d('leadership');
  writeFileSync(join(leadershipDirectory, 'leadership.jsonl'), '', { mode: 0o600 });
  const stateDirectory = d('scheduler');
  for (const s of ['projects', 'outcomes', 'submissions', 'evidence']) d('scheduler', s);
  const workspaceRoot = d('workspaces');
  const etc = d('etc');
  const X = selection.ids[0];
  const p = selection.get(X);
  const policy = {
    schema: FLEET_POLICY_SCHEMA, revision: 1, selection_digest: selection.digest,
    projects: { [X]: { native_project: p.nativeProjectId, source_digest: p.sourceDigest, paperclip_company: '11111111-1111-4111-8111-111111111111',
      manager: addr('1'), evaluator: addr('2'), max_task_units: '2000000000', max_plan_revision: 3 } },
    roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])),
    solvers: [addr('3')],
  };
  const fleetPolicyPath = join(etc, 'fleet-policy.json');
  writeFileSync(fleetPolicyPath, JSON.stringify(policy), { mode: 0o600 });
  const contractPath = join(etc, 'paperclip-contract.json');
  writeFileSync(contractPath, JSON.stringify(fixtureContract()), { mode: 0o600 });
  const store = join(d('reviewer'), 'jobs.json');
  writeFileSync(store, JSON.stringify({ version: 1, jobs: {}, attempts: {} }), { mode: 0o600 });
  return {
    root, etc,
    config: {
      schema: ADAPTERS_CONFIG_SCHEMA,
      production: { chainId: PROD_CHAIN, genesisSha256: 'd'.repeat(64) },
      native: { chainId: READER_CHAIN, startEvent: '0',
        reader: { binary: join(root, 'bin', 'uain-state'), binaryHash: 'e'.repeat(64), genesis: join(etc, 'genesis.json'), genesisHash: 'f'.repeat(64),
          rpc: 'http://127.0.0.1:26999', timeoutMs: 2000, maxAgeSeconds: 120 } },
      fleetPolicyPath,
      paperclip: { contractPath, origin: 'https://paperclip.fixture.test', apiKeyEnv: KEY_ENV },
      review: { stores: [store], reviewer: addr('4') },
      registryDirectory, journalDirectory, leadershipDirectory,
      scheduler: { stateDirectory, workspaceRoot },
      outputDirectory: join(root, 'reports'),
    },
  };
}
const fixtureDeps = (calls = []) => ({
  env: { [KEY_ENV]: 'fixture-operator-key-0123456789' },
  createReaderTransport: (c) => fakeReaderTransport(c, calls),
  paperclipFetch: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
  selection,
});

test('the example config is a shape only: every placeholder refuses', () => {
  assert.throws(() => validateAdaptersConfig(structuredClone(EXAMPLE_CONFIG)), refuses('adapters_config_placeholder'));
  assert.throws(() => validateAdaptersConfig(null), refuses('adapters_config_missing'));
  assert.throws(() => validateAdaptersConfig({}), refuses('adapters_config_missing'));
});

test('every config value is required and checked', async () => {
  const { config } = deployment();
  assert.ok(validateAdaptersConfig(config));
  for (const k of Object.keys(config)) {
    const c = structuredClone(config);
    delete c[k];
    assert.throws(() => validateAdaptersConfig(c), refuses('adapters_config_missing'), k);
  }
  const mutate = (fn) => {
    const c = structuredClone(config);
    fn(c);
    return c;
  };
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.extra = 1; })), refuses('adapters_config_invalid'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { delete c.native.reader.rpc; })), refuses('adapters_config_missing'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.paperclip.apiKeyEnv = 'sk-live-0123456789abcdef'; })), refuses('adapters_config_invalid'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.paperclip.origin = 'http://paperclip.fixture.test'; })), refuses('adapters_config_invalid'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.registryDirectory = 'relative/registry'; })), refuses('adapters_config_invalid'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.production.genesisSha256 = 'nope'; })), refuses('adapters_config_invalid'));
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.review = { stores: [], reviewer: addr('4') }; })), refuses('adapters_config_invalid'));
  // Reading the production chain requires the reader to use the pinned production genesis.
  assert.throws(() => validateAdaptersConfig(mutate((c) => { c.native.chainId = PROD_CHAIN; })), refuses('adapters_production_pin_mismatch'));
  assert.ok(validateAdaptersConfig(mutate((c) => { c.native.chainId = PROD_CHAIN; c.native.reader.genesisHash = c.production.genesisSha256; })));
  assert.ok(validateAdaptersConfig(mutate((c) => { c.review = null; })), 'review may be explicitly unconfigured');

  // Construction refuses an unset key variable and absent stores before reading anything.
  const calls = [];
  await assert.rejects(createAdapters(config, { ...fixtureDeps(calls), env: {} }), refuses('adapters_paperclip_key_unset'));
  const noJournal = mutate((c) => { c.journalDirectory = join(c.journalDirectory, 'missing'); });
  await assert.rejects(createAdapters(noJournal, fixtureDeps(calls)), refuses('adapters_store_missing'));
  const { config: other } = deployment();
  rmSync(join(other.leadershipDirectory, 'leadership.jsonl'));
  await assert.rejects(createAdapters(other, fixtureDeps(calls)), refuses('adapters_store_missing'));
  chmodSync(config.fleetPolicyPath, 0o666);
  await assert.rejects(createAdapters(config, fixtureDeps(calls)), refuses('adapters_fleet_policy_untrusted'));
  assert.equal(calls.length, 0, 'no native read before the configuration is complete');
});

test('adapters build from the config and produce reports read-only', async () => {
  const { config } = deployment();
  const calls = [];
  const adapters = await createAdapters(config, fixtureDeps(calls));
  try {
    assert.equal(adapters.accountReader, null);
    assert.deepEqual(adapters.production, { chainId: PROD_CHAIN, genesisSha256: 'd'.repeat(64) });
    // Read-only: no broadcaster and no custody signer.
    await assert.rejects(adapters.native.dispatch('none'), refuses('intent_not_found'));
    const result = await produceReports(adapters, { generatedAt: '2026-11-06T12:00:00.000Z' });
    assert.deepEqual(result.summary.operational.rows, { pass: 0, held: 24, incomplete: 96 }); // 24 reviewed prior-art holds
    assert.equal(result.summary.operational.complete, false);
    for (const p of Object.values(result.paths)) assert.ok(existsSync(p));
    assert.ok(calls.length > 0, 'the injected reader transport was used');
  } finally {
    await adapters.close();
  }
  assert.equal(calls.closed, true);
});

test('report CLI: config only from argv, refused when symlinked or writable by others', async () => {
  assert.equal(parseArgs(['--adapters', 'a.mjs']), null);
  assert.equal(parseArgs(['--adapters', 'a', '--adapters', 'b']), null);
  assert.deepEqual(parseArgs(['--config', 'c.json', '--adapters', 'a.mjs']), { modulePath: 'a.mjs', configPath: 'c.json' });
  let out = sink();
  assert.equal(await main([], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'adapters_not_configured');

  const { config, etc, root } = deployment();
  const cfg = join(etc, 'report-adapters.json');
  writeFileSync(cfg, JSON.stringify(EXAMPLE_CONFIG), { mode: 0o600 });
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', cfg], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'adapters_config_placeholder');

  chmodSync(cfg, 0o646);
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', cfg], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'config_untrusted');
  chmodSync(cfg, 0o600);

  const link = join(root, 'config-link.json');
  symlinkSync(cfg, link);
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', link], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'config_symlinked');

  const linkedDir = join(root, 'etc-link');
  symlinkSync(etc, linkedDir);
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', join(linkedDir, 'report-adapters.json')], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'config_symlinked');

  const open = join(root, 'open');
  mkdirSync(open);
  chmodSync(open, 0o777);
  writeFileSync(join(open, 'c.json'), JSON.stringify(config), { mode: 0o600 });
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', join(open, 'c.json')], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'config_untrusted');
  chmodSync(open, 0o700);

  writeFileSync(join(etc, 'bad.json'), 'not json', { mode: 0o600 });
  out = sink();
  assert.equal(await main(['--adapters', ADAPTERS_MODULE, '--config', join(etc, 'bad.json')], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'config_invalid');

  // A world-writable adapters module is refused before it is imported.
  const mod = join(etc, 'loose-adapters.mjs');
  writeFileSync(mod, 'throw new Error("must not be imported");\n', { mode: 0o600 });
  chmodSync(mod, 0o666);
  writeFileSync(cfg, JSON.stringify(config), { mode: 0o600 });
  out = sink();
  assert.equal(await main(['--adapters', mod, '--config', cfg], { stdout: out }), 2);
  assert.equal(out.lines[0].refused, 'adapters_module_untrusted');
});

test('report CLI end to end through an operator wrapper around the example adapters', async () => {
  const { config, etc } = deployment();
  const cfg = join(etc, 'report-adapters.json');
  writeFileSync(cfg, JSON.stringify(config), { mode: 0o600 });
  const wrapper = join(etc, 'operator-adapters.mjs');
  // FIXTURE operator module: the example adapters with fake reader and Paperclip I/O.
  writeFileSync(wrapper, `import { createAdapters as base } from ${JSON.stringify(pathToFileURL(ADAPTERS_MODULE).href)};
const reader = (c) => ({ configured: true, pins: { chainId: c.chainId }, async publicState(s) { return { state: { chain_id: c.chainId, height: '9', header_time: new Date().toISOString(), event_count: '0', member: null, records: Object.fromEntries((s.keys ?? []).map((k) => [k, null])) } }; } });
export function createAdapters(config) {
  return base(config, { env: { ${KEY_ENV}: 'fixture-operator-key-0123456789' }, createReaderTransport: reader,
    paperclipFetch: async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }) });
}
`, { mode: 0o600 });
  const out = sink();
  assert.equal(await main(['--adapters', wrapper, '--config', cfg], { stdout: out }), 0, JSON.stringify(out.lines));
  assert.equal(out.lines[0].summary.operational.rows.incomplete, 96); // 24 projects are held by reviewed prior art
  const written = JSON.parse(readFileSync(out.lines[0].written.combined, 'utf8'));
  assert.equal(written.selectionDigest, selection.digest);
});
