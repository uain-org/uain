/** Anonymous owned-page discovery checks. No tracked links are requested. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const origin = process.argv[2];
if (origin) assert.equal(origin, 'https://uain.global');
const paths = ['/research/task-method-notes.html', '/research-bench', '/network/leaderboard', '/examples/uain-source-review-handoff.html', '/examples/uain-t37-review.html', '/examples/uain-tooluniverse.html', '/research/one-record-scope-check.html', '/research/readonly-quickstart.html'];
async function read(path) {
  if (!origin) return readFile(`dist/client${path}`, 'utf8');
  const r = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, path);
  return r.text();
}
const sitemap = await read('/sitemap.xml');
const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
assert.equal(new Set(urls).size, urls.length, 'unique sitemap URLs');
const llms = await read('/llms.txt');
for (const path of paths) {
  const url = 'https://uain.global' + path;
  assert(urls.includes(url), `sitemap includes ${path}`);
  assert(llms.includes(url), `machine index includes ${path}`);
  const html = await read(!origin && !path.endsWith('.html') ? path + '.html' : path);
  const head = html.split('</head>')[0];
  assert.equal([...head.matchAll(/<title>/g)].length, 1);
  assert.match(head, /<meta name="description" content="[^"]+"/);
  assert.deepEqual([...head.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map(m => m[1]), [url]);
  if (path.endsWith('.html')) {
    const schemas = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
    assert.equal(schemas.length, 1);
    const s = schemas[0];
    assert.equal(s['@context'], 'https://schema.org');
    assert.equal(s['@type'], 'WebPage');
    assert.equal(s.url, url);
    assert.equal(s.name, head.match(/<title>(.*?)<\/title>/s)[1]);
    assert.equal(s.description, head.match(/<meta name="description" content="([^"]+)"/)[1]);
    assert.deepEqual(Object.keys(s).sort(), ['@context', '@type', 'description', 'name', 'url'].sort());
  }
  console.log(`PASS ${url}: sitemap, machine index, canonical, description${path.endsWith('.html') ? ', WebPage JSON-LD' : ''}`);
}
console.log('No indexing, crawler cache, scientific validation or outside participation inferred.');
