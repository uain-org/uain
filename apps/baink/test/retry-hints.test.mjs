// Retry hints on every 429 and 503 refusal (P1-2, 11 November 2026). The limits
// are unchanged; each refusal now says how long to wait, in the Retry-After
// header, error.retryAfterSeconds and a plain error.next sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBainkServer } from '../server/app.mjs';
import { retryHint, withRetryHint } from '../server/http-errors.mjs';
import { fixture, member } from './http-fixture.mjs';

test('retryHint covers only 429 and 503, rounds up and stays between 1 second and 1 hour', () => {
  for (const status of [400, 401, 404, 409, 500]) assert.equal(retryHint(status, 'rate_limited', 5), null);
  assert.deepEqual(retryHint(429, 'rate_limited', 12.2), { retryAfterSeconds: 13, next: 'You reached the request limit for now. Wait 13 seconds, then try again.' });
  assert.equal(retryHint(503, 'busy').retryAfterSeconds, 5);
  assert.equal(retryHint(429, 'client_busy').retryAfterSeconds, 2);
  assert.equal(retryHint(429, 'unknown_code').retryAfterSeconds, 10);
  assert.equal(retryHint(503, 'unknown_code').retryAfterSeconds, 30);
  assert.equal(retryHint(429, 'rate_limited', -4).retryAfterSeconds, 1, 'an elapsed window still waits one second');
  assert.equal(retryHint(429, 'rate_limited', 1e9).retryAfterSeconds, 3600);
  assert.match(retryHint(503, 'unknown_code').next, /Wait 30 seconds/);
});

test('withRetryHint keeps code and message, adds the hint and sets a matching Retry-After', () => {
  const headers = {}, res = { headersSent: false, setHeader: (k, v) => { headers[k] = v; } };
  const body = withRetryHint(res, 503, { error: { code: 'busy', message: 'The service is busy.' } });
  assert.deepEqual(body, { error: { code: 'busy', message: 'The service is busy.', retryAfterSeconds: 5, next: 'BAINK is busy. Wait 5 seconds, then try again.' } });
  assert.equal(headers['Retry-After'], '5');
  const plain = { error: { code: 'not_found', message: 'x' } };
  assert.equal(withRetryHint(res, 404, plain), plain);
});

test('an unknown key over its 12-a-minute budget learns the exact time left in the window', async (t) => {
  const f = await fixture(t), who = member();
  for (let i = 0; i < 12; i++) assert.equal((await f.request(who, 'GET', '/api/account')).status, 404);
  const limited = await f.request(who, 'GET', '/api/account');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  const wait = limited.body.error.retryAfterSeconds;
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 60, `wait ${wait} lies inside the one-minute window`);
  assert.equal(limited.headers.get('retry-after'), String(wait));
  assert.equal(limited.body.error.next, `You reached the request limit for now. Wait ${wait} seconds, then try again.`);
});

test('the 16-per-client concurrency refusal carries Retry-After and a next step', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'baink-retry-hints-'));
  const app = await createBainkServer({ dataDir: dir, publicOrigin: 'https://baink.example', projectsSource: null, catalogueDir: null });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, sockets = [];
  t.after(async () => { for (const s of sockets) s.destroy(); app.server.closeAllConnections(); await app.close(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 16; i++) {
    const received = once(app.server, 'request');
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write('POST /api/account HTTP/1.1\r\nHost: baink.example\r\nContent-Type: application/json\r\nContent-Length: 16000\r\n\r\n{');
    await received;
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '2');
  assert.deepEqual(body.error, { code: 'client_busy', message: 'Too many concurrent requests. Retry shortly.', retryAfterSeconds: 2, next: 'Too many of your requests are still running. Wait 2 seconds, then send one again.' });
});
