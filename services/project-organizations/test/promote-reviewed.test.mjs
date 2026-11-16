import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { buildOpenProjectPayload, validateBootstrapReview, BOOTSTRAP_REVIEW_SCHEMA } from '../src/bootstrap.mjs';
import { BOOTSTRAP_DRAFTER_ID } from '../src/bootstrap-record.mjs';
import { PRIOR_ART_PRODUCER_ID } from '../src/prior-art.mjs';
import {
  ALWAYS_EXCLUDED, DEFAULT_DRAFTS, DEFAULT_OUT, DEFAULT_REVIEWS, promoteReviewed, proposingModelIds,
  reviewedIds, runPromotion, validateReviewFile,
} from '../ops/promote-reviewed.mjs';

/* Reads the real drafts, the real review files and the real catalogue. No network. */
const CATALOGUE_DIR = fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url));
const catalogue = catalogueRecords(await loadCatalogue(CATALOGUE_DIR));
const selection = await loadSelection({ current: catalogue });
const FIRST_FIVE = selection.projects.slice(0, 5).map((p) => p.id);
const REVIEWER = 'claude-independent-prior-art-reviewer-20261106';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const draftOf = (id) => readJSON(join(DEFAULT_DRAFTS, `${id}.json`));
const reviewOf = (id) => readJSON(join(DEFAULT_REVIEWS, `${id}.review.json`));
const sourceOf = (id) => ({ row: catalogue.records.get(id), revision: catalogue.revision });
const refuses = (fn, code) => assert.throws(fn, (e) => (assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`), true));
const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'promote-reviewed-'));
  dirs.push(d);
  return d;
};

test('the first five selected projects have an independent review file bound to them', () => {
  assert.deepEqual(FIRST_FIVE, ['OPP-00002', 'OPP-00003', 'OPP-00004', 'OPP-00005', 'OPP-00006']);
  for (const id of FIRST_FIVE) {
    const review = validateReviewFile(reviewOf(id), id);
    assert.equal(review.reviewer, REVIEWER);
    assert.equal(review.assessment.reviewer, REVIEWER);
    assert.ok(!ALWAYS_EXCLUDED.includes(review.reviewer));
    assert.ok(review.additionalSearches.length >= 4, `${id} needs at least four of its own searches`);
    assert.ok(review.assessment.rationale.length >= 20);
    assert.ok(['benevolent', 'neutral'].includes(review.class));
  }
  // More reviewers add files over time: every review must belong to a selected project,
  // and the first five must stay among them.
  const ids = reviewedIds(DEFAULT_REVIEWS);
  assert.ok(FIRST_FIVE.every((id) => ids.includes(id)));
  assert.ok(ids.every((id) => selection.has(id)));
});

test('promoteReviewed produces a record native open_project accepts for the live catalogue row', () => {
  for (const id of FIRST_FIVE) {
    const promoted = promoteReviewed({ draft: draftOf(id), reviewFile: reviewOf(id), selection, source: sourceOf(id) });
    assert.equal(promoted.outcome, 'record');
    const record = promoted.record;
    assert.equal(record.schema, BOOTSTRAP_REVIEW_SCHEMA);
    assert.equal(record.project, id);
    assert.equal(record.source_digest, selection.get(id).sourceDigest);
    assert.match(record.prior_art.basis, new RegExp(`^Independent review by ${REVIEWER}: `));
    assert.match(record.prior_art.basis, /open solution found: no; known answer: no/);
    assert.ok(record.prior_art.searches.length >= 2 && record.prior_art.searches.length <= 20);
    // The record validates and builds the native payload with the catalogue title, unrewritten.
    validateBootstrapReview(record, selection.get(id));
    const payload = buildOpenProjectPayload({ selection, projectId: id, source: sourceOf(id), review: record });
    assert.equal(payload.title, catalogue.records.get(id).title);
    assert.equal(payload.id, `P-${id}`);
    assert.equal(payload.class, record.class);
  }
});

test('the written reviewed records are exactly what promotion produces', () => {
  for (const id of FIRST_FIVE) {
    const written = readJSON(join(DEFAULT_OUT, `${id}.json`));
    const { record } = promoteReviewed({ draft: draftOf(id), reviewFile: reviewOf(id), selection, source: sourceOf(id) });
    assert.deepEqual(written, record);
    buildOpenProjectPayload({ selection, projectId: id, source: sourceOf(id), review: written });
  }
  // Every written record or hold has a review behind it, and every record is what promotion yields.
  const reviewed = reviewedIds(DEFAULT_REVIEWS);
  for (const name of readdirSync(DEFAULT_OUT).filter((n) => n.endsWith('.json'))) {
    const id = name.replace(/\.(hold\.)?json$/, '');
    assert.ok(reviewed.includes(id), `${name} has no review file`);
    if (name.endsWith('.hold.json')) continue;
    const { record } = promoteReviewed({ draft: draftOf(id), reviewFile: reviewOf(id), selection, source: sourceOf(id) });
    assert.deepEqual(readJSON(join(DEFAULT_OUT, name)), record, `${id} record differs from promotion`);
  }
});

test('an open solution or a known answer is recorded as a hold, never as a record', () => {
  const id = FIRST_FIVE[0];
  for (const [field, reason] of [['openSolutionFound', 'prior_art_open_solution_found'], ['knownAnswer', 'prior_art_known_answer']]) {
    const reviewFile = reviewOf(id);
    reviewFile.assessment = { ...reviewFile.assessment, [field]: true };
    const promoted = promoteReviewed({ draft: draftOf(id), reviewFile, selection, source: sourceOf(id) });
    assert.equal(promoted.outcome, 'held');
    assert.equal(promoted.hold.reason, reason);
    assert.equal(promoted.hold.project, id);
    assert.equal(promoted.hold.reviewer, REVIEWER);
    assert.ok(!('prior_art' in promoted.hold) && !('class' in promoted.hold));
  }
});

test('the drafting step and the proposing models cannot review their own searches', () => {
  const id = FIRST_FIVE[0];
  const as = (reviewer, excludedReviewers = []) => {
    const reviewFile = reviewOf(id);
    reviewFile.reviewer = reviewer;
    reviewFile.assessment = { ...reviewFile.assessment, reviewer };
    return () => promoteReviewed({ draft: draftOf(id), reviewFile, selection, source: sourceOf(id), excludedReviewers });
  };
  refuses(as(PRIOR_ART_PRODUCER_ID), 'reviewer_not_independent');
  refuses(as(BOOTSTRAP_DRAFTER_ID), 'reviewer_not_independent');
  refuses(as('claude-sonnet-5-5', ['claude-sonnet-5-5']), 'reviewer_not_independent');
});

test('proposingModelIds collects the CEO and manager model ids for this project only', () => {
  const reports = [
    { projectId: 'OPP-00002', role: 'ceo', execution: { model: 'model-a' } },
    { projectId: 'OPP-00002', role: 'manager', execution: { model: 'model-b' } },
    { projectId: 'OPP-00002', role: 'ceo', execution: { model: 'model-a' } },
    { projectId: 'OPP-00003', role: 'ceo', execution: { model: 'model-c' } },
  ];
  const store = { list: ({ projectId }) => reports.filter((r) => r.projectId === projectId) };
  assert.deepEqual(proposingModelIds(store, 'OPP-00002').toSorted(cmp), ['model-a', 'model-b']);
  assert.deepEqual(proposingModelIds(store, 'OPP-00003'), ['model-c']);
  assert.deepEqual(proposingModelIds(null, 'OPP-00002'), []);
  // A plain array of reports is filtered by project too.
  assert.deepEqual(proposingModelIds(reports, 'OPP-00003'), ['model-c']);
});

test('a review file for another project, or without its own searches, is refused', () => {
  const reviewFile = reviewOf('OPP-00003');
  refuses(() => promoteReviewed({ draft: draftOf('OPP-00002'), reviewFile, selection, source: sourceOf('OPP-00002') }), 'invalid_review_file');
  const thin = reviewOf('OPP-00002');
  thin.additionalSearches = thin.additionalSearches.slice(0, 3);
  refuses(() => validateReviewFile(thin, 'OPP-00002'), 'insufficient_review_searches');
  const mismatched = reviewOf('OPP-00002');
  mismatched.assessment = { ...mismatched.assessment, reviewer: 'someone-else-9' };
  refuses(() => validateReviewFile(mismatched, 'OPP-00002'), 'invalid_review_file');
  const unsourced = reviewOf('OPP-00002');
  unsourced.additionalSearches = unsourced.additionalSearches.map((s) => ({ ...s, source: 'not a url' }));
  refuses(() => validateReviewFile(unsourced, 'OPP-00002'), 'invalid_review_file');
});

test('an assessment bound to other searches, and a draft that is already assessed, are refused', () => {
  const id = FIRST_FIVE[0];
  const bound = reviewOf(id);
  bound.assessment = { ...bound.assessment, searchesDigest: 'f'.repeat(64) };
  refuses(() => promoteReviewed({ draft: draftOf(id), reviewFile: bound, selection, source: sourceOf(id) }), 'assessment_digest_mismatch');
  const right = reviewOf(id);
  right.assessment = { ...right.assessment, searchesDigest: draftOf(id).searches_digest };
  assert.equal(promoteReviewed({ draft: draftOf(id), reviewFile: right, selection, source: sourceOf(id) }).outcome, 'record');
  const assessed = draftOf(id);
  assessed.class = 'benevolent';
  refuses(() => promoteReviewed({ draft: assessed, reviewFile: reviewOf(id), selection, source: sourceOf(id) }), 'draft_already_assessed');
});

test('runPromotion writes a record per project, a hold file for a held one, and reports refusals', () => {
  const out = tmp();
  const outcomes = runPromotion({ ids: FIRST_FIVE, drafts: DEFAULT_DRAFTS, reviews: DEFAULT_REVIEWS, out, selection, catalogue });
  assert.deepEqual(outcomes, FIRST_FIVE.map((id) => ({ id, outcome: 'record', reason: null })));
  for (const id of FIRST_FIVE) assert.deepEqual(readJSON(join(out, `${id}.json`)), readJSON(join(DEFAULT_OUT, `${id}.json`)));

  // A held project: the reviews directory holds a review that found an open solution.
  const heldReviews = tmp();
  const held = reviewOf(FIRST_FIVE[1]);
  held.assessment = { ...held.assessment, knownAnswer: true };
  writeFileSync(join(heldReviews, `${FIRST_FIVE[1]}.review.json`), JSON.stringify(held));
  const heldOut = tmp();
  const heldOutcomes = runPromotion({ ids: [FIRST_FIVE[1]], drafts: DEFAULT_DRAFTS, reviews: heldReviews, out: heldOut, selection, catalogue });
  assert.deepEqual(heldOutcomes, [{ id: FIRST_FIVE[1], outcome: 'held', reason: 'prior_art_known_answer' }]);
  const holdFile = readJSON(join(heldOut, `${FIRST_FIVE[1]}.hold.json`));
  assert.equal(holdFile.schema, 'uain-project-organization-bootstrap-hold-v1');
  assert.equal(holdFile.reason, 'prior_art_known_answer');
  assert.ok(!readdirSync(heldOut).includes(`${FIRST_FIVE[1]}.json`));

  // A missing review file is reported as a refusal, not thrown, and writes nothing.
  const emptyOut = tmp();
  const unreviewed = selection.ids.find((id) => !reviewedIds(DEFAULT_REVIEWS).includes(id)) ?? null;
  const missingReviews = tmp(); // an empty reviews directory guarantees a missing review
  const missing = runPromotion({ ids: [unreviewed ?? FIRST_FIVE[0]], drafts: DEFAULT_DRAFTS, reviews: missingReviews, out: emptyOut, selection, catalogue });
  assert.equal(missing[0].outcome, 'refused');
  assert.deepEqual(readdirSync(emptyOut), []);

  // --dry-run writes nothing at all.
  const dry = tmp();
  const dryOutcomes = runPromotion({ ids: FIRST_FIVE, drafts: DEFAULT_DRAFTS, reviews: DEFAULT_REVIEWS, out: dry, selection, catalogue, dryRun: true });
  assert.ok(dryOutcomes.every((x) => x.outcome === 'record'));
  assert.deepEqual(readdirSync(dry), []);
});
