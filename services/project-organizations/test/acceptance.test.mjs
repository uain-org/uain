import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELECTION_PATH, validateSelection } from '../src/selection.mjs';
import { openRegistry } from '../src/registry.mjs';
import { openJournal } from '../src/journal.mjs';
import { createFundModel } from '../src/fund-model.mjs';
import { OPERATIONAL_COLUMNS, REWARD_COLUMNS, buildAcceptance, writeReports } from '../src/acceptance.mjs';

const selection = validateSelection(JSON.parse(readFileSync(SELECTION_PATH, 'utf8')));
const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uain-acceptance-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const PRODUCTION = { chainId: 'uain-production-pin' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
let n = 100;
const addr = () => 'uain1' + (++n).toString(16).padStart(40, '0');
const [A, B] = selection.ids;
const HELD = 'OPP-08881';
const at = '2026-11-06T12:00:00.000Z';

/** Test-only: relabel a fund-model snapshot as if read from a finalized production proof, so the
 * acceptance logic itself can be exercised. Such a relabelled object is never written anywhere. */
const asProduction = (snap) => {
  const s = structuredClone(snap);
  delete s.fixture;
  delete s.proof.fixture;
  s.proof.chainId = PRODUCTION.chainId;
  return s;
};

/** Runs one project's native flow in the semantic model and returns its fixture snapshot. */
function nativeFlow(p, { verdict = 'accept', review = true, submit = true } = {}) {
  const guardian = addr(), reviewer = addr(), manager = addr(), evaluator = addr(), solver = addr();
  const m = createFundModel({ guardian, reviewer });
  for (const x of [manager, evaluator, solver]) m.enroll(x);
  m.createProject({ project: p.nativeProjectId, lead: guardian });
  m.join({ project: p.nativeProjectId, member: solver });
  m.start({ actor: guardian, project: p.nativeProjectId, manager });
  m.configure({ actor: guardian, project: p.nativeProjectId, evaluator });
  m.plan({ actor: evaluator, project: p.nativeProjectId, revision: 1, mainKpi: p.kpi.statement, reason: 'Independent five-stage plan',
    stages: [1, 2, 3, 4, 5].map((round) => ({ round, criteria: `Stage ${round} measurable criterion for ${p.id}` })) });
  m.reviewPlan({ actor: evaluator, project: p.nativeProjectId, revision: 1, verdict: 'accept' });
  const taskId = `task-${p.id}`;
  const t = m.openTask({ actor: manager, id: taskId, project: p.nativeProjectId, criteria: 'Exact criteria', solverAmount: '4000000', reviewerAmount: '1000000' });
  const sub = `sub-${p.id}`;
  if (submit) m.submit({ actor: solver, id: sub, task: taskId, evidence: 'evidence' });
  if (submit && review) m.review({ actor: reviewer, submission: sub, verdict, executionId: 'exec-1', criteriaDigest: t.acceptanceDigest, evidenceDigest: sha('evidence') });
  return { snapshot: m.snapshot(p.nativeProjectId), manager, evaluator, solver, reviewer, taskId, sub, model: m };
}

function world() {
  const registry = openRegistry({ directory: tempDir(), selection });
  const journal = openJournal({ directory: tempDir() });
  return { registry, journal, natives: new Map(), papers: new Map(), runs: new Map(), attempts: new Map(), readbacks: new Map() };
}
/** Supplies complete evidence for one project; returns the flow for further tampering. */
function complete(w, id, options = {}) {
  const p = selection.get(id);
  const flow = nativeFlow(p, options);
  const company = randomUUID(), ceo = randomUUID(), mgr = randomUUID();
  w.registry.bind(id, { nativeProjectId: p.nativeProjectId, nativeManager: flow.manager, nativeEvaluator: flow.evaluator, paperclipCompanyId: company, ceoAgentId: ceo, managerAgentId: mgr });
  w.papers.set(id, { projectId: id, readAt: at, company: { id: company }, agents: [{ id: ceo, role: 'ceo', reportsTo: null }, { id: mgr, role: 'manager', reportsTo: ceo }] });
  w.runs.set(id, [
    { runId: 'run-ceo', projectId: id, companyId: company, agentId: ceo, role: 'ceo', actual: true, outcome: 'completed', finishedAt: at },
    { runId: 'run-mgr', projectId: id, companyId: company, agentId: mgr, role: 'manager', actual: true, outcome: 'completed', finishedAt: at },
  ]);
  w.attempts.set(id, [{ attemptId: 'attempt-1', projectId: id, taskId: flow.taskId, leaseId: 'lease-1', actual: true, bounded: true, outcome: 'completed', finishedAt: at }]);
  w.natives.set(id, asProduction(flow.snapshot));
  const earnings = (m) => flow.snapshot.records['central_earnings/' + m];
  w.readbacks.set(id, [flow.solver, flow.reviewer].filter(earnings).map((member) => ({ member, total: earnings(member).total, readAt: at })));
  return { p, flow, company, ceo, mgr };
}
const build = (w, extra = {}) => buildAcceptance({ selection, registry: w.registry, journal: w.journal, nativeSnapshots: w.natives, paperclipSnapshots: w.papers,
  leadershipRuns: w.runs, workerAttempts: w.attempts, accountReadbacks: w.readbacks, production: PRODUCTION, generatedAt: at, ...extra });
const row = (report, id) => report.projects.find((r) => r.projectId === id);
const cellOf = (report, id, c) => row(report, id).columns[c];

test('with no evidence all 120 rows exist, nothing passes and unknown is not counted as fail-as-pass', () => {
  const w = world();
  const { operationalReadiness: op, rewardAcceptance: rw } = build(w);
  for (const r of [op, rw]) {
    assert.equal(r.projects.length, 120);
    assert.deepEqual(r.projects.map((x) => x.projectId), [...selection.ids]);
    assert.equal(r.complete, false);
    assert.equal(r.counts.rows.pass, 0);
  }
  assert.deepEqual(op.columns, [...OPERATIONAL_COLUMNS]);
  assert.deepEqual(rw.columns, [...REWARD_COLUMNS]);
  assert.equal(cellOf(op, A, 'organization').reason, 'binding_missing:paperclipCompanyId,ceoAgentId,managerAgentId');
  assert.deepEqual(cellOf(op, A, 'nativeAdmission'), { status: 'unknown', evidence: null, reason: 'native_snapshot_unavailable' });
  assert.equal(cellOf(rw, A, 'awards').status, 'unknown');
  assert.equal(op.counts.columns.nativeAdmission.unknown, 120);
  for (const s of op.stages) assert.equal(s.reached, false);
  // Counts always total 120 per column.
  for (const c of OPERATIONAL_COLUMNS) assert.equal(Object.values(op.counts.columns[c]).reduce((a, b) => a + b, 0), 120);
});

test('OPP-08881 stays held with main_kpi_below_native_minimum and is never replaced', () => {
  const w = world();
  const { operationalReadiness: op, rewardAcceptance: rw } = build(w);
  const held = row(op, HELD);
  assert.equal(held.status, 'held');
  assert.deepEqual(held.holds, ['main_kpi_below_native_minimum']);
  for (const c of ['approvedPlan', 'reservedTask', 'workerAttempt']) assert.deepEqual(held.columns[c], { status: 'held', evidence: null, reason: 'main_kpi_below_native_minimum' });
  for (const c of REWARD_COLUMNS) assert.equal(cellOf(rw, HELD, c).status, 'held');
  assert.equal(held.columns.organization.status, 'missing');
  assert.equal(op.counts.rows.held, 1);
  assert.equal(op.projects.filter((r) => r.projectId === HELD).length, 1);
});

test('a project with complete production evidence passes both reports; stage one is reached', () => {
  const w = world();
  complete(w, A);
  const { operationalReadiness: op, rewardAcceptance: rw } = build(w);
  for (const c of OPERATIONAL_COLUMNS) assert.equal(cellOf(op, A, c).status, 'pass', `${c}: ${cellOf(op, A, c).reason}`);
  for (const c of REWARD_COLUMNS) assert.equal(cellOf(rw, A, c).status, 'pass', `${c}: ${cellOf(rw, A, c).reason}`);
  assert.equal(row(op, A).status, 'pass');
  assert.equal(cellOf(op, A, 'allowance').evidence.allocation, '10000000000');
  assert.equal(cellOf(rw, A, 'awards').evidence.awards.length, 2);
  assert.equal(op.stages[0].reached, true);
  assert.equal(op.stages[1].reached, false);
  assert.equal(op.complete, false);
  assert.equal(op.counts.rows.pass, 1);
});

test('fixture, non-production, unfinalized and unpinned native proofs never fill a row', () => {
  const w = world();
  const { flow } = complete(w, A);
  w.natives.set(A, flow.snapshot);
  let op = build(w).operationalReadiness;
  assert.equal(cellOf(op, A, 'nativeAdmission').reason, 'fixture_evidence_not_production');
  assert.equal(cellOf(op, A, 'nativeAdmission').status, 'missing');
  const other = asProduction(flow.snapshot);
  other.proof.chainId = 'uain-shadow-20261008-1';
  w.natives.set(A, other);
  assert.equal(cellOf(build(w).operationalReadiness, A, 'approvedPlan').reason, 'non_production_chain');
  const pending = asProduction(flow.snapshot);
  pending.proof.finalized = false;
  w.natives.set(A, pending);
  assert.equal(cellOf(build(w).rewardAcceptance, A, 'awards').reason, 'native_proof_not_finalized');
  w.natives.set(A, asProduction(flow.snapshot));
  op = build(w, { production: null }).operationalReadiness;
  assert.deepEqual(cellOf(op, A, 'allowance'), { status: 'unknown', evidence: null, reason: 'production_chain_unpinned' });
});

test("another project's snapshot or receipts can never fill a row", () => {
  const w = world();
  const a = complete(w, A);
  complete(w, B);
  // A's snapshot under B.
  w.natives.set(B, asProduction(a.flow.snapshot));
  let r = build(w);
  assert.equal(cellOf(r.operationalReadiness, B, 'nativeAdmission').reason, 'snapshot_project_mismatch');
  // B's own snapshot with A's task, submission, review and awards merged in.
  const pB = selection.get(B);
  const bFlow = nativeFlow(pB, { submit: false });
  const mixed = asProduction(bFlow.snapshot);
  for (const [k, v] of Object.entries(a.flow.snapshot.records)) if (/^central_(task|submission|review|award)\//.test(k)) mixed.records[k] = v;
  delete mixed.records['central_task/' + bFlow.taskId];
  w.natives.set(B, mixed);
  w.attempts.set(B, [{ attemptId: 'x', projectId: B, taskId: a.flow.taskId, leaseId: 'l', actual: true, bounded: true, outcome: 'completed', finishedAt: at }]);
  r = build(w);
  assert.equal(cellOf(r.operationalReadiness, B, 'reservedTask').reason, 'no_reserved_task');
  assert.equal(cellOf(r.operationalReadiness, B, 'workerAttempt').reason, 'attempt_task_not_in_project');
  assert.equal(cellOf(r.rewardAcceptance, B, 'submission').reason, 'no_native_submission');
  assert.equal(cellOf(r.rewardAcceptance, B, 'awards').status, 'missing');
  // A worker attempt recorded under A but naming project B is not A's attempt either.
  w.attempts.set(A, [{ attemptId: 'y', projectId: B, taskId: a.flow.taskId, leaseId: 'l', actual: true, bounded: true, outcome: 'completed', finishedAt: at }]);
  assert.equal(cellOf(build(w).operationalReadiness, A, 'workerAttempt').reason, 'no_actual_attempt');
});

test('reject pays the reviewer only; a solver award on reject or a self-review fails the row', () => {
  const w = world();
  const { flow } = complete(w, A, { verdict: 'reject' });
  let rw = build(w).rewardAcceptance;
  assert.equal(cellOf(rw, A, 'independentReview').evidence.verdict, 'reject');
  assert.deepEqual(cellOf(rw, A, 'awards').evidence.awards.map((x) => x.role), ['reviewer']);
  assert.equal(cellOf(rw, A, 'accountReadback').status, 'pass');
  assert.equal(cellOf(build(w).operationalReadiness, A, 'reservedTask').status, 'pass');
  const forged = asProduction(flow.snapshot);
  forged.records[`central_award/solver/${flow.sub}`] = { submission: flow.sub, task: flow.taskId, project: selection.get(A).nativeProjectId, member: flow.solver, role: 'solver', amount: '4000000' };
  w.natives.set(A, forged);
  assert.equal(cellOf(build(w).rewardAcceptance, A, 'awards').reason, 'unexpected_solver_award_on_reject');
  const self = asProduction(flow.snapshot);
  for (const k of Object.keys(self.records)) if (k.startsWith('central_review/')) self.records[k].reviewer = flow.solver;
  w.natives.set(A, self);
  rw = build(w).rewardAcceptance;
  assert.equal(cellOf(rw, A, 'independentReview').reason, 'reviewer_is_author');
  assert.equal(cellOf(rw, A, 'awards').status, 'missing');
});

test('needs_evidence is not final; accept without the exact solver award is not accepted', () => {
  const w = world();
  const p = selection.get(A);
  const { flow } = complete(w, A, { review: false });
  flow.model.review({ actor: flow.reviewer, submission: flow.sub, verdict: 'needs_evidence', executionId: 'exec-ne', criteriaDigest: flow.model.task(flow.taskId).acceptanceDigest, evidenceDigest: sha('evidence') });
  w.natives.set(A, asProduction(flow.model.snapshot(p.nativeProjectId)));
  let rw = build(w).rewardAcceptance;
  assert.equal(cellOf(rw, A, 'submission').status, 'pass');
  assert.equal(cellOf(rw, A, 'independentReview').reason, 'needs_evidence_not_final');
  assert.equal(cellOf(rw, A, 'awards').status, 'missing');
  const accepted = complete(w, B);
  const tampered = asProduction(accepted.flow.snapshot);
  tampered.records[`central_award/solver/${accepted.flow.sub}`].amount = '4000001';
  w.natives.set(B, tampered);
  rw = build(w).rewardAcceptance;
  assert.equal(cellOf(rw, B, 'awards').reason, 'solver_award_missing_or_inexact');
  delete tampered.records[`central_award/solver/${accepted.flow.sub}`];
  assert.equal(cellOf(build(w).rewardAcceptance, B, 'awards').reason, 'solver_award_missing_or_inexact');
});

test('leadership runs count only when actual, non-fixture, bound and completed', () => {
  const w = world();
  const { company, ceo } = complete(w, A);
  const base = { runId: 'r', projectId: A, companyId: company, agentId: ceo, role: 'ceo', finishedAt: at };
  const cases = [
    [{ ...base, actual: false, outcome: 'completed' }, 'no_actual_run:records_only_or_fixture'],
    [{ ...base, actual: true, fixture: true, outcome: 'completed' }, 'no_actual_run:records_only_or_fixture'],
    [{ ...base, actual: true, agentId: randomUUID(), outcome: 'completed' }, 'no_actual_run:records_only_or_fixture'],
    [{ ...base, actual: true, outcome: 'failed' }, 'last_actual_run_failed'],
  ];
  for (const [run, reason] of cases) {
    w.runs.set(A, [run]);
    const c = cellOf(build(w).operationalReadiness, A, 'ceoRun');
    assert.equal(c.status, 'missing');
    assert.equal(c.reason, reason);
  }
  w.runs.delete(A);
  assert.equal(cellOf(build(w).operationalReadiness, A, 'managerRun').reason, 'no_actual_run');
});

test('organization requires bound IDs and a matching Paperclip readback', () => {
  const w = world();
  const { company, ceo, mgr } = complete(w, A);
  const good = w.papers.get(A);
  w.papers.delete(A);
  assert.equal(cellOf(build(w).operationalReadiness, A, 'organization').reason, 'paperclip_readback_unavailable');
  w.papers.set(A, { ...good, company: { id: randomUUID() } });
  assert.equal(cellOf(build(w).operationalReadiness, A, 'organization').reason, 'paperclip_company_mismatch');
  w.papers.set(A, { ...good, agents: [{ id: ceo, role: 'ceo' }, { id: mgr, role: 'manager', reportsTo: null }] });
  assert.equal(cellOf(build(w).operationalReadiness, A, 'organization').reason, 'manager_does_not_report_to_ceo');
  w.papers.set(A, { ...good, projectId: B });
  assert.equal(cellOf(build(w).operationalReadiness, A, 'organization').reason, 'paperclip_readback_project_mismatch');
  w.papers.set(A, { ...good, fixture: true });
  assert.equal(cellOf(build(w).operationalReadiness, A, 'organization').reason, 'fixture_evidence_not_production');
  w.papers.set(A, good);
  assert.deepEqual(cellOf(build(w).operationalReadiness, A, 'organization').evidence, { companyId: company, ceoAgentId: ceo, managerAgentId: mgr, readAt: at });
});

test('unresolved journal intents make the affected columns unknown; no journal means no missing claims', () => {
  const w = world();
  const p = selection.get(B);
  const intent = w.journal.prepare({ id: 'open-task-b', projectId: B, kind: 'native', operation: 'central_task_open', payload: { task: 'x' },
    selectionDigest: selection.digest, sourceDigest: p.sourceDigest, signer: addr() });
  w.journal.claim(intent.id, 'owner');
  w.journal.markUnknown(intent.id);
  complete(w, A);
  const flow = nativeFlow(p, { submit: false });
  const noTask = asProduction(flow.snapshot);
  delete noTask.records['central_task/' + flow.taskId];
  w.natives.set(B, noTask);
  const op = build(w).operationalReadiness;
  assert.deepEqual(cellOf(op, B, 'reservedTask'), { status: 'unknown', evidence: { intentId: 'open-task-b', operation: 'central_task_open', state: 'unknown' }, reason: 'journal_outcome_unknown' });
  assert.equal(cellOf(op, A, 'reservedTask').status, 'pass');
  const without = build(w, { journal: null }).operationalReadiness;
  assert.equal(cellOf(without, B, 'organization').reason, 'journal_unavailable');
  assert.equal(cellOf(without, A, 'organization').status, 'pass');
});

test('a changed Main KPI in the native plan is not the approved plan', () => {
  const w = world();
  const { flow } = complete(w, A);
  const changed = asProduction(flow.snapshot);
  for (const [k, v] of Object.entries(changed.records)) if (k.startsWith('central_fund_plan/')) v.main_kpi = 'A relaxed, rewritten Main KPI statement';
  w.natives.set(A, changed);
  assert.equal(cellOf(build(w).operationalReadiness, A, 'approvedPlan').reason, 'main_kpi_changed');
});

test('account readback must match native lifetime earnings; stale or absent display is unknown', () => {
  const w = world();
  const { flow } = complete(w, A);
  w.readbacks.set(A, [{ member: flow.solver, total: '1', readAt: at }, { member: flow.reviewer, total: '1000000', readAt: at }]);
  assert.equal(cellOf(build(w).rewardAcceptance, A, 'accountReadback').reason, 'account_display_stale');
  w.readbacks.delete(A);
  assert.equal(cellOf(build(w).rewardAcceptance, A, 'accountReadback').reason, 'account_display_readback_unavailable');
});

test('unread native record classes and unreadable per-project sources are unknown, never missing', () => {
  const w = world();
  complete(w, A);
  const { flow } = complete(w, B, { submit: false });
  // B never submitted; with reviews unread that is still a genuine `missing` submission.
  w.natives.get(B).unread = ['central_review/'];
  // A's tasks were not read: everything that depends on them is unknown, not missing.
  const snap = w.natives.get(A);
  for (const k of Object.keys(snap.records)) if (/^central_(task|submission|review|award|earnings)\//.test(k)) delete snap.records[k];
  snap.unread = ['central_task/', 'central_submission/', 'central_review/', 'central_award/', 'central_earnings/'];
  w.runs.set(A, { unavailable: 'leadership_store_unreadable' });
  w.readbacks.set(B, { unavailable: 'account_readback_unreadable' });
  const { operationalReadiness: op, rewardAcceptance: rw } = build(w);
  assert.deepEqual([cellOf(op, A, 'reservedTask').status, cellOf(op, A, 'reservedTask').reason], ['unknown', 'native_records_unread']);
  for (const c of REWARD_COLUMNS) assert.equal(cellOf(rw, A, c).reason, 'native_records_unread', c);
  assert.equal(cellOf(op, A, 'nativeAdmission').status, 'pass', 'what was read still counts');
  for (const c of ['ceoRun', 'managerRun']) assert.deepEqual([cellOf(op, A, c).status, cellOf(op, A, c).reason], ['unknown', 'leadership_store_unreadable']);
  assert.deepEqual([cellOf(rw, B, 'submission').status, cellOf(rw, B, 'submission').reason], ['missing', 'no_native_submission']);
  assert.equal(flow.sub, 'sub-' + B);
  const broken = buildAcceptance({ selection, registry: { get: () => { throw new Error('locked'); } }, journal: w.journal, production: PRODUCTION });
  assert.deepEqual([cellOf(broken.operationalReadiness, A, 'ceoRun').status, cellOf(broken.operationalReadiness, A, 'ceoRun').reason], ['unknown', 'registry_unavailable']);
});

test('writeReports writes the two distinct reports and a combined projection file', () => {
  const w = world();
  complete(w, A);
  const acceptance = build(w);
  const dir = join(tempDir(), 'reports');
  const paths = writeReports(dir, acceptance);
  assert.deepEqual(Object.keys(paths), ['operationalReadiness', 'rewardAcceptance', 'combined']);
  const op = JSON.parse(readFileSync(join(dir, 'operational-readiness.json'), 'utf8'));
  const rw = JSON.parse(readFileSync(join(dir, 'reward-acceptance.json'), 'utf8'));
  const combined = JSON.parse(readFileSync(join(dir, 'acceptance.json'), 'utf8'));
  assert.equal(op.schema, 'uain-project-organization-operational-readiness-v1');
  assert.equal(rw.schema, 'uain-project-organization-reward-acceptance-v1');
  assert.equal(combined.operationalReadiness.projects.length, 120);
  assert.equal(statSync(join(dir, 'acceptance.json')).mode & 0o777, 0o640);
  assert.equal(JSON.stringify(op).includes('secret'), false);
  const broken = structuredClone(acceptance);
  broken.rewardAcceptance.projects.pop();
  assert.throws(() => writeReports(dir, broken), (e) => e.code === 'invalid_acceptance_report');
  const lying = structuredClone(acceptance);
  lying.operationalReadiness.complete = true;
  assert.throws(() => writeReports(dir, lying), (e) => e.code === 'invalid_acceptance_report');
});


test('reviewed prior-art holds hold every unpassed cell of that project, never as missing', async () => {
  const { bootstrapHoldsFrom } = await import('../src/acceptance.mjs');
  const dir = new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/', import.meta.url);
  const holds = bootstrapHoldsFrom(dir.pathname, selection);
  assert.equal(Object.keys(holds).length, 24);
  assert.equal(holds['OPP-04561'], 'prior_art_open_solution_found');
  const a = buildAcceptance({ selection, bootstrapHolds: holds, generatedAt: '2026-11-06T00:00:00Z' });
  const row = a.operationalReadiness.projects.find((r) => r.projectId === 'OPP-04561');
  assert.equal(row.status, 'held');
  assert.ok(Object.values(row.columns).every((c) => c.status === 'held' && c.reason === 'prior_art_open_solution_found'));
  assert.ok(row.holds.includes('prior_art_open_solution_found'));
  const open = a.operationalReadiness.projects.find((r) => r.projectId === 'OPP-00002');
  assert.notEqual(open.status, 'held');
  // 24 reviewed prior-art holds plus any selection hold (this fixture uses the unamended selection).
  const selectionHeld = selection.projects.filter((p) => p.holds.length && !holds[p.id]).length;
  assert.equal(a.operationalReadiness.counts.rows.held, 24 + selectionHeld);
  assert.equal(a.operationalReadiness.complete, false);
});
