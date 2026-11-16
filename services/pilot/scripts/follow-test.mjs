/**
 * The ledger follower (src/follow.mjs) under the failures it exists for.
 *
 *   UAIN_DATA_DIR=$(mktemp -d) node src/server.mjs &
 *   node scripts/follow-test.mjs
 *
 * A proxy in front of the pilot can hide the stream (an older server), or
 * accept a stream and then go silent (a half-open connection on a lossy path).
 * Exits non-zero on the first assertion that fails.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { follow } from '../dist/src/runtime/follow.js';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const UPSTREAM = process.env.UAIN_BASE ?? 'http://127.0.0.1:8787';
let mode = 'pass'; // pass | no-stream | silent-once
let silentServed = 0;

const proxy = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/stream' && mode === 'no-stream') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"not_found"}');
  }
  if (
    url.pathname === '/api/stream' &&
    mode === 'silent-once' &&
    silentServed === 0
  ) {
    silentServed += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return; // headers, then nothing, forever
  }
  const up = await fetch(`${UPSTREAM}${req.url}`, {
    headers: req.headers['last-event-id']
      ? { 'last-event-id': req.headers['last-event-id'] }
      : {},
  });
  res.writeHead(up.status, Object.fromEntries(up.headers));
  if (!up.body) return res.end();
  req.on('close', () => up.body.cancel().catch(() => {}));
  for await (const chunk of up.body) res.write(chunk);
  res.end();
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${proxy.address().port}`;

/** Writes one ledger entry through the MCP-free JSON enrol path. */
async function write(name) {
  const r = await fetch(`${UPSTREAM}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      operator: 'Lab',
      authority: 'duty engineer',
      principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
      proof: proveWith(newKey(), 'enrol'),
    }),
  });
  assert.equal(r.status, 201);
}
const head = async () =>
  (await (await fetch(`${UPSTREAM}/api/events?limit=1`)).json()).events[0]
    ?.id ?? 0;

function run(opts = {}) {
  const ctrl = new AbortController();
  const got = [];
  const notes = [];
  let ready = null;
  const done = follow({
    base: BASE,
    signal: ctrl.signal,
    note: (m) => notes.push(m),
    onReady: (h) => (ready ??= h),
    onEntry: (e) => {
      opts.onEntry?.(e);
      got.push(e.id);
    },
    idleMs: 600,
    maxBackoffMs: 400,
    ...opts.follow,
  });
  const until = async (pred, ms = 8000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end)
        throw new Error(`timed out; got ${got}; notes ${notes.join(' | ')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return {
    got,
    notes,
    until,
    get ready() {
      return ready;
    },
    stop: async () => {
      ctrl.abort();
      await done;
    },
  };
}

let step = 0;
const ok = (label) => console.log(`  ok ${++step}  ${label}`);

/* ------------------------------------------------------------ from now */

await write('seed');
let h = await head();
let f = run();
await f.until(() => f.ready !== null);
assert.equal(f.ready, h);
await write('one');
await write('two');
let want = (
  await (await fetch(`${UPSTREAM}/api/events?after=${h}`)).json()
).events.map((e) => e.id);
await f.until(() => f.got.length >= want.length);
assert.deepEqual(f.got, want);
await f.stop();
ok('from now: ready at the head, then every new entry once, in order');

/* ----------------------------------------------------- handler failure */

h = await head();
let failed = false;
f = run({
  onEntry: (e) => {
    if (!failed && e.summary.includes('flaky')) {
      failed = true;
      throw new Error('simulated handler failure');
    }
  },
});
await f.until(() => f.ready !== null);
await write('before');
await write('flaky');
await write('after');
want = (
  await (await fetch(`${UPSTREAM}/api/events?after=${h}`)).json()
).events.map((e) => e.id);
await f.until(() => f.got.length >= want.length);
assert.deepEqual(f.got, want, 'no entry lost, none duplicated, order kept');
assert.ok(failed);
assert.ok(f.notes.some((n) => n.includes('will be replayed')));
await f.stop();
ok(
  'a failing handler gets the same entry again, and nothing after it jumps the queue',
);

/* -------------------------------------------------------------- resume */

f = run({ follow: { after: h } });
await f.until(() => f.got.length >= want.length);
assert.deepEqual(f.got.slice(0, want.length), want);
await f.stop();
ok('after= resumes from a cursor and replays everything since');

/* ---------------------------------------------------- no stream at all */

mode = 'no-stream';
h = await head();
f = run();
await f.until(() => f.ready !== null);
assert.equal(f.ready, h);
await write('paged one');
await write('paged two');
want = (
  await (await fetch(`${UPSTREAM}/api/events?after=${h}`)).json()
).events.map((e) => e.id);
await f.until(() => f.got.length >= want.length);
assert.deepEqual(f.got, want);
assert.ok(f.notes.some((n) => n.includes('stream unavailable (404)')));
await f.stop();
ok(
  'with no stream it falls back to /api/events?after= and still delivers everything in order',
);

/* ----------------------------------------------- a stream that goes quiet */

mode = 'silent-once';
silentServed = 0;
h = await head();
f = run({ follow: { after: h } });
await write('while silent');
const target = await head();
await f.until(() => f.got.includes(target));
assert.ok(
  f.notes.some((n) => n.includes('reconnecting')),
  f.notes.join(' | '),
);
assert.equal(silentServed, 1);
await f.stop();
ok(
  'a connection that goes silent is dropped after the idle limit and the entry still arrives',
);

proxy.close();
console.log(`\nall ${step} checks passed`);
process.exit(0);
