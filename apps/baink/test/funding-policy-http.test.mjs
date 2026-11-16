import test from 'node:test';
import { readPersistedState } from '../server/store-sqlite.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { createBainkServer } from '../server/app.mjs';
const origin = 'https://baink.example';
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'baink-funding-test-'));
  await writeFile(
    join(dataDir, 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: {},
      requests: {},
      nonces: {},
      history: [],
      nativeIntents: {},
    }),
  );
  const app = await createBainkServer({
    dataDir,
    publicOrigin: origin,
    projectsSource: null,
    catalogueDir: null,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const port = app.server.address().port;
  const request = (path, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Host: 'baink.example',
            Origin: origin,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString());
            } catch {}
            resolve({ status: res.statusCode, body });
          });
        },
      );
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  return { request, dataDir };
}
test('funding API/config/MCP expose the same safe draft, no financial mutation or private amounts', async (t) => {
  const f = await fixture(t);
  const before = await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir)));
  const api = await f.request('/api/funding/policy');
  assert.equal(api.status, 200);
  assert.equal(api.body.status, 'draft-unadopted');
  const config = await f.request('/api/config');
  assert.deepEqual(config.body.projectFunding, api.body);
  const mcp = await f.request('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'baink_funding_policy', arguments: {} },
    },
  });
  assert.equal(mcp.status, 200);
  assert.equal(mcp.body.result?.isError, false);
  // The MCP adds only the standard next step to the same safe draft.
  const { nextStep, ...mcpDraft } = mcp.body.result.structuredContent;
  assert.deepEqual(mcpDraft, api.body);
  assert.equal(nextStep.tool, 'baink_agent_next');
  const all = JSON.stringify([api.body, config.body, mcp.body]);
  for (const marker of ['1111110000', '112110000', '179355', 'slack.com'])
    assert.ok(!all.includes(marker));
  assert.equal(await Promise.resolve(JSON.stringify(readPersistedState(f.dataDir))), before);
});
test('funding policy accepts no query, caller approvals/amounts or write paths', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/api/funding/policy?approved=true',
    '/api/funding/policy?round=6',
    '/api/funding/policy?amount=100',
    '/api/funding/policy?revision=a&revision=b',
  ])
    assert.equal((await f.request(path)).status, 400, path);
  for (const path of [
    '/api/funding/policy',
    '/api/funding/applications',
    '/api/funding/allocate',
  ])
    assert.equal(
      (await f.request(path, { method: 'POST', body: { approved: true } }))
        .status,
      404,
      path,
    );
  const r = await f.request('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'baink_funding_policy', arguments: { approved: true } },
    },
  });
  assert.equal(r.body.error?.code, -32602);
  assert.equal(
    (
      await f.request('/api/funding/policy', {
        headers: { Origin: 'https://attacker.example' },
      })
    ).status,
    403,
  );
});
