#!/usr/bin/env node
/** Promotes a reviewed bootstrap draft with an independent reviewer's assessment.
 *
 *   node services/project-organizations/ops/promote-reviewed.mjs [--only OPP-00002,OPP-00003]
 *        [--reviews <dir>] [--drafts <dir>] [--out <dir>] [--leadership <dir>] [--dry-run]
 *
 * For each project it reads the DRAFT (`<drafts>/<id>.json`, searches only) and the review
 * file (`<reviews>/<id>.review.json`, schema `uain-project-organization-bootstrap-review-v1`)
 * written by a reviewer who is neither the drafting step nor the proposing model, and calls
 * `promoteDraft` in ../src/bootstrap-record.mjs. The reviewer is excluded when its id is the
 * trusted search producer, the drafter, or any model id that appears in the leadership
 * reports for this project (the proposing CEO/manager models): a model may not clear its own
 * proposal. `promoteDraft` then either
 *
 *   - returns the reviewed bootstrap record, written to `<out>/<id>.json` after
 *     `buildOpenProjectPayload` has accepted it against the live catalogue row, or
 *   - returns a hold (`prior_art_open_solution_found`, `prior_art_known_answer`), written to
 *     `<out>/<id>.hold.json`. A held project is never opened as new work (CLAUDE.md,
 *     29 September 2026) and keeps holding as `prior_art_review_required`.
 *
 * Nothing here decides novelty, and nothing here signs or dispatches anything: the file it
 * writes is the record `bootstrap.mjs` reads. Reads and local writes only; no network. */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalogue } from '../../../apps/baink/server/catalogue.mjs';
import { catalogueRecords, loadSelection } from '../src/selection.mjs';
import { buildOpenProjectPayload } from '../src/bootstrap.mjs';
import { BOOTSTRAP_DRAFTER_ID, PROMOTION_HOLDS, promoteDraft, validateDraft } from '../src/bootstrap-record.mjs';
import { PRIOR_ART_PRODUCER_ID } from '../src/prior-art.mjs';
import { openLeadershipStore } from '../src/leadership.mjs';
import { CATALOGUE_ID, OrganizationError, exactKeys, need, plain, text } from '../src/common.mjs';

export const REVIEW_FILE_SCHEMA = 'uain-project-organization-bootstrap-review-v1';
export const DEFAULT_DRAFTS = fileURLToPath(new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-drafts/', import.meta.url));
export const DEFAULT_REVIEWS = fileURLToPath(new URL('./reviews/', import.meta.url));
export const DEFAULT_OUT = fileURLToPath(new URL('../../../docs/baink/project-organizations-2026-11-06/bootstrap-reviewed/', import.meta.url));
export const CATALOGUE_DIR = fileURLToPath(new URL('../../../apps/baink/catalogue', import.meta.url));
/** Reviewer ids that can never be independent, whatever a review file claims. */
export const ALWAYS_EXCLUDED = Object.freeze([PRIOR_ART_PRODUCER_ID, BOOTSTRAP_DRAFTER_ID]);

const REVIEW_KEYS = ['schema', 'projectId', 'reviewer', 'reviewedAt', 'class', 'assessment', 'additionalSearches'];
const SEARCH_KEYS = ['query', 'source', 'observedAt', 'finding'];
const MIN_ADDITIONAL_SEARCHES = 4;

/** Structural check of one review file. It decides nothing; promoteDraft applies the rules. */
export function validateReviewFile(review, projectId = null) {
  need(plain(review) && exactKeys(review, REVIEW_KEYS) && review.schema === REVIEW_FILE_SCHEMA, 'invalid_review_file');
  need(typeof review.projectId === 'string' && CATALOGUE_ID.test(review.projectId), 'invalid_review_file', 'projectId');
  need(projectId === null || review.projectId === projectId, 'invalid_review_file', `review is bound to ${review.projectId}`);
  need(!Number.isNaN(Date.parse(review.reviewedAt)), 'invalid_review_file', 'reviewedAt');
  need(plain(review.assessment) && review.assessment.reviewer === review.reviewer, 'invalid_review_file',
    'the assessment reviewer must be the review file reviewer');
  need(Array.isArray(review.additionalSearches) && review.additionalSearches.length >= MIN_ADDITIONAL_SEARCHES, 'insufficient_review_searches',
    `an independent review records at least ${MIN_ADDITIONAL_SEARCHES} of its own searches`);
  for (const s of review.additionalSearches) {
    need(plain(s) && exactKeys(s, SEARCH_KEYS) && text(s.query, 3, 1000) && text(s.finding, 10, 2000), 'invalid_review_file', 'additionalSearches');
    need(!Number.isNaN(Date.parse(s.observedAt)), 'invalid_review_file', 'additionalSearches observedAt');
    let url;
    try {
      url = new URL(s.source);
    } catch {
      throw new OrganizationError('invalid_review_file', 'every additional search cites an absolute URL');
    }
    need(url.protocol === 'https:', 'invalid_review_file', 'every additional search cites an https URL');
  }
  return review;
}

/** Every model id that proposed this project (CEO or manager run), from the leadership log. */
export function proposingModelIds(leadership, projectId) {
  if (leadership === null || leadership === undefined) return [];
  const reports = typeof leadership.list === 'function' ? leadership.list({ projectId }) : leadership;
  const ids = new Set();
  for (const r of reports) {
    if (!plain(r) || (projectId && r.projectId !== projectId)) continue;
    for (const id of [r.execution?.model, r.model]) if (typeof id === 'string' && id.trim() !== '') ids.add(id);
  }
  return [...ids];
}

/**
 * One project: draft + review file -> the reviewed bootstrap record or the recorded hold.
 * @returns {{outcome: 'record', projectId, record}|{outcome: 'held', projectId, hold}}
 */
export function promoteReviewed({ draft, reviewFile, selection, excludedReviewers = [], source = null }) {
  validateDraft(draft);
  validateReviewFile(reviewFile, draft.project);
  const excluded = [...new Set([...ALWAYS_EXCLUDED, ...excludedReviewers])];
  const result = promoteDraft(draft, { class: reviewFile.class, assessment: reviewFile.assessment }, { selection, excludedReviewers: excluded });
  if (result.status === 'held') {
    need(PROMOTION_HOLDS.includes(result.reason), 'invalid_promotion_hold');
    return { outcome: 'held', projectId: draft.project, hold: result };
  }
  // The record must be the one native open_project would accept for the live catalogue row.
  if (source !== null) buildOpenProjectPayload({ selection, projectId: draft.project, source, review: result });
  return { outcome: 'record', projectId: draft.project, record: result };
}

const writeAtomic = (path, value) => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
};

const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Promotes every requested project, writing records and holds under `out`. */
export function runPromotion({ ids, drafts, reviews, out, selection, catalogue, leadership = null, dryRun = false, log = () => {} }) {
  mkdirSync(out, { recursive: true });
  const outcomes = [];
  for (const id of ids) {
    try {
      const draft = readJSON(join(drafts, `${id}.json`));
      const reviewFile = readJSON(join(reviews, `${id}.review.json`));
      const row = catalogue.records.get(id);
      need(row !== undefined, 'selected_source_changed', `${id} is not in the live catalogue`);
      const promoted = promoteReviewed({
        draft, reviewFile, selection, source: { row, revision: catalogue.revision },
        excludedReviewers: proposingModelIds(leadership, id),
      });
      const path = join(out, promoted.outcome === 'record' ? `${id}.json` : `${id}.hold.json`);
      const value = promoted.outcome === 'record' ? promoted.record
        : { schema: 'uain-project-organization-bootstrap-hold-v1', ...promoted.hold, reviewedAt: reviewFile.reviewedAt };
      if (!dryRun) writeAtomic(path, value);
      log(`${id} ${promoted.outcome}${promoted.outcome === 'held' ? ` ${promoted.hold.reason}` : ''} -> ${dryRun ? '(dry run)' : path}`);
      outcomes.push({ id, outcome: promoted.outcome, reason: promoted.hold?.reason ?? null });
    } catch (error) {
      // A missing or unparseable draft or review file is a refusal for that project, not a crash.
      const code = error instanceof OrganizationError ? error.code
        : (error instanceof SyntaxError || typeof error.code === 'string') ? 'review_input_unreadable' : null;
      if (code === null) throw error;
      log(`${id} refused ${code}: ${error.message}`);
      outcomes.push({ id, outcome: 'refused', code, message: error.message });
    }
  }
  return outcomes;
}

/** Project ids with a review file in `reviews`, in catalogue order. */
export const reviewedIds = (reviews) => readdirSync(reviews).filter((n) => n.endsWith('.review.json')).map((n) => n.slice(0, -'.review.json'.length)).sort();

function args(argv) {
  const o = { drafts: DEFAULT_DRAFTS, reviews: DEFAULT_REVIEWS, out: DEFAULT_OUT, leadership: null, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--drafts') o.drafts = argv[++i];
    else if (a === '--reviews') o.reviews = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--leadership') o.leadership = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',');
    else throw new OrganizationError('invalid_arguments', `unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const catalogue = catalogueRecords(await loadCatalogue(CATALOGUE_DIR));
  const selection = await loadSelection({ current: catalogue });
  const ids = o.only ?? reviewedIds(o.reviews);
  const leadership = o.leadership === null ? null : openLeadershipStore({ directory: o.leadership });
  const outcomes = runPromotion({
    ids, drafts: o.drafts, reviews: o.reviews, out: o.out, selection, catalogue, leadership, dryRun: o.dryRun,
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  });
  console.log(JSON.stringify(outcomes, null, 2));
  if (outcomes.some((x) => x.outcome === 'refused')) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof OrganizationError ? `refused: ${error.code} ${error.message}` : error);
    process.exit(1);
  });
}
