/** The public template of a prior-art survey part, derived from its native task.
 *
 * Survey parts (`T-OPP-xxxxx-1-prior-art-survey-r<2-9>-p<1-99>`) are opened by project
 * organizations over time, so BAINK cannot ship a static template row for each one. A part's
 * native criteria text is generated deterministically by
 * services/project-organizations/src/survey.mjs `surveyPartCriteria` and lists every
 * required identifier, so the template can be read back from the proved native record.
 *
 * The generator is mirrored here, not imported: a BAINK release packages only server/,
 * review-service/, integrations/, shared/ and catalogue/ (deploy/runtime-sources.mjs).
 * apps/baink/test/survey-part-template.test.mjs pins the mirror to the original byte for
 * byte. Parsing is strict: the parsed fields must regenerate the native criteria exactly,
 * and sha256(criteria) must equal the task's native acceptance digest. Anything else is
 * refused (null), and the route answers its usual 404.
 */
import { createHash } from 'node:crypto';

export const SURVEY_PART_TASK = /^T-(OPP-[0-9]{5})-1-prior-art-survey-r([2-9])-p([1-9][0-9]?)$/;
// survey.mjs / verifiers/prior-art-survey.mjs constants (pinned by the test).
export const SURVEY_PART_KINDS = Object.freeze(['doi', 'arxiv', 'github', 'pubmed', 'nct', 'wikidata']);
export const SURVEY_PART_MAX_ITEMS = 60;
export const SURVEY_PART_MAX_REQUIRED = 3;
export const SURVEY_PART_MINUTES = 20;
export const SURVEY_PART_MIN_INCLUDED = 1;
export const SURVEY_PART_MIN_KINDS = 1;
const ID_PATTERNS = Object.freeze({
  doi: /^10\.[0-9]{4,9}\/[-._;()/:a-z0-9<>[\]]{1,200}$/,
  arxiv: /^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]{2,20}(?:\.[a-z]{2})?\/[0-9]{7})(?:v[0-9]{1,3})?$/,
  github: /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/,
  pubmed: /^[1-9][0-9]{0,9}$/,
  nct: /^NCT[0-9]{8}$/,
  wikidata: /^Q[1-9][0-9]{0,11}$/,
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** verifiers/prior-art-survey.mjs `normalizeId`. */
export function normalizeSurveyPartId(kind, id) {
  if (typeof id !== 'string' || !Object.hasOwn(ID_PATTERNS, kind)) return null;
  let value = id.trim();
  if (kind === 'doi') value = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  if (kind === 'arxiv') value = value.replace(/^arxiv:/i, '').toLowerCase().replace(/v[0-9]{1,3}$/, '');
  if (kind === 'github') value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').toLowerCase();
  if (kind === 'nct' || kind === 'wikidata') value = value.toUpperCase();
  return ID_PATTERNS[kind].test(value) ? value : null;
}

// survey.mjs `clip` and common.mjs `text`.
const clip = (value, bytes) => {
  if (Buffer.byteLength(value) <= bytes) return value;
  return Buffer.from(value).subarray(0, bytes - 3).toString('utf8').replace(/�+$/, '').trimEnd() + '...';
};
const text = (v, min, max) => typeof v === 'string' && v.trim().length >= min && Buffer.byteLength(v) <= max &&
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** survey.mjs `surveyPartCriteria`, byte for byte. Returns null where the original throws. */
export function surveyPartCriteriaText({ title, mainKpi, part, parts, requiredIds }) {
  if (!(text(title, 1, 1000) && text(mainKpi, 20, 4096) && Number.isSafeInteger(part) && Number.isSafeInteger(parts) && part >= 1 &&
    part <= parts && Array.isArray(requiredIds) && requiredIds.length >= 1 && requiredIds.length <= SURVEY_PART_MAX_REQUIRED &&
    requiredIds.every((r) => plain(r) && normalizeSurveyPartId(r.kind, r.id) === r.id))) return null;
  const required = requiredIds.length;
  const listed = requiredIds.map((r) => `${r.kind} ${r.id}`).join('; ');
  return `Prior-art survey part ${part} of ${parts} for "${clip(title, 200)}". Main KPI: "${clip(mainKpi, 600)}". ` +
    `A small unit, expected within ${SURVEY_PART_MINUTES} minutes: check ${required === 1 ? 'this identifier' : `these ${required} identifiers`} ` +
    `the project-level searches returned against this Main KPI: ${listed}. Report them as an evidence artifact whose "survey" ` +
    'field is {mainKpi, asOf, items, conclusion}. mainKpi is the Main KPI above, exactly. asOf is the survey date (YYYY-MM-DD). ' +
    `Each of 1 to ${SURVEY_PART_MAX_ITEMS} items is {kind, id, title, relation, note}: kind is one of ${SURVEY_PART_KINDS.join(', ')}; ` +
    'id is the canonical identifier; title is the title of that record; relation is meets_main_kpi, partial, adjacent or screened_out; ' +
    'note says in 10 to 400 bytes what the item does for the Main KPI, or why it was screened out. ' +
    `Every identifier above is an item, and at least ${SURVEY_PART_MIN_INCLUDED} item is not screened out (add one record you found if ` +
    'all listed ones are unrelated). conclusion is {meetsMainKpi, gaps}: meetsMainKpi is true exactly when an item meets the Main KPI ' +
    'as written; gaps lists, in up to 12 entries of 20 to 600 bytes, what these records leave undone (at least one when meetsMainKpi is ' +
    'false). Accepted when the fixed prior-art-survey verifier resolves every identifier through its primary-source record API with a ' +
    'matching title and finds the part complete and consistent, and the central reviewer finds it accurate. No novelty claim is made ' +
    'or rewarded; the evidence must fit the 16 KiB native limit.';
}

const LIST_MARK = ' the project-level searches returned against this Main KPI: ';
const KPI_MARK = '". Main KPI: "';
const UNIT_MARK = `". A small unit, expected within ${SURVEY_PART_MINUTES} minutes: check `;
// Everything after the identifier list is fixed text.
const TAIL = (() => {
  const sample = surveyPartCriteriaText({ title: 'x', mainKpi: 'x'.repeat(20), part: 1, parts: 1, requiredIds: [{ kind: 'pubmed', id: '1' }] });
  return sample.slice(sample.indexOf('pubmed 1') + 'pubmed 1'.length);
})();
const once = (haystack, needle) => {
  const at = haystack.indexOf(needle);
  return at >= 0 && haystack.indexOf(needle, at + 1) === -1 ? at : -1;
};

/** `{title, mainKpi, part, parts, requiredIds}` that regenerate `criteria` exactly, or null. */
export function parseSurveyPartCriteria(criteria) {
  if (typeof criteria !== 'string' || Buffer.byteLength(criteria) > 4096 || !criteria.endsWith(TAIL)) return null;
  const head = /^Prior-art survey part ([1-9][0-9]?) of ([1-9][0-9]?) for "/.exec(criteria);
  if (!head) return null;
  const body = criteria.slice(head[0].length, criteria.length - TAIL.length);
  const kpiAt = once(body, KPI_MARK), unitAt = once(body, UNIT_MARK), listAt = once(body, LIST_MARK);
  if (kpiAt < 0 || unitAt < 0 || listAt < 0 || !(kpiAt < unitAt && unitAt < listAt)) return null;
  const title = body.slice(0, kpiAt), mainKpi = body.slice(kpiAt + KPI_MARK.length, unitAt);
  const count = body.slice(unitAt + UNIT_MARK.length, listAt);
  const required = count === 'this identifier' ? 1 : /^these ([23]) identifiers$/.exec(count)?.[1];
  if (!required) return null;
  const entries = body.slice(listAt + LIST_MARK.length).split('; ');
  if (entries.length !== Number(required)) return null;
  const requiredIds = [];
  for (const entry of entries) {
    const space = entry.indexOf(' ');
    const kind = entry.slice(0, space), id = entry.slice(space + 1);
    if (space < 1 || normalizeSurveyPartId(kind, id) !== id) return null;
    requiredIds.push({ kind, id });
  }
  // A Main KPI over 600 bytes is clipped in the criteria; the policy keeps the full text, so a
  // clipped (or clip-shaped) Main KPI cannot be published as the exact one.
  if (mainKpi.endsWith('...')) return null;
  const parsed = { title, mainKpi, part: Number(head[1]), parts: Number(head[2]), requiredIds };
  return surveyPartCriteriaText(parsed) === criteria ? parsed : null;
}

/** The survey-template row for a proved native survey-part task, or null when it is not one.
 * A part under review keeps its template (10 November 2026): its author needs it to revise a survey
 * after the reviewer asks for more evidence, and the criteria are already public on the task. */
export function surveyPartTemplate(taskId, task) {
  const id = typeof taskId === 'string' ? SURVEY_PART_TASK.exec(taskId) : null;
  if (!id || !plain(task) || task.id !== taskId || task.project !== `P-${id[1]}` || !['open', 'open_unfunded', 'under_review'].includes(task.state) ||
    typeof task.criteria !== 'string' || !/^[a-f0-9]{64}$/.test(task.acceptance_digest ?? '') || sha256(task.criteria) !== task.acceptance_digest) return null;
  const parsed = parseSurveyPartCriteria(task.criteria);
  if (!parsed || parsed.part !== Number(id[3]) || typeof task.title !== 'string' || !task.title.endsWith(` (part ${parsed.part} of ${parsed.parts})`)) return null;
  return {
    project: task.project,
    criteriaDigest: task.acceptance_digest,
    mainKpi: parsed.mainKpi,
    minIncluded: SURVEY_PART_MIN_INCLUDED,
    minKinds: SURVEY_PART_MIN_KINDS,
    required: parsed.requiredIds.map((r) => ({ kind: r.kind, id: r.id, title: null })),
  };
}
