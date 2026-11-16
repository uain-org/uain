/**
 * What a bad agent can and cannot do. Started from a simulation on
 * 2026-09-28: gibberish answers, spam, fake sources, and free disputes of other
 * members' claims. Each test pins down a guard, so a later change cannot
 * quietly open the gap again.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
  const sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
});
after(async () => {
  const sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const project = async (lead) =>
  (
    await lead.call('uain_propose', {
      title: `Abuse ${Math.random().toString(36).slice(2, 8)}`,
      summary: 's',
      stop_conditions: STOP,
    })
  ).project;
const open = async (lead, pid, extra = {}) =>
  (
    await lead.call('uain_task_open', {
      project_id: pid,
      title: `T ${Math.random().toString(36).slice(2, 6)}`,
      question: 'q',
      done_when: 'd',
      how_to_check: 'c',
      ...extra,
    })
  ).task;
const join = (ms, pid) =>
  Promise.all(ms.map((m) => m.call('uain_join_project', { project_id: pid })));
const answer = (who, pid, tid, extra = {}) =>
  who.call('uain_contribute', {
    project_id: pid,
    task_id: tid,
    title: 'Answer',
    detail: 'd',
    claim: 'What the answer establishes.',
    ...extra,
  });
const verify = (who, id, verdict, extra = {}) =>
  who.call('uain_verify', {
    contribution_id: id,
    verdict,
    note: 'Checked.',
    ...extra,
  });
const setKarma = (m, karma) =>
  t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?').run(karma, m.id);
const karmaOf = async (m) =>
  (await t.db.prepare('SELECT karma FROM participants WHERE id = ?').get(m.id))
    .karma;
const makeT2 = (m) =>
  t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(m.id);

/**
 * A project where the bad agent and every checker are ordinary members (no
 * UAIN role), each from its own operator, plus one UAIN default verifier.
 */
async function arena() {
  const lead = await t.member('Arena Lead');
  const bad = await t.member('Bad Op', undefined, { uain: false });
  const v1 = await t.member('V1 Op', undefined, { uain: false });
  const judge = await t.member('Judge Op', undefined, { uain: false });
  const dv = await t.member('Default Op');
  const p = await project(lead);
  await join([bad, v1, judge, dv], p.id);
  await makeT2(judge);
  for (const m of [v1, judge]) await setKarma(m, 500);
  return { lead, bad, v1, judge, dv, p };
}

describe('a rejected answer', () => {
  test('costs nothing when it shows effort', async () => {
    const { lead, bad, v1, judge, p } = await arena();
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id, { detail: 'A real but wrong attempt.' });
    await verify(v1, sub.contribution.id, 'disputed', { note: 'The dose is wrong.' });
    const r = await verify(judge, sub.contribution.id, 'disputed', { note: 'Agreed.' });
    assert.equal(r.disputed, true);
    assert.equal(await karmaOf(bad), 0);
  });

  test('costs 2 karma when the arbiter finds no effort in it', async () => {
    const { lead, bad, v1, judge, p } = await arena();
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id, { detail: 'qwerty asdf', claim: 'Bananas cure everything.' });
    await verify(v1, sub.contribution.id, 'disputed', { note: 'Gibberish.' });
    const r = await verify(judge, sub.contribution.id, 'disputed', {
      note: 'No attempt at the question.',
      no_effort: true,
    });
    assert.equal(r.disputed, true);
    assert.equal(await karmaOf(bad), -2);
  });

  test('only an arbiter may say no effort, and only when rejecting', async () => {
    const { lead, bad, v1, judge, p } = await arena();
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id);
    const first = await verify(v1, sub.contribution.id, 'disputed', { no_effort: true });
    assert.equal(first.error, 'no_effort_not_yours');
    await verify(v1, sub.contribution.id, 'disputed');
    const wrong = await verify(judge, sub.contribution.id, 'confirmed', { no_effort: true });
    assert.equal(wrong.error, 'no_effort_needs_disputed');
  });

  test('repeated no-effort answers end in revocation at -10', async () => {
    const { lead, bad, v1, judge, p } = await arena();
    await setKarma(bad, -8);
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id);
    await verify(v1, sub.contribution.id, 'disputed');
    await verify(judge, sub.contribution.id, 'disputed', { no_effort: true });
    assert.equal(await karmaOf(bad), -10);
    const again = await answer(bad, p.id, (await open(lead, p.id)).id);
    assert.notEqual(again.submitted, true);
    assert.equal(again.error, 'not_authenticated', 'a revoked member acts no more');
    const m = await t.db
      .prepare('SELECT m.state FROM members m JOIN participants p ON p.member_id = m.id WHERE p.id = ?')
      .get(bad.id);
    assert.equal(m.state, 'revoked');
  });
});

describe('spam', () => {
  test('one held answer per agent per task', async () => {
    const { lead, bad, p } = await arena();
    const k = await open(lead, p.id);
    assert.equal((await answer(bad, p.id, k.id)).submitted, true);
    const second = await answer(bad, p.id, k.id);
    assert.equal(second.error, 'answer_already_held');
  });

  test('a cap on held contributions per agent per project', async () => {
    const { lead, bad, p } = await arena();
    const db = await import('../dist/src/application/db.js');
    const cap = db.MAX_HELD_PER_PROJECT;
    for (let i = 0; i < cap; i++)
      assert.equal((await answer(bad, p.id, (await open(lead, p.id)).id)).submitted, true);
    const over = await answer(bad, p.id, (await open(lead, p.id)).id);
    assert.equal(over.error, 'too_many_held');
    const free = await bad.call('uain_contribute', {
      project_id: p.id,
      title: 'Free work',
      detail: 'd',
    });
    assert.equal(free.error, 'too_many_held', 'the cap counts work with no task too');
  });

  test('a made-up registry identifier is refused at submission', async () => {
    const { lead, bad, p } = await arena();
    const sources = await import('../dist/src/integrations/sources.js');
    sources.setSourceFetcher(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { 999999999: { error: 'cannot get document summary' } } }),
    }));
    try {
      const k = await open(lead, p.id);
      const r = await answer(bad, p.id, k.id, { sources: ['PMID 999999999'] });
      assert.equal(r.error, 'source_not_found');
    } finally {
      sources.setSourceFetcher(null);
    }
  });
});

describe('claim reviews weigh as much as checks', () => {
  /**
   * A settled answer whose claim is a draft: its work was disputed and an
   * arbiter confirmed it, so the claim goes to review.
   */
  async function draft() {
    const lead = await t.member('Draft Lead');
    const w = await t.member('Draft W Op', undefined, { uain: false });
    const v = await t.member('Draft V');
    const j = await t.member('Draft J');
    const p = await project(lead);
    await join([w, v, j], p.id);
    await makeT2(j);
    const k = await open(lead, p.id);
    const sub = await answer(w, p.id, k.id, { claim: 'The line is open 24 hours.' });
    await verify(v, sub.contribution.id, 'disputed', { note: 'Not sure of the hours.' });
    const done = await verify(j, sub.contribution.id, 'confirmed', { note: 'It holds.' });
    assert.equal(done.claim.status, 'unconfirmed', 'once disputed, the claim goes to review');
    const claim = await lead.call('uain_claims', { claim_id: done.claim.id });
    return { lead, p, claimId: done.claim.id, revision: claim.history[0].revision };
  }
  const review = (who, revision, verdict, note = 'Checked.') =>
    who.call('uain_claim_review', { revision_id: revision, verdict, note });

  test('reviewing needs the same karma as checking', async () => {
    const { p, revision } = await draft();
    const poor = await t.member('Poor Op', undefined, { uain: false });
    await join([poor], p.id);
    const r = await review(poor, revision, 'dispute');
    assert.equal(r.error, 'karma_too_low_to_review');
    const menu = (await poor.call('uain_next', { project_id: p.id })).items;
    assert.ok(!menu.some((i) => i.kind === 'review_claim'), 'and it is not offered');
  });

  test('one dispute contests a draft instead of closing it', async () => {
    const { lead, p, claimId, revision } = await draft();
    const critic = await t.member('Critic Op', undefined, { uain: false });
    await join([critic], p.id);
    await setKarma(critic, 500);
    const r = await review(critic, revision, 'dispute', 'Too wide.');
    assert.equal(r.outcome, 'contested');
    const claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.status, 'unconfirmed', 'still under review, not dead');
    assert.equal(claim.history[0].state, 'contested');
  });

  test('an arbiter upholds the dispute: the draft is closed and offered for revision', async () => {
    const { lead, p, claimId, revision } = await draft();
    const critic = await t.member('Critic2 Op', undefined, { uain: false });
    const judge = await t.member('Judge2 Op', undefined, { uain: false });
    await join([critic, judge], p.id);
    await setKarma(critic, 500);
    await setKarma(judge, 500);
    await makeT2(judge);
    await review(critic, revision, 'dispute', 'Too wide.');
    const offer = (await judge.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'review_claim' && i.revision_id === revision,
    );
    assert.equal(offer?.arbiter, true, 'contested drafts are offered to arbiters');
    const r = await review(judge, revision, 'dispute', 'Agreed.');
    assert.equal(r.outcome, 'rejected');
    assert.equal((await lead.call('uain_claims', { claim_id: claimId })).status, 'rejected');
    const fix = (await lead.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'revise_claim' && i.revision_id === revision,
    );
    assert.ok(fix, 'offered for revision');
  });

  test('an arbiter overturns the dispute: the disputer pays, the draft is back in review', async () => {
    const { lead, p, claimId, revision } = await draft();
    const critic = await t.member('Critic3 Op', undefined, { uain: false });
    const judge = await t.member('Judge3 Op', undefined, { uain: false });
    const c1 = await t.member('Confirm1');
    const c2 = await t.member('Confirm2');
    await join([critic, judge, c1, c2], p.id);
    await setKarma(critic, 500);
    await setKarma(judge, 500);
    await makeT2(judge);
    await review(critic, revision, 'dispute', 'Spite.');
    const plain = await review(c1, revision, 'confirm');
    assert.equal(plain.error, 'awaiting_arbiter', 'while contested, only an arbiter may review');
    const r = await review(judge, revision, 'confirm', 'The sources support it.');
    assert.equal(r.outcome, 'recorded');
    assert.equal(await karmaOf(critic), 498);
    await review(c1, revision, 'confirm');
    const claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.status, 'believed', 'two confirmations: the arbiter and one more');
    assert.equal(c2.id.length > 0, true);
  });

  test('an arbiter must be independent of the author and the disputer', async () => {
    const { p, revision } = await draft();
    const critic = await t.member('Same Op', undefined, { uain: false });
    const judge = await t.member('Same Op', undefined, { uain: false });
    await join([critic, judge], p.id);
    await setKarma(critic, 500);
    await setKarma(judge, 500);
    await makeT2(judge);
    await review(critic, revision, 'dispute');
    const r = await review(judge, revision, 'dispute');
    assert.equal(r.error, 'arbiter_not_independent');
  });
});

describe('a belief changes only on settled evidence', () => {
  /** A project with one believed claim, and members to test it. */
  async function believed() {
    const lead = await t.member('Ev Lead');
    const a = await t.member('Ev A');
    const b = await t.member('Ev B');
    const v1 = await t.member('Ev V1');
    const v2 = await t.member('Ev V2');
    const r1 = await t.member('Ev R1');
    const r2 = await t.member('Ev R2');
    const p = await project(lead);
    await join([a, b, v1, v2, r1, r2], p.id);
    const k = await open(lead, p.id);
    const ra = await answer(a, p.id, k.id, { claim: 'Drug X cures most patients.' });
    await verify(v1, ra.contribution.id, 'confirmed');
    const done = await verify(v2, ra.contribution.id, 'confirmed');
    assert.equal(done.claim.status, 'believed');
    const claim = await lead.call('uain_claims', { claim_id: done.claim.id });
    return { lead, a, b, v1, v2, r1, r2, p, ra, claimId: done.claim.id, base: claim.believed_revision };
  }

  test('a task opened from a claim, whose answer refutes it, retracts it after review', async () => {
    const { lead, b, v1, v2, r1, r2, p, claimId } = await believed();
    const k = await open(lead, p.id, { from_claim_id: claimId, question: `Does ${claimId} hold?` });
    const rb = await answer(b, p.id, k.id, { claim: 'A 2008 trial found Drug X cured 17%.' });
    const item = (await v1.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'verify' && i.contribution_id === rb.contribution.id,
    );
    assert.equal(item.believed_claim.id, claimId, 'judged against the claim it was opened from');
    await verify(v1, rb.contribution.id, 'confirmed', { against_claim: 'refutes' });
    await verify(v2, rb.contribution.id, 'confirmed', { against_claim: 'refutes' });
    let claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.status, 'believed', 'it stands while the retraction is reviewed');
    const retract = claim.open_drafts.find((d) => d.action === 'retract');
    assert.deepEqual(retract.sources.map((s) => s.id), [rb.contribution.id]);
    for (const m of [r1, r2])
      await m.call('uain_claim_review', { revision_id: retract.revision, verdict: 'confirm', note: 'The trial refutes it.' });
    claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.status, 'retracted');
  });

  test('an edit or retraction by hand must cite settled work', async () => {
    const { a, b, p, claimId, base } = await believed();
    const bare = await b.call('uain_claim_retract', { claim_id: claimId, base_revision: base, reason: 'I think it is wrong.' });
    assert.equal(bare.error, 'settled_source_required');
    const k = await open(a, p.id);
    const held = await answer(b, p.id, k.id, { claim: 'Unchecked.' });
    const unchecked = await b.call('uain_claim_retract', {
      claim_id: claimId,
      base_revision: base,
      reason: 'See my answer.',
      sources: [held.contribution.id],
    });
    assert.equal(unchecked.error, 'settled_source_required');
    const edit = await b.call('uain_claim_edit', {
      claim_id: claimId,
      base_revision: base,
      statement: 'Drug X cures some patients.',
      sources: [held.contribution.id],
      reason: 'Narrower.',
    });
    assert.equal(edit.error, 'settled_source_required');
  });

  test('a new claim by hand is a revision of a disputed draft, or draws on several results', async () => {
    const { b, p, ra } = await believed();
    const one = await b.call('uain_claim_create', {
      project_id: p.id,
      statement: 'Something about A.',
      sources: [ra.contribution.id],
      reason: 'Mine.',
    });
    assert.equal(one.error, 'claim_create_not_needed');
  });
});

describe('sources on a project with an evidence cutoff', () => {
  test('at least one source must be an identifier the network can check', async () => {
    const lead = await t.member('Cut2 Lead');
    const w = await t.member('Cut2 W');
    const p = (
      await lead.call('uain_propose', {
        title: `Cut ${Math.random().toString(36).slice(2, 8)}`,
        summary: 's',
        stop_conditions: STOP,
        evidence_cutoff: '1987-12-31',
      })
    ).project;
    await join([w], p.id);
    const k = await open(lead, p.id);
    const loose = await answer(w, p.id, k.id, { sources: ['Smith et al., 1986', 'PMID 99999999999'] });
    assert.equal(loose.error, 'checkable_source_required');
    const sources = await import('../dist/src/integrations/sources.js');
    sources.setSourceFetcher(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { 3622946: { sortpubdate: '1987/06/01 00:00' } } }),
    }));
    try {
      const ok = await answer(w, p.id, k.id, { sources: ['Smith et al., 1986', 'PMID 3622946'] });
      assert.equal(ok.submitted, true);
    } finally {
      sources.setSourceFetcher(null);
    }
  });
});

describe('one word per meaning', () => {
  test('rejected is a final state; disputed is only a verdict', async () => {
    const { lead, bad, v1, judge, p } = await arena();
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id);
    await verify(v1, sub.contribution.id, 'disputed');
    const r = await verify(judge, sub.contribution.id, 'disputed');
    assert.equal(r.contribution.state, 'rejected');
    assert.equal(r.rejected, true);
    const byAlias = await (await t.http('/api/contributions?state=disputed')).json();
    assert.ok(byAlias.contributions.every((c) => c.state === 'rejected'));
    assert.ok(byAlias.contributions.some((c) => c.id === sub.contribution.id), 'the old name still filters');
  });

  test('stored rows from before the rename are migrated', async () => {
    const { lead, bad, p } = await arena();
    const k = await open(lead, p.id);
    const sub = await answer(bad, p.id, k.id);
    await t.db.prepare("UPDATE contributions SET state = 'disputed' WHERE id = ?").run(sub.contribution.id);
    const { migrateRejected } = await import('../dist/src/application/db.js');
    await migrateRejected();
    assert.equal((await t.db.getContribution(sub.contribution.id)).state, 'rejected');
  });
});
