/**
 * A branch-only rehearsal of the public path five separate members use.
 * Every identity and task lives in this file's throwaway PostgreSQL database.
 * It tests protocol reachability, not unprimed external discovery or human
 * operator consent. The test operators are fixtures, not real people.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

const priorArt = {
  statement: 'This disposable fixture is confined to the test database and has no production research claim.',
  searched: [
    'Disposable test database: checked generated fixture records for an earlier result.',
    'Branch test fixture inventory: checked that no result is seeded for these generated IDs.',
  ],
};
const benevolence = {
  class: 'benevolent',
  statement: 'The fixture uses no personal data or external resources.',
};
const verification = {
  method: 'reproduce',
  criteria: 'Check the supplied public fixture and record its digest.',
};

let t;
before(async () => {
  t = await boot({
    UAIN_REQUIRE_PRIOR_ART: '1',
    UAIN_REQUIRE_BENEVOLENCE: '1',
    UAIN_REQUIRE_VERIFICATION_PLAN: '1',
  });
});
after(async () => { await t?.close(); });

test('five distinct members discover, enrol, join and start separate tasks', async () => {
  // One privileged fixture opens work. The five arriving members below get
  // no UAIN role grant; they use only public MCP and ordinary member tools.
  const lead = await t.member('Fixture project operator', 'five-agent-fixture-lead');
  const proposed = await lead.call('uain_propose', {
    title: 'Five-agent branch-only discovery fixture',
    summary: 'Disposable public-data tasks for the branch integration test.',
    stop_conditions: ['Stop before any external or production action.'],
    prior_art: priorArt,
    benevolence,
  });
  assert.equal(proposed.opened, true, JSON.stringify(proposed));
  const projectId = proposed.project.id;

  const tasks = [];
  for (let i = 1; i <= 5; i++) {
    const opened = await lead.call('uain_task_open', {
      project_id: projectId,
      title: `Five-agent fixture ${i}: inspect a public test record`,
      question: `What does disposable public test record ${i} contain?`,
      done_when: 'A reproducible answer with an input digest.',
      how_to_check: 'Compare the answer with the pinned fixture.',
      prior_art: priorArt,
      benevolence,
      verification,
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    tasks.push(opened.task);
  }

  const addresses = new Set();
  const participants = new Set();
  for (let i = 0; i < 5; i++) {
    const task = tasks[i];
    const anonymous = await t.connect();
    const found = await anonymous.call('uain_find_tasks', {
      q: `Five-agent fixture ${i + 1}`,
    });
    assert.equal(found.count, 1, JSON.stringify(found));
    assert.equal(found.tasks[0].id, task.id);
    assert.equal(found.tasks[0].status, 'open');
    assert.equal((await t.http(`/tasks/${task.id}`)).status, 200);
    const feed = await (await t.http(`/tasks/feed.json?q=Five-agent%20fixture%20${i + 1}`)).json();
    assert.equal(feed.tasks[0].id, task.id);

    const member = await t.member(`Fixture operator ${i + 1}`, `five-agent-fixture-${i + 1}`, { uain: false });
    const who = await member.call('uain_whoami');
    assert.equal(who.authenticated, true);
    assert.equal(who.member.address, member.key.address);
    assert.equal(who.participant.id, member.id);
    addresses.add(who.member.address);
    participants.add(who.participant.id);

    const joined = await member.call('uain_join_project', { project_id: projectId });
    assert.equal(joined.joined, true, JSON.stringify(joined));
    const menu = await member.call('uain_next', { project_id: projectId, limit: 50 });
    assert.ok(menu.items.some((item) => item.kind === 'task' && item.task_id === task.id),
      JSON.stringify(menu.items));
    const started = await member.call('uain_start', { kind: 'task', id: task.id });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.task.id, task.id);
    assert.equal(started.others_working.length, 0);
    const current = await (await t.http(`/api/tasks/${task.id}`)).json();
    assert.equal(current.working.count, 1);
    assert.equal(current.status, 'open');
  }
  assert.equal(addresses.size, 5, 'five independent member keys');
  assert.equal(participants.size, 5, 'five independent agent records');
});
