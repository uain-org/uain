import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { boot } from '../helpers.mjs';

// A stand-in for Slack's incoming webhook that keeps what it is sent.
const received = [];
let slack, metrics, t;
before(async () => {
  slack = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('ok');
    });
  });
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  t = await boot({
    UAIN_SLACK_WAITLIST_WEBHOOK: `http://127.0.0.1:${slack.address().port}/hook`,
  });
  const { startMetrics, registry } = await import('../../dist/src/operations/metrics.js');
  const { pool } = await import('../../dist/src/storage/store.js');
  // Port 0 means "off" to startMetrics: it only watches the pool, and the
  // registry is served here on a free port instead.
  startMetrics(pool, 0);
  metrics = createServer(async (_, res) => res.end(await registry.metrics()));
  await new Promise((r) => metrics.listen(0, '127.0.0.1', r));
});
after(async () => {
  metrics.close();
  slack.close();
  await t.close();
});

const scrape = async () =>
  (await fetch(`http://127.0.0.1:${metrics.address().port}/metrics`)).text();

const until = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

const register = (body) =>
  t.http('/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('metrics and the waitlist Slack notice', () => {
  test('a new registration is sent to Slack, without its contacts', async () => {
    const r = await register({
      name: 'Helix <!channel>',
      system_types: ['ai_agent'],
      description: 'A research agent.',
      email: 'ops@helix.example',
    });
    assert.equal(r.status, 201);
    const { candidate_id } = await r.json();
    await until(() => received.length === 1);
    assert.equal(received.length, 1);
    const text = received[0].text;
    assert.ok(text.includes(candidate_id));
    assert.ok(text.includes('Helix &lt;!channel&gt;'), 'markup is escaped');
    assert.equal(text.includes('ops@helix.example'), false);
  });

  test('a repeat registration is not sent again', async () => {
    const r = await register({
      name: 'helix <!channel>',
      system_types: ['ai_agent'],
      description: 'Again.',
      email: 'ops@helix.example',
    });
    assert.equal(r.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(received.length, 1);
  });

  test('requests are counted by route, never by id', async () => {
    await t.http('/api/waitlist/UAIN-00000001');
    const body = await scrape();
    assert.match(body, /uain_http_request_duration_seconds_count\{route="GET \/api\/waitlist",status="2xx"\} \d+/);
    assert.equal(body.includes('UAIN-00000001'), false);
    assert.match(body, /uain_waitlist_registrations_total 1/);
    assert.match(body, /uain_slack_notifications_total\{outcome="sent"\} 1/);
    assert.match(body, /uain_pg_pool_connections\{state="total"\} \d+/);
  });
});
