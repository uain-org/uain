import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, member } from './http-fixture.mjs';
const company = '11111111-1111-4111-8111-111111111111',
  project = '22222222-2222-4222-8222-222222222222';

test('operations stay explicit not-configured and require signed account access', async (t) => {
  const f = await fixture(t),
    alice = member();
  await f.request(alice, 'POST', '/api/account', {});
  assert.equal(
    (await f.request(null, 'GET', '/api/projects/project-one/operations'))
      .status,
    401,
  );
  const result = await f.request(
    alice,
    'GET',
    '/api/projects/project-one/operations',
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'not-configured');
  assert.equal(result.body.project, null);
  assert.equal(result.body.costs.costCentsExact, null);
});
test('mapped project operations require exact operator viewer permission before any upstream read', async (t) => {
  const alice = member(),
    bob = member();
  let calls = 0;
  const f = await fixture(t, {
    paperclipViewers: { 'project-one': [alice.address] },
    paperclipConfig: {
      origin: 'https://paperclip.example',
      allowedOrigins: ['https://paperclip.example'],
      apiKey: 'fixture-paperclip-token-1234',
      allowedCompanyIds: [company],
      projectMap: { 'project-one': { companyId: company, projectId: project } },
      fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.method, 'GET');
        const path = new URL(url).pathname;
        return new Response(
          JSON.stringify(
            path === '/api/projects/' + project
              ? {
                  id: project,
                  companyId: company,
                  name: 'Scoped work',
                  status: 'in_progress',
                  leadAgentId: null,
                  workspace: { secret: 'never-public' },
                }
              : [],
          ),
          { headers: { 'Content-Type': 'application/json' } },
        );
      },
    },
  });
  for (const user of [alice, bob])
    await f.request(user, 'POST', '/api/account', {});
  const denied = await f.request(
    bob,
    'GET',
    '/api/projects/project-one/operations',
  );
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(denied.body).includes(company));
  const allowed = await f.request(
    alice,
    'GET',
    '/api/projects/project-one/operations',
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.status, 'available');
  assert.equal(allowed.body.project.name, 'Scoped work');
  assert.ok(!JSON.stringify(allowed.body).includes('never-public'));
  assert.equal(allowed.body.costs.costCentsExact, null);
  const before = calls;
  assert.equal(
    (await f.request(alice, 'GET', '/api/projects/another-project/operations'))
      .status,
    403,
  );
  assert.equal(calls, before);
  const config = await f.request(null, 'GET', '/api/config');
  assert.equal(config.body.integrations.paperclip.configured, true);
  assert.ok(!JSON.stringify(config.body).includes(company));
});
test('invalid viewer scope cannot silently widen access at startup', async (t) => {
  await assert.rejects(
    fixture(t, {
      paperclipViewers: { 'project-one': ['not-a-native-address'] },
    }),
    /viewer/i,
  );
});

test('incomplete operator configuration does not disclose private mapping or origin to unapproved members', async (t) => {
  const alice = member();
  const f = await fixture(t, {
    paperclipConfig: {
      origin: 'https://private-control.example',
      allowedCompanyIds: [company],
      projectMap: { 'project-one': { companyId: company, projectId: project } },
    },
  });
  await f.request(alice, 'POST', '/api/account', {});
  const answer = await f.request(
    alice,
    'GET',
    '/api/projects/project-one/operations',
  );
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'not-configured');
  const text = JSON.stringify(answer.body);
  assert.ok(!text.includes(company));
  assert.ok(!text.includes(project));
  assert.ok(!text.includes('private-control.example'));
});
