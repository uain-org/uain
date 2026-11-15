import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SELECTION_PATH, validateSelection } from '../src/selection.mjs';
import { digest } from '../src/common.mjs';
import { OPERATIONAL_SCHEMA } from '../src/acceptance.mjs';
import { RELEASE_SCHEMA, ROLLOUT_STAGES, manifestDigest, planStage } from '../ops/rollout.mjs';

const selectionJson = JSON.parse(readFileSync(SELECTION_PATH, 'utf8'));
const selection = validateSelection(selectionJson);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const HELD = 'OPP-08881';

function release() {
  const body = {
    schema: RELEASE_SCHEMA,
    selectionDigest: selection.digest,
    selection: structuredClone(selectionJson),
    files: [{ path: 'services/project-organizations/src/acceptance.mjs', sha256: sha('a') }, { path: 'services/project-organizations/src/registry.mjs', sha256: sha('r') }],
    pins: { nativeBinarySha256: sha('native'), paperclipRevision: 'abc123', custodySourceSha256: sha('custody') },
    hosts: ['app-host', 'uain-database'],
    preflight: { stages: Object.fromEntries(ROLLOUT_STAGES.map((n) => [String(n), { minimumAvailableMemoryMiB: 1024 + n * 16, minimumFreeDiskMiB: 4096 + n * 64 }])) },
  };
  return { ...body, digest: digest(body) };
}
/** Operational report shaped like acceptance.mjs output, with the first `passing` rows passing. */
function report(passing, { failId = null } = {}) {
  return {
    schema: OPERATIONAL_SCHEMA,
    selectionDigest: selection.digest,
    projects: selection.projects.map((p, i) => ({
      projectId: p.id,
      status: p.holds.length ? 'held' : p.id === failId ? 'incomplete' : i < passing ? 'pass' : 'incomplete',
    })),
  };
}
function input(overrides = {}) {
  const manifest = release();
  return {
    selectionDigest: selection.digest,
    manifest,
    reviewedManifestDigest: manifest.digest,
    observedFiles: Object.fromEntries(manifest.files.map((f) => [f.path, f.sha256])),
    stage: 1,
    priorReport: null,
    host: { memMb: 8192, diskMb: 100000 },
    backupAgeHours: 2,
    computeStatus: { state: 'available' },
    pins: { 'app-host': { ...manifest.pins }, 'uain-database': { ...manifest.pins } },
    journal: { unresolved: [] },
    ...overrides,
  };
}
const codes = (plan) => plan.refusals.map((r) => r.code);
const deepFreeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

test('stage one with every gate satisfied is allowed and contains only the first frozen ID', () => {
  const plan = planStage(deepFreeze(input()));
  assert.deepEqual(plan.refusals, []);
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.projects, [selection.ids[0]]);
  assert.equal(plan.productionChange, false);
  assert.equal(manifestDigest(release()), release().digest);
});

test('stage membership is the first N in frozen order; held projects stay held and are never replaced', () => {
  const plan = planStage(input({ stage: 120, priorReport: report(20) }));
  assert.equal(plan.allowed, true, JSON.stringify(plan.refusals));
  assert.deepEqual(plan.projects, [...selection.ids]);
  assert.deepEqual(plan.newProjects, selection.ids.slice(20));
  assert.deepEqual(plan.held, [{ projectId: HELD, holds: ['main_kpi_below_native_minimum'] }]);
  assert.equal(new Set(plan.projects).size, 120);
  const five = planStage(input({ stage: 5, priorReport: report(1) }));
  assert.deepEqual(five.projects, selection.ids.slice(0, 5));
  assert.deepEqual(five.newProjects, selection.ids.slice(1, 5));
  // A failed project inside a prior stage blocks; it is not swapped for the next ID.
  const failed = planStage(input({ stage: 20, priorReport: report(5, { failId: selection.ids[3] }) }));
  assert.deepEqual(codes(failed), ['prior_stage_failed']);
  assert.equal(failed.refusals[0].detail, selection.ids[3]);
  assert.deepEqual(failed.projects, selection.ids.slice(0, 20));
});

test('refuses a later stage without a passing prior stage report', () => {
  assert.deepEqual(codes(planStage(input({ stage: 5 }))), ['prior_stage_report_missing']);
  assert.deepEqual(codes(planStage(input({ stage: 5, priorReport: report(0) }))), ['prior_stage_failed']);
  assert.deepEqual(codes(planStage(input({ stage: 20, priorReport: report(1) }))), ['prior_stage_failed']);
  const reordered = report(5);
  [reordered.projects[0], reordered.projects[1]] = [reordered.projects[1], reordered.projects[0]];
  assert.deepEqual(codes(planStage(input({ stage: 20, priorReport: reordered }))), ['selection_drift']);
  assert.deepEqual(codes(planStage(input({ stage: 20, priorReport: { ...report(5), selectionDigest: sha('other') } }))), ['selection_drift']);
  assert.deepEqual(codes(planStage(input({ stage: 7 }))), ['invalid_stage', 'capacity_requirements_unpinned']);
});

test('refuses selection drift', () => {
  const m = release();
  const drifted = structuredClone(m.selection);
  drifted.projects[0].sourceDigest = sha('changed');
  const body = { ...m, selection: drifted };
  delete body.digest;
  const manifest = { ...body, digest: digest(body) };
  const plan = planStage(input({ manifest, reviewedManifestDigest: manifest.digest }));
  assert.ok(codes(plan).includes('selection_drift'));
  assert.equal(plan.allowed, false);
  assert.ok(codes(planStage(input({ selectionDigest: sha('elsewhere') }))).includes('selection_drift'));
  const swapped = structuredClone(m.selection);
  swapped.projects[0].id = 'OPP-99999';
  assert.ok(codes(planStage(input({ manifest: { ...m, selection: swapped } }))).some((c) => c === 'selection_drift' || c === 'source_manifest_tampered'));
});

test('refuses source manifest tampering and unreviewed source bytes', () => {
  const m = release();
  const edited = { ...m, pins: { ...m.pins, paperclipRevision: 'evil' } };
  assert.ok(codes(planStage(input({ manifest: edited }))).includes('source_manifest_tampered'));
  const resigned = { ...edited };
  delete resigned.digest;
  const rehashed = { ...resigned, digest: digest(resigned) };
  assert.ok(codes(planStage(input({ manifest: rehashed, pins: { 'app-host': rehashed.pins, 'uain-database': rehashed.pins } }))).includes('source_manifest_tampered'));
  const observed = Object.fromEntries(m.files.map((f) => [f.path, f.sha256]));
  observed[m.files[0].path] = sha('tampered');
  assert.deepEqual(codes(planStage(input({ observedFiles: observed }))), ['source_sha_mismatch']);
  assert.deepEqual(codes(planStage(input({ observedFiles: { ...input().observedFiles, 'ops/extra.mjs': sha('x') } }))), ['source_unreviewed_files']);
  assert.deepEqual(codes(planStage(input({ observedFiles: undefined }))), ['source_observation_missing']);
});

test('refuses insufficient RAM or disk and unpinned capacity requirements', () => {
  assert.deepEqual(codes(planStage(input({ host: { memMb: 512, diskMb: 100000 } }))), ['insufficient_memory']);
  assert.deepEqual(codes(planStage(input({ host: { memMb: 8192, diskMb: 10 } }))), ['insufficient_disk']);
  assert.deepEqual(codes(planStage(input({ host: undefined }))), ['host_capacity_unknown']);
  const m = release();
  const body = { ...m, preflight: {} };
  delete body.digest;
  const manifest = { ...body, digest: digest(body) };
  assert.deepEqual(codes(planStage(input({ manifest, reviewedManifestDigest: manifest.digest }))), ['capacity_requirements_unpinned']);
});

test('refuses exhausted or unknown compute', () => {
  assert.deepEqual(codes(planStage(input({ computeStatus: { state: 'total_exhausted' } }))), ['compute_exhausted']);
  assert.deepEqual(codes(planStage(input({ computeStatus: { state: 'daily_exhausted' } }))), ['compute_daily_exhausted']);
  assert.deepEqual(codes(planStage(input({ computeStatus: undefined }))), ['compute_status_unknown']);
});

test('refuses cross-host pin mismatch and missing host pins', () => {
  const m = release();
  const plan = planStage(input({ pins: { 'app-host': { ...m.pins }, 'uain-database': { ...m.pins, nativeBinarySha256: sha('old') } } }));
  assert.deepEqual(plan.refusals, [{ code: 'cross_host_pin_mismatch', detail: 'uain-database:nativeBinarySha256' }]);
  assert.deepEqual(codes(planStage(input({ pins: { 'app-host': { ...m.pins } } }))), ['host_pins_missing']);
  assert.deepEqual(codes(planStage(input({ pins: { 'app-host': { ...m.pins, extra: 'x' }, 'uain-database': { ...m.pins } } }))), ['cross_host_pin_mismatch']);
});

test('refuses a stale or unknown backup', () => {
  assert.deepEqual(codes(planStage(input({ backupAgeHours: 24.5 }))), ['stale_backup']);
  assert.equal(planStage(input({ backupAgeHours: 24 })).allowed, true);
  assert.deepEqual(codes(planStage(input({ backupAgeHours: undefined }))), ['backup_age_unknown']);
});

test('refuses unknown journal writes and an unavailable journal', () => {
  const plan = planStage(input({ journal: { unresolved: [{ id: 'open-task-1', projectId: selection.ids[0], operation: 'central_task_open', state: 'unknown' }] } }));
  assert.deepEqual(plan.refusals, [{ code: 'unknown_journal_writes', detail: 'open-task-1' }]);
  assert.deepEqual(codes(planStage(input({ journal: undefined }))), ['journal_status_unavailable']);
});

test('every refusal is reported together and the planner never mutates its inputs', () => {
  const frozen = deepFreeze(input({ stage: 5, backupAgeHours: 99, computeStatus: { state: 'total_exhausted' }, host: { memMb: 1, diskMb: 1 }, journal: { unresolved: [{ id: 'x' }] } }));
  const plan = planStage(frozen);
  assert.equal(plan.allowed, false);
  assert.deepEqual(codes(plan).sort(), ['compute_exhausted', 'insufficient_disk', 'insufficient_memory', 'prior_stage_report_missing', 'stale_backup', 'unknown_journal_writes']);
  assert.deepEqual(planStage({}).allowed, false);
});
