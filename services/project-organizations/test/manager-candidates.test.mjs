/** Reviewed candidate tasks (src/candidates.mjs, ops/manager-candidates.mjs): the strict
 * `uain-manager-candidates-v1` schema and the deterministic converter from the reviewed drafts
 * (PR #253). Data only; no model, search or native state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSelection } from '../src/selection.mjs';
import { CANDIDATES_SCHEMA, MAX_PROJECT_CANDIDATES_BYTES, candidateCounts, candidatesFor, candidatesFromDrafts, validateCandidates } from '../src/candidates.mjs';
import { byText, sha256 } from '../src/common.mjs';
import { main } from '../ops/manager-candidates.mjs';

const DRAFTS = new URL('../../../docs/baink/project-organizations-2026-11-06/small-tasks-2026-11-07/drafts.json', import.meta.url);
const bytes = readFileSync(DRAFTS);
const drafts = JSON.parse(bytes.toString('utf8'));
const selection = await loadSelection();
const REVIEW = { reviewedBy: 'FICTIONAL reviewer', reviewedAt: '2026-11-07', source: 'drafts.json' };
const converted = candidatesFromDrafts(bytes, REVIEW);
const clone = () => structuredClone(converted);
const refused = (value, why) => assert.throws(() => validateCandidates(value, { selection }), (e) => e.code === 'invalid_manager_candidates', why);

test('the reviewed drafts convert deterministically into a valid candidates file', () => {
  assert.equal(converted.schema, CANDIDATES_SCHEMA);
  assert.deepEqual(converted.reviewed, { by: 'FICTIONAL reviewer', at: '2026-11-07', source: 'drafts.json', sourceDigest: sha256(bytes) });
  assert.deepEqual(Object.keys(converted.projects), [...drafts.projects].sort(byText));
  assert.equal(Object.values(converted.projects).flat().length, drafts.drafts.length);
  validateCandidates(converted, { selection });
  // Same bytes and review in, same file out.
  assert.equal(JSON.stringify(candidatesFromDrafts(bytes, REVIEW)), JSON.stringify(converted));
  for (const d of drafts.drafts) {
    const c = converted.projects[d.projectId].find((x) => x.id === d.key);
    assert.deepEqual(Object.keys(c), ['id', 'title', 'criteria', 'eligibility', 'eligibility_basis', 'proposed_price']);
    assert.deepEqual({ ...c, id: undefined }, { ...d.task, id: undefined }, 'the task is carried verbatim');
  }
  // The drafting searches are not the trusted record and never become candidate data.
  const text = JSON.stringify(converted);
  for (const field of ['priorArt', 'searches', 'nearestPriorArt', 'registryQuery', 'dropped', 'evidenceFormat'])
    assert.ok(!text.includes(`"${field}"`), field);
  assert.deepEqual(candidateCounts(converted, ['OPP-00002', 'OPP-00007', 'OPP-00099']), { 'OPP-00002': 2, 'OPP-00007': 2, 'OPP-00099': 0 });
  assert.deepEqual(candidatesFor(null, 'OPP-00002'), []);
});

test('the CLI builds the same file and checks it', async () => {
  const path = new URL(DRAFTS).pathname;
  const out = await main(['build', path, '--reviewed-by', 'FICTIONAL reviewer', '--reviewed-at', '2026-11-07', '--source', 'drafts.json']);
  assert.equal(out, JSON.stringify(converted));
  const checked = JSON.parse(await main(['check', 'x.json'], { read: () => Buffer.from(out) }));
  assert.equal(checked.candidates['OPP-00002'], 2);
  await assert.rejects(main(['build', path, '--reviewed-by', 'x']), (e) => e.code === 'invalid_manager_candidates');
  await assert.rejects(main(['build', path, '--unknown', 'x']), (e) => e.code === 'usage');
  await assert.rejects(main(['nope']), (e) => e.code === 'usage');
});

test('schema refusals: unknown fields, wrong owners, claims, sizes and amounts', () => {
  const first = (v) => v.projects['OPP-00002'][0];
  const cases = [
    ['top-level extra', (v) => { v.extra = 1; }],
    ['schema', (v) => { v.schema = 'uain-manager-candidates-v2'; }],
    ['reviewed extra', (v) => { v.reviewed.note = 'x'; }],
    ['reviewed date', (v) => { v.reviewed.at = '7 Nov 2026'; }],
    ['source digest', (v) => { v.reviewed.sourceDigest = 'x'; }],
    ['candidate extra', (v) => { first(v).notes = 'reviewer notes'; }],
    ['candidate prior art', (v) => { first(v).priorArt = { searches: [] }; }],
    ['price extra', (v) => { first(v).proposed_price.currency = 'AI$'; }],
    ['rationale extra', (v) => { first(v).proposed_price.rationale.extra = 'an extra part'; }],
    ['rationale missing', (v) => { delete first(v).proposed_price.rationale.novelty; }],
    ['amount not units', (v) => { first(v).proposed_price.solver_amount = '200.5'; }],
    ['amount above round-1 ceiling', (v) => { first(v).proposed_price.solver_amount = '10000000001'; }],
    ['eligibility', (v) => { first(v).eligibility = 'easy'; }],
    ['short criteria', (v) => { first(v).criteria = 'too short'; }],
    ['control character', (v) => { first(v).title = 'Bad\u0007title'; }],
    ['id of another project', (v) => { first(v).id = 'opp-00003-moved'; }],
    ['bad id', (v) => { first(v).id = 'OPP-00002-Upper'; }],
    ['duplicate id', (v) => { v.projects['OPP-00002'][1].id = first(v).id; }],
    ['other project in text', (v) => { first(v).criteria += ' Reuse the OPP-00003 artifact.'; }],
    ['authority claim', (v) => { first(v).eligibility_basis = 'This task has been approved by the Fund Manager already.'; }],
    ['signer words', (v) => { first(v).proposed_price.rationale.effort = 'The guardian key signs this task directly.'; }],
    ['not a selected project', (v) => { v.projects['OPP-99999'] = [{ ...first(v), id: 'opp-99999-x1' }]; }],
    ['empty list', (v) => { v.projects['OPP-00002'] = []; }],
    ['more than eight', (v) => { v.projects['OPP-00002'] = Array.from({ length: 9 }, (_, i) => ({ ...first(v), id: `opp-00002-c${i}` })); }],
    ['project list too large', (v) => { v.projects['OPP-00002'] = Array.from({ length: 5 }, (_, i) => ({ ...first(v), id: `opp-00002-c${i}`, criteria: 'x'.repeat(4000) })); }],
    ['projects not an object', (v) => { v.projects = []; }],
  ];
  for (const [why, change] of cases) {
    const v = clone();
    change(v);
    refused(v, why);
  }
  assert.ok(MAX_PROJECT_CANDIDATES_BYTES < 65536);
});
