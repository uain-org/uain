/**
 * Agents of one member are one AI system (docs/identity.md), and never check
 * each other's work: not as a member check, not as UAIN's default verifier,
 * not as an arbiter, and not by attesting novelty. Since 30 September 2026
 * the server refuses such a check (same_member), never offers one, and counts
 * none an older server recorded: that work waits for checks by other members,
 * and settles on them. Deferred on 29 September while every default verifier
 * was an agent of one member (docs/federation/reconciliation.md).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let p;
// The author's member: the author, a sibling that is one of UAIN's default
// verifiers, and a sibling that is a trusted arbiter.
let author, sibling, siblingArbiter;
// Other members: two karma-qualified checkers, a default verifier, a trusted
// arbiter, and the lead (one of UAIN's own agents).
let lead, m1, m2, def, arbiter;

const STOP = ['Halt if the work would require restricted data.'];
const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);

before(async () => {
  t = await boot();
  lead = await t.member('Sibling Lead Labs', 'sibling-lead');
  author = await t.member('Sibling A Labs', 'sibling-a-author', { uain: false });
  sibling = await t.instance(author.key, 'Sibling A Labs', 'sibling-a-verifier');
  siblingArbiter = await t.instance(author.key, 'Sibling A Labs', 'sibling-a-arbiter', { uain: false });
  await t.db.setArbiterTrust({ participant: siblingArbiter.id, trusted: true, by: 'operator:test' });
  await setKarma(siblingArbiter.id, 150);
  m1 = await t.member('Sibling B Labs', 'sibling-b', { uain: false });
  m2 = await t.member('Sibling C Labs', 'sibling-c', { uain: false });
  for (const m of [m1, m2]) await setKarma(m.id, 150);
  def = await t.member('Sibling D Labs', 'sibling-default', { uain: false });
  await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
  arbiter = await t.member('Sibling E Labs', 'sibling-arbiter', { uain: false });
  await t.db.setArbiterTrust({ participant: arbiter.id, trusted: true, by: 'operator:test' });
  await setKarma(arbiter.id, 150);
  const r = await lead.call('uain_propose', {
    title: 'Sibling checks',
    summary: 'Work checked only by members other than its author’s.',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  p = r.project;
  for (const m of [author, sibling, siblingArbiter, m1, m2, def, arbiter])
    assert.equal((await m.call('uain_join_project', { project_id: p.id })).error, undefined);
});
after(async () => {
  await t.close();
});

const work = async () => {
  const r = await author.call('uain_contribute', {
    project_id: p.id,
    title: 'Measured value',
    detail: 'Recomputed it from the pinned inputs.',
    karma_claimed: 10,
  });
  assert.equal(r.submitted, true, JSON.stringify(r));
  return r.contribution;
};
const check = (who, id, verdict = 'confirmed', extra = {}) =>
  who.call('uain_verify', { contribution_id: id, verdict, note: 'Re-ran it.', ...extra });
const sorted = (ids) => [...ids].sort((x, y) => x.localeCompare(y));
/** Who was paid a verifier share of a settlement. */
const sharedBy = (done) => sorted(done.verifier_credits.map((s) => s.verifier));
/** The verify items this agent's menu offers on one contribution. */
const offered = async (who, id) =>
  (await who.call('uain_next', { project_id: p.id, limit: 50 })).items.filter(
    (i) => i.contribution_id === id,
  );
/**
 * Put a check on the record as a server before 30 September 2026 could, and
 * move the project's version so no server reads it from memory without it.
 */
async function recordedBefore(contributionId, verifier, verdict = 'confirmed', extra = {}) {
  await t.db
    .prepare(
      'INSERT INTO verifications (contribution_id, verifier, verdict, note, at, novelty, novelty_checked) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      contributionId, verifier, verdict, 'Re-ran it.', new Date().toISOString(),
      extra.novelty ?? null, extra.novelty_checked ? JSON.stringify(extra.novelty_checked) : null,
    );
  await t.db.prepare('SELECT bump_versions(?::jsonb)').get(JSON.stringify([p.id]));
}

describe('agents of one member never check each other', () => {
  test('a sibling is refused same_member, as default verifier or trusted arbiter', async () => {
    const w = await work();
    for (const who of [sibling, siblingArbiter]) {
      const r = await check(who, w.id);
      assert.equal(r.verified, false);
      assert.equal(r.error, 'same_member', JSON.stringify(r));
      assert.match(r.message, /Another agent of your member/);
      assert.equal((await check(who, w.id, 'disputed')).error, 'same_member');
    }
    // A novelty attestation too: the broader refusal replaces
    // novelty_not_independent, which refused only that.
    const attested = await check(sibling, w.id, 'confirmed', {
      novelty: 'new',
      novelty_checked: ['Google Scholar: measured value', 'GitHub: measured value'],
    });
    assert.equal(attested.error, 'same_member');
    // The contributor itself keeps its own refusal.
    assert.equal((await check(author, w.id)).error, 'self_verification_refused');
    assert.equal((await t.db.getContribution(w.id)).verifications.length, 0);
  });

  test('a sibling is never offered the check, before or after the member checks are in', async () => {
    const w = await work();
    assert.deepEqual(await offered(sibling, w.id), []);
    assert.deepEqual(await offered(siblingArbiter, w.id), []);
    assert.equal((await offered(def, w.id)).length, 1);
    assert.equal((await check(m1, w.id)).still_needed, 1);
    const second = await check(m2, w.id);
    assert.equal(second.awaiting_default_verifier, true, JSON.stringify(second));
    // The double-check goes to a default verifier of another member only.
    assert.deepEqual(await offered(sibling, w.id), []);
    assert.equal((await offered(def, w.id))[0]?.default_verifier_check, true);
    assert.equal((await check(def, w.id)).settled, true);
  });

  test('a check by another member settles as before', async () => {
    const w = await work();
    const one = await check(m1, w.id);
    assert.equal(one.settled, false);
    assert.equal(one.still_needed, 1);
    const two = await check(m2, w.id);
    assert.equal(two.settled, false);
    assert.equal(two.awaiting_default_verifier, true);
    const done = await check(def, w.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.independent_operators, 3);
    assert.equal(done.contribution.karma_awarded, 10);
    assert.deepEqual(sharedBy(done), sorted([m1.id, m2.id, def.id]));
    // A default verifier among the member checks still settles it at once.
    const quick = await work();
    await check(m1, quick.id);
    assert.equal((await check(def, quick.id)).settled, true);
  });
});

describe('sibling checks already on the record count for nothing', () => {
  test('a sibling default verifier’s confirmation settles nothing, and the work settles on other members’ checks', async () => {
    const w = await work();
    await recordedBefore(w.id, sibling.id, 'confirmed', {
      novelty: 'new',
      novelty_checked: ['Google Scholar: measured value', 'GitHub: measured value'],
    });
    const kept = await t.db.getContribution(w.id);
    const own = kept.verifications.find((v) => v.verifier === sibling.id);
    assert.equal(own.same_member, true);
    assert.equal(own.independent, false);
    assert.equal(kept.novelty, 'unattested', 'it attests nothing about its own member’s work');

    // Offered to other members as though nobody had checked it, and never to
    // the author's member.
    const item = (await offered(m1, w.id))[0];
    assert.match(item?.why ?? '', /^2 more verifier/, JSON.stringify(item));
    assert.equal(item.needed, 2);
    assert.equal(item.default_verifier_check, undefined);
    assert.deepEqual(await offered(siblingArbiter, w.id), []);

    // Before the rule, this check made two, one of them a default verifier's,
    // and the work settled on it.
    const first = await check(m1, w.id);
    assert.equal(first.settled, false, JSON.stringify(first));
    assert.equal(first.still_needed, 1);
    assert.equal(first.awaiting_default_verifier, undefined);
    assert.equal((await t.db.getContribution(w.id)).state, 'held');

    // A second member's check, then the double-check by a default verifier of
    // another member.
    const second = await check(m2, w.id);
    assert.equal(second.settled, false);
    assert.equal(second.awaiting_default_verifier, true, JSON.stringify(second));
    assert.equal((await offered(def, w.id))[0]?.default_verifier_check, true);
    assert.deepEqual(await offered(sibling, w.id), []);
    const done = await check(def, w.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.independent_operators, 3);
    assert.equal(done.contribution.karma_awarded, 10);

    // The sibling's check stays on the record, and earns no share or karma.
    assert.ok(done.contribution.verifications.some((v) => v.verifier === sibling.id && v.same_member));
    assert.deepEqual(sharedBy(done), sorted([m1.id, m2.id, def.id]));
    assert.equal((await sibling.call('uain_whoami')).participant.credits, 0);
    assert.equal((await t.db.getParticipant(sibling.id)).karma, 0);
  });

  test('a sibling’s arbitration decides nothing: an arbiter of another member does', async () => {
    const w = await work();
    await check(m1, w.id);
    assert.equal((await check(m2, w.id, 'disputed')).contested, true);
    await recordedBefore(w.id, siblingArbiter.id, 'confirmed');

    // Still contested: the default verifier's check is not yet the one that
    // releases it, and it may not arbitrate.
    assert.deepEqual(await offered(def, w.id), []);
    assert.equal((await check(def, w.id)).error, 'arbiter_not_proven');
    assert.equal((await t.db.getContribution(w.id)).state, 'contested');

    assert.equal((await offered(arbiter, w.id))[0]?.arbiter, true);
    const ruled = await check(arbiter, w.id);
    assert.equal(ruled.awaiting_default_verifier, true, JSON.stringify(ruled));
    const done = await check(def, w.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.arbitrated, true);
    assert.ok(!done.verifier_credits.some((s) => s.verifier === siblingArbiter.id));
  });
});

describe('arbitration, comparisons and prior-art challenges', () => {
  test('a sibling may not arbitrate contested work, trusted arbiter included, nor is it offered', async () => {
    const w = await work();
    await check(m1, w.id);
    assert.equal((await check(m2, w.id, 'disputed')).contested, true);
    for (const who of [siblingArbiter, sibling]) {
      assert.deepEqual(await offered(who, w.id), []);
      assert.equal((await check(who, w.id)).error, 'same_member');
      assert.equal((await check(who, w.id, 'disputed')).error, 'same_member');
    }
    assert.equal((await offered(arbiter, w.id))[0]?.arbiter, true);
    const ruled = await check(arbiter, w.id);
    assert.equal(ruled.awaiting_default_verifier, true, JSON.stringify(ruled));
    // Nor does a sibling give the default verifier's check after arbitration.
    assert.deepEqual(await offered(sibling, w.id), []);
    assert.equal((await check(sibling, w.id)).error, 'same_member');
    assert.equal((await offered(def, w.id))[0]?.default_verifier_check, true);
    const done = await check(def, w.id);
    assert.equal(done.settled, true, JSON.stringify(done));
  });

  test('nobody checks a comparison of its member’s result, default verifiers included', async () => {
    const k = (
      await lead.call('uain_task_open', {
        project_id: p.id,
        title: 'Two answers',
        question: 'What does the registry say?',
        done_when: 'Two answers, compared',
        how_to_check: 'Look it up',
        answers_wanted: 2,
      })
    ).task;
    const answer = async (who, claim) =>
      (
        await who.call('uain_contribute', {
          project_id: p.id,
          task_id: k.id,
          title: 'Registry entry',
          detail: 'Read the registry.',
          claim,
        })
      ).contribution;
    const ra = await answer(author, 'The registry says yes.');
    const rb = await answer(m1, 'The registry says no.');
    const cmp = await m2.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [ra.id, rb.id],
      title: 'Comparison',
      detail: 'Read both.',
      claim: 'They read different registry entries.',
    });
    assert.equal(cmp.submitted, true, JSON.stringify(cmp));
    const id = cmp.contribution.id;
    // A default verifier and a trusted arbiter of the member whose result it
    // compares: before, both were exempt.
    for (const who of [sibling, siblingArbiter]) {
      assert.deepEqual(await offered(who, id), []);
      const r = await check(who, id);
      assert.equal(r.error, 'compares_your_result', JSON.stringify(r));
      assert.deepEqual(r.yours, [ra.id]);
    }
    // A default verifier of a member with no result in it checks it.
    assert.equal((await offered(def, id)).length, 1);
    assert.equal((await check(def, id)).verified, true);
  });

  test('a prior-art challenge is decided by a member other than the challenger’s', async () => {
    const k = (
      await lead.call('uain_task_open', {
        project_id: p.id,
        title: 'Already solved?',
        question: 'What is the digest?',
        done_when: 'A digest is reported',
        how_to_check: 'Recompute it',
      })
    ).task;
    const filed = await t.db.challengePriorArt({
      challenger: author.id,
      taskId: k.id,
      source: 'https://example.org/solved',
      note: 'Table 2 gives the digest for this very sample.',
    });
    assert.ok(filed.challenge, JSON.stringify(filed));
    const decide = (who, decision) =>
      who.call('uain_task_prior_art_decide', {
        challenge_id: filed.challenge.id,
        decision,
        note: 'Table 2 is a different sample: its digest is not this one.',
      });
    const judges = async (who) =>
      (await who.call('uain_next', { project_id: p.id, limit: 50 })).items.some(
        (i) => i.kind === 'prior_art_challenge' && i.challenge_id === filed.challenge.id,
      );
    for (const who of [sibling, siblingArbiter]) {
      assert.equal(await judges(who), false);
      assert.equal((await decide(who, 'upheld')).error, 'judge_not_independent');
    }
    assert.equal(await judges(def), true);
    const rejected = await decide(def, 'rejected');
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.equal(rejected.challenge.state, 'rejected');
  });
});
