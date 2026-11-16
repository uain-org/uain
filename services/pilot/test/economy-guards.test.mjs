import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

// A ceiling of one credit, so after the first mint every award is deferred:
// what each test pays is read as minted plus deferred.
let t;
before(async () => {
  t = await boot({ UAIN_DAILY_ISSUANCE_CAP: '1' });
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

async function project(lead) {
  const r = await lead.call('uain_propose', {
    title: `Guards ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Test project',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  return r.project;
}

const join = (members, pid) =>
  Promise.all(members.map((m) => m.call('uain_join_project', { project_id: pid })));

const verdict = (who, id, v = 'confirmed') =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note: 'Checked.' });

async function work(who, pid, karma) {
  const r = await who.call('uain_contribute', {
    project_id: pid,
    title: 'w',
    detail: 'x',
    karma_claimed: karma,
  });
  assert.equal(r.submitted, true, JSON.stringify(r));
  return r.contribution.id;
}

/**
 * Funding is no longer filed (D9; removed 10 November 2026). A filing from
 * before, as the store holds it: a contribution of kind funding with its
 * transfer in meta, awaiting its checks.
 */
async function fund(who, pid, tx, amount = 100, chain = 'base') {
  const r = await who.call('uain_contribute', { project_id: pid, title: `Funding: ${amount} USD on ${chain}`, detail: `Transfer ${tx}`, karma_claimed: 1 });
  assert.equal(r.submitted, true, JSON.stringify(r));
  const meta = { tx_hash: tx, chain, amount_usd: amount, to_address: '0xproject' };
  await t.db.prepare("UPDATE contributions SET kind = 'funding', meta = ? WHERE id = ?").run(JSON.stringify(meta), r.contribution.id);
  return { submitted: true, contribution: { ...r.contribution, meta } };
}

/** Settle a funding filing with two checks; the settled contribution. */
async function settleFunding(filing, v1, v2) {
  assert.equal(filing.submitted, true, JSON.stringify(filing));
  await verdict(v1, filing.contribution.id);
  const done = await verdict(v2, filing.contribution.id);
  assert.equal(done.settled, true, JSON.stringify(done));
  return done.contribution;
}

/** Verifier credits for a contribution, per verifier: minted at settlement or deferred. */
async function verifierPay(id) {
  const rows = await t.db
    .prepare(
      `SELECT participant, SUM(n) AS n FROM (
         SELECT participant, delta AS n FROM credit_ledger WHERE ref = ? AND kind = 'verifier'
         UNION ALL
         SELECT participant, amount AS n FROM credit_deferrals WHERE contribution_id = ? AND kind = 'verifier'
       ) paid GROUP BY participant`,
    )
    .all(id, id);
  return Object.fromEntries(rows.map((r) => [r.participant, r.n]));
}

describe('the verifier share', () => {
  test('is paid in full, the remainder a credit each to the earliest checks', async () => {
    const lead = await t.member('VS-Lead');
    // Two members with the karma to check, then UAIN's default verifier: the
    // three checks the white paper's double-check (5.8) settles on.
    const m1 = await t.member('VS-One', 'VS-M1', { uain: false });
    const m2 = await t.member('VS-Two', 'VS-M2', { uain: false });
    const dv = await t.member('VS-Default');
    for (const m of [m1, m2])
      await t.db.prepare('UPDATE participants SET karma = 100 WHERE id = ?').run(m.id);
    const p = await project(lead);
    await join([m1, m2, dv], p.id);

    const settle = async (karma) => {
      const id = await work(lead, p.id, karma);
      await verdict(m1, id);
      const waiting = await verdict(m2, id);
      assert.equal(waiting.awaiting_default_verifier, true, JSON.stringify(waiting));
      const done = await verdict(dv, id);
      assert.equal(done.settled, true, JSON.stringify(done));
      assert.equal(done.contribution.credits_awarded, karma);
      return { id, done };
    };

    // An award of 10: a share of 2 among three used to pay 0 each.
    const ten = await settle(10);
    assert.deepEqual(ten.done.verifier_credits, [
      { verifier: m1.id, credits: 1 },
      { verifier: m2.id, credits: 1 },
      { verifier: dv.id, credits: 0 },
    ]);
    assert.deepEqual(await verifierPay(ten.id), { [m1.id]: 1, [m2.id]: 1 });

    // An award of 20: a share of 4 among three used to pay 3.
    const issued = await t.db.issuedLast24h();
    const twenty = await settle(20);
    assert.equal(twenty.done.verifier_credits_each, 1);
    assert.deepEqual(await verifierPay(twenty.id), { [m1.id]: 2, [m2.id]: 1, [dv.id]: 1 });
    assert.equal(await t.db.issuedLast24h(), issued, 'the shares still wait on the ceiling');
  });
});

describe('funding (removed; history only)', () => {
  test('there is no tool to file it', async () => {
    const a = await t.member('FD-A');
    const { tools } = await a.client.listTools();
    assert.equal(tools.some((x) => x.name === 'uain_contribute_funding'), false);
    assert.equal(typeof t.db.contributeFunding, 'undefined');
  });

  test('the index still holds a transfer once among filings already stored', async () => {
    const a = await t.member('FD-IA');
    const lead = await t.member('FD-ILead');
    const p = await project(lead);
    await join([a], p.id);
    const hex = 'ab'.repeat(32);
    const first = await fund(a, p.id, `0x${hex}`);
    const other = await fund(a, p.id, `0x${'ef'.repeat(32)}`);
    const index = await t.db
      .prepare("SELECT 1 FROM pg_indexes WHERE indexname = 'contributions_funding_transfer'")
      .get();
    assert.ok(index, 'the unique index was built on a store with no duplicates');
    await assert.rejects(
      t.db
        .prepare('UPDATE contributions SET meta = ? WHERE id = ?')
        .run(JSON.stringify({ tx_hash: hex, chain: 'BASE', amount_usd: 100 }), other.contribution.id),
      /contributions_funding_transfer/,
    );
    assert.ok(first.contribution.id);
  });

  test('a store already holding a transfer filed twice still starts; the index follows once it is resolved', async () => {
    const store = await import('../dist/src/storage/store.js');
    const funder = await t.member('FS-Funder');
    const lead = await t.member('FS-Lead');
    const p = await project(lead);
    await join([funder], p.id);
    const one = await fund(funder, p.id, `0x${'d1'.repeat(32)}`);
    const two = await fund(funder, p.id, `0x${'d2'.repeat(32)}`);
    const index = () =>
      t.db.prepare("SELECT 1 FROM pg_indexes WHERE indexname = 'contributions_funding_transfer'").get();

    // As a store from before the index might: the same transfer, live, twice.
    await t.db.prepare('DROP INDEX contributions_funding_transfer').run();
    await t.db
      .prepare('UPDATE contributions SET meta = ? WHERE id = ?')
      .run(JSON.stringify(one.contribution.meta), two.contribution.id);
    await store.ready();
    assert.equal(await index(), undefined, 'not built over a duplicate');

    await t.db.prepare("UPDATE contributions SET state = 'rejected' WHERE id = ?").run(two.contribution.id);
    await store.ready();
    assert.ok(await index(), 'built at the next start');
  });

  test('a filing from before settles in credits, never in Karma, within the member’s credit cap', async () => {
    const funder = await t.member('FC-Funder');
    const sibling = await t.instance(funder.key, 'FC-Funder', 'FC-Sibling');
    const lead = await t.member('FC-Lead');
    const v1 = await t.member('FC-V1');
    const v2 = await t.member('FC-V2');
    const p = await project(lead);
    await join([funder, sibling, v1, v2], p.id);
    let n = 0;
    const tx = () => `0x${(++n).toString(16).padStart(64, 'c')}`;
    const karmaBefore = (await t.db.getParticipant(funder.id)).member.karma;

    // 100 USD is 10 credits; it was up to 10 credibility before D9.
    const one = await settleFunding(await fund(funder, p.id, tx(), 100), v1, v2);
    assert.equal(one.karma_awarded, 0);
    assert.equal(one.credits_awarded, 10);
    const two = await settleFunding(await fund(sibling, p.id, tx(), 49_900), v1, v2);
    assert.equal(two.karma_awarded, 0);
    assert.equal(two.credits_awarded, 4990);
    const three = await settleFunding(await fund(funder, p.id, tx(), 1000), v1, v2);
    assert.equal(three.credits_awarded, 0, 'the member has had its 5,000');
    assert.equal((await t.db.getParticipant(funder.id)).member.karma, karmaBefore);

    const b = await sibling.call('uain_balance');
    assert.equal(b.funding.credits_used, 5000);
    assert.equal(b.funding.credibility_used, 0);
    assert.equal(b.funding.credibility_cap, 0);
  });
});

describe('release-deferred', () => {
  test('keeps back what is owed to revoked members and withdrawn agents, and says so', async () => {
    // Clear what earlier tests left deferred: the ceiling stays spent.
    await t.db.releaseDeferred({ by: 'operator:test' });
    const lead = await t.member('RD-Lead');
    const stays = await t.member('RD-Stays');
    const revoked = await t.member('RD-Revoked');
    const leaves = await t.member('RD-Leaves');
    const v1 = await t.member('RD-V1');
    const v2 = await t.member('RD-V2');
    const p = await project(lead);
    await join([stays, revoked, leaves, v1, v2], p.id);
    const owed = {};
    for (const who of [stays, revoked, leaves]) {
      const id = await work(who, p.id, 20);
      await verdict(v1, id);
      const done = await verdict(v2, id);
      assert.equal(done.credits_deferred, 20, JSON.stringify(done));
      owed[who.id] = id;
    }
    await t.db.revokeLicence(revoked.id, 'test');
    await leaves.call('uain_withdraw');

    const r = await t.db.releaseDeferred({ by: 'operator:test' });
    // 20 to the member that stays, and 2 to each verifier on all three.
    assert.equal(r.released, 20 + 6 * 2);
    assert.equal(r.awards, 7);
    assert.deepEqual(
      r.skipped.map((s) => [s.participant, s.contribution_id, s.amount, s.reason]),
      [
        [revoked.id, owed[revoked.id], 20, 'licence_revoked'],
        [leaves.id, owed[leaves.id], 20, 'withdrawn'],
      ],
    );
    assert.equal((await t.db.getParticipant(stays.id)).credits, 20);
    for (const who of [revoked, leaves]) {
      assert.equal((await t.db.getParticipant(who.id)).credits, 0, 'nothing minted');
      const c = await t.db.getContribution(owed[who.id]);
      assert.equal(c.credits_deferred, 20, 'still owed, on the record');
    }
    const entry = await t.db
      .prepare("SELECT summary FROM events WHERE actor = 'operator:test' ORDER BY id DESC LIMIT 1")
      .get();
    assert.match(entry.summary, /2 award\(s\) to revoked or withdrawn recipients stay deferred/);

    // Asked again, it pays them nothing and still reports them.
    const again = await t.db.releaseDeferred({ by: 'operator:test' });
    assert.equal(again.released, 0);
    assert.equal(again.skipped.length, 2);
  });
});
