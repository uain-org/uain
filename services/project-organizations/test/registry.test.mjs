import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SELECTION_PATH, validateSelection } from '../src/selection.mjs';
import { BINDING_FIELDS, openRegistry } from '../src/registry.mjs';

const manifest = JSON.parse(readFileSync(SELECTION_PATH, 'utf8'));
const selection = validateSelection(manifest);
const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'uain-registry-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let n = 0;
const address = () => 'uain1' + (++n).toString(16).padStart(40, '0');
const refuses = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected ${code}`);
const [A, B, C] = selection.ids;
const fullBinding = (id) => ({
  nativeProjectId: 'P-' + id,
  nativeManager: address(),
  nativeEvaluator: address(),
  paperclipCompanyId: randomUUID(),
  paperclipProjectId: randomUUID(),
  paperclipGoalId: randomUUID(),
  ceoAgentId: randomUUID(),
  managerAgentId: randomUUID(),
});

let registry;
before(() => {
  registry = openRegistry({ directory: tempDir(), selection });
});

test('a fresh registry holds the 120 selected projects with null bindings and no implied admission', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  for (const id of selection.ids) {
    const b = r.get(id);
    assert.equal(b.projectId, id);
    assert.equal(b.sourceDigest, selection.get(id).sourceDigest);
    assert.equal(b.revision, 0);
    assert.equal(b.updatedAt, null);
    for (const f of Object.keys(BINDING_FIELDS)) assert.equal(b[f], null, `${id} ${f}`);
  }
  r.close();
});

test('the database file is private', () => {
  const d = tempDir();
  openRegistry({ directory: d, selection }).close();
  assert.equal(statSync(join(d, 'registry.sqlite')).mode & 0o777, 0o600);
});

test('pagination: page 2 of pageSize 100 contains exactly the last 20 selected projects', () => {
  const first = registry.list({ page: 1, pageSize: 100 });
  const second = registry.list({ page: 2, pageSize: 100 });
  assert.equal(first.total, 120);
  assert.equal(first.pages, 2);
  assert.equal(first.projects.length, 100);
  assert.equal(second.projects.length, 20);
  assert.deepEqual(second.projects.map((p) => p.projectId), selection.ids.slice(100));
  assert.deepEqual([...first.projects, ...second.projects].map((p) => p.projectId), [...selection.ids]);
  assert.equal(registry.list({ page: 3, pageSize: 100 }).projects.length, 0);
  assert.equal(registry.list().projects.length, 100);
  const small = registry.list({ page: 18, pageSize: 7 });
  assert.equal(small.pages, 18);
  assert.equal(small.projects.length, 1);
  assert.equal(small.projects[0].projectId, selection.ids[119]);
});

test('invalid pages are refused', () => {
  for (const options of [{ page: 0 }, { page: 1.5 }, { pageSize: 0 }, { pageSize: 101 }, { page: '2' }])
    refuses(() => registry.list(options), 'invalid_registry_page');
});

test('a binding sets missing fields, bumps the revision and is idempotent for identical values', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const company = randomUUID();
  const one = r.bind(A, { paperclipCompanyId: company });
  assert.equal(one.paperclipCompanyId, company);
  assert.equal(one.revision, 1);
  assert.ok(one.updatedAt);
  assert.equal(one.paperclipProjectId, null);
  const again = r.bind(A, { paperclipCompanyId: company });
  assert.equal(again.revision, 1, 'no-op bind does not bump the revision');
  const full = fullBinding(A);
  full.paperclipCompanyId = company;
  const two = r.bind(A, full);
  assert.equal(two.revision, 2);
  for (const [k, v] of Object.entries(full)) assert.equal(two[k], v);
  assert.equal(r.byCompany(company).projectId, A);
  r.close();
});

test('binding is accepted by native project id as well as catalogue id', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  r.bind('P-' + B, { nativeProjectId: 'P-' + B });
  assert.equal(r.get(B).nativeProjectId, 'P-' + B);
  r.close();
});

test('a persistent binding cannot be changed to a different value', () => {
  const d = tempDir();
  const r = openRegistry({ directory: d, selection });
  const first = randomUUID();
  r.bind(A, { ceoAgentId: first });
  refuses(() => r.bind(A, { ceoAgentId: randomUUID() }), 'binding_conflict');
  r.close();
  const reopened = openRegistry({ directory: d, selection });
  refuses(() => reopened.bind(A, { ceoAgentId: randomUUID() }), 'binding_conflict');
  assert.equal(reopened.get(A).ceoAgentId, first);
  reopened.close();
});

test('a conflicting bind changes nothing, even fields that were themselves valid', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const ceo = randomUUID();
  r.bind(A, { ceoAgentId: ceo });
  refuses(() => r.bind(A, { managerAgentId: randomUUID(), ceoAgentId: randomUUID() }), 'binding_conflict');
  const row = r.get(A);
  assert.equal(row.managerAgentId, null);
  assert.equal(row.revision, 1);
  r.close();
});

test('the native project id must be the frozen P-<catalogue id>', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  refuses(() => r.bind(A, { nativeProjectId: 'P-' + B }), 'native_project_id_mismatch');
  refuses(() => r.bind(A, { nativeProjectId: 'P-service-integrity-20261105' }), 'native_project_id_mismatch');
  assert.equal(r.bind(A, { nativeProjectId: 'P-' + A }).nativeProjectId, 'P-' + A);
  r.close();
});

test('a unique identity bound to one project is refused for any other project', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const bound = fullBinding(A);
  r.bind(A, bound);
  for (const [field, [, unique]] of Object.entries(BINDING_FIELDS)) {
    if (!unique || field === 'nativeProjectId') continue;
    refuses(() => r.bind(B, { [field]: bound[field] }), 'duplicate_cross_project_binding');
    assert.equal(r.get(B)[field], null);
  }
  assert.equal(r.get(B).revision, 0);
  r.close();
});

test('the central evaluator is not unique: one evaluator may serve several projects', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const evaluator = address();
  r.bind(A, { nativeEvaluator: evaluator });
  assert.equal(r.bind(B, { nativeEvaluator: evaluator }).nativeEvaluator, evaluator);
  r.close();
});

test('the evaluator can never be the project manager', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const same = address();
  refuses(() => r.bind(A, { nativeManager: same, nativeEvaluator: same }), 'evaluator_is_manager');
  r.bind(A, { nativeManager: same });
  refuses(() => r.bind(A, { nativeEvaluator: same }), 'evaluator_is_manager');
  const evaluator = address();
  r.bind(B, { nativeEvaluator: evaluator });
  refuses(() => r.bind(B, { nativeManager: evaluator }), 'evaluator_is_manager');
  assert.equal(r.get(A).nativeEvaluator, null);
  assert.equal(r.get(B).nativeManager, null);
  r.close();
});

test('compare-and-swap: a stale expected revision is refused', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  const writerA = r.get(A).revision;
  const writerB = r.get(A).revision;
  r.bind(A, { paperclipCompanyId: randomUUID() }, { expectedRevision: writerA });
  refuses(() => r.bind(A, { paperclipProjectId: randomUUID() }, { expectedRevision: writerB }), 'registry_revision_conflict');
  assert.equal(r.get(A).paperclipProjectId, null);
  const next = r.bind(A, { paperclipProjectId: randomUUID() }, { expectedRevision: 1 });
  assert.equal(next.revision, 2);
  refuses(() => r.bind(A, { paperclipGoalId: randomUUID() }, { expectedRevision: '2' }), 'registry_revision_conflict');
  r.close();
});

test('compare-and-swap holds across two registry handles on the same store', () => {
  const d = tempDir();
  const one = openRegistry({ directory: d, selection });
  const two = openRegistry({ directory: d, selection });
  one.bind(C, { paperclipGoalId: randomUUID() }, { expectedRevision: 0 });
  refuses(() => two.bind(C, { paperclipProjectId: randomUUID() }, { expectedRevision: 0 }), 'registry_revision_conflict');
  const company = randomUUID();
  one.bind(A, { paperclipCompanyId: company });
  refuses(() => two.bind(B, { paperclipCompanyId: company }), 'duplicate_cross_project_binding');
  one.close();
  two.close();
});

test('bindings persist across a restart', () => {
  const d = tempDir();
  const r = openRegistry({ directory: d, selection });
  const full = fullBinding(C);
  r.bind(C, full);
  r.close();
  const reopened = openRegistry({ directory: d, selection });
  const row = reopened.get(C);
  for (const [k, v] of Object.entries(full)) assert.equal(row[k], v);
  assert.equal(row.revision, 1);
  assert.equal(reopened.byCompany(full.paperclipCompanyId).projectId, C);
  refuses(() => reopened.bind(A, { managerAgentId: full.managerAgentId }), 'duplicate_cross_project_binding');
  reopened.close();
});

test('reopening a registry with a different selection is refused', () => {
  const d = tempDir();
  openRegistry({ directory: d, selection }).close();
  const drifted = structuredClone(manifest);
  drifted.projects[0].modelPlanDigest = 'e'.repeat(64);
  refuses(() => openRegistry({ directory: d, selection: validateSelection(drifted) }), 'registry_selection_drift');
  const substituted = structuredClone(manifest);
  substituted.projects[119] = { ...substituted.projects[119], id: 'OPP-00001' };
  refuses(() => openRegistry({ directory: d, selection: validateSelection(substituted) }), 'registry_selection_drift');
  openRegistry({ directory: d, selection }).close();
});

test('unknown projects and malformed bindings are refused', () => {
  const r = openRegistry({ directory: tempDir(), selection });
  refuses(() => r.get('OPP-00001'), 'project_not_selected');
  refuses(() => r.bind('OPP-00001', { ceoAgentId: randomUUID() }), 'project_not_selected');
  for (const bad of [
    {}, null, [], { stars: '5' }, { ceoAgentId: 'not-a-uuid' }, { ceoAgentId: 7 },
    { nativeManager: 'uain1' + 'G'.repeat(40) }, { nativeEvaluator: '0x' + '1'.repeat(40) },
    { paperclipCompanyId: randomUUID().toUpperCase().replace(/-/g, '') },
  ]) refuses(() => r.bind(A, bad), 'invalid_binding');
  assert.equal(r.get(A).revision, 0);
  r.close();
});

test('byCompany returns null for unknown or malformed company ids', () => {
  assert.equal(registry.byCompany(randomUUID()), null);
  assert.equal(registry.byCompany('x'), null);
  assert.equal(registry.byCompany(undefined), null);
});

test('a registry configuration without the 120 selection is refused', () => {
  refuses(() => openRegistry({ directory: tempDir(), selection: { projects: [] } }), 'invalid_registry_configuration');
  refuses(() => openRegistry({ directory: undefined, selection }), 'invalid_registry_configuration');
});
