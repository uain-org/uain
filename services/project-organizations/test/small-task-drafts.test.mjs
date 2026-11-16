/** Drafted small follow-on tasks (docs/baink/project-organizations-2026-11-06/small-tasks-2026-11-07/drafts.json).
 *
 * Checks that every draft is in the exact shape the manager stage consumes and survives its real
 * gates: the leadership sanitizer (authority claims, signer words, other-project references, task
 * and price fields), the trusted prior-art query derivation, pricing within the round-1 allowance
 * and the fleet policy bound, and one batch of `central_task_open` requests per project.
 *
 * Every provider, retriever, assessment and native state here is a FIXTURE: no model was called,
 * no search was run, no native state was read. The fixture assessment says "no open solution";
 * in production that decision belongs to the independent fenced assessor, never to this test. */
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { CENTRAL_POLICY, centralPayload } from '../../../apps/baink/server/central-earning-command.mjs';
import { centralUnlockedUnits } from '../../../apps/baink/server/central-budget.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { openLeadershipStore } from '../src/leadership.mjs';
import { NATIVE_ROLE_OPERATIONS } from '../src/native.mjs';
import { createPriorArtSearch, deriveQueries } from '../src/prior-art.mjs';
import { GUARDIAN } from '../src/bootstrap.mjs';
import { sha256, units } from '../src/common.mjs';
import { acceptedSurvey } from './fixtures/survey-fixture.mjs';
import { CONFIG_SCHEMA, runManagerStage } from '../ops/manager-stage.mjs';

const DIR = new URL('../../../docs/baink/project-organizations-2026-11-06/small-tasks-2026-11-07/', import.meta.url);
const doc = JSON.parse(readFileSync(new URL('drafts.json', DIR), 'utf8'));
const catalogue = catalogueRecords(await loadCatalogue(fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url))));
const selection = await loadSelection();
const FUND_MANAGER = 'uain1a62e7d2841e34473b98a5fb8395019d1ca02b15c';
const AID = 1000000n;
/** Runbook 8c fleet policy revision 2: 9,750 AI$ per task and per batch. */
const MAX_TASK_UNITS = String(9750n * AID);
/** Round 1 after the 250 AI$ survey. */
const AVAILABLE = 9750n * AID;
const T0 = Date.parse('2026-11-07T12:00:00Z');
const pad = (n) => String(n).padStart(20, '0');
const jsonl = (value) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } }) + '\n';
const byProject = Map.groupBy(doc.drafts, (d) => d.projectId);

test('drafts file: schema, the ten pinned starter projects, unique keys and titles', () => {
  assert.equal(doc.schema, 'uain-small-task-drafts-v1');
  assert.equal(doc.status, 'draft_for_review');
  assert.deepEqual(doc.projects, ['OPP-00002', 'OPP-00003', 'OPP-00004', 'OPP-00005', 'OPP-00006', 'OPP-00007', 'OPP-00008', 'OPP-00009', 'OPP-00010', 'OPP-00014']);
  assert.ok(doc.drafts.length >= 10 && doc.drafts.length <= 15);
  assert.equal(new Set(doc.drafts.map((d) => d.key)).size, doc.drafts.length);
  assert.equal(new Set(doc.drafts.map((d) => d.task.title)).size, doc.drafts.length);
  for (const id of doc.projects) {
    const p = selection.get(id);
    assert.deepEqual(p.holds, [], `${id} is not held`);
    const n = byProject.get(id)?.length ?? 0;
    assert.ok(n >= 1 && n <= 2, `${id} has 1 or 2 drafts`);
  }
});

test('each draft: small reward, a fixed registry query in its criteria, and a recorded prior-art basis', () => {
  for (const d of doc.drafts) {
    const { task } = d;
    assert.equal(task.eligibility, 'new', d.key);
    const solver = units(task.proposed_price.solver_amount);
    const reviewer = units(task.proposed_price.reviewer_amount);
    assert.ok(solver >= 100n * AID && solver <= 250n * AID, `${d.key}: solver reward sized for under an hour`);
    assert.ok(reviewer > 0n && reviewer * 3n <= solver, `${d.key}: reviewer reward`);
    assert.ok(d.estimatedMinutes > 0 && d.estimatedMinutes <= 60, `${d.key}: under an hour`);
    assert.ok(task.criteria.includes(`query is exactly this ClinicalTrials.gov API v2 URL: ${d.registryQuery.url}`), `${d.key}: the criteria pin the query`);
    assert.equal(new URL(d.registryQuery.url).origin, 'https://clinicaltrials.gov');
    assert.ok(/16 KiB/.test(task.criteria) && /\(0\/1\)/.test(task.criteria), `${d.key}: bounded artifact and binary outcome`);
    assert.ok(d.registryQuery.observedTotal >= 5 && d.registryQuery.observedTotal <= 80, `${d.key}: a set small enough for one sitting`);
    assert.ok(deriveQueries(task).length >= 1 && deriveQueries(task)[0].length >= 2, `${d.key}: the trusted search can derive queries`);
    const searches = d.priorArt.searches;
    assert.ok(searches.length >= 2 && new Set(searches.map((s) => s.query)).size >= 2, `${d.key}: at least two distinct searches`);
    assert.ok(searches.filter((s) => s.source.startsWith('WebSearch')).length >= 1, `${d.key}: at least one web search`);
    for (const s of searches) assert.ok(s.query.length >= 3 && s.finding.length >= 10 && !Number.isNaN(Date.parse(s.observedAt)), d.key);
    assert.match(d.priorArt.conclusion, /^No open solution found/, d.key);
  }
  for (const x of doc.dropped) assert.ok(x.candidate && x.search && x.reason.length >= 20 && doc.projects.includes(x.projectId));
});

/* ------------------------------------------------ FIXTURE manager-stage run per project */

function nativeRecords(ID) {
  const P = 'P-' + ID;
  const s = acceptedSurvey(ID);
  const stages = Array.from({ length: 5 }, (_, i) => ({ round: i + 1, criteria: `FIXTURE stage ${i + 1} criteria for the unchanged Main KPI of this project.` }));
  const r = {
    [`project/${P}`]: { id: P, state: 'active', lead: GUARDIAN, safety_halted: false },
    [`central_project_budget/${P}`]: {
      project: P, manager: GUARDIAN, policy: CENTRAL_POLICY, allocation: centralUnlockedUnits(1), round: 1, lifetime_ceiling: '1000000000000000',
      reserved: s.task.reserved ?? '0', paid: s.task.paid ?? '0', height: '100', evidence_digest: 'b'.repeat(64),
    },
    [`central_fund_config/${P}`]: { project: P, evaluator: FUND_MANAGER },
    [`central_fund_state/${P}`]: { project: P, revision: 1, approved_revision: 1, completed: 0, pending: '' },
    [`central_fund_plan/${P}/${pad(1)}`]: { project: P, revision: 1, state: 'accept', main_kpi: selection.get(ID).mainKpi, stages },
    coin_supply: { minted: '0', reserved: '750000000', transparent: '0', shielded: '0' },
    central_task_count: '1',
    [`central_task_index/${pad(1)}`]: { id: s.task.id, project: P },
    [`central_task/${s.task.id}`]: s.task,
    ...s.records,
  };
  return r;
}
const statusOf = (records) => async (keys) => ({ status: 'read', height: '120', app_hash: 'a'.repeat(64),
  records: Object.fromEntries(keys.map((k) => [k, records[k] ?? null])) });
const BODIES = {
  'api.github.com': () => JSON.stringify({ total_count: 0, items: [] }),
  'export.arxiv.org': () => '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  'api.crossref.org': () => JSON.stringify({ message: { 'total-results': 1, items: [{ DOI: '10.1000/fixture', title: ['FIXTURE work'] }] } }),
  'api.semanticscholar.org': () => JSON.stringify({ total: 0, data: [] }),
};
const retriever = { async observe(url) {
  const bytes = Buffer.from(BODIES[new URL(url).hostname]());
  return { url, bytes, sha256: sha256(bytes) };
} };
function provider(ID, tasks) {
  const calls = [];
  return { calls, fixture: false, model: 'fixture-model', async execute({ role, executionId, prompt }) {
    calls.push({ role, prompt });
    const answer = role === 'ceo' ? { main_kpi: selection.get(ID).mainKpi, strategy: 'FIXTURE strategy: build on the gaps the accepted survey names.', blockers: [] }
      : role === 'manager' ? { main_kpi: selection.get(ID).mainKpi, round: 1, tasks }
        : { openSolutionFound: false, knownAnswer: false, rationale: 'FIXTURE assessment only: not a novelty decision.' };
    return { raw: jsonl(answer), receipt: { executionId, model: 'fixture-model', startedAt: '2026-11-07T11:00:00.000Z', finishedAt: '2026-11-07T11:00:05.000Z', actual: true } };
  } };
}

for (const [ID, drafts] of byProject) {
  test(`${ID}: drafts pass the real manager-stage gates and price into one batch within the round-1 allowance (FIXTURE run)`, async () => {
    const P = 'P-' + ID;
    const stageRoot = mkdtempSync(join(tmpdir(), 'small-tasks-'));
    try {
      const tasks = drafts.map((d) => d.task);
      const prov = provider(ID, tasks);
      let n = 0;
      const store = openLeadershipStore({ directory: join(stageRoot, 'leadership') });
      const policy = {
        schema: 'uain-project-organization-fleet-policy-v1', revision: 2, selection_digest: selection.digest,
        projects: { [ID]: { native_project: P, source_digest: selection.get(ID).sourceDigest, paperclip_company: null, manager: GUARDIAN,
          evaluator: FUND_MANAGER, max_task_units: MAX_TASK_UNITS, max_plan_revision: 3 } },
        roles: Object.fromEntries(Object.entries(NATIVE_ROLE_OPERATIONS).map(([k, v]) => [k, [...v]])), solvers: [],
      };
      const summary = await runManagerStage({
        config: { schema: CONFIG_SCHEMA, projects: [ID], max_projects_per_run: 1, cooldown_minutes: 360, max_executions_per_day: 40 },
        projects: [ID], selection, catalogue, policy, status: statusOf(nativeRecords(ID)), provider: prov,
        priorArt: createPriorArtSearch({ retriever, clock: () => T0 - 60e3 }),
        store, stageRoot, now: () => T0,
        newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
        // FIXTURE pre-open admission: a compiled verification contract per priced task.
        preOpen: { compile: ({ task }) => ({ contractDigest: createHash('sha256').update('FIXTURE contract ' + task.id).digest('hex') }) },
      });
      assert.deepEqual(summary.skipped, []);
      assert.equal(summary.runs[0]?.status, 'batched', JSON.stringify(summary.runs[0]));
      const manager = store.list({ projectId: ID }).find((r) => r.role === 'manager');
      assert.equal(manager.status, 'completed');
      assert.deepEqual(manager.findings, [], 'the sanitizer stripped nothing');
      assert.deepEqual(manager.result.tasks.map((t) => t.title), tasks.map((t) => t.title));
      const dir = join(stageRoot, 'batches', ID);
      const [batch] = readdirSync(dir).filter((f) => !f.endsWith('.refused.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
      assert.equal(batch.requests.length, drafts.length, 'every draft is priced');
      let total = 0n;
      batch.requests.forEach((r, i) => {
        assert.equal(r.operation, 'central_task_open');
        assert.equal(r.member, GUARDIAN);
        assert.equal(r.payload.project, P);
        assert.equal(r.payload.title, tasks[i].title);
        assert.deepEqual(centralPayload('central_task_open', r.payload), r.payload);
        assert.equal(r.payload.solver_amount, tasks[i].proposed_price.solver_amount);
        total += BigInt(r.payload.solver_amount) + BigInt(r.payload.reviewer_amount);
      });
      assert.equal(batch.totalUnits, total.toString());
      assert.ok(total <= AVAILABLE);
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  });
}

test('all drafts together stay far inside the ten round-1 allowances', () => {
  let total = 0n;
  for (const d of doc.drafts) total += units(d.task.proposed_price.solver_amount) + units(d.task.proposed_price.reviewer_amount);
  assert.ok(total <= 10n * AVAILABLE);
  for (const [, drafts] of byProject) {
    const t = drafts.reduce((a, d) => a + units(d.task.proposed_price.solver_amount) + units(d.task.proposed_price.reviewer_amount), 0n);
    assert.ok(t <= 500n * AID, 'at most 500 AI$ per project from these drafts');
  }
});
