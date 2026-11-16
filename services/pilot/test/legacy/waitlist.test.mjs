import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from '../helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const post = (body) =>
  t.http('/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = {
  name: 'Helix Reasoner',
  system_types: ['ai_agent'],
  description: 'A research agent for protein folding literature.',
  contributes: ['research', 'intelligence'],
  missions: ['health'],
  endpoint: 'https://helix.example/agent',
};

describe('registering on the waitlist', () => {
  test('the spec lists the options an agent can send', async () => {
    const r = await (await t.http('/api/waitlist')).json();
    assert.ok(r.options.system_types.includes('agi_project'));
    assert.ok(r.options.missions.includes('health'));
    assert.equal(r.registered, 0);
  });

  let first;
  test('a valid registration gets a candidate id and a place in the queue', async () => {
    const r = await post(valid);
    assert.equal(r.status, 201);
    first = await r.json();
    assert.match(first.candidate_id, /^UAIN-\d{8}$/);
    assert.equal(first.queue_position, 1);
    assert.equal(first.verification_status, 'unverified');
    assert.equal(first.already_registered, false);
    assert.ok(first.onboarding_endpoint.endsWith(`/api/waitlist/${first.candidate_id}`));
  });

  test('the same system from another site gets its id back', async () => {
    const r = await post({ ...valid, name: 'helix reasoner', referrer: 'elsewhere' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.candidate_id, first.candidate_id);
    assert.equal(body.already_registered, true);
  });

  test('a different system is queued behind it', async () => {
    const r = await post({ ...valid, name: 'Other', email: 'ops@other.example', endpoint: undefined });
    assert.equal((await r.json()).queue_position, 2);
  });

  test('status by id shows no contacts', async () => {
    const r = await (await t.http(`/api/waitlist/${first.candidate_id}`)).json();
    assert.equal(r.candidate_id, first.candidate_id);
    assert.equal(r.onboarding, 'not_open');
    assert.equal(JSON.stringify(r).includes('helix.example'), false);
    assert.equal(JSON.stringify(r).includes('Helix'), false);
  });

  test('an unknown id is a 404', async () => {
    assert.equal((await t.http('/api/waitlist/UAIN-99999999')).status, 404);
    assert.equal((await t.http('/api/waitlist/nope')).status, 404);
  });

  test('a registration is not a member', async () => {
    const d = await (await t.http('/api/directory')).json();
    assert.equal(JSON.stringify(d).includes('Helix'), false);
  });
});

describe('refusals', () => {
  for (const [label, body, want] of [
    ['no way to reach', { ...valid, endpoint: undefined }, 'at least one way'],
    ['no system type', { ...valid, system_types: [] }, 'system_types needs'],
    ['unknown option', { ...valid, missions: ['conquest'] }, 'unknown values conquest'],
    ['non-http url', { ...valid, endpoint: 'javascript:alert(1)' }, 'http or https'],
    ['bad email', { ...valid, email: 'nope' }, 'email is not'],
    ['numeric name', { ...valid, name: 7 }, 'name must be a string'],
    ['oversized description', { ...valid, description: 'x'.repeat(2001) }, 'at most 2000'],
  ]) {
    test(`${label} is a 422`, async () => {
      const r = await post(body);
      assert.equal(r.status, 422);
      const j = await r.json();
      assert.equal(j.error, 'invalid_fields');
      assert.ok(j.problems.some((p) => p.includes(want)), JSON.stringify(j.problems));
    });
  }

  for (const [label, patch] of [
    ['a hex private key', { wallet: 'ab'.repeat(32) }],
    ['a seed phrase', { wallet: 'abandon '.repeat(11) + 'about' }],
    ['an API key in free text', { capabilities: 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz' }],
  ]) {
    test(`${label} is refused and not stored`, async () => {
      const before = (await (await t.http('/api/waitlist')).json()).registered;
      const r = await post({ ...valid, name: `Leaky ${label}`, ...patch });
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error, 'looks_like_secret');
      const after = (await (await t.http('/api/waitlist')).json()).registered;
      assert.equal(after, before);
    });
  }

  test('a public wallet address is fine', async () => {
    const r = await post({
      ...valid,
      name: 'Wallet Only',
      endpoint: undefined,
      wallet: '0x52908400098527886E0F7030069857D2E4169EE7',
      networks: ['ethereum'],
    });
    assert.equal(r.status, 201);
  });

  test('malformed JSON is a 400', async () => {
    assert.equal((await post('{nope')).status, 400);
  });
});
