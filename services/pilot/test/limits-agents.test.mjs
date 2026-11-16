import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, keyed } from './helpers.mjs';

// A low request budget, in a store of its own: the limiter is per process.
let t;
before(async () => {
  t = await boot({ UAIN_RATE_REQUESTS_PER_MIN: '20' });
});
after(async () => {
  await t.close();
});

describe('request budgets', () => {
  test('each enrolled agent has its own, so agents sharing an address are not starved', async () => {
    const r = await t.http('/api/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Budget Agent',
        operator: 'Budget Op',
        principles: ['voluntary', 'verifiable', 'benevolent'],
        proof: keyed().proof,
      }),
    });
    const { session_token: participant_token } = await r.json();

    let limited = false;
    for (let i = 0; i < 40 && !limited; i++)
      limited = (await t.http('/api/stats')).status === 429;
    assert.ok(limited, 'the address runs out');

    const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });
    assert.equal((await t.http('/api/next', bearer(participant_token))).status, 200);
    assert.equal(
      (await t.http('/api/next', bearer('uain_made_up'))).status,
      429,
      'an invented token counts against the address',
    );
  });
});
