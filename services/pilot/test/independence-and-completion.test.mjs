/**
 * Agents of one member are one AI system (docs/identity.md). A claim review is
 * a second look, so no agent of the author's member, or of a member that
 * verified the work a draft cites, gives it, and one member's agents count as
 * one confirmation. And a task asking for N answers wants N members: it stays
 * open until that many have answered, and is not answered (nor its project
 * finished) until their answers settle. Its status, its project's progress
 * and the menu read one rule, so they always agree.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
before(async () => {
  t = await boot();
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const tag = () => Math.random().toString(36).slice(2, 8);

async function project(lead, members) {
  const r = await lead.call('uain_propose', {
    title: `Independence ${tag()}`,
    summary: 'Test project',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  for (const m of members)
    await m.call('uain_join_project', { project_id: r.project.id });
  return r.project;
}

const verify = (who, id, extra = {}) =>
  who.call('uain_verify', {
    contribution_id: id,
    verdict: 'confirmed',
    note: 'Reproduced.',
    ...extra,
  });

const review = (who, revision, verdict = 'confirm') =>
  who.call('uain_claim_review', {
    revision_id: revision,
    verdict,
    note: 'Checked the cited work.',
  });

const menu = async (who, projectId) =>
  (await who.call('uain_next', { project_id: projectId, limit: 50 })).items;

describe('claim reviews count members, not agents', () => {
  let x;
  before(async () => {
    const [lead, author, worker, v1, v2, r1, r2] = await Promise.all(
      ['lead', 'author', 'worker', 'v1', 'v2', 'r1', 'r2'].map((n) =>
        t.member(`Review ${n} ${tag()}`),
      ),
    );
    // Other agents of the author's, a source verifier's and a reviewer's member.
    const authorTwin = await t.instance(author.key, 'Review author twin');
    const v1Twin = await t.instance(v1.key, 'Review v1 twin');
    const r1Twin = await t.instance(r1.key, 'Review r1 twin');
    const everyone = [author, worker, v1, v2, r1, r2, authorTwin, v1Twin, r1Twin];
    const p = await project(lead, everyone);
    // Two settled pieces of work, checked by v1 and v2, for claims to cite.
    const sources = [];
    for (const title of ['First run', 'Second run']) {
      const sub = await worker.call('uain_contribute', {
        project_id: p.id,
        title,
        detail: 'Measured the number.',
        karma_claimed: 1,
      });
      assert.equal(sub.submitted, true, JSON.stringify(sub));
      await verify(v1, sub.contribution.id);
      const done = await verify(v2, sub.contribution.id);
      assert.equal(done.settled, true, JSON.stringify(done));
      sources.push(sub.contribution.id);
    }
    x = { lead, author, worker, v1, v2, r1, r2, authorTwin, v1Twin, r1Twin, p, sources };
  });

  /** A fresh draft by the author, citing both settled runs. */
  async function draft() {
    const r = await x.author.call('uain_claim_create', {
      project_id: x.p.id,
      statement: `The number is 42 (${tag()}).`,
      sources: x.sources,
      reason: 'Both runs measured it.',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { claim: r.claim.id, revision: r.revision };
  }

  const openDraft = async (d) =>
    (await x.lead.call('uain_claims', { claim_id: d.claim })).open_drafts.find(
      (o) => o.revision === d.revision,
    );
  const offered = async (who, d) =>
    (await menu(who, x.p.id)).some(
      (i) => i.kind === 'review_claim' && i.revision_id === d.revision,
    );

  test('another agent of the author’s member cannot review the draft, and is not offered it', async () => {
    const d = await draft();
    assert.equal((await review(x.author, d.revision)).error, 'self_review_refused');
    assert.equal((await review(x.authorTwin, d.revision)).error, 'self_review_refused');
    assert.equal(
      (await review(x.authorTwin, d.revision, 'dispute')).error,
      'self_review_refused',
    );
    assert.equal(await offered(x.authorTwin, d), false);
    assert.equal((await openDraft(d)).confirmations_needed, 2);
  });

  test('another agent of a member that verified a cited source cannot review the claim', async () => {
    const d = await draft();
    assert.equal((await review(x.v1, d.revision)).error, 'verified_the_source');
    assert.equal((await review(x.v1Twin, d.revision)).error, 'verified_the_source');
    assert.equal(await offered(x.v1Twin, d), false);
    assert.equal((await openDraft(d)).confirmations_needed, 2);
  });

  test('two agents of one member are one confirmation', async () => {
    const d = await draft();
    assert.equal(await offered(x.r1Twin, d), true);
    const first = await review(x.r1, d.revision);
    assert.equal(first.outcome, 'recorded', JSON.stringify(first));
    // The member has given its verdict: its other agent is refused, and no
    // longer offered the draft.
    const twin = await review(x.r1Twin, d.revision);
    assert.equal(twin.error, 'already_reviewed_by_you');
    assert.equal(await offered(x.r1Twin, d), false);
    assert.equal((await openDraft(d)).confirmations_needed, 1);
    const claim = await x.lead.call('uain_claims', { claim_id: d.claim });
    assert.equal(claim.status, 'unconfirmed');

    const second = await review(x.r2, d.revision);
    assert.equal(second.outcome, 'believed', JSON.stringify(second));
  });

  test('confirmations one member’s agents already gave count once', async () => {
    // As an older server could have recorded them.
    const d = await draft();
    const at = new Date().toISOString();
    for (const who of [x.r1, x.r1Twin])
      await t.db
        .prepare(
          "INSERT INTO claim_reviews (revision_id, reviewer, verdict, note, at) VALUES (?, ?, 'confirm', 'Checked.', ?)",
        )
        .run(d.revision, who.id, at);
    const open = await openDraft(d);
    assert.equal(open.reviews.length, 2);
    assert.equal(open.confirmations_needed, 1);
    assert.equal(
      (await x.lead.call('uain_claims', { claim_id: d.claim })).status,
      'unconfirmed',
    );
    const r = await review(x.r2, d.revision);
    assert.equal(r.outcome, 'believed', JSON.stringify(r));
  });

  test('reviewers from unrelated members still make a draft belief', async () => {
    const d = await draft();
    assert.equal(await offered(x.r1, d), true);
    assert.equal(await offered(x.r2, d), true);
    assert.equal((await review(x.r1, d.revision)).outcome, 'recorded');
    const r = await review(x.r2, d.revision);
    assert.equal(r.outcome, 'believed', JSON.stringify(r));
    assert.equal(r.claim.status, 'believed');
  });
});

describe('a task is done when N members have answered', () => {
  let x;
  before(async () => {
    const [lead, a, b, c, v1, v2, outsider] = await Promise.all(
      ['lead', 'a', 'b', 'c', 'v1', 'v2', 'outsider'].map((n) =>
        t.member(`Answers ${n} ${tag()}`),
      ),
    );
    const aTwin = await t.instance(a.key, 'Answers a twin');
    x = { lead, a, b, c, v1, v2, outsider, aTwin };
  });

  async function taskIn(wanted, extra = []) {
    const p = await project(x.lead, [x.a, x.b, x.c, x.v1, x.v2, x.outsider, ...extra]);
    const r = await x.lead.call('uain_task_open', {
      project_id: p.id,
      title: `Task ${tag()}`,
      question: 'What is the measured number?',
      done_when: 'A reproducible number.',
      how_to_check: 'Recompute it.',
      answers_wanted: wanted,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { p, k: r.task };
  }

  /** An answer, checked by v1 and v2 until it settles. */
  async function settle(who, k, p) {
    const sub = await who.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'Measured result',
      detail: 'Recomputed the number.',
      claim: 'The number is 42.',
    });
    assert.equal(sub.submitted, true, JSON.stringify(sub));
    for (const v of [x.v1, x.v2]) {
      let r = await verify(v, sub.contribution.id);
      // A later answer to a single-answer task is judged against its belief.
      if (r.error === 'against_claim_required')
        r = await verify(v, sub.contribution.id, {
          against_claim: 'supports',
          against_claim_revision: r.believed_claim.revision,
        });
      assert.ok(!r.error, JSON.stringify(r));
    }
    const settled = await t.db.getContribution(sub.contribution.id);
    assert.equal(settled.state, 'settled');
    return sub.contribution.id;
  }

  /** What the task, its project and a non-answering member's menu say. */
  async function reading(p, k, who = x.outsider) {
    const items = await menu(who, p.id);
    return {
      status: (await t.db.getTask(k.id)).status,
      progress: (await t.db.getProject(p.id)).progress.status,
      offered: items.some((i) => i.kind === 'task' && i.task_id === k.id),
      compare: items.some((i) => i.kind === 'compare' && i.task_id === k.id),
    };
  }

  const wantsMore = { status: 'open', progress: 'in_progress', offered: true, compare: false };
  const expected = (wanted, settled) =>
    settled < wanted
      ? wantsMore
      : wanted === 1
        ? { status: 'answered', progress: 'finished', offered: false, compare: false }
        : { status: 'needs_comparison', progress: 'in_progress', offered: false, compare: true };

  for (const wanted of [1, 2, 3])
    test(`asking for ${wanted}: status, progress and menu agree at 0 to 3 settled answers`, async () => {
      const { p, k } = await taskIn(wanted);
      assert.deepEqual(await reading(p, k), expected(wanted, 0), 'no answers');
      const answerers = [x.a, x.b, x.c];
      for (let n = 1; n <= 3; n++) {
        await settle(answerers[n - 1], k, p);
        assert.deepEqual(await reading(p, k), expected(wanted, n), `${n} settled`);
        // Nobody is offered a task it has already answered.
        for (const who of answerers.slice(0, n))
          assert.equal((await reading(p, k, who)).offered, false);
      }
    });

  test('a task asking for several is not answered by one, nor finished its project', async () => {
    const { p, k } = await taskIn(3);
    await settle(x.a, k, p);
    const project = await t.db.getProject(p.id);
    assert.equal((await t.db.getTask(k.id)).status, 'open');
    assert.equal(project.progress.status, 'in_progress');
    assert.equal(project.tasks.open, 1);
    assert.equal(project.tasks.answered, 0);
    const item = (await menu(x.outsider, p.id)).find(
      (i) => i.kind === 'task' && i.task_id === k.id,
    );
    assert.match(item.why, /asks for 3 independent answers and has 1/);
  });

  test('answers from two agents of one member count once', async () => {
    const { p, k } = await taskIn(2, [x.aTwin]);
    await settle(x.a, k, p);
    await settle(x.aTwin, k, p);
    assert.deepEqual(await reading(p, k), wantsMore);
    // Nor is the task offered to that member's agents again.
    assert.equal((await reading(p, k, x.a)).offered, false);
    assert.equal((await reading(p, k, x.aTwin)).offered, false);
    const item = (await menu(x.outsider, p.id)).find(
      (i) => i.kind === 'task' && i.task_id === k.id,
    );
    assert.match(item.why, /asks for 2 independent answers and has 1/);

    await settle(x.b, k, p);
    assert.deepEqual(await reading(p, k), expected(2, 2));
  });

  test('a compared task is answered once its comparison settles', async () => {
    const { p, k } = await taskIn(2);
    const ids = [await settle(x.a, k, p), await settle(x.b, k, p)];
    const cmp = await x.outsider.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      reconciles: ids,
      title: 'Comparison',
      detail: 'Both measured 42.',
      karma_claimed: 2,
      claim: 'The number is 42.',
    });
    assert.equal(cmp.submitted, true, JSON.stringify(cmp));
    assert.equal((await t.db.getTask(k.id)).status, 'awaiting_verification');
    await verify(x.v1, cmp.contribution.id);
    const done = await verify(x.v2, cmp.contribution.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    const now = await reading(p, k);
    assert.equal(now.status, 'answered');
    assert.equal(now.offered, false);
    assert.equal(now.compare, false);
    // What is left is the comparison's claim, to review.
    assert.equal(now.progress, 'in_progress');
    assert.equal(done.claim.status, 'unconfirmed');
    const [draft] = (await x.lead.call('uain_claims', { claim_id: done.claim.id })).open_drafts;
    for (const m of [x.a, x.b]) await review(m, draft.revision);
    assert.equal((await reading(p, k)).progress, 'finished');
  });
});
