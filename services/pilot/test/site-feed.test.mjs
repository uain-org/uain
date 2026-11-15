import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directories = [];
after(async () => {
  await Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function modules() {
  const directory = await mkdtemp(join(tmpdir(), 'uain-site-feed-'));
  directories.push(directory);
  for (const [name, source] of [
    ['api-base', 'lib/network/api-base.ts'],
    ['feed', 'lib/network/feed.ts'],
    ['format', 'lib/network/format.ts'],
    ['divide', 'components/network/divide.tsx'],
  ]) {
    let code = await readFile(
      new URL('../../../' + source, import.meta.url),
      'utf8',
    );
    code = code
      .replace("'./api-base'", "'./api-base.mjs'")
      .replace("'@/lib/network/format'", "'./format.mjs'");
    const compiled = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    }).outputText;
    await writeFile(join(directory, name + '.mjs'), compiled);
  }
  return {
    feed: await import(pathToFileURL(join(directory, 'feed.mjs'))),
    divide: await import(pathToFileURL(join(directory, 'divide.mjs'))),
  };
}
async function fixture(run) {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  };
  let now = Date.parse('2026-10-13T12:00:00Z'),
    body,
    ok = true;
  const calls = [],
    intervals = new Set();
  globalThis.document = { hidden: false, addEventListener() {} };
  globalThis.setInterval = (fn) => {
    intervals.add(fn);
    return fn;
  };
  globalThis.clearInterval = (fn) => intervals.delete(fn);
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok, json: async () => body };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await run({
      ...(await modules()),
      calls,
      flush,
      reply: (value) => {
        body = value;
        ok = true;
      },
      fail: () => {
        ok = false;
      },
      tick: async (milliseconds) => {
        now += milliseconds;
        for (const fn of intervals) fn();
        await flush();
      },
      now: () => now,
    });
  } finally {
    Object.assign(globalThis, {
      fetch: original.fetch,
      setInterval: original.setInterval,
      clearInterval: original.clearInterval,
    });
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
    Date.now = original.now;
  }
}
const snapshot = (verified_at, refresh_pending = true) => ({
  projects: [{ id: 'real-project' }],
  site_snapshot: { verified_at, refresh_pending, authoritative: false },
});

test('site browsing receives dated rows while updates are pending, rather than a fabricated fresh timestamp', async () =>
  fixture(async (f) => {
    f.reply(snapshot('2026-10-13T11:59:30Z'));
    const rows = [],
      statuses = [];
    const off = f.feed.subscribe(
      '/api/projects?page_size=20',
      (body) => rows.push(body.projects),
      { onStatus: (value) => statuses.push(value) },
    );
    try {
      await f.flush();
      assert.equal(rows[0][0].id, 'real-project');
      const status = statuses.at(-1);
      assert.equal(status.okAt, Date.parse('2026-10-13T11:59:30Z'));
      assert.equal(status.updating, true);
      assert.equal(status.stale, false);
      assert.equal(
        new URL(f.calls[0], 'https://uain.invalid').searchParams.get(
          'site_snapshot',
        ),
        '1',
      );
      const note = f.divide.feedLine(status, true);
      assert.match(note, /Updating; verified at/);
      assert.doesNotMatch(note, /not answer/i);
    } finally {
      off();
    }
  }));

test('snapshot flags are limited to public browsing and never sent to strict discovery or individual records', async () =>
  fixture(async (f) => {
    assert.equal(typeof f.feed.siteSnapshotPath, 'function');
    for (const path of [
      '/api/projects?q=health',
      '/api/tasks?project=P',
      '/api/contributions',
      '/api/directory',
      '/api/stats',
      '/api/directory/map',
      '/api/projects/P',
      '/api/projects/P/tasks?page=2',
      '/api/projects/P/claims',
      '/api/projects/P/members',
    ])
      assert.equal(
        new URL(
          f.feed.siteSnapshotPath(path),
          'https://uain.invalid',
        ).searchParams.get('site_snapshot'),
        '1',
        path,
      );
    for (const path of [
      '/api/tasks?discover=1',
      '/api/tasks/T',
      '/api/contributions/C',
      '/api/directory/A',
      '/api/members/M',
      '/api/native/state',
      '/api/native/receipt',
      '/api/wallets/ethereum/A/balance',
      '/api/activity?limit=80',
      '/api/proposals',
    ])
      assert.equal(
        new URL(
          f.feed.siteSnapshotPath(path),
          'https://uain.invalid',
        ).searchParams.has('site_snapshot'),
        false,
        path,
      );
  }));

test('an expired retained snapshot keeps its rows and says updating; a failed read is still stale', async () =>
  fixture(async (f) => {
    f.reply(snapshot('2026-10-13T11:58:01Z', false));
    const rows = [],
      statuses = [];
    const off = f.feed.subscribe(
      '/api/projects',
      (body) => rows.push(body.projects),
      { onStatus: (status) => statuses.push(status) },
    );
    try {
      await f.flush();
      assert.equal(Boolean(statuses.at(-1).updating), false);
      await f.tick(5000);
      assert.equal(statuses.at(-1).updating, true);
      assert.equal(statuses.at(-1).stale, false);
      assert.equal(rows.at(-1)[0].id, 'real-project');
      assert.doesNotMatch(
        f.divide.feedLine(statuses.at(-1), true),
        /not answer/i,
      );
      f.fail();
      await f.tick(5000);
      assert.equal(statuses.at(-1).stale, true);
      assert.equal(rows.at(-1)[0].id, 'real-project');
      assert.match(f.divide.feedLine(statuses.at(-1), true), /not answered/);
    } finally {
      off();
    }
  }));

test('the snapshot age boundary never reports a two-minute-old record as fresh', async () =>
  fixture(async (f) => {
    const status = f.feed.publicReadStatus(
      snapshot('2026-10-13T11:58:00Z', false),
    );
    assert.equal(status.updating, true);
    assert.equal(status.stale, false);
  }));

test('legacy pilot responses retain delivery-time freshness and malformed snapshot dates never become fresh data', async () =>
  fixture(async (f) => {
    f.reply({ projects: [{ id: 'pilot-project' }] });
    const rows = [],
      statuses = [];
    const off = f.feed.subscribe(
      '/api/projects',
      (body) => rows.push(body.projects),
      { onStatus: (status) => statuses.push(status) },
    );
    try {
      await f.flush();
      assert.equal(statuses.at(-1).okAt, f.now());
      assert.equal(statuses.at(-1).stale, false);
      assert.equal(Boolean(statuses.at(-1).updating), false);
      f.reply(snapshot('invalid'));
      await f.tick(5000);
      assert.equal(statuses.at(-1).stale, true);
      assert.equal(rows.at(-1)[0].id, 'pilot-project');
    } finally {
      off();
    }
  }));

test('a project with three separately verified reads reports the oldest verification and any pending refresh', async () =>
  fixture(async (f) => {
    assert.equal(typeof f.feed.combinePublicReadStatus, 'function');
    const status = f.feed.combinePublicReadStatus([
      snapshot('2026-10-13T11:59:45Z', false),
      {
        claims: [],
        site_snapshot: {
          verified_at: '2026-10-13T11:59:30Z',
          refresh_pending: true,
          authoritative: false,
        },
      },
      { tasks: [] },
    ]);
    assert.equal(status.okAt, Date.parse('2026-10-13T11:59:30Z'));
    assert.equal(status.updating, true);
    assert.equal(status.stale, false);
  }));
