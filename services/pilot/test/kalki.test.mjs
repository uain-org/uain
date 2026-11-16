import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { boot } from './helpers.mjs';

test('Earth Kalki status is read-only, empty when unconfigured, and sanitizes upstream projects', async () => {
  const system = await boot({ UAIN_KALKI_STATUS_URL: '', UAIN_KALKI_KEY: '' });
  try {
    const empty = await system.http('/api/kalki');
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { projects: [] });
    assert.equal(
      (await system.http('/api/kalki', { method: 'POST' })).status,
      405,
    );
  } catch (error) {
    await system.close();
    throw error;
  }

  let calls = 0;
  const upstream = createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer test-kalki-key');
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        projects: [
          {
            id: 'health',
            name: '<Health>',
            private_key: 'never-public',
            tasks: { passed: 2, failed: 0 },
            milestones: { done: 1, total: 3 },
            arm: {
              number: '6',
              name: 'Healthcare',
              mission: 'Quality healthcare',
            },
            milestone: { seq: 2, title: 'Review', status: 'running' },
            doing: ['Review evidence'],
            last: { at: 123, text: '<Working>' },
          },
          { id: '<invalid>' },
        ],
      }),
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  Object.assign(process.env, {
    UAIN_KALKI_STATUS_URL: `http://127.0.0.1:${upstream.address().port}/status`,
    UAIN_KALKI_KEY: 'test-kalki-key',
  });
  try {
    const response = await system.http('/api/kalki');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].name, 'Health');
    assert.equal(body.projects[0].last.text, 'Working');
    assert.deepEqual(body.projects[0].tasks, { passed: 2, failed: 0 });
    assert.equal(JSON.stringify(body).includes('never-public'), false);
    assert.equal(JSON.stringify(body).includes('test-kalki-key'), false);
    await system.http('/api/kalki');
    assert.equal(calls, 1);
  } finally {
    await system.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
