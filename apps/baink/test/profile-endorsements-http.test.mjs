import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
const form = {
  displayName: 'Synthetic peer',
  summary: 'A local test profile',
  capabilities: [],
  services: [],
  languages: [],
  availability: 'open',
  website: '',
  publish: true,
  expectedVersion: 0,
};
async function setup(t) {
  const f = await fixture(t),
    alice = member(),
    bob = member(),
    carol = member();
  for (const who of [alice, bob, carol])
    assert.equal(
      (await f.request(who, 'POST', '/api/account', { displayName: 'QA' }))
        .status,
      201,
    );
  assert.equal(
    (await f.request(bob, 'PATCH', '/api/profile', form)).status,
    200,
  );
  return {
    f,
    alice,
    bob,
    carol,
    path: '/api/profiles/' + bob.address + '/endorsements',
  };
}
const body = {
  clientRequestId: 'http-upvote-test-01',
  profileVersion: 1,
  publish: true,
};
test('public current-profile upvote list and signed add/own/withdraw survive restart', async (t) => {
  const { f, alice, bob, path } = await setup(t);
  let r = await f.request(null, 'GET', path);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 0);
  assert.equal(r.body.subject.profileVersion, 1);
  assert.equal((await f.request(null, 'POST', path, body)).status, 401);
  r = await f.request(alice, 'POST', path, body);
  assert.equal(r.status, 201);
  const id = r.body.endorsement.id;
  assert.equal(r.body.endorsement.author, alice.address);
  assert.equal((await f.request(alice, 'POST', path, body)).status, 200);
  await f.restart();
  r = await f.request(
    alice,
    'GET',
    `/api/profile/endorsements?target=${bob.address}&profileVersion=1`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.endorsement.id, id);
  r = await f.request(null, 'GET', path);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.provenance.establishesTrust, false);
  assert.equal(JSON.stringify(r.body).includes('clientRequestId'), false);
  assert.equal(JSON.stringify(r.body).includes('publicKey'), false);
  r = await f.request(
    alice,
    'POST',
    `/api/profile/endorsements/${id}/withdraw`,
    {},
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.endorsement.active, false);
  assert.equal((await f.request(null, 'GET', path)).body.count, 0);
  assert.equal(
    (await f.request(alice, 'POST', path, body)).body.endorsement.active,
    false,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', path, {
        ...body,
        clientRequestId: 'http-upvote-explicit-new',
      })
    ).status,
    201,
  );
});
test('upvote HTTP denies self/extra authority/badqueries/crossholder and binds currentversion', async (t) => {
  const { f, alice, bob, carol, path } = await setup(t);
  assert.equal((await f.request(bob, 'POST', path, body)).status, 400);
  assert.equal(
    (await f.request(alice, 'POST', path, { ...body, author: carol.address }))
      .status,
    400,
  );
  assert.equal(
    (await f.request(alice, 'POST', path, { ...body, profileVersion: 2 }))
      .status,
    409,
  );
  assert.equal(
    (await f.request(null, 'GET', path + '?author=' + alice.address)).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        alice,
        'GET',
        `/api/profile/endorsements?target=${bob.address}&profileVersion=1&owner=${carol.address}`,
      )
    ).status,
    400,
  );
  const r = await f.request(alice, 'POST', path, body);
  assert.equal(r.status, 201);
  const id = r.body.endorsement.id;
  assert.equal(
    (
      await f.request(
        carol,
        'POST',
        `/api/profile/endorsements/${id}/withdraw`,
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(bob, 'PATCH', '/api/profile', {
        ...form,
        summary: 'Changed published revision',
        expectedVersion: 1,
      })
    ).status,
    200,
  );
  assert.equal((await f.request(null, 'GET', path)).body.count, 0);
  assert.equal(
    (
      await f.request(
        alice,
        'GET',
        `/api/profile/endorsements?target=${bob.address}&profileVersion=1`,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(bob, 'PATCH', '/api/profile', {
        publish: false,
        expectedVersion: 2,
      })
    ).status,
    200,
  );
  assert.equal((await f.request(null, 'GET', path)).status, 404);
  assert.equal(
    (
      await f.request(
        alice,
        'POST',
        `/api/profile/endorsements/${id}/withdraw`,
        {},
      )
    ).status,
    200,
  );
});
