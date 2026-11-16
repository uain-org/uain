import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createBainkServer } from '../server/app.mjs';

async function setup(
  t,
  catalogueDir = new URL('../catalogue/', import.meta.url).pathname,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-proposal-page-'));
  const app = await createBainkServer({
    dataDir,
    publicOrigin: 'https://baink.example',
    projectsSource: null,
    catalogueDir,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    app,
    dataDir,
    base: `http://127.0.0.1:${app.server.address().port}`,
    get: (path, options = {}) =>
      fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
        redirect: 'manual',
        ...options,
      }),
  };
}

test('canonical inactive proposal HTML and JSON are initial, source-bound and read-only', async (t) => {
  const f = await setup(t);
  const before = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))).catch(
    (error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  const list = await (await f.get('/api/proposals?pageSize=2')).json();
  const first = list.projects[0];
  assert.match(
    first.pageUrl,
    /^https:\/\/baink\.example\/proposals\/OPP-00001-[a-z0-9-]+$/,
  );
  assert.equal(first.url, null);
  const path = new URL(first.pageUrl).pathname;
  let response = await f.get(path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const html = await response.text();
  assert.ok(html.includes(first.id) && html.includes(first.title));
  assert.match(html, /inactive/i);
  assert.match(html, /target/i);
  assert.ok(
    html.includes('application/json') && html.includes(first.documentUrl),
  );
  assert.equal(/<script\b/i.test(html), false);
  assert.match(
    response.headers.get('content-security-policy'),
    /script-src 'none'|default-src 'none'/,
  );
  response = await f.get(path + '?format=json');
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.schema, 'baink/proposal-document/v1');
  assert.match(document.revision, /^[a-f0-9]{64}$/);
  assert.equal(document.id, first.id);
  assert.equal(document.status, 'inactive');
  assert.equal(document.progress, null);
  assert.equal(document.canonicalUrl, first.pageUrl);
  assert.ok(JSON.stringify(document).includes(list.source.workbookSha256));
  const head = await f.get(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(
    Number(head.headers.get('content-length')),
    Buffer.byteLength(html),
  );
  const nativeDetail = await (await f.get('/api/proposals/' + first.id)).json();
  assert.equal(nativeDetail.project.pageUrl, first.pageUrl);
  assert.equal(nativeDetail.project.documentUrl, first.documentUrl);
  assert.equal(nativeDetail.project.url, null);
  assert.deepEqual(
    await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }),
    before,
  );
});

test('proposal namespace redirects by stable ID, fails closed and retains privacy/navigation rules', async (t) => {
  const f = await setup(t);
  let response = await f.get('/proposals/OPP-00001');
  assert.equal(response.status, 308);
  const canonical = response.headers.get('location');
  assert.match(canonical, /^https:\/\/baink\.example\/proposals\/OPP-00001-/);
  response = await f.get('/proposals/OPP-00001-old-title?format=json');
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), canonical + '?format=json');
  for (const path of [
    '/proposals',
    '/proposals/OPP-99999',
    '/proposals/OPP-00001/a',
    '/proposals/opp-00001',
    '/proposals/%4fPP-00001',
    '/proposals/OPP-00001%00',
    '/proposals/OPP-00001.json',
  ]) {
    response = await f.get(path);
    assert.ok(
      [400, 404].includes(response.status),
      [path, response.status].join(':'),
    );
  }
  for (const suffix of [
    '?format=xml',
    '?format=json&format=json',
    '?owner=private',
  ])
    assert.equal(
      (await f.get(new URL(canonical).pathname + suffix)).status,
      400,
    );
  assert.equal(
    (await f.get(new URL(canonical).pathname, { method: 'POST', body: '{}' }))
      .status,
    405,
  );
  assert.equal(
    (
      await f.get(new URL(canonical).pathname + '?format=json', {
        headers: { Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.get(new URL(canonical).pathname, {
        headers: { 'Sec-Fetch-Site': 'cross-site' },
      })
    ).status,
    200,
  );
  const hostileHost = await f.get('/proposals/OPP-00001', {
    headers: { Host: 'attacker.example' },
  });
  assert.equal(hostileHost.headers.get('location'), canonical);
});

test('unavailable catalogue returns real503 for documents without leaking diagnostics or rendering app', async (t) => {
  const f = await setup(t, null);
  for (const path of [
    '/proposals/OPP-00001',
    '/proposals/OPP-00001-example?format=json',
  ]) {
    const response = await f.get(path);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(/<!doctype|\/Users\/|dataDir|checksums/i.test(text), false);
  }
});

test('raw proposal traversal cannot normalize into the generic application', async (t) => {
  const f = await setup(t);
  for (const path of [
    '/proposals/%2e%2e/',
    '/proposals/OPP-00001/../../',
    '/proposals/../',
    '/proposals\\..\\',
    '/%70roposals/../',
    'https://baink.example/proposals/../',
  ]) {
    const result = await new Promise((resolve, reject) => {
      const r = request(f.base, { path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (part) => (body += part));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      r.on('error', reject);
      r.end();
    });
    assert.equal(result.status, 404, path);
    assert.equal(result.body.includes('<div id="root">'), false);
  }
});

test('public JSON documents support ordinary cross-site navigation while rejecting cross-site fetches', async (t) => {
  const f = await setup(t);
  const getRaw = (path, options) =>
    new Promise((resolve, reject) => {
      const r = request(f.base, { path, ...options }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', reject);
      r.end();
    });
  const redirect = await f.get('/proposals/OPP-00001');
  const path =
    new URL(redirect.headers.get('location')).pathname + '?format=json';
  assert.equal(
    (
      await getRaw(path, {
        headers: {
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await getRaw(path, {
        headers: {
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await getRaw(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } }))
      .status,
    403,
  );
  assert.equal(
    (
      await getRaw(path, {
        headers: {
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
      })
    ).status,
    403,
  );
});
