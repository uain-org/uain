import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// Exercise the actual compiled HTTP discovery handler without network or a database.
// Only its native data dependency and response sink are supplied by the fixture.
const source = await readFile(new URL('../dist/src/api/server.js', import.meta.url), 'utf8');
// The page frame's helpers (record-frame.ts, 10 November 2026) are imports of server.js.
const frame = await import('../dist/src/api/record-frame.js');
const start = source.indexOf("const DISCOVERY_ORIGIN =");
const end = source.indexOf('\nconst publicParticipant =', start);
assert(start > 0 && end > start, 'compiled discovery handler exists');
const task = { id: 'T-37', project_id: 'P', title: 'Question <script>', question: 'Exact question </script><script>bad</script>', done_when: 'Exact output', created_at: '2026-10-19T00:00:00Z', status: 'open', novelty: 'stated', prior_art: { statement: 'Source search', searched: [] }, benevolence: { class: 'neutral' }, verification: { criteria: 'Exact check', method: 'reproduce' } };
async function render(selected = task, project = { title: 'Project', state: 'active' }, path = '/tasks/T-37') {
  const context = vm.createContext({ URL, process: { env: { UAIN_AUTHORITY: 'native' } }, COPY: 'fixture', framedDocument: frame.framedDocument, longDay: frame.longDay, noticeDocument: frame.noticeDocument, pageHead: frame.pageHead, RECORD_PAGE_CSP: frame.RECORD_PAGE_CSP, nativePublicData: async url => url.pathname.startsWith('/api/tasks/') ? { status: selected ? 200 : 404, body: selected ?? { error: 'not_found' } } : { status: project ? 200 : 404, body: project }, });
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
