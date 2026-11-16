import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogue } from '../server/catalogue.mjs';
import { createProposalPages } from '../server/proposal-pages.mjs';
import { renderProposalPage } from '../server/proposal-page-template.mjs';

const catalogue = await loadCatalogue(
  new URL('../catalogue/', import.meta.url).pathname,
);
const pages = createProposalPages({
  catalogue,
  origin: 'https://baink.example',
});
const canonical = pages.resolve('/proposals/OPP-00001').location;
const model = pages.resolve(new URL(canonical).pathname).model;

test('proposal renderer emits initial accessible source-qualified HTML without executable content', () => {
  const html = renderProposalPage(model);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html[^>]+lang="en"/i);
  assert.match(html, /<h1[\s>]/i);
  assert.ok(html.includes(model.title));
  assert.ok(html.includes(model.id) && html.includes(model.document.revision));
  assert.ok(
    html.includes(model.source.workbookSha256) &&
      html.includes(model.source.revision),
  );
  assert.ok(html.includes(model.canonicalUrl) && html.includes(model.jsonUrl));
  assert.match(html, /application\/json/);
  assert.match(html, /inactive/i);
  assert.match(html, /target/i);
  assert.equal(
    /<script\b|<iframe\b|<form\b|@import|url\(\s*['"]?https?:|\bon(?:click|load|error)\s*=/i.test(
      html,
    ),
    false,
  );
  assert.ok(Buffer.byteLength(html) < 100000);
});

test('proposal renderer escapes every source text context and refuses unsafe hyperlink schemes', () => {
  const malicious =
    '</title><script>alert("source")</script><img src=x onerror="boom">&';
  const copy = structuredClone(model);
  for (const key of ['title', 'description', 'category', 'kind', 'notice'])
    copy[key] = malicious;
  for (const key of ['statement', 'unit', 'qualification'])
    copy.kpi[key] = malicious;
  copy.provenance.sheet = malicious;
  copy.source.notice = malicious;
  let html = renderProposalPage(copy);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;') && html.includes('&amp;'));
  for (const key of ['canonicalUrl', 'jsonUrl', 'workspaceUrl']) {
    const forged = { ...copy, [key]: 'javascript:alert(1)' };
    try {
      html = renderProposalPage(forged);
      assert.equal(/(?:href|src)\s*=\s*["']javascript:/i.test(html), false);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
  }
});
