/**
 * Work and projects that could not move, from docs/federation/reconciliation.md
 * section 4: contested work whose only default verifier disputed it (bug 6),
 * a finished project reopened past its lead's allowance (bug 7), and projects
 * that could never be halted or completed (bug 8). Halting is kept to members
 * with standing, and a halt can be lifted by the lead or an operator.
 *
 * Nobody here is one of UAIN's own agents unless a test names it one, so the
 * default verifier below is the only one on the network.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boot } from './helpers.mjs';

/** Run an operator maintenance action on this test's store, as the workflow does. */
const maintenance = (env) =>
  promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url))],
    { env: { ...process.env, ...env } },
  );

let t;
let lead;
let def;
let arb;
let a;
let b;

const STOP = ['Halt if the work would require restricted data.'];
const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);
const karmaOf = async (m) =>
  (await t.db.prepare('SELECT karma FROM participants WHERE id = ?').get(m.id)).karma;
const propose = (who, title = `P ${Math.random().toString(36).slice(2, 8)}`) =>
  who.call('uain_propose', { title, summary: 's', stop_conditions: STOP });
const join = (who, p) => who.call('uain_join_project', { project_id: p.id });
const verdict = (who, id, v, note = 'Checked.') =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note });
const task = (who, p, title = 'Q') =>
  who.call('uain_task_open', {
    project_id: p.id,
    title,
    question: 'What does the registry say?',
    done_when: 'The registry entry, cited',
    how_to_check: 'Look it up',
  });
const answer = (who, p, k, claim = 'The registry says so.') =>
  who.call('uain_contribute', {
    project_id: p.id,
    task_id: k.id,
    title: 'Answer',
    detail: 'Looked it up.',
    karma_claimed: 5,
    claim,
  });
const work = (who, p, extra = {}) =>
  who.call('uain_contribute', {
    project_id: p.id,
    title: 'w',
    detail: 'x',
    karma_claimed: 1,
    ...extra,
  });
const offered = async (who, p) =>
  (await who.call('uain_next', {})).items.filter((i) => i.project?.id === p.id);

before(async () => {
  t = await boot();
  lead = await t.member('Live Lead Co', 'live-lead', { uain: false });
  await t.db.setUainRole({ participant: lead.id, role: 'project-creator', on: true, by: 'operator:test' });
  def = await t.member('Live Default Co', 'live-default', { uain: false });
  await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
  arb = await t.member('Live Arbiter Co', 'live-arbiter', { uain: false });
  await setKarma(arb.id, 150);
  await t.db.setArbiterTrust({ participant: arb.id, trusted: true, by: 'operator:test' });
  a = await t.member('Live A Co', 'live-a', { uain: false });
  b = await t.member('Live B Co', 'live-b', { uain: false });
  await setKarma(a.id, 150);
  await setKarma(b.id, 150);
});
after(async () => {
  await t.close();
});

describe('contested work whose only default verifier disputed it', () => {
  /** Two members confirm, the only default verifier disputes, an arbiter confirms. */
  async function contested(prefix) {
    const p = (await propose(lead)).project;
    const worker = await t.member(`${prefix} Worker Co`, `${prefix}-worker`, { uain: false });
    for (const m of [worker, def, arb, a, b]) await join(m, p);
    const k = (await task(lead, p)).task;
    const sub = (await answer(worker, p, k)).contribution;

    await verdict(a, sub.id, 'confirmed');
    const checked = await verdict(b, sub.id, 'confirmed');
    assert.equal(checked.awaiting_default_verifier, true, JSON.stringify(checked));
    const disputed = await verdict(def, sub.id, 'disputed', 'The registry entry is for another trial.');
    assert.equal(disputed.contested, true, JSON.stringify(disputed));
    const ruled = await verdict(arb, sub.id, 'confirmed', 'The registry entry matches.');
    assert.equal(ruled.settled, false, JSON.stringify(ruled));
    assert.equal(ruled.awaiting_default_verifier, true);
    return { p, sub };
  }

  test('it settles once that default verifier confirms it after arbitration', async () => {
    assert.deepEqual(
      (await t.db.listUainRole('default-verifier')).map((r) => r.id),
      [def.id],
      'the only default verifier on the network',
    );
    const { p, sub } = await contested('dv1');

    // Nobody else may give the check that releases it.
    assert.equal((await verdict(a, sub.id, 'confirmed')).error, 'already_verified_by_you');

    // The default verifier that disputed it is offered it again, as the check
    // that releases pay. Before, it was told it had already verified it.
    const item = (await offered(def, p)).find((i) => i.contribution_id === sub.id);
    assert.equal(item?.default_verifier_check, true, JSON.stringify(await offered(def, p)));
    const before = await karmaOf(def);
    const done = await verdict(def, sub.id, 'confirmed', 'The arbiter is right: it is the same trial.');
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.arbitrated, true);

    const row = await t.db.getContribution(sub.id);
    assert.equal(row.state, 'settled');
    const mine = row.verifications.filter((v) => v.verifier === def.id);
    assert.equal(mine.length, 1, 'one verdict per verifier: the new one takes the dispute\'s place');
    assert.equal(mine[0].verdict, 'confirmed');
    assert.match(mine[0].note, /In place of its dispute of .*: The registry entry is for another trial\./);
    assert.equal(await karmaOf(def), before, 'confirming in place of its own dispute costs it nothing');
    // The work was disputed, so its claim is reviewed before it is believed.
    assert.equal(done.claim.status, 'unconfirmed');
    const events = await t.db
      .prepare("SELECT summary FROM events WHERE actor = ? AND kind = 'verification' ORDER BY id")
      .all(def.id);
    assert.ok(events.some((e) => /^disputed on "Answer"/.test(e.summary)), 'the dispute stays on the ledger');
    assert.ok(events.some((e) => /^confirmed on "Answer" after arbitration/.test(e.summary)));
  });

  test('or is rejected if it disputes the work again', async () => {
    const { sub } = await contested('dv2');
    const done = await verdict(def, sub.id, 'disputed', 'Still another trial.');
    assert.equal(done.rejected, true, JSON.stringify(done));
    assert.equal((await t.db.getContribution(sub.id)).state, 'rejected');
  });
});

describe("reopening a finished project and the lead's allowance", () => {
  test('a task on a finished project must fit the allowance, whoever opens it', async () => {
    const m = await t.member('Reopen Lead Co', 'reopen-lead', { uain: false });
    await setKarma(m.id, 1000);
    const first = (await propose(m)).project;
    await join(def, first);
    const sub = (await work(m, first, { verifiers_required: 1 })).contribution;
    assert.equal((await verdict(def, sub.id, 'confirmed')).settled, true);
    await setKarma(m.id, 1000);
    assert.equal((await t.db.getProject(first.id)).progress.status, 'finished');

    // The finished project frees its place, and a second takes it.
    const second = await propose(m);
    assert.equal(second.opened, true, JSON.stringify(second));

    // Reopening the first would make two.
    const reopened = await task(m, first);
    assert.equal(reopened.ok, false, JSON.stringify(reopened));
    assert.equal(reopened.error, 'project_limit_reached');
    assert.equal(reopened.allowed, 1);
    assert.deepEqual(reopened.running, [second.project.id]);
    assert.match(reopened.message, /allows/);
    assert.equal((await task(def, first)).error, 'project_limit_reached', "the place is the lead's");

    // A project still running takes tasks as before.
    assert.equal((await task(m, second.project)).ok, true);

    // With room for two, the first reopens, and a third does not fit.
    await setKarma(m.id, 1010);
    assert.equal((await task(m, first)).ok, true);
    assert.equal((await propose(m)).error, 'project_limit_reached');
  });
});

describe('halting and completing a project', () => {
  test('a member invokes a stop condition and the project halts, on the record', async () => {
    const p = (await propose(lead)).project;
    await join(a, p);
    const k = (await task(lead, p)).task;
    const held = (await answer(a, p, k)).contribution;

    assert.equal(
      (await b.call('uain_project_halt', { project_id: p.id, condition: STOP[0], reason: 'r' })).error,
      'not_a_member',
    );
    const wrong = await a.call('uain_project_halt', {
      project_id: p.id,
      condition: 'Halt if it rains.',
      reason: 'r',
    });
    assert.equal(wrong.error, 'condition_not_found');
    assert.deepEqual(wrong.stop_conditions, STOP);

    const halted = await a.call('uain_project_halt', {
      project_id: p.id,
      condition: STOP[0],
      reason: 'The next step needs patient records.',
    });
    assert.equal(halted.ok, true, JSON.stringify(halted));
    assert.equal(halted.halted, true);
    assert.equal(halted.state, 'halted');
    assert.deepEqual(
      { status: halted.progress.status, label: halted.progress.label },
      { status: 'halted', label: 'Halted' },
    );
    const events = await t.db.prepare("SELECT actor, summary FROM events WHERE kind = 'halt'").all();
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, a.id);
    assert.match(events[0].summary, /restricted data.*patient records/);

    // It offers no work, and takes no new tasks, answers or checks.
    assert.deepEqual(await offered(a, p), []);
    assert.deepEqual(await offered(lead, p), []);
    assert.equal((await task(lead, p)).error, 'project_closed');
    assert.equal((await work(a, p)).error, 'project_closed');
    assert.equal((await verdict(def, held.id, 'confirmed')).error, 'project_closed');
    assert.equal(
      (await lead.call('uain_project_halt', { project_id: p.id, condition: STOP[0], reason: 'r' })).error,
      'project_closed',
    );
    assert.ok(!(await t.db.runningProjects(lead.id)).includes(p.id));
    const listed = await t.db.listProjectSummaries({ status: 'halted' });
    assert.ok(listed.projects.some((x) => x.id === p.id));
  });

  test('only the lead, UAIN agents and members with 100 karma may halt; the lead or an operator resumes', async () => {
    const owner = await t.member('Halt Lead Co', 'halt-lead', { uain: false });
    await setKarma(owner.id, 1000);
    const p = (await propose(owner)).project;
    // The lead may halt its own project whatever its karma.
    await setKarma(owner.id, 0);
    const low = await t.member('Halt Low Co', 'halt-low', { uain: false });
    const hundred = await t.member('Halt Hundred Co', 'halt-hundred', { uain: false });
    await setKarma(hundred.id, 100);
    for (const m of [low, hundred, def]) await join(m, p);
    const halt = (who) =>
      who.call('uain_project_halt', { project_id: p.id, condition: STOP[0], reason: 'It needs patient records.' });
    const resume = (who, reason = 'The records are no longer needed.') =>
      who.call('uain_project_resume', { project_id: p.id, reason });
    const state = async () => (await t.db.getProject(p.id)).state;

    // Joining is free, so a member without standing may not stop the project.
    const refused = await halt(low);
    assert.equal(refused.error, 'halt_not_allowed', JSON.stringify(refused));
    assert.equal(refused.needed, 100);
    assert.match(refused.message, /lead/);
    assert.equal(await state(), 'active');

    // A member with 100 karma may, and may not lift its own halt; nor may anyone but the lead.
    assert.equal((await halt(hundred)).halted, true);
    assert.equal((await resume(hundred)).error, 'not_the_lead');
    assert.equal((await resume(low)).error, 'not_the_lead');
    // Resuming counts the project toward the lead's allowance again, so the
    // lead needs the karma to run it (test/resume-and-profile.test.mjs).
    await setKarma(owner.id, 1000);
    const resumed = await resume(owner);
    assert.equal(resumed.resumed, true, JSON.stringify(resumed));
    assert.equal(resumed.state, 'active');
    assert.notEqual(resumed.progress.status, 'halted');
    assert.equal((await resume(owner)).error, 'not_halted');
    assert.equal((await task(owner, p)).ok, true, 'a resumed project takes tasks again');

    // One of UAIN's default verifiers may, with no karma.
    assert.equal(await karmaOf(def), 0);
    assert.equal((await halt(def)).halted, true);
    assert.equal((await resume(owner)).resumed, true);

    // The lead halts its own project; an operator lifts it.
    assert.equal((await halt(owner)).halted, true);
    const out = await maintenance({
      ACTION: 'resume-project',
      PROJECT: p.id,
      BASIS: 'Checked with the lead: the condition no longer applies.',
      OPERATOR_ID: 'operator:test',
    });
    assert.match(out.stdout, /resumed/);
    assert.equal(await state(), 'active');
    const lifted = await t.db
      .prepare("SELECT actor, summary FROM events WHERE kind = 'halt' AND summary LIKE 'Resumed%' ORDER BY id")
      .all();
    assert.deepEqual(
      lifted.map((e) => e.actor),
      [owner.id, owner.id, 'operator:test'],
    );
    assert.match(lifted[2].summary, /no longer applies/);
    await assert.rejects(
      maintenance({ ACTION: 'resume-project', PROJECT: p.id, BASIS: 'again', OPERATOR_ID: 'operator:test' }),
      /not_halted/,
    );
  });

  test('the lead declares a finished project complete, and it takes no new work', async () => {
    const p = (await propose(lead)).project;
    await join(b, p);
    await join(def, p);
    const sub = (await work(b, p, { verifiers_required: 1 })).contribution;

    const complete = (who) =>
      who.call('uain_project_complete', { project_id: p.id, reason: 'done_when is met.' });
    assert.equal((await complete(b)).error, 'not_the_lead');
    const early = await complete(lead);
    assert.equal(early.error, 'project_not_finished', JSON.stringify(early));
    assert.equal(early.progress.status, 'in_progress');

    assert.equal((await verdict(def, sub.id, 'confirmed')).settled, true);
    const done = await complete(lead);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.completed, true);
    assert.equal(done.state, 'complete');
    assert.deepEqual(
      { status: done.progress.status, label: done.progress.label },
      { status: 'finished', label: 'Complete' },
    );
    const events = await t.db
      .prepare('SELECT summary FROM events WHERE actor = ? ORDER BY id DESC LIMIT 1')
      .all(lead.id);
    assert.match(events[0].summary, /complete: done_when is met\./);

    assert.deepEqual(await offered(b, p), []);
    assert.equal((await task(lead, p)).error, 'project_closed');
    assert.equal((await work(b, p)).error, 'project_closed');
    assert.equal((await complete(lead)).error, 'project_closed');
    assert.equal(
      (await b.call('uain_project_halt', { project_id: p.id, condition: STOP[0], reason: 'r' })).error,
      'project_closed',
    );
  });
});
