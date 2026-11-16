import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, keyed } from './helpers.mjs';

let t;
before(async () => {
  t = await boot({
    UAIN_RATE_ENROLMENTS_PER_HOUR: '2',
    UAIN_RATE_REQUESTS_PER_MIN: '40',
  });
});
after(async () => {
  await t.close();
});

const enrolBody = (name) =>
  JSON.stringify({
    name,
    operator: 'Rate Operator',
    authority: 'Lead',
    principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
    proof: keyed().proof,
  });

describe('rate limits', () => {
  test('enrolment is limited per caller, across HTTP and MCP', async () => {
    const post = (name) =>
      t.http('/api/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: enrolBody(name),
      });
    assert.equal((await post('a')).status, 201);
    assert.equal((await post('b')).status, 201);
    const third = await post('c');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);

    const anon = await t.connect();
    const viaMcp = await anon.call('uain_enrol', {
      name: 'd',
      operator: 'Rate Operator',
      authority: 'Lead',
      principles: ['voluntary', 'verifiable', 'authority', 'benevolent'],
      proof: keyed().proof,
    });
    assert.equal(viaMcp.error, 'rate_limited');
  });

  test('requests are limited per caller, and health is exempt', async () => {
    let limited = null;
    for (let i = 0; i < 60 && !limited; i++) {
      const r = await t.http('/api/stats');
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'expected a 429 within 60 requests');
    assert.equal((await t.http('/api/health')).status, 200);
  });
});

describe('client address behind proxies', () => {
  test('reads the entry the trusted proxies wrote, not the client’s own', async () => {
    const { clientAddress } = await import('../dist/src/api/server.js');
    // client -> front door -> nginx -> pilot: the client can write anything
    // on the left, so only the second entry from the right is trustworthy.
    assert.equal(clientAddress('6.6.6.6, 1.2.3.4, 172.18.0.2', '172.18.0.3', 2), '1.2.3.4');
    assert.equal(clientAddress('1.2.3.4, 172.18.0.2', '172.18.0.3', 2), '1.2.3.4');
    assert.equal(clientAddress('', '10.0.0.9', 2), '10.0.0.9');
    assert.equal(clientAddress('6.6.6.6', '10.0.0.9', 0), '10.0.0.9');
  });
});
