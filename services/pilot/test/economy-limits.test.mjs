import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

// Both flags are read when db.mjs loads, so they get a store of their own.
let t;
before(async () => {
  t = await boot({ UAIN_TRANSFERS_ENABLED: 'true', UAIN_DAILY_ISSUANCE_CAP: '30' });
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

async function settledWork(karma) {
  const lead = await t.member('L-Lead');
  const v1 = await t.member('L-V1');
  const v2 = await t.member('L-V2');
  const p = (
    await lead.call('uain_propose', { title: `L ${Math.random()}`, summary: 's', stop_conditions: STOP })
  ).project;
  for (const m of [v1, v2]) await m.call('uain_join_project', { project_id: p.id });
  const sub = await lead.call('uain_contribute', {
    project_id: p.id,
    title: 'w',
    detail: 'x',
    karma_claimed: karma,
  });
  await v1.call('uain_verify', { contribution_id: sub.contribution.id, verdict: 'confirmed', note: 'ok' });
  const done = await v2.call('uain_verify', {
    contribution_id: sub.contribution.id,
    verdict: 'confirmed',
    note: 'ok',
  });
  return { lead, v1, v2, done };
}

describe('daily issuance ceiling', () => {
  test('mints up to the ceiling, defers the rest, and releases it on operator action', async () => {
    const { lead, v1, done } = await settledWork(50);
    assert.equal(done.credits_minted, 30);
    assert.equal(done.credits_deferred, 20);
    assert.equal(done.contribution.karma_awarded, 50, 'credibility is never deferred');
    assert.equal((await v1.call('uain_balance')).credits, 0);
    assert.equal((await v1.call('uain_balance')).credits_deferred, 5);

    const r = await t.db.releaseDeferred({ by: 'operator:test' });
    assert.equal(r.released, 30); // 20 to the contributor, 5 to each verifier
    assert.equal((await lead.call('uain_balance')).credits, 50);
    assert.equal((await v1.call('uain_balance')).credits, 5);
  });
});

describe('transfers when enabled', () => {
  test('move credits, never credibility, with no overdraft', async () => {
    const { lead, v1 } = await settledWork(10);
    await t.db.releaseDeferred({ by: 'operator:test' }); // the ceiling was spent by the test above
    const before_ = await lead.call('uain_balance');
    const issued = await t.db.issuedLast24h();
    const sent = await lead.call('uain_transfer_credits', { to: v1.id, amount: 3, memo: 'thanks' });
    assert.equal(sent.transferred, 3, JSON.stringify(sent));
    const after_ = await lead.call('uain_balance');
    assert.equal(after_.credits, before_.credits - 3);
    assert.equal(after_.credibility, before_.credibility);
    assert.equal(await t.db.issuedLast24h(), issued, 'transfers are not issuance');

    assert.equal(
      (await lead.call('uain_transfer_credits', { to: v1.id, amount: 1_000_000 })).error,
      'insufficient_credits',
    );
    assert.equal(
      (await lead.call('uain_transfer_credits', { to: lead.id, amount: 1 })).error,
      'self_transfer',
    );
    await v1.call('uain_withdraw');
    assert.equal(
      (await lead.call('uain_transfer_credits', { to: v1.id, amount: 1 })).error,
      'recipient_unavailable',
    );
  });
});
