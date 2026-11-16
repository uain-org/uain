/** Project agents (Rahul, 9 November 2026): every project organization runs its own two AI agents,
 * which start as soon as there is activity on that project (a join, a submission, a review result or
 * a completed task) and keep at least three small units open.
 *
 *   project manager (role `writer`)  reads the project's Main KPI, what its parts already cover and
 *                                    how much is open, and proposes the next small units: 1 to 3
 *                                    identifiers of existing work each (DOI, arXiv, GitHub, PubMed,
 *                                    NCT, Wikidata) that no part of the project lists yet;
 *   task assessor (role `assessor`)  a separate execution that sees each unit with the titles the
 *                                    fixed record API returned, and accepts or rejects it.
 *
 * Both run on Sonnet (`claude-sonnet-5-5`, decided 9 November 2026). Neither signs, prices, funds or
 * reviews anything: an accepted unit becomes a survey part built by `buildAgentPartPayloads` (fixed
 * criteria, the hash-pinned prior-art-survey verifier, 20 AI$ per record plus a 10 AI$ check), which
 * the organization starter opens from the project's allowance and central UAIN review decides.
 * This module is pure: no file, network, model or native access.
 */
import { CATALOGUE_ID, exactKeys, need, plain, sha256, text } from './common.mjs';
import { KINDS, normalizeId } from '../verifiers/prior-art-survey.mjs';
import { SURVEY_PART_MAX_PARTS, SURVEY_PART_MAX_REQUIRED, parseSurveyPartId } from './survey.mjs';

export const PROJECT_AGENT_MODEL = 'claude-sonnet-5-5';
export const PROJECT_AGENT_ROLES = Object.freeze(['writer', 'assessor']);
export const TARGET_OPEN = 3;
export const MAX_UNITS_PER_RUN = 3;
/** Native operations by members that count as project activity. Openings and fundings signed by the
 * project's own guardian are the agents' own output and never wake them. */
export const ACTIVITY_OPERATIONS = Object.freeze(['project_join', 'central_submit', 'central_review']);

const str = { type: 'string' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const record = object({ kind: { type: 'string', enum: [...KINDS] }, id: str });
export const PROJECT_AGENT_SCHEMAS = Object.freeze({
  writer: object({
    units: { type: 'array', maxItems: MAX_UNITS_PER_RUN, items: object({ records: { type: 'array', minItems: 1, maxItems: SURVEY_PART_MAX_REQUIRED, items: record }, reason: str }) },
    note: str,
  }),
  assessor: object({
    verdicts: { type: 'array', maxItems: MAX_UNITS_PER_RUN, items: object({ unit: { type: 'integer', minimum: 1, maximum: MAX_UNITS_PER_RUN }, accept: { type: 'boolean' }, reason: str }) },
  }),
});

/** The catalogue project of a native subject: `P-OPP-xxxxx` or a task `T-OPP-xxxxx-…`. */
export function subjectProject(subject) {
  if (typeof subject !== 'string') return null;
  const m = /^(?:P-|T-)(OPP-[0-9]{5})(?:$|-)/.exec(subject);
  return m ? m[1] : null;
}

/** Activity per project from proven native events. `submissionTask` maps a submission id to its task
 * (the subject of a submission and of a review is the submission id). Events by `ownMembers` (guardian, Fund Manager) are skipped.
 * @returns Map<projectId, Array<{id, operation, member, subject}>> */
export function activityFromEvents(events, { projects, ownMembers = [], submissionTask = new Map() } = {}) {
  const wanted = new Set(projects);
  const own = new Set(ownMembers);
  const out = new Map();
  for (const e of events) {
    need(plain(e) && typeof e.id === 'string' && typeof e.operation === 'string' && typeof e.subject === 'string', 'invalid_native_event');
    if (!ACTIVITY_OPERATIONS.includes(e.operation) || own.has(e.member)) continue;
    const project = subjectProject(e.subject) ?? subjectProject(submissionTask.get(e.subject));
    if (!project || !wanted.has(project)) continue;
    if (!out.has(project)) out.set(project, []);
    out.get(project).push({ id: e.id, operation: e.operation, member: e.member, subject: e.subject });
  }
  return out;
}

/** A part a newcomer can take now: open, nothing pending, no winner. */
const accepting = (t) => plain(t) && t.state === 'open' && !t.pending && !t.winner;

/** Stock of one project from its built part files and native task records.
 * @param built Array of `uain-survey-parts-build-v1` files (installed and agent revisions)
 * @param opened Set of request ids whose opening finalized
 * @param records {taskId: native record}
 * @param surveyCovered records the project's open full survey already lists (a v1 project such as
 *   OPP-00002, 10 November 2026): covered, so no unit repeats them, but not counted as units. */
export function projectStock(projectId, built, opened, records, { surveyCovered = [] } = {}) {
  need(CATALOGUE_ID.test(projectId), 'invalid_project');
  need(Array.isArray(surveyCovered) && surveyCovered.every((r) => plain(r) && KINDS.includes(r.kind) && normalizeId(r.kind, r.id) === r.id), 'invalid_parts');
  const covered = surveyCovered.map((r) => ({ kind: r.kind, id: r.id })), revisions = new Set();
  let open = 0, unopened = 0, underReview = 0, accepted = 0;
  for (const file of built) {
    need(plain(file) && file.project === projectId && Array.isArray(file.parts), 'invalid_parts');
    revisions.add(file.revision);
    for (const row of file.parts) {
      const id = row.request.payload.id;
      need(parseSurveyPartId(id)?.projectId === projectId, 'invalid_parts');
      for (const r of row.policy.successTests[0].requiredIds) covered.push({ kind: r.kind, id: r.id });
      if (!opened.has(row.request.id)) { unopened++; continue; }
      const t = records[id];
      if (accepting(t)) open++;
      else if (plain(t) && t.state === 'accepted') accepted++;
      else if (plain(t) && t.pending) underReview++;
    }
  }
  return { projectId, open, unopened, underReview, accepted, covered, revisions: [...revisions].sort((a, b) => a - b) };
}

/** How many new units the project needs to keep `target` accepting (open now or waiting to open). */
export const unitsNeeded = (stock, target = TARGET_OPEN) => Math.max(0, Math.min(MAX_UNITS_PER_RUN, target - stock.open - stock.unopened));

/** The next agent revision: 3..9, never an existing one. */
export function nextRevision(stock) {
  const next = Math.max(2, ...stock.revisions) + 1;
  return next <= 9 ? next : null;
}

const listCovered = (covered) => covered.length ? covered.map((r) => `- ${r.kind} ${r.id}`).join('\n') : '- (none yet)';

export function writerPrompt({ projectId, title, description, mainKpi, stock, needed, activity }) {
  need(CATALOGUE_ID.test(projectId) && text(title, 1, 1000) && text(mainKpi, 1, 4096) && Number.isSafeInteger(needed) && needed >= 0, 'invalid_agent_input');
  return [
    `You are the project manager agent of UAIN project organization ${projectId}: "${title}".`,
    `Main KPI: "${mainKpi}".`,
    description ? `Project description: ${String(description).slice(0, 3000)}` : '',
    `Activity that woke you: ${activity.length ? activity.map((a) => `${a.operation} on ${a.subject}`).join('; ') : 'scheduled check (no new activity)'}.`,
    `Current small units: ${stock.open} open, ${stock.unopened} waiting to open, ${stock.underReview} under review, ${stock.accepted} accepted.`,
    `Your job: propose exactly ${needed} new small unit(s) (0 means propose none and say why in note). Each unit is 1 to ${SURVEY_PART_MAX_REQUIRED} identifiers of`,
    'EXISTING published work, code, trials or datasets that bear on this Main KPI, which a solver will inventory in about 20 minutes',
    '(title, relation to the Main KPI, a short note, and what is still missing). Units are paid 20 AI$ per record plus a 10 AI$ check and',
    'are verified by a fixed record checker, so every identifier must be real and resolvable:',
    '- doi (lowercase, e.g. 10.1038/s41586-020-2649-2), pubmed (PMID digits), nct (NCT + 8 digits), arxiv (e.g. 2401.01234),',
    '  github (owner/repo, lowercase), wikidata (Q-id). Prefer DOI and PubMed. Use web search to confirm each identifier exists.',
    '- Never repeat an identifier already covered (list below). Never invent identifiers; propose fewer units rather than guess.',
    '- Each unit must stand on its own: no unit may depend on another unfinished unit. Group closely related records in one unit.',
    '- Prefer records that the existing coverage misses: other approaches, recent work (2023-2026), negative results, open-source tools.',
    'Already covered by this project\'s parts:',
    listCovered(stock.covered),
    'Answer only with the JSON object the schema asks for: {"units":[{"records":[{"kind":"doi","id":"..."}],"reason":"..."}],"note":"..."}.',
  ].filter(Boolean).join('\n');
}

export function assessorPrompt({ projectId, title, mainKpi, units, covered }) {
  need(CATALOGUE_ID.test(projectId) && Array.isArray(units) && units.length >= 1, 'invalid_agent_input');
  return [
    `You are the independent task assessor agent of UAIN project organization ${projectId}: "${title}". Main KPI: "${mainKpi}".`,
    'Another agent (the project manager) proposed the small units below. Each identifier was already resolved by a fixed record API;',
    'the title shown is what that API returned. Judge each unit separately and accept it only if ALL hold:',
    '1. every record is plausibly relevant to the Main KPI (existing work, partial work or a clearly adjacent approach);',
    '2. a capable AI can inventory the unit in about 20 minutes (titles, relation, note, gaps) with public sources;',
    '3. it stands on its own and duplicates nothing already covered;',
    '4. nothing in it is unsafe, harmful or malevolent.',
    'Already covered:',
    listCovered(covered),
    'Proposed units:',
    ...units.map((u, i) => `Unit ${i + 1}: ${u.records.map((r) => `${r.kind} ${r.id} — "${r.title}"`).join('; ')} (proposer's reason: ${u.reason})`),
    'Answer only with the JSON object the schema asks for: {"verdicts":[{"unit":1,"accept":true,"reason":"..."}]}, one verdict per unit.',
  ].join('\n');
}

/** Normalized, deduplicated writer units; anything malformed or already covered is dropped. */
export function parseWriter(value, { covered = [], needed = MAX_UNITS_PER_RUN } = {}) {
  need(plain(value) && Array.isArray(value.units) && typeof value.note === 'string', 'invalid_writer_output');
  const seen = new Set(covered.map((r) => `${r.kind}:${r.id}`));
  const units = [];
  for (const u of value.units.slice(0, Math.min(needed, MAX_UNITS_PER_RUN))) {
    if (!plain(u) || !Array.isArray(u.records) || typeof u.reason !== 'string') continue;
    const records = [];
    for (const r of u.records.slice(0, SURVEY_PART_MAX_REQUIRED)) {
      const id = plain(r) && KINDS.includes(r.kind) ? normalizeId(r.kind, r.id) : null;
      if (!id || seen.has(`${r.kind}:${id}`)) continue;
      seen.add(`${r.kind}:${id}`);
      records.push({ kind: r.kind, id });
    }
    if (records.length) units.push({ records, reason: u.reason.slice(0, 600) });
  }
  return { units, note: value.note.slice(0, 600) };
}

/** Units the assessor accepted, by 1-based unit number. A unit without a verdict is rejected. */
export function parseAssessor(value, count) {
  need(plain(value) && Array.isArray(value.verdicts), 'invalid_assessor_output');
  const accepted = new Set();
  for (const v of value.verdicts) {
    if (exactKeys(v, ['unit', 'accept', 'reason']) && Number.isSafeInteger(v.unit) && v.unit >= 1 && v.unit <= count && v.accept === true) accepted.add(v.unit);
  }
  return [...accepted].sort((a, b) => a - b);
}

/** Keep only records the fixed record API resolved with a real title; drop emptied units. */
export function resolvedUnits(units, preflightRows) {
  const byKey = new Map(preflightRows.map((r) => [`${r.kind}:${r.id}`, r]));
  return units.map((u) => ({
    ...u, records: u.records.filter((r) => byKey.get(`${r.kind}:${r.id}`)?.status === 'resolved')
      .map((r) => ({ ...r, title: byKey.get(`${r.kind}:${r.id}`).title })),
  })).filter((u) => u.records.length > 0);
}

/** Rolling execution admission: true when `count` more executions fit in the last 24 hours. */
export function executionsAdmitted(timestamps, count, { maxPerDay, now }) {
  need(Number.isSafeInteger(maxPerDay) && maxPerDay >= 2 && maxPerDay <= 1000, 'invalid_agent_config');
  const since = now - 24 * 3600 * 1000;
  return timestamps.filter((t) => t > since).length + count <= maxPerDay;
}

/** Which projects wake this tick: activity since their last run (after the cooldown), else a fallback
 * check once `fallbackHours` passed while the project is short of open units. */
export function wakeOrder({ projects, activity, state, short, now, cooldownMinutes, fallbackHours }) {
  const out = [];
  for (const p of projects) {
    const last = state[p]?.lastRun ?? 0;
    if (now - last < cooldownMinutes * 60000) continue;
    if ((activity.get(p) ?? []).length || (state[p]?.pendingActivity ?? []).length) out.push({ project: p, reason: 'activity' });
    else if (short.has(p) && now - last >= fallbackHours * 3600000) out.push({ project: p, reason: 'fallback' });
  }
  // Activity first, then the longest-waiting fallback projects.
  return out.sort((a, b) => (a.reason === b.reason ? (state[a.project]?.lastRun ?? 0) - (state[b.project]?.lastRun ?? 0) : a.reason === 'activity' ? -1 : 1));
}

export const receiptDigest = (receipt) => sha256(JSON.stringify(receipt));
export { SURVEY_PART_MAX_PARTS };
