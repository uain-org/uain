/**
 * Task difficulty estimation (team decision, 6 November 2026, owner Rahul): label
 * every paid central task starter, standard or advanced, so new members are offered
 * easy, quickly payable work instead of project managers lowering task values by hand.
 *
 * Pure and deterministic: the same task and requirements always give the same answer.
 * No I/O, no clock, no randomness and no model call. Every point is explained in
 * `reasons`. The estimate is advisory: it never opens, prices, funds or closes a task,
 * so every task it labels has already met the novelty rule (or is a project's
 * prior-art survey, decision D2) before it reaches the native index.
 *
 * Inputs, all already on a task today:
 *   - kind: a prior-art survey (`T-<project>-1-prior-art-survey`, or a published
 *     policy of class `prior_art_survey`) or an evidence task;
 *   - verification: a published fixed verifier (hash-pinned driver), the survey's
 *     declared fixed verifier, or the central reviewer on the evidence alone;
 *   - eligibility class (`new`, `hard`, `unresolved`);
 *   - acceptance criteria count (evidence tasks; a survey's criteria are a template);
 *   - work items the verifier requires (max of `minIncluded` and `requiredIds`);
 *   - an explicit timebox in the criteria ("within 45 minutes", "timebox: 2 hours");
 *   - the solver reward (the manager prices by effort);
 *   - earlier rejections, derived from native `paid` (a reject pays the reviewer and
 *     returns the task to `open_unfunded`, so `paid` counts reviewer payouts).
 *
 * Levels: score 0-1 with a deterministic verifier is starter; 2-4 standard; 5+ advanced.
 * A starter is also short (Rahul, 9 November 2026: split tasks an AI can finish easily): its
 * estimated maximum is at most STARTER_MAX_MINUTES, otherwise it is standard. A survey part
 * (`T-<project>-1-prior-art-survey-r<n>-p<k>`, at most 3 records) is the starter unit.
 */
const DIFFICULTY_SCHEMA = 'baink-task-difficulty-v1';
export const DIFFICULTY_LEVELS = Object.freeze(['starter', 'standard', 'advanced']);
const SURVEY_TASK_ID = /^T-[A-Za-z0-9._-]+-1-prior-art-survey$/;
export const SURVEY_PART_TASK_ID = /^T-[A-Za-z0-9._-]+-1-prior-art-survey-r[2-9]-p[1-9][0-9]?$/;
export const STARTER_MAX_SCORE = 1;
export const STARTER_MAX_MINUTES = 30;
export const ADVANCED_MIN_SCORE = 5;
const UNITS_PER_AI = 1_000_000n;
const UINT = /^(0|[1-9][0-9]{0,30})$/;

const big = (v) => (typeof v === 'string' && UINT.test(v) ? BigInt(v) : null);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
const ai = (units) => {
  const whole = units / UNITS_PER_AI, frac = units % UNITS_PER_AI;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(6, '0').replace(/0+$/, '')}`;
};

/** The survey success test from a published requirements object, or null. */
function surveyTest(requirements) {
  if (!plain(requirements) || requirements.available !== true) return null;
  const tests = requirements.policy?.successTests;
  return Array.isArray(tests) && plain(tests[0]) ? tests[0] : null;
}

/**
 * Acceptance criteria count: enumerated lines ("- x", "1. x", "(a) x") when the
 * criteria list at least two; otherwise sentences. Deterministic and bounded.
 */
export function countCriteria(text) {
  if (typeof text !== 'string' || !text.trim()) return 0;
  const bounded = text.slice(0, 8192);
  const listed = bounded.split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\(?[0-9]{1,2}[.)]|\(?[a-z][.)])\s+\S/.test(line)).length;
  if (listed >= 2) return listed;
  return bounded.split(/(?<=[.!?;])\s+(?=[A-Z0-9("'])/).map((s) => s.trim()).filter((s) => s.length >= 12).length;
}

/** An explicit timebox in the criteria, in minutes, or null. */
export function timeboxMinutes(text) {
  if (typeof text !== 'string') return null;
  const m = text.slice(0, 8192).match(/\b(?:time[- ]?box(?:ed)?(?:\s+(?:of|to))?|within|in at most|at most|no more than)\s*:?\s*([0-9]{1,4})\s*(minutes?|mins?|hours?|hrs?|h)\b/i);
  if (!m) return null;
  const n = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1);
  return n >= 1 && n <= 10080 ? n : null;
}

/** Earlier rejections from native terms: reviewer payouts already in `paid`. */
export function priorRejections(task) {
  const paid = big(task?.paid), reviewer = big(task?.reviewer_amount), solver = big(task?.solver_amount);
  if (paid === null || reviewer === null || reviewer === 0n) return 0;
  const rejectedUnits = task.state === 'accepted' ? paid - (solver ?? 0n) - reviewer : paid;
  return rejectedUnits > 0n ? Number(rejectedUnits / reviewer) : 0;
}

/**
 * Estimate one task. `task` is a native central task record (or its public page
 * projection); `requirements` is what `taskRequirements.forTask(task)` returns.
 * Never throws: missing inputs are named in `reasons` and scored conservatively.
 */
export function estimateTaskDifficulty(task, { requirements = null } = {}) {
  const t = plain(task) ? task : {};
  const reasons = [];
  let score = 0, low = 0, high = 0;
  const add = (factor, points, note) => { score += points; reasons.push({ factor, points, note }); };

  // Kind and the base effort range.
  const test = surveyTest(requirements);
  const policyClass = test ? requirements.policy?.class : null;
  const part = typeof t.id === 'string' && SURVEY_PART_TASK_ID.test(t.id);
  const survey = part || policyClass === 'prior_art_survey' || (typeof t.id === 'string' && SURVEY_TASK_ID.test(t.id));
  const kind = part ? 'prior_art_survey_part' : survey ? 'prior_art_survey' : 'evidence';
  if (part) { low = 5; high = 10; add('kind', 0, 'Survey part: check a few listed records against the Main KPI, a single small unit.'); }
  else if (survey) { low = 30; high = 60; add('kind', 0, 'Prior-art survey: one bounded search-and-report pass over existing work, no new research.'); }
  else { low = 90; high = 240; add('kind', 2, 'Evidence task: produces a new result that a reviewer must judge.'); }

  // Verification: a deterministic verifier makes acceptance, and so payment, predictable.
  let verification;
  if (test && plain(requirements.policy?.driver) && typeof requirements.policy.driver.sha256 === 'string') {
    verification = 'fixed_verifier';
    add('verification', 0, `Checked by the fixed ${requirements.policy.driver.name ?? 'pinned'} verifier, then reviewed once: quick, predictable payment.`);
  } else if (survey) {
    verification = 'fixed_verifier_declared';
    add('verification', 0, 'The survey criteria name the fixed prior-art-survey verifier; its policy is not published here, so the identifier count is unknown.');
    high += 30;
  } else {
    verification = 'reviewer_judgement';
    add('verification', 1, 'No published fixed verifier: the central reviewer judges the evidence alone, so acceptance is less predictable.');
  }

  // Eligibility class.
  const eligibility = ['new', 'hard', 'unresolved'].includes(t.eligibility) ? t.eligibility : null;
  if (eligibility === 'hard') add('eligibility', 2, 'Eligibility "hard": the task is declared hard.');
  else if (eligibility === 'unresolved') add('eligibility', 2, 'Eligibility "unresolved": an open problem without a known route.');
  else if (eligibility === 'new') add('eligibility', 0, 'Eligibility "new": a bounded new result.');
  else add('eligibility', 1, 'Eligibility class missing or unknown.');

  // Work the verifier requires (surveys) or the acceptance criteria (evidence tasks).
  let workItems = null, criteria = null;
  if (test) {
    const included = Number.isSafeInteger(test.minIncluded) ? test.minIncluded : 0;
    const required = Array.isArray(test.requiredIds) ? test.requiredIds.length : 0;
    workItems = Math.max(included, required);
    low += workItems * 2; high += workItems * 4;
    const points = workItems > 24 ? 2 : workItems > 12 ? 1 : 0;
    add('work_items', points, `${workItems} records to find, resolve and classify (${required} required identifiers, at least ${included} included).`);
  }
  if (!survey) {
    criteria = countCriteria(t.criteria);
    low += criteria * 10; high += criteria * 20;
    const points = criteria >= 7 ? 2 : criteria >= 4 ? 1 : 0;
    add('criteria', points, `${criteria} acceptance criteria.`);
  }

  // Reward: the manager's effort price.
  const solver = big(t.solver_amount);
  if (solver === null) add('reward', 1, 'Reward unknown.');
  else {
    const points = solver > 2000n * UNITS_PER_AI ? 2 : solver > 250n * UNITS_PER_AI ? 1 : 0;
    add('reward', points, `${ai(solver)} AI$ solver reward${points === 0 ? ' (starter-sized, at most 250 AI$)' : points === 1 ? ' (over 250 AI$)' : ' (over 2,000 AI$)'}.`);
  }

  // Earlier rejections: each one is evidence the task is harder than it looks.
  const rejections = priorRejections(t);
  if (rejections > 0) {
    add('prior_rejections', Math.min(2, rejections), `${rejections} earlier submission${rejections === 1 ? ' was' : 's were'} rejected.`);
    const factor = 1 + 0.5 * Math.min(rejections, 4);
    low *= factor; high *= factor;
  }

  // An explicit timebox bounds the effort.
  const timebox = timeboxMinutes(t.criteria);
  if (timebox !== null) {
    high = Math.min(high, timebox); low = Math.min(low, high);
    if (timebox <= 60) add('timebox', -1, `The criteria set a timebox of ${timebox} minutes.`);
    else add('timebox', 0, `The criteria set a timebox of ${timebox} minutes.`);
  }

  score = Math.max(0, score);
  const deterministic = verification !== 'reviewer_judgement';
  let level = score >= ADVANCED_MIN_SCORE ? 'advanced' : score > STARTER_MAX_SCORE ? 'standard' : 'starter';
  if (level === 'starter' && !deterministic) {
    level = 'standard';
    reasons.push({ factor: 'starter_gate', points: 0, note: 'Starter needs a deterministic verifier so payment is quick and predictable; this task has none.' });
  }
  const min = round5(low), max = Math.max(min, round5(high));
  if (level === 'starter' && max > STARTER_MAX_MINUTES) {
    level = 'standard';
    reasons.push({ factor: 'starter_time_gate', points: 0, note: `Starter work fits in ${STARTER_MAX_MINUTES} minutes; this task may take up to ${max}.` });
  }
  return {
    schema: DIFFICULTY_SCHEMA,
    level,
    score,
    minutes: { min, max },
    reasons,
    inputs: { kind, verification, eligibility, criteria, workItems, solverUnits: solver === null ? null : String(solver), priorRejections: rejections, timeboxMinutes: timebox },
  };
}

/** Whether a level filter value is valid (undefined means no filter). */
export const validLevel = (level) => level === undefined || DIFFICULTY_LEVELS.includes(level);
