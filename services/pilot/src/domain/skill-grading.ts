/**
 * Grading a skill test's answer (application/skill-tests.ts): pure, with no
 * database, so the seed script can check its bank without one. An answer
 * spec is stored as JSON in skill_tests.answer_spec and never served.
 */

/**
 * What a correct answer is. Stored as JSON in skill_tests.answer_spec and
 * never served:
 * - number: within `tolerance` of `value`;
 * - exact: the text, after trimming, optionally ignoring case;
 * - regex: the whole trimmed answer matches `pattern`;
 * - set: a list; scored by overlap (items in both over items in either),
 *   passed only by the exact set.
 */
export type AnswerSpec =
  | { type: 'number'; value: number; tolerance: number }
  | { type: 'exact'; value: string; case_sensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'set'; values: string[]; case_sensitive?: boolean };

const SPEC_FIELDS: Record<string, string[]> = {
  number: ['type', 'value', 'tolerance'],
  exact: ['type', 'value', 'case_sensitive'],
  regex: ['type', 'pattern', 'flags'],
  set: ['type', 'values', 'case_sensitive'],
};

/** Every reason a spec cannot grade, so all of them are fixed at once. */
export function specProblems(spec: unknown): string[] {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['answer_spec must be an object'];
  const s = spec as Record<string, unknown>;
  const fields = SPEC_FIELDS[String(s.type)];
  if (!fields) return ['answer_spec.type must be number, exact, regex or set'];
  const out: string[] = [];
  const extra = Object.keys(s).filter((k) => !fields.includes(k));
  if (extra.length) out.push(`answer_spec has fields outside its type: ${extra.join(', ')}`);
  if ('case_sensitive' in s && typeof s.case_sensitive !== 'boolean')
    out.push('answer_spec.case_sensitive must be true or false');
  if (s.type === 'number') {
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) out.push('answer_spec.value must be a finite number');
    if (typeof s.tolerance !== 'number' || !Number.isFinite(s.tolerance) || s.tolerance < 0)
      out.push('answer_spec.tolerance must be a number, zero or more');
  } else if (s.type === 'exact') {
    if (typeof s.value !== 'string' || !s.value.trim()) out.push('answer_spec.value must be text');
  } else if (s.type === 'regex') {
    if (typeof s.pattern !== 'string' || !s.pattern) out.push('answer_spec.pattern must be text');
    else if (s.flags !== undefined && (typeof s.flags !== 'string' || !/^[imsu]*$/.test(s.flags)))
      out.push('answer_spec.flags may hold only i, m, s and u');
    else
      try {
        new RegExp(s.pattern, (s.flags as string | undefined) ?? '');
      } catch {
        out.push('answer_spec.pattern is not a valid regular expression');
      }
  } else if (s.type === 'set') {
    const values = s.values;
    if (!Array.isArray(values) || !values.length || !values.every((v) => typeof v === 'string' && v.trim()))
      out.push('answer_spec.values must be a non-empty list of text');
    else {
      const fold = (v: string) => (s.case_sensitive === false ? v.trim().toLowerCase() : v.trim());
      if (new Set(values.map(fold)).size !== values.length) out.push('answer_spec.values repeat');
    }
  }
  return out;
}

/**
 * What a test asks for, said without the answer: shown with every test so
 * an answer in the wrong form does not cost an attempt. The tolerance is
 * shown; a pattern or the expected values never are.
 */
export function answerFormat(spec: AnswerSpec): string {
  const ignoring = 'case_sensitive' in spec && spec.case_sensitive === false ? ', ignoring case' : '';
  switch (spec.type) {
    case 'number':
      return (
        'A number, digits only: for example 12.5 or -0.003, with no units and no thousands ' +
        'separators. ' +
        (spec.tolerance > 0
          ? `It passes within ${spec.tolerance} of the expected value.`
          : 'It must equal the expected value exactly.')
      );
    case 'exact':
      return `Text, compared exactly with the expected answer${ignoring}, after trimming spaces at either end.`;
    case 'regex':
      return 'Text, checked in full against a pattern the server keeps, after trimming spaces at either end.';
    case 'set':
      return (
        'A list: a JSON array of strings, or one item per line. It is scored by its overlap ' +
        `with the expected set (items in both, over items in either)${ignoring}; only the exact ` +
        'set passes.'
      );
  }
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** A list answer: a JSON array, or one item per line. */
function listOf(raw: string): string[] | null {
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t);
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' || typeof x === 'number')) return null;
      return v.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      return null;
    }
  }
  return t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Grade an answer: a score from 0 to 100, and whether it passes. An answer
 * in the wrong form (not a number, an unreadable list) is refused rather
 * than graded, and costs no attempt.
 */
export function grade(spec: AnswerSpec, raw: string): { score: number; passed: boolean } | { error: 'bad_answer' } {
  const answer = String(raw ?? '').trim();
  if (!answer) return { error: 'bad_answer' };
  switch (spec.type) {
    case 'number': {
      if (!NUMBER.test(answer)) return { error: 'bad_answer' };
      // A hair of slack for floating point, far below any tolerance a test states.
      const passed = Math.abs(Number(answer) - spec.value) <= spec.tolerance + 1e-9 * Math.max(1, Math.abs(spec.value));
      return { score: passed ? 100 : 0, passed };
    }
    case 'exact': {
      const fold = (v: string) => (spec.case_sensitive === false ? v.toLowerCase() : v);
      const passed = fold(answer) === fold(spec.value.trim());
      return { score: passed ? 100 : 0, passed };
    }
    case 'regex': {
      const passed = new RegExp(`^(?:${spec.pattern})$`, spec.flags ?? '').test(answer);
      return { score: passed ? 100 : 0, passed };
    }
    case 'set': {
      const items = listOf(answer);
      if (!items || !items.length) return { error: 'bad_answer' };
      const fold = (v: string) => (spec.case_sensitive === false ? v.trim().toLowerCase() : v.trim());
      const given = new Set(items.map(fold));
      const expected = new Set(spec.values.map(fold));
      const both = [...given].filter((v) => expected.has(v)).length;
      const either = new Set([...given, ...expected]).size;
      const score = Math.round((100 * both) / either);
      return { score, passed: score === 100 };
    }
  }
}
