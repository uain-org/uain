/** SEO release acceptance: inspect real response HTML, never infer index status. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const origin = process.argv[2];
async function get(path) {
  if (!origin)
    return readFile(
      `dist/client${path === '/' ? '/index.html' : path.endsWith('.md') || path.endsWith('.txt') || path.endsWith('.xml') ? path : path + '.html'}`,
      'utf8',
    );
  const r = await fetch(origin + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200, path);
  return r.text();
}
for (const path of [
  '/',
  '/for-ai',
  '/insights',
  '/insights/measured-trust-not-blind-trust',
  '/editorial',
  '/network/projects',
  '/network/directory',
]) {
  const s = await get(path),
    head = s.split('</head>')[0],
    canonical =
      path === '/' ? 'https://uain.global' : 'https://uain.global' + path;
  assert.equal([...head.matchAll(/<title>/g)].length, 1, path);
  assert(head.includes(`rel="canonical" href="${canonical}"`), path);
  assert(head.includes(`property="og:url" content="${canonical}"`), path);
  assert.match(head, /<meta name="description" content="[^"]+"/);
  for (const m of s.matchAll(
    /<script type="application\/ld\+json">(.*?)<\/script>/gs,
  ))
    JSON.parse(m[1]);
  console.log('PASS metadata', path);
}
for (const path of ['/propose', '/network/proposals']) {
  const s = await get(path);
  assert.match(s, /<meta name="robots" content="noindex, follow"/);
  assert.doesNotMatch(s, /<form\b/);
  assert.match(s, /unavailable/);
  console.log('PASS retired workflow', path);
}
const map = await get('/sitemap.xml');
for (const path of [
  '/waitlist',
  '/propose',
  '/network/proposals',
  '/network/live',
])
  assert(!map.includes(`<loc>https://uain.global${path}</loc>`));
assert(
  (await get('/robots.txt')).includes(
    'https://uain.global/records/sitemap.xml',
  ),
);
if (origin) {
  const catalog = await get('/records/projects');
  assert.match(catalog, /\/network\/projects\//);
  const path = catalog.match(/href="(\/network\/projects\/[^"?#]+)"/)[1];
  const s = await get(path);
  assert(s.includes(`rel="canonical" href="https://uain.global${path}"`));
  assert.match(s, /What would count as done/);
  assert.match(s, /Tasks and evidence/);
  const members = await get('/records/members');
  const member = members.match(/href="(\/network\/directory\/[^"?#]+)"/)[1];
  const m = await get(member);
  assert(m.includes(`rel="canonical" href="https://uain.global${member}"`));
  assert.match(m, /declared, not independently verified/i);
  const missing = await fetch(
    origin + '/network/directory/seo-acceptance-nonexistent-record',
    { redirect: 'manual' },
  );
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /noindex/);
  const records = await get('/records/sitemap.xml');
  assert(records.includes(path));
  const task = await get('/tasks/T-37');
  assert.match(task, /noindex,follow/);
  for (const path of ['/for-ai/', '/network/projects/example/']) {
    const r = await fetch(origin + path, { redirect: 'manual' });
    assert([301, 308].includes(r.status), path);
  }
  const markdown = await fetch(origin + '/', {
    headers: { accept: 'text/markdown' },
  });
  assert.match(await markdown.text(), /Joining the United AI Network/);
  console.log(
    'PASS live catalogues, records, missing record, sitemap, task safeguards, redirects and Markdown negotiation',
  );
}
console.log(
  'No ranking, indexing, citation or outside-participation claim is inferred.',
);
