import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Exercise the actual compiled HTTP discovery handler without network or a database.
// Only its native data dependency and response sink are supplied by the fixture.
const source = await readFile(new URL('../dist/src/api/server.js', import.meta.url), 'utf8');
// The page frame's helpers (record-frame.ts, 10 November 2026) are imports of server.js.
const frame = await import('../dist/src/api/record-frame.js');
// The central task page (central-task-page.ts, 16 November 2026) is an import of server.js too.
const centralPage = await import('../dist/src/api/central-task-page.js');
const start = source.indexOf("const DISCOVERY_ORIGIN =");
const end = source.indexOf('\nconst publicParticipant =', start);
assert(start > 0 && end > start, 'compiled discovery handler exists');
const task = { id: 'T-37', project_id: 'P', title: 'Question <script>', question: 'Exact question </script><script>bad</script>', done_when: 'Exact output', created_at: '2026-10-19T00:00:00Z', status: 'open', novelty: 'stated', prior_art: { statement: 'Source search', searched: [] }, benevolence: { class: 'neutral' }, verification: { criteria: 'Exact check', method: 'reproduce' } };
async function render(selected = task, project = { title: 'Project', state: 'active' }, path = '/tasks/T-37', central = null) {
  const context = vm.createContext({ URL, process: { env: { UAIN_AUTHORITY: 'native' } }, COPY: 'fixture', framedDocument: frame.framedDocument, longDay: frame.longDay, noticeDocument: frame.noticeDocument, pageHead: frame.pageHead, RECORD_PAGE_CSP: frame.RECORD_PAGE_CSP, CENTRAL_TASK_ID: centralPage.CENTRAL_TASK_ID, renderCentralTaskMain: centralPage.renderCentralTaskMain, centralTaskForPage: async () => central, acceptedWorkDeps: () => null, acceptedWork: async () => ({ status: 503, body: {} }), nativePublicData: async url => url.pathname.startsWith('/api/tasks/') ? { status: selected ? 200 : 404, body: selected ?? { error: 'not_found' } } : { status: project ? 200 : 404, body: project }, });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.handle = handleTaskDiscovery;', context);
  let status, body;
  await context.handle({ method: 'GET' }, { writeHead(s) { status = s; }, end(b) { body = b; } }, new URL('https://uain.global' + path));
  return { status, body };
}
test('native task canonical, alternate and escaped JSON-LD identify the exact source', async () => {
  const r = await render();
  assert.equal(r.status, 200);
  assert.match(r.body, /rel="canonical" href="https:\/\/uain.global\/tasks\/T-37"/);
  assert.match(r.body, /type="application\/json" href="https:\/\/uain.global\/api\/tasks\/T-37"/);
  const raw = r.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  assert(!raw.includes('<'), 'JSON-LD cannot close its script');
  const schema = JSON.parse(raw);
  assert.equal(schema['@type'], 'CreativeWork');
  assert.equal(schema.url, 'https://uain.global/tasks/T-37');
  assert.equal(schema.identifier, task.id);
  assert.equal(schema.description, task.question);
  assert.equal(schema.datePublished, task.created_at);
  assert(!r.body.includes('name="robots"'));
});
test('incomplete original-policy declarations and non-actionable tasks stay noindex', async () => {
  for (const selected of [{ ...task, discovery: { publication_status: 'legacy_metadata_incomplete' } }, { ...task, status: 'closed' }, { ...task, novelty: 'known' }]) {
    const r = await render(selected);
    assert.equal(r.status, 200);
    assert.match(r.body, /name="robots" content="noindex,follow"/);
  }
  const halted = await render(task, { title: 'Project', state: 'halted' });
  assert.match(halted.body, /name="robots" content="noindex,follow"/);
});
test('unknown native task and absent project do not produce indexable error pages', async () => {
  for (const r of [await render(null), await render(task, null)]) {
    assert.equal(r.status, 404);
    // A page in the site's frame since 10 November 2026, still never indexable.
    assert.match(r.body, /Task not found/);
    assert.match(r.body, /name="robots" content="noindex,follow"/);
  }
});

test('a central task id reads as its own page here, and an unknown one is a 404 page', async () => {
  const { createHash } = await import('node:crypto');
  const criteria = 'Prior-art survey part 1 of 1 for "Goal". Main KPI: "One goal". A small unit, expected within 20 minutes: check these 2 identifiers the project-level searches returned against this Main KPI: doi 10.1/a; doi 10.1/b. Report them as an evidence artifact.';
  const t = { id: 'T-OPP-00001-1-prior-art-survey-r2-p1', project: 'P-OPP-00001', title: 'Prior-art survey: Goal (part 1 of 1)', criteria, acceptance_digest: createHash('sha256').update(criteria).digest('hex'), eligibility: 'new', solver_amount: '20000000', reviewer_amount: '5000000', evidence_digest: '2'.repeat(64), state: 'open', pending: '', winner: '', reserved: '25000000', paid: '0' };
  const page = await render(task, { title: 'Goal project', state: 'active' }, '/tasks/' + t.id, { task: t, held: false, height: '1', winner: null });
  assert.equal(page.status, 200);
  assert.match(page.body, /What the task asks/);
  assert.match(page.body, /Goal project/);
  assert.match(page.body, /node uain-agent\.mjs template T-OPP-00001-1-prior-art-survey-r2-p1/);
  assert.match(page.body, /rel="alternate" type="application\/json" href="https:\/\/baink\.money\/api\/native\/central\/survey-template\/T-OPP-00001-1-prior-art-survey-r2-p1"/);
  const missing = await render(task, { title: 'Goal project', state: 'active' }, '/tasks/T-OPP-99999-1-prior-art-survey', null);
  assert.equal(missing.status, 404);
});

// The /tasks tabs (16 November 2026): every state has a tab with its count, the selected tab
// changes the title and lead, and the tabs keep the search query.
async function renderList(path, list) {
  const context = vm.createContext({ URL, URLSearchParams, process: { env: { UAIN_AUTHORITY: 'native' } }, COPY: 'fixture', framedDocument: frame.framedDocument, longDay: frame.longDay, noticeDocument: frame.noticeDocument, pageHead: frame.pageHead, RECORD_PAGE_CSP: frame.RECORD_PAGE_CSP, CENTRAL_TASK_ID: centralPage.CENTRAL_TASK_ID, renderCentralTaskMain: centralPage.renderCentralTaskMain, centralTaskForPage: async () => null,
    acceptedWorkDeps: () => ({}), acceptedWork: async () => ({ status: 200, body: { accepted: [{ task: 'T-OPP-1-prior-art-survey-r1-p1', submission: 'CS-1', name: 'House agent', operator: 'UAIN', time: '2026-11-15T10:30:29Z' }] } }),
    nativePublicData: async url => url.pathname === '/api/tasks' ? { status: 200, body: list(url) } : url.pathname.startsWith('/api/members/') ? { status: 200, body: { name: 'Codex (UAIN)', operator: 'United AI Network' } } : { status: 404, body: {} } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.handle = handleTaskDiscovery;', context);
  let status, body;
  await context.handle({ method: 'GET' }, { writeHead(s) { status = s; }, end(b) { body = b; } }, new URL('https://uain.global' + path));
  return { status, body };
}
test('/tasks shows a tab per state with counts, and the answered tab names who answered', async () => {
  const asked = [];
  const list = (url) => {
    asked.push(url.searchParams.get('status'));
    const tabs = { open: 224, answered: 7, under_review: 4, closed: 2 };
    if (url.searchParams.get('status') !== 'answered') return { count: 0, page: 1, pages: 1, tasks: [], tabs };
    return { count: 2, page: 1, pages: 1, tabs, tasks: [
      { id: 'T-43', kind: 'instant', project_id: 'P', project_title: 'Longevity', title: 'Which null ITP results rule out 10%?', status: 'answered', price: { karma: 60 }, url: '/tasks/T-43', results: [{ id: 'RC-4569', state: 'settled', member_id: 'uain1' + 'a'.repeat(40), settled_at: '2026-09-30T12:58:05Z' }, { id: 'RC-4572', state: 'settled' }] },
      { id: 'T-OPP-1-prior-art-survey-r1-p1', kind: 'central', project_id: 'P-OPP-1', project_title: 'Robotaxi', title: 'Prior-art survey part 1', status: 'answered', status_label: 'Answered', winner: 'CS-1', reward: { solver_ai: 60 }, url: '/tasks/T-OPP-1-prior-art-survey-r1-p1' },
    ] };
  };
  const r = await renderList('/tasks?status=answered&q=survey', list);
  assert.equal(r.status, 200);
  assert.equal(asked[0], 'answered');
  assert.match(r.body, /<title>Answered research tasks \| UAIN<\/title>/);
  assert.doesNotMatch(r.body, /<h1[^>]*>Open research tasks/);
  for (const [label, n] of [['Open', 224], ['Answered', 7], ['Under review', 4], ['Closed', 2]]) assert.match(r.body, new RegExp(label + ' <span class="record-tab-count">' + n + '</span>'));
  assert.match(r.body, /class="record-tab on" href="\/tasks\?status=answered&amp;q=survey" aria-current="page"/);
  assert.match(r.body, /href="\/tasks\?q=survey">Open/, 'the open tab keeps the search');
  assert.match(r.body, /Answered by Codex \(UAIN\), run by United AI Network and 1 more · 30 September 2026/);
  assert.match(r.body, /Answered by House agent, run by UAIN · 15 November 2026/);
  assert.match(r.body, /<input type="hidden" name="status" value="answered">/);
  assert.match(r.body, /name="robots"/, 'only the open list is indexed');
  const open = await renderList('/tasks', list);
  assert.match(open.body, /<title>Open research tasks \| UAIN<\/title>/);
  assert.match(open.body, /class="record-tab on" href="\/tasks" aria-current="page">Open/);
  assert.equal((await renderList('/tasks?status=nonsense', list)).status, 200, 'an unknown tab falls back to open');
});
