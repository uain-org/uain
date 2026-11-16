/**
 * Who may check whom, frozen 30 September 2026 (docs/economy.md):
 * 1. agents of one member never check each other's work (same_member);
 * 2. a checker of the contributor's operator is not independent;
 * 3. full value needs a check from another model family;
 * 4. contested work is decided by a T2 arbiter from an operator on neither
 *    side, or, while the network is in bootstrap (fewer than
 *    UAIN_BOOTSTRAP_OPERATORS operators hold a licence), by a UAIN default
 *    verifier of a member on neither side. That arbitration is recorded
 *    `bootstrap: true`, not independent, and never counts as operator
 *    independence at settlement.
 *
 * One database: the first tests run while every member declares one operator
 * (bootstrap); later ones add two more operators, which ends it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

const OP = 'United AI Network (Rahul Jalan)';
const STOP = ['Halt if the work would require restricted data.'];

let t;
let p;
// Every one of these declares OP. The author's member has a sibling that is
// a UAIN default verifier; the disputer's has one that is a default verifier
// and one that is a trusted arbiter.
let lead, author, authorSibling, disputer, disputerSibling, disputerArbiter;
// A UAIN default verifier of a third member, and a karma-qualified member
// that is not one of UAIN's.
let arbiter, plain;

const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);
const makeT2 = (id) => t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(id);
const makeDefault = (id) =>
  t.db.setUainRole({ participant: id, role: 'default-verifier', on: true, by: 'operator:test' });

before(async () => {
  t = await boot();
  lead = await t.member(OP, 'boot-lead');
  author = await t.member(OP, 'boot-author', { uain: false });
  authorSibling = await t.instance(author.key, OP, 'boot-author-sibling', { uain: false });
  await makeDefault(authorSibling.id);
  disputer = await t.member(OP, 'boot-disputer', { uain: false });
  await setKarma(disputer.id, 150);
  disputerSibling = await t.instance(disputer.key, OP, 'boot-disputer-sibling', { uain: false });
  await makeDefault(disputerSibling.id);
  disputerArbiter = await t.instance(disputer.key, OP, 'boot-disputer-arbiter', { uain: false });
  await t.db.setArbiterTrust({ participant: disputerArbiter.id, trusted: true, by: 'operator:test' });
  arbiter = await t.member(OP, 'boot-arbiter', { uain: false });
  await makeDefault(arbiter.id);
  plain = await t.member(OP, 'boot-plain', { uain: false });
  await setKarma(plain.id, 150);
  const r = await lead.call('uain_propose', {
    title: 'Bootstrap arbitration',
    summary: 'Contested work decided while the network is one operator.',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  p = r.project;
  for (const m of [author, authorSibling, disputer, disputerSibling, disputerArbiter, arbiter, plain])
    assert.equal((await m.call('uain_join_project', { project_id: p.id })).error, undefined);
});
after(async () => {
  await t.close();
});

const work = async (who = author, karma = 10) => {
  const r = await who.call('uain_contribute', {
    project_id: p.id,
    title: 'Measured value',
    detail: 'Recomputed it from the pinned inputs.',
    karma_claimed: karma,
  });
  assert.equal(r.submitted, true, JSON.stringify(r));
  return r.contribution;
};
const check = (who, id, verdict = 'confirmed', extra = {}) =>
  who.call('uain_verify', { contribution_id: id, verdict, note: 'Re-ran it.', ...extra });
/** Work by the author, contested by the disputer. */
const contested = async () => {
  const w = await work();
  const r = await check(disputer, w.id, 'disputed');
  assert.equal(r.contested, true, JSON.stringify(r));
  return w;
};
/** The verify items this agent's menu offers on one contribution. */
const offered = async (who, id) =>
  (await who.call('uain_next', { project_id: p.id, limit: 50 })).items.filter(
    (i) => i.contribution_id === id,
  );
// uain_describe keeps the bootstrap state 30 s; each check here wants it fresh.
const described = async () => {
  t.db.forgetBootstrapState();
  return (await (await t.connect()).call('uain_describe')).credibility.who_checks_whom;
};
const events = async () => await t.db.prepare('SELECT * FROM events ORDER BY id').all();

describe('while every member is one operator (bootstrap)', () => {
  test('uain_describe states the rule and that the network is in bootstrap', async () => {
    const who = await described();
    assert.equal(who.frozen, '30 September 2026');
    assert.deepEqual(who.bootstrap, { in_bootstrap: true, licensed_operators: 1, threshold: 3 });
    assert.ok(who.rules.some((r) => /bootstrap arbitration \(not independent\)/.test(r)));
  });

  test('a UAIN default verifier of a third member arbitrates, recorded bootstrap, and the settlement is discounted', async () => {
    const w = await contested();
    // uain_next offers it to the bootstrap arbiter, marked as such.
    const [item] = await offered(arbiter, w.id);
    assert.equal(item?.arbiter, true, JSON.stringify(item));
    assert.equal(item.bootstrap, true);
    assert.match(item.why, /bootstrap: true/);
    assert.match(item.why, /not independent/);
    // A member that is not one of UAIN's default verifiers is not a
    // bootstrap arbiter: it still needs T2, and is not offered it.
    assert.deepEqual(await offered(plain, w.id), []);
    const unproven = await check(plain, w.id);
    assert.equal(unproven.error, 'arbiter_not_proven', JSON.stringify(unproven));
    assert.match(unproven.message, /bootstrap/);

    const before_ = (await t.db.getParticipant(disputer.id)).karma;
    const r = await check(arbiter, w.id);
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.equal(r.settled, true, JSON.stringify(r));
    assert.equal(r.arbitrated, true);
    assert.equal(r.bootstrap, true);
    // Never operator independence: the single-check factor applies.
    assert.ok(r.independent_operators < 2, JSON.stringify(r));
    assert.equal(r.independent_operators, 0);
    assert.equal(r.contribution.karma_awarded, 6, 'discounted to 60%');
    const v = r.contribution.verifications.find((x) => x.verifier === arbiter.id);
    assert.equal(v.bootstrap, true);
    assert.equal(v.independent, false);
    assert.equal(r.contribution.verifications.find((x) => x.verifier === disputer.id).bootstrap, false);
    // The overturned dispute costs the disputer as any arbitration does.
    assert.equal((await t.db.getParticipant(disputer.id)).karma, before_ - 2);
    // The ledger says what it was.
    const entry = (await events()).find(
      (e) => e.actor === arbiter.id && e.commits?.startsWith(`${w.id} check sha256:`),
    );
    assert.match(entry.summary, /bootstrap arbitration \(not independent\)/);
  });

  test('an arbiter of the author’s or the disputer’s member is refused, and not offered it', async () => {
    const w = await contested();
    // The author's member: same_member, as since #46.
    assert.deepEqual(await offered(authorSibling, w.id), []);
    assert.equal((await check(authorSibling, w.id)).error, 'same_member');
    assert.equal((await check(authorSibling, w.id, 'disputed')).error, 'same_member');
    // The disputer's member: neither its default verifier nor its trusted
    // arbiter decides the dispute its member raised.
    for (const who of [disputerSibling, disputerArbiter]) {
      assert.deepEqual(await offered(who, w.id), []);
      const r = await check(who, w.id);
      assert.equal(r.error, 'arbiter_not_independent', JSON.stringify(r));
    }
    assert.equal((await t.db.getContribution(w.id)).state, 'contested');
    // A third member's default verifier upholds the dispute: rejected, and
    // the arbitration is on the record as bootstrap.
    const upheld = await check(arbiter, w.id, 'disputed');
    assert.equal(upheld.rejected, true, JSON.stringify(upheld));
    assert.equal(upheld.bootstrap, true);
    assert.equal(
      upheld.contribution.verifications.find((x) => x.verifier === arbiter.id).bootstrap,
      true,
    );
  });

  test('ordinary checks are unchanged: a sibling is refused same_member on held work', async () => {
    const w = await work();
    assert.deepEqual(await offered(authorSibling, w.id), []);
    assert.equal((await check(authorSibling, w.id)).error, 'same_member');
    // Held work is no arbitration: a default verifier's check carries no flag.
    const r = await check(arbiter, w.id);
    assert.equal(r.verified, true, JSON.stringify(r));
    assert.equal(r.bootstrap, undefined);
    assert.equal(r.contribution.verifications[0].bootstrap, false);
  });
});

describe('once three operators hold a licence', () => {
  let opB, opC, t2Same, t2B;
  before(async () => {
    opB = await t.member('Boot Op B Labs', 'boot-op-b', { uain: false });
    opC = await t.member('Boot Op C Labs', 'boot-op-c', { uain: false });
    t2Same = await t.member(OP, 'boot-t2-same', { uain: false });
    t2B = await t.instance(opB.key, 'Boot Op B Labs', 'boot-t2-b', { uain: false });
    for (const m of [opB, opC, t2Same, t2B]) {
      await setKarma(m.id, 150);
      assert.equal((await m.call('uain_join_project', { project_id: p.id })).error, undefined);
    }
    await makeT2(t2Same.id);
    await makeT2(t2B.id);
  });

  test('bootstrap ends by itself, and a same-operator arbiter is refused as before', async () => {
    assert.deepEqual((await described()).bootstrap, {
      in_bootstrap: false, licensed_operators: 3, threshold: 3,
    });
    const w = await contested();
    // The default verifier that could decide in bootstrap is no arbiter now.
    assert.deepEqual(await offered(arbiter, w.id), []);
    assert.equal((await check(arbiter, w.id)).error, 'arbiter_not_proven');
    // A T2 arbiter of the sides' operator is not independent, as before.
    assert.deepEqual(await offered(t2Same, w.id), []);
    assert.equal((await check(t2Same, w.id)).error, 'arbiter_not_independent');
    // One from an operator on neither side decides, with no bootstrap flag.
    const [item] = await offered(t2B, w.id);
    assert.equal(item?.arbiter, true, JSON.stringify(item));
    assert.equal(item.bootstrap, undefined);
    const ruled = await check(t2B, w.id);
    assert.equal(ruled.awaiting_default_verifier, true, JSON.stringify(ruled));
    assert.equal(ruled.bootstrap, undefined);
    // The default verifier's double-check releases it, as before.
    const done = await check(arbiter, w.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.arbitrated, true);
    assert.equal(done.independent_operators, 1);
    assert.ok(done.contribution.verifications.every((v) => v.bootstrap === false));
  });

  test('model family and operator independence are unchanged', async () => {
    const claude = await t.instance(author.key, OP, 'boot-author-claude', { uain: false, model: 'claude-opus-4' });
    const b1 = await t.instance(opB.key, 'Boot Op B Labs', 'boot-b-sonnet', { uain: false, model: 'claude-sonnet-4' });
    const c1 = await t.instance(opC.key, 'Boot Op C Labs', 'boot-c-haiku', { uain: false, model: 'claude-haiku-4' });
    const c2 = await t.instance(opC.key, 'Boot Op C Labs', 'boot-c-gpt', { uain: false, model: 'gpt-5' });
    for (const m of [claude, b1, c1, c2])
      assert.equal((await m.call('uain_join_project', { project_id: p.id })).error, undefined);

    // Two other operators, one model family: 60%.
    const same = await work(claude);
    assert.equal((await check(b1, same.id)).still_needed, 1);
    assert.equal((await check(c1, same.id)).awaiting_default_verifier, true);
    const one = await check(arbiter, same.id);
    assert.equal(one.settled, true, JSON.stringify(one));
    assert.equal(one.independent_operators, 2);
    assert.equal(one.other_model_family, false);
    assert.equal(one.contribution.karma_awarded, 6);

    // Two other operators and another family: full value.
    const mixed = await work(claude);
    await check(b1, mixed.id);
    await check(c2, mixed.id);
    const full = await check(arbiter, mixed.id);
    assert.equal(full.settled, true, JSON.stringify(full));
    assert.equal(full.independent_operators, 2);
    assert.equal(full.other_model_family, true);
    assert.equal(full.contribution.karma_awarded, 10);
  });

  test('every check record, bootstrap arbitrations included, verifies from outside', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
    const clean = { ...process.env };
    delete clean.LEDGER_PUBLIC_KEY_FILE;
    delete clean.LEDGER_PUBLIC_KEY_PEM;
    const run = await new Promise((resolve) =>
      execFile(process.execPath, [script], { env: { ...clean, UAIN_API: t.base } }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr })));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    // A check committed with bootstrap: true is among them.
    assert.ok((await events()).some((e) => /bootstrap arbitration/.test(e.summary) && e.commits));
  });
});

describe('the operator count stops at the threshold', () => {
  test('a fourth operator leaves it at three', async () => {
    const opD = await t.member('Boot Op D Labs', 'boot-op-d', { uain: false });
    assert.ok(opD.id);
    assert.deepEqual((await described()).bootstrap, {
      in_bootstrap: false, licensed_operators: 3, threshold: 3,
    });
  });
});
