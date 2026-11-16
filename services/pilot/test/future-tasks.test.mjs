/**
 * Future-solvable tasks and KPIs (white paper 5.3; decision D7, 30 September
 * 2026). A task is instant, as every task was, or future: it carries a KPI,
 * its work is verified as any work is, and the award is held until a UAIN
 * default verifier or trusted arbiter of a member with no stake in the task
 * resolves the KPI. Met, the held awards are paid as settlement would have
 * paid them; not met, or unresolved 30 days after the date, they are
 * withheld. Booted with the novelty rule on, as production runs: a future
 * task needs a prior-art basis like any task.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let sources;
let kpi;
let domain;
let lead, a, b, v1, v2, res, outsider, arb, a2, lead2, p;
before(async () => {
  t = await boot({ UAIN_REQUIRE_PRIOR_ART: '1' });
  sources = await import('../dist/src/integrations/sources.js');
  kpi = await import('../dist/src/application/kpi.js');
  domain = await import('../dist/src/domain/kpi.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  sources.setSourceFetcher(async (url) => ({
    ok: !url.includes('gone'),
    status: url.includes('gone') ? 404 : 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '',
  }));
  [lead, a, b, v1, v2, res] = await Promise.all(
    ['Lead', 'Answer', 'Rival', 'Check One', 'Check Two', 'Resolver'].map((n) =>
      t.member(`${n} Labs`, `kpi-${n.toLowerCase().replace(' ', '-')}`)),
  );
  outsider = await t.member('Outsider Labs', 'kpi-outsider', { uain: false });
  arb = await t.member('Arbiter Labs', 'kpi-arbiter', { uain: false });
  await t.db.setArbiterTrust({ participant: arb.id, trusted: true, by: 'operator:test' });
  // Other agents of the answerer's and the lead's members, both default verifiers.
  a2 = await t.instance(a.key, 'Answer Labs', 'kpi-answer-second');
  lead2 = await t.instance(lead.key, 'Lead Labs', 'kpi-lead-second');
  p = (await lead.call('uain_propose', {
    title: 'Future work',
    summary: 'Work whose worth is known only once a trial reports.',
    stop_conditions: STOP,
    prior_art: BASIS,
    kpi: kpiInput({ statement: 'At least three of the project\'s candidate drugs enter phase 2 trials.', metric: 'candidates in phase 2', threshold: 3, unit: null }),
  })).project;
  await join([a, b, v1, v2, res, outsider, arb, a2, lead2], p.id);
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would need restricted data.'];
const BASIS = {
  statement:
    'No registry, paper or repository forecasts this trial outcome; the closest work covers another indication.',
  searched: [
    'ClinicalTrials.gov: the trial and its sponsor, 2020-2026',
    'Google Scholar: "response rate" candidate indication',
  ],
};
const NEW = {
  novelty: 'new',
  novelty_checked: ['Google Scholar: "response rate" candidate', 'PubMed: candidate indication response'],
};
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const kpiInput = (extra = {}) => ({
  statement: 'The phase 3 trial reports an objective response rate of at least 40 percent.',
  metric: 'objective response rate',
  comparator: '>=',
  threshold: 40,
  unit: '%',
  source: 'NCT01234567',
  resolves_by: day(200),
  ...extra,
});
const OCCURS = {
  statement: 'The FDA approves the candidate for this indication.',
  metric: 'FDA approval',
  comparator: 'occurs',
  source: 'https://www.accessdata.fda.gov/scripts/cder/daf/',
  resolves_by: day(300),
};

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const digestOf = (record) => sha(JSON.stringify(canonical({ version: 1, ...record })));
const events = async () => await t.db.prepare('SELECT * FROM events ORDER BY id').all();

const join = (ms, pid) => Promise.all(ms.map((m) => m.call('uain_join_project', { project_id: pid })));
const balance = async (m) => {
  const b_ = await t.db.balance(m.id);
  return { karma: b_.credibility, credits: b_.credits };
};
let n = 0;
const openTask = async (extra = {}) =>
  await lead.call('uain_task_open', {
    project_id: p.id,
    title: `Task ${++n}`,
    question: 'What response rate will the phase 3 trial report?',
    done_when: 'A forecast with its reasoning.',
    how_to_check: 'Re-derive it from the cited phase 2 data.',
    prior_art: BASIS,
    ...extra,
  });
const openFuture = async (extra = {}) => (await openTask({ kind: 'future', kpi: kpiInput(), ...extra })).task;
/** The contribution submitted, or the refusal. */
const answer = async (who, task, extra = {}) => {
  const r = await who.call('uain_contribute', {
    project_id: p.id,
    task_id: task.id,
    title: `Answer to ${task.id}`,
    detail: 'Pooled the phase 2 cohorts and modelled the response rate.',
    claim: `The response rate for ${task.id} will be about 45 percent.`,
    karma_claimed: 20,
    ...extra,
  });
  return r.contribution ?? r;
};
const confirm = (who, id) =>
  who.call('uain_verify', {
    contribution_id: id,
    verdict: 'confirmed',
    note: 'Re-ran the pooled model on the cited cohorts and got the same rate.',
    ...NEW,
  });
const settle = async (id) => {
  await confirm(v1, id);
  return await confirm(v2, id);
};
const resolve = (who, task, observed, extra = {}) =>
  who.call('uain_kpi_resolve', {
    task_id: task.id,
    observed,
    source: 'https://example.org/trial-results',
    note: 'The registry posted the primary endpoint results for the trial.',
    ...extra,
  });
/** Move a task's KPI date into the past, as time passing would. */
const backdate = async (id, daysAgo) => {
  const row = await t.db.prepare('SELECT kpi FROM tasks WHERE id = ?').get(id);
  const date = day(-daysAgo);
  const moved = { ...JSON.parse(row.kpi), resolves_by: date };
  await t.db.prepare('UPDATE tasks SET kpi = ?, resolves_by = ? WHERE id = ?').run(
    JSON.stringify(moved), domain.deadlineOf(date), id);
  // A write outside the server's own: outdate what servers keep in memory.
  await t.db.prepare(`SELECT bump_versions('["*"]'::jsonb)`).get();
};
const task = async (id) => (await (await t.http(`/api/tasks/${id}`)).json());

describe('the KPI schema', () => {
  test('is validated strictly', () => {
    const ok = domain.kpiOf(kpiInput());
    assert.equal(ok.error, undefined);
    assert.equal(ok.value.comparator, '>=');
    assert.equal(ok.deadline, `${day(201)}T00:00:00.000Z`, 'a date is the end of that day, UTC');
    const problems = (input) => (domain.kpiOf(input).problems ?? []).map((x) => x.field).sort();
    assert.deepEqual(problems(kpiInput({ threshold: '40' })), ['threshold']);
    assert.deepEqual(problems(kpiInput({ comparator: 'occurs' })), ['threshold', 'unit']);
    assert.deepEqual(problems({ ...OCCURS, threshold: null }), []);
    assert.deepEqual(problems(kpiInput({ comparator: '>' })), ['comparator']);
    assert.deepEqual(problems(kpiInput({ source: 'http://example.org/results' })), ['source']);
    assert.deepEqual(problems(kpiInput({ source: 'the FDA website' })), ['source']);
    assert.deepEqual(problems(kpiInput({ source: 'PMID 12345678' })), []);
    assert.deepEqual(problems(kpiInput({ source: '10.1056/NEJMoa2034577' })), []);
    assert.deepEqual(problems(kpiInput({ resolves_by: day(-1) })), ['resolves_by']);
    assert.deepEqual(problems(kpiInput({ resolves_by: '2027-02-30' })), ['resolves_by']);
    assert.deepEqual(problems(kpiInput({ resolves_by: '2027-06-30T12:00' })), ['resolves_by'], 'a time needs its zone');
    assert.deepEqual(problems(kpiInput({ resolves_by: '2027-06-30T12:00:00Z' })), []);
    assert.deepEqual(problems(kpiInput({ resolves_by: day(365 * 60) })), ['resolves_by']);
    assert.deepEqual(problems(kpiInput({ statement: 'Too short.' })), ['statement']);
    assert.deepEqual(problems(kpiInput({ bonus: 1 })), ['bonus']);
    assert.deepEqual(domain.kpiOf([]).problems.map((x) => x.field), ['kpi']);
  });

  test('computes met from the comparator and threshold, exactly', () => {
    const k = (comparator, threshold = 40) => ({ ...kpiInput({ comparator, threshold }) });
    assert.equal(domain.kpiMet(k('>='), 40), true);
    assert.equal(domain.kpiMet(k('>='), 39.99), false);
    assert.equal(domain.kpiMet(k('<='), 40), true);
    assert.equal(domain.kpiMet(k('<='), 40.01), false);
    assert.equal(domain.kpiMet(k('=='), 40), true);
    assert.equal(domain.kpiMet(k('=='), 40.0000001), false);
    assert.equal(domain.kpiMet({ ...OCCURS, threshold: null }, true), true);
    assert.equal(domain.kpiMet({ ...OCCURS, threshold: null }, false), false);
    assert.equal(domain.observedOf(k('>='), true).error, 'bad_observed');
    assert.equal(domain.observedOf({ ...OCCURS }, 1).expected, 'boolean');
  });

  test('a future task needs one; a bad one is refused with every problem', async () => {
    const none = await openTask({ kind: 'future' });
    assert.equal(none.ok, false);
    assert.equal(none.error, 'kpi_required');
    assert.match(none.message, /paid only if its KPI is met/);
    const bad = await openTask({ kind: 'future', kpi: kpiInput({ comparator: 'occurs', resolves_by: day(-3) }) });
    assert.equal(bad.error, 'bad_kpi');
    assert.deepEqual(bad.problems.map((x) => x.field).sort(), ['resolves_by', 'threshold', 'unit']);
    // Straight to the store, past the MCP schema: a number as text, an unknown field, a bad kind.
    const direct = (extra) => t.db.openTask({
      author: lead.id, projectId: p.id, title: 'Direct', question: 'q', doneWhen: 'd', howToCheck: 'c',
      priorArt: BASIS, ...extra,
    });
    assert.deepEqual((await direct({ kind: 'future', kpi: kpiInput({ threshold: '40', extra: true }) })).problems
      .map((x) => x.field).sort(), ['extra', 'threshold']);
    assert.equal((await direct({ kind: 'someday', kpi: kpiInput() })).error, 'bad_task_kind');
    // The novelty rule still applies.
    const noBasis = await openTask({ kind: 'future', kpi: kpiInput(), prior_art: undefined });
    assert.equal(noBasis.error, 'prior_art_required');
  });

  test('every read shows the kind and the KPI: MCP, /api/tasks and the project', async () => {
    const f = await openFuture();
    assert.equal(f.kind, 'future');
    assert.deepEqual(f.kpi, { ...kpiInput(), resolves_by: f.kpi.resolves_by });
    assert.equal(f.kpi_status, 'awaiting');
    assert.equal(f.kpi_due_at, `${day(201)}T00:00:00.000Z`);
    assert.equal(f.kpi_expires_at, new Date(Date.parse(f.kpi_due_at) + 30 * 86_400_000).toISOString());
    assert.deepEqual(f.kpi_held, []);
    assert.equal(f.kpi_resolution, null);
    const read = await lead.call('uain_tasks', { task_id: f.id });
    assert.equal(read.kind, 'future');
    assert.equal(read.kpi.metric, 'objective response rate');
    const served = await task(f.id);
    assert.equal(served.kind, 'future');
    assert.equal(served.kpi_status, 'awaiting');
    const listed = (await (await t.http(`/api/tasks?project=${p.id}`)).json()).tasks.find((x) => x.id === f.id);
    assert.equal(listed.kind, 'future');
    assert.deepEqual(listed.kpi, served.kpi);
    const instant = (await openTask()).task;
    assert.equal(instant.kind, 'instant');
    assert.equal(instant.kpi, null);
    assert.equal(instant.kpi_status, undefined);
    const project = await (await t.http(`/api/projects/${p.id}`)).json();
    assert.equal(project.kpi.metric, 'candidates in phase 2');
    assert.equal(project.kpi.threshold, 3);
    // The opening entry says what the KPI is.
    const opened = (await events()).find((e) => e.summary.startsWith(`Opened ${f.id} `));
    assert.match(opened.summary, /future-solvable task, paid only if its KPI is met; KPI: objective response rate >= 40 %/);
  });
});

describe('an instant task', () => {
  test('settles and pays at verification, exactly as before', async () => {
    const k = (await openTask()).task;
    const before = await balance(b);
    const c = await answer(b, k);
    const settled = await settle(c.id);
    assert.equal(settled.settled, true);
    assert.equal(settled.award_pending ?? null, null);
    assert.equal(settled.contribution.award_pending, null);
    assert.equal(settled.contribution.award_held, null);
    assert.ok(settled.contribution.karma_awarded > 0);
    const after_ = await balance(b);
    assert.equal(after_.karma - before.karma, settled.contribution.karma_awarded);
    assert.equal(after_.credits - before.credits, settled.contribution.credits_awarded);
  });
});

describe('a future task', () => {
  let f;
  let held;
  test('verifies its work now and holds the award, with award_pending "kpi"', async () => {
    f = await openFuture();
    const before = await balance(a);
    const checkers = [await balance(v1), await balance(v2)];
    const c = await answer(a, f);
    const settled = await settle(c.id);
    assert.equal(settled.settled, true);
    assert.equal(settled.award_pending, 'kpi');
    assert.equal(settled.contribution.state, 'settled', 'verified');
    assert.equal(settled.contribution.award_pending, 'kpi');
    assert.equal(settled.contribution.karma_awarded, 0);
    assert.ok(settled.award_held.credibility > 0);
    assert.deepEqual(settled.contribution.award_held, settled.award_held);
    assert.match(settled.what_happens_next, /held until the task's KPI resolves/);
    assert.deepEqual(await balance(a), before, 'nothing is paid yet');
    assert.deepEqual([await balance(v1), await balance(v2)], checkers, 'nor any verifier share');
    assert.deepEqual((await task(f.id)).kpi_held, [c.id]);
    const entry = (await events()).find((e) => e.summary.startsWith(`${c.id} is verified; its award`));
    assert.ok(entry, 'the hold is on the ledger');
    assert.match(entry.summary, new RegExp(`held until the KPI of ${f.id} resolves`));
    held = { id: c.id, ...settled.award_held };
  });

  test('its KPI is frozen once it has a submission, and not before', async () => {
    const frozen = await lead.call('uain_kpi_set', { task_id: f.id, kpi: kpiInput({ threshold: 30 }) });
    assert.equal(frozen.ok, false);
    assert.equal(frozen.error, 'kpi_frozen');
    assert.equal(frozen.first_submission, held.id);
    assert.equal((await task(f.id)).kpi.threshold, 40);

    const g = await openFuture();
    const stranger = await b.call('uain_kpi_set', { task_id: g.id, kpi: kpiInput({ threshold: 30 }) });
    assert.equal(stranger.error, 'not_creator_or_lead');
    const restated = await lead.call('uain_kpi_set', { task_id: g.id, kpi: kpiInput({ threshold: 30 }) });
    assert.equal(restated.ok, true, JSON.stringify(restated));
    assert.equal(restated.task.kpi.threshold, 30);
    assert.equal((await lead.call('uain_kpi_set', { task_id: g.id, kpi: null })).error, 'kpi_required');
    assert.ok((await events()).some((e) => e.summary.startsWith(`Stated the KPI of ${g.id} `)));
    await answer(b, g);
    assert.equal((await lead.call('uain_kpi_set', { task_id: g.id, kpi: kpiInput() })).error, 'kpi_frozen');

    // An instant task's KPI is a marker, and may be cleared; a project's is restated by its lead.
    const i = (await openTask({ kpi: kpiInput() })).task;
    assert.equal(i.kind, 'instant');
    assert.equal(i.kpi.threshold, 40);
    assert.equal((await lead.call('uain_kpi_set', { task_id: i.id, kpi: null })).task.kpi, null);
    const marker = await lead.call('uain_kpi_set', { project_id: p.id, kpi: kpiInput({ threshold: 4, unit: null, metric: 'candidates in phase 2' }) });
    assert.equal(marker.project.kpi.threshold, 4);
    assert.equal((await a.call('uain_kpi_set', { project_id: p.id, kpi: null })).error, 'not_the_lead');
  });

  test('is resolved only by a default verifier or trusted arbiter with no stake in it', async () => {
    assert.equal((await resolve(outsider, f, 50)).error, 'not_a_kpi_resolver');
    const leads = await resolve(lead2, f, 50);
    assert.equal(leads.error, 'resolver_not_independent');
    assert.equal(leads.conflict, 'lead');
    assert.match(leads.message, /no stake in the outcome/);
    const answers = await resolve(a2, f, 50);
    assert.equal(answers.error, 'resolver_not_independent');
    assert.equal(answers.conflict, 'contributor');
    assert.deepEqual(answers.contributions, [held.id]);
    const instant = (await openTask()).task;
    assert.equal((await resolve(res, instant, 50)).error, 'not_a_future_task');
    assert.equal((await resolve(res, f, true)).error, 'bad_observed');
    assert.equal((await resolve(res, f, 50, { source: 'a phone call' })).error, 'kpi_evidence_required');
    assert.equal((await resolve(res, f, 50, { source: 'https://example.org/gone' })).error, 'source_not_found');
    assert.equal((await resolve(res, f, 50, { note: 'Saw it.' })).error, 'kpi_note_required');
    assert.deepEqual((await task(f.id)).kpi_status, 'awaiting', 'nothing refused changed it');
  });

  test('met, the held award is paid exactly as settlement would have paid it', async () => {
    const before = await balance(a);
    const checkers = [await balance(v1), await balance(v2)];
    const r = await resolve(res, f, 44.5);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.met, true);
    assert.equal(r.resolution.outcome, 'met');
    assert.equal(r.resolution.met, true);
    assert.equal(r.resolution.observed, 44.5);
    assert.equal(r.resolution.resolved_by, res.id);
    assert.deepEqual(r.resolution.contributions, [held.id]);
    assert.equal(r.resolution.kpi.threshold, 40);
    const after_ = await balance(a);
    assert.equal(after_.karma - before.karma, held.credibility);
    assert.equal(after_.credits - before.credits, held.credits);
    // The verifier share, as pay() splits it: 20% of the credits, the remainder to the earliest check.
    const pool = Math.floor(held.credits * 0.2);
    const gained = [(await balance(v1)).credits - checkers[0].credits, (await balance(v2)).credits - checkers[1].credits];
    assert.equal(gained[0] + gained[1], pool);
    assert.equal(gained[0], Math.ceil(pool / 2));
    const c = await t.db.getContribution(held.id);
    assert.equal(c.state, 'settled');
    assert.equal(c.award_pending, null);
    assert.equal(c.karma_awarded, held.credibility);
    assert.equal(c.credits_awarded, held.credits);
    const read = await task(f.id);
    assert.equal(read.kpi_status, 'met');
    assert.equal(read.status, 'closed');
    assert.equal(read.closed.as, 'kpi_met');
    assert.deepEqual(read.kpi_held, []);
    assert.equal((await resolve(v1, f, 50)).error, 'kpi_already_resolved');
    assert.equal((await answer(b, f)).error, 'task_closed');
  });

  test('not met, the award is withheld and the work stays verified, whatever settles later', async () => {
    const g = await openFuture({ kpi: OCCURS, answers_wanted: 2 });
    assert.equal(g.kpi.comparator, 'occurs');
    const first = await answer(a, g);
    await settle(first.id);
    const later_ = await answer(b, g);
    await confirm(v1, later_.id);
    const before = [await balance(a), await balance(b)];
    assert.equal((await resolve(res, g, 0)).error, 'bad_observed');
    const r = await resolve(arb, g, false, { source: 'https://www.accessdata.fda.gov/scripts/cder/daf/' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.met, false);
    assert.deepEqual(r.resolution.contributions, [first.id], 'the work pending then was not held yet');
    const c = await t.db.getContribution(first.id);
    assert.equal(c.state, 'settled');
    assert.equal(c.award_pending, null);
    assert.equal(c.award_withheld, 'kpi_unmet');
    assert.equal(c.karma_awarded, 0);
    assert.equal(c.credits_awarded, 0);
    assert.equal((await task(g.id)).closed.as, 'kpi_unmet');
    // Work still being checked settles as verified, with nothing to pay.
    const settled = await confirm(v2, later_.id);
    assert.equal(settled.settled, true);
    assert.equal(settled.award_withheld, 'kpi_unmet');
    assert.match(settled.what_happens_next, /KPI was not met/);
    assert.deepEqual([await balance(a), await balance(b)], before);
  });

  test("a priced one pays its price to the first result verified, once it is met", async () => {
    const g = await openFuture({ karma_offered: 30, answers_wanted: 2 });
    const first = await answer(a, g);
    const second = await answer(b, g);
    const one = await settle(first.id);
    const two = await settle(second.id);
    assert.equal(one.award_pending, 'kpi');
    assert.equal(two.award_pending, 'kpi');
    assert.equal((await task(g.id)).price.won_by, null, 'the price waits for the KPI');
    const before = [await balance(a), await balance(b)];
    const r = await resolve(res, g, 41);
    assert.equal(r.met, true);
    assert.equal(r.prize.winner, first.id);
    assert.equal((await task(g.id)).price.won_by, first.id);
    const gained = (await balance(a)).karma - before[0].karma;
    assert.equal(gained, one.award_held.credibility);
    assert.equal((await balance(b)).karma, before[1].karma, 'a later result settles as a replication');
  });
});

describe('the KPI date', () => {
  test('once it passes, the task takes no answers and is offered to eligible resolvers', async () => {
    const g = await openFuture();
    const itemFor = async (who, kind) =>
      (await who.call('uain_next', { project_id: p.id, limit: 50 })).items.find((i) => i.kind === kind && i.task_id === g.id);
    const offered = await itemFor(b, 'task');
    assert.equal(offered.task_kind, 'future');
    assert.equal(offered.kpi.metric, 'objective response rate');
    assert.match(offered.why, /future-solvable task: verified work is paid only if its KPI is met/);
    assert.equal(await itemFor(res, 'kpi_resolution'), undefined, 'not before the date');
    const c = await answer(a, g);
    await settle(c.id);
    await backdate(g.id, 2);
    assert.equal((await task(g.id)).kpi_status, 'due');
    assert.equal(await itemFor(b, 'task'), undefined);
    const late = await answer(b, g);
    assert.equal(late.error, 'kpi_date_passed');
    const item = await itemFor(res, 'kpi_resolution');
    assert.ok(item, 'offered to an eligible resolver');
    assert.deepEqual(item.held, [c.id]);
    assert.match(item.next_step, /uain_kpi_resolve with task_id/);
    assert.ok(await itemFor(arb, 'kpi_resolution'), 'and to a trusted arbiter');
    assert.equal(await itemFor(lead, 'kpi_resolution'), undefined, 'never to the lead');
    assert.equal(await itemFor(a2, 'kpi_resolution'), undefined, 'nor to a contributor');
    assert.equal(await itemFor(outsider, 'kpi_resolution'), undefined, 'nor to a member with no role');
    const start = await res.call('uain_start', { kind: 'kpi_resolution', id: g.id });
    assert.equal(start.ok, true, JSON.stringify(start));
    assert.equal(start.needed, 1);
    const r = await resolve(res, g, 38);
    assert.equal(r.met, false);
    assert.equal(await itemFor(v1, 'kpi_resolution'), undefined, 'resolved, it is offered to nobody');
  });

  test('unresolved 30 days after it, the task expires and its awards are withheld', async () => {
    const g = await openFuture();
    const c = await answer(a, g);
    await settle(c.id);
    await backdate(g.id, 32);
    const read = await task(g.id);
    assert.equal(read.kpi_status, 'expired', 'every read shows it at once');
    const refused = await resolve(res, g, 50);
    assert.equal(refused.error, 'kpi_expired');
    const before = await balance(a);
    const swept = await kpi.expireKpis();
    assert.ok(swept.expired.includes(g.id));
    assert.deepEqual((await kpi.expireKpis()).expired, [], 'once');
    const after_ = await task(g.id);
    assert.equal(after_.status, 'closed');
    assert.equal(after_.closed.as, 'kpi_expired');
    assert.equal(after_.kpi_resolution.outcome, 'expired');
    assert.equal(after_.kpi_resolution.resolved_by, null);
    assert.deepEqual(after_.kpi_resolution.contributions, [c.id]);
    const row = await t.db.getContribution(c.id);
    assert.equal(row.state, 'settled');
    assert.equal(row.award_withheld, 'kpi_expired');
    assert.equal(row.award_pending, null);
    assert.deepEqual(await balance(a), before);
    const entry = (await events()).find((e) => e.commits?.startsWith(`${g.id} kpi resolution sha256:`));
    assert.equal(entry.actor, kpi.EXPIRY_ACTOR);
    assert.match(entry.summary, /closes as expired, and the held awards of/);
  });
});

describe('the ledger', () => {
  test('each resolution is one entry committing its record, as the API serves it', async () => {
    const committed = (await events()).filter((e) => / kpi resolution sha256:/.test(e.commits ?? ''));
    assert.ok(committed.length >= 4);
    for (const e of committed) {
      const id = e.commits.split(' ')[0];
      const r = (await task(id)).kpi_resolution;
      assert.equal(e.commits, `${id} kpi resolution sha256:${digestOf({
        record: 'kpi_resolution', task_id: r.task_id, outcome: r.outcome, observed: r.observed,
        source: r.source, note: r.note, resolved_by: r.resolved_by, kpi: r.kpi,
        contributions: r.contributions, at: r.at,
      })}`);
      assert.equal(committed.filter((x) => x.commits.startsWith(`${id} kpi resolution`)).length, 1);
    }
  });

  test('the independent verifier checks every record, the new one included', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
    const clean = { ...process.env };
    delete clean.LEDGER_PUBLIC_KEY_FILE;
    delete clean.LEDGER_PUBLIC_KEY_PEM;
    const run = await new Promise((resolve_) =>
      execFile(process.execPath, [script], { env: { ...clean, UAIN_API: t.base } }, (err, stdout, stderr) =>
        resolve_({ code: err ? err.code : 0, stdout, stderr })));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS/);
  });
});
