/** Bootstrap prior-art drafts and their promotion to the reviewed bootstrap record.
 *
 * A draft (ops/draft-bootstrap.mjs) holds only what the deterministic project-level
 * searches collected: the exact catalogue title, the searches bound to URL and sha256,
 * the failures, and `class: null`, `assessment: null`. It never decides class or novelty.
 *
 * `promoteDraft` is the only way a draft becomes the record `bootstrap.mjs`
 * (`validateBootstrapReview`, `buildOpenProjectPayload`) accepts. An independent reviewer,
 * who is neither the drafting step nor the proposing model, supplies the class and the
 * explicit assessment. An open solution or a known answer means the project is not opened
 * as new work: promotion returns a hold instead of a record, and the bootstrap then holds
 * the project as `prior_art_review_required` because it has no reviewed record.
 *
 * Nothing here can prove the reviewer is independent; the reviewer id and rationale are
 * written into the native prior-art basis so the choice stays reviewable. */
import { CATALOGUE_ID, HASH, OrganizationError, digest, exactKeys, need, nativeProjectId, plain, text } from './common.mjs';
import { BOOTSTRAP_REVIEW_SCHEMA, NATIVE_CLASSES, openProjectPayload } from './bootstrap.mjs';
import { PRIOR_ART_PRODUCER_ID, PRIOR_ART_SOURCES } from './prior-art.mjs';

export const BOOTSTRAP_DRAFT_SCHEMA = 'uain-project-organization-bootstrap-draft-v1';
export const BOOTSTRAP_DRAFTER_ID = 'uain-project-organization-bootstrap-drafter-v1';
export const DRAFT_STATUSES = Object.freeze(['assessment_required', 'insufficient_searches']);
/** Promotion outcomes that are not a record: the project must not be opened as new work. */
export const PROMOTION_HOLDS = Object.freeze(['prior_art_open_solution_found', 'prior_art_known_answer']);
export const DRAFT_NOTE = 'DRAFT. Searches only; no class, no assessment and no novelty claim. An independent reviewer ' +
  '(not this drafting step and not the proposing model) must read the searches, set class (benevolent or neutral) and the ' +
  'explicit assessment {openSolutionFound, knownAnswer, reviewer, rationale}; promoteDraft() in ' +
  'services/project-organizations/src/bootstrap-record.mjs then builds the reviewed bootstrap record bootstrap.mjs accepts. ' +
  'Until then the project holds as prior_art_review_required.';

const NATIVE_MIN_SEARCHES = 2;
const NATIVE_MAX_SEARCHES = 20;
const BASIS_MAX = 4000;
const REVIEWER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/;
const LABELS = new Set(Object.values(PRIOR_ART_SOURCES).map((s) => s.label));
const SOURCE_IDS = new Set(Object.keys(PRIOR_ART_SOURCES));
const DRAFT_KEYS = ['schema', 'status', 'project', 'native_project', 'source_digest', 'source_revision', 'title', 'producer', 'drafted_at',
  'queries', 'searches', 'retrievals', 'failures', 'searches_digest', 'class', 'assessment', 'note'];
const ASSESSMENT_KEYS = ['openSolutionFound', 'knownAnswer', 'reviewer', 'rationale'];

/** The digest prior-art.mjs uses as its pendingId: {subject, searches, retrievals}. */
export const searchesDigestOf = ({ project, criteriaDigest, searches, retrievals }) =>
  digest({ subject: { projectId: project, criteriaDigest }, searches, retrievals });

/** Structural check of a draft file; returns it unchanged. Status may be either draft status. */
export function validateDraft(draft) {
  try {
    need(exactKeys(draft, DRAFT_KEYS) && draft.schema === BOOTSTRAP_DRAFT_SCHEMA && DRAFT_STATUSES.includes(draft.status), 'invalid_bootstrap_draft');
    need(typeof draft.project === 'string' && CATALOGUE_ID.test(draft.project) && draft.native_project === nativeProjectId(draft.project), 'invalid_bootstrap_draft');
    need(HASH.test(draft.source_digest) && /^[a-f0-9]{40}$/.test(draft.source_revision), 'invalid_bootstrap_draft');
    need(typeof draft.title === 'string' && text(draft.title, 1, 1000), 'invalid_bootstrap_draft');
    need(draft.class === null && draft.assessment === null, 'draft_already_assessed', 'a draft carries no class or assessment');
    const p = draft.producer;
    need(exactKeys(p, ['kind', 'id', 'drafter', 'sources', 'criteriaDigest']) && p.kind === 'trusted_search' && p.id === PRIOR_ART_PRODUCER_ID &&
      p.drafter === BOOTSTRAP_DRAFTER_ID && Array.isArray(p.sources) && p.sources.every((s) => SOURCE_IDS.has(s)) && HASH.test(p.criteriaDigest),
    'invalid_bootstrap_draft');
    need(!Number.isNaN(Date.parse(draft.drafted_at)), 'invalid_bootstrap_draft');
    need(Array.isArray(draft.queries) && draft.queries.every((q) => typeof q === 'string'), 'invalid_bootstrap_draft');
    need(Array.isArray(draft.searches) && Array.isArray(draft.retrievals) && draft.searches.length === draft.retrievals.length, 'invalid_bootstrap_draft');
    need(Array.isArray(draft.failures) && draft.failures.every((f) => exactKeys(f, ['source', 'query', 'code'])), 'invalid_bootstrap_draft');
    for (const [i, s] of draft.searches.entries()) {
      const r = draft.retrievals[i];
      need(exactKeys(s, ['query', 'source', 'observedAt', 'resultSummary']) && LABELS.has(s.source), 'invalid_bootstrap_draft');
      need(exactKeys(r, ['source', 'query', 'url', 'finalUrl', 'sha256', 'bytes', 'observedAt']) && SOURCE_IDS.has(r.source) &&
        PRIOR_ART_SOURCES[r.source].label === s.source && r.query === s.query && r.observedAt === s.observedAt && HASH.test(r.sha256), 'invalid_bootstrap_draft');
      // Every search is bound to the exact URL and bytes it was read from.
      need(typeof s.resultSummary === 'string' && s.resultSummary.startsWith(`url=${r.finalUrl}; sha256=${r.sha256}; `), 'draft_binding_mismatch');
      need(new URL(r.finalUrl).hostname === PRIOR_ART_SOURCES[r.source].host, 'draft_binding_mismatch');
    }
    need(HASH.test(draft.searches_digest) && draft.searches_digest === searchesDigestOf({
      project: draft.project, criteriaDigest: p.criteriaDigest, searches: draft.searches, retrievals: draft.retrievals,
    }), 'draft_digest_mismatch', 'the searches were changed after drafting');
    return draft;
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError('invalid_bootstrap_draft');
  }
}

/** One native search string per collected search: source, query and its URL+sha256 binding. */
export const nativeSearchOf = (search, retrieval) => `${search.source} "${search.query}" url=${retrieval.finalUrl} sha256=${retrieval.sha256}`;

/**
 * promoteDraft(draft, { class, assessment: {openSolutionFound, knownAnswer, reviewer, rationale, searchesDigest?} },
 *              { selection?, excludedReviewers? })
 *   -> the reviewed bootstrap record {schema, project, source_digest, class, prior_art: {basis, searches}}
 *   -> or a frozen hold {status: 'held', reason, project, reviewer} when the reviewer found an
 *      open solution or a known answer (never a record: the project is not new work).
 * Throws on anything else that is not a valid independent review of these exact searches.
 */
export function promoteDraft(draft, review, { selection = null, excludedReviewers = [] } = {}) {
  validateDraft(draft);
  need(draft.status === 'assessment_required', 'insufficient_searches', `${draft.project} has fewer than ${NATIVE_MIN_SEARCHES} successful searches`);
  need(exactKeys(review, ['class', 'assessment']), 'invalid_review', 'review takes class and assessment only');
  const a = review.assessment;
  need(plain(a), 'assessment_required');
  const keys = Object.hasOwn(a, 'searchesDigest') ? [...ASSESSMENT_KEYS, 'searchesDigest'] : ASSESSMENT_KEYS;
  need(exactKeys(a, keys), 'invalid_assessment', 'assessment fields');
  need(typeof a.openSolutionFound === 'boolean' && typeof a.knownAnswer === 'boolean', 'invalid_assessment',
    'openSolutionFound and knownAnswer must be explicit booleans');
  need(typeof a.reviewer === 'string' && REVIEWER.test(a.reviewer), 'invalid_assessment', 'reviewer');
  need(Array.isArray(excludedReviewers) && excludedReviewers.every((r) => typeof r === 'string'), 'invalid_review', 'excludedReviewers');
  const producers = [draft.producer.id, draft.producer.drafter, ...excludedReviewers];
  need(!producers.includes(a.reviewer), 'reviewer_not_independent', 'the drafting step or the proposing model cannot review its own searches');
  need(text(a.rationale, 20, 2000) && !/[\r\t]/.test(a.rationale), 'invalid_assessment', 'rationale of at least 20 characters');
  need(a.searchesDigest === undefined || a.searchesDigest === draft.searches_digest, 'assessment_digest_mismatch',
    'the assessment was made for other searches');
  if (selection !== null) {
    const p = selection.get(draft.project);
    need(p.sourceDigest === draft.source_digest, 'prior_art_review_stale', `${draft.project} draft predates the pinned source`);
  }
  if (a.openSolutionFound || a.knownAnswer) {
    return Object.freeze({
      status: 'held', reason: a.openSolutionFound ? 'prior_art_open_solution_found' : 'prior_art_known_answer',
      project: draft.project, reviewer: a.reviewer, openSolutionFound: a.openSolutionFound, knownAnswer: a.knownAnswer,
    });
  }
  // Class is checked after the hold: a project not opened needs no class.
  need(NATIVE_CLASSES.includes(review.class), 'invalid_review', 'class must be benevolent or neutral');

  const searches = draft.searches.map((s, i) => nativeSearchOf(s, draft.retrievals[i]));
  need(new Set(searches).size === searches.length && searches.length >= NATIVE_MIN_SEARCHES, 'insufficient_searches');
  need(searches.length <= NATIVE_MAX_SEARCHES, 'too_many_searches', `native accepts at most ${NATIVE_MAX_SEARCHES} searches`);
  const labels = [...new Set(draft.searches.map((s) => s.source))].join(', ');
  let basis = `Independent review by ${a.reviewer}: ${a.rationale.trim().replace(/\s+/g, ' ')} ` +
    `(open solution found: no; known answer: no; ${searches.length} project-level searches of ${labels}; ` +
    `draft ${draft.searches_digest}, source ${draft.source_digest})`;
  if (Buffer.byteLength(basis) > BASIS_MAX) basis = Buffer.from(basis).subarray(0, BASIS_MAX - 3).toString('utf8').replace(/�+$/, '') + '...';
  const record = {
    schema: BOOTSTRAP_REVIEW_SCHEMA, project: draft.project, source_digest: draft.source_digest, class: review.class,
    prior_art: { basis, searches },
  };
  // The same bounds native open_project enforces (title, class, basis, 2..20 distinct searches).
  try {
    openProjectPayload({ id: draft.native_project, title: draft.title, class: record.class, prior_art: record.prior_art });
  } catch {
    throw new OrganizationError('invalid_prior_art_review', `${draft.project} promoted record does not fit native bounds`);
  }
  return record;
}
