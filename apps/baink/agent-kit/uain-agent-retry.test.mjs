// Kit 0.2.18 (12 November 2026): BAINK's requested wait (Retry-After) is honoured, within bounds and
// with one plain line to the person, for 429 rate_limited and for proof refusals on reads; a write
// refused for a proof is never resent; every final refusal (trade_paused and the other 4xx) is never
// retried. FIXTURE: a fake BAINK answering in order, and an injected sleep that records each wait.
import test from 'node:test';
import assert from 'node:assert/strict';

let fresh = 0;
/** A separate copy of the kit, so the one-minute proof pause of one test never leaks into another. */
const kit = () => import(`./uain-agent.mjs?retry-test=${++fresh}`);

function bainkAnswering(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname + new URL(url).search, method: init.method });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, json: async () => a.body };
  };
  return { fetch, calls };
}
const refusal = (status, code, { retryAfter, next, bodyWait } = {}) => ({
  status,
  headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
  body: { error: { code, message: `refused: ${code}`, ...(next ? { next } : {}), ...(bodyWait === undefined ? {} : { retryAfterSeconds: bodyWait }) } },
});
const OK = { status: 200, body: { ok: true } };
function options(baink) {
  const slept = [], said = [];
  return { o: { url: 'https://baink.example', fetch: baink.fetch, sleep: async (ms) => { slept.push(ms); }, notice: (line) => said.push(line) }, slept, said };
}

test('the bounds are 30 seconds a wait and 60 seconds a call', async () => {
  const { RETRY_WAIT_CAP_MS, RETRY_WAIT_BUDGET_MS } = await kit();
  assert.equal(RETRY_WAIT_CAP_MS, 30_000);
  assert.equal(RETRY_WAIT_BUDGET_MS, 60_000);
});

for (const method of ['GET', 'POST']) {
  test(`429 rate_limited on a ${method}: waits what BAINK asks, says so, then succeeds`, async () => {
    const { api } = await kit();
    const baink = bainkAnswering([refusal(429, 'rate_limited', { retryAfter: 13, next: 'Wait 13 seconds, then try again.' }), OK]);
    const { o, slept, said } = options(baink);
    assert.deepEqual(await api(o, method, '/api/native/central/status', method === 'GET' ? undefined : {}), { ok: true });
    assert.deepEqual(slept, [13_000]);
    assert.equal(baink.calls.length, 2);
    assert.equal(said.length, 1);
    assert.match(said[0], /^BAINK asked this agent to wait 13 seconds \(BAINK is pacing requests from this key\)\. Waiting, then trying once more; nothing is sent twice\.$/);
  });
}

test('429 rate_limited: the body\'s retryAfterSeconds counts when there is no header; no hint waits 10 seconds', async () => {
  const { api } = await kit();
  const a = options(bainkAnswering([refusal(429, 'rate_limited', { bodyWait: 4.2 }), OK]));
  await api(a.o, 'GET', '/api/account');
  assert.deepEqual(a.slept, [5_000]);
  const b = options(bainkAnswering([refusal(429, 'rate_limited'), OK]));
  await api(b.o, 'GET', '/api/account');
  assert.deepEqual(b.slept, [10_000]);
});

test('429 rate_limited: at most two waits, then the refusal with the wait in plain words', async () => {
  const { api } = await kit();
  const baink = bainkAnswering([refusal(429, 'rate_limited', { retryAfter: 2 })]);
  const { o, slept } = options(baink);
  await assert.rejects(api(o, 'POST', '/api/native/central/prepare', {}), (e) => {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.retryAfterSeconds, 2);
    assert.equal(e.next, 'BAINK asked to wait 2 seconds before trying again.');
    return true;
  });
  assert.deepEqual(slept, [2_000, 2_000]);
  assert.equal(baink.calls.length, 3);
});

test('429 rate_limited: a wait over 30 seconds, or past the 60-second budget, is said, not slept', async () => {
  const { api } = await kit();
  const long = bainkAnswering([refusal(429, 'rate_limited', { retryAfter: 45, next: 'You reached the request limit for now. Wait 45 seconds, then try again.' }), OK]);
  const a = options(long);
  await assert.rejects(api(a.o, 'GET', '/api/account'), (e) => e.code === 'rate_limited' && e.retryAfterSeconds === 45 && /Wait 45 seconds/.test(e.next));
  assert.deepEqual(a.slept, []);
  assert.equal(long.calls.length, 1);
  const budget = bainkAnswering([refusal(429, 'rate_limited', { retryAfter: 30 }), refusal(429, 'rate_limited', { retryAfter: 30 }), refusal(429, 'rate_limited', { retryAfter: 1 }), OK]);
  const b = options(budget);
  await assert.rejects(api(b.o, 'GET', '/api/account'), (e) => e.code === 'rate_limited');
  assert.deepEqual(b.slept, [30_000, 30_000], 'two waits fill the budget');
});

for (const code of ['central_proof_unavailable', 'native_proof_unavailable']) {
  test(`503 ${code} on a read: waits what BAINK asks once, then reads again`, async () => {
    const { api } = await kit();
    const baink = bainkAnswering([refusal(503, code, { retryAfter: 30 }), OK]);
    const { o, slept, said } = options(baink);
    assert.deepEqual(await api(o, 'GET', '/api/native/central/status'), { ok: true });
    assert.deepEqual(slept, [30_000]);
    assert.match(said[0], /wait 30 seconds \(the network could not prove its current state just now\)/);
  });
  test(`503 ${code} on a write: never resent, and the wait is passed on`, async () => {
    const { api } = await kit();
    const baink = bainkAnswering([refusal(503, code, { retryAfter: 30 }), OK]);
    const { o, slept } = options(baink);
    await assert.rejects(api(o, 'POST', '/api/native/central/intents/x/submit', {}), (e) => {
      assert.equal(e.code, code);
      assert.equal(e.retryAfterSeconds, 30);
      assert.equal(e.next, undefined, 'the kit\'s own hint (the receipt check) applies');
      return true;
    });
    assert.deepEqual(slept, []);
    assert.equal(baink.calls.length, 1);
  });
}

test('a proof refusal on a read with no hint waits 1.5 seconds as before; a second refusal pauses retries for a minute', async () => {
  const { api } = await kit();
  const baink = bainkAnswering([refusal(503, 'central_proof_unavailable')]);
  const { o, slept, said } = options(baink);
  await assert.rejects(api(o, 'GET', '/api/native/central/status'), (e) => e.code === 'central_proof_unavailable');
  assert.deepEqual(slept, [1500]);
  assert.deepEqual(said, [], 'no line for a short blip');
  await assert.rejects(api(o, 'GET', '/api/native/central/status'), (e) => e.code === 'central_proof_unavailable');
  assert.deepEqual(slept, [1500], 'paused: answered at once');
});

test('a bounded read never waits past its deadline', async () => {
  const { api } = await kit();
  const baink = bainkAnswering([refusal(503, 'central_proof_unavailable', { retryAfter: 30 }), OK]);
  const { o, slept } = options(baink);
  await assert.rejects(api(o, 'GET', '/api/native/central/awards', undefined, undefined, { deadline: Date.now() + 10_000 }), (e) => e.code === 'central_proof_unavailable');
  assert.deepEqual(slept, []);
});

// Final refusals: never retried, whatever Retry-After says.
for (const [status, code] of [
  [409, 'trade_paused'],
  [409, 'payment_request_locked'],
  [409, 'replay_detected'],
  [400, 'invalid_query'],
  [401, 'invalid_signature'],
  [403, 'forbidden'],
  [404, 'request_missing'],
  [429, 'member_nonce_limit'],
  [429, 'send_daily_limit'],
  [429, 'capacity'],
  [503, 'server_send_unavailable'],
]) {
  test(`${status} ${code} is never retried`, async () => {
    const { api } = await kit();
    const baink = bainkAnswering([refusal(status, code, { retryAfter: 1, next: 'The server says what to do.' }), OK]);
    const { o, slept, said } = options(baink);
    await assert.rejects(api(o, 'POST', '/api/trade/offers', {}), (e) => e.code === code && e.next === 'The server says what to do.');
    assert.equal(baink.calls.length, 1);
    assert.deepEqual(slept, []);
    assert.deepEqual(said, []);
  });
}

test('503 busy and 429 client_busy keep their own retries', async () => {
  const { api } = await kit();
  for (const [status, code] of [[503, 'busy'], [429, 'client_busy']]) {
    const baink = bainkAnswering([refusal(status, code, { retryAfter: 0 }), OK]);
    const { o, said } = options(baink);
    assert.deepEqual(await api(o, 'POST', '/api/account', {}), { ok: true });
    assert.equal(baink.calls.length, 2, code);
    assert.deepEqual(said, []);
  }
});
