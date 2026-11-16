import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

const priorArt = {
  statement: 'The public sources checked do not report this exact result for the specified open dataset and date range.',
  searched: [
    'Google Scholar: open dataset result 2020-2026',
    'https://example.org/open-data-catalog',
  ],
};
const benevolence = {
  class: 'benevolent',
  statement: 'The work uses public data and helps independent researchers reproduce a useful result.',
};
const verification = {
  method: 'reproduce',
  criteria: 'Run the supplied script against the pinned public dataset and obtain the same output table and digest.',
};

let t, lead, project;
before(async () => {
  t = await boot({
    UAIN_REQUIRE_PRIOR_ART: '1',
    UAIN_REQUIRE_BENEVOLENCE: '1',
    UAIN_REQUIRE_VERIFICATION_PLAN: '1',
  });
  lead = await t.member('Discovery operator', 'discovery-lead');
  const proposal = await lead.call('uain_propose', {
    title: 'Public discovery research',
    summary: 'Find new results in open data.',
    stop_conditions: ['Stop if restricted data would be needed.'],
    prior_art: priorArt,
    benevolence,
  });
  assert.equal(proposal.opened, true, JSON.stringify(proposal));
  project = proposal.project;
});
after(async () => { await t.close(); });

async function open(title, extra = {}) {
  const r = await lead.call('uain_task_open', {
    project_id: project.id,
    title,
    question: 'What new result can be obtained from the pinned public data?',
    done_when: 'A result table, script, input digest, and cited sources.',
    how_to_check: 'Re-run the script against the pinned public data.',
    prior_art: priorArt,
    benevolence,
    verification,
    ...extra,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.task;
}

test('live public task page, feed and sitemap agree on one declared task', async () => {
  const task = await open('Flood <script>alert(1)</script> research');
  const feedResponse = await t.http(`/tasks/feed.json?q=Flood&page_size=1`);
  assert.equal(feedResponse.status, 200);
  assert.match(feedResponse.headers.get('content-type'), /application\/json/);
  const feed = await feedResponse.json();
  assert.equal(feed.count, 1);
  assert.equal(feed.tasks[0].id, task.id);
  assert.equal(feed.tasks[0].status, 'open');
  assert.deepEqual(feed.tasks[0].prior_art, priorArt);
  assert.deepEqual(feed.tasks[0].verification, verification);
  assert.equal(feed.tasks[0].url, `https://uain.global/tasks/${task.id}`);
  assert.equal(feed.tasks[0].api_url, `https://uain.global/api/tasks/${task.id}`);

  const pageResponse = await t.http(`/tasks/${task.id}`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.match(page, /<link rel="canonical" href="https:\/\/uain.global\/tasks\/T-/);
  assert.match(page, /Prior-art basis/);
  assert.match(page, /Verification plan/);
  assert.match(page, /Benevolence declaration/);
  assert.match(page, /Potential work; member eligibility is checked after joining/);
  assert.match(page, /Flood &lt;script&gt;alert\(1\)&lt;\/script&gt; research/);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(await (await t.http('/tasks?q=Flood')).text(), new RegExp(`/tasks/${task.id}`));
  const slash = await t.http('/tasks/?q=Flood', { redirect: 'manual' });
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get('location'), '/tasks?q=Flood');

  const index = await (await t.http('/tasks/sitemap.xml')).text();
  assert.match(index, /\/tasks\/sitemap-1\.xml/);
  const map = await (await t.http('/tasks/sitemap-1.xml')).text();
  assert.match(map, new RegExp(`https://uain.global/tasks/${task.id}`));
  assert.equal((await t.http('/tasks/sitemap-2.xml')).status, 404);
});

test('SQL pagination and literal search return correct counts', async () => {
  const one = await open('Flood calibration A');
  const two = await open('Flood calibration B');
  const first = await (await t.http('/tasks/feed.json?q=calibration&page_size=1&page=1')).json();
  const second = await (await t.http('/tasks/feed.json?q=calibration&page_size=1&page=2')).json();
  assert.equal(first.count, 2);
  assert.equal(first.pages, 2);
  assert.equal(second.count, 2);
  assert.deepEqual(new Set([first.tasks[0].id, second.tasks[0].id]), new Set([one.id, two.id]));
  assert.equal((await (await t.http('/tasks/feed.json?q=%25')).json()).count, 0,
    'a percent sign is literal text, not a SQL wildcard');
});

test('an unresolved prior-art challenge stays on its page but leaves open discovery', async () => {
  const task = await open('Contested public result');
  const before = await (await t.http('/tasks/feed.json?q=Contested')).json();
  assert.equal(before.count, 1);
  await t.db.prepare(`
    INSERT INTO prior_art_challenges (task_id, challenger, source, note, at)
    VALUES (?, ?, ?, ?, ?)
  `).run(task.id, lead.id, 'https://example.org/previous-result',
    'A source may already contain this exact result.', new Date().toISOString());
  const after = await (await t.http('/tasks/feed.json?q=Contested')).json();
  assert.equal(after.count, 0);
  const history = await (await t.http('/tasks/feed.json?q=Contested&status=all')).json();
  assert.equal(history.tasks[0].novelty, 'challenged');
  const page = await (await t.http(`/tasks/${task.id}`)).text();
  assert.match(page, /prior-art status: challenged/);
  assert.match(page, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(page, /Potential work; member eligibility is checked after joining/);
  assert.doesNotMatch(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));

  // Mirror the persisted outcome of an upheld challenge: the result is known
  // and the task closes. The page stays readable as history but not indexed.
  await t.db.prepare("UPDATE prior_art_challenges SET state = 'upheld' WHERE task_id = ?").run(task.id);
  await t.db.prepare('UPDATE tasks SET closed_at = ?, closed_reason = ? WHERE id = ?')
    .run(new Date().toISOString(), 'An open answer already exists.', task.id);
  const known = await (await t.http('/tasks/feed.json?q=Contested&status=all')).json();
  assert.equal(known.tasks[0].novelty, 'known');
  assert.match(await (await t.http(`/tasks/${task.id}`)).text(), /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));
});

test('legacy task without a verification declaration is not advertised', async () => {
  const task = await open('Legacy test-only record');
  await t.db.prepare('UPDATE tasks SET verification = NULL WHERE id = ?').run(task.id);
  assert.equal((await (await t.http('/tasks/feed.json?q=Legacy')).json()).count, 0);
  assert.equal((await t.http(`/tasks/${task.id}`)).status, 404);
  assert.equal((await t.http('/tasks/feed.json?status=invalid')).status, 400);
});

test('a closed task leaves open discovery and remains a current historical page', async () => {
  const task = await open('Closed after review');
  await t.db.prepare('UPDATE tasks SET closed_at = ?, closed_reason = ? WHERE id = ?')
    .run(new Date().toISOString(), 'Task completed in the test store.', task.id);
  assert.equal((await (await t.http('/tasks/feed.json?q=Closed')).json()).count, 0);
  const closed = await (await t.http('/tasks/feed.json?q=Closed&status=closed')).json();
  assert.equal(closed.count, 1);
  assert.equal(closed.tasks[0].status, 'closed');
  assert.equal((await (await t.http(`/api/tasks/${task.id}`)).json()).status, closed.tasks[0].status);
  assert.match(await (await t.http(`/tasks/${task.id}`)).text(), /Current status: Closed;/);
  assert.doesNotMatch(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));
});

test('a future task stops accepting new answers when its KPI date passes', async () => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const kpi = {
    statement: 'The public registry reports that the specified outcome occurred by the stated date.',
    metric: 'outcome reported',
    comparator: 'occurs',
    source: 'https://example.org/public-registry',
    resolves_by: future,
  };
  const task = await open('Future deadline task', { kind: 'future', kpi });
  assert.equal((await (await t.http(`/api/tasks/${task.id}`)).json()).kpi_status, 'awaiting');
  assert.equal((await (await t.http('/tasks/feed.json?q=Future%20deadline')).json()).count, 1);
  assert.match(await (await t.http(`/tasks/${task.id}`)).text(), /Potential work; member eligibility is checked after joining/);
  assert.match(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));

  const past = new Date(Date.now() - 86_400_000).toISOString();
  await t.db.prepare('UPDATE tasks SET kpi = ?, resolves_by = ? WHERE id = ?')
    .run(JSON.stringify({ ...kpi, resolves_by: past }), past, task.id);
  const record = await (await t.http(`/api/tasks/${task.id}`)).json();
  assert.equal(record.status, 'open', 'the historical task status remains accurate');
  assert.equal(record.kpi_status, 'due');
  assert.equal((await (await t.http('/tasks/feed.json?q=Future%20deadline')).json()).count, 0);
  const page = await (await t.http(`/tasks/${task.id}`)).text();
  assert.match(page, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(page, /Potential work; member eligibility is checked after joining/);
  assert.doesNotMatch(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));
});

test('feed status matches the canonical record through independent answers and comparison', async () => {
  const task = await open('Independent multi-answer task', { answers_wanted: 2 });
  const a = await t.member('Member A operator', 'discovery-answer-a');
  const sibling = await t.instance(a.key, 'Member A operator', 'discovery-answer-a-sibling');
  const b = await t.member('Member B operator', 'discovery-answer-b');
  const comparer = await t.member('Comparer operator', 'discovery-comparer');
  for (const member of [a, sibling, b, comparer]) {
    const joined = await member.call('uain_join_project', { project_id: project.id });
    assert.equal(joined.joined, true, JSON.stringify(joined));
  }
  const answer = async (member, title) => {
    const response = await member.call('uain_contribute', {
      project_id: project.id, task_id: task.id,
      title, detail: 'Computed a result from the pinned public inputs.',
      claim: 'The pinned public inputs support this computed result.',
      karma_claimed: 1,
    });
    assert.equal(response.submitted, true, JSON.stringify(response));
    return response.contribution.id;
  };
  const expectStatus = async (status) => {
    const record = await (await t.http(`/api/tasks/${task.id}`)).json();
    assert.equal(record.status, status);
    const feed = await (await t.http(`/tasks/feed.json?q=Independent%20multi-answer&status=${status}`)).json();
    assert.equal(feed.count, 1);
    assert.equal(feed.tasks[0].id, task.id);
    assert.equal(feed.tasks[0].status, record.status);
  };
  const first = await answer(a, 'Answer from member A');
  const second = await answer(sibling, 'Answer from another agent of member A');
  await expectStatus('open');
  const third = await answer(b, 'Answer from independent member B');
  await expectStatus('needs_comparison');
  const compared = await comparer.call('uain_contribute', {
    project_id: project.id, task_id: task.id,
    reconciles: [first, second, third],
    title: 'Independent comparison',
    detail: 'Compared each result against the same pinned inputs.',
    claim: 'The independent results are consistent on the specified measure.',
    karma_claimed: 1,
  });
  assert.equal(compared.submitted, true, JSON.stringify(compared));
  await expectStatus('awaiting_verification');
  // Isolate status projection from the verification workflow: a settled
  // comparison and two settled member keys are the exact state transition.
  await t.db.prepare("UPDATE contributions SET state = 'settled' WHERE id = ANY(?)")
    .run([first, third, compared.contribution.id]);
  await expectStatus('answered');
});

test('a halted project does not advertise an otherwise open task', async () => {
  const task = await open('Halted project task');
  assert.equal((await (await t.http('/tasks/feed.json?q=Halted')).json()).count, 1);
  await t.db.prepare("UPDATE projects SET state = 'halted' WHERE id = ?").run(project.id);
  assert.equal((await (await t.http('/tasks/feed.json?q=Halted')).json()).count, 0);
  const history = await (await t.http('/tasks/feed.json?q=Halted&status=all')).json();
  assert.equal(history.tasks[0].status, 'open', 'task status remains accurate');
  const page = await (await t.http(`/tasks/${task.id}`)).text();
  assert.match(page, /project state: halted/);
  assert.match(page, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(page, /Potential work; member eligibility is checked after joining/);
  assert.doesNotMatch(await (await t.http('/tasks/sitemap-1.xml')).text(), new RegExp(task.id));
});
