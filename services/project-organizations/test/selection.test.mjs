import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import {
  NATIVE_MAIN_KPI_MIN_BYTES, SELECTION_COUNT, SELECTION_PATH, SELECTION_SCHEMA,
  catalogueRecords, loadSelection, sourceDigestOf, validateSelection,
} from '../src/selection.mjs';

const CATALOGUE_DIR = fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url));
const manifest = JSON.parse(readFileSync(SELECTION_PATH, 'utf8'));
let current;

before(async () => {
  current = catalogueRecords(await loadCatalogue(CATALOGUE_DIR));
});

const clone = () => structuredClone(manifest);
/** A copy of the live catalogue records whose rows can be mutated safely. */
const records = () => ({ revision: current.revision, records: new Map([...current.records].map(([k, v]) => [k, structuredClone(v)])) });
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);

test('the frozen manifest has exactly 120 unique source-pinned projects that reproduce from the real catalogue', () => {
  assert.equal(current.records.size, 21600);
  assert.match(current.revision, /^[a-f0-9]{40}$/);
  const selection = validateSelection(manifest, current);
  assert.equal(selection.schema, SELECTION_SCHEMA);
  assert.equal(selection.projects.length, SELECTION_COUNT);
  assert.equal(new Set(selection.ids).size, 120);
  assert.match(selection.digest, /^[a-f0-9]{64}$/);
  for (const p of selection.projects) {
    const row = current.records.get(p.id);
    assert.ok(row, `${p.id} exists in the catalogue`);
    assert.equal(sourceDigestOf(row, current.revision), p.sourceDigest);
    assert.equal(p.nativeProjectId, 'P-' + p.id);
    assert.equal(selection.get(p.nativeProjectId), p);
    assert.equal(selection.get(p.id), p);
    assert.ok(selection.has(p.id));
  }
});

test('the Main KPI of every selected project is the unchanged catalogue KPI', () => {
  const selection = validateSelection(manifest, current);
  for (const p of selection.projects) assert.deepEqual({ ...p.kpi }, current.records.get(p.id).kpi);
});

test('OPP-08881 is the only project held, because its Main KPI is under the native minimum; its wording is not padded', () => {
  const selection = validateSelection(manifest, current);
  const held = selection.projects.filter((p) => p.holds.length);
  assert.deepEqual(held.map((p) => p.id), ['OPP-08881']);
  const p = selection.get('OPP-08881');
  assert.deepEqual([...p.holds], ['main_kpi_below_native_minimum']);
  assert.equal(p.kpi.statement, current.records.get('OPP-08881').kpi.statement);
  assert.equal(Buffer.byteLength(p.kpi.statement), 19);
  assert.ok(Buffer.byteLength(p.kpi.statement) < NATIVE_MAIN_KPI_MIN_BYTES);
});

test('the frozen selection and its records are immutable', () => {
  const selection = validateSelection(manifest, current);
  assert.ok(Object.isFrozen(selection) && Object.isFrozen(selection.projects) && Object.isFrozen(selection.ids));
  const p = selection.projects[0];
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.kpi) && Object.isFrozen(p.holds));
  assert.throws(() => selection.projects.push(p), TypeError);
});

test('the selection digest is stable and changes with any manifest change', () => {
  const a = validateSelection(manifest).digest;
  assert.equal(validateSelection(clone()).digest, a);
  const m = clone();
  m.projects[5].modelPlanDigest = 'f'.repeat(64);
  assert.notEqual(validateSelection(m).digest, a);
});

test('a project outside the selection is refused, never substituted', () => {
  const selection = validateSelection(manifest, current);
  refuses(() => selection.get('OPP-00001'), 'project_not_selected');
  refuses(() => selection.get('P-OPP-00001'), 'project_not_selected');
  refuses(() => selection.get(''), 'project_not_selected');
  assert.equal(selection.has('OPP-00001'), false);
});

test('an unknown selected source (absent from the catalogue) is refused', () => {
  const m = clone();
  m.projects[0].id = 'OPP-99999';
  validateSelection(m); // structurally valid
  refuses(() => validateSelection(m, current), 'selected_source_missing');
});

test('a missing selected source is refused', () => {
  const live = records();
  live.records.delete('OPP-10561');
  refuses(() => validateSelection(manifest, live), 'selected_source_missing');
});

test('a changed selected source is refused, whether its text, KPI or revision changed', () => {
  for (const change of [
    (row) => { row.title += ' (edited)'; },
    (row) => { row.description = 'changed'; },
    (row) => { row.category = 'Other'; },
    (row) => { row.kpi.threshold += 1; },
    (row) => { row.kpi.statement = row.kpi.statement + ' and more'; },
  ]) {
    const live = records();
    change(live.records.get('OPP-00002'));
    refuses(() => validateSelection(manifest, live), 'selected_source_changed');
  }
  refuses(() => validateSelection(manifest, { ...records(), revision: 'a'.repeat(40) }), 'selected_source_changed');
});

test('fields outside the pinned digest do not count as a source change', () => {
  const live = records();
  live.records.get('OPP-00002').taskCount = 5;
  assert.equal(validateSelection(manifest, live).projects.length, 120);
});

test('a manifest whose Main KPI differs from the pinned source is refused', () => {
  const m = clone();
  m.projects[0].kpi.statement = '2,000,000,000 people treated yearly';
  refuses(() => validateSelection(m, current), 'selected_main_kpi_changed');
  const n = clone();
  n.projects[0].kpi.qualification = 'A measured result.';
  refuses(() => validateSelection(n, current), 'selected_main_kpi_changed');
});

test('a duplicate selected id is refused', () => {
  const m = clone();
  m.projects[1] = structuredClone(m.projects[0]);
  refuses(() => validateSelection(m), 'duplicate_selection_project');
});

test('count drift is refused in either direction', () => {
  const fewer = clone();
  fewer.projects.pop();
  refuses(() => validateSelection(fewer), 'selection_count_drift');
  const more = clone();
  more.projects.push({ ...structuredClone(more.projects[0]), id: 'OPP-99998' });
  refuses(() => validateSelection(more), 'selection_count_drift');
  const declared = clone();
  declared.count = 121;
  refuses(() => validateSelection(declared), 'invalid_selection');
  const notArray = clone();
  notArray.projects = {};
  refuses(() => validateSelection(notArray), 'selection_count_drift');
});

test('malformed manifests and project records are refused', () => {
  const cases = [
    [(m) => { m.schema = 'other'; }, 'invalid_selection'],
    [(m) => { m.extra = true; }, 'invalid_selection'],
    [(m) => { delete m.authority; }, 'invalid_selection'],
    [(m) => { m.observedAt = 'not a date'; }, 'invalid_selection'],
    [(m) => { m.projects[3].extra = 1; }, 'invalid_selection_project'],
    [(m) => { delete m.projects[3].modelPlanDigest; }, 'invalid_selection_project'],
    [(m) => { m.projects[3].id = 'OPP-1'; }, 'invalid_selection_project'],
    [(m) => { m.projects[3].sourceDigest = 'A'.repeat(64); }, 'invalid_selection_project'],
    [(m) => { m.projects[3].kpi.extra = 1; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.statement += ' '; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.statement = ''; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.threshold = 1.5; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.threshold = '10'; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.qualification = ''; }, 'invalid_selection_kpi'],
    [(m) => { m.projects[3].kpi.statement = 'bad\u0001control'; }, 'invalid_selection_kpi'],
  ];
  for (const [mutate, code] of cases) {
    const m = clone();
    mutate(m);
    refuses(() => validateSelection(m), code);
  }
  refuses(() => validateSelection(null), 'invalid_selection');
  refuses(() => validateSelection([]), 'invalid_selection');
});

test('the current catalogue may be given as an iterable of rows', () => {
  const live = { revision: current.revision, records: [...current.records.values()] };
  assert.equal(validateSelection(manifest, live).projects.length, 120);
});

test('loadSelection reads the committed manifest and checks it against the catalogue', async () => {
  const selection = await loadSelection({ current });
  const amendments = JSON.parse(readFileSync(new URL('../../../docs/baink/project-organizations-2026-11-06/kpi-amendments.json', import.meta.url)));
  assert.equal(selection.digest, validateSelection(manifest, null, { amendments }).digest);
  assert.notEqual(selection.digest, validateSelection(manifest).digest);
  assert.equal((await loadSelection({ current, amendmentsPath: null })).digest, validateSelection(manifest).digest);
  await assert.rejects(loadSelection({ current: { ...records(), revision: 'b'.repeat(40) } }), (e) => e.code === 'selected_source_changed');
});

test('sourceDigestOf requires a 40-hex revision and a row', () => {
  const row = current.records.get('OPP-00002');
  refuses(() => sourceDigestOf(row, 'abc'), 'invalid_source_record');
  refuses(() => sourceDigestOf(row, undefined), 'invalid_source_record');
  refuses(() => sourceDigestOf(null, current.revision), 'invalid_source_record');
});

test('catalogueRecords refuses an unavailable catalogue', async () => {
  const unavailable = await loadCatalogue(undefined);
  refuses(() => catalogueRecords(unavailable), 'catalogue_unavailable');
  refuses(() => catalogueRecords(null), 'catalogue_unavailable');
});

test('a recorded KPI amendment restates the source verbatim and lifts only the native-minimum hold', () => {
  const amendments = JSON.parse(readFileSync(new URL('../../../docs/baink/project-organizations-2026-11-06/kpi-amendments.json', import.meta.url)));
  const s = validateSelection(manifest, current, { amendments });
  const p = s.get('OPP-08881');
  assert.equal(p.kpi.statement, '1,000 bridges built');
  assert.equal(p.mainKpi, '1,000 bridges built in total');
  assert.deepEqual([...p.holds], []);
  assert.equal(p.kpiAmendment.decidedBy, 'Rahul');
  assert.equal(s.get('OPP-00002').mainKpi, s.get('OPP-00002').kpi.statement);
  assert.equal(s.projects.filter((x) => x.holds.length).length, 0);
  const bad = (change, code) => {
    const a = structuredClone(amendments);
    Object.assign(a.amendments[0], change);
    assert.throws(() => validateSelection(manifest, null, { amendments: a }), (e) => e.code === code);
  };
  bad({ statement: 'One thousand bridges completed' }, 'invalid_kpi_amendment');
  bad({ statement: '1,000 bridges built' }, 'invalid_kpi_amendment');
  bad({ threshold: 2000 }, 'kpi_amendment_source_mismatch');
  bad({ sourceStatement: '1,000 bridges' }, 'kpi_amendment_source_mismatch');
  bad({ id: 'OPP-99999' }, 'invalid_kpi_amendment');
  bad({ decidedBy: '' }, 'invalid_kpi_amendment');
  const dup = structuredClone(amendments);
  dup.amendments.push(structuredClone(dup.amendments[0]));
  assert.throws(() => validateSelection(manifest, null, { amendments: dup }), (e) => e.code === 'invalid_kpi_amendment');
});
