import assert from 'node:assert/strict';
import { test } from 'node:test';
import { framedDocument, noticeDocument, wantsPage } from '../dist/src/api/record-frame.js';
import { publicStatus, resetPublicStatus, reviewQueue } from '../dist/src/api/public-status.js';

test('a page request is told apart from a program request (10 November 2026)', () => {
  const html = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  assert.equal(wantsPage(html, '/tasks'), true);
  assert.equal(wantsPage(html, '/network/directory/x'), true);
  assert.equal(wantsPage(html, '/api/members'), false, 'the API stays JSON for browsers too');
  assert.equal(wantsPage(html, '/mcp'), false);
  assert.equal(wantsPage(html, '/tasks/feed.json'), false);
  assert.equal(wantsPage('*/*', '/tasks'), false, 'programs keep JSON');
  assert.equal(wantsPage(undefined, '/tasks'), false);
});

test('framed pages name the site fragments, keep a plain stub, and mark the section', () => {
  const page = framedDocument({ head: '<title>T</title>', main: '<p>body</p>', section: 'tasks' });
  assert.match(page, /include virtual="\/_record-frame\/header-tasks.html" stub="plain_header"/);
  assert.match(page, /<main id="main" class="record-page"><div class="page-shell"><p>body<\/p><\/div><\/main>/);
  assert.match(page, /<!--# block name="plain_footer" --><footer class="plain-footer">/);
  assert.doesNotMatch(page, /Credits have no monetary value/);
  const notice = noticeDocument({ title: 'A <b> title', message: 'Try again in a minute.' });
  assert.match(notice, /A &lt;b&gt; title/);
  assert.match(notice, /noindex,follow/);
  assert.match(notice, /href="\/status"/);
});

test('status reads BAINK once a minute at most, never calls a failed read healthy, and shows the queue only when published', async () => {
  resetPublicStatus();
  const asked = [];
  let t = 1_000_000;
  const answers = {
    '/api/health': [200, { ok: true, storage: 'ready' }],
    '/api/native/review/health': [200, { available: true, brokerReady: true, broker: { payload: { rootReady: true } } }],
    '/api/public/review-queue': [404, { error: 'not_found' }],
  };
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const [status, body] = answers[path];
    return { status, text: async () => JSON.stringify(body) };
  };
  const first = await publicStatus({ ready: async () => true, fetcher, now: () => t });
  assert.equal(first.uain.ok, true);
  assert.equal(first.baink.ok, true);
  assert.equal(first.review.ok, true);
  assert.equal(first.review_queue, null, 'no queue figure until BAINK publishes one');
  assert.equal(asked.length, 3);
  t += 30_000;
  await publicStatus({ ready: async () => true, fetcher, now: () => t });
  assert.equal(asked.length, 3, 'held for a minute');
  t += 31_000;
  answers['/api/native/review/health'] = [200, { available: true, brokerReady: false }];
  answers['/api/health'] = [502, {}];
  answers['/api/public/review-queue'] = [200, { status: 'available', waiting: 4, oldestSince: '2026-11-10T09:00:00Z', note: '4 submissions wait.' }];
  const later = await publicStatus({ ready: async () => { throw Error('x'); }, fetcher, now: () => t });
  assert.equal(asked.length, 6);
  assert.equal(later.uain.ok, null);
  assert.equal(later.baink.ok, null, 'a failed read is not known, not healthy');
  assert.equal(later.review.ok, false);
  assert.equal(later.review_queue.waiting, 4);
  assert.equal(reviewQueue({ ok: true, status: 200, body: { status: 'unavailable', waiting: 3 } }), null);
  resetPublicStatus();
});

test('the status page reads of BAINK never follow a redirect (P2-6, 13 November 2026)', async () => {
  resetPublicStatus();
  const inits = [];
  await publicStatus({ ready: async () => true, fetcher: async (_url, init) => { inits.push(init); return { status: 200, text: async () => '{}' }; }, now: () => 1 });
  assert.ok(inits.length > 0);
  for (const init of inits) assert.equal(init.redirect, 'error');
  resetPublicStatus();
});
