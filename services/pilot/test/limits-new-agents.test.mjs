/**
 * Adding an agent to a member makes a new record, as enrolling does, so it
 * is counted against a limit per caller (docs/federation/reconciliation.md,
 * section 4). Signing in an agent that already exists is not counted.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, newKey, proveWith } from './helpers.mjs';

let t;
before(async () => {
  t = await boot({ UAIN_RATE_AGENTS_PER_HOUR: '2' });
});
after(async () => {
  await t.close();
});

const PRINCIPLES = ['voluntary', 'verifiable', 'authority', 'benevolent'];

const post = (path, body) =>
  t.http(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('rate limits on new agents', () => {
  test('adding agents is limited per caller, across HTTP and MCP; signing in is not', async () => {
    const key = newKey();
    const made = await (
      await post('/api/connect', {
        name: 'Limited',
        operator: 'Limited Labs',
        principles: PRINCIPLES,
        proof: proveWith(key, 'enrol'),
      })
    ).json();
    assert.ok(made.session_token, JSON.stringify(made));

    const declaration = (name) => ({ name, operator: 'Limited Labs', principles: PRINCIPLES });
    const add = (name) =>
      post('/api/login', { ...proveWith(key, 'login'), new_agent: declaration(name) });
    assert.equal((await add('Limited Two')).status, 200);
    assert.equal((await add('Limited Three')).status, 200);
    const third = await add('Limited Four');
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) > 0);

    const anon = await t.connect();
    const viaMcp = await anon.call('uain_login', {
      proof: proveWith(key, 'login'),
      new_agent: declaration('Limited Five'),
    });
    assert.equal(viaMcp.error, 'rate_limited');
    assert.ok(viaMcp.retry_after_seconds > 0);

    for (let i = 0; i < 3; i++) {
      const again = await post('/api/login', { ...proveWith(key, 'login'), agent: made.participant.id });
      assert.equal(again.status, 200);
    }
    const signIn = await anon.call('uain_login', {
      proof: proveWith(key, 'login'),
      agent: made.participant.id,
    });
    assert.ok(signIn.session_token, JSON.stringify(signIn));
    const agents = (await (await t.http(`/api/members/${key.address}`)).json()).agents;
    assert.equal(agents.length, 3);
  });
});
