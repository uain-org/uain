/**
 * The live stream and the ledger cursor, end to end.
 *
 *   UAIN_DATA_DIR=$(mktemp -d) UAIN_STREAM_HEARTBEAT_MS=500 node src/server.mjs &
 *   node scripts/stream-test.mjs
 *
 * UAIN_BASE may point through a proxy chain instead of at the pilot: the
 * latency checks are what show that nothing in between buffers the stream.
 * Exits non-zero on the first assertion that fails.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newKey, proveWith } from '../../../public/worker/uain-key.mjs';

const BASE = process.env.UAIN_BASE ?? 'http://127.0.0.1:8787';
const MCP = process.env.UAIN_MCP ?? `${BASE}/mcp`;
const FAST_MS = Number(process.env.FAST_MS ?? 1000);

/** A minimal SSE reader: every event, and every comment line, in order. */
function open(query = '', headers = {}) {
  const ctrl = new AbortController();
  const events = [];
  const comments = [];
  let wake = null;
  const done = (async () => {
    const res = await fetch(`${BASE}/api/stream${query}`, {
      headers,
      signal: ctrl.signal,
    });
    events.status = res.status;
    events.headers = res.headers;
    if (!res.ok) {
      events.body = await res.json();
      wake?.();
      return;
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const ev = { at: Date.now() };
        for (const line of block.split('\n')) {
          if (line.startsWith(':'))
            comments.push({ at: Date.now(), text: line });
          else {
            const i = line.indexOf(':');
            const k = line.slice(0, i);
            const v = line.slice(i + 1).trimStart();
            if (k === 'data') ev.data = JSON.parse(v);
            else ev[k] = v;
          }
        }
        if (ev.event) events.push(ev);
        wake?.();
      }
    }
  })().catch((e) => {
    if (e.name !== 'AbortError') throw e;
  });
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end)
        throw new Error(
          `timed out; have ${JSON.stringify(events.map((e) => [e.event, e.id]))}`,
        );
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
  };
  return { events, comments, until, close: () => ctrl.abort(), done };
}

async function enrolSomeone(name) {
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(MCP)));
  const t0 = Date.now();
  const r = await c.callTool({
    name: 'uain_enrol',
    arguments: {
      principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
      proof: proveWith(newKey(), 'enrol'),
      name,
      operator: 'Lab',
      authority: 'duty engineer',
    },
  });
  await c.close();
  return { t0, participant: JSON.parse(r.content[0].text).participant };
}

const json = async (path) => (await fetch(`${BASE}${path}`)).json();
let step = 0;
const ok = (label) => console.log(`  ok ${++step}  ${label}`);
const entries = (s) => s.events.filter((e) => e.event === 'entry');

/* ------------------------------------------------------------------ live */

const s1 = open();
await s1.until(() => s1.events.some((e) => e.event === 'ready'));
assert.equal(s1.events.status, 200);
assert.match(s1.events.headers.get('content-type'), /^text\/event-stream/);
const head = s1.events[0].data.head;
assert.equal(Number(s1.events[0].id), head);
ok(`stream opens with ready, head ${head}`);

const a = await enrolSomeone('Streamer A');
await s1.until(() => entries(s1).length >= 2);
const lag = entries(s1)[0].at - a.t0;
assert.ok(lag < FAST_MS, `first entry took ${lag}ms; something is buffering`);
const ids1 = entries(s1).map((e) => Number(e.id));
assert.deepEqual(
  ids1,
  [...ids1].sort((x, y) => x - y),
  'entries arrive in id order',
);
assert.ok(ids1.every((id) => id > head));
assert.equal(entries(s1)[0].data.actor, a.participant.id);
ok(`a write reaches an open stream in ${lag}ms, in id order`);

await s1.until(() => s1.comments.some((c) => c.text === ': ping'), 3000);
ok('heartbeat comments arrive while idle');

/* ---------------------------------------------------------------- resume */

const cursor = Number(entries(s1).at(-1).id);
s1.close();
await enrolSomeone('Streamer B');
await enrolSomeone('Streamer C');
const missed = (await json(`/api/events?after=${cursor}`)).events.map(
  (e) => e.id,
);
assert.ok(
  missed.length >= 4,
  `expected entries after ${cursor}, got ${missed}`,
);

const s2 = open('', { 'last-event-id': String(cursor) });
await s2.until(() => s2.events.some((e) => e.event === 'ready'));
assert.deepEqual(
  entries(s2).map((e) => Number(e.id)),
  missed,
);
const ready2 = s2.events.find((e) => e.event === 'ready');
assert.equal(ready2.data.replayed_from, cursor);
assert.equal(Number(ready2.id), missed.at(-1));
ok(
  `reconnecting with Last-Event-ID ${cursor} replays exactly the ${missed.length} missed entries, then ready`,
);

await enrolSomeone('Streamer D');
await s2.until(() => entries(s2).length > missed.length);
assert.ok(Number(entries(s2).at(-1).id) > missed.at(-1));
ok('after the replay the same stream carries on live');
s2.close();

const s3 = open(`?after=${cursor}`);
await s3.until(() => s3.events.some((e) => e.event === 'ready'));
assert.deepEqual(
  entries(s3)
    .map((e) => Number(e.id))
    .slice(0, missed.length),
  missed,
);
s3.close();
ok('?after= replays the same as Last-Event-ID');

/* ---------------------------------------------------------------- filter */

const s4 = open(`?after=${head}&kinds=handshake`);
await s4.until(() => s4.events.some((e) => e.event === 'ready'));
assert.ok(entries(s4).length > 0);
assert.ok(entries(s4).every((e) => e.data.kind === 'handshake'));
const ready4 = s4.events.find((e) => e.event === 'ready');
const allAfter = (await json(`/api/events?after=${head}&limit=500`)).events;
assert.equal(
  Number(ready4.id),
  allAfter.at(-1).id,
  'the cursor advances past filtered-out entries',
);
s4.close();
ok('kinds= filters, and the cursor still moves past what it filtered out');

/* ----------------------------------------------------------------- refuse */

for (const q of ['?after=-1', '?after=abc', '?after=1.5']) {
  const s = open(q);
  await s.until(() => s.events.status !== undefined && s.events.body);
  assert.equal(s.events.status, 400, q);
}
ok('a bad cursor is refused with 400');

/* ----------------------------------------------------------- the cursor */

let r = await (await fetch(`${BASE}/api/events?after=-1`)).status;
assert.equal(r, 400);
const p1 = await json(`/api/events?after=${head}&limit=3`);
assert.equal(p1.order, 'oldest_first');
assert.equal(p1.count, 3);
assert.equal(p1.more, true);
assert.deepEqual(
  p1.events.map((e) => e.id),
  [...p1.events.map((e) => e.id)].sort((x, y) => x - y),
);
const p2 = await json(`/api/events?after=${p1.next_after}&limit=3`);
assert.ok(p2.events[0].id > p1.next_after);
let all = [];
let c = head;
for (;;) {
  const p = await json(`/api/events?after=${c}&limit=2`);
  all = all.concat(p.events.map((e) => e.id));
  c = p.next_after;
  if (!p.more) break;
}
assert.deepEqual(
  all,
  allAfter.map((e) => e.id),
  'paging forward visits every entry once',
);
const end = await json(`/api/events?after=${c}`);
assert.equal(end.count, 0);
assert.equal(end.next_after, c);
assert.equal(end.more, false);
const newest = await json('/api/events?limit=2');
assert.ok(
  newest.events[0].id > newest.events[1].id,
  'without a cursor it is still newest first',
);
ok(
  '/api/events?after= pages forward oldest first with next_after and more; the old read is unchanged',
);

console.log(`\nall ${step} checks passed`);
process.exit(0);
