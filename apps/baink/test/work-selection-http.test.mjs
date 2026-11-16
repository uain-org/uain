import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, member } from './http-fixture.mjs';

async function setup(t) {
  const source = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/projects/real-project')
      return res.end(
        JSON.stringify({
          id: 'real-project',
          title: 'Real source project',
          description: 'A source projection, not a funded bounty.',
          status: 'active',
          task_count: 0,
          authority: 'native-source-projection',
        }),
      );
    if (req.url === '/projects/real-project/tasks')
      return res.end(JSON.stringify({ tasks: [] }));
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => source.close(r)));
  return fixture(t, {
    projectsSource: `http://127.0.0.1:${source.address().port}/projects`,
  });
}

test('work selections bind reviewed source, signed owner and durable withdrawn retry over real HTTP', async (t) => {
  const f = await setup(t),
    alice = member(),
    bob = member();
  for (const who of [alice, bob])
    assert.equal(
      (
        await f.request(who, 'POST', '/api/account', {
          displayName: 'Private identity',
        })
      ).status,
      201,
    );
  const reviewed = await f.request(
    null,
    'GET',
    '/api/work/source?kind=projects&projectId=real-project',
  );
  assert.equal(reviewed.status, 200);
  assert.match(reviewed.body.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(reviewed.body.source.sourceAvailable, true);
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        '/api/work/source?kind=projects&projectId=absent-project',
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/work/selections', {
        clientRequestId: 'absent-source-123',
        kind: 'projects',
        projectId: 'absent-project',
        sourceDigest: 'a'.repeat(64),
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request(null, 'GET', '/api/work/selections')).status,
    401,
  );
  const body = {
    clientRequestId: 'http-work-selection-1',
    kind: 'projects',
    projectId: 'real-project',
    sourceDigest: reviewed.body.sourceDigest,
  };
  const stale = await f.request(alice, 'POST', '/api/work/selections', {
    ...body,
    sourceDigest: '0'.repeat(64),
  });
  assert.equal(stale.status, 409);
  const selected = await f.request(alice, 'POST', '/api/work/selections', body);
  assert.equal(selected.status, 201);
  const id = selected.body.selection.id;
  assert.equal(selected.body.selection.claim, false);
  assert.equal(selected.body.selection.settlementAvailable, false);
  assert.equal(
    (await f.request(alice, 'POST', '/api/work/selections', body)).body
      .selection.id,
    id,
  );
  assert.equal(
    (await f.request(bob, 'GET', '/api/work/selections')).body.selections
      .length,
    0,
  );
  assert.equal(
    (await f.request(bob, 'POST', `/api/work/selections/${id}/withdraw`, {}))
      .status,
    404,
  );
  assert.equal(
    (await f.request(alice, 'POST', `/api/work/selections/${id}/withdraw`, {}))
      .status,
    200,
  );
  await f.restart();
  const replay = await f.request(alice, 'POST', '/api/work/selections', body);
  assert.equal(replay.body.selection.id, id);
  assert.equal(replay.body.selection.availability, 'withdrawn');
  assert.equal(
    (await f.request(alice, 'GET', '/api/work/selections')).body.selections
      .length,
    0,
  );
  const replacement = await f.request(alice, 'POST', '/api/work/selections', {
    ...body,
    clientRequestId: 'http-work-selection-2',
  });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.selection.id, id);
  assert.equal(
    (await f.request(alice, 'GET', '/api/work/selections?availability=all'))
      .body.selections.length,
    2,
  );
});

test('work-source queries reject duplicates, unsupported sources and unavailable data without storing interest', async (t) => {
  const f = await fixture(t),
    alice = member();
  await f.request(alice, 'POST', '/api/account', { displayName: 'Owner' });
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        '/api/work/source?kind=projects&kind=proposals&projectId=x',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        '/api/work/source?kind=elsewhere&projectId=x',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/work/selections', {
        clientRequestId: 'invalid-source-id-1',
        kind: 'proposals',
        projectId: 'not-a-proposal',
        sourceDigest: 'a'.repeat(64),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        null,
        'GET',
        '/api/work/source?kind=proposals&projectId=OPP-00001',
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await f.request(alice, 'POST', '/api/work/selections', {
        clientRequestId: 'unknown-source-1',
        kind: 'projects',
        projectId: 'missing',
        sourceDigest: 'a'.repeat(64),
      })
    ).status,
    503,
  );
  assert.equal(
    (await f.request(alice, 'GET', '/api/work/selections')).body.selections
      .length,
    0,
  );
});

test('research source configuration cannot publish embedded credentials or tokens', async (t) => {
  for (const projectsSource of [
    'https://user:password@example.test/api/projects',
    'https://example.test/api/projects?token=private',
    'https://example.test/api/projects#secret',
    'http://example.test/api/projects',
  ])
    await assert.rejects(
      fixture(t, { projectsSource }),
      /Invalid catalogue URL/,
    );
});
