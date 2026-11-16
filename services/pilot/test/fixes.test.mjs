import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

// Fixes from the first hepatitis C run (2026-09-25).
let t;
let sources;
before(async () => {
  t = await boot();
  sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const project = async (lead, extra = {}) =>
  (
    await lead.call('uain_propose', {
      title: `Fix ${Math.random().toString(36).slice(2, 8)}`,
      summary: 's',
      stop_conditions: STOP,
      ...extra,
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
const verdict = (who, id, v, note = 'Checked.') =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note });
const makeT2 = async (m) =>
  await t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(m.id);

describe('menus', () => {
  test('ties are broken differently for different agents', async () => {
    const lead = await t.member('Tie Lead');
    const agents = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => t.member(`Tie ${n}`)),
    );
    const p = await project(lead);
    await join(agents, p.id);
    for (let i = 0; i < 6; i++) await open(lead, p.id);
    const firsts = new Set();
    for (const a of agents) {
      const menu = await a.call('uain_next', { project_id: p.id });
      firsts.add(menu.items.find((i) => i.kind === 'task').task_id);
    }
    assert.ok(firsts.size > 1, 'not every agent is sent to the same first task');
  });

  test('a task someone is already on is marked covered, and a pass then does not ask the lead to rethink', async () => {
    const lead = await t.member('Cov Lead');
    const [a, b, c] = await Promise.all(['Cov A', 'Cov B', 'Cov C'].map((n) => t.member(n)));
    const p = await project(lead);
    await join([a, b, c], p.id);
    const k = await open(lead, p.id);
    await a.call('uain_task_start', { task_id: k.id });
    const item = (await b.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.task_id === k.id,
    );
    assert.equal(item.enough_on_it, true);
    assert.deepEqual(item.working, [a.id], 'the offered task names who is on it');
    const own = (await a.call('uain_next', { project_id: p.id })).items.filter((i) => i.task_id === k.id);
    assert.deepEqual(own.map((i) => i.kind), ['continue_task'], 'its worker is told to finish it, not offered it');
    await b.call('uain_task_start', { task_id: k.id });
    await b.call('uain_release', { kind: 'task', id: k.id, reason: 'a is on it' });
    const afterPass = await b.call('uain_next', { project_id: p.id });
    assert.ok(!afterPass.items.some((i) => i.task_id === k.id), 'not offered again to one who passed');
    await c.call('uain_task_start', { task_id: k.id });
    await c.call('uain_release', { kind: 'task', id: k.id, reason: 'a is on it' });
    const passed = (await lead.call('uain_tasks', { task_id: k.id })).passed;
    assert.ok(passed.recent.every((x) => x.crowded === 1));
    assert.ok(
      !(await lead.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'rethink'),
    );
  });
});

describe('after a dispute', () => {
  test('a reopened task carries its rejected answers, and two rejections ask the lead to rethink', async () => {
    const lead = await t.member('Dis Lead');
    const [w1, w2, v, judge, next] = await Promise.all(
      ['Dis W1', 'Dis W2', 'Dis V', 'Dis Judge', 'Dis Next'].map((n) => t.member(n)),
    );
    const p = await project(lead);
    await join([w1, w2, v, judge, next], p.id);
    await makeT2(judge);
    const k = await open(lead, p.id);
    for (const w of [w1, w2]) {
      const sub = await w.call('uain_contribute', { project_id: p.id, task_id: k.id, title: 'x', detail: 'd', claim: 'What the answer establishes.' });
      await verdict(v, sub.contribution.id, 'disputed', 'The dose is wrong: the paper says 600 mg.');
      await verdict(judge, sub.contribution.id, 'disputed', 'Agreed, 600 mg.');
    }
    const item = (await next.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'task' && i.task_id === k.id,
    );
    assert.equal(item.earlier_attempts.length, 2);
    assert.match(item.earlier_attempts[0].objections[0].note, /600 mg/);
    const rethink = (await lead.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'rethink',
    );
    assert.equal(rethink.task_id, k.id);
    assert.match(rethink.why, /2 answers to this task you lead were rejected/);
  });

  test('a disputed claim draft is offered for revision, with the objection', async () => {
    const lead = await t.member('Rev Lead');
    const [w, rival, v1, v2, r1, fixer] = await Promise.all(
      ['Rev W', 'Rev Rival', 'Rev V1', 'Rev V2', 'Rev R1', 'Rev Fixer'].map((n) => t.member(n)),
    );
    const p = await project(lead);
    await join([w, rival, v1, v2, r1, fixer], p.id);
    const k = await open(lead, p.id);
    const sub = await w.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'x',
      detail: 'd',
      claim: 'This was the only study.',
    });
    // Disputed work an arbiter confirms keeps its claim a draft for review.
    await makeT2(rival);
    await verdict(v1, sub.contribution.id, 'disputed', 'Overstated?');
    const done = await verdict(rival, sub.contribution.id, 'confirmed', 'The work holds.');
    assert.equal(done.claim.status, 'unconfirmed');
    const draft = (await lead.call('uain_claims', { claim_id: done.claim.id })).history[0];

    // A verifier of the cited work cannot review the claim on it.
    const own = await rival.call('uain_claim_review', {
      revision_id: draft.revision,
      verdict: 'confirm',
      note: 'ok',
    });
    assert.equal(own.error, 'verified_the_source');

    await r1.call('uain_claim_review', {
      revision_id: draft.revision,
      verdict: 'dispute',
      note: 'Say "one of the studies", not "the only study".',
    });
    // A dispute contests the draft; an arbiter upholding it closes it.
    const judge = await t.member('Rev Judge Op');
    await join([judge], p.id);
    await makeT2(judge);
    const upheld = await judge.call('uain_claim_review', {
      revision_id: draft.revision,
      verdict: 'dispute',
      note: 'The objection is right.',
    });
    assert.equal(upheld.outcome, 'rejected');
    const revise = (await fixer.call('uain_next', { project_id: p.id })).items.find(
      (i) => i.kind === 'revise_claim',
    );
    assert.equal(revise.claim_id, done.claim.id);
    assert.match(revise.objections[0].note, /one of the studies/);

    await fixer.call('uain_claim_create', {
      project_id: p.id,
      statement: 'This was one of the studies.',
      sources: [sub.contribution.id],
      reason: 'Corrected per the objection.',
    });
    assert.ok(
      !(await fixer.call('uain_next', { project_id: p.id })).items.some((i) => i.kind === 'revise_claim'),
      'answered by the new draft',
    );
  });
});

describe('forecasts and the evidence cutoff', () => {
  test('a forecast task needs a probability, and its claim states the bet', async () => {
    const lead = await t.member('Fc Lead');
    const [w, v1, v2] = await Promise.all(['Fc W', 'Fc V1', 'Fc V2'].map((n) => t.member(n)));
    const p = await project(lead);
    await join([w, v1, v2], p.id);
    const k = await open(lead, p.id, { answer_type: 'forecast' });
    assert.equal(k.answer_type, 'forecast');
    const missing = await w.call('uain_contribute', { project_id: p.id, task_id: k.id, title: 'x', detail: 'd' });
    assert.equal(missing.error, 'forecast_required');
    const sub = await w.call('uain_contribute', {
      project_id: p.id,
      task_id: k.id,
      title: 'Interferon-free cure',
      detail: 'Reasoning from 2010 evidence.',
      forecast: { statement: 'An interferon-free regimen cures most genotype 1 patients', probability: 0.7, horizon: 'by 2016' },
    });
    assert.equal(sub.contribution.evidence, 'derived');
    assert.match(sub.contribution.claim_statement, /probability 70%, by 2016/);
  });

  test('sources published after the cutoff are marked, not refused', async () => {
    sources.setSourceFetcher(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('esummary')
          ? { result: { 36449413: { sortpubdate: '2023/01/05 00:00' }, 19965718: { sortpubdate: '2010/01/08 00:00' } } }
          : {},
    }));
    const lead = await t.member('Cut Lead');
    const p = await project(lead, { evidence_cutoff: '2010-12-31' });
    const sub = await lead.call('uain_contribute', {
      project_id: p.id,
      title: 'x',
      detail: 'd',
      sources: ['PMID: 36449413', 'PMID: 19965718'],
    });
    assert.equal(sub.submitted, true);
    const byId = Object.fromEntries(sub.contribution.source_checks.map((c) => [c.source, c]));
    assert.equal(byId['PMID: 36449413'].after_cutoff, true);
    assert.equal(byId['PMID: 19965718'].after_cutoff, undefined);
  });
});
