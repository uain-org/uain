/**
 * The novelty items in a menu, as a client reads them (UAIN Client 0.13.0
 * found each of these): an item that only lacks an attestation says so, a
 * member's own challenge keeps the task off its menu, a checker can say it is
 * on a challenge, and declining one challenge leaves the task's others on
 * offer. Booted with the novelty rule required, as production runs.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let sources;
let lead, a, v1, v2, c, c2, c3, judge1, judge2;
before(async () => {
  t = await boot({ UAIN_REQUIRE_PRIOR_ART: '1' });
  sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  sources.setSourceFetcher(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '',
  }));
  [lead, a, v1, v2, c, c2, c3, judge1, judge2] = await Promise.all(
    ['Lead', 'Answer', 'Check One', 'Check Two', 'Challenger', 'Second', 'Third', 'Judge One', 'Judge Two'].map(
      (n) => t.member(`${n} Labs`, `items-${n.toLowerCase().replace(' ', '-')}`),
    ),
  );
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const BASIS = {
  statement:
    'No open dataset, paper or repository reports this value; the closest work estimates it only indirectly.',
  searched: ['Google Scholar: "sample digest value" 2015-2026', 'GitHub code search: sample digest value'],
};

/** A project of its own, so each test reads only its own menu. */
const project = async (members) => {
  const p = (await lead.call('uain_propose', {
    title: `Items ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Measure what nobody has measured.',
    stop_conditions: ['Halt if the work would need restricted data.'],
    prior_art: BASIS,
  })).project;
  await Promise.all(members.map((m) => m.call('uain_join_project', { project_id: p.id })));
  return p;
};
const openTask = async (p) =>
  (await lead.call('uain_task_open', {
    project_id: p.id,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What is the digest of the sample?',
    done_when: 'A digest with the code that computed it.',
    how_to_check: 'Recompute it from the pinned inputs.',
    prior_art: BASIS,
  })).task;
const challenge = async (who, task, n = 1) => {
  const filed = await who.call('uain_task_prior_art', {
    task_id: task.id,
    source: `https://example.org/solved-${n}`,
    note: 'Table 2 gives the digest for this very sample.',
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  return filed.challenge;
};
const menu = async (who, p) => (await who.call('uain_next', { project_id: p.id, limit: 50 })).items;
const decline = async (who, items) => {
  const r = await t.http('/api/working/decline', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ reason: 'Not a source I can open.', items }),
  });
  assert.equal(r.status, 200);
  return await r.json();
};

describe('novelty items a client can tell apart', () => {
  test('an item that only lacks the attestation is marked attestation_only', async () => {
    const p = await project([a, v1, v2]);
    const task = await openTask(p);
    const sub = (await a.call('uain_contribute', {
      project_id: p.id,
      task_id: task.id,
      title: `Answer to ${task.id}`,
      detail: 'Recomputed the digest from the pinned inputs.',
      claim: `The digest for ${task.id} is 42.`,
    })).contribution;
    // A check not yet given asks for the attestation too, but is a whole check.
    const fresh = (await menu(v1, p)).find((i) => i.contribution_id === sub.id);
    assert.equal(fresh.kind, 'verify');
    assert.equal(fresh.attest_novelty, true);
    assert.equal(fresh.attestation_only, undefined);

    const note = 'Re-ran it on the pinned inputs and got the same digest.';
    for (const v of [v1, v2])
      await v.call('uain_verify', { contribution_id: sub.id, verdict: 'confirmed', note });
    const item = (await menu(v1, p)).find((i) => i.contribution_id === sub.id);
    assert.equal(item.kind, 'verify');
    assert.equal(item.attest_novelty, true);
    assert.equal(item.attestation_only, true);
  });

  test("a member's open challenge keeps the task off its agents' menus, and its start is released", async () => {
    const sibling = await t.instance(c.key, 'Challenger Labs', 'items-challenger-sibling');
    const p = await project([a, c, sibling, judge1]);
    const task = await openTask(p);
    await c.call('uain_task_start', { task_id: task.id });
    assert.ok((await menu(c, p)).some((i) => i.kind === 'continue_task' && i.task_id === task.id));

    const filed = await challenge(c, task);
    const onTask = (items) => items.filter((i) => i.task_id === task.id && ['task', 'continue_task'].includes(i.kind));
    assert.deepEqual(onTask(await menu(c, p)), [], 'not offered to the challenger');
    assert.deepEqual(onTask(await menu(sibling, p)), [], 'nor to another agent of its member');
    assert.ok((await menu(a, p)).some((i) => i.kind === 'task' && i.task_id === task.id), 'still offered to others');
    assert.deepEqual((await t.db.getTask(task.id)).working, { count: 0, recent: [] });
    const events = await t.db.prepare('SELECT * FROM events WHERE actor = ? ORDER BY id').all(c.id);
    assert.equal(events.at(-1).kind, 'working');
    assert.match(events.at(-1).summary, new RegExp(`^Released ${task.id}`));

    await judge1.call('uain_task_prior_art_decide', {
      challenge_id: filed.id,
      decision: 'rejected',
      note: 'Table 2 is a different sample: its digest is not this one.',
    });
    assert.ok((await menu(c, p)).some((i) => i.kind === 'task' && i.task_id === task.id), 'offered again once decided');
  });

  test('a checker says it is on a challenge, and the menu prefers challenges nobody is on', async () => {
    const p = await project([c, c2, judge1, judge2]);
    const one = await challenge(c, await openTask(p));
    const two = await challenge(c2, await openTask(p));

    const started = await judge1.call('uain_start', { kind: 'prior_art_challenge', id: one.id });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.needed, 1);
    assert.equal(started.enough_already, false);

    const items = (await menu(judge2, p)).filter((i) => i.kind === 'prior_art_challenge');
    assert.deepEqual(items.map((i) => i.challenge_id), [two.id, one.id], 'the one nobody is on first');
    assert.deepEqual(items[1].working, [judge1.id]);
    assert.equal(items[1].enough_on_it, true);
    assert.equal(items[0].enough_on_it, false);
    assert.match(items[0].next_step, new RegExp(`^uain_start with kind "prior_art_challenge" and id "${two.id}"`));

    // Deciding it ends the signal, as submitting does; a decided one is not open.
    await judge1.call('uain_task_prior_art_decide', {
      challenge_id: one.id,
      decision: 'rejected',
      note: 'Table 2 is a different sample: its digest is not this one.',
    });
    const row = await t.db.prepare('SELECT done_at FROM item_workers WHERE item = ? AND participant = ?')
      .get(`prior_art_challenge:${one.id}`, judge1.id);
    assert.ok(row.done_at);
    assert.equal((await judge2.call('uain_start', { kind: 'prior_art_challenge', id: one.id })).error, 'item_not_open');
    assert.equal((await judge2.call('uain_start', { kind: 'prior_art_challenge', id: two.id })).ok, true);
    assert.equal((await judge2.call('uain_release', { kind: 'prior_art_challenge', id: two.id })).released, 1);
  });

  test('declining one challenge leaves the rest of its task on offer; a task_id declines its open ones', async () => {
    const p = await project([c, c2, c3, judge1, judge2]);
    const task = await openTask(p);
    const one = await challenge(c, task, 1);
    const two = await challenge(c2, task, 2);
    const challengesIn = async (who) =>
      (await menu(who, p)).filter((i) => i.kind === 'prior_art_challenge').map((i) => i.challenge_id);

    // A client that sends the item as the menu gave it declines that challenge.
    const item = (await menu(judge1, p)).find((i) => i.challenge_id === one.id);
    const told = await decline(judge1, [item]);
    assert.equal(told.declined, 1);
    assert.deepEqual(await challengesIn(judge1), [two.id]);

    // An older client names only the task: its open challenges, not later ones.
    const old = await decline(judge2, [{ kind: 'prior_art_challenge', task_id: task.id }]);
    assert.equal(old.declined, 2);
    assert.deepEqual(await challengesIn(judge2), []);
    const three = await challenge(c3, task, 3);
    assert.deepEqual(await challengesIn(judge2), [three.id]);
  });

  test("the lead's plan item reads as one sentence", async () => {
    const p = await project([]);
    const plan = (await menu(lead, p)).find((i) => i.kind === 'plan');
    assert.ok(plan);
    assert.doesNotMatch(plan.next_step, /project has a budget\)/);
    assert.match(plan.next_step, /instead of only what is already proven\); or, if nothing more is needed now, uain_release/);
  });
});
