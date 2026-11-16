/**
 * Follow-ups to the fixes in docs/federation/reconciliation.md section 4.
 * An operator's revocation goes on the ledger under the operator (#14's
 * rule). Settlement keeps what is owed to a revoked member or a withdrawn
 * agent deferred, as release-deferred does (#11). A halted or complete
 * project takes no claim drafts or reviews, as it takes no tasks, answers or
 * checks, and new work that reopens a finished project must fit its lead's
 * allowance, as a task must (#13). And a member does not check a rival of
 * its own answer, nor a comparison of its own result.
 *
 * Nobody here is one of UAIN's own agents unless a test names it one, so the
 * default verifier below is the only one on the network.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boot } from './helpers.mjs';

/** Run an operator maintenance action on this test's store, as the workflow does. */
const maintenance = (env) =>
  promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url))],
    { env: { ...process.env, OPERATOR_ID: '', ...env } },
  );

let t;
let lead;
let def;
let arb;
let a;
let b;

const STOP = ['Halt if the work would require restricted data.'];
const setKarma = (id, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, id);
const propose = (who, title = `P ${Math.random().toString(36).slice(2, 8)}`) =>
  who.call('uain_propose', { title, summary: 's', stop_conditions: STOP });
const join = (who, p) => who.call('uain_join_project', { project_id: p.id });
const verdict = (who, id, v = 'confirmed', note = 'Checked.') =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note });
const task = (who, p, title = 'Q') =>
  who.call('uain_task_open', {
    project_id: p.id,
    title,
    question: 'What does the registry say?',
    done_when: 'The registry entry, cited',
    how_to_check: 'Look it up',
  });
const answer = (who, p, k, claim = 'The registry says so.') =>
  who.call('uain_contribute', {
    project_id: p.id,
    task_id: k.id,
    title: 'Answer',
    detail: 'Looked it up.',
    karma_claimed: 5,
    claim,
  });
const work = (who, p, extra = {}) =>
  who.call('uain_contribute', {
    project_id: p.id,
    title: 'w',
    detail: 'x',
    karma_claimed: 1,
    ...extra,
  });
const createClaim = (who, p, sources) =>
  who.call('uain_claim_create', {
    project_id: p.id,
    statement: 'Both results say the same.',
    sources,
    reason: 'Read together.',
  });
const editClaim = (who, claim, sources) =>
  who.call('uain_claim_edit', {
    claim_id: claim.id,
    base_revision: claim.believed_revision,
    statement: 'The registry says so, twice.',
    sources,
    reason: 'A second result.',
  });
const retractClaim = (who, claim, sources) =>
  who.call('uain_claim_retract', {
    claim_id: claim.id,
    base_revision: claim.believed_revision,
    sources,
    reason: 'Another result says otherwise.',
  });
const review = (who, revision, v = 'confirm') =>
  who.call('uain_claim_review', { revision_id: revision, verdict: v, note: 'Checked the cited work.' });
const count = async (sql, ...args) => Number((await t.db.prepare(sql).get(...args)).n);

before(async () => {
  t = await boot();
  lead = await t.member('Next Lead Co', 'next-lead', { uain: false });
  await t.db.setUainRole({ participant: lead.id, role: 'project-creator', on: true, by: 'operator:test' });
  def = await t.member('Next Default Co', 'next-default', { uain: false });
  await t.db.setUainRole({ participant: def.id, role: 'default-verifier', on: true, by: 'operator:test' });
  arb = await t.member('Next Arbiter Co', 'next-arbiter', { uain: false });
  await setKarma(arb.id, 150);
  await t.db.setArbiterTrust({ participant: arb.id, trusted: true, by: 'operator:test' });
  a = await t.member('Next A Co', 'next-a', { uain: false });
  b = await t.member('Next B Co', 'next-b', { uain: false });
  await setKarma(a.id, 150);
  await setKarma(b.id, 150);
});
after(async () => {
  await t.close();
});

/**
 * A project of `owner` whose work is all done: a task answered, its claim
 * believed, and one more settled contribution, citable as new evidence.
 */
async function finishedProject(owner) {
  const p = (await propose(owner)).project;
  for (const m of [def, a, b]) await join(m, p);
  const k = (await task(owner, p)).task;
  const ans = (await answer(a, p, k)).contribution;
  await verdict(b, ans.id);
  const settled = await verdict(def, ans.id);
  assert.equal(settled.settled, true, JSON.stringify(settled));
  assert.equal(settled.claim.status, 'believed', JSON.stringify(settled.claim));
  const extra = (await work(b, p, { verifiers_required: 1 })).contribution;
  assert.equal((await verdict(def, extra.id)).settled, true);
  const claim = await owner.call('uain_claims', { claim_id: settled.claim.id });
  assert.equal((await t.db.getProject(p.id)).progress.status, 'finished');
  return { p, k, ans, extra, claim };
}

describe('revoke-licence', () => {
  test('goes on the ledger under the operator, with the member as its peer; one at -10 stays under the member', async () => {
    const target = await t.member('Revoke Target Co', 'revoke-target', { uain: false });
    const licence = async () => (await t.db.getParticipant(target.id)).member.licence;
    const basis = 'Broke a rule outside what karma measures.';

    // Only under an operator's name, as every other operator action.
    for (const OPERATOR_ID of ['', 'someone', 'operator'])
      await assert.rejects(
        maintenance({ ACTION: 'revoke-licence', PARTICIPANT: target.id, BASIS: basis, OPERATOR_ID }),
        /OPERATOR_ID/,
        `OPERATOR_ID=${JSON.stringify(OPERATOR_ID)}`,
      );
    assert.equal((await licence()).status, 'active');

    const out = await maintenance({
      ACTION: 'revoke-licence',
      PARTICIPANT: target.id,
      BASIS: basis,
      OPERATOR_ID: 'operator:test',
    });
    assert.match(out.stdout, /"revoked":true/);
    assert.equal((await licence()).status, 'revoked');
    assert.equal((await licence()).reason, basis, 'the reason is the reason; the ledger names who');
    const entry = await t.db
      .prepare("SELECT actor, peer, summary FROM events WHERE kind = 'licence' AND (actor = ? OR peer = ?) ORDER BY id DESC LIMIT 1")
      .get(target.id, target.id);
    assert.deepEqual(
      { actor: entry.actor, peer: entry.peer },
      { actor: 'operator:test', peer: target.id },
      JSON.stringify(entry),
    );
    assert.match(entry.summary, /licence was revoked: Broke a rule outside what karma measures\.$/);

    // Nobody decides a revocation at -10: it stays under the member's own agent.
    const grief = await t.member('Revoke Grief Co', 'revoke-grief', { uain: false });
    await t.db.setUainRole({ participant: grief.id, role: 'default-verifier', on: true, by: 'operator:test' });
    await setKarma(grief.id, -9);
    const p = (await propose(lead)).project;
    for (const m of [grief, def, arb, a]) await join(m, p);
    const sub = (await work(a, p)).contribution;
    assert.equal((await verdict(grief, sub.id, 'disputed')).contested, true);
    assert.equal((await verdict(arb, sub.id)).awaiting_default_verifier, true);
    assert.equal((await verdict(def, sub.id)).settled, true);
    assert.equal((await t.db.getParticipant(grief.id)).member.licence.status, 'revoked');
    const auto = await t.db
      .prepare("SELECT actor, peer, summary FROM events WHERE kind = 'licence' AND actor = ? ORDER BY id DESC LIMIT 1")
      .get(grief.id);
    assert.equal(auto?.peer, null, JSON.stringify(auto));
    assert.match(auto.summary, /licence was revoked: karma fell to -11, at or below -10$/);
  });
});

describe('settlement', () => {
  test('keeps what is owed to revoked members and withdrawn agents deferred, as release-deferred does', async () => {
    const p = (await propose(lead)).project;
    const rogue = await t.member('Pay Rogue Co', 'pay-rogue', { uain: false });
    const leaver = await t.member('Pay Leaver Co', 'pay-leaver', { uain: false });
    const checker = await t.member('Pay Checker Co', 'pay-checker', { uain: false });
    await setKarma(checker.id, 150);
    for (const m of [rogue, leaver, checker, a, def]) await join(m, p);

    // Work of 20 each, checked by two members, waiting for the default verifier.
    const owed = {};
    for (const who of [rogue, leaver, lead]) {
      const sub = (await work(who, p, { karma_claimed: 20 })).contribution;
      await verdict(a, sub.id);
      assert.equal((await verdict(checker, sub.id)).awaiting_default_verifier, true);
      owed[who.id] = sub.id;
    }
    await t.db.revokeLicence(rogue.id, 'test: broke a rule', 'operator:test');
    await t.db.revokeLicence(checker.id, 'test: broke a rule', 'operator:test');
    assert.equal((await leaver.call('uain_withdraw')).withdrawn, true);

    const credits = async (m) => (await t.db.getParticipant(m.id)).credits;
    const had = { a: await credits(a), def: await credits(def) };
    const issued = await t.db.issuedLast24h();
    const done = {};
    for (const who of [rogue, leaver, lead]) {
      done[who.id] = await verdict(def, owed[who.id]);
      assert.equal(done[who.id].settled, true, JSON.stringify(done[who.id]));
      assert.equal(done[who.id].contribution.credits_awarded, 20);
    }

    // The contributor's 20 and the checker's share are kept back, and said so.
    // A share of 4 among three checks: 2 to the earliest, 1 each to the rest.
    assert.equal(done[rogue.id].credits_minted, 0);
    assert.equal(done[rogue.id].credits_deferred, 20);
    assert.deepEqual(done[rogue.id].credits_withheld, [
      { participant: rogue.id, amount: 20, reason: 'licence_revoked' },
      { participant: checker.id, amount: 1, reason: 'licence_revoked' },
    ]);
    assert.deepEqual(done[leaver.id].credits_withheld, [
      { participant: leaver.id, amount: 20, reason: 'withdrawn' },
      { participant: checker.id, amount: 1, reason: 'licence_revoked' },
    ]);
    assert.equal(done[lead.id].credits_minted, 20);
    assert.deepEqual(done[lead.id].credits_withheld, [
      { participant: checker.id, amount: 1, reason: 'licence_revoked' },
    ]);

    for (const m of [rogue, leaver, checker]) assert.equal(await credits(m), 0, `${m.id}: nothing minted`);
    assert.equal(await credits(lead), 20);
    assert.equal(await credits(a), had.a + 6);
    assert.equal(await credits(def), had.def + 3);
    assert.equal(await t.db.issuedLast24h(), issued + 29, 'what is kept back spends none of the ceiling');
    // Credibility is the record of verified work, and is kept as before.
    assert.equal((await t.db.getParticipant(rogue.id)).karma, 20);
    assert.equal((await t.db.getParticipant(leaver.id)).karma, 20);

    const kept = await t.db
      .prepare("SELECT summary FROM events WHERE kind = 'karma' AND actor = ? ORDER BY id")
      .all(rogue.id);
    assert.ok(
      kept.some((e) => e.summary === `20 credits for ${owed[rogue.id]} stay deferred: its recipient's licence is revoked`),
      JSON.stringify(kept),
    );

    // Still owed, on the record, and release-deferred keeps them back too.
    const r = await t.db.releaseDeferred({ by: 'operator:test' });
    const mine = r.skipped.filter((s) => Object.values(owed).includes(s.contribution_id));
    assert.deepEqual(
      mine.map((s) => [s.participant, s.contribution_id, s.amount, s.reason]),
      [
        [rogue.id, owed[rogue.id], 20, 'licence_revoked'],
        [checker.id, owed[rogue.id], 1, 'licence_revoked'],
        [leaver.id, owed[leaver.id], 20, 'withdrawn'],
        [checker.id, owed[leaver.id], 1, 'licence_revoked'],
        [checker.id, owed[lead.id], 1, 'licence_revoked'],
      ],
    );
    for (const m of [rogue, leaver, checker]) assert.equal(await credits(m), 0);
  });
});

describe('claims in a halted or complete project', () => {
  test('a halted project takes no new drafts or reviews; a draft from before waits until it resumes', async () => {
    const { p, ans, extra, claim } = await finishedProject(lead);
    const other = (await work(a, p, { verifiers_required: 1 })).contribution;
    assert.equal((await verdict(def, other.id)).settled, true);
    const draft = await createClaim(lead, p, [extra.id, other.id]);
    assert.ok(draft.revision, JSON.stringify(draft));

    const halted = await lead.call('uain_project_halt', {
      project_id: p.id,
      condition: STOP[0],
      reason: 'The next step needs patient records.',
    });
    assert.equal(halted.halted, true, JSON.stringify(halted));
    const revisions = await count('SELECT COUNT(*) AS n FROM claim_revisions');
    const reviews = await count('SELECT COUNT(*) AS n FROM claim_reviews');

    for (const [what, r] of [
      ['create', await createClaim(lead, p, [ans.id, extra.id])],
      ['edit', await editClaim(a, claim, [extra.id])],
      ['retract', await retractClaim(b, claim, [other.id])],
      ['review', await review(a, draft.revision)],
    ]) {
      assert.equal(r.ok, false, `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.error, 'project_closed', what);
      assert.equal(r.state, 'halted', what);
      assert.match(r.message, /halted or complete/, what);
    }
    assert.equal(await count('SELECT COUNT(*) AS n FROM claim_revisions'), revisions);
    assert.equal(await count('SELECT COUNT(*) AS n FROM claim_reviews'), reviews);

    // Resumed, the draft is reviewed where it was left.
    assert.equal((await lead.call('uain_project_resume', { project_id: p.id, reason: 'Not needed after all.' })).resumed, true);
    assert.equal((await review(a, draft.revision)).outcome, 'recorded');
    assert.equal((await review(b, draft.revision)).outcome, 'believed');
  });

  test('a complete project takes no new drafts', async () => {
    const { p, ans, extra, claim } = await finishedProject(lead);
    const done = await lead.call('uain_project_complete', { project_id: p.id, reason: 'done_when is met.' });
    assert.equal(done.completed, true, JSON.stringify(done));
    for (const [what, r] of [
      ['create', await createClaim(lead, p, [ans.id, extra.id])],
      ['edit', await editClaim(a, claim, [extra.id])],
      ['retract', await retractClaim(b, claim, [extra.id])],
    ]) {
      assert.equal(r.error, 'project_closed', `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.state, 'complete', what);
    }
    assert.equal((await t.db.getProject(p.id)).progress.label, 'Complete');
  });
});

describe("new work on a finished project and its lead's allowance", () => {
  test('an answer, with a task or without, or a claim draft must fit the allowance, as a task must', async () => {
    const m = await t.member('Reopen Work Co', 'reopen-work', { uain: false });
    await setKarma(m.id, 1000);
    const { p: first, k, ans, extra, claim } = await finishedProject(m);
    await setKarma(m.id, 1000);

    // The finished project frees its place, and a second takes it.
    const second = await propose(m);
    assert.equal(second.opened, true, JSON.stringify(second));

    // Any of these would make the first run again, and make two.
    for (const [what, r] of [
      ['work with no task', await work(m, first)],
      ['work by another member', await work(a, first)],
      ['a second answer to its answered task', await answer(b, first, k)],
      ['a claim', await createClaim(m, first, [ans.id, extra.id])],
      ['an edit', await editClaim(a, claim, [extra.id])],
      ['a retraction', await retractClaim(b, claim, [extra.id])],
    ]) {
      assert.equal(r.error, 'project_limit_reached', `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.allowed, 1, what);
      assert.deepEqual(r.running, [second.project.id], what);
      assert.equal(r.lead, m.id, what);
      assert.match(r.message, /allows/, what);
    }
    assert.equal((await t.db.getProject(first.id)).progress.status, 'finished');
    assert.deepEqual(await t.db.runningProjects(m.id), [second.project.id]);

    // With room for two, the first takes work again.
    await setKarma(m.id, 1010);
    assert.equal((await work(a, first)).submitted, true);
    assert.equal((await t.db.getProject(first.id)).progress.status, 'in_progress');
  });
});

describe('checks by a member with a stake in the task', () => {
  const checksOffered = async (who, p) =>
    (await who.call('uain_next', { project_id: p.id, limit: 50 })).items
      .filter((i) => i.kind === 'verify')
      .map((i) => i.contribution_id);

  test('a member that answered a task is neither offered nor allowed a check of a rival answer', async () => {
    const p = (await propose(lead)).project;
    const x = await t.member('Stake X Co', 'stake-x', { uain: false });
    const y = await t.member('Stake Y Co', 'stake-y', { uain: false });
    const w = await t.member('Stake W Co', 'stake-w', { uain: false });
    for (const m of [x, y, w]) await setKarma(m.id, 150);
    const sibling = await t.instance(x.key, 'Stake X Co', 'stake-x-two', { uain: false });
    for (const m of [x, y, w, sibling, def]) await join(m, p);
    const k = (await task(lead, p)).task;
    const mine = (await answer(x, p, k, 'The registry says yes.')).contribution;
    const rival = (await answer(y, p, k, 'The registry says no.')).contribution;

    // Counted by member: another agent of the member that answered is refused too.
    for (const who of [x, sibling]) {
      assert.ok(!(await checksOffered(who, p)).includes(rival.id), `${who.id} is offered the rival`);
      const r = await verdict(who, rival.id);
      assert.equal(r.error, 'answered_this_task', JSON.stringify(r));
      assert.deepEqual(r.yours, [mine.id]);
      assert.match(r.message, /also answered this task/);
    }
    assert.equal((await verdict(y, mine.id)).error, 'answered_this_task');

    // A member with no answer of its own checks either, and so does UAIN's default verifier.
    assert.ok((await checksOffered(w, p)).includes(rival.id));
    assert.equal((await verdict(w, rival.id)).verified, true);
    assert.ok((await checksOffered(def, p)).includes(rival.id));
    assert.equal((await verdict(def, rival.id)).settled, true);
  });

  test('a member is neither offered nor allowed a check of a comparison of its own result', async () => {
    const p = (await propose(lead)).project;
    const people = [];
    for (const name of ['x', 'y', 'z', 'w']) {
      const m = await t.member(`Compare ${name.toUpperCase()} Co`, `compare-${name}`, { uain: false });
      await setKarma(m.id, 150);
      await join(m, p);
      people.push(m);
    }
    const [cx, cy, cz, cw] = people;
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
    const rx = (await answer(cx, p, k, 'The registry says yes.')).contribution;
    const ry = (await answer(cy, p, k, 'The registry says no.')).contribution;
    const cmp = await cz.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [rx.id, ry.id],
      title: 'Comparison',
      detail: 'Read both.',
      claim: 'They read different registry entries.',
    });
    assert.equal(cmp.submitted, true, JSON.stringify(cmp));
    const id = cmp.contribution.id;

    assert.ok(!(await checksOffered(cx, p)).includes(id));
    const r = await verdict(cx, id);
    assert.equal(r.error, 'compares_your_result', JSON.stringify(r));
    assert.deepEqual(r.yours, [rx.id]);
    assert.match(r.message, /compares a result by you/);

    assert.ok((await checksOffered(cw, p)).includes(id));
    assert.equal((await verdict(cw, id)).verified, true);
  });

  test('two agents of one member do not count as two comparison results', async () => {
    const p = (await propose(lead)).project;
    const author = await t.member('Compare Siblings Co', 'compare-siblings', { uain: false });
    const sibling = await t.instance(author.key, 'Compare Siblings Co', 'compare-siblings-two', { uain: false });
    const comparer = await t.member('Compare Outsider Co', 'compare-outsider', { uain: false });
    for (const who of [author, sibling, comparer]) await join(who, p);
    const k = (await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Independent answers',
      question: 'What does the registry say?',
      done_when: 'Two independent answers, compared',
      how_to_check: 'Look it up',
      answers_wanted: 2,
    })).task;
    const first = (await answer(author, p, k, 'The first reading.')).contribution;
    const second = (await answer(sibling, p, k, 'The second reading.')).contribution;
    const compared = await comparer.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [first.id, second.id],
      title: 'Comparison',
      detail: 'Read both.',
      claim: 'The readings differ.',
    });
    assert.equal(compared.error, 'results_from_one_member', JSON.stringify(compared));
  });

  test('a sibling of an answerer cannot author a comparison of that answer', async () => {
    const p = (await propose(lead)).project;
    const author = await t.member('Compare Author Co', 'compare-author', { uain: false });
    const sibling = await t.instance(author.key, 'Compare Author Co', 'compare-author-two', { uain: false });
    const other = await t.member('Compare Other Co', 'compare-other', { uain: false });
    for (const who of [author, sibling, other]) await join(who, p);
    const k = (await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Independent answers',
      question: 'What does the registry say?',
      done_when: 'Two independent answers, compared',
      how_to_check: 'Look it up',
      answers_wanted: 2,
    })).task;
    const first = (await answer(author, p, k, 'The first reading.')).contribution;
    const second = (await answer(other, p, k, 'The second reading.')).contribution;
    const compared = await sibling.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [first.id, second.id],
      title: 'Comparison',
      detail: 'Read both.',
      claim: 'The readings differ.',
    });
    assert.equal(compared.error, 'cannot_compare_own_result', JSON.stringify(compared));
    assert.match(compared.message, /Your member wrote one of these results/);
  });

  test('two members of one operator still count as separate comparison results', async () => {
    const p = (await propose(lead)).project;
    const firstAuthor = await t.member('Shared Compare Operator', 'shared-compare-one', { uain: false });
    const secondAuthor = await t.member('Shared Compare Operator', 'shared-compare-two', { uain: false });
    const comparer = await t.member('Independent Compare Operator', 'shared-compare-reader', { uain: false });
    for (const who of [firstAuthor, secondAuthor, comparer]) await join(who, p);
    const k = (await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Independent members',
      question: 'What does the registry say?',
      done_when: 'Two member answers, compared',
      how_to_check: 'Look it up',
      answers_wanted: 2,
    })).task;
    const first = (await answer(firstAuthor, p, k, 'The first reading.')).contribution;
    const second = (await answer(secondAuthor, p, k, 'The second reading.')).contribution;
    const compared = await comparer.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [first.id, second.id],
      title: 'Comparison',
      detail: 'Read both.',
      claim: 'The readings differ.',
    });
    assert.equal(compared.submitted, true, JSON.stringify(compared));
  });
});
