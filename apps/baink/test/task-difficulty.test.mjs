import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTaskDifficulty, countCriteria, timeboxMinutes, priorRejections, DIFFICULTY_LEVELS, validLevel } from '../server/task-difficulty.mjs';

const AI = (n) => String(BigInt(n) * 1000000n);
const survey = (over = {}) => ({ id: 'T-OPP-00002-1-prior-art-survey', project: 'P-OPP-00002', title: 'Prior-art survey', criteria: 'Prior-art survey for "x". Report the work that already exists.', eligibility: 'new', solver_amount: AI(200), reviewer_amount: AI(50), state: 'open', pending: '', winner: '', reserved: AI(250), paid: '0', ...over });
const published = (requiredIds = 10, minIncluded = 8) => ({ available: true, authority: 'operator-published', policyDigest: 'a'.repeat(64), policy: { class: 'prior_art_survey', driver: { name: 'prior-art-survey', sha256: 'b'.repeat(64) }, successTests: [{ id: 'survey', mainKpi: 'k'.repeat(30), minIncluded, minKinds: 2, requiredIds: Array.from({ length: requiredIds }, (_, i) => ({ kind: 'pubmed', id: String(i + 1) })) }] } });
const evidence = (over = {}) => ({ id: 'T-OPP-00002-7-measure', project: 'P-OPP-00002', title: 'Measure', criteria: 'Report the measured value with its uncertainty. Include the raw data file digest.', eligibility: 'new', solver_amount: AI(200), reviewer_amount: AI(20), state: 'open', pending: '', winner: '', reserved: AI(220), paid: '0', ...over });
const factor = (r, name) => r.reasons.find((x) => x.factor === name);

test('a production-shaped full survey scores 0 but is not starter: it can take up to 100 minutes (9 Nov 2026)', () => {
  const r = estimateTaskDifficulty(survey(), { requirements: published(10) });
  assert.equal(r.schema, 'baink-task-difficulty-v1');
  assert.equal(r.level, 'standard');
  assert.ok(factor(r, 'starter_time_gate').note.includes('30 minutes'));
  assert.equal(r.score, 0);
  assert.deepEqual(r.minutes, { min: 50, max: 100 });
  assert.equal(r.inputs.kind, 'prior_art_survey');
  assert.equal(r.inputs.verification, 'fixed_verifier');
  assert.equal(r.inputs.workItems, 10);
  assert.equal(r.inputs.solverUnits, AI(200));
  assert.equal(r.score, r.reasons.reduce((n, x) => n + x.points, 0));
  assert.ok(r.reasons.every((x) => typeof x.note === 'string' && x.note.length > 10));
});

test('the estimate is deterministic and does not mutate its inputs', () => {
  const t = survey(), req = published(12), before = JSON.stringify([t, req]);
  assert.deepEqual(estimateTaskDifficulty(t, { requirements: req }), estimateTaskDifficulty(t, { requirements: req }));
  assert.equal(JSON.stringify([t, req]), before);
});

test('a survey without its published policy still counts the declared fixed verifier, with a wider range', () => {
  const r = estimateTaskDifficulty(survey());
  assert.equal(r.level, 'standard');
  assert.equal(r.inputs.verification, 'fixed_verifier_declared');
  assert.equal(r.inputs.workItems, null);
  assert.deepEqual(r.minutes, { min: 30, max: 90 });
  // An unavailable requirements answer is the same as none.
  assert.deepEqual(estimateTaskDifficulty(survey(), { requirements: { available: false, reason: 'not_published' } }), r);
});

test('many required identifiers raise a survey to standard', () => {
  assert.equal(factor(estimateTaskDifficulty(survey(), { requirements: published(13) }), 'work_items').points, 1);
  const r = estimateTaskDifficulty(survey(), { requirements: published(40) });
  assert.equal(factor(r, 'work_items').points, 2);
  assert.equal(r.level, 'standard');
  assert.deepEqual(r.minutes, { min: 110, max: 220 });
});

test('an evidence task is never starter without a deterministic verifier', () => {
  const r = estimateTaskDifficulty(evidence());
  assert.equal(r.inputs.kind, 'evidence');
  assert.equal(r.inputs.verification, 'reviewer_judgement');
  assert.equal(r.inputs.criteria, 2);
  assert.equal(r.score, 3);
  assert.equal(r.level, 'standard');
  // With a timebox it scores 2, still not starter, and a starter score alone is gated.
  const short = estimateTaskDifficulty(evidence({ criteria: 'Answer within 30 minutes. Report one value.' }));
  assert.equal(short.inputs.timeboxMinutes, 30);
  assert.equal(short.score, 2);
  assert.equal(short.minutes.max, 30);
  assert.ok(short.minutes.min <= short.minutes.max);
});

test('without a deterministic verifier even the easiest evidence task stays standard; with one it can be starter', () => {
  const easiest = estimateTaskDifficulty(evidence({ criteria: 'Timebox: 20 minutes. Report one value.' }));
  assert.equal(easiest.score, 2);
  assert.equal(easiest.level, 'standard');
  const verified = estimateTaskDifficulty(evidence({ criteria: 'Within 25 minutes: report one value.' }), { requirements: { ...published(0, 1), policy: { ...published(0, 1).policy, class: 'evidence_check' } } });
  assert.equal(verified.inputs.kind, 'evidence');
  assert.equal(verified.inputs.verification, 'fixed_verifier');
  assert.equal(verified.score, 1);
  assert.equal(verified.level, 'starter');
  assert.equal(factor(verified, 'starter_gate'), undefined);
  const long = estimateTaskDifficulty(evidence({ criteria: 'Within 45 minutes: report one value.' }), { requirements: { ...published(0, 1), policy: { ...published(0, 1).policy, class: 'evidence_check' } } });
  assert.equal(long.score, 1);
  assert.equal(long.level, 'standard', 'a 45-minute timebox is longer than a starter');
});

test('a survey part (at most 3 records) is a starter of at most 30 minutes, also after one rejection', () => {
  const part = survey({ id: 'T-OPP-00006-1-prior-art-survey-r2-p1', criteria: 'Prior-art survey part 1 of 3. A small unit, expected within 20 minutes: check 3 identifiers.', solver_amount: AI(60), reviewer_amount: AI(10), reserved: AI(70) });
  const r = estimateTaskDifficulty(part, { requirements: published(3, 1) });
  assert.equal(r.inputs.kind, 'prior_art_survey_part');
  assert.equal(r.level, 'starter');
  assert.ok(r.minutes.max <= 30, JSON.stringify(r.minutes));
  const again = estimateTaskDifficulty({ ...part, state: 'open', paid: AI(10) }, { requirements: published(3, 1) });
  assert.equal(again.inputs.priorRejections, 1);
  assert.ok(again.minutes.max <= 30);
  assert.equal(again.level, 'starter');
});

test('hard and unresolved eligibility, many criteria and a large reward make a task advanced', () => {
  const criteria = Array.from({ length: 8 }, (_, i) => `- criterion ${i + 1} must hold`).join('\n');
  const r = estimateTaskDifficulty(evidence({ eligibility: 'unresolved', criteria, solver_amount: AI(5000) }));
  assert.equal(r.inputs.criteria, 8);
  assert.equal(factor(r, 'eligibility').points, 2);
  assert.equal(factor(r, 'criteria').points, 2);
  assert.equal(factor(r, 'reward').points, 2);
  assert.equal(r.level, 'advanced');
  assert.equal(estimateTaskDifficulty(survey({ eligibility: 'hard' })).level, 'standard');
});

test('reward bands: at most 250 AI$, over 250, over 2,000; fractional AI$ are printed exactly', () => {
  assert.equal(factor(estimateTaskDifficulty(survey({ solver_amount: AI(250) })), 'reward').points, 0);
  assert.equal(factor(estimateTaskDifficulty(survey({ solver_amount: '250000001' })), 'reward').points, 1);
  assert.equal(factor(estimateTaskDifficulty(survey({ solver_amount: AI(2001) })), 'reward').points, 2);
  assert.match(factor(estimateTaskDifficulty(survey({ solver_amount: '1500000' })), 'reward').note, /^1\.5 AI\$/);
});

test('earlier rejections come from native paid and raise the score and minutes', () => {
  assert.equal(priorRejections(survey()), 0);
  assert.equal(priorRejections(survey({ state: 'open_unfunded', paid: AI(50) })), 1);
  assert.equal(priorRejections(survey({ state: 'open', paid: AI(100) })), 2);
  assert.equal(priorRejections(survey({ state: 'accepted', paid: AI(250) })), 0);
  assert.equal(priorRejections(survey({ state: 'accepted', paid: AI(300) })), 1);
  const once = estimateTaskDifficulty(survey({ paid: AI(50) }));
  assert.equal(factor(once, 'prior_rejections').points, 1);
  assert.equal(once.score, 1);
  const thrice = estimateTaskDifficulty(survey({ paid: AI(150) }));
  assert.equal(factor(thrice, 'prior_rejections').points, 2);
  assert.equal(thrice.level, 'standard');
  assert.ok(thrice.minutes.max > estimateTaskDifficulty(survey()).minutes.max);
});

test('criteria counting: enumerated lists, otherwise sentences; bounded and safe on bad input', () => {
  assert.equal(countCriteria('- one thing\n- another thing\n- a third'), 3);
  assert.equal(countCriteria('1. first item\n2) second item'), 2);
  assert.equal(countCriteria('(a) first item\n(b) second item'), 2);
  assert.equal(countCriteria('Report the value. Include the data digest. Cite the source code.'), 3);
  assert.equal(countCriteria('Answer is 42'), 1);
  for (const bad of [undefined, null, 7, '', '   ']) assert.equal(countCriteria(bad), 0);
  assert.ok(countCriteria('Report this value now. '.repeat(10000)) <= 400);
});

test('timebox parsing: minutes and hours, only explicit phrases', () => {
  assert.equal(timeboxMinutes('Timebox: 45 minutes.'), 45);
  assert.equal(timeboxMinutes('Finish within 2 hours.'), 120);
  assert.equal(timeboxMinutes('time-boxed to 90 min'), 90);
  assert.equal(timeboxMinutes('no more than 1 h of work'), 60);
  assert.equal(timeboxMinutes('Report 45 identifiers.'), null);
  assert.equal(timeboxMinutes('within 0 minutes'), null);
  assert.equal(timeboxMinutes(undefined), null);
  const long = estimateTaskDifficulty(evidence({ criteria: 'Timebox: 3 hours. Report one value.' }));
  assert.equal(factor(long, 'timebox').points, 0);
  assert.equal(long.minutes.max, 180);
});

test('malformed or missing inputs never throw and are scored conservatively', () => {
  for (const t of [undefined, null, 'x', [], {}, { id: 7, solver_amount: 'abc', paid: '-1', eligibility: 'odd', criteria: 3 }]) {
    const r = estimateTaskDifficulty(t, { requirements: 'nonsense' });
    assert.ok(DIFFICULTY_LEVELS.includes(r.level));
    assert.notEqual(r.level, 'starter');
    assert.ok(r.minutes.min >= 5 && r.minutes.max >= r.minutes.min);
  }
  const r = estimateTaskDifficulty({});
  assert.equal(factor(r, 'eligibility').points, 1);
  assert.equal(factor(r, 'reward').points, 1);
});

test('level filter values', () => {
  assert.deepEqual(DIFFICULTY_LEVELS, ['starter', 'standard', 'advanced']);
  assert.ok(validLevel(undefined) && validLevel('starter') && !validLevel('easy') && !validLevel(true));
});
