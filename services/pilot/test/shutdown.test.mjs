// Graceful shutdown (operations/shutdown.ts), pool bounds and the start-up
// writes that must not run when there is nothing to do (10 November 2026).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  if (!t) return;
  await t.db.flushLog();
  await (await import('../dist/src/storage/ratelimit.js')).syncCounts();
  await t.close();
});

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('SIGTERM on the real server process', () => {
  test('fails readiness, ends streams, finishes, flushes the access log and exits 0', async () => {
    const port = await freePort();
    const server = fileURLToPath(new URL('../dist/src/api/server.js', import.meta.url));
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        UAIN_SHUTDOWN_DRAIN_MS: '600',
        UAIN_SHUTDOWN_DEADLINE_MS: '5000',
        UAIN_METRICS_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => (output += b));
    child.stderr.on('data', (b) => (output += b));
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; ; i++) {
        const r = await fetch(`${base}/api/ready`).catch(() => null);
        if (r?.status === 200) break;
        if (i > 200) throw new Error(`server never became ready:\n${output}`);
        await sleep(50);
      }

      // An open event stream, and a request whose access-log line is still
      // batched (200 ms) when the signal arrives.
      const stream = await fetch(`${base}/api/stream`);
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      await reader.read();
      const marker = `/api/projects/shutdown-marker-${Date.now()}`;
      assert.equal((await fetch(`${base}${marker}`)).status, 404);

      const signalled = Date.now();
      child.kill('SIGTERM');
      await sleep(100);
      // Draining: still answering, but not ready.
      const ready = await fetch(`${base}/api/ready`);
      assert.equal(ready.status, 503);
      assert.equal((await ready.json()).draining, true);
      assert.equal((await fetch(`${base}/api/health`)).status, 200);

      // The stream is ended by the server, not cut by the exit.
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      const { code, signal } = await exited;
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
      // Well inside the 30 s grace period, after the drain.
      const took = Date.now() - signalled;
      assert.ok(took >= 600 && took < 5000, `exit took ${took} ms`);
      assert.match(output, /shutdown: SIGTERM/);

      const logged = await t.db.query(
        "SELECT count(*)::int AS n FROM access_log WHERE action = $1",
        [`GET ${marker}`],
      );
      assert.equal(logged.rows[0].n, 1, 'the batched access-log line was flushed before exit');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('the shutdown routine', () => {
  test('runs once, waits for requests in flight, then flushes and exits', async () => {
    const { createShutdown, lifecycle } = await import('../dist/src/operations/shutdown.js');
    const { createServer: http } = await import('node:http');
    let release;
    const server = http((req, res) => {
      if (req.url === '/slow') release = () => res.end('done');
      else res.end('ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const steps = [];
    const shutdown = createShutdown({
      server,
      endStreams: () => steps.push('streams'),
      flush: async () => steps.push('flush'),
      drainMs: 50,
      deadlineMs: 5000,
      exit: (code) => steps.push(`exit ${code}`),
      say: () => {},
    });
    const slow = fetch(`${base}/slow`).then((r) => r.text());
    await sleep(50);
    const first = shutdown('SIGTERM');
    assert.equal(shutdown('SIGINT'), first, 'a second signal joins the first run');
    assert.equal(lifecycle.draining, true);
    await sleep(150);
    assert.deepEqual(steps, ['streams'], 'nothing flushed while a request is in flight');
    release();
    assert.equal(await slow, 'done');
    await first;
    assert.deepEqual(steps, ['streams', 'flush', 'exit 0']);
    lifecycle.draining = false;
  });

  test('cuts connections at the deadline and still flushes', async () => {
    const { createShutdown, lifecycle } = await import('../dist/src/operations/shutdown.js');
    const { createServer: http } = await import('node:http');
    const server = http(() => {}); // never answers
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const hung = fetch(`http://127.0.0.1:${server.address().port}/`).catch((e) => e);
    await sleep(50);
    const steps = [];
    const started = Date.now();
    await createShutdown({
      server,
      endStreams: () => {},
      flush: async () => steps.push('flush'),
      drainMs: 0,
      deadlineMs: 300,
      exit: (code) => steps.push(`exit ${code}`),
      say: () => {},
    })();
    assert.ok(Date.now() - started < 2000);
    assert.ok((await hung) instanceof Error);
    assert.deepEqual(steps, ['flush', 'exit 0']);
    lifecycle.draining = false;
  });
});

describe('start-up writes', () => {
  test('migrateRejected writes nothing, and moves no version, when nothing is disputed', async () => {
    const versions = async () =>
      (await t.db.query('SELECT id, version FROM project_versions ORDER BY id')).rows;
    const before = await versions();
    assert.equal(await t.db.migrateRejected(), false);
    assert.deepEqual(await versions(), before);
  });
});

describe('pool bounds', () => {
  test('connections carry their application name; scripts get no statement limit', async () => {
    const { pool } = await import('../dist/src/storage/store.js');
    const { rows } = await pool.query(
      "SELECT current_setting('application_name') AS name, current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle",
    );
    assert.match(rows[0].name, /^uain-pilot .+ main$/);
    // The test runner is not api/server.js: no statement limit.
    assert.equal(rows[0].statement, '0');
    assert.equal(rows[0].idle, '1min');
    assert.equal(pool.options.connectionTimeoutMillis, 10_000);
  });
});

describe('the session lookup', () => {
  test('the rate limit and the authentication of one request share one lookup', async () => {
    const a = await t.member('Lookup-Op');
    const store = await import('../dist/src/storage/store.js');
    await t.db.authenticate(a.token); // the first use may note the session's last use
    const spent = await t.db.inRequestScope(async () => {
      const queries = store.counter.queries;
      assert.equal(await t.db.tokenHolder(a.token), a.id);
      const who = await t.db.authenticate(a.token);
      assert.equal(who.id, a.id);
      return store.counter.queries - queries;
    });
    // It was six: the session for the rate limit, then session, agent,
    // member, member again and its karma.
    assert.equal(spent, 1);
    // Outside a request, or for a second authenticate in one, it reads afresh.
    const again = await t.db.inRequestScope(async () => {
      await t.db.tokenHolder(a.token);
      await t.db.authenticate(a.token);
      const queries = store.counter.queries;
      await t.db.authenticate(a.token);
      return store.counter.queries - queries;
    });
    assert.equal(again, 1);
    const r = await t.http('/api/next', { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(r.status, 200, await r.text());
  });

  test('a write in the request drops the kept lookup', async () => {
    const a = await t.member('Lookup-Op3');
    await t.db.inRequestScope(async () => {
      assert.equal(await t.db.tokenHolder(a.token), a.id);
      await t.db.logout(a.token);
      assert.equal(await t.db.authenticate(a.token), null);
    });
  });

  test('the member it returns matches getMember', async () => {
    const a = await t.member('Lookup-Op2');
    const who = await t.db.authenticate(a.token);
    assert.deepEqual(who.member, await t.db.getMember(who.member_id));
    assert.equal(who.id, a.id);
    assert.equal(await t.db.authenticate('not-a-token'), null);
  });
});
