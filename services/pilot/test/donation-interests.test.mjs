import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';
let t, slack, store, outbox;
let rejectSlack = false;
const messages = [];
before(async () => {
  slack = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      messages.push(JSON.parse(raw));
      res.statusCode = rejectSlack ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => slack.listen(0, '127.0.0.1', r));
  t = await boot({
    UAIN_SLACK_WAITLIST_WEBHOOK: `http://127.0.0.1:${slack.address().port}/hook`,
    UAIN_RATE_DONATION_INTERESTS_PER_HOUR: '20',
  });
  store = await import('../dist/src/storage/store.js');
  outbox = await import('../dist/src/api/donation-interests.js');
});
after(async () => {
  await t.close();
  await new Promise((r) => slack.close(r));
});
const body = (extra = {}) => ({
  request_id: randomUUID(),
  project_id: 'sahel-early-warning',
  project_title: 'Sahel project',
  name: 'Test donor',
  email: 'private.donor@example.org',
  amount: '50',
  currency: 'CHF',
  message: 'Interested in helping.\nPlease keep me informed.',
  consent_contact: true,
  attribution: {
    referred_by: 'agent_42',
    utm_source: 'email',
    source: 'example.org',
  },
  ...extra,
});
const post = (b) =>
  t.http('/api/donation-interests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
async function waitFor(condition) {
  for (let i = 0; i < 50; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('condition not reached');
}
test('private interest, referral and durable Slack delivery; idempotent retries', async () => {
  const beforeLedger = await store.pool.query(
    'SELECT count(*)::int AS n FROM events',
  );
  const b = body();
  const response = await post(b);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.status, 'interest_recorded');
  assert.match(result.message, /interest in donating has been noted/);
  assert.ok(!JSON.stringify(result).includes(b.email));
  await waitFor(
    async () =>
      !!(
        await store.pool.query(
          'SELECT slack_sent_at FROM donation_interests WHERE id=$1',
          [result.id],
        )
      ).rows[0]?.slack_sent_at,
  );
  const row = (
    await store.pool.query('SELECT * FROM donation_interests WHERE id=$1', [
      result.id,
    ])
  ).rows[0];
  assert.equal(row.email, b.email);
  assert.equal(row.attribution.referred_by, 'agent_42');
  assert.equal(row.is_demo, true);
  assert.ok(messages.at(-1).text.includes('agent_42'));
  assert.ok(!messages.at(-1).text.includes(b.email));
  assert.ok(!messages.at(-1).text.includes(b.name));
  const sent = messages.length;
  const retry = await post(b);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).id, result.id);
  assert.equal(messages.length, sent);
  assert.equal(
    (await store.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n,
    beforeLedger.rows[0].n,
  );
  assert.equal((await t.http('/api/donation-interests')).status, 405);
});
test('validation blocks unknown projects, malformed fields and absent consent', async () => {
  for (const extra of [
    { consent_contact: false },
    { email: 'invalid' },
    { amount: '-2' },
    { amount: '1e5' },
    { currency: 'BTC' },
    { name: '<script>' },
    { request_id: '------------------------------------' },
  ])
    assert.equal((await post(body(extra))).status, 422);
  assert.equal((await post(body({ project_id: 'not-a-project' }))).status, 404);
});
test('Slack failure keeps the interest, retries safely after the lease', async () => {
  rejectSlack = true;
  const r = await post(body());
  assert.equal(r.status, 201);
  const { id } = await r.json();
  await waitFor(async () => messages.some((m) => m.text.includes(id)));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    (
      await store.pool.query(
        'SELECT slack_sent_at FROM donation_interests WHERE id=$1',
        [id],
      )
    ).rows[0].slack_sent_at,
    null,
  );
  rejectSlack = false;
  await store.pool.query(
    'UPDATE donation_interests SET slack_retry_at=0 WHERE id=$1',
    [id],
  );
  await Promise.all([
    outbox.flushDonationNotices(),
    outbox.flushDonationNotices(),
  ]);
  assert.ok(
    (
      await store.pool.query(
        'SELECT slack_sent_at FROM donation_interests WHERE id=$1',
        [id],
      )
    ).rows[0].slack_sent_at,
  );
  assert.equal(messages.filter((m) => m.text.includes(id)).length, 2);
});

test('directory attribution snapshots the referring AI system and links its profile', async () => {
  const agent = await t.member('Referral operator', 'Helpful research system');
  const b = body({ attribution: { referred_by: agent.id, source: 'email' } });
  const r = await post(b);
  assert.equal(r.status, 201);
  const { id } = await r.json();
  await waitFor(
    async () =>
      !!(
        await store.pool.query(
          'SELECT slack_sent_at FROM donation_interests WHERE id=$1',
          [id],
        )
      ).rows[0]?.slack_sent_at,
  );
  const row = (
    await store.pool.query('SELECT * FROM donation_interests WHERE id=$1', [id])
  ).rows[0];
  assert.equal(row.referring_system.status, 'directory_match');
  assert.equal(row.referring_system.name, 'Helpful research system');
  assert.equal(row.referring_system.operator, 'Referral operator');
  assert.equal(row.referring_system.id, agent.id);
  assert.equal(
    row.referring_system.profile_url,
    `https://uain.global/network/live?id=${agent.id}`,
  );
  const message = messages.find((m) => m.text.includes(id)).text;
  assert.ok(message.includes('Helpful research system'));
  assert.ok(message.includes('Referral operator'));
  assert.ok(message.includes(row.referring_system.profile_url));
  assert.ok(message.includes('does not prove who sent the link'));
  assert.ok(!message.includes(b.email));
  await store.pool.query(
    "UPDATE participants SET name='Renamed later' WHERE id=$1",
    [agent.id],
  );
  const retry = await post({
    ...b,
    attribution: { referred_by: 'different-system' },
  });
  assert.equal(retry.status, 200);
  assert.equal(
    (
      await store.pool.query(
        'SELECT referring_system FROM donation_interests WHERE id=$1',
        [id],
      )
    ).rows[0].referring_system.name,
    'Helpful research system',
  );
});

test('member addresses resolve; unknown and missing IDs never invent a system', async () => {
  const agent = await t.member('Referral member operator', 'Referral member');
  const { member_id } = (
    await store.pool.query('SELECT member_id FROM participants WHERE id=$1', [
      agent.id,
    ])
  ).rows[0];
  const memberR = await post(body({ attribution: { referred_by: member_id } }));
  assert.equal(memberR.status, 201);
  const memberId = (await memberR.json()).id;
  const system = (
    await store.pool.query(
      'SELECT referring_system FROM donation_interests WHERE id=$1',
      [memberId],
    )
  ).rows[0].referring_system;
  assert.equal(system.status, 'directory_match');
  assert.equal(system.member_address, member_id);
  assert.ok(system.profile_url.endsWith('?member=' + member_id));
  const unknownR = await post(
    body({
      attribution: {
        referred_by: 'unknown-system',
        name: 'Fake directory name',
      },
    }),
  );
  const unknownId = (await unknownR.json()).id;
  const unknown = (
    await store.pool.query(
      'SELECT referring_system FROM donation_interests WHERE id=$1',
      [unknownId],
    )
  ).rows[0].referring_system;
  assert.deepEqual(unknown, {
    status: 'unrecognised',
    supplied_id: 'unknown-system',
  });
  const directR = await post(
    body({ attribution: { referred_by: 'invalid<id>' } }),
  );
  const directId = (await directR.json()).id;
  assert.deepEqual(
    (
      await store.pool.query(
        'SELECT referring_system FROM donation_interests WHERE id=$1',
        [directId],
      )
    ).rows[0].referring_system,
    { status: 'direct' },
  );
  await waitFor(
    async () =>
      !!(
        await store.pool.query(
          'SELECT slack_sent_at FROM donation_interests WHERE id=$1',
          [directId],
        )
      ).rows[0]?.slack_sent_at,
  );
});
