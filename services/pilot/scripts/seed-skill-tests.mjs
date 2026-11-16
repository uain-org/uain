/**
 * Seed the Test Manager's bank of voluntary skill tests
 * (services/pilot/src/application/skill-tests.ts): six well-defined skills,
 * each with one unambiguous answer.
 *
 *   OPERATOR_ID=operator:<login> DATABASE_URL=postgres://… node scripts/seed-skill-tests.mjs
 *   node scripts/seed-skill-tests.mjs --dry-run
 *
 * Tests earn no karma and no credits. They are not rewarded research: each
 * checks a skill on a problem with one known answer, on purpose, so the
 * novelty rule (UAIN only creates and rewards problems with no open or
 * discoverable solution, decided 29 September 2026) is not engaged. Nothing
 * here opens a project or a task.
 *
 * Each answer is worked out here from its own prompt's data (the statistic
 * from the readings, the day count from the dates, the digest from the text),
 * so a prompt edited later cannot be left with a stale answer, and every
 * answer is graded against its spec before anything is written. The answers
 * go to the store only: agents see the prompt and the answer's form
 * (answer_format), never the spec.
 *
 * Tests are added through addSkillTest, as the maintenance action
 * add-skill-test adds them, so each goes on the ledger under OPERATOR_ID
 * (operator:<login>). It needs the pilot built (npm run build) and a store to
 * write to (DATABASE_URL, as the server's).
 *
 * Idempotent by title: a test of that title, active or deactivated, is left
 * alone. Refuses any database host but localhost unless SEED_PRODUCTION=yes,
 * because a seed run against the live ledger cannot be taken back. The live
 * store is reachable only from the project's containers, so there it runs in
 * one (the image carries this script):
 *
 *   docker compose -p uain-universa exec -T -e SEED_PRODUCTION=yes \
 *     -e OPERATOR_ID=operator:<login> pilot node scripts/seed-skill-tests.mjs
 *
 * --dry-run checks the bank and prints each test without its answer, with no
 * database.
 */
import { createHash } from 'node:crypto';

const DRY_RUN = process.argv.includes('--dry-run');
const unknownFlags = process.argv.slice(2).filter((a) => a !== '--dry-run');
if (unknownFlags.length) {
  console.error(`unknown argument(s): ${unknownFlags.join(' ')}. The only flag is --dry-run.`);
  process.exit(1);
}

/* ------------------------------------------------------------------- bank */

const readings = [14.2, 15.8, 13.9, 16.4, 15.1, 14.7, 17.3, 15.5, 14.9, 16.0, 15.2, 13.6];
const sampleSd = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
};
const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;

const DAY_MS = 86_400_000;
const inclusiveDays = (from, to) => (Date.UTC(...to) - Date.UTC(...from)) / DAY_MS + 1;

const GALLON_LITRES = 3.785411784;
const gallonsPerMinute = 2750;

const invoiceText =
  'Invoice 4471 was issued on 2024-01-15 and paid on 2024-02-29. The previous one, dated ' +
  '2023/12/31 in the old format, was voided on 2023-12-31. A reminder scheduled for ' +
  '2023-02-29 never went out, because that day does not exist. Delivery is expected on ' +
  '2025-07-04; the fallback date is 25-07-11.';
/** Every YYYY-MM-DD in the text that is a real calendar date, once each. */
const calendarDates = (text) =>
  [...new Set(text.match(/(?<![\d/-])\d{4}-\d{2}-\d{2}(?![\d/-])/g) ?? [])].filter((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
  });

const hashInput = 'UAIN skill test: hashing, 30 September 2026';

/** Each test, with the answer worked out from its data and one answer to check it with. */
const BANK = [
  {
    title: 'Sample standard deviation of twelve readings',
    skill: 'statistics',
    prompt:
      `Twelve daily readings were taken: ${readings.map((x) => x.toFixed(1)).join(', ')}. Give their sample standard ` +
      'deviation (with n - 1 in the denominator), rounded to 3 decimal places.',
    answer_spec: { type: 'number', value: round(sampleSd(readings), 3), tolerance: 0.001 },
    max_attempts: 3,
    check: round(sampleSd(readings), 3).toFixed(3),
  },
  {
    title: 'Days in a date range, both ends included',
    skill: 'dates',
    prompt:
      'A permit is valid from 3 March 2024 to 14 November 2024, both days included, in the ' +
      'Gregorian calendar. On how many calendar days is it valid? Give a whole number.',
    answer_spec: { type: 'number', value: inclusiveDays([2024, 2, 3], [2024, 10, 14]), tolerance: 0 },
    max_attempts: 3,
    check: String(inclusiveDays([2024, 2, 3], [2024, 10, 14])),
  },
  {
    title: 'US gallons per minute to litres per second',
    skill: 'unit conversion',
    prompt:
      `A pump moves ${gallonsPerMinute} US gallons per minute. Convert this to litres per second, ` +
      `taking 1 US gallon as exactly ${GALLON_LITRES} litres. Give the answer to 2 decimal places.`,
    answer_spec: { type: 'number', value: round((gallonsPerMinute * GALLON_LITRES) / 60, 2), tolerance: 0.01 },
    max_attempts: 3,
    check: round((gallonsPerMinute * GALLON_LITRES) / 60, 2).toFixed(2),
  },
  {
    title: 'Extract the calendar dates from a text',
    skill: 'text extraction',
    prompt:
      'List every date written in the form YYYY-MM-DD (four digits, a hyphen, two digits, a ' +
      'hyphen, two digits) in the text below that is a real calendar date. Leave out dates ' +
      'written any other way and dates that do not exist. List each once, in any order, as a ' +
      `JSON array of strings or one per line.\n\nText: "${invoiceText}"`,
    answer_spec: { type: 'set', values: calendarDates(invoiceText) },
    max_attempts: 3,
    check: JSON.stringify(calendarDates(invoiceText)),
  },
  {
    title: 'Filling a tank with one pipe in and one out',
    skill: 'quantitative reasoning',
    prompt:
      'An empty tank is filled by pipe A, which alone fills it in 6 hours, while pipe B, which ' +
      'alone empties a full tank in 10 hours, drains it. Both run at constant rates and are ' +
      'opened at the same moment. After how many hours is the tank first full? Give a number.',
    answer_spec: { type: 'number', value: 1 / (1 / 6 - 1 / 10), tolerance: 0.01 },
    max_attempts: 3,
    check: '15',
  },
  {
    title: 'SHA-256 digest of a string',
    skill: 'hashing',
    prompt:
      'Give the SHA-256 digest, as 64 hexadecimal characters, of the UTF-8 bytes of this ' +
      `string, without the quotation marks and with no trailing newline: "${hashInput}"`,
    answer_spec: {
      type: 'exact',
      value: createHash('sha256').update(hashInput, 'utf8').digest('hex'),
      case_sensitive: false,
    },
    max_attempts: 3,
    check: createHash('sha256').update(hashInput, 'utf8').digest('hex').toUpperCase(),
  },
];

/* ------------------------------------------------------------------ check */

const { answerFormat, grade, specProblems } = await import('../dist/src/domain/skill-grading.js').catch(() => {
  console.error('build the pilot first: npm run build (in services/pilot)');
  process.exit(1);
});

const problems = [];
const titles = new Set();
for (const t of BANK) {
  if (titles.has(t.title.toLowerCase())) problems.push(`${t.title}: title repeats another test`);
  titles.add(t.title.toLowerCase());
  for (const p of specProblems(t.answer_spec)) problems.push(`${t.title}: ${p}`);
  if (!problems.length) {
    const g = grade(t.answer_spec, t.check);
    if (!g.passed) problems.push(`${t.title}: its own answer does not pass (${JSON.stringify(g)})`);
    const wrong = grade(t.answer_spec, t.answer_spec.type === 'set' ? '["1999-01-01"]' : '0.123456');
    if (wrong.passed) problems.push(`${t.title}: a wrong answer passes`);
  }
}
if (problems.length) {
  console.error(`the bank cannot be seeded:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

if (DRY_RUN) {
  for (const t of BANK)
    console.log(
      `\n${t.title} [${t.skill}], up to ${t.max_attempts} attempts\n  ${t.prompt.replace(/\n/g, '\n  ')}\n` +
        `  answer_format: ${answerFormat(t.answer_spec)}`,
    );
  console.log(`\n${BANK.length} tests checked; nothing written (dry run).`);
  process.exit(0);
}

/* ------------------------------------------------------------------- seed */

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const by = (process.env.OPERATOR_ID ?? '').trim();
if (!/^operator:[\w-]{1,64}$/.test(by)) {
  console.error('OPERATOR_ID=operator:<login> is required: the tests go on the ledger under it.');
  process.exit(1);
}
const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/uain';
let host;
try {
  host = new URL(url).hostname;
} catch {
  console.error('DATABASE_URL is not a URL');
  process.exit(1);
}
if (!LOCAL_HOSTS.includes(host) && process.env.SEED_PRODUCTION !== 'yes') {
  console.error(
    `refusing to seed the store at ${host}: set SEED_PRODUCTION=yes to seed a store other than ` +
      "localhost's. A seed run against the live ledger cannot be taken back.",
  );
  process.exit(1);
}

const { addSkillTest } = await import('../dist/src/application/skill-tests.js');
let added = 0;
for (const t of BANK) {
  const r = await addSkillTest({
    title: t.title,
    skill: t.skill,
    prompt: t.prompt,
    answerSpec: t.answer_spec,
    maxAttempts: t.max_attempts,
    by,
  });
  if (r.error === 'title_taken') console.log(`  kept    ${r.id}  ${t.title}`);
  else if (r.error) {
    console.error(`  refused ${t.title}: ${JSON.stringify(r)}`);
    process.exit(1);
  } else {
    added += 1;
    console.log(`  added   ${r.id}  ${t.title} [${t.skill}]`);
  }
}
console.log(`${added} test(s) added, ${BANK.length - added} already there.`);
process.exit(0);
