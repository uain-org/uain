import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, member } from './http-fixture.mjs';
import { validateSelection, SELECTION_PATH } from '../../../services/project-organizations/src/selection.mjs';
import { buildAcceptance, writeReports } from '../../../services/project-organizations/src/acceptance.mjs';

const PATH = '/api/operations/organizations';
const selection = validateSelection(JSON.parse(readFileSync(SELECTION_PATH, 'utf8')));

/** A genuine report from the acceptance builder with no evidence: nothing passes. */
async function reports(t) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-organizations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = writeReports(dir, buildAcceptance({ selection, generatedAt: '2026-11-06T12:00:00.000Z' }));
  return { dir, combined: paths.combined, json: JSON.parse(await readFile(paths.combined, 'utf8')) };
}
async function setup(t, { path, operators } = {}) {
  const operator = member(), viewer = member();
  const f = await fixture(t, { organizationsStatus: { path: path ?? null, operators: operators ?? [operator.address] } });
  for (const [who, name] of [[operator, 'Fleet operator'], [viewer, 'Other member']])
    assert.equal((await f.request(who, 'POST', '/api/account', { displayName: name })).status, 201);
  return { f, operator, viewer };
}

test('organization status is private: signature and operator allowlist precede any source read', async (t) => {
  const { f, operator, viewer } = await setup(t);
  let r = await f.request(null, 'GET', PATH);
  assert.equal(r.status, 401);
  r = await f.request(viewer, 'GET', PATH);
  assert.equal(r.status, 403);
  assert.equal(r.body.error?.code ?? r.body.code, 'organizations_status_forbidden');
  r = await f.request(operator, 'GET', PATH);
  assert.equal(r.status, 503);
  assert.equal(r.body.error?.code ?? r.body.code, 'organizations_status_unavailable');
});

test('a missing, invalid, symlinked or self-contradicting source is 503, never an empty report', async (t) => {
  const { dir, combined, json } = await reports(t);
  const cases = [];
  cases.push(join(dir, 'absent.json'));
  const garbage = join(dir, 'garbage.json');
  await writeFile(garbage, '{not json');
  cases.push(garbage);
  const short = join(dir, 'short.json');
  await writeFile(short, JSON.stringify({ ...json, operationalReadiness: { ...json.operationalReadiness, projects: json.operationalReadiness.projects.slice(0, 119) } }));
  cases.push(short);
  const fiat = structuredClone(json);
  fiat.operationalReadiness.projects[0].status = 'pass';
  const fiatPath = join(dir, 'fiat.json');
  await writeFile(fiatPath, JSON.stringify(fiat));
  cases.push(fiatPath);
  const claimed = structuredClone(json);
  claimed.rewardAcceptance.complete = true;
  const claimedPath = join(dir, 'claimed.json');
  await writeFile(claimedPath, JSON.stringify(claimed));
  cases.push(claimedPath);
  const link = join(dir, 'link.json');
  await symlink(combined, link);
  cases.push(link);
  cases.push('relative/acceptance.json');
  for (const path of cases) {
    const { f, operator } = await setup(t, { path });
    const r = await f.request(operator, 'GET', PATH);
    assert.equal(r.status, 503, path);
    assert.equal(r.body.error?.code ?? r.body.code, 'organizations_status_unavailable');
  }
});

test('operators page through all 120 IDs in frozen order with bounded page sizes', async (t) => {
  const { combined } = await reports(t);
  const { f, operator } = await setup(t, { path: combined });
  let r = await f.request(operator, 'GET', PATH);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 120);
  assert.equal(r.body.pageSize, 20);
  assert.equal(r.body.pages, 6);
  assert.equal(r.body.projects.length, 20);
  assert.deepEqual(r.body.complete, { operational: false, reward: false });
  assert.equal(r.body.counts.operational.pass, 0);
  assert.equal(r.body.counts.operational.held, 1);
  for (const s of r.body.stages) assert.equal(s.reached, false);
  const ids = [];
  for (let page = 1; page <= 2; page++) {
    r = await f.request(operator, 'GET', `${PATH}?page=${page}&pageSize=60`);
    assert.equal(r.status, 200);
    ids.push(...r.body.projects.map((p) => p.projectId));
  }
  assert.deepEqual(ids, [...selection.ids]);
  assert.equal(r.body.projects.at(-1).projectId, 'OPP-10561');
  const held = r.body.projects.find((p) => p.projectId === 'OPP-08881');
  assert.equal(held.operational.status, 'held');
  assert.equal(held.operational.columns.approvedPlan.reason, 'main_kpi_below_native_minimum');
  // Unknown is reported as unknown, not as zero.
  assert.equal(r.body.projects[0].operational.columns.nativeAdmission.status, 'unknown');
  for (const query of ['?pageSize=61', '?page=7', '?page=0', '?page=1.5', '?page=1&page=2', '?status=pass', '?pageSize=abc'])
    assert.equal((await f.request(operator, 'GET', PATH + query)).status, 400, query);
});

test('the projection drops credentials, provider costs and unlisted evidence fields', async (t) => {
  const { dir, json } = await reports(t);
  const doc = structuredClone(json);
  const cell = (evidence) => ({ status: 'pass', reason: null, evidence });
  const row = doc.operationalReadiness.projects[0];
  for (const c of Object.keys(row.columns)) row.columns[c] = cell({ chainId: 'uain-prod', height: '9', token: 'sk-secret-token', providerCostUsd: 3, envelope: { sig: 'x' } });
  row.columns.organization = cell({ companyId: 'c', apiKey: 'paperclip-operator-key', readAt: '2026-11-06T12:00:00.000Z' });
  row.status = 'pass';
  const rw = doc.rewardAcceptance.projects[0];
  for (const c of Object.keys(rw.columns)) rw.columns[c] = cell({ awards: [{ role: 'reviewer', member: 'uain1' + 'a'.repeat(40), amount: '1', password: 'x' }] });
  rw.status = 'pass';
  const path = join(dir, 'with-secrets.json');
  await writeFile(path, JSON.stringify(doc));
  const { f, operator } = await setup(t, { path });
  const r = await f.request(operator, 'GET', `${PATH}?pageSize=1`);
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  for (const leaked of ['sk-secret-token', 'paperclip-operator-key', 'providerCostUsd', 'envelope', 'password', 'apiKey'])
    assert.equal(text.includes(leaked), false, leaked);
  assert.deepEqual(r.body.projects[0].operational.columns.organization.evidence, { companyId: 'c', readAt: '2026-11-06T12:00:00.000Z' });
  assert.deepEqual(r.body.projects[0].reward.columns.awards.evidence.awards, [{ role: 'reviewer', member: 'uain1' + 'a'.repeat(40), amount: '1' }]);
  assert.equal(r.body.counts.operational.pass, 1);
  assert.equal(r.body.stages[0].reached, true);
  assert.equal(r.body.projects.length, 1);
});

test('public discovery stays separate: drafts are never funded or payable and no organization rows leak', async (t) => {
  const { combined } = await reports(t);
  const f = await fixture(t, { catalogueDir: new URL('../catalogue/', import.meta.url).pathname, organizationsStatus: { path: combined, operators: [member().address] } });
  let r = await f.request(null, 'GET', '/api/work/projects?pageSize=100');
  assert.equal(r.status, 200);
  assert.ok(r.body.projects.length > 0);
  for (const p of r.body.projects) {
    assert.equal(p.funded, false);
    assert.equal(p.funding.payable, false);
    assert.equal(p.earningsAvailable, false);
  }
  assert.equal(JSON.stringify(r.body).includes('nativeAdmission'), false);
  r = await f.request(null, 'GET', '/api/management/initial-tasks?pageSize=100');
  assert.equal(r.status, 200);
  for (const p of r.body.projects)
    for (const task of p.tasks) {
      assert.equal(task.payable, false);
      assert.equal(task.reward, null);
      assert.equal(task.state, 'draft-held');
    }
  r = await f.request(null, 'GET', '/api/management/initial-tasks/summary');
  assert.equal(r.body.payable, 0);
  assert.equal(r.body.drafts, r.body.held);
});
