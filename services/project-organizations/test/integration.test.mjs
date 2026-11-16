/** INTEGRATION FIXTURE, NOT PRODUCTION EVIDENCE.
 *
 * Wires the real organization modules together for one selected project: selection,
 * registry, journal, Paperclip adapter + transport, leadership runs and store, Fund
 * Manager worker, pricing, native adapter, compute budget, scheduler, runtime cycle,
 * verification, status collection, acceptance and the BAINK status projection.
 *
 * Only the outermost I/O is faked, and every fake is labelled:
 * - FakeChain: the native chain, driven by the semantic fund model (fund-model.mjs);
 * - FakeCustody: an in-process Ed25519 signer holding throwaway test keys;
 * - fakePaperclip: an in-memory Paperclip HTTP server behind the real transport;
 * - fixture providers/executor: never a real model; their receipts are never actual.
 * The guardian bootstrap and the central reviewer's verdict are applied directly to the
 * fake chain, as their real counterparts sit outside these modules.
 *
 * Nothing here contacts a network, a provider, a chain or production.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { centralEarningSigningBytes } from '../../../apps/baink/server/central-earning-command.mjs';
import { memberAddress } from '../../../apps/baink/server/native-financial-command.mjs';
import { createOrganizationsStatus } from '../../../apps/baink/server/organizations-status.mjs';
import { catalogueRecords, loadSelection, sourceDigestOf } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { CONTRACT_SCHEMA, PAPERCLIP_REPOSITORY, PINNED_PAPERCLIP_REVISION, createOrganizationAdapter, createPaperclipTransport } from '../src/paperclip.mjs';
import { openLeadershipStore, runLeadership } from '../src/leadership.mjs';
import { FLEET_POLICY_SCHEMA, NATIVE_ROLE_OPERATIONS, createNativeAdapter } from '../src/native.mjs';
import { SUPPLY_CAP_UNITS, pricingInputsFromSnapshot, validatePricedTask } from '../src/pricing.mjs';
import { TRUSTED_PRIOR_ART_SCHEMA, proposeTask } from '../src/task-proposal.mjs';
import { openComputeBudget } from '../src/compute-budget.mjs';
import { createScheduler, fundingEpochOf } from '../src/scheduler.mjs';
import { runCycle } from '../src/runtime.mjs';
import { ARTIFACT_SCHEMA, POLICY_SCHEMA, createRunner, driverDigest, verifyEvidence } from '../src/verification.mjs';
import { createFundModel } from '../src/fund-model.mjs';
import { collectStatus } from '../src/status.mjs';
import { buildSurveyTask, requireAcceptedSurvey, surveyStatus } from '../src/survey.mjs';
import { draftOf, fixtureSurvey, reviewedOf } from './fixtures/survey-fixture.mjs';
import { OPERATIONAL_COLUMNS, REWARD_COLUMNS, buildAcceptance } from '../src/acceptance.mjs';
import { produceReports } from '../ops/report.mjs';
import { openFundWorker, openReportStore } from '../../fund-manager/src/worker.mjs';

const FIXTURE_CHAIN = 'uain-integration-fixture-chain';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
// Without the recorded KPI amendments, so OPP-08881 still exercises the native-minimum hold.
const selection = await loadSelection({ amendmentsPath: null });
const X = selection.ids[0];
const HELD = 'OPP-08881';
const p = selection.get(X);
const P = p.nativeProjectId;
const sourceOf = async (id) => ({ revision: catalogue.revision, row: structuredClone(catalogue.records.get(id)) });

const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uain-integration-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: memberAddress(pub), publicKey: pub.toString('base64url'), privateKey };
}

/** FIXTURE native chain: the semantic fund model plus member sequences, inclusion proofs
 * and the store-key record view the gateway serves. Fields the model does not track
 * (plan/task evidence digests, task title) are kept in an overlay from the signed payloads. */
class FakeChain {
  constructor({ clock, keys }) {
    this.clock = clock;
    this.guardian = identity().address;
    this.reviewer = identity().address;
    this.model = createFundModel({ guardian: this.guardian, reviewer: this.reviewer });
    this.height = 10n;
    this.members = {};
    for (const k of keys) {
      this.model.enroll(k.address);
      this.members[k.address] = { id: k.address, public_key: k.publicKey, licence: 'active', sequence: '0' };
    }
    this.projects = new Set();
    this.overlay = {};
    this.included = new Map();
    this.rejected = [];
  }
  /** Guardian bootstrap (custody's fixed entrypoint in production, not the adapter). */
  bootstrap(project, manager, evaluator) {
    this.model.createProject({ project, lead: this.guardian });
    this.model.start({ actor: this.guardian, project, manager });
    this.model.configure({ actor: this.guardian, project, evaluator });
    this.projects.add(project);
  }
  view() {
    const records = {};
    for (const project of this.projects) Object.assign(records, this.model.snapshot(project).records);
    for (const [k, extra] of Object.entries(this.overlay)) if (records[k]) records[k] = { ...records[k], ...extra };
    return records;
  }
  async read({ member, keys }) {
    const all = this.view();
    const records = Object.fromEntries(keys.map((k) => [k, all[k] ?? null]));
    return structuredClone({
      chain_id: FIXTURE_CHAIN, height: String(this.height), header_time: new Date(this.clock.now).toISOString(),
      app_hash: sha(JSON.stringify(all) + this.height), signed_header: { fixture: true }, event_count: String(this.included.size),
      member: member ? this.members[member] ?? null : null, records,
    });
  }
  async tasks(project) {
    return Object.values(this.view()).filter((v) => v && v.project === project && typeof v.solver_amount === 'string');
  }
  async reviews(submission) {
    return Object.entries(this.view()).filter(([k]) => k.startsWith(`central_review/${submission}/`)).map(([, v]) => v);
  }
  apply(c) {
    const q = c.payload, actor = c.member;
    switch (c.operation) {
      case 'project_join': return this.model.join({ project: q.project, member: actor });
      case 'central_fund_plan':
        this.model.plan({ actor, project: q.project, revision: q.revision, mainKpi: q.main_kpi, stages: q.stages, reason: q.reason });
        this.overlay[`central_fund_plan/${q.project}/${String(q.revision).padStart(20, '0')}`] = { evidence_digest: q.evidence_digest };
        return null;
      case 'central_fund_plan_review': return this.model.reviewPlan({ actor, project: q.project, revision: q.revision, verdict: q.verdict });
      case 'central_task_open':
        this.model.openTask({ actor, id: q.id, project: q.project, criteria: q.criteria, solverAmount: q.solver_amount, reviewerAmount: q.reviewer_amount });
        this.overlay[`central_task/${q.id}`] = { title: q.title, eligibility: q.eligibility, eligibility_digest: q.eligibility_digest, evidence_digest: q.evidence_digest };
        return null;
      case 'central_submit': return this.model.submit({ actor, id: q.id, task: q.task, evidence: q.evidence });
      default: throw new Error(`fixture chain does not model ${c.operation}`);
    }
  }
  async broadcast(envelope) {
    const c = envelope.command;
    const commandDigest = sha(centralEarningSigningBytes(c));
    if (this.included.has(commandDigest) || this.members[c.member]?.sequence !== c.sequence) return 1;
    try {
      this.apply(c);
    } catch (e) {
      this.rejected.push({ operation: c.operation, code: e.code });
      return 1;
    }
    this.height += 1n;
    this.members[c.member].sequence = String(BigInt(c.sequence) + 1n);
    this.included.set(commandDigest, {
      authority: 'native', finalized: true, chain_id: FIXTURE_CHAIN, command_digest: commandDigest, member: c.member, operation: c.operation,
      height: String(this.height),
    });
    return 0;
  }
  async findCommand({ commandDigest, expiresHeight }) {
    const proof = this.included.get(commandDigest);
    if (proof) return { found: true, proof: structuredClone(proof) };
    return { found: false, expired: this.height > BigInt(expiresHeight), height: String(this.height) };
  }
  /** FIXTURE central reviewer verdict (the protected reviewer service in production). */
  centralReview({ submission, verdict, executionId }) {
    const all = this.view();
    const v = all[`central_submission/${submission}`];
    const t = all[`central_task/${v.task}`];
    this.height += 1n;
    return this.model.review({ actor: this.reviewer, submission, verdict, executionId, criteriaDigest: t.acceptance_digest, evidenceDigest: v.evidence_digest });
  }
}

/** FIXTURE custody: signs with throwaway in-process test keys. */
class FakeCustody {
  constructor(keys) {
    this.keys = new Map(keys.map((k) => [k.address, k]));
    this.signed = [];
  }
  async sign(command, context) {
    this.signed.push({ operation: command.operation, ...context });
    const key = this.keys.get(command.member);
    return { command, public_key: key.publicKey, signature: edSign(null, centralEarningSigningBytes(command), key.privateKey).toString('base64url') };
  }
}

/** FIXTURE Paperclip contract shaped like the qualifier's output for the pinned revision
 * (mirrors test/paperclip.test.mjs: leadership is hired behind the board-approval gate). */
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
      'company.create': { method: 'POST', path: '/api/companies', bodyFields: ['name', 'description', 'budgetMonthlyCents'], ...create, fixed: { budgetMonthlyCents: 0 } },
      'company.update': { method: 'PATCH', path: '/api/companies/:companyId', bodyFields: ['name', 'description', 'status', 'requireBoardApprovalForNewAgents'],
        gate: { requireBoardApprovalForNewAgents: true } },
      'goal.list': { method: 'GET', path: '/api/companies/:companyId/goals', pagination: null },
      'goal.get': { method: 'GET', path: '/api/goals/:goalId' },
      'goal.create': { method: 'POST', path: '/api/companies/:companyId/goals', bodyFields: ['title', 'description', 'level', 'status'], ...create,
        fixed: { level: 'company', status: 'active' } },
      'project.list': { method: 'GET', path: '/api/companies/:companyId/projects', pagination: null },
      'project.get': { method: 'GET', path: '/api/projects/:projectId' },
      'project.create': { method: 'POST', path: '/api/companies/:companyId/projects',
        bodyFields: ['name', 'description', 'status', 'visibility', 'goalIds', 'leadAgentId', 'idempotencyKey'],
        ...create, idempotencyField: 'idempotencyKey', replaySafe: true, fixed: { status: 'backlog', visibility: 'private', leadAgentId: null }, goalLink: 'goalIds' },
      'agent.list': { method: 'GET', path: '/api/companies/:companyId/agents', pagination: null },
      'agent.get': { method: 'GET', path: '/api/agents/:agentId' },
      'agent.hire': { method: 'POST', path: '/api/companies/:companyId/agent-hires',
        bodyFields: ['name', 'role', 'title', 'reportsTo', 'capabilities', 'metadata'],
        externalKey: { field: 'metadata', format: 'object-property', property: 'uainExternalKey' },
        idempotencyField: null, replaySafe: false, responseField: 'agent', fixed: {},
        roles: { ceo: 'ceo', manager: 'pm' }, hierarchyField: 'reportsTo', expect: { status: 'pending_approval' } },
    },
  };
}

/** FIXTURE in-memory Paperclip HTTP server (hire -> pending_approval behind the gate). */
function fakePaperclip() {
  const apiKey = randomBytes(24).toString('base64url');
  const db = { company: new Map(), goal: new Map(), project: new Map(), agent: new Map() };
  const PLURAL = { goals: 'goal', projects: 'project', agents: 'agent', 'agent-hires': 'agent' };
  const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  const writes = [];
  async function fetchImpl(input, init) {
    const url = new URL(input), method = init.method, body = init.body ? JSON.parse(init.body) : undefined;
    if (init.headers.Authorization !== `Bearer ${apiKey}`) return json(401, { error: 'unauthorized' });
    if (method !== 'GET') writes.push(`${method} ${url.pathname}`);
    const path = url.pathname;
    const page = (rows) => {
      if (!url.searchParams.has('limit')) return rows;
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
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
      if (!row) return json(404, {});
      if (method === 'PATCH') Object.assign(row, body);
      return json(200, row);
    }
    m = path.match(/^\/api\/companies\/([^/]+)\/(goals|projects|agents|agent-hires)$/);
    if (m) {
      const company = db.company.get(m[1]);
      if (!company) return json(404, {});
      const kind = PLURAL[m[2]];
      if (method === 'GET') return json(200, page([...db[kind].values()].filter((r) => r.companyId === m[1])));
      if (m[2] === 'agents') return json(409, { error: 'direct agent creation is not used' });
      if (kind === 'agent') {
        const row = { id: randomUUID(), ...body, companyId: m[1], status: company.requireBoardApprovalForNewAgents ? 'pending_approval' : 'idle' };
        db.agent.set(row.id, row);
        return json(201, { agent: row, approval: { id: randomUUID(), status: 'pending' } });
      }
      const { idempotencyKey: _k, ...rest } = body;
      const row = { id: randomUUID(), status: 'active', ...rest, companyId: m[1] };
      db[kind].set(row.id, row);
      return json(201, row);
    }
    m = path.match(/^\/api\/(goals|projects|agents)\/([^/]+)$/);
    if (m && method === 'GET') {
      const row = db[PLURAL[m[1]]].get(m[2]);
      return row ? json(200, row) : json(404, {});
    }
    return json(404, { error: 'no route' });
  }
  return { apiKey, db, writes, fetchImpl };
}

const jsonl = (value) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n';
const TASK_CRITERIA = 'FIXTURE criteria: an independent rerun reproduces the retained witness from the pinned inputs exactly.';

/** FIXTURE leadership provider: never a real model, receipts are never actual. */
function leadershipProvider() {
  const calls = [];
  return {
    calls, fixture: true, model: 'fixture-model',
    async execute({ role, projectId, executionId }) {
      calls.push({ role, projectId });
      const kpi = selection.get(projectId).kpi.statement;
      const answer = role === 'ceo'
        ? { main_kpi: kpi, strategy: 'FIXTURE strategy: build reproducible evidence first, then scale delivery carefully.', blockers: ['FIXTURE blocker: no qualified clinical verification adapter.'] }
        : { main_kpi: kpi, round: 1, tasks: [{
          title: 'FIXTURE bounded witness reproduction task', criteria: TASK_CRITERIA, eligibility: 'unresolved',
          eligibility_basis: 'FIXTURE basis: the integration test supplies its own prior-art record below.',
          proposed_price: { solver_amount: '400000000', reviewer_amount: '100000000', rationale: {
            effort: 'FIXTURE effort: one bounded rerun.', difficulty: 'FIXTURE difficulty: moderate.',
            novelty: 'FIXTURE novelty: unresolved.', verificationCost: 'FIXTURE verification: one rerun.',
          } },
        }] };
      return { raw: jsonl(answer), receipt: { executionId, model: 'fixture-model', startedAt: '2026-11-06T12:00:00.000Z', finishedAt: '2026-11-06T12:00:01.000Z', actual: false } };
    },
  };
}
/** FIXTURE Fund Manager provider (plan, then an independent accept review). */
function fundProvider() {
  const stages = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE stage ${i + 1}: independently verify immutable evidence against the unchanged Main KPI.` }));
  return {
    async execute({ role, projectId, executionId }) {
      const kpi = selection.get(projectId).kpi.statement;
      if (role === 'fund_plan') return { raw: jsonl({ main_kpi: kpi, stages, reason: 'FIXTURE: five ordered sub-KPIs decompose the unchanged Main KPI.' }), receipt: { executionId, actual: false } };
      return { raw: jsonl({ verdict: 'accept', findings: ['FIXTURE review: each stage carries observable immutable evidence.'] }), receipt: { executionId, actual: false } };
    },
  };
}

/** Runs the whole single-project flow once and returns the wired world. */
async function buildWorld() {
  const base = tempDir();
  const clock = { now: Date.parse('2026-11-06T12:00:00.000Z') };
  const nowMs = () => clock.now;
  const manager = identity(), evaluator = identity(), solver = identity();
  const chain = new FakeChain({ clock, keys: [manager, evaluator, solver] });
  chain.bootstrap(P, manager.address, evaluator.address);
  const custody = new FakeCustody([manager, evaluator, solver]);

  const registry = openRegistry({ directory: join(base, 'registry'), selection });
  const journal = openJournal({ directory: join(base, 'journal'), now: nowMs });

  // 1. Paperclip organization: company -> goal -> project -> CEO -> manager (reports to CEO).
  const server = fakePaperclip();
  const contract = fixtureContract();
  const transport = createPaperclipTransport({ origin: 'https://paperclip.fixture.example', apiKey: server.apiKey, contract, fetchImpl: server.fetchImpl, timeoutMs: 500 });
  const paperclip = createOrganizationAdapter({ transport, registry, journal, selection, contract, now: nowMs });
  const reconciled = await paperclip.reconcile(X);

  // 2. Native bindings and the root-owned fleet policy naming this project only.
  const org = registry.get(X);
  registry.bind(X, { nativeProjectId: P, nativeManager: manager.address, nativeEvaluator: evaluator.address });
  const policy = {
    schema: FLEET_POLICY_SCHEMA, revision: 1, selection_digest: selection.digest,
    projects: { [X]: { native_project: P, source_digest: p.sourceDigest, paperclip_company: org.paperclipCompanyId,
      manager: manager.address, evaluator: evaluator.address, max_task_units: '2000000000', max_plan_revision: 3 } },
    roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])),
    solvers: [solver.address],
  };
  const native = createNativeAdapter({ custody, reader: chain, registry, journal, selection, policy, chainId: FIXTURE_CHAIN, now: nowMs, timeoutMs: 1000 });
  const settle = async (intent) => {
    const sent = await native.dispatch(intent.id);
    assert.equal(sent.status, 'dispatched', `${intent.operation} dispatched`);
    assert.equal(sent.code, 0, `${intent.operation} included by the fixture chain: ${JSON.stringify(chain.rejected)}`);
    const done = await native.reconcile(intent.id);
    assert.equal(done.status, 'confirmed', `${intent.operation} confirmed`);
    return done.intent;
  };

  // 3. Leadership: CEO run, then the manager is blocked until a plan is approved.
  const leadershipStore = openLeadershipStore({ directory: join(base, 'leadership') });
  const provider = leadershipProvider();
  const leader = (role, extra = {}) => runLeadership({
    projectId: X, role, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(X)) }, provider, selection, store: leadershipStore,
    bounds: { maxTaskUnits: policy.projects[X].max_task_units }, now: () => new Date(clock.now),
    organization: { companyId: org.paperclipCompanyId, agentId: role === 'ceo' ? org.ceoAgentId : org.managerAgentId }, ...extra,
  });
  const ceoRun = await leader('ceo');
  const blockedManager = await leader('manager');

  // 4. Fund Manager: evaluator-signed proposal, then its independent approval.
  const reports = openReportStore({ directory: join(base, 'reports') });
  const worker = openFundWorker({ registry, journal, native, provider: fundProvider(), selection, source: sourceOf, reports });
  const proposal = await worker.plan(X);
  await settle(proposal.intents[0]);
  const approval = await worker.plan(X);
  await settle(approval.intents[0]);
  const afterPlan = await native.snapshot(X);
  const surveyFirstManager = await leader('manager', { approvedPlan: afterPlan.approvedPlan, fundState: afterPlan.fundState });

  // 4b. The prior-art survey is the first task: priced deterministically, opened, solved through the
  // scheduler and accepted. The solver joins here, before its first task.
  await settle(await native.prepare(X, 'project_join', { project: P }, { id: `join-${X}-solver`, signer: solver.address }));
  const supplyNow = () => { const l = chain.model.ledger(); return { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: l.minted, reserved: l.reserved } }; };
  const surveyTask = buildSurveyTask({
    projectId: X, selection, source: { revision: catalogue.revision, row: structuredClone(catalogue.records.get(X)) },
    draft: draftOf(X), reviewed: reviewedOf(X), approvedPlan: afterPlan, pricingSnapshot: supplyNow(), driverSha256: driverDigest('prior-art-survey'),
  });
  const surveyPriced = validatePricedTask(surveyTask.input);
  await settle(await native.prepare(X, 'central_task_open', surveyPriced.nativePayload, { id: `open-${surveyPriced.nativePayload.id}` }));
  const surveyTaskId = surveyPriced.nativePayload.id;

  const budget = openComputeBudget({ directory: join(base, 'compute'), now: nowMs, limits: { perCallUsd: 1, dailyUsd: 2, totalUsd: 5 } });
  const executorCalls = [];
  const executor = {
    model: 'fixture-solver', fixture: true, actual: false, capabilities: [],
    async run(job) {
      executorCalls.push(job);
      const base = { schema: ARTIFACT_SCHEMA, taskId: job.taskId, submissionId: job.submissionId, author: job.author };
      const evidenceArtifact = job.taskId === surveyTaskId ? { ...base, survey: fixtureSurvey(surveyTask.policy) }
        : { ...base, note: 'FIXTURE solver output; not a research result' };
      return { outcome: 'completed', usage: { costUsd: 0, stopReason: 'fixture' }, evidenceArtifact };
    },
  };
  let job = { projectId: X, taskId: surveyTaskId, kind: 'solver', solver: solver.address, criteriaDigest: surveyPriced.nativePayload.acceptance_digest };
  const scheduler = createScheduler({
    selection, registry, journal, executor, native, budget,
    jobs: {
      next: (id) => (id === X ? job : null),
      criteriaDigest: async (_id, t) => (await chain.read({ member: null, keys: [`central_task/${t}`] })).records[`central_task/${t}`]?.acceptance_digest,
      fundingEpoch: async (_id, t) => fundingEpochOf((await chain.read({ member: null, keys: [`central_task/${t}`] })).records[`central_task/${t}`]),
    },
    sources: { digest: async (id) => sourceDigestOf(catalogue.records.get(id), catalogue.revision) },
    workspaceRoot: join(base, 'workspaces'), stateDirectory: join(base, 'scheduler'), clock: nowMs,
  });
  const surveyPendingStatus = surveyStatus(await native.snapshot(X, { evidence: true }));
  const surveyCycle = await runCycle({ journal, native, scheduler });
  const surveySubmit = journal.get(surveyCycle.tick.intentId);
  await native.dispatch(surveySubmit.id);
  await runCycle({ journal, native, scheduler });
  const surveyReview = chain.centralReview({ submission: surveySubmit.payload.id, verdict: 'accept', executionId: 'fixture-central-review-survey' });
  const survey = requireAcceptedSurvey(await native.snapshot(X, { evidence: true }));
  const managerRun = await leader('manager', { approvedPlan: afterPlan.approvedPlan, fundState: afterPlan.fundState, survey });

  // 5. Pricing from the manager proposal against the fresh native snapshot (with the accepted
  // survey's submission, so the survey gate can read it), then central_task_open.
  const proposed = managerRun.result.tasks[0];
  const nativeView = await native.snapshot(X, { evidence: true });
  const inputs = pricingInputsFromSnapshot(nativeView);
  const ledger = chain.model.ledger();
  const priced = validatePricedTask(proposeTask({
    managerReport: managerRun, taskId: `T-${X}-1`, approvedPlan: nativeView, selection,
    // FIXTURE: the leadership provider is a fixture, so its report is never actual.
    requireActualReport: false,
    // FIXTURE prior-art record: no real search was run by this test.
    priorArtRecord: {
      schema: TRUSTED_PRIOR_ART_SCHEMA,
      producer: { kind: 'trusted_search', id: 'fixture-search-run-1', recordedAt: '2026-11-06T11:00:00.000Z' },
      subject: { projectId: X, criteriaDigest: sha(proposed.criteria) },
      basis: 'FIXTURE prior-art basis recorded for the integration test only; not a real search.',
      searches: [
        { query: 'fixture query one', source: 'fixture-registry-a', observedAt: '2026-11-06T11:00:00.000Z', resultSummary: 'FIXTURE: no result recorded.' },
        { query: 'fixture query two', source: 'fixture-registry-b', observedAt: '2026-11-06T11:00:00.000Z', resultSummary: 'FIXTURE: no result recorded.' },
      ],
      knownAnswer: false, openSolutionFound: false,
    },
    pricingSnapshot: { supply: { cap: SUPPLY_CAP_UNITS.toString(), issued: ledger.minted, reserved: ledger.reserved } },
    now: () => clock.now,
  }));
  assert.equal(inputs.approvedPlan.revision, priced.priceEvidence.plan.revision);
  const openIntent = await native.prepare(X, 'central_task_open', priced.nativePayload, { id: `open-${priced.nativePayload.id}` });
  await settle(openIntent);
  const taskId = priced.nativePayload.id;
  job = { projectId: X, taskId, kind: 'solver', solver: solver.address, criteriaDigest: sha(TASK_CRITERIA) };

  // 7. Scheduler solver job through the runtime cycle -> prepared central_submit intent.
  const firstCycle = await runCycle({ journal, native, scheduler });
  const submitIntent = journal.get(firstCycle.tick.intentId);
  const sent = await native.dispatch(submitIntent.id);
  const secondCycle = await runCycle({ journal, native, scheduler });


  // 8. FIXTURE central review: accept, which mints the exact solver and reviewer awards.
  const submission = submitIntent.payload.id;
  const review = chain.centralReview({ submission, verdict: 'accept', executionId: 'fixture-central-review-1' });

  const accountReader = async (member) => ({ member, total: chain.model.earnings(member)?.total ?? '0', readAt: new Date(clock.now).toISOString() });
  const adapters = { selection, registry, journal, native, paperclip, leadershipStore, scheduler, accountReader };
  return {
    base, clock, chain, custody, server, registry, journal, native, paperclip, leadershipStore, scheduler, worker, budget, accountReader, adapters,
    manager, evaluator, solver, reconciled, org, ceoRun, blockedManager, surveyFirstManager, managerRun, proposal, approval, priced, taskId, executorCalls,
    surveyTask, surveyPriced, surveyTaskId, surveyPendingStatus, surveySubmit, surveyReview, survey,
    firstCycle, sent, secondCycle, submitIntent, submission, review,
  };
}

const world = await buildWorld();
const inputs = await collectStatus(world.adapters);
const row = (report, id) => report.projects.find((r) => r.projectId === id);
const NATIVE_OPERATIONAL = ['nativeAdmission', 'approvedPlan', 'allowance', 'reservedTask'];

test('FIXTURE: each module step ran for one project through the real adapters', async () => {
  const w = world;
  assert.equal(w.reconciled.status, 'complete');
  assert.ok(['paperclipCompanyId', 'paperclipGoalId', 'paperclipProjectId', 'ceoAgentId', 'managerAgentId'].every((f) => w.org[f]), 'all organization IDs bound');
  assert.ok(w.server.writes.every((x) => !/wake|heartbeat|run|approv/.test(x)), 'no agent was woken or approved');
  assert.deepEqual([...w.server.db.agent.values()].map((a) => a.status), ['pending_approval', 'pending_approval']);
  // Leadership: fixture provider, so retained but never actual.
  assert.deepEqual([w.ceoRun.status, w.ceoRun.actual, w.ceoRun.agentId], ['completed', false, w.org.ceoAgentId]);
  assert.deepEqual([w.blockedManager.status, w.blockedManager.reason], ['blocked', 'approved_plan_required']);
  // The survey is the first task: before it is accepted, the manager is blocked without a provider call.
  assert.deepEqual([w.surveyFirstManager.status, w.surveyFirstManager.reason, w.surveyFirstManager.execution], ['blocked', 'prior_art_survey_required', null]);
  assert.deepEqual([w.surveyPriced.nativePayload.id, w.surveyPriced.nativePayload.solver_amount, w.surveyPriced.nativePayload.reviewer_amount, w.surveyPriced.nativePayload.eligibility],
    [`T-${X}-1-prior-art-survey`, '200000000', '50000000', 'new']);
  assert.equal(w.surveyPendingStatus.state, 'pending');
  assert.deepEqual([w.survey.state, w.survey.meetsMainKpi, w.survey.submission], ['accepted', false, w.surveySubmit.payload.id]);
  assert.deepEqual(w.managerRun.priorArtSurvey, { taskId: w.surveyTaskId, submission: w.survey.submission, evidenceDigest: w.survey.evidenceDigest });
  assert.deepEqual(w.priced.priceEvidence.task.evidenceDigest.length, 64);
  assert.deepEqual([w.managerRun.status, w.managerRun.actual, w.managerRun.milestoneRound, w.managerRun.agentId], ['completed', false, 1, w.org.managerAgentId]);
  // Fund plan approved natively by the evaluator; the manager never signed it.
  assert.deepEqual([w.proposal.status, w.approval.status], ['proposal_prepared', 'approval_prepared']);
  assert.equal((await w.worker.status(X)).status, 'active');
  const signers = w.custody.signed.map((s) => [s.operation, s.role]);
  assert.deepEqual(signers, [['central_fund_plan', 'evaluator'], ['central_fund_plan_review', 'evaluator'], ['project_join', 'solver'],
    ['central_task_open', 'manager'], ['central_submit', 'solver'], ['central_task_open', 'manager'], ['central_submit', 'solver']]);
  // Pricing fed central_task_open unchanged; native reserved exactly solver + reviewer.
  const task = w.chain.model.task(w.taskId);
  assert.deepEqual([task.solverAmount, task.reviewerAmount, task.acceptanceDigest], [w.priced.nativePayload.solver_amount, w.priced.nativePayload.reviewer_amount, w.priced.nativePayload.acceptance_digest]);
  // Scheduler -> central_submit intent -> confirmed only after reconciliation in the next cycle.
  assert.equal(w.firstCycle.tick.state, 'submission_prepared');
  assert.equal(w.executorCalls.length, 2);
  // The executor is told the submission and author its artifact must name for verification.
  assert.deepEqual([w.executorCalls[0].taskId, w.executorCalls[0].submissionId, w.executorCalls[0].author], [w.surveyTaskId, w.surveySubmit.payload.id, w.solver.address]);
  assert.equal(w.executorCalls[1].submissionId, w.submitIntent.payload.id);
  assert.equal(w.sent.status, 'dispatched');
  assert.deepEqual(w.secondCycle.reconciled, [{ id: w.submitIntent.id, from: 'dispatched', to: 'confirmed' }]);
  assert.equal(w.secondCycle.state, 'idle');
  assert.equal(w.scheduler.status(X).state, 'submitted');
  const attempts = w.scheduler.attempts(X);
  const byTask = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  assert.deepEqual(attempts.map((a) => [a.taskId, a.outcome, a.actual, a.bounded]).sort(byTask),
    [[w.surveyTaskId, 'completed', false, true], [w.taskId, 'completed', false, true]].sort(byTask));
  // Review paid the exact advertised amounts.
  assert.deepEqual(w.review.awards.map((a) => [a.role, a.member, a.amount]),
    [['reviewer', w.chain.reviewer, task.reviewerAmount], ['solver', w.solver.address, task.solverAmount]]);
  // Every journal intent settled; nothing is left unknown.
  assert.deepEqual([...new Set(w.journal.list().map((i) => i.state))], ['confirmed']);
});

test('FIXTURE: collectStatus maps the real adapters onto the acceptance input shapes', () => {
  assert.equal(inputs.errors.length, 0, JSON.stringify(inputs.errors.slice(0, 3)));
  const snap = inputs.nativeSnapshots.get(X);
  assert.deepEqual([snap.proof.authority, snap.proof.chainId, snap.proof.finalized, snap.unread], ['native', FIXTURE_CHAIN, true, []]);
  assert.ok(snap.records[`central_task/${world.taskId}`] && snap.records[`central_submission/${world.submission}`] && snap.records[`central_award/solver/${world.submission}`]);
  assert.deepEqual(inputs.paperclipSnapshots.get(X).agents.map((a) => a.role), ['ceo', 'manager']);
  assert.equal(inputs.paperclipSnapshots.size, 1, 'only the reconciled project has a Paperclip readback');
  assert.deepEqual(inputs.leadershipRuns.get(X).map((r) => [r.role, r.actual, r.outcome]),
    [['ceo', false, 'completed'], ['manager', false, 'blocked'], ['manager', false, 'blocked'], ['manager', false, 'completed']]);
  assert.equal(inputs.workerAttempts.get(X).length, 2);
  assert.equal(inputs.accountReadbacks.get(X).length, 2);
});

test('FIXTURE: with the production pin equal to the fixture chain, rows reflect each step truthfully and nothing is complete', () => {
  const a = buildAcceptance({ ...inputs, production: { chainId: FIXTURE_CHAIN }, generatedAt: '2026-11-06T13:00:00.000Z' });
  const op = row(a.operationalReadiness, X).columns, rw = row(a.rewardAcceptance, X).columns;
  assert.equal(op.organization.status, 'pass');
  // Fixture leadership runs are retained records only: never actual, never pass.
  assert.deepEqual([op.ceoRun.status, op.ceoRun.reason], ['missing', 'no_actual_run:records_only_or_fixture']);
  assert.deepEqual([op.managerRun.status, op.managerRun.reason], ['missing', 'no_actual_run:records_only_or_fixture']);
  for (const c of NATIVE_OPERATIONAL) assert.equal(op[c].status, 'pass', `${c}: ${op[c].reason}`);
  // The survey is the first reserved task; the manager's task follows it.
  assert.deepEqual([op.reservedTask.evidence.taskId, op.reservedTask.evidence.reservedTasks], [world.surveyTaskId, 2]);
  // The fixture executor's attempt is bounded but not actual.
  assert.deepEqual([op.workerAttempt.status, op.workerAttempt.reason], ['missing', 'no_actual_attempt:records_only_or_fixture']);
  for (const c of REWARD_COLUMNS) assert.equal(rw[c].status, 'pass', `${c}: ${rw[c].reason}`);
  // Both accepted trails (the survey and the manager's task) are real; the report cites one of them.
  assert.ok([world.submission, world.surveySubmit.payload.id].includes(rw.submission.evidence.submissionId));
  assert.equal(rw.submission.evidence.submissions, 2);
  assert.deepEqual(rw.awards.evidence.awards.map((x) => x.role), ['reviewer', 'solver']);
  assert.equal(row(a.operationalReadiness, X).status, 'incomplete');
  assert.equal(row(a.rewardAcceptance, X).status, 'pass');

  // The other 119 projects stay missing/unknown/held; nothing is substituted or filled.
  for (const report of [a.operationalReadiness, a.rewardAcceptance])
    for (const r of report.projects.filter((x) => x.projectId !== X))
      for (const [c, cell] of Object.entries(r.columns)) assert.ok(['missing', 'unknown', 'held'].includes(cell.status), `${r.projectId} ${c} is ${cell.status}`);
  const held = row(a.operationalReadiness, HELD);
  assert.deepEqual([held.status, held.holds, held.columns.approvedPlan.status], ['held', ['main_kpi_below_native_minimum'], 'held']);
  assert.equal(row(a.rewardAcceptance, HELD).columns.awards.status, 'held');
  assert.deepEqual(a.operationalReadiness.counts.rows, { pass: 0, held: 1, incomplete: 119 });
  assert.deepEqual(a.rewardAcceptance.counts.rows, { pass: 1, held: 1, incomplete: 118 });
  assert.equal(a.operationalReadiness.complete, false);
  assert.equal(a.rewardAcceptance.complete, false);
  assert.equal(a.operationalReadiness.stages[0].reached, false, 'stage 1 needs operational pass, which fixture runs cannot give');
});

test('FIXTURE: a fixture chain id never passes native cells unless the production pin matches it', () => {
  const mismatch = buildAcceptance({ ...inputs, production: { chainId: 'uain-production-pin' } });
  const unpinned = buildAcceptance({ ...inputs, production: null });
  for (const [a, status, reason] of [[mismatch, 'missing', 'non_production_chain'], [unpinned, 'unknown', 'production_chain_unpinned']]) {
    const op = row(a.operationalReadiness, X).columns, rw = row(a.rewardAcceptance, X).columns;
    for (const c of [...NATIVE_OPERATIONAL, ...REWARD_COLUMNS]) {
      const cell = c in op ? op[c] : rw[c];
      assert.deepEqual([cell.status, cell.reason], [status, reason], c);
    }
    assert.equal(op.organization.status, 'pass', 'Paperclip readback does not depend on the chain pin');
    assert.equal(a.rewardAcceptance.counts.rows.pass, 0);
    assert.equal(a.operationalReadiness.complete || a.rewardAcceptance.complete, false);
    for (const r of a.operationalReadiness.projects) assert.ok(OPERATIONAL_COLUMNS.every((c) => !NATIVE_OPERATIONAL.includes(c) || r.columns[c].status !== 'pass'));
  }
});

test('FIXTURE: a failing source for one project is unknown, never missing or zero, and other projects still read', async () => {
  const failing = {
    ...world.adapters,
    native: { snapshot: async (id, o) => (id === X ? Promise.reject(Object.assign(new Error('reader down'), { code: 'native_read_timeout' })) : world.native.snapshot(id, o)) },
    leadershipStore: { list: ({ projectId }) => { if (projectId === X) throw Object.assign(new Error('disk'), { code: 'leadership_log_tampered' }); return []; } },
    scheduler: null,
  };
  const got = await collectStatus(failing);
  assert.equal(got.nativeSnapshots.has(X), false);
  assert.equal(got.nativeSnapshots.size, 119);
  assert.deepEqual(got.errors.map((e) => [e.projectId, e.source, e.reason]), [[X, 'native', 'native_read_timeout'], [X, 'leadership', 'leadership_log_tampered']]);
  const a = buildAcceptance({ ...got, production: { chainId: FIXTURE_CHAIN } });
  const op = row(a.operationalReadiness, X).columns, rw = row(a.rewardAcceptance, X).columns;
  for (const c of [...NATIVE_OPERATIONAL, 'ceoRun', 'managerRun', 'workerAttempt']) assert.equal(op[c].status, 'unknown', c);
  for (const c of REWARD_COLUMNS) assert.equal(rw[c].status, 'unknown', c);
  assert.equal(row(a.operationalReadiness, selection.ids[1]).columns.workerAttempt.reason, 'scheduler_unavailable');
});

test('FIXTURE: verification output is a per-task attestation only and never claims the Main KPI', async () => {
  const policy = {
    schema: POLICY_SCHEMA, class: 'finite_math_witness', taskId: world.taskId, projectId: P, criteriaDigest: sha(TASK_CRITERIA), inputs: [], primarySourceHosts: [],
    driver: { name: 'finite-math-witness', sha256: driverDigest('finite-math-witness') },
    successTests: [{ id: 'factor', witnessType: 'integer_factorization', instance: { n: '91' } }],
  };
  const assignment = { taskId: world.taskId, projectId: P, submissionId: world.submission, author: world.solver.address, criteriaDigest: sha(TASK_CRITERIA) };
  const artifact = { schema: ARTIFACT_SCHEMA, taskId: world.taskId, submissionId: world.submission, author: world.solver.address, witnesses: { factor: { factors: ['7', '13'] } } };
  const result = await verifyEvidence({ taskPolicy: policy, assignment, artifact }, { runner: createRunner() });
  assert.deepEqual([result.verdict, result.mainKpiSatisfied, result.attestation.mainKpiSatisfied], ['pass', false, false]);
  // Bound to the native submission the scheduler produced. No module consumes this yet: the
  // central reviewer's verdict above was applied directly to the fixture chain.
  assert.deepEqual([result.attestation.submissionId, result.attestation.author], [world.submission, world.solver.address]);
});

test('FIXTURE: the report CLI writes reports the BAINK status projection accepts', async () => {
  const out = join(tempDir(), 'reports');
  const produced = await produceReports({ ...world.adapters, production: { chainId: FIXTURE_CHAIN }, outputDirectory: out }, { generatedAt: '2026-11-06T13:00:00.000Z' });
  assert.equal(produced.summary.operational.complete, false);
  const operator = 'uain1' + 'c'.repeat(40);
  const status = createOrganizationsStatus({ path: produced.paths.combined, operators: [operator] });
  const page = await status.page(new URLSearchParams({ page: '1', pageSize: '20' }));
  assert.deepEqual([page.complete.operational, page.complete.reward], [false, false]);
  const first = page.projects.find((r) => r.projectId === X);
  assert.equal(first.reward.status, 'pass');
  assert.equal(first.operational.columns.ceoRun.reason, 'no_actual_run:records_only_or_fixture');
  const unbound = page.projects.find((r) => r.projectId === selection.ids[1]);
  assert.match(unbound.operational.columns.organization.reason, /^binding_missing:paperclipCompanyId/);
});
