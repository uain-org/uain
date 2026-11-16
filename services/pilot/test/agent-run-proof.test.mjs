import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { keySignedAgentRun, verifiedPublicAgentRun } from '../src/application/agent-run-proof.ts';
import { publishAgentRun, signAgentRun } from '../../../public/worker/uain-key.mjs';
import { boot, newKey } from './helpers.mjs';

const secret = 'local-test-shared-secret-with-32-characters';
const payload = {
  source: 'synapse',
  participant_id: 'synapse-researcher',
  external_id: '01234567-89ab-4cde-8123-456789abcdef',
  topic: 'Open research on ageing interventions',
  status: 'running',
  public_url: null,
  consent_at: new Date(Date.now() - 60_000).toISOString(),
};
const sign = (value) => ({
  payload: value,
  signature: createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex'),
});

test('rejects an unsigned or forged private-topic submission', () => {
  assert.equal(verifiedPublicAgentRun(payload, secret).error, 'invalid_signature');
  assert.equal(verifiedPublicAgentRun({ ...sign(payload), signature: '0'.repeat(64) }, secret).error, 'invalid_signature');
  assert.equal(verifiedPublicAgentRun(sign(payload), '').error, 'integration_disabled');
});

test('accepts signed public consent and refuses content changed after signing', () => {
  assert.deepEqual(verifiedPublicAgentRun(sign(payload), secret).payload, payload);
  const changed = sign(payload);
  changed.payload = { ...payload, topic: 'Private research topic' };
  assert.equal(verifiedPublicAgentRun(changed, secret).error, 'invalid_signature');
  const redirected = sign(payload);
  redirected.payload = { ...payload, participant_id: 'another-agent' };
  assert.equal(verifiedPublicAgentRun(redirected, secret).error, 'invalid_signature');
});

test('refuses absent consent and unsafe public URLs even with a valid signature', () => {
  const noConsent = { ...payload, consent_at: undefined };
  assert.equal(verifiedPublicAgentRun(sign(noConsent), secret).error, 'invalid_consent_at');
  const unsafeUrl = { ...payload, public_url: 'javascript:alert(1)' };
  assert.equal(verifiedPublicAgentRun(sign(unsafeUrl), secret).error, 'invalid_public_url');
});

/* ------------------------------------------------ signed with the member key */


const AUDIENCE = 'https://uain.global';
const keyed = (source = 'neuroetch', over = {}) => ({ ...payload, source, participant_id: 'neuroetch', ...over });

describe('a run signed with the member key', () => {
  const key = newKey();
  const member = { address: key.address, public_key: key.public_key };

  test('is accepted from any system that names itself, with no shared secret', () => {
    for (const source of ['neuroetch', 'enlightenment', 'synapse']) {
      const run = keyed(source);
      assert.deepEqual(keySignedAgentRun(signAgentRun(key, run, AUDIENCE), member, AUDIENCE).payload, run);
    }
  });

  test('is refused when signed by another key, for another server, or changed after signing', () => {
    const other = newKey();
    assert.equal(keySignedAgentRun(signAgentRun(other, keyed(), AUDIENCE), member, AUDIENCE).error, 'invalid_signature');
    assert.equal(
      keySignedAgentRun(signAgentRun(key, keyed(), 'https://look-alike.example'), member, AUDIENCE).error,
      'invalid_signature',
    );
    const changed = signAgentRun(key, keyed(), AUDIENCE);
    changed.payload = { ...changed.payload, topic: 'Something the owner never published' };
    assert.equal(keySignedAgentRun(changed, member, AUDIENCE).error, 'invalid_signature');
  });

  test('checks the fields as a shared-secret run does, and needs the member key', () => {
    assert.equal(keySignedAgentRun(signAgentRun(key, keyed('Not A Slug'), AUDIENCE), member, AUDIENCE).error, 'unsupported_source');
    assert.equal(
      keySignedAgentRun(signAgentRun(key, keyed('neuroetch', { consent_at: undefined }), AUDIENCE), member, AUDIENCE).error,
      'invalid_consent_at',
    );
    assert.equal(keySignedAgentRun(signAgentRun(key, keyed(), AUDIENCE), { ...member, public_key: null }, AUDIENCE).error, 'member_key_required');
    assert.equal(keySignedAgentRun({ payload: keyed() }, member, AUDIENCE).error, 'invalid_signature');
  });

  test('a shared-secret envelope still names only synapse', () => {
    assert.equal(verifiedPublicAgentRun(sign(keyed('neuroetch')), secret).error, 'unsupported_source');
  });
});

describe('POST /api/agent-runs with the member key', () => {
  let t;
  before(async () => {
    t = await boot();
  });
  after(async () => {
    await t.close();
  });

  test('records the run for the signing member, once, and shows it publicly', async () => {
    const sys = await t.member('NeuroEtch Lab', 'neuroetch-publisher', { uain: false });
    const run = { ...keyed(), participant_id: sys.id };
    const first = await publishAgentRun(t.base, sys.token, sys.key, run);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.changed, true);
    const again = await publishAgentRun(t.base, sys.token, sys.key, run);
    assert.equal(again.body.changed, false);
    const listed = await (await t.http(`/api/agent-runs?participant=${sys.id}`)).json();
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].source, 'neuroetch');
  });

  test("refuses another member's key, another agent's id and an unsigned body", async () => {
    const a = await t.member('Lab A', 'publisher-a', { uain: false });
    const b = await t.member('Lab B', 'publisher-b', { uain: false });
    const run = { ...keyed(), participant_id: a.id };
    const forged = await publishAgentRun(t.base, a.token, b.key, run);
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error, 'invalid_signature');
    const wrongAgent = await publishAgentRun(t.base, a.token, a.key, { ...run, participant_id: b.id });
    assert.equal(wrongAgent.body.error, 'participant_mismatch');
    const bare = await t.http('/api/agent-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ payload: run }),
    });
    assert.equal(bare.status, 400);
    const anonymous = await t.http('/api/agent-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signAgentRun(a.key, run, t.base)),
    });
    assert.equal(anonymous.status, 401);
  });
});
