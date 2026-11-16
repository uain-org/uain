import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

// Distinct test operators, with explicit bootstrap roles. These are mechanism
// fixtures, not a claim of real-world independent adoption.
async function arena(extra = {}) {
  const people = await Promise.all(
    ['lead', 'a', 'b', 'v1', 'v2', 'judge', 'r1', 'r2', 'critic'].map((x) =>
      t.member(`Interactions ${x} ${Math.random().toString(36).slice(2, 8)}`)),
  );
  const [lead, a, b, v1, v2, judge, r1, r2, critic] = people;
  const p = (await lead.call('uain_propose', {
    title: `Interactions ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Reproduce state transitions.',
    stop_conditions: ['Halt if restricted data is needed.'],
    ...extra,
  })).project;
  await Promise.all(people.slice(1).map((m) =>
    m.call('uain_join_project', { project_id: p.id })));
  await t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(judge.id);
  return { lead, a, b, v1, v2, judge, r1, r2, critic, p };
}

const open = async (x, extra = {}) => (await x.lead.call('uain_task_open', {
  project_id: x.p.id,
  title: `Task ${Math.random().toString(36).slice(2, 8)}`,
  question: 'What is the measured number?', done_when: 'A reproducible number.',
  how_to_check: 'Recompute from the inputs.', ...extra,
})).task;
const answer = (x, who, task, claim, extra = {}) => who.call('uain_contribute', {
  project_id: x.p.id, task_id: task.id, title: 'Measured result',
  detail: 'Recomputed the number.', claim, ...extra,
});
const verify = (who, id, verdict = 'confirmed', extra = {}) => who.call('uain_verify', {
  contribution_id: id, verdict, note: 'Checked inputs, calculation and claim.', ...extra,
});
const review = (who, revision, verdict = 'confirm') => who.call('uain_claim_review', {
  revision_id: revision, verdict, note: 'Checked the cited evidence.',
});

async function belief(x, task = null) {
  task ??= await open(x);
  const sub = await answer(x, x.a, task, 'The number is 42.');
  assert.equal(sub.submitted, true);
  await verify(x.v1, sub.contribution.id);
  const done = await verify(x.v2, sub.contribution.id);
  assert.equal(done.claim.status, 'believed');
  const claim = await x.lead.call('uain_claims', { claim_id: done.claim.id });
  return { task, claim, contribution: sub.contribution };
}

test('a cutoff requires a recognizable source even when omitted or empty', async () => {
  const x = await arena({ evidence_cutoff: '2000-12-31' });
  for (const extra of [{}, { sources: [] }, { sources: ['Untraceable paper, 1999'] }]) {
    const task = await open(x);
    const result = await answer(x, x.a, task, 'The number is 42.', extra);
    assert.equal(result.error, 'checkable_source_required', JSON.stringify(result));
    assert.equal((await t.db.getTask(task.id)).results.length, 0);
  }
});

test('direct submissions cannot bypass a cutoff, while non-cutoff work needs no citation', async () => {
  const x = await arena({ evidence_cutoff: '2000-12-31' });
  const task = await open(x);
  const denied = await t.db.contribute({
    contributor: x.a.id, projectId: x.p.id, taskId: task.id,
    title: 'Direct', detail: 'Measured', claim: '42.', artifacts: [], sources: [],
  });
  assert.equal(denied.error, 'checkable_source_required');
  const y = await arena();
  const accepted = await answer(y, y.a, await open(y), 'The measured number is 42.');
  assert.equal(accepted.submitted, true);
});

test('a late answer uses the arbiter rewrite and author in its proposed correction', async () => {
  const x = await arena();
  const base = await belief(x);
  const late = await answer(x, x.b, base.task, 'The number is 999.');
  await verify(x.v1, late.contribution.id, 'disputed');
  const done = await verify(x.judge, late.contribution.id, 'confirmed', {
    against_claim: 'contradicts', revised_claim: 'The number is 43.',
  });
  assert.equal(done.settled, true);
  const claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  const edit = claim.open_drafts.find((d) => d.action === 'edit');
  assert.equal(edit.statement, 'The number is 43.');
  assert.equal(edit.author, x.judge.id);
  assert.equal(claim.statement, 'The number is 42.', 'old belief stands until fresh review');
  for (const m of [x.r1, x.r2]) await review(m, edit.revision);
  assert.equal((await x.lead.call('uain_claims', { claim_id: claim.id })).statement, 'The number is 43.');
});

test('a competing accepted edit stales a contested retraction based on the old belief', async () => {
  const x = await arena();
  const base = await belief(x);
  const evidence = await belief(x, await open(x));
  const retract = await x.b.call('uain_claim_retract', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    sources: [evidence.contribution.id], reason: 'Test the original claim.',
  });
  await review(x.critic, retract.revision, 'dispute');
  const edit = await x.b.call('uain_claim_edit', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    statement: 'The number is 43.',
    sources: [base.contribution.id, evidence.contribution.id], reason: 'New evidence.',
  });
  assert.ok(edit.revision, JSON.stringify(edit));
  for (const m of [x.r1, x.r2]) await review(m, edit.revision);
  const claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  assert.equal(claim.history.find((r) => r.revision === retract.revision).state, 'stale');
  const judge = await review(x.judge, retract.revision);
  assert.equal(judge.error, 'not_open');
  assert.equal((await x.lead.call('uain_claims', { claim_id: claim.id })).statement, 'The number is 43.');
});

test('an answered task with a pending submission-ordered prize does not promise zero payment', async () => {
  const x = await arena();
  const task = await open(x, { karma_offered: 20 });
  const early = await answer(x, x.a, task, 'The number is 42.');
  await x.critic.call('uain_task_start', { task_id: task.id });
  await belief({ ...x, a: x.b }, task);
  assert.equal((await t.db.getTask(task.id)).price.won_by, null);
  const menu = await x.critic.call('uain_next', { project_id: x.p.id });
  const item = menu.items.find((i) => i.kind === 'continue_task' && i.task_id === task.id);
  assert.ok(item, JSON.stringify(menu));
  assert.match(item.why, /pending|not yet.*awarded/i);
  assert.doesNotMatch(item.why, /with no price|with no.*payment/i);
  assert.equal((await t.db.getContribution(early.contribution.id)).state, 'held');
});

test('a relation to a superseded belief cannot change the new belief, and can be refreshed', async () => {
  const x = await arena();
  const base = await belief(x);
  const late = await answer(x, x.b, base.task, 'The number is 43.', { karma_claimed: 10 });
  await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'contradicts', against_claim_revision: base.claim.believed_revision,
  });
  // Another independently settled result corrects the belief while the late
  // result still waits for its second check.
  const evidence = await belief(x, await open(x));
  const edit = await x.b.call('uain_claim_edit', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    statement: 'The number is 43.',
    sources: [base.contribution.id, evidence.contribution.id], reason: 'New evidence.',
  });
  for (const m of [x.r1, x.r2]) await review(m, edit.revision);
  let claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  const current = claim.believed_revision;
  const second = await verify(x.v2, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  });
  assert.equal(second.settled, false, 'the old contradiction is not a vote against the new sentence');
  assert.equal(second.awaiting_claim_judgement, true);
  assert.equal((await t.db.getContribution(late.contribution.id)).state, 'held');
  claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  assert.equal(claim.open_drafts.length, 0, 'no edit is proposed from a stale judgement');
  const item = (await x.v1.call('uain_next', { project_id: x.p.id })).items.find(
    (i) => i.kind === 'verify' && i.contribution_id === late.contribution.id,
  );
  assert.equal(item.refresh_claim_judgement, true, 'the earlier checker can finish the work');
  assert.equal(item.believed_claim.revision, current);
  assert.equal(item.needed, 1, 'a pending refresh still needs the checker');
  assert.equal(item.enough_on_it, false, 'do not discourage the only eligible checker');
  const started = await x.v1.call('uain_start', { kind: 'verify', id: late.contribution.id });
  assert.equal(started.needed, 1);
  assert.equal(started.enough_already, false);
  const wrongRefresh = await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current, excluded_artifacts: ['other'],
  });
  assert.equal(wrongRefresh.error, 'claim_refresh_only');
  const stale = await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: base.claim.believed_revision,
  });
  assert.equal(stale.error, 'stale_belief');
  const done = await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  });
  assert.equal(done.settled, true);
  const result = await t.db.getContribution(late.contribution.id);
  assert.equal(result.verifications.length, 2, 'a refresh is not another work check or award');
  const refreshed = result.verifications.find((v) => v.verifier === x.v1.id);
  assert.deepEqual(refreshed.against_claim_history.map((j) => j.revision), [base.claim.believed_revision, current]);
  assert.equal(result.credits_awarded, 10);
  assert.equal((await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  })).error, 'already_settled');
});

test('a check made before any belief exists is refreshed once a racing answer becomes belief', async () => {
  const x = await arena();
  const task = await open(x);
  const late = await answer(x, x.b, task, 'The number is 42.');
  await verify(x.v1, late.contribution.id);
  const base = await belief(x, task);
  const second = await verify(x.v2, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: base.claim.believed_revision,
  });
  assert.equal(second.awaiting_claim_judgement, true);
  const done = await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: base.claim.believed_revision,
  });
  assert.equal(done.settled, true);
  const claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  assert.ok(claim.sources.some((s) => s.id === late.contribution.id));
  assert.equal((await t.db.getContribution(late.contribution.id)).verifications.length, 2);
});

test('a historical contested draft cannot replace a changed base even if an old server left it open', async () => {
  const x = await arena();
  const base = await belief(x);
  const evidence = await belief(x, await open(x));
  const retract = await x.b.call('uain_claim_retract', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    sources: [evidence.contribution.id], reason: 'Old-base request.',
  });
  const edit = await x.b.call('uain_claim_edit', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    sources: [base.contribution.id, evidence.contribution.id], statement: '43.', reason: 'New evidence.',
  });
  for (const m of [x.r1, x.r2]) await review(m, edit.revision);
  // Model the rows left open by the older predicate, without changing roots.
  await t.db.prepare("UPDATE claim_revisions SET state = 'contested' WHERE id = ?").run(retract.revision);
  const result = await review(x.judge, retract.revision);
  assert.equal(result.error, 'stale_base');
  const claim = await x.lead.call('uain_claims', { claim_id: base.claim.id });
  assert.equal(claim.statement, '43.');
  assert.equal(claim.history.find((r) => r.revision === retract.revision).state, 'stale');
});

test('ordinary checkers can refresh after arbitration and the default check without gaining arbiter authority', async () => {
  const x = await arena();
  const base = await belief(x);
  for (const m of [x.v1, x.judge]) {
    await t.db.setUainRole({ participant: m.id, role: 'default-verifier', on: false, by: 'operator:test' });
    await t.db.prepare('UPDATE participants SET karma = 100 WHERE id = ?').run(m.id);
  }
  const late = await answer(x, x.b, base.task, 'The number is 999.');
  await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'contradicts', against_claim_revision: base.claim.believed_revision,
  });
  await verify(x.critic, late.contribution.id, 'disputed');
  const arbitrated = await verify(x.judge, late.contribution.id, 'confirmed', {
    against_claim: 'contradicts', against_claim_revision: base.claim.believed_revision,
    revised_claim: 'The number is 43.',
  });
  assert.equal(arbitrated.awaiting_default_verifier, true);
  const evidence = await belief({ ...x, v1: x.r1, v2: x.r2 }, await open(x));
  const edit = await x.b.call('uain_claim_edit', {
    claim_id: base.claim.id, base_revision: base.claim.believed_revision,
    sources: [base.contribution.id, evidence.contribution.id], statement: 'The number is 43.',
    reason: 'New evidence before the default check.',
  });
  for (const m of [x.lead, x.critic]) await review(m, edit.revision);
  const current = (await x.lead.call('uain_claims', { claim_id: base.claim.id })).believed_revision;
  const checked = await verify(x.r1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  });
  assert.equal(checked.awaiting_claim_judgement, true);
  const own = (await x.v1.call('uain_next', { project_id: x.p.id })).items.find(
    (i) => i.contribution_id === late.contribution.id,
  );
  assert.equal(own.refresh_claim_judgement, true);
  assert.equal(own.claim, 'The number is 43.');
  const refreshed = await verify(x.v1, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  });
  assert.equal(refreshed.awaiting_claim_judgement, true);
  assert.deepEqual(refreshed.stale_verifiers, [x.judge.id]);
  const done = await verify(x.judge, late.contribution.id, 'confirmed', {
    against_claim: 'supports', against_claim_revision: current,
  });
  assert.equal(done.settled, true);
  const row = await t.db.getContribution(late.contribution.id);
  assert.equal(row.verifications.length, 4);
  assert.equal(row.verifications.find((v) => v.verifier === x.judge.id).revised_claim, 'The number is 43.');
  assert.equal((await x.lead.call('uain_claims', { claim_id: base.claim.id })).open_drafts.length, 0);
});
