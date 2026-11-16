/** Reviewed candidate tasks for the manager stage (Rahul, 7 November 2026).
 *
 * An optional, root-owned input (`/etc/uain-custody/manager-stage/candidates.json`) of reviewed
 * task suggestions per starter project. The manager stage passes a project's candidates, and only
 * that project's, to its fenced manager run as labelled data. The manager decides: it may adopt,
 * adapt or ignore them. Nothing here is prior art, a price or an approval. Every task the manager
 * returns, whether or not it derives from a candidate, still goes through the trusted prior-art
 * search, the independent fenced assessment and `buildTaskProposal`/`validatePricedTask`.
 *
 * For that reason a candidate carries exactly the manager's task shape plus an `id`: no searches,
 * citations, novelty verdicts or other prior-art fields (a draft's own drafting searches stay in
 * the reviewed source document, bound here by `reviewed.sourceDigest`).
 *
 * Schema `uain-manager-candidates-v1` (unknown fields anywhere are refused):
 *   { "schema": "uain-manager-candidates-v1",
 *     "reviewed": { "by": "...", "at": "YYYY-MM-DD", "source": "...", "sourceDigest": "<sha256 hex>" },
 *     "projects": { "OPP-00002": [ { "id": "opp-00002-...", "title", "criteria", "eligibility",
 *                                    "eligibility_basis", "proposed_price": { "solver_amount",
 *                                    "reviewer_amount", "rationale": { "effort", "difficulty",
 *                                    "novelty", "verificationCost" } } } ] } }
 *
 * `ops/custody/manager_stage.py` mirrors the structural checks (`validate_candidates`); this module
 * adds the selection and the manager-output screen (authority claims, signer words, other projects). */
import { CATALOGUE_ID, HASH, byText, canonical, digest, exactKeys, need, plain, sha256, text, units } from './common.mjs';
import { CANDIDATE_ID, MAX_CANDIDATES, PRICE_RATIONALE_PARTS, ROUND_CEILING_UNITS, screenRefusal } from './leadership.mjs';

export const CANDIDATES_SCHEMA = 'uain-manager-candidates-v1';
export const CANDIDATES_PATH = '/etc/uain-custody/manager-stage/candidates.json';
/** Whole file, and one project's list as canonical JSON (keeps the manager prompt under 64 KiB). */
export const MAX_CANDIDATES_BYTES = 262144;
export const MAX_PROJECT_CANDIDATES_BYTES = 16384;
export const MAX_CANDIDATE_PROJECTS = 120;
export { CANDIDATE_ID };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ELIGIBILITY = ['hard', 'new', 'unresolved'];
const TASK_KEYS = ['id', 'title', 'criteria', 'eligibility', 'eligibility_basis', 'proposed_price'];
const bad = (detail) => need(false, 'invalid_manager_candidates', detail);

function checkCandidate(c, projectId, at) {
  if (!exactKeys(c, TASK_KEYS)) bad(`${at}: fields must be exactly ${TASK_KEYS.join(', ')}`);
  if (!(typeof c.id === 'string' && CANDIDATE_ID.test(c.id) && c.id.startsWith(projectId.toLowerCase() + '-'))) bad(`${at}.id`);
  if (!text(c.title, 3, 240)) bad(`${at}.title`);
  if (!text(c.criteria, 20, 4096)) bad(`${at}.criteria`);
  if (!ELIGIBILITY.includes(c.eligibility)) bad(`${at}.eligibility`);
  if (!text(c.eligibility_basis, 20, 2048)) bad(`${at}.eligibility_basis`);
  const q = c.proposed_price;
  if (!exactKeys(q, ['solver_amount', 'reviewer_amount', 'rationale'])) bad(`${at}.proposed_price`);
  let total;
  try {
    total = units(q.solver_amount) + units(q.reviewer_amount);
  } catch {
    bad(`${at}.proposed_price amounts`);
  }
  // A suggestion never above round 1's whole allowance; the run's own bound narrows it further.
  if (total > ROUND_CEILING_UNITS[0]) bad(`${at}.proposed_price above the round-1 ceiling`);
  if (!exactKeys(q.rationale, PRICE_RATIONALE_PARTS)) bad(`${at}.proposed_price.rationale`);
  for (const part of PRICE_RATIONALE_PARTS) if (!text(q.rationale[part], 10, 2000)) bad(`${at}.proposed_price.rationale.${part}`);
  // The same screen the manager's own output passes: no authority claims, signer words or other projects.
  for (const [path, value] of [['title', c.title], ['criteria', c.criteria], ['eligibility_basis', c.eligibility_basis],
    ...PRICE_RATIONALE_PARTS.map((part) => [`proposed_price.rationale.${part}`, q.rationale[part]])]) {
    const refused = screenRefusal(value, projectId);
    if (refused) bad(`${at}.${path}: ${refused}`);
  }
}

/** Strict validation; returns a deep-frozen copy. `selection` (optional) requires every project to be
 * a selected, unheld project. */
export function validateCandidates(value, { selection } = {}) {
  need(plain(value) && exactKeys(value, ['schema', 'reviewed', 'projects']) && value.schema === CANDIDATES_SCHEMA, 'invalid_manager_candidates', 'schema');
  const r = value.reviewed;
  if (!(exactKeys(r, ['by', 'at', 'source', 'sourceDigest']) && text(r.by, 3, 200) && typeof r.at === 'string' && DAY.test(r.at) &&
    !Number.isNaN(Date.parse(r.at + 'T00:00:00Z')) && text(r.source, 1, 300) && typeof r.sourceDigest === 'string' && HASH.test(r.sourceDigest))) bad('reviewed');
  need(plain(value.projects), 'invalid_manager_candidates', 'projects');
  const ids = Object.keys(value.projects);
  if (!(ids.length >= 1 && ids.length <= MAX_CANDIDATE_PROJECTS && ids.every((id) => CATALOGUE_ID.test(id)))) bad('projects');
  const seen = new Set();
  for (const projectId of ids) {
    if (selection) {
      let project;
      try {
        project = selection.get(projectId);
      } catch {
        bad(`${projectId} is not a selected project`);
      }
      if (project.holds.length) bad(`${projectId} is held`);
    }
    const list = value.projects[projectId];
    if (!(Array.isArray(list) && list.length >= 1 && list.length <= MAX_CANDIDATES)) bad(`${projectId}: 1 to ${MAX_CANDIDATES} candidates`);
    list.forEach((c, i) => checkCandidate(c, projectId, `${projectId}[${i}]`));
    for (const c of list) {
      if (seen.has(c.id)) bad(`duplicate candidate id ${c.id}`);
      seen.add(c.id);
    }
    if (Buffer.byteLength(canonical(list)) > MAX_PROJECT_CANDIDATES_BYTES) bad(`${projectId}: candidates above ${MAX_PROJECT_CANDIDATES_BYTES} bytes`);
  }
  // Sizes last: by now every value is a plain JSON value.
  need(Buffer.byteLength(canonical(value)) <= MAX_CANDIDATES_BYTES, 'invalid_manager_candidates', 'file too large');
  return deepFreeze(structuredClone(value));
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** One project's candidates (a fresh array), or [] when the file is absent or lists none for it. */
export function candidatesFor(candidates, projectId) {
  if (!candidates) return [];
  return Object.hasOwn(candidates.projects, projectId) ? structuredClone(candidates.projects[projectId]) : [];
}

/** Candidate counts for the listed projects (0 for a project with none). */
export function candidateCounts(candidates, projects) {
  return Object.fromEntries(projects.map((p) => [p, candidatesFor(candidates, p).length]));
}

/** What a run record keeps about the file: its digest and review, not its text. */
export function candidatesRecord(candidates, projectId) {
  return { schema: CANDIDATES_SCHEMA, digest: digest(candidates), reviewed: structuredClone(candidates.reviewed),
    offered: candidatesFor(candidates, projectId).map((c) => c.id) };
}

/** Deterministic converter from the reviewed drafts document (`uain-small-task-drafts-v1`, PR #253)
 * to `uain-manager-candidates-v1`. It keeps only each draft's task and key: the drafting
 * searches, nearest prior art, registry observations and the dropped list are left out on purpose
 * (they are not the trusted record). `sourceBytes` are the exact drafts file bytes. */
export function candidatesFromDrafts(sourceBytes, { reviewedBy, reviewedAt, source }) {
  need([reviewedBy, reviewedAt, source].every((v) => typeof v === 'string'), 'invalid_manager_candidates', 'reviewed-by, reviewed-at and source are required');
  const doc = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
  need(plain(doc) && doc.schema === 'uain-small-task-drafts-v1' && Array.isArray(doc.drafts), 'invalid_drafts', 'schema');
  const projects = {};
  for (const d of doc.drafts) {
    need(plain(d) && typeof d.key === 'string' && typeof d.projectId === 'string' && CATALOGUE_ID.test(d.projectId) && plain(d.task), 'invalid_drafts', 'draft');
    const t = d.task;
    const q = t.proposed_price ?? {};
    (projects[d.projectId] ??= []).push({
      id: d.key, title: t.title, criteria: t.criteria, eligibility: t.eligibility, eligibility_basis: t.eligibility_basis,
      proposed_price: { solver_amount: q.solver_amount, reviewer_amount: q.reviewer_amount,
        rationale: Object.fromEntries(PRICE_RATIONALE_PARTS.map((part) => [part, q.rationale?.[part]])) },
    });
  }
  const sorted = Object.fromEntries(Object.keys(projects).sort(byText).map((p) => [p, projects[p]]));
  return validateCandidates({ schema: CANDIDATES_SCHEMA, reviewed: { by: reviewedBy, at: reviewedAt, source, sourceDigest: sha256(sourceBytes) }, projects: sorted });
}
