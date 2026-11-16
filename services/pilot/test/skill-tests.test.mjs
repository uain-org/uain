/**
 * Voluntary skill tests: the Test Manager (white paper 5.2; D10, decided 30
 * September 2026: a server function, not an agent).
 *
 * The server grades an answer against a spec it never serves, records every
 * graded attempt on the ledger as a 'test' entry, caps attempts per member
 * and per hour, and pays nothing: tests earn no karma and no credits. The
 * bank is added by the operator (maintenance) and by an idempotent seed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let tests;
let grading;
let chain;
before(async () => {
  t = await boot({ UAIN_RATE_TEST_ATTEMPTS_PER_HOUR: '8' });
  tests = await import('../dist/src/application/skill-tests.js');
  grading = await import('../dist/src/domain/skill-grading.js');
  chain = await import('../dist/src/ledger/chain.js');
});
after(async () => {
  await t.close();
});

// Answers no response may ever carry.
const SECRET_NUMBER = 424242.5;
const SECRET_TEXT = 'zebra-quartz-17';
const SECRET_SET = ['alpha-omega-1', 'beta-omega-2', 'gamma-omega-3'];
const SECRET_PATTERN = 'kiwi-[0-9]{3}';
const SECRETS = ['424242.5', SECRET_TEXT, ...SECRET_SET, 'kiwi-', 'answer_spec'];

const by = 'operator:tester';
const add = async (spec, extra = {}) => {
  const r = await tests.addSkillTest({
    title: `Test ${Math.random().toString(36).slice(2, 10)}`,
    skill: 'testing',
    prompt: 'Answer the question.',
    answerSpec: spec,
    maxAttempts: 3,
    by,
    ...extra,
  });
  assert.equal(r.added, true, JSON.stringify(r));
  return r.id;
};

/** A body must not carry any answer. */
function sealed(body, where) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where} carries "${s}"`);
}

const submit = (who, test_id, answer) => who.call('uain_test_submit', { test_id, answer });
const standing = async (id) =>
  await t.db
    .prepare(
      `SELECT p.karma, p.credits,
              (SELECT COUNT(*) FROM karma_events WHERE participant_id = p.id) AS karma_rows,
              (SELECT COUNT(*) FROM credit_ledger WHERE participant = p.id) AS credit_rows
       FROM participants p WHERE p.id = ?`,
    )
    .get(id);

const MAINTENANCE = fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url));
const SEED = fileURLToPath(new URL('../scripts/seed-skill-tests.mjs', import.meta.url));
function run(file, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

describe('grading', () => {
  test('a number passes within its tolerance; one in another form is not graded', () => {
    const spec = { type: 'number', value: 173.5, tolerance: 0.01 };
    assert.deepEqual(grading.grade(spec, '173.5'), { score: 100, passed: true });
    assert.deepEqual(grading.grade(spec, ' 173.49 '), { score: 100, passed: true });
    assert.deepEqual(grading.grade(spec, '1.735e2'), { score: 100, passed: true });
    assert.deepEqual(grading.grade(spec, '173.52'), { score: 0, passed: false });
    for (const bad of ['173.5 L/s', '1,735', 'about 173', 'NaN', ''])
      assert.deepEqual(grading.grade(spec, bad), { error: 'bad_answer' }, bad);
    const exact = { type: 'number', value: 257, tolerance: 0 };
    assert.equal(grading.grade(exact, '257').passed, true);
    assert.equal(grading.grade(exact, '256').passed, false);
  });

  test('exact text, a pattern, and a set scored by overlap', () => {
    const hex = { type: 'exact', value: 'abc123', case_sensitive: false };
    assert.equal(grading.grade(hex, ' ABC123 ').passed, true);
    assert.equal(grading.grade({ type: 'exact', value: 'abc123' }, 'ABC123').passed, false);
    const pattern = { type: 'regex', pattern: '2024-03-03\\s*/\\s*2024-11-14' };
    assert.equal(grading.grade(pattern, '2024-03-03/2024-11-14').passed, true);
    assert.equal(grading.grade(pattern, 'from 2024-03-03/2024-11-14').passed, false, 'the whole answer must match');
    const set = { type: 'set', values: ['a', 'b', 'c'] };
    assert.deepEqual(grading.grade(set, '["c","a","b"]'), { score: 100, passed: true });
    assert.deepEqual(grading.grade(set, 'a\nb\nc\na'), { score: 100, passed: true });
    assert.deepEqual(grading.grade(set, '["a","b"]'), { score: 67, passed: false });
    assert.deepEqual(grading.grade(set, '["a","b","c","d"]'), { score: 75, passed: false });
    assert.deepEqual(grading.grade(set, '[1, {"x": 2}]'), { error: 'bad_answer' });
  });

  test('a spec that cannot grade is refused, every reason at once', () => {
    assert.deepEqual(grading.specProblems({ type: 'number', value: 1, tolerance: 0 }), []);
    assert.ok(grading.specProblems({ type: 'number', value: 'one', tolerance: -1 }).length === 2);
    assert.ok(grading.specProblems({ type: 'regex', pattern: '(' }).length === 1);
    assert.ok(grading.specProblems({ type: 'set', values: ['a', 'a'] }).length === 1);
    assert.ok(grading.specProblems({ type: 'exact', value: 'x', extra: 1 }).length === 1);
    assert.ok(grading.specProblems({ type: 'guess' }).length === 1);
    assert.ok(grading.specProblems(null).length === 1);
  });

  test('what a test asks for never gives its answer away', () => {
    for (const spec of [
      { type: 'number', value: SECRET_NUMBER, tolerance: 0.5 },
      { type: 'exact', value: SECRET_TEXT },
      { type: 'regex', pattern: SECRET_PATTERN },
      { type: 'set', values: SECRET_SET },
    ])
      sealed(grading.answerFormat(spec), spec.type);
    assert.match(grading.answerFormat({ type: 'number', value: 1, tolerance: 0.5 }), /within 0\.5/);
  });
});

describe('taking a test', () => {
  let ids;
  let a;
  let sibling;
  let b;
  before(async () => {
    ids = {
      number: await add({ type: 'number', value: SECRET_NUMBER, tolerance: 0.5 }, { title: 'A secret number', skill: 'arithmetic' }),
      text: await add({ type: 'exact', value: SECRET_TEXT }, { title: 'A secret word', skill: 'recall', maxAttempts: 2 }),
      pattern: await add({ type: 'regex', pattern: SECRET_PATTERN }, { title: 'A secret pattern', skill: 'recall' }),
      set: await add({ type: 'set', values: SECRET_SET }, { title: 'A secret set', skill: 'extraction' }),
    };
    a = await t.member('ST-Alpha');
    sibling = await t.instance(a.key, 'ST-Alpha', 'ST-Alpha-second');
    b = await t.member('ST-Beta');
  });

  test('the tests are listed without their answers, with how your member stands', async () => {
    const anon = await (await t.connect()).call('uain_tests', {});
    assert.ok(anon.count >= 4);
    assert.equal(anon.karma, 0);
    assert.equal(anon.credits, 0);
    assert.match(anon.rules, /no karma and no credits/);
    assert.match(anon.rules, /novelty rule/);
    const listed = anon.tests.find((x) => x.id === ids.number);
    assert.equal(listed.title, 'A secret number');
    assert.ok(listed.answer_format);
    assert.equal(listed.yours, undefined);
    sealed(anon, 'uain_tests');
    const mine = await a.call('uain_tests', { skill: 'recall' });
    assert.deepEqual(mine.tests.map((x) => x.id).sort(), [ids.text, ids.pattern].sort());
    assert.deepEqual(mine.tests.find((x) => x.id === ids.text).yours, {
      attempts: 0, attempts_left: 2, passed: false, best_score: null,
    });
    sealed(mine, 'uain_tests signed in');
    const { tools } = await a.client.listTools();
    for (const name of ['uain_tests', 'uain_test_submit'])
      assert.match(tools.find((x) => x.name === name).description, /no karma and no credits/);
  });

  test('a correct answer passes, goes on the ledger without the answer, and pays nothing', async () => {
    const before_ = await standing(a.id);
    const r = await submit(a, ids.text, ` ${SECRET_TEXT} `);
    assert.equal(r.graded, true, JSON.stringify(r));
    assert.equal(r.passed, true);
    assert.equal(r.score, 100);
    assert.equal(r.attempt, 1);
    assert.equal(r.karma_awarded, 0);
    assert.equal(r.credits_awarded, 0);
    assert.ok(r.event_id);
    const e = await t.db.getEvent(r.event_id);
    assert.equal(e.kind, 'test');
    assert.equal(e.actor, a.id);
    assert.match(e.summary, new RegExp(`^Passed skill test ${ids.text} "A secret word" \\(recall\\): score 100 of 100, attempt 1 of 2`));
    sealed(e, 'the ledger entry');
    const row = await t.db.prepare('SELECT * FROM test_attempts WHERE event_id = ?').get(r.event_id);
    assert.equal(row.participant_id, a.id);
    assert.equal(row.passed, true);
    assert.deepEqual(await standing(a.id), before_, 'no karma, no credits, no rows of either');
    const again = await submit(sibling, ids.text, SECRET_TEXT);
    assert.equal(again.error, 'already_passed', 'the member has passed it, whichever agent asks');
  });

  test('a wrong answer is not corrected, and attempts are capped per member', async () => {
    const one = await submit(b, ids.text, 'wrong-1');
    assert.equal(one.passed, false);
    assert.equal(one.score, 0);
    assert.equal(one.attempts_left, 1);
    sealed(one, 'a failed attempt');
    const e = await t.db.getEvent(one.event_id);
    assert.match(e.summary, /^Did not pass skill test/);
    assert.ok(!e.summary.includes('wrong-1'), 'the answer given is not on the ledger either');
    const two = await submit(b, ids.text, 'wrong-2');
    assert.equal(two.attempts_left, 0);
    const three = await submit(b, ids.text, SECRET_TEXT);
    assert.equal(three.graded, false);
    assert.equal(three.error, 'no_attempts_left');
    assert.equal(three.max_attempts, 2);
    assert.match(three.message, /share/);
    // Another agent of the member is not a fresh try.
    const b2 = await t.instance(b.key, 'ST-Beta', 'ST-Beta-second');
    assert.equal((await submit(b2, ids.text, SECRET_TEXT)).error, 'no_attempts_left');
  });

  test('an answer in the wrong form costs no attempt', async () => {
    const r = await submit(a, ids.number, 'four hundred thousand');
    assert.equal(r.error, 'bad_answer');
    assert.match(r.expects, /A number/);
    sealed(r, 'bad_answer');
    const listed = (await a.call('uain_tests', {})).tests.find((x) => x.id === ids.number);
    assert.equal(listed.yours.attempts, 0);
    const ok = await submit(a, ids.number, '424242.9');
    assert.equal(ok.passed, true, 'within the tolerance');
  });

  test('a set is scored by overlap, a pattern must match whole', async () => {
    const partial = await submit(a, ids.set, JSON.stringify(SECRET_SET.slice(0, 2)));
    assert.equal(partial.passed, false);
    assert.equal(partial.score, 67);
    const full = await submit(sibling, ids.set, SECRET_SET.join('\n'));
    assert.equal(full.passed, true);
    assert.equal(full.attempt, 2, "the sibling's attempt is the member's second");
    assert.equal((await submit(a, ids.pattern, 'kiwi-12')).passed, false);
    assert.equal((await submit(a, ids.pattern, 'kiwi-123')).passed, true);
  });

  test('attempts are rate-limited per member across tests', async () => {
    const c = await t.member('ST-Gamma');
    const many = [];
    for (let i = 0; i < 4; i++) many.push(await add({ type: 'number', value: 1, tolerance: 0 }, { maxAttempts: 10 }));
    let n = 0;
    for (const id of many)
      for (let i = 0; i < 2; i++) {
        const r = await submit(c, id, '2');
        assert.equal(r.graded, true, JSON.stringify(r));
        n += 1;
      }
    assert.equal(n, 8);
    const limited = await submit(c, many[0], '1');
    assert.equal(limited.error, 'rate_limited');
    assert.equal(limited.limit, 8);
    assert.ok(limited.retry_after_seconds > 0 && limited.retry_after_seconds <= 3600);
  });

  test('a deactivated test takes no attempts and is not listed', async () => {
    const id = await add({ type: 'number', value: 3, tolerance: 0 });
    const off = await tests.deactivateSkillTest({ id, by });
    assert.equal(off.deactivated, true);
    assert.equal((await tests.deactivateSkillTest({ id, by })).unchanged, true);
    assert.equal((await submit(b, id, '3')).error, 'test_inactive');
    assert.ok(!(await b.call('uain_tests', {})).tests.some((x) => x.id === id));
    assert.equal((await submit(b, 'ST-99999', '3')).error, 'test_not_found');
  });

  test('results show on the profile and the track record, never with an answer', async () => {
    const member = (await t.db.getParticipant(a.id)).member;
    const reads = {
      member: await (await t.http(`/api/members/${member.address}`)).json(),
      agent: await (await t.http(`/api/directory/${a.id}`)).json(),
      memberRecord: await (await t.http(`/api/members/${member.address}/track-record`)).json(),
      agentRecord: await (await t.http(`/api/directory/${sibling.id}/track-record`)).json(),
      participant: await b.call('uain_participant', { id: a.id }),
      events: await (await t.http('/api/events?limit=200')).json(),
    };
    for (const [where, body] of Object.entries(reads)) sealed(body, where);
    const results = reads.member.test_results;
    assert.equal(results.tests_passed, 4, 'text, number, set and pattern, by either agent');
    assert.deepEqual(
      results.best_by_skill.map((s) => [s.skill, s.best_score, s.passed]),
      [['arithmetic', 100, true], ['extraction', 100, true], ['recall', 100, true]],
    );
    assert.match(results.note, /no karma and no credits/);
    assert.equal(reads.agent.test_results.tests_passed, 3, "the agent's own: text, number, pattern");
    assert.equal(reads.participant.test_results.tests_passed, 3);
    assert.equal(reads.memberRecord.summary.tests.passed, 4);
    assert.ok(reads.memberRecord.test_results.recent_attempts.every((x) => x.event_id));
    assert.equal(reads.agentRecord.test_results.tests_passed, 1, "the sibling's own: the set");
  });

  test('the ledger stays one unbroken chain', async () => {
    const rows = await t.db.prepare('SELECT * FROM events ORDER BY id').all();
    const check = chain.verifyChain(rows);
    assert.equal(check.ok, true, JSON.stringify(check.errors));
  });
});

describe('the operator adds and retires tests', () => {
  const spec = { type: 'exact', value: 'operator-secret-answer' };
  const input = { title: 'Added by the operator', skill: 'maintenance', prompt: 'Say the word.', answer_spec: spec, max_attempts: 2 };

  test('add-skill-test goes on the ledger under the operator, without the answer', async () => {
    const r = await run(MAINTENANCE, { ACTION: 'add-skill-test', SKILL_TEST: JSON.stringify(input), OPERATOR_ID: 'operator:tester' });
    assert.equal(r.code, 0, r.err);
    const [, id] = r.out.match(/added (ST-\d+)/);
    const row = await t.db.prepare('SELECT * FROM skill_tests WHERE id = ?').get(id);
    assert.equal(row.title, 'Added by the operator');
    assert.equal(row.created_by, 'operator:tester');
    assert.equal(row.max_attempts, 2);
    const e = await t.db.prepare("SELECT * FROM events WHERE kind = 'test' AND summary LIKE ?").get(`Added skill test ${id} %`);
    assert.equal(e.actor, 'operator:tester');
    assert.ok(!e.summary.includes('operator-secret-answer'));
    assert.ok(!r.out.includes('operator-secret-answer'));

    const again = await run(MAINTENANCE, { ACTION: 'add-skill-test', SKILL_TEST: JSON.stringify(input), OPERATOR_ID: 'operator:tester' });
    assert.equal(again.code, 1);
    assert.match(again.err, /title_taken/);
    const nobody = await run(MAINTENANCE, { ACTION: 'add-skill-test', SKILL_TEST: JSON.stringify({ ...input, title: 'Other' }), OPERATOR_ID: '' });
    assert.equal(nobody.code, 1);
    assert.match(nobody.err, /OPERATOR_ID/);
    const bad = await run(MAINTENANCE, {
      ACTION: 'add-skill-test',
      SKILL_TEST: JSON.stringify({ ...input, title: 'Bad', answer_spec: { type: 'regex', pattern: '(' } }),
      OPERATOR_ID: 'operator:tester',
    });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /invalid_test/);

    const listed = await run(MAINTENANCE, { ACTION: 'list-skill-tests' });
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, new RegExp(`${id} +active`));
    assert.ok(!listed.out.includes('operator-secret-answer'));

    const off = await run(MAINTENANCE, { ACTION: 'deactivate-skill-test', SKILL_TEST: id.toLowerCase(), OPERATOR_ID: 'operator:tester' });
    assert.equal(off.code, 0, off.err);
    assert.equal((await t.db.prepare('SELECT active, deactivated_by FROM skill_tests WHERE id = ?').get(id)).active, false);
    const retired = await t.db.prepare("SELECT * FROM events WHERE kind = 'test' AND summary LIKE ?").get(`Deactivated skill test ${id} %`);
    assert.equal(retired.actor, 'operator:tester');
    const missing = await run(MAINTENANCE, { ACTION: 'deactivate-skill-test', SKILL_TEST: 'ST-99999', OPERATOR_ID: 'operator:tester' });
    assert.equal(missing.code, 1);
  });
});

describe('the seed', () => {
  test('refuses a store other than localhost without SEED_PRODUCTION, and wants an operator', async () => {
    const remote = await run(SEED, { OPERATOR_ID: 'operator:tester', DATABASE_URL: 'postgres://uain@db.example:5432/uain' });
    assert.equal(remote.code, 1);
    assert.match(remote.err, /refusing to seed the store at db\.example/);
    const nobody = await run(SEED, { OPERATOR_ID: '' });
    assert.equal(nobody.code, 1);
    assert.match(nobody.err, /OPERATOR_ID/);
    const dry = await run(SEED, { OPERATOR_ID: '' }, ['--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /6 tests checked; nothing written/);
  });

  test('seeds six tests once, each passed by its own answer and listed without it', async () => {
    const first = await run(SEED, { OPERATOR_ID: 'operator:seeder' });
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /6 test\(s\) added, 0 already there/);
    const second = await run(SEED, { OPERATOR_ID: 'operator:seeder' });
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /0 test\(s\) added, 6 already there/);
    const seeded = await t.db.prepare("SELECT * FROM skill_tests WHERE created_by = 'operator:seeder'").all();
    assert.equal(seeded.length, 6);
    assert.deepEqual(
      seeded.map((s) => s.skill).sort(),
      ['dates', 'hashing', 'quantitative reasoning', 'statistics', 'text extraction', 'unit conversion'],
    );
    const listed = (await (await t.connect()).call('uain_tests', {})).tests;
    for (const s of seeded) {
      const spec = JSON.parse(s.answer_spec);
      const listing = listed.find((x) => x.id === s.id);
      assert.ok(listing, s.id);
      const body = JSON.stringify(listing);
      assert.ok(!body.includes('answer_spec'));
      const answer = spec.type === 'set' ? spec.values : String(spec.value ?? '');
      if (spec.type === 'set') for (const v of answer) assert.ok(!listing.answer_format.includes(v), s.title);
      else if (spec.type === 'exact') assert.ok(!body.includes(answer), s.title);
    }
    const days = seeded.find((s) => s.skill === 'dates');
    assert.equal(JSON.parse(days.answer_spec).value, 257);
    const extraction = seeded.find((s) => s.skill === 'text extraction');
    assert.deepEqual(JSON.parse(extraction.answer_spec).values.sort(), ['2023-12-31', '2024-01-15', '2024-02-29', '2025-07-04']);
    const tank = seeded.find((s) => s.skill === 'quantitative reasoning');
    assert.equal(grading.grade(JSON.parse(tank.answer_spec), '15').passed, true);
  });
});
