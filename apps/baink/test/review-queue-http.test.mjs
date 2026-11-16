// The public review-queue figure (10 November 2026 field report 05): the HTTP route, its cross-origin read
// for uain.global's /status page, baink_guide's reviewQueue field, and the two central-earning readers
// it is built on. Fixture level: the native reader is a stand-in with the real proof shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createBainkServer } from '../server/app.mjs';
import { createCentralEarningService } from '../server/central-earning.mjs';
import { createReviewQueue } from '../server/review-queue.mjs';

const pins = { chainId: 'fictional-queue', epoch: 'a'.repeat(64), verifierSha256: 'b'.repeat(64) };
function fakeNative(records, calls = []) {
  return {
    configured: true, pins, timeoutMs: 8000,
    async publicState({ keys }) {
      calls.push(keys);
      const proof = { authority: 'native', chainId: pins.chainId, epoch: pins.epoch, genesisSha256: pins.epoch, verifierSha256: pins.verifierSha256, height: '40', appHash: 'c'.repeat(64), headerTime: new Date().toISOString(), maxAgeSeconds: 120 };
      return { proof, state: { chain_id: pins.chainId, height: '40', app_hash: 'c'.repeat(64), event_count: '9', records: Object.fromEntries(keys.map((k) => [k, records[k] ?? null])) } };
    },
  };
}
const intent = (id, at, status = 'accepted', operation = 'central_submit') => ({ status, sendAttemptedAt: at, command: { operation, payload: { id, task: 'T-' + id } } });

test('central earning lists the submissions BAINK relayed and reads their public records, nothing else', async () => {
  const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
  const intents = {
    a: intent('CS-a', ago(50)), b: intent('CS-b', ago(30), 'finalized'), c: intent('CS-c', ago(20), 'refused'),
    d: intent('CS-d', ago(10), 'prepared'), e: intent('CS-e', ago(5), 'accepted', 'central_join'), f: { status: 'accepted', command: { operation: 'central_submit', payload: { id: 'CS-f' } } },
    g: intent('../x', ago(1)),
  };
  const calls = [];
  const service = createCentralEarningService({ store: { read: () => ({ centralEarningIntents: intents }) }, native: fakeNative({ 'central_submission/CS-a': { state: 'under_review' }, 'central_submission/CS-b': { state: 'accepted' } }, calls) });
  // Newest first; refused, prepared, never-sent, non-submit and malformed rows left out.
  assert.deepEqual(service.recordedSubmissions(), [{ id: 'CS-b', task: 'T-CS-b', at: ago(30) }, { id: 'CS-a', task: 'T-CS-a', at: ago(50) }]);
  assert.equal(service.recordedSubmissions(1).length, 1);
  const read = await service.publicRecords(['central_submission/CS-a', 'central_submission/CS-b', 'central_submission/CS-z']);
  assert.deepEqual(read.records, { 'central_submission/CS-a': { state: 'under_review' }, 'central_submission/CS-b': { state: 'accepted' }, 'central_submission/CS-z': null });
  assert.equal(read.height, '40');
  assert.deepEqual(calls, [['central_submission/CS-a', 'central_submission/CS-b', 'central_submission/CS-z']]);
  // Only submission records, at most 96, never anything a caller names.
  for (const bad of [[], ['member/uain1x'], ['central_submission/../x'], Array.from({ length: 97 }, (_, n) => 'central_submission/CS-' + n)])
    await assert.rejects(service.publicRecords(bad), /invalid_central_keys/);
  // Without a native reader there is no answer (the queue then says it could not read).
  assert.equal(await createCentralEarningService({ store: { read: () => ({}) }, native: { configured: false } }).publicRecords(['central_submission/CS-a']), null);
});

test('answers sent back for more evidence are counted apart: they wait for their authors, not for the reviewer', async () => {
  const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
  // 10 November 2026: the figure read "waiting: 2, oldest since 03:02 UTC" for two needs-evidence answers.
  const intents = { a: intent('CS-a', ago(400)), b: intent('CS-b', ago(390)), c: intent('CS-c', ago(20)), d: intent('CS-d', ago(380)), e: intent('CS-e', ago(370)) };
  const records = {
    'central_submission/CS-a': { state: 'under_review', evidence_request_height: '30', evidence_deadline: '129630' },
    'central_submission/CS-b': { state: 'under_review', evidence_request_height: '31', evidence_deadline: '129631' },
    'central_submission/CS-c': { state: 'under_review' },
    // The author asked for a reassessment: it is back with the reviewer.
    'central_submission/CS-d': { state: 'under_review', evidence_deadline: '129640', reassess: true },
    // The deadline passed (proof height 40 here is below it; make one that passed).
    'central_submission/CS-e': { state: 'under_review', evidence_deadline: '39' },
  };
  const queue = createReviewQueue({ centralEarning: createCentralEarningService({ store: { read: () => ({ centralEarningIntents: intents }) }, native: fakeNative(records) }) });
  const f = await queue.figure();
  assert.equal(f.waiting, 2, 'CS-c and the reassessed CS-d wait for the reviewer');
  assert.deepEqual(f.waitingSince, [ago(380), ago(20)]);
  assert.deepEqual(f.awaitingAuthor, { waiting: 3, oldestSince: ago(400), deadlinePassed: 1, nextDeadlineHeight: '129630' });
  assert.match(f.note, /^2 submissions wait for the reviewer, the oldest since/);
  assert.match(f.note, /Apart from these, 3 answers wait for their authors to add evidence the reviewer asked for, before a deadline; those are not waiting for the reviewer\.$/);
});

test('the queue built on the real readers counts only submissions under review and stops reading decided ones', async () => {
  const now = Date.now(), ago = (m) => new Date(now - m * 60000).toISOString();
  const intents = { a: intent('CS-a', ago(50)), b: intent('CS-b', ago(30)), c: intent('CS-c', ago(10)), old: intent('CS-old', ago(300)) };
  const records = { 'central_submission/CS-a': { state: 'under_review' }, 'central_submission/CS-b': { state: 'rejected' }, 'central_submission/CS-c': { state: 'under_review' } };
  const calls = [];
  let clock = now;
  const queue = createReviewQueue({ centralEarning: createCentralEarningService({ store: { read: () => ({ centralEarningIntents: intents }) }, native: fakeNative(records, calls) }), clock: () => clock });
  const first = await queue.figure();
  assert.equal(first.status, 'available'); assert.equal(first.waiting, 2); assert.equal(first.oldestSince, ago(50));
  assert.deepEqual(first.limits, { perHour: 16, perDay: 128, window: 'clock hour, UTC' });
  assert.match(first.note, /^2 submissions wait for the reviewer, the oldest since \d\d:\d\d UTC/);
  assert.doesNotMatch(first.note, /within|minutes\b/, 'no time is promised');
  assert.equal(calls.length, 1);
  // Within a minute the kept answer is served without a read.
  assert.equal(await queue.figure(), first); assert.equal(calls.length, 1);
  // Later, the decided submission and the five-hour-old unrecorded send are not read again.
  clock = now + 61_000; await queue.figure(); await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], ['central_submission/CS-c', 'central_submission/CS-a']);
});

async function server(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'baink-review-queue-'));
  const app = await createBainkServer({ dataDir: join(dir, 'data'), publicOrigin: 'https://baink.example', projectsSource: null, catalogueDir: null, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.server.closeAllConnections?.(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${app.server.address().port}`;
}
const fixed = (value) => {
  let figures = 0;
  return { limits: value.limits, figures: () => figures, async figure() { figures++; return value; }, peek: () => value };
};
const FIGURE = { status: 'available', waiting: 3, oldestSince: '2026-11-10T09:00:00.000Z', waitingSince: ['2026-11-10T09:00:00.000Z', '2026-11-10T09:10:00.000Z', '2026-11-10T09:20:00.000Z'], limits: { perHour: 16, perDay: 128, window: 'clock hour, UTC' }, asOf: '2026-11-10T09:30:00.000Z', note: '3 submissions wait for a decision.' };

test('GET /api/public/review-queue is public, unsigned and readable from uain.global', async (t) => {
  const queue = fixed(FIGURE), base = await server(t, { reviewQueue: queue });
  const host = { Host: 'baink.example' };
  const plain = await fetch(base + '/api/public/review-queue', { headers: host });
  assert.equal(plain.status, 200); assert.deepEqual(await plain.json(), FIGURE);
  assert.equal(plain.headers.get('access-control-allow-origin'), '*');
  // A browser on uain.global sends its own Origin and Sec-Fetch-Site: cross-site; both pass on this route only.
  const cross = await fetch(base + '/api/public/review-queue', { headers: { ...host, Origin: 'https://uain.global', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 200); assert.equal(cross.headers.get('access-control-allow-origin'), '*');
  const preflight = await fetch(base + '/api/public/review-queue', { method: 'OPTIONS', headers: { ...host, Origin: 'https://uain.global', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  // Every other API route still refuses a foreign origin.
  for (const path of ['/api/public/tasks', '/api/config']) {
    const other = await fetch(base + path, { headers: { ...host, Origin: 'https://uain.global' } });
    assert.equal(other.status, 403, path); assert.equal(other.headers.get('access-control-allow-origin'), null);
  }
  // No query fields; a write is not this route.
  assert.equal((await fetch(base + '/api/public/review-queue?wait=1', { headers: host })).status, 400);
  assert.notEqual((await fetch(base + '/api/public/review-queue', { method: 'POST', headers: { ...host, Origin: 'https://uain.global', 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
});

test('without a native reader the route answers at once and says the queue could not be read, with the cap', async (t) => {
  const base = await server(t, {});
  const res = await fetch(base + '/api/public/review-queue', { headers: { Host: 'baink.example' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(['available', 'unavailable'].includes(body.status));
  assert.deepEqual(body.limits, { perHour: 16, perDay: 128, window: 'clock hour, UTC' });
  assert.match(body.note, /at most 16 reviews in each clock hour \(UTC\) and 128 a day/);
});

test("baink_guide's review answer carries the kept queue figure and never waits for one", async (t) => {
  // node:http, because fetch does not send a Host header and the MCP checks it.
  const mcp = (base, question) => new Promise((resolve, reject) => {
    const req = httpRequest(base + '/mcp', { method: 'POST', headers: { Host: 'baink.example', Origin: 'https://baink.example', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString()).result.structuredContent); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'baink_guide', arguments: { question } } }));
  });
  const queue = fixed(FIGURE), base = await server(t, { reviewQueue: queue });
  const review = await mcp(base, 'My review is taking long. Is it delayed?');
  assert.equal(review.topic, 'review');
  assert.deepEqual(review.reviewQueue, { note: FIGURE.note, waiting: 3, oldestSince: FIGURE.oldestSince, limits: FIGURE.limits, asOf: FIGURE.asOf });
  assert.equal(queue.figures(), 0, 'the guide only peeks at a kept answer');
  const other = await mcp(base, 'how do I back up my key?');
  assert.equal(other.reviewQueue, undefined);
  // Nothing kept yet: the answer comes without the field.
  const empty = await server(t, { reviewQueue: { limits: FIGURE.limits, figure: async () => FIGURE, peek: () => null } });
  assert.equal((await mcp(empty, 'My review is taking long. Is it delayed?')).reviewQueue, undefined);
});
