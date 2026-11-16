import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  t.db.setTxtResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

async function project(lead, extra = {}) {
  const r = await lead.call('uain_propose', {
    title: `Economy ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Test project',
    stop_conditions: STOP,
    ...extra,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  return r.project;
}

const join = (members, pid) =>
  Promise.all(members.map((m) => m.call('uain_join_project', { project_id: pid })));

/** Arbitration is for proven members; tests stand one up directly. */
const makeT2 = async (m) =>
  await t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(m.id);

const verdict = (who, id, v = 'confirmed') =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note: 'Checked.' });

async function work(who, pid, karma = 20) {
  const r = await who.call('uain_contribute', {
    project_id: pid,
    title: 'w',
    detail: 'x',
    karma_claimed: karma,
  });
  assert.equal(r.submitted, true, JSON.stringify(r));
  return r.contribution.id;
}

/** Point the resolver at an in-memory zone. Never real DNS. */
function zone(records) {
  t.db.setTxtResolver(async (domain) => {
    if (!(domain in records)) {
      const e = new Error('ENOTFOUND');
      e.code = 'ENOTFOUND';
      throw e;
    }
    return records[domain].map((r) => [r]);
  });
}

async function proveOperator(m, domain, records) {
  const claim = await m.call('uain_claim_operator', { domain });
  assert.equal(claim.claimed, true, JSON.stringify(claim));
  records[domain] = [...(records[domain] ?? []), claim.record_value];
  zone(records);
  const ok = await m.call('uain_confirm_operator');
  assert.equal(ok.verified, true, JSON.stringify(ok));
}

describe('two balances', () => {
  test('work pays credibility and credits; verifiers share a fifth in credits', async () => {
    const lead = await t.member('E-Alpha');
    const v1 = await t.member('E-Beta');
    const v2 = await t.member('E-Gamma');
    const p = await project(lead);
    await join([v1, v2], p.id);
    const id = await work(lead, p.id, 20);
    await verdict(v1, id);
    const done = await verdict(v2, id);
    assert.equal(done.settled, true);
    assert.equal(done.credits_minted, 20);
    assert.equal(done.verifier_credits_each, 2); // floor(20 * 0.2 / 2)

    const me = await lead.call('uain_balance');
    assert.equal(me.credibility, 20);
    assert.equal(me.credits, 20);
    assert.equal(me.recent[0].kind, 'bounty');
    const who = await lead.call('uain_whoami');
    assert.equal(who.participant.credibility, who.participant.karma);

    const vb = await v1.call('uain_balance');
    assert.equal(vb.credits, 2);
    assert.equal(vb.credibility, 0, 'verifying earns credits, never standing');
  });

  test('the credits column always equals the sum of the credit ledger', async () => {
    const rows = await t.db
      .prepare(
        `SELECT p.id, p.credits, COALESCE(SUM(c.delta), 0) AS summed
         FROM participants p LEFT JOIN credit_ledger c ON c.participant = p.id
         GROUP BY p.id`,
      )
      .all();
    for (const r of rows) assert.equal(r.credits, r.summed, r.id);
  });

  test('transfers are refused while disabled', async () => {
    const a = await t.member('E-T1');
    const b = await t.member('E-T2');
    const r = await a.call('uain_transfer_credits', { to: b.id, amount: 1 });
    assert.equal(r.error, 'transfers_disabled');
  });
});

describe('disputes are arbitrated', () => {
  test('an overturned dispute settles the work and costs the disputer', async () => {
    const lead = await t.member('C-Lead');
    const disputer = await t.member('C-Grief');
    const sameSide = await t.member('C-Grief'); // shares the disputer's operator
    const arbiter = await t.member('C-Arb');
    const helper = await t.member('C-Help');
    const p = await project(lead);
    await join([disputer, sameSide, arbiter, helper], p.id);

    // Give the disputer some credibility to lose.
    const earlier = await work(disputer, p.id, 10);
    await verdict(lead, earlier);
    await verdict(helper, earlier);
    const before_ = (await disputer.call('uain_balance')).credibility;
    assert.ok(before_ > 0);

    const id = await work(lead, p.id, 20);
    const first = await verdict(disputer, id, 'disputed');
    assert.equal(first.contested, true);
    assert.equal(first.contribution.state, 'contested');

    const unproven = await verdict(arbiter, id, 'confirmed');
    assert.equal(unproven.error, 'arbiter_not_proven');

    await makeT2(sameSide);
    await makeT2(arbiter);
    const partisan = await verdict(sameSide, id, 'confirmed');
    assert.equal(partisan.error, 'arbiter_not_independent');

    const offered = await arbiter.call('uain_next', { project_id: p.id });
    assert.ok(
      offered.items.some((i) => i.contribution_id === id && i.arbiter),
      'contested work is offered to an eligible arbiter',
    );
    const notOffered = await helper.call('uain_next', { project_id: p.id });
    assert.ok(!notOffered.items.some((i) => i.contribution_id === id));

    const resolved = await verdict(arbiter, id, 'confirmed');
    assert.equal(resolved.settled, true);
    assert.equal(resolved.arbitrated, true);
    assert.equal(resolved.contribution.state, 'settled');

    const after_ = (await disputer.call('uain_balance')).credibility;
    assert.equal(after_, before_ - 2);
  });

  test('karma summed over a member’s agents revokes all of them at -10', async () => {
    const lead = await t.member('S-Lead');
    const arbiter = await t.member('S-Arb');
    const disputer = await t.member('S-Grief');
    const sibling = await t.instance(disputer.key, 'S-Grief', 'S-Sibling');
    const p = await project(lead);
    await join([disputer, arbiter, sibling], p.id);
    await makeT2(arbiter);
    // -5 and -4: neither agent alone is at -10, the member is at -9.
    const set = t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?');
    await set.run(-5, disputer.id);
    await set.run(-4, sibling.id);
    const id = await work(lead, p.id, 5);
    await verdict(disputer, id, 'disputed');
    await verdict(arbiter, id, 'confirmed');
    const one = await t.db.getParticipant(disputer.id);
    assert.equal(one.member.karma, -11);
    assert.equal(one.member.licence.status, 'revoked');
    assert.equal((await t.db.getParticipant(sibling.id)).state, 'revoked');
    assert.equal((await sibling.call('uain_whoami')).authenticated, false, 'the sibling is cut off too');
  });

  test('an overturned dispute can take karma below zero, and at -10 the licence goes', async () => {
    const lead = await t.member('R-Lead');
    const disputer = await t.member('R-Grief');
    const arbiter = await t.member('R-Arb');
    const p = await project(lead);
    await join([disputer, arbiter], p.id);
    await makeT2(arbiter);
    await t.db.prepare('UPDATE participants SET karma = -9 WHERE id = ?').run(disputer.id);

    const id = await work(lead, p.id, 5);
    await verdict(disputer, id, 'disputed');
    const resolved = await verdict(arbiter, id, 'confirmed');
    assert.equal(resolved.settled, true, JSON.stringify(resolved));

    const row = await t.db.getParticipant(disputer.id);
    assert.equal(row.karma, -11);
    assert.equal(row.state, 'revoked');
    assert.equal(row.member.licence.status, 'revoked');
    assert.match(row.member.licence.reason, /-11/);
    assert.equal((await disputer.call('uain_whoami')).authenticated, false);
  });

  test('pending contested work blocks amendments like held work', async () => {
    const lead = await t.member('A-Lead');
    const d = await t.member('A-D');
    const p = await project(lead);
    await join([d], p.id);
    const id = await work(lead, p.id, 5);
    await verdict(d, id, 'disputed');
    const r = await lead.call('uain_amend', {
      project_id: p.id,
      condition: STOP[0],
      text: 'Halt if restricted data is needed.',
      reason: 'Tighter wording.',
    });
    assert.equal(r.error, 'work_pending');
  });
});

describe('operator verification', () => {
  const records = {};

  test('a TXT record proves the operator; a missing one does not', async () => {
    const m = await t.member('O-One');
    const claim = await m.call('uain_claim_operator', { domain: 'one.example' });
    assert.match(claim.record_value, /^uain-operator=did:uain:/);
    zone(records);
    const miss = await m.call('uain_confirm_operator');
    assert.equal(miss.verified, false);
    records['one.example'] = [claim.record_value];
    zone(records);
    const ok = await m.call('uain_confirm_operator');
    assert.equal(ok.verified, true);
    assert.equal((await m.call('uain_balance')).operator_verified, true);
    const bad = await m.call('uain_claim_operator', { domain: 'not a domain' });
    assert.equal(bad.error, 'bad_domain');
  });

  test('two proved systems on one domain are one operator, whatever they declare', async () => {
    const a = await t.member('Declared A');
    const b = await t.member('Declared B');
    const c = await t.member('Declared C');
    await proveOperator(a, 'shared.example', records);
    await proveOperator(b, 'shared.example', records);
    const p = await project(a);
    await join([b, c], p.id);
    const id = await work(a, p.id, 10);
    await verdict(b, id);
    const done = await verdict(c, id);
    assert.equal(done.independent_operators, 1);
    assert.equal(done.contribution.karma_awarded, 6);
  });

  test('T2 needs a proved operator as well as independent checks', async () => {
    const proved = await t.member('Tier Proved');
    const unproved = await t.member('Tier Unproved');
    const v1 = await t.member('Tier V1');
    const v2 = await t.member('Tier V2');
    await proveOperator(proved, 'proved.example', records);
    const p = await project(proved);
    await join([unproved, v1, v2], p.id);
    for (const who of [proved, unproved]) {
      for (let i = 0; i < 2; i++) {
        const id = await work(who, p.id, 5);
        await verdict(v1, id);
        await verdict(v2, id);
      }
    }
    assert.equal((await proved.call('uain_whoami')).participant.tier, 'T2');
    assert.equal((await unproved.call('uain_whoami')).participant.tier, 'T1');
  });
});

describe('compute', () => {
  test('compute pays credits only, capped per contribution', async () => {
    const donor = await t.member('G-Donor');
    const lead = await t.member('G-Lead');
    const v1 = await t.member('G-V1');
    const v2 = await t.member('G-V2');
    const p = await project(lead);
    await join([donor, v1, v2], p.id);
    const sub = await donor.call('uain_contribute_compute', {
      project_id: p.id,
      gpu_hours: 100,
      provider: 'test cluster',
      detail: 'Re-ran the pipeline.',
    });
    assert.equal(sub.submitted, true, JSON.stringify(sub));
    await verdict(v1, sub.contribution.id);
    const done = await verdict(v2, sub.contribution.id);
    assert.equal(done.credits_minted, 1000);
    assert.equal(done.contribution.karma_awarded, 0);
    assert.equal((await donor.call('uain_balance')).credibility, 0);
  });
});

describe('budget stages', () => {
  test('task offers are bounded by the unlocked stage, not the whole budget', async () => {
    const lead = await t.member('S-Lead');
    const p = await project(lead, { uain_budget: 10_000_000 });
    await t.db.allocateBudget({ projectId: p.id, amount: 10_000_000, by: 'operator:test' });
    const post = (offer) =>
      lead.call('uain_task_open', {
        project_id: p.id,
        title: `t${offer}`,
        question: 'q',
        done_when: 'd',
        how_to_check: 'c',
        karma_offered: offer,
      });
    assert.equal((await post(900)).ok, true);
    const over = await post(200);
    assert.equal(over.error, 'over_budget');
    assert.equal(over.unlocked, 1000); // floor at stage 0
    const unlocked = await t.db.unlockStage({ projectId: p.id, by: 'operator:test' });
    assert.equal(unlocked.budget_stage, 1);
    assert.equal(unlocked.budget_unlocked, 10_000);
    assert.equal((await post(200)).ok, true);
  });
});
