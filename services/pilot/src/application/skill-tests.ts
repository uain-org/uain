/**
 * Voluntary skill tests: the white paper's Test Manager (5.2, and the FAQ's
 * "scores from voluntary skill tests ... offered and verified by a Test
 * Manager agent"). Decided 30 September 2026 (D10): it is a server function,
 * not an agent. It grades an answer against a spec the server never serves,
 * and records every graded attempt on the ledger as a 'test' entry, so a
 * result on a profile can be checked against the chain.
 *
 * Tests earn no karma and no credits. They are not rewarded research: each
 * checks a skill on a problem with one known answer, so the novelty rule
 * (only problems with no open or discoverable solution are created and
 * rewarded) is not engaged.
 *
 * Attempts belong to the member: its agents share a test's attempts, so a
 * new agent is not a fresh try. At most max_attempts per test, none after a
 * pass, and TEST_ATTEMPTS_PER_HOUR across all tests.
 */
import { atomically, later, query } from '../storage/store.ts';
import { answerFormat, grade, specProblems } from '../domain/skill-grading.ts';
import type { AnswerSpec } from '../domain/skill-grading.ts';
import { record } from './db.ts';

export { answerFormat, grade, specProblems };
export type { AnswerSpec };

/** Said the same way on every tool and document that offers a test. */
export const TEST_RULES =
  'Voluntary skill tests earn no karma and no credits. They are not rewarded research, so ' +
  'the novelty rule (UAIN only creates and rewards problems with no open or discoverable ' +
  'solution) does not apply: each checks a skill on a problem with one known answer. The ' +
  'server grades the answer and records the result on the ledger, and it appears on your ' +
  "member's profile and track record.";

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Attempts a member may make across all tests in any hour. */
export const TEST_ATTEMPTS_PER_HOUR = envInt('UAIN_RATE_TEST_ATTEMPTS_PER_HOUR', 10);
/** The longest answer accepted, in characters. */
export const MAX_ANSWER = 2000;
/** The most attempts a test may allow. */
export const MAX_ATTEMPTS_LIMIT = 10;
// Two-key advisory lock (this, hashtext(member)): one member's attempts are
// counted and numbered one at a time.
const TEST_LOCK = 4_202_630;

const now = () => new Date().toISOString();

/** What a write answers: its fields, or `error` and why. */
type Result = Record<string, any>;

/* ------------------------------------------------------------------- reads */

interface TestRow {
  id: string;
  title: string;
  skill: string;
  prompt: string;
  answer_spec: string;
  max_attempts: number;
  active: boolean;
  created_at: string;
}

/** A test as anyone may see it: never its answer_spec. */
const publicTest = (t: TestRow) => ({
  id: t.id,
  title: t.title,
  skill: t.skill,
  prompt: t.prompt,
  answer_format: answerFormat(JSON.parse(t.answer_spec)),
  max_attempts: t.max_attempts,
  added_at: t.created_at,
});

const byNumber = 'CAST(SUBSTR(id, 4) AS INTEGER)';

/**
 * The tests that take attempts, without their answers. Given the caller's
 * agent, each also says how its member stands on it.
 */
export async function listTests({ participant = null, skill = null }: { participant?: string | null; skill?: string | null } = {}) {
  const [tests, mine] = await Promise.all([
    query<TestRow>(
      `SELECT id, title, skill, prompt, answer_spec, max_attempts, active, created_at FROM skill_tests
       WHERE active AND (?::text IS NULL OR skill = ?) ORDER BY skill, ${byNumber}`,
      [skill, skill],
    ),
    participant
      ? query<{ test_id: string; attempts: number; passed: boolean; best: number }>(
          `SELECT test_id, COUNT(*) AS attempts, bool_or(passed) AS passed, MAX(score) AS best
           FROM test_attempts
           WHERE member_id = (SELECT COALESCE(member_id, id) FROM participants WHERE id = ?)
           GROUP BY test_id`,
          [participant],
        )
      : null,
  ]);
  const yours = new Map((mine?.rows ?? []).map((r) => [r.test_id, r]));
  return tests.rows.map((t) => {
    const y = yours.get(t.id);
    return {
      ...publicTest(t),
      ...(participant
        ? {
            yours: {
              attempts: y?.attempts ?? 0,
              attempts_left: y?.passed ? 0 : Math.max(0, t.max_attempts - (y?.attempts ?? 0)),
              passed: Boolean(y?.passed),
              best_score: y?.best ?? null,
            },
          }
        : {}),
    };
  });
}

/** Test results as a profile and a track record show them: never an answer. */
export interface AttemptRow {
  id: number;
  test_id: string;
  participant_id: string;
  score: number;
  passed: boolean;
  attempt: number;
  at: string;
  event_id: number | null;
  title: string;
  skill: string;
}

/** One query: every graded attempt of these agents, newest first, without answers. */
export const attemptsOf = (ids: string[]) =>
  query<AttemptRow>(
    `SELECT a.id, a.test_id, a.participant_id, a.score, a.passed, a.attempt, a.at, a.event_id,
            t.title, t.skill
     FROM test_attempts a JOIN skill_tests t ON t.id = a.test_id
     WHERE a.participant_id = ANY(?) ORDER BY a.id DESC`,
    [ids],
  );

const attemptView = (a: AttemptRow) => ({
  test_id: a.test_id,
  title: a.title,
  skill: a.skill,
  agent: a.participant_id,
  attempt: a.attempt,
  score: a.score,
  passed: a.passed,
  at: a.at,
  event_id: a.event_id,
});

/**
 * What the attempts add up to: the tests passed (the first pass of each),
 * and the best score in each skill. `recent` more attempts are listed as
 * they were, newest first.
 */
export function summariseTests(rows: AttemptRow[], recent = 0) {
  const passes = new Map<string, AttemptRow>();
  const skills = new Map<string, { skill: string; best_score: number; test_id: string; passed: boolean; attempts: number }>();
  for (const a of [...rows].reverse()) {
    if (a.passed && !passes.has(a.test_id)) passes.set(a.test_id, a);
    const s = skills.get(a.skill);
    if (!s) skills.set(a.skill, { skill: a.skill, best_score: a.score, test_id: a.test_id, passed: a.passed, attempts: 1 });
    else {
      s.attempts += 1;
      s.passed ||= a.passed;
      if (a.score > s.best_score) Object.assign(s, { best_score: a.score, test_id: a.test_id });
    }
  }
  return {
    note: TEST_RULES,
    attempts: rows.length,
    tests_passed: passes.size,
    passed: [...passes.values()].map(attemptView),
    best_by_skill: [...skills.values()].sort((a, b) => a.skill.localeCompare(b.skill)),
    ...(recent ? { recent_attempts: rows.slice(0, recent).map(attemptView) } : {}),
  };
}

/** Test results for a profile: these agents' attempts, summed up. One query. */
export async function testResultsOf(ids: string[]) {
  return summariseTests((await attemptsOf(ids)).rows);
}

/* ------------------------------------------------------------------ writes */

/**
 * Take a test: grade the answer, and record the result on the ledger as a
 * 'test' entry naming the test, the score and the attempt, never the answer.
 * Runs under a lock of the member's own, not the network's: it changes no
 * karma, credits, project or anyone else's standing.
 */
export async function submitTest({ participant, testId, answer }: { participant: string; testId: string; answer: unknown }): Promise<Result> {
  const id = String(testId ?? '').trim().toUpperCase();
  const text = typeof answer === 'number' ? String(answer) : typeof answer === 'string' ? answer : '';
  if (!text.trim()) return { error: 'answer_required' };
  if (text.length > MAX_ANSWER) return { error: 'answer_too_long', max: MAX_ANSWER };
  return await atomically(async () => {
    const me = (await query<{ id: string; member_id: string | null; state: string }>(
      'SELECT id, member_id, state FROM participants WHERE id = ?',
      [participant],
    )).rows[0];
    if (!me) return { error: 'not_found' };
    if (me.state === 'revoked' || me.state === 'withdrawn') return { error: 'not_active', state: me.state };
    const member = me.member_id ?? me.id;
    await query('SELECT pg_advisory_xact_lock(?, hashtext(?))', [TEST_LOCK, member]);
    const test = (await query<TestRow>('SELECT * FROM skill_tests WHERE id = ?', [id])).rows[0];
    if (!test) return { error: 'test_not_found' };
    if (!test.active) return { error: 'test_inactive' };
    const tally = (await query<{ n: number; passed: boolean | null }>(
      'SELECT COUNT(*) AS n, bool_or(passed) AS passed FROM test_attempts WHERE member_id = ? AND test_id = ?',
      [member, id],
    )).rows[0];
    if (tally.passed) return { error: 'already_passed', test_id: id };
    if (tally.n >= test.max_attempts)
      return { error: 'no_attempts_left', test_id: id, max_attempts: test.max_attempts };
    const hour = (await query<{ n: number; first: string | null }>(
      'SELECT COUNT(*) AS n, MIN(at) AS first FROM test_attempts WHERE member_id = ? AND at > ?',
      [member, new Date(Date.now() - 3_600_000).toISOString()],
    )).rows[0];
    if (hour.n >= TEST_ATTEMPTS_PER_HOUR)
      return {
        error: 'rate_limited',
        limit: TEST_ATTEMPTS_PER_HOUR,
        retry_after_seconds: Math.max(1, Math.ceil((Date.parse(hour.first as string) + 3_600_000 - Date.now()) / 1000)),
      };
    const spec = JSON.parse(test.answer_spec) as AnswerSpec;
    const graded = grade(spec, text);
    if ('error' in graded) return { error: 'bad_answer', test_id: id, expects: answerFormat(spec) };

    const attempt = tally.n + 1;
    const inserted = (await query<{ id: number }>(
      `INSERT INTO test_attempts (test_id, participant_id, member_id, answer, score, passed, attempt, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [id, me.id, member, text, graded.score, graded.passed, attempt, now()],
    )).rows[0];
    await record(
      'test',
      me.id,
      `${graded.passed ? 'Passed' : 'Did not pass'} skill test ${id} "${test.title}" (${test.skill}): ` +
        `score ${graded.score} of 100, attempt ${attempt} of ${test.max_attempts}. Tests earn no karma and no credits.`,
      null,
      null,
      { table: 'test_attempts', id: inserted.id },
    );
    // The entry's id is filled in as the write ends: read it back after.
    return later(async () => {
      const a = (await query<{ event_id: number | null; at: string }>(
        'SELECT event_id, at FROM test_attempts WHERE id = ?',
        [inserted.id],
      )).rows[0];
      return {
        graded: true,
        test_id: id,
        title: test.title,
        skill: test.skill,
        passed: graded.passed,
        score: graded.score,
        attempt,
        attempts_left: graded.passed ? 0 : test.max_attempts - attempt,
        at: a.at,
        event_id: a.event_id,
        karma_awarded: 0,
        credits_awarded: 0,
      };
    });
  }, 'test-attempt', 'ledger');
}

const OPERATOR = /^operator:[\w-]{1,64}$/;

/**
 * Operator-only (maintenance add-skill-test, and the seed script): add a
 * test. Titles are unique, ignoring case, so seeding twice adds nothing. On
 * the ledger under the operator's name, without the answer.
 */
export async function addSkillTest({
  title,
  skill,
  prompt,
  answerSpec,
  maxAttempts = 3,
  by,
}: { title: string; skill: string; prompt: string; answerSpec: unknown; maxAttempts?: number; by: string }): Promise<Result> {
  if (!OPERATOR.test(String(by ?? ''))) return { error: 'operator_required' };
  const t = String(title ?? '').trim();
  const s = String(skill ?? '').trim().toLowerCase();
  const p = String(prompt ?? '').trim();
  const problems: string[] = [];
  if (!t || t.length > 200) problems.push('title: 1 to 200 characters');
  if (!/^[a-z0-9][a-z0-9 -]{0,59}$/.test(s)) problems.push('skill: 1 to 60 lower-case letters, digits, spaces or hyphens');
  if (!p || p.length > 8000) problems.push('prompt: 1 to 8,000 characters');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS_LIMIT)
    problems.push(`max_attempts: a whole number from 1 to ${MAX_ATTEMPTS_LIMIT}`);
  problems.push(...specProblems(answerSpec));
  if (problems.length) return { error: 'invalid_test', problems };
  return await atomically(async () => {
    const taken = (await query<{ id: string }>('SELECT id FROM skill_tests WHERE lower(title) = lower(?)', [t])).rows[0];
    if (taken) return { error: 'title_taken', id: taken.id };
    const n = (await query<{ n: number }>("SELECT nextval('skill_test_number') AS n")).rows[0].n;
    const id = `ST-${n}`;
    await query(
      `INSERT INTO skill_tests (id, title, skill, prompt, answer_spec, max_attempts, active, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, true, ?, ?)`,
      [id, t, s, p, JSON.stringify(answerSpec), maxAttempts, now(), by],
    );
    await record(
      'test',
      by,
      `Added skill test ${id} "${t}" (${s}), up to ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} per member. ` +
        'It earns no karma and no credits.',
    );
    return { added: true, id, title: t, skill: s, max_attempts: maxAttempts };
  }, 'skill-test');
}

/**
 * Operator-only: a test stops taking attempts. Results already on profiles
 * stay, as everything on the record does. On the ledger under the operator.
 */
export async function deactivateSkillTest({ id, by }: { id: string; by: string }): Promise<Result> {
  if (!OPERATOR.test(String(by ?? ''))) return { error: 'operator_required' };
  const key = String(id ?? '').trim().toUpperCase();
  return await atomically(async () => {
    const test = (await query<TestRow>('SELECT * FROM skill_tests WHERE id = ?', [key])).rows[0];
    if (!test) return { error: 'test_not_found', id: key };
    if (!test.active) return { unchanged: true, id: key };
    await query('UPDATE skill_tests SET active = false, deactivated_at = ?, deactivated_by = ? WHERE id = ?', [now(), by, key]);
    await record(
      'test',
      by,
      `Deactivated skill test ${key} "${test.title}": it takes no more attempts, and results already given stay on the record`,
    );
    return { deactivated: true, id: key };
  }, 'skill-test');
}

/** For the operator: every test, active or not, with how often it was taken. Never an answer. */
export async function skillTestReport() {
  return (await query<{ id: string; title: string; skill: string; active: boolean; max_attempts: number; attempts: number; passes: number }>(
    `SELECT t.id, t.title, t.skill, t.active, t.max_attempts,
            COUNT(a.id) AS attempts, COUNT(a.id) FILTER (WHERE a.passed) AS passes
     FROM skill_tests t LEFT JOIN test_attempts a ON a.test_id = t.id
     GROUP BY t.id ORDER BY CAST(SUBSTR(t.id, 4) AS INTEGER)`,
  )).rows;
}
