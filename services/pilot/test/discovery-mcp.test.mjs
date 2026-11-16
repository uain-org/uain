/** A fresh, anonymous MCP client can find live work before it has a UAIN key. */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let lead;
let first;
let second;

const priorArt = {
  statement:
    'The checked public literature and repositories contain no open answer to this narrowly specified research question.',
  searched: [
    'Google Scholar: sensor-sparse estuary forecast reproducible benchmark',
    'GitHub code search: sensor-sparse estuary forecast benchmark',
  ],
};
const benevolence = {
  class: 'benevolent',
  statement:
    'Public flood warning research benefits exposed communities and uses only open environmental measurements.',
};
const verification = {
  method: 'reproduce',
  criteria:
    'Re-run the published evaluation from pinned public inputs and compare every forecast score with the submitted values.',
};

before(async () => {
  t = await boot({
    UAIN_REQUIRE_PRIOR_ART: '1',
    UAIN_REQUIRE_BENEVOLENCE: '1',
    UAIN_REQUIRE_VERIFICATION_PLAN: '1',
  });
  lead = await t.member('Discovery Test Operator', 'discovery-lead');
  const proposal = await lead.call('uain_propose', {
    title: 'Open estuary research',
    summary: 'Novel, checkable research on sparse environmental observations.',
    stop_conditions: ['Halt if restricted observations would be needed.'],
    prior_art: priorArt,
    benevolence,
  });
  assert.equal(proposal.opened, true, JSON.stringify(proposal));
  const projectId = proposal.project.id;
  const open = async (title) => {
    const result = await lead.call('uain_task_open', {
      project_id: projectId,
      title,
      question: `Can a new method solve ${title.toLowerCase()} from open measurements?`,
      done_when: 'A reproducible result and source code are public.',
      how_to_check: 'Re-run the pinned evaluation.',
      prior_art: priorArt,
      benevolence,
      verification,
    });
    assert.ok(result.task?.id, JSON.stringify(result));
    return result.task;
  };
  first = await open('Sensor-sparse estuary forecasts');
  second = await open('Coastal observation gap analysis');
});

after(async () => {
  await t?.close();
});

test('round 5: MCP rejects excessive input elements before tool schema validation', async () => {
  const anon = await t.connect();
  const result = await anon.client.callTool({ name: 'uain_find_tasks', arguments: { padding: Array(10001).fill(0) } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /maximum of 10000 elements/);
});

test('anonymous MCP search matches the live feed and stable task record', async () => {
  const anon = await t.connect();
  const tools = (await anon.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('uain_find_tasks'));
  const result = await anon.call('uain_find_tasks', { q: 'sensor-sparse' });
  assert.equal(result.count, 1);
  assert.equal(result.tasks[0].id, first.id);
  assert.equal(result.tasks[0].status, 'open');
  assert.equal(result.tasks[0].url, `/tasks/${first.id}`);
  assert.equal(result.tasks[0].api_url, `/api/tasks/${first.id}`);
  assert.deepEqual(result.tasks[0].prior_art, priorArt);
  assert.deepEqual(result.tasks[0].verification, verification);
  assert.match(result.next_step, /operator/);

  const feed = await t.http('/tasks/feed.json?q=sensor-sparse');
  assert.equal(feed.status, 200);
  const body = await feed.json();
  assert.equal(body.count, result.count);
  assert.deepEqual(body.tasks.map((task) => task.id), result.tasks.map((task) => task.id));
  assert.equal(body.tasks[0].url, `https://uain.global/tasks/${first.id}`);
  assert.equal(body.tasks[0].api_url, `https://uain.global/api/tasks/${first.id}`);
});

test('anonymous MCP search paginates and does not advertise closed work as open', async () => {
  const anon = await t.connect();
  const pageOne = await anon.call('uain_find_tasks', { page: 1, page_size: 1 });
  const pageTwo = await anon.call('uain_find_tasks', { page: 2, page_size: 1 });
  assert.equal(pageOne.count, 2);
  assert.equal(pageOne.pages, 2);
  assert.equal(pageOne.tasks.length, 1);
  assert.equal(pageTwo.tasks.length, 1);
  assert.notEqual(pageOne.tasks[0].id, pageTwo.tasks[0].id);

  const closed = await lead.call('uain_task_close', {
    task_id: second.id,
    reason: 'A narrower research question superseded this one.',
  });
  assert.equal(closed.error, undefined, JSON.stringify(closed));
  const open = await anon.call('uain_find_tasks');
  assert.deepEqual(open.tasks.map((task) => task.id), [first.id]);
  const historical = await anon.call('uain_find_tasks', { status: 'closed' });
  assert.ok(historical.tasks.some((task) => task.id === second.id));
});
