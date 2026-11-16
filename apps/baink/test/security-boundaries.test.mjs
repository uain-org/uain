import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member, signed } from './http-fixture.mjs';

test('round 1: valid signatures cannot be moved across queries, bodies, audiences or time windows', async (t) => {
  const f = await fixture(t), alice = member();
  assert.equal((await f.request(alice, 'POST', '/api/account', { displayName: 'Alice' })).status, 201);
  const headers = signed(alice, 'GET', '/api/history?page=1');
  assert.equal((await f.request(alice, 'GET', '/api/history?page=2', {}, headers)).status, 401);
  for (const overrides of [
    { audience: 'https://attacker.example' },
    { timestamp: String(Date.now() - 600_000) },
    { timestamp: String(Date.now() + 600_000) },
  ]) {
    const forged = signed(alice, 'GET', '/api/account', {}, overrides);
    assert.equal((await f.request(alice, 'GET', '/api/account', {}, forged)).status, 401);
  }
  assert.equal((await f.request(alice, 'PATCH', '/api/account', { displayName: 'Altered' }, signed(alice, 'PATCH', '/api/account', { displayName: 'Reviewed' }))).status, 401);
  assert.equal((await f.request(alice, 'GET', '/api/account')).body.account.displayName, 'Alice');
});

test('round 1: simultaneous valid replays commit once and stay consumed after restart', async (t) => {
  const f = await fixture(t), alice = member();
  await f.request(alice, 'POST', '/api/account', { displayName: 'Alice' });
  const headers = signed(alice, 'GET', '/api/account');
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.request(alice, 'GET', '/api/account', {}, headers)));
  assert.deepEqual(replies.map(r => r.status).sort((a, b) => a - b), [200, 409, 409, 409, 409, 409, 409, 409]);
  await f.restart();
  assert.equal((await f.request(alice, 'GET', '/api/account', {}, headers)).body.error.code, 'replay_detected');
});

test('round 2: unpublished drafts never enter public discovery and another holder cannot select them', async (t) => {
  const f = await fixture(t), alice = member(), bob = member();
  for (const who of [alice, bob]) await f.request(who, 'POST', '/api/account', { displayName: 'Private account' });
  const secret = 'PRIVATE-DRAFT-SECURITY-CANARY';
  const draft = { displayName: 'Alice draft', summary: secret, capabilities: [], services: [], languages: [], availability: 'open', website: '', publish: false, expectedVersion: 0 };
  assert.equal((await f.request(alice, 'PATCH', '/api/profile', draft)).status, 200);
  for (const path of ['/api/profiles', `/api/profiles/${alice.address}`, `/api/profiles?search=${secret}`, `/api/profiles/${alice.address}/endorsements`]) {
    const response = await f.request(null, 'GET', path);
    assert.ok([200, 404].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!JSON.stringify(response.body).includes(secret));
  }
  assert.equal((await f.request(null, 'GET', '/api/profile')).status, 401);
  const other = await f.request(bob, 'GET', '/api/profile');
  assert.equal(other.body.profile, null);
  assert.equal((await f.request(bob, 'PATCH', '/api/profile', { ...draft, address: alice.address })).status, 400);
  await f.restart();
  assert.equal((await f.request(alice, 'GET', '/api/profile')).body.profile.summary, secret);
  assert.equal((await f.request(null, 'GET', `/api/profiles/${alice.address}`)).status, 404);
});
