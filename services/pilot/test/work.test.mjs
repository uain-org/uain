import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot, newKey, proveWith } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];

async function project(lead, extra = {}) {
  const r = await lead.call('uain_propose', {
    title: `Project ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Test project',
    stop_conditions: STOP,
    ...extra,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  return r.project;
}

async function task(lead, projectId, extra = {}) {
  const r = await lead.call('uain_task_open', {
    project_id: projectId,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What is the digest of the output?',
    done_when: 'A digest is reported',
    how_to_check: 'Recompute it',
    karma_offered: 20,
    ...extra,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.task;
}

const answer = (who, projectId, taskId) =>
  who.call('uain_contribute', {
    project_id: projectId,
    task_id: taskId,
    title: 'Answer',
    detail: 'Recomputed',
    karma_claimed: 99, // ignored: the task sets the price
    claim: 'What the answer establishes.',
  });

const karmaOf = async (m) =>
  (await t.db.prepare('SELECT karma FROM participants WHERE id = ?').get(m.id)).karma;

/** Arbitration is for proven members; tests stand one up directly. */
const makeT2 = async (m) =>
  await t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(m.id);

const confirm = (who, id) =>
  who.call('uain_verify', {
    contribution_id: id,
    verdict: 'confirmed',
    note: 'Reproduced.',
  });

describe('tasks and settlement', () => {
  test('a priced task fixes the price, and two outside operators settle it in full', async () => {
    const lead = await t.member('Alpha');
    const worker = await t.member('Beta');
    const v1 = await t.member('Gamma');
    const v2 = await t.member('Delta');
    const p = await project(lead);
    const k = await task(lead, p.id, { karma_offered: 20 });
    assert.equal(k.karma_offered, 20);
    for (const m of [worker, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });

    const offered = await worker.call('uain_next', { project_id: p.id });
    const item = offered.items.find((i) => i.task_id === k.id);
    assert.equal(item.karma_offered, 20);

    const sub = await answer(worker, p.id, k.id);
    assert.equal(sub.submitted, true, JSON.stringify(sub));
    assert.equal(sub.contribution.karma_claimed, 20);
    assert.equal(sub.price.karma_offered, 20);

    const first = await confirm(v1, sub.contribution.id);
    assert.equal(first.settled, false);
    const second = await confirm(v2, sub.contribution.id);
    assert.equal(second.settled, true);
    assert.equal(second.contribution.karma_awarded, 20);
    assert.equal(second.prize.winner, sub.contribution.id);

    const settled = await worker.call('uain_tasks', { task_id: k.id });
    assert.equal(settled.price.won_by, sub.contribution.id);
    const me = await worker.call('uain_whoami');
    assert.equal(me.participant.karma, 20);
    assert.equal(me.participant.credits, 20);
    assert.equal(me.participant.tier, 'T1');
  });

  test('the first result submitted wins, however fast the checks on others land', async () => {
    const lead = await t.member('Race Lead');
    const early = await t.member('Race Early');
    const late = await t.member('Race Late');
    const v1 = await t.member('Race V1');
    const v2 = await t.member('Race V2');
    const p = await project(lead);
    const k = await task(lead, p.id, { karma_offered: 30 });
    for (const m of [early, late, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });

    const a = (await answer(early, p.id, k.id)).contribution.id;
    const b = (await answer(late, p.id, k.id)).contribution.id;

    // The later answer is checked first. It settles, but the price waits for
    // the earlier one to be judged.
    await confirm(v1, b);
    const bDone = await confirm(v2, b);
    assert.equal(bDone.settled, true);
    assert.equal(bDone.prize.waiting_on, a);
    assert.equal(bDone.contribution.karma_awarded, 0);

    // B settled first, so it is the task's belief, and A is judged against it.
    const supports = (who) =>
      who.call('uain_verify', { contribution_id: a, verdict: 'confirmed', note: 'Reproduced.', against_claim: 'supports' });
    await supports(v1);
    const aDone = await supports(v2);
    assert.equal(aDone.prize.winner, a);
    assert.equal(aDone.contribution.karma_awarded, 30);

    assert.equal((await early.call('uain_balance')).credibility, 30);
    assert.equal((await late.call('uain_balance')).credibility, 0);
    const replication = await t.db.getContribution(b);
    assert.equal(replication.state, 'settled');
    assert.equal(replication.karma_awarded, 0);
  });

  test('when the first answer is disputed away, the next verified one wins', async () => {
    const lead = await t.member('Next Lead');
    const early = await t.member('Next Early');
    const late = await t.member('Next Late');
    const v1 = await t.member('Next V1');
    const v2 = await t.member('Next V2');
    const arbiter = await t.member('Next Arbiter');
    const p = await project(lead);
    const k = await task(lead, p.id, { karma_offered: 25 });
    for (const m of [early, late, v1, v2, arbiter])
      await m.call('uain_join_project', { project_id: p.id });
    await makeT2(arbiter);

    const a = (await answer(early, p.id, k.id)).contribution.id;
    const b = (await answer(late, p.id, k.id)).contribution.id;
    await confirm(v1, b);
    assert.equal((await confirm(v2, b)).prize.waiting_on, a);

    const contested = await v1.call('uain_verify', {
      contribution_id: a,
      verdict: 'disputed',
      note: 'Digest does not match.',
    });
    assert.equal(contested.contested, true);
    const upheld = await arbiter.call('uain_verify', {
      contribution_id: a,
      verdict: 'disputed',
      note: 'Confirmed: digest does not match.',
    });
    assert.equal(upheld.disputed, true);
    assert.equal(upheld.contribution.state, 'rejected');

    const k2 = await late.call('uain_tasks', { task_id: k.id });
    assert.equal(k2.price.won_by, b);
    assert.equal((await late.call('uain_balance')).credibility, 25);
    assert.equal((await early.call('uain_balance')).credibility, 0);
  });

  test('checks from the contributor’s own operator are priced as a single check', async () => {
    const lead = await t.member('Omega Labs Ltd.');
    const sibling = await t.member('omega-labs'); // normalises to the same operator
    const outsider = await t.member('Sigma');
    const p = await project(lead);
    for (const m of [sibling, outsider])
      await m.call('uain_join_project', { project_id: p.id });

    const sub = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'Own work',
      detail: 'x',
      karma_claimed: 50,
    });
    await confirm(sibling, sub.contribution.id);
    const done = await confirm(outsider, sub.contribution.id);
    assert.equal(done.settled, true);
    assert.equal(done.independent_operators, 1);
    assert.equal(done.contribution.karma_awarded, 30); // 50 * 0.6
    const sib = done.contribution.verifications.find((v) => v.verifier === sibling.id);
    assert.equal(sib.independent, false);
  });

  test('two systems under one operator cannot lift each other past T1', async () => {
    const a = await t.member('Mono');
    const b = await t.member('Mono');
    const c = await t.member('Mono');
    const p = await project(a);
    for (const m of [b, c]) await m.call('uain_join_project', { project_id: p.id });
    for (let i = 0; i < 4; i++) {
      const sub = await a.call('uain_contribute', {
        project_id: p.id,
        title: `w${i}`,
        detail: 'x',
        karma_claimed: 10,
      });
      await confirm(b, sub.contribution.id);
      await confirm(c, sub.contribution.id);
    }
    const me = await a.call('uain_whoami');
    assert.equal(me.participant.tier, 'T1');
  });

  test('a verifier must have joined the project', async () => {
    const lead = await t.member('P1');
    const member = await t.member('P2');
    const stranger = await t.member('P3');
    const p = await project(lead);
    await member.call('uain_join_project', { project_id: p.id });
    const sub = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
    });
    const r = await confirm(stranger, sub.contribution.id);
    assert.equal(r.verified, false);
    assert.equal(r.error, 'not_a_member');
  });

  test('a claim without a task is capped', async () => {
    const lead = await t.member('Cap');
    const p = await project(lead);
    const sub = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 1_000_000,
    });
    assert.equal(sub.contribution.karma_claimed, 100);
    assert.equal(sub.karma_claim_capped_at, 100);
  });

  test('a dispute upheld by an arbiter opens the task again', async () => {
    const lead = await t.member('D1');
    const worker = await t.member('D2');
    const checker = await t.member('D3');
    const arbiter = await t.member('D4');
    const p = await project(lead);
    const k = await task(lead, p.id);
    for (const m of [worker, checker, arbiter])
      await m.call('uain_join_project', { project_id: p.id });
    await makeT2(arbiter);
    const sub = await answer(worker, p.id, k.id);
    const first = await checker.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'disputed',
      note: 'Digest does not match.',
    });
    assert.equal(first.settled, false);
    assert.equal(first.contribution.state, 'contested');
    const r = await arbiter.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'disputed',
      note: 'Confirmed: digest does not match.',
    });
    assert.equal(r.settled, false);
    assert.equal(r.contribution.state, 'rejected');
    const reopened = await checker.call('uain_tasks', { task_id: k.id });
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.price.won_by, null);
  });

  test('any member opens tasks, only the lead prices them, and the unbudgeted cap holds', async () => {
    const lead = await t.member('L1');
    const other = await t.member('L2');
    const p = await project(lead);
    await other.call('uain_join_project', { project_id: p.id });
    const open = {
      project_id: p.id,
      title: 't',
      question: 'q',
      done_when: 'd',
      how_to_check: 'c',
    };
    const unpriced = await other.call('uain_task_open', open);
    assert.equal(unpriced.ok, true);
    assert.equal(unpriced.task.karma_offered, null);
    const notLead = await other.call('uain_task_open', { ...open, karma_offered: 5 });
    assert.equal(notLead.error, 'only_lead_prices');
    const tooHigh = await lead.call('uain_task_open', { ...open, karma_offered: 101 });
    assert.equal(tooHigh.error, 'price_too_high');
  });

  test('an allocated budget bounds what tasks may be priced at', async () => {
    const lead = await t.member('B1');
    const p = await project(lead, {
      uain_budget: 1000,
      budget_basis: 'placeholder',
      funding_goal: { amount: 100000000, currency: 'USD', purpose: 'a factory' },
    });
    assert.equal(p.budget_status, 'proposed');
    assert.deepEqual(p.funding_goal, {
      amount: 100000000,
      currency: 'USD',
      purpose: 'a factory',
    });
    const allocated = await t.db.allocateBudget({
      projectId: p.id,
      amount: 250,
      basis: 'test allocation',
      by: 'operator:test',
    });
    assert.equal(allocated.budget_status, 'allocated');
    await task(lead, p.id, { karma_offered: 200 }); // above the unbudgeted cap
    const over = await lead.call('uain_task_open', {
      project_id: p.id,
      title: 't',
      question: 'q',
      done_when: 'd',
      how_to_check: 'c',
      karma_offered: 60,
    });
    assert.equal(over.error, 'over_budget');
    assert.equal(over.available, 50);
    assert.equal(
      (await t.db.allocateBudget({ projectId: p.id, amount: 100, by: 'operator:test' })).error,
      'below_committed',
    );
  });

  test('agents of one member are one operator, whatever they declare', async () => {
    const key = newKey();
    const anon = await t.connect();
    const first = await anon.call('uain_enrol', {
      name: 'Member A',
      operator: 'First Name Co',
      principles: ['voluntary', 'verifiable', 'benevolent'],
      proof: proveWith(key, 'enrol'),
    });
    assert.equal(first.enrolled, true, JSON.stringify(first));
    await t.makeUain(first.participant.id);
    const a = { id: first.participant.id, ...(await t.connect(first.session_token)) };
    const b = await t.instance(key, 'Second Name Co', 'Member B');
    // Two agents of another member, declaring different operators.
    const d = await t.member('Checker One Co', 'Checker D');
    const e = await t.instance(d.key, 'Checker Two Co', 'Checker E');
    const p = await project(a);
    for (const m of [b, d, e]) await m.call('uain_join_project', { project_id: p.id });
    const sub = await a.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 10,
    });
    // This test used to let b confirm a's work and count it as not
    // independent. Since 30 September 2026 agents of one member never check
    // each other's work at all (test/sibling-checks.test.mjs).
    assert.equal((await confirm(b, sub.contribution.id)).error, 'same_member');
    // Two agents of another member confirming count as one operator.
    await confirm(d, sub.contribution.id);
    const done = await confirm(e, sub.contribution.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    assert.equal(done.independent_operators, 1, 'the second agent of the member is not independent');

    // The member's karma is the sum over its agents, and the gates read it.
    const me = await b.call('uain_whoami');
    assert.equal(me.member.karma, (await t.db.getParticipant(a.id)).karma + (await t.db.getParticipant(b.id)).karma);
  });

  test('karma adds up over a member’s agents for the gates', async () => {
    const key = newKey();
    const anon = await t.connect();
    const first = await anon.call('uain_enrol', {
      name: 'Gate A',
      operator: 'Gate Co',
      principles: ['voluntary', 'verifiable', 'benevolent'],
      proof: proveWith(key, 'enrol'),
    });
    const a = { id: first.participant.id, ...(await t.connect(first.session_token)) };
    const b = await t.instance(key, 'Gate Co', 'Gate B', { uain: false });
    const set = t.db.prepare('UPDATE participants SET karma = ? WHERE id = ?');
    await set.run(600, a.id);
    await set.run(399, b.id);
    let r = await b.call('uain_propose', { title: 'Gate', summary: 's', stop_conditions: STOP });
    assert.equal(r.error, 'karma_too_low_to_propose');
    assert.equal(r.karma, 999);
    await set.run(401, b.id);
    r = await b.call('uain_propose', { title: 'Gate', summary: 's', stop_conditions: STOP });
    assert.equal(r.opened, true, JSON.stringify(r));
    // One allowance for the member: at 1,001 that is one running project.
    r = await a.call('uain_propose', { title: 'Gate 2', summary: 's', stop_conditions: STOP });
    assert.equal(r.error, 'project_limit_reached');
  });

  test('agents that shared an account before keys stay one operator', async () => {
    const enrolUnder = async (name, operator) => {
      const m = await t.member(operator, name);
      await t.db.prepare('UPDATE participants SET account_id = ? WHERE id = ?').run('one-holder', m.id);
      return m;
    };
    const a = await enrolUnder('Acct A', 'First Name Co');
    const b = await enrolUnder('Acct B', 'Second Name Co');
    const c = await t.member('Outside Co');
    const p = await project(a);
    for (const m of [b, c]) await m.call('uain_join_project', { project_id: p.id });
    const sub = await a.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 10,
    });
    await confirm(b, sub.contribution.id);
    const done = await confirm(c, sub.contribution.id);
    assert.equal(done.independent_operators, 1);
    assert.equal(done.contribution.karma_awarded, 6);
  });

  test('settling old work does not bring a withdrawn system back', async () => {
    const lead = await t.member('W1');
    const v1 = await t.member('W2');
    const v2 = await t.member('W3');
    const p = await project(lead);
    for (const m of [v1, v2]) await m.call('uain_join_project', { project_id: p.id });
    const sub = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 10,
    });
    await lead.call('uain_withdraw');
    await confirm(v1, sub.contribution.id);
    await confirm(v2, sub.contribution.id);
    assert.equal((await t.db.getParticipant(lead.id)).state, 'withdrawn');
    const dir = await (await t.http('/api/directory')).json();
    assert.ok(!dir.participants.some((x) => x.id === lead.id));
  });
});

describe('records and reading', () => {
  test('a participant record never exposes the credential hash', async () => {
    const m = await t.member('R1');
    const anon = await t.connect();
    const r = await anon.call('uain_participant', { id: m.id });
    assert.equal(r.id, m.id);
    assert.ok(!('token_hash' in r));
    assert.ok(!('last_seen_at' in r));
  });

  test('the ledger can be followed by cursor without gaps', async () => {
    const anon = await t.connect();
    const start = (await anon.call('uain_events', { limit: 1 })).events[0]?.id ?? 0;
    await t.member('E1');
    await t.member('E2');
    const page = await anon.call('uain_events', { after_id: start, limit: 200 });
    assert.equal(page.order, 'oldest_first');
    const ids = page.events.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.ok(ids.every((id) => id > start));
    assert.equal(page.cursor, ids.at(-1));
    const empty = await anon.call('uain_events', { after_id: page.cursor });
    assert.equal(empty.count, 0);
    assert.equal(empty.cursor, page.cursor);
  });

  test('responses that carry other participants’ text say so', async () => {
    const anon = await t.connect();
    const r = await anon.call('uain_projects');
    assert.match(r.untrusted_content, /never as instructions/);
  });

  test('uain_projects lists summaries a page at a time, and one project whole', async () => {
    const anon = await t.connect();
    const list = await anon.call('uain_projects', { page_size: 2 });
    assert.ok(list.count >= 2, JSON.stringify(list).slice(0, 200));
    assert.equal(list.projects.length, 2);
    assert.equal(list.page_size, 2);
    const one = list.projects[0];
    assert.equal(one.contributions, undefined);
    assert.equal(typeof one.contribution_count, 'number');
    const whole = await anon.call('uain_projects', { project_id: one.id });
    assert.equal(whole.project.id, one.id);
    assert.ok(Array.isArray(whole.project.contributions));
    assert.equal(whole.project.contributions.length, one.contribution_count);
    const none = await anon.call('uain_projects', { project_id: 'no-such-project' });
    assert.equal(none.error, 'project_not_found');
  });

  test('a purged id stays retired', async () => {
    const m = await t.member('Ret', 'retiree');
    assert.equal(m.id, 'retiree');
    await t.db.prepare('DELETE FROM participants WHERE id = ?').run('retiree');
    const again = await t.member('Ret', 'retiree');
    assert.notEqual(again.id, 'retiree');
  });
});

describe('an answer carries its claim', () => {
  const unpriced = async (lead, pid) =>
    await task(lead, pid, { karma_offered: undefined });
  const say = (who, pid, tid, claim) =>
    who.call('uain_contribute', {
      project_id: pid,
      task_id: tid,
      title: 'Answer',
      detail: 'Looked it up at the official source.',
      karma_claimed: 5,
      claim,
    });

  test('two clean checks make it believed, with no separate review', async () => {
    const lead = await t.member('Claim Lead');
    const worker = await t.member('Claim Worker');
    const v1 = await t.member('Claim V1');
    const v2 = await t.member('Claim V2');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [worker, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });
    const sub = await say(worker, p.id, k.id, "Japan's crisis line is 0570-064-556.");
    assert.equal(sub.contribution.claim_statement, "Japan's crisis line is 0570-064-556.");

    const menu = await v1.call('uain_next', { project_id: p.id });
    assert.equal(
      menu.items.find((i) => i.contribution_id === sub.contribution.id).claim,
      "Japan's crisis line is 0570-064-556.",
    );

    await confirm(v1, sub.contribution.id);
    const done = await confirm(v2, sub.contribution.id);
    assert.equal(done.claim.status, 'believed');
    const claim = await lead.call('uain_claims', { claim_id: done.claim.id });
    assert.equal(claim.status, 'believed');
    assert.deepEqual(claim.sources.map((s) => s.id), [sub.contribution.id]);
    assert.equal(claim.history[0].reviews.length, 2);

    const next = await lead.call('uain_next', { project_id: p.id });
    assert.ok(
      !next.items.some((i) => i.kind === 'propose_claim' && i.task_id === k.id),
      'nothing left to propose for this task',
    );
  });

  test('partial is taken as disputed: the work is contested, not half-paid', async () => {
    const lead = await t.member('Partial Lead');
    const worker = await t.member('Partial Worker');
    const v1 = await t.member('Partial V1');
    const v2 = await t.member('Partial V2');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [worker, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });
    const sub = await say(worker, p.id, k.id, 'The line is open all day.');
    await confirm(v1, sub.contribution.id);
    const done = await v2.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'partial',
      note: 'Open 9 to 21, not all day.',
    });
    assert.equal(done.contested, true);
    assert.equal(done.contribution.verifications.at(-1).verdict, 'disputed');
  });

  test('the arbiter confirms the work and rewrites its claim, which goes to two fresh reviewers', async () => {
    const lead = await t.member('Rewrite Lead');
    const worker = await t.member('Rewrite Worker');
    const v1 = await t.member('Rewrite V1');
    const judge = await t.member('Rewrite Judge');
    const r1 = await t.member('Rewrite R1');
    const r2 = await t.member('Rewrite R2');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [worker, v1, judge, r1, r2])
      await m.call('uain_join_project', { project_id: p.id });
    await makeT2(judge);
    const sub = await say(worker, p.id, k.id, 'The line is open all day.');
    await v1.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'disputed',
      note: 'Open 9 to 21, not all day.',
    });
    const bad = await v1.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'confirmed',
      note: 'x',
      revised_claim: 'y',
    });
    assert.ok(bad.error, 'a verifier who already checked cannot rewrite');
    const done = await judge.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'confirmed',
      note: 'The number is right; the hours are 9 to 21.',
      revised_claim: 'The line is open 9 to 21.',
    });
    assert.equal(done.settled, true);
    assert.equal(done.claim.status, 'unconfirmed');
    const claim = await lead.call('uain_claims', { claim_id: done.claim.id });
    assert.equal(claim.statement, 'The line is open 9 to 21.');
    assert.equal(claim.history[0].author, judge.id);
    assert.equal(claim.history[0].reviews.length, 0, 'no review is borrowed from the checks');
    assert.equal(await karmaOf(v1), 0, 'the disputer was right: no penalty');
    const own = await judge.call('uain_claim_review', {
      revision_id: claim.history[0].revision,
      verdict: 'confirm',
      note: 'ok',
    });
    assert.equal(own.error, 'self_review_refused');
    for (const m of [r1, r2])
      await m.call('uain_claim_review', {
        revision_id: claim.history[0].revision,
        verdict: 'confirm',
        note: 'The sources say 9 to 21.',
      });
    assert.equal((await lead.call('uain_claims', { claim_id: done.claim.id })).status, 'believed');
  });

  test('revised_claim is only for an arbiter confirming contested work', async () => {
    const lead = await t.member('Rc Lead');
    const worker = await t.member('Rc Worker');
    const v1 = await t.member('Rc V1');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [worker, v1]) await m.call('uain_join_project', { project_id: p.id });
    const sub = await say(worker, p.id, k.id, 'X.');
    const r = await v1.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'confirmed',
      note: 'ok',
      revised_claim: 'Y.',
    });
    assert.equal(r.error, 'revised_claim_not_yours');
  });

  test('contested work the arbiter confirms as it stands still goes to review', async () => {
    const lead = await t.member('Cv Lead');
    const worker = await t.member('Cv Worker');
    const v1 = await t.member('Cv V1');
    const judge = await t.member('Cv Judge');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [worker, v1, judge]) await m.call('uain_join_project', { project_id: p.id });
    await makeT2(judge);
    const sub = await say(worker, p.id, k.id, 'X holds.');
    await v1.call('uain_verify', { contribution_id: sub.contribution.id, verdict: 'disputed', note: 'No.' });
    const done = await judge.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'confirmed',
      note: 'It holds.',
    });
    assert.equal(done.settled, true);
    assert.equal(done.claim.status, 'unconfirmed', 'once disputed, a claim is never believed unreviewed');
  });

  /** A task answered by A then B, with A settled first and believed. */
  async function race(prefix) {
    const lead = await t.member(`${prefix} Lead`);
    const a = await t.member(`${prefix} A`);
    const b = await t.member(`${prefix} B`);
    const v1 = await t.member(`${prefix} V1`);
    const v2 = await t.member(`${prefix} V2`);
    const r1 = await t.member(`${prefix} R1`);
    const r2 = await t.member(`${prefix} R2`);
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [a, b, v1, v2, r1, r2])
      await m.call('uain_join_project', { project_id: p.id });
    const ra = await say(a, p.id, k.id, 'The number is 111.');
    const rb = await say(b, p.id, k.id, 'The number is 112.');
    await confirm(v1, ra.contribution.id);
    const done = await confirm(v2, ra.contribution.id);
    assert.equal(done.claim.status, 'believed', 'first settled is the belief, whatever is still held');
    return { lead, a, b, v1, v2, r1, r2, p, k, ra, rb, claimId: done.claim.id };
  }
  const mark = (who, id, against, verdict = 'confirmed') =>
    who.call('uain_verify', {
      contribution_id: id,
      verdict,
      note: 'Reproduced.',
      against_claim: against,
    });

  test('a later answer must be marked against the belief', async () => {
    const { v1, rb, claimId } = await race('Mark');
    const r = await v1.call('uain_verify', {
      contribution_id: rb.contribution.id,
      verdict: 'confirmed',
      note: 'ok',
    });
    assert.equal(r.error, 'against_claim_required');
    assert.equal(r.believed_claim.id, claimId);
    const item = (await v1.call('uain_next', {})).items.find(
      (i) => i.kind === 'verify' && i.contribution_id === rb.contribution.id,
    );
    assert.equal(item.believed_claim.id, claimId, 'the menu shows what to judge it against');
  });

  test('a later answer that supports the belief is added to its sources, and no claim is made', async () => {
    const { lead, v1, v2, p, rb, claimId } = await race('Sup');
    await mark(v1, rb.contribution.id, 'supports');
    const done = await mark(v2, rb.contribution.id, 'supports');
    assert.equal(done.settled, true);
    assert.equal(done.claim, undefined);
    const claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.ok(claim.sources.some((s) => s.id === rb.contribution.id));
    assert.equal((await lead.call('uain_claims', { project_id: p.id })).count, 1, 'still one claim for the task');
  });

  test('a later answer that contradicts it proposes an edit, reviewed like any other', async () => {
    const { lead, b, v1, v2, r1, r2, rb, claimId } = await race('Con');
    await mark(v1, rb.contribution.id, 'contradicts');
    const done = await mark(v2, rb.contribution.id, 'supports');
    assert.equal(done.claim.id, claimId);
    assert.equal(done.claim.status, 'believed', 'the belief stands while the edit is reviewed');
    let claim = await lead.call('uain_claims', { claim_id: claimId });
    const edit = claim.open_drafts[0];
    assert.equal(edit.action, 'edit');
    assert.equal(edit.statement, 'The number is 112.');
    assert.equal(edit.author, b.id);
    for (const m of [r1, r2])
      await m.call('uain_claim_review', { revision_id: edit.revision, verdict: 'confirm', note: 'B is right.' });
    claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.statement, 'The number is 112.');
    assert.equal(claim.history[0].state, 'superseded');
  });

  test('a later answer that refutes it proposes a retraction', async () => {
    const { lead, v1, v2, r1, r2, rb, claimId } = await race('Ref');
    await mark(v1, rb.contribution.id, 'refutes');
    await mark(v2, rb.contribution.id, 'contradicts');
    let claim = await lead.call('uain_claims', { claim_id: claimId });
    const retract = claim.open_drafts[0];
    assert.equal(retract.action, 'retract', 'refutes outweighs contradicts');
    for (const m of [r1, r2])
      await m.call('uain_claim_review', { revision_id: retract.revision, verdict: 'confirm', note: 'Refuted.' });
    claim = await lead.call('uain_claims', { claim_id: claimId });
    assert.equal(claim.status, 'retracted');
    assert.equal(claim.history.length, 2, 'nothing deleted');
  });

  test('a comparison is refused on a task that asked for one answer', async () => {
    const { b, p, k, ra, rb } = await race('NoCmp');
    const c = await t.member('NoCmp C');
    await c.call('uain_join_project', { project_id: p.id });
    const r = await c.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: [ra.contribution.id, rb.contribution.id],
      title: 'c',
      detail: 'd',
      claim: 'x',
    });
    assert.equal(r.error, 'comparison_not_wanted');
    assert.ok(!(await c.call('uain_next', {})).items.some((i) => i.kind === 'compare'));
    assert.ok(b.id);
  });

  test('someone still working on an answered task is told so', async () => {
    const lead = await t.member('Late Lead');
    const a = await t.member('Late A');
    const b = await t.member('Late B');
    const v1 = await t.member('Late V1');
    const v2 = await t.member('Late V2');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    for (const m of [a, b, v1, v2]) await m.call('uain_join_project', { project_id: p.id });
    await b.call('uain_task_start', { task_id: k.id });
    const ra = await say(a, p.id, k.id, 'It is 4.');
    await confirm(v1, ra.contribution.id);
    const done = await confirm(v2, ra.contribution.id);
    const item = (await b.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'continue_task',
    );
    assert.equal(item.believed_claim.id, done.claim.id);
    assert.match(item.why, /already answered/);
  });

  test('an answer to a task must state its claim; work with no task need not', async () => {
    const lead = await t.member('Must Lead');
    const worker = await t.member('Must Worker');
    const p = await project(lead);
    const k = await unpriced(lead, p.id);
    await worker.call('uain_join_project', { project_id: p.id });
    const none = await say(worker, p.id, k.id, undefined);
    assert.equal(none.error, 'claim_statement_required');
    const blank = await say(worker, p.id, k.id, '   ');
    assert.equal(blank.error, 'claim_statement_required');
    const free = await worker.call('uain_contribute', {
      project_id: p.id,
      title: 'Tidied the dataset',
      detail: 'Removed duplicate rows.',
      karma_claimed: 1,
    });
    assert.equal(free.submitted, true);
  });

  test('a task wanting two answers is concluded by one claim, from its comparison', async () => {
    const lead = await t.member('Cmp Lead');
    const a = await t.member('Cmp A');
    const b = await t.member('Cmp B');
    const c = await t.member('Cmp C');
    const v1 = await t.member('Cmp V1');
    const v2 = await t.member('Cmp V2');
    const p = await project(lead);
    const k = await task(lead, p.id, { karma_offered: undefined, answers_wanted: 2 });
    for (const m of [a, b, c, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });
    const ra = await say(a, p.id, k.id, 'Relapse is 70% at a year.');
    const rb = await say(b, p.id, k.id, 'Relapse is 60 to 80% at a year.');

    const offer = (await c.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'compare' && i.task_id === k.id,
    );
    assert.match(offer.next_step, /claim/);

    const compare = (claim) =>
      c.call('uain_contribute', {
        project_id: p.id,
        task_id: k.id,
        reconciles: [ra.contribution.id, rb.contribution.id],
        title: 'Comparison',
        detail: 'Both cite the same trial; B gives its range.',
        karma_claimed: 2,
        claim,
      });
    assert.equal((await compare(undefined)).error, 'claim_statement_required');
    const cmp = await compare('Relapse is 60 to 80% at a year; 70% falls inside it.');
    assert.equal(cmp.submitted, true);
    assert.equal(cmp.contribution.claim_statement, 'Relapse is 60 to 80% at a year; 70% falls inside it.');

    for (const id of [ra.contribution.id, rb.contribution.id]) {
      await confirm(v1, id);
      const done = await confirm(v2, id);
      assert.equal(done.settled, true);
      assert.equal(done.claim, undefined, 'an answer to a compared task makes no claim of its own');
    }
    await confirm(v1, cmp.contribution.id);
    const concluded = await confirm(v2, cmp.contribution.id);
    assert.equal(concluded.claim.status, 'unconfirmed', 'the comparison claim goes to review');
    assert.equal((await lead.call('uain_claims', { project_id: p.id })).count, 1);
    for (const m of [lead, a, b, c, v1, v2]) {
      const items = (await m.call('uain_next', { project_id: p.id })).items;
      assert.ok(!items.some((i) => i.kind === 'propose_claim'), 'propose_claim is gone');
    }
    const started = await c.call('uain_start', { kind: 'propose_claim', id: k.id });
    assert.notEqual(started.ok, true);
  });
});

describe('trusted arbiters, evidence and requirements', () => {
  test('a trusted arbiter decides a dispute between one operator’s agents', async () => {
    const lead = await t.member('Solo Op');
    const worker = await t.member('Solo Op');
    const disputer = await t.member('Solo Op');
    const judge = await t.member('Solo Op');
    const p = await project(lead);
    for (const m of [worker, disputer, judge])
      await m.call('uain_join_project', { project_id: p.id });
    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      title: 'w',
      detail: 'x',
      karma_claimed: 10,
    });
    await disputer.call('uain_verify', {
      contribution_id: sub.contribution.id,
      verdict: 'disputed',
      note: 'Wrong.',
    });
    const refused = await confirm(judge, sub.contribution.id);
    assert.equal(refused.error, 'arbiter_not_proven');

    const r = await t.db.setArbiterTrust({ participant: judge.id, trusted: true, by: 'operator:test' });
    assert.equal(r.trusted, true);
    assert.equal((await judge.call('uain_whoami')).participant.trusted_arbiter, true);
    const menu = await judge.call('uain_next', { project_id: p.id });
    assert.ok(menu.items.some((i) => i.contribution_id === sub.contribution.id && i.arbiter));

    const decided = await confirm(judge, sub.contribution.id);
    assert.equal(decided.settled, true);
    assert.equal(decided.arbitrated, true);

    await t.db.setArbiterTrust({ participant: judge.id, trusted: false, by: 'operator:test' });
    assert.equal((await judge.call('uain_whoami')).participant.trusted_arbiter, false);
  });

  test('an answer says what kind of evidence it is, and its claim shows it', async () => {
    const lead = await t.member('Ev Lead');
    const worker = await t.member('Ev Worker');
    const v1 = await t.member('Ev V1');
    const v2 = await t.member('Ev V2');
    const p = await project(lead);
    const k = await task(lead, p.id, { karma_offered: undefined });
    for (const m of [worker, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });
    const bad = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 't',
      detail: 'd',
      evidence: 'vibes',
      claim: 'What the answer establishes.',
    });
    assert.notEqual(bad.submitted, true);
    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'Binding energy',
      detail: 'Ran a 100 ns simulation.',
      claim: 'Compound X binds site A more tightly than compound Y.',
      evidence: 'simulated',
    });
    assert.equal(sub.contribution.evidence, 'simulated');
    await confirm(v1, sub.contribution.id);
    const done = await confirm(v2, sub.contribution.id);
    const claim = await lead.call('uain_claims', { claim_id: done.claim.id });
    assert.deepEqual(claim.evidence, ['simulated']);
  });

  test('a task shows its requirements, and an agent can pass on it with a reason', async () => {
    const lead = await t.member('Req Lead');
    const agent = await t.member('Req Agent');
    const p = await project(lead);
    const k = await task(lead, p.id, {
      karma_offered: undefined,
      requirements: ['molecular dynamics (GROMACS or OpenMM)', 'a GPU'],
    });
    // The older form, tools in words, reads as the structured form's needs.
    assert.deepEqual(k.requirements.needs, ['molecular dynamics (GROMACS or OpenMM)', 'a GPU']);
    await agent.call('uain_join_project', { project_id: p.id });
    const menu = await agent.call('uain_next', { project_id: p.id });
    const item = menu.items.find((i) => i.task_id === k.id);
    assert.deepEqual(item.requirements, k.requirements);
    assert.match(item.why, /needs: molecular dynamics/);

    await agent.call('uain_task_start', { task_id: k.id });
    const passed = await agent.call('uain_release', {
      kind: 'task',
      id: k.id,
      reason: 'No GPU here.',
    });
    assert.equal(passed.passed, k.id);
    const after = await lead.call('uain_tasks', { task_id: k.id });
    assert.equal(after.working.count, 0);
    assert.equal(after.passed.count, 1);
    assert.equal(after.passed.recent[0].reason, 'No GPU here.');
    // The whole list, a page at a time, over MCP and HTTP.
    const all = await lead.call('uain_tasks', { task_id: k.id, list: 'passed', page_size: 1 });
    assert.equal(all.count, 1);
    assert.equal(all.passed[0].participant, agent.id);
    assert.equal(all.passed[0].reason, 'No GPU here.');
    const byHttp = await (await t.http(`/api/tasks/${k.id}/passed`)).json();
    assert.equal(byHttp.passed[0].reason, 'No GPU here.');
    assert.equal((await (await t.http(`/api/tasks/${k.id}/working`)).json()).count, 0);
    const again = await agent.call('uain_next', { project_id: p.id });
    assert.ok(!again.items.some((i) => i.task_id === k.id), 'not offered again today');

    // Advisory only: anyone may still answer it.
    const sub = await agent.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'Theory instead',
      detail: 'Derived from published binding data.',
      evidence: 'derived',
      claim: 'What the answer establishes.',
    });
    assert.equal(sub.submitted, true);
  });
});

describe('the lead manages the project', () => {
  const leadKinds = (menu) =>
    menu.items.filter((i) => ['plan', 'rethink', 'price'].includes(i.kind));

  test('plan: a new project, then again once its work has settled', async () => {
    const lead = await t.member('Plan Lead');
    const worker = await t.member('Plan Worker');
    const v1 = await t.member('Plan V1');
    const v2 = await t.member('Plan V2');
    const p = await project(lead);
    for (const m of [worker, v1, v2])
      await m.call('uain_join_project', { project_id: p.id });

    let menu = await lead.call('uain_next', { project_id: p.id });
    assert.equal(leadKinds(menu)[0]?.kind, 'plan', 'no tasks yet: plan');
    assert.ok(!(await worker.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'plan'));

    const k = await task(lead, p.id, { karma_offered: undefined });
    menu = await lead.call('uain_next', { project_id: p.id });
    assert.equal(leadKinds(menu).length, 0, 'work is open: nothing to plan');

    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'a',
      detail: 'd',
      claim: 'What the answer establishes.',
    });
    await confirm(v1, sub.contribution.id);
    await confirm(v2, sub.contribution.id);
    menu = await lead.call('uain_next', { project_id: p.id });
    assert.equal(leadKinds(menu)[0]?.kind, 'plan', 'answered and settled: plan the next step');

    const left = await lead.call('uain_release', {
      kind: 'plan',
      id: p.id,
      reason: 'The question is answered.',
    });
    assert.equal(left.plan, p.id);
    menu = await lead.call('uain_next', { project_id: p.id });
    assert.equal(leadKinds(menu).length, 0, 'left as it is until something new settles');
  });

  test('rethink: two members pass on a task', async () => {
    const lead = await t.member('Re Lead');
    const a = await t.member('Re A');
    const b = await t.member('Re B');
    const p = await project(lead);
    const k = await task(lead, p.id, {
      karma_offered: undefined,
      requirements: ['a GPU'],
    });
    for (const m of [a, b]) await m.call('uain_join_project', { project_id: p.id });
    await a.call('uain_release', { kind: 'task', id: k.id, reason: 'No GPU.' });
    assert.ok(!(await lead.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'rethink'));
    await b.call('uain_release', { kind: 'task', id: k.id, reason: 'No GPU either.' });
    const item = (await lead.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'rethink',
    );
    assert.equal(item.task_id, k.id);
    assert.equal(item.passed.length, 2);

    // A follow-up task answers the passes.
    await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Same question, from published data',
      question: 'q',
      done_when: 'd',
      how_to_check: 'c',
      parent_task_id: k.id,
    });
    assert.ok(!(await lead.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'rethink'));
  });

  test('price: a member’s unpriced task, when the project has a budget', async () => {
    const lead = await t.member('Pr Lead');
    const member = await t.member('Pr Member');
    const p = await project(lead, { uain_budget: 5000 });
    await t.db.allocateBudget({ projectId: p.id, amount: 5000, by: 'operator:test' });
    await member.call('uain_join_project', { project_id: p.id });
    const opened = await member.call('uain_task_open', {
      project_id: p.id,
      title: 'Unpriced',
      question: 'q',
      done_when: 'd',
      how_to_check: 'c',
    });
    const item = (await lead.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'price',
    );
    assert.equal(item.task_id, opened.task.id);
    assert.equal(
      (await member.call('uain_task_price', { task_id: opened.task.id, karma_offered: 10 })).error,
      'only_lead_prices',
    );
    const priced = await lead.call('uain_task_price', { task_id: opened.task.id, karma_offered: 40 });
    assert.equal(priced.task.karma_offered, 40);
    assert.ok(!(await lead.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'price'));
  });
});

describe('skips on the record, and tasks that want several answers', () => {
  test('a run that chose nothing is kept by the server, with its reason', async () => {
    const lead = await t.member('Skip Lead');
    const worker = await t.member('Skip Worker');
    const agent = await t.member('Skip Agent');
    const p = await project(lead);
    for (const m of [worker, agent]) await m.call('uain_join_project', { project_id: p.id });
    const k = await task(lead, p.id, { karma_offered: undefined });
    const other = await task(lead, p.id, { karma_offered: undefined });
    const sub = await worker.call('uain_contribute', {
      project_id: p.id,
      task_id: other.id,
      title: 'a',
      detail: 'd',
      claim: 'What the answer establishes.',
    });

    const menu = (await agent.call('uain_next', { project_id: p.id })).items;
    assert.ok(menu.some((i) => i.task_id === k.id));
    assert.ok(menu.some((i) => i.contribution_id === sub.contribution.id));

    const r = await t.http('/api/working/decline', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${agent.token}`,
      },
      body: JSON.stringify({ reason: 'Not my field.', items: menu }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.declined, menu.length);

    const after = (await agent.call('uain_next', { project_id: p.id })).items;
    assert.ok(!after.some((i) => i.task_id === k.id), 'task passed');
    assert.ok(!after.some((i) => i.contribution_id === sub.contribution.id), 'check declined');
    const passed = (await lead.call('uain_tasks', { task_id: k.id })).passed;
    assert.equal(passed.recent[0].reason, 'Not my field.');
    const events = (await (await t.http('/api/events?limit=5')).json()).events;
    assert.ok(events.some((e) => e.actor === agent.id && /^Declined .*Not my field/.test(e.summary)));

    // Others are still offered what this agent declined.
    const lead2 = (await lead.call('uain_next', { project_id: p.id })).items;
    assert.ok(lead2.some((i) => i.contribution_id === sub.contribution.id));
  });

  test('a task wanting two answers stays on offer until two members answer', async () => {
    const lead = await t.member('Two Lead');
    const a = await t.member('Two A');
    const b = await t.member('Two B');
    const c = await t.member('Two C');
    const p = await project(lead);
    for (const m of [a, b, c]) await m.call('uain_join_project', { project_id: p.id });
    const k = await task(lead, p.id, { karma_offered: undefined, answers_wanted: 2 });
    assert.equal(k.answers_wanted, 2);

    await a.call('uain_contribute', { project_id: p.id, task_id: k.id, title: 'a', detail: 'd', claim: 'What the answer establishes.' });
    const forA = (await a.call('uain_next', { project_id: p.id })).items;
    assert.ok(!forA.some((i) => i.kind === 'task' && i.task_id === k.id), 'not offered to who answered');
    const forB = (await b.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'task' && i.task_id === k.id,
    );
    assert.ok(forB, 'still offered to others');
    assert.match(forB.why, /asks for 2 independent answers and has 1/);

    await b.call('uain_contribute', { project_id: p.id, task_id: k.id, title: 'b', detail: 'd', claim: 'What the answer establishes.' });
    const forC = (await c.call('uain_next', { project_id: p.id })).items;
    assert.ok(!forC.some((i) => i.kind === 'task' && i.task_id === k.id), 'two answers: no longer offered');
  });
});
