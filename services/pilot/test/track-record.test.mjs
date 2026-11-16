/**
 * The karma ledger and the track record (white paper 5.2; D10, decided 30
 * September 2026: the Track Record Manager is a server function).
 *
 * Every place karma changes writes a karma_events row that names the ledger
 * entry announcing it; an agent's rows add up to its karma; the backfill from
 * the ledger is idempotent and gives each agent at most one opening balance;
 * and the track record, over HTTP and MCP, is derived from the record.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let karma;
before(async () => {
  t = await boot();
  karma = await import('../dist/src/application/karma-ledger.js');
});
after(async () => {
  await t.close();
});

const STOP = ['Halt if the work would require restricted data.'];
const NEW = {
  novelty: 'new',
  novelty_checked: ['Google Scholar: "track record digest"', 'GitHub code search: track record digest'],
};
const KNOWN = { novelty: 'known', known_source: 'https://example.org/already-public' };

async function project(lead) {
  const r = await lead.call('uain_propose', {
    title: `Record ${Math.random().toString(36).slice(2, 8)}`,
    summary: 'Test project',
    stop_conditions: STOP,
  });
  assert.equal(r.opened, true, JSON.stringify(r));
  return r.project;
}
const join = (members, pid) =>
  Promise.all(members.map((m) => m.call('uain_join_project', { project_id: pid })));
const makeT2 = (m) => t.db.prepare("UPDATE participants SET tier = 'T2' WHERE id = ?").run(m.id);
const verdict = (who, id, v = 'confirmed', extra = {}) =>
  who.call('uain_verify', { contribution_id: id, verdict: v, note: 'Checked.', ...extra });
async function work(who, pid, claimed = 20, extra = {}) {
  const r = await who.call('uain_contribute', {
    project_id: pid,
    title: 'w',
    detail: 'x',
    karma_claimed: claimed,
    ...extra,
  });
  assert.equal(r.submitted, true, JSON.stringify(r));
  return r.contribution.id;
}

const rowsOf = (id) =>
  t.db.prepare('SELECT * FROM karma_events WHERE participant_id = ? ORDER BY id').all(id);
const event = (id) => t.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
const karmaOf = async (id) => (await t.db.prepare('SELECT karma FROM participants WHERE id = ?').get(id)).karma;

/** The one row a change wrote, and the ledger entry it points at. */
async function lastRow(id, kind) {
  const rows = (await rowsOf(id)).filter((r) => r.kind === kind);
  assert.ok(rows.length, `a ${kind} row for ${id}`);
  const row = rows.at(-1);
  assert.ok(row.event_id, 'the row names its ledger entry');
  const e = await event(row.event_id);
  assert.ok(e, 'the entry exists');
  return { row, e };
}

const MAINTENANCE = fileURLToPath(new URL('../dist/src/application/maintenance.js', import.meta.url));
function maintain(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAINTENANCE], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

describe('every karma change is a row of the karma ledger', () => {
  // First, while the contribution numbers are still RC-4501 and RC-4502: the
  // operator's one restatement of RC-4502 moves karma too.
  test('an operator restatement (maintenance restate-rc4502)', async () => {
    const lead = await t.member('K-Kestrel');
    const checker = await t.enrol({ name: 'claude-code', operator: 'K-Anthropic' });
    assert.equal(checker.id, 'claude-code');
    await t.makeUain(checker.id);
    const p = await project(lead);
    await t.db.joinProject(p.id, checker.id);
    await work(lead, p.id, 5);
    const id = await work(lead, p.id, 20, { artifacts: [{ label: 'uain-surface-divergence-r2-v1' }] });
    assert.equal(id, 'RC-4502');
    const checked = await t.db.verify({ verifier: checker.id, contributionId: id, verdict: 'confirmed', note: 'Scope ruling.' });
    assert.equal(checked.error, undefined, JSON.stringify(checked));
    // As it stood before the restatement: partial, and nothing awarded yet.
    await t.db.prepare("UPDATE verifications SET verdict = 'partial' WHERE contribution_id = ?").run(id);
    await t.db.prepare('UPDATE contributions SET karma_awarded = 0 WHERE id = ?').run(id);
    const before_ = await karmaOf(lead.id);

    const r = await maintain({ ACTION: 'restate-rc4502', OPERATOR_ID: 'operator:tester' });
    assert.equal(r.code, 0, r.err);
    assert.equal(await karmaOf(lead.id), before_ + 12);
    const { row, e } = await lastRow(lead.id, 'operator_restatement');
    assert.equal(row.delta, 12);
    assert.equal(row.ref, 'RC-4502');
    assert.equal(e.kind, 'amendment');
    assert.equal(e.actor, 'operator:tester');
    assert.equal(e.peer, lead.id);
  });

  test('settled work, and no karma for its checkers', async () => {
    const lead = await t.member('K-Lead');
    const v1 = await t.member('K-V1');
    const v2 = await t.member('K-V2');
    const p = await project(lead);
    await join([v1, v2], p.id);
    const id = await work(lead, p.id, 20);
    await verdict(v1, id);
    const done = await verdict(v2, id);
    assert.equal(done.settled, true);
    const { row, e } = await lastRow(lead.id, 'settlement');
    assert.equal(row.delta, done.contribution.karma_awarded);
    assert.equal(row.ref, id);
    assert.equal(row.member_id, (await t.db.getParticipant(lead.id)).member_id);
    assert.match(row.reason, new RegExp(id));
    assert.equal(e.kind, 'karma');
    assert.equal(e.actor, lead.id);
    assert.match(e.summary, /κ settled for "w"/);
    // The verifiers' share is credits: it writes no karma row.
    assert.deepEqual(await rowsOf(v1.id), []);
    assert.deepEqual(await rowsOf(v2.id), []);
  });

  test('a task price won', async () => {
    const lead = await t.member('K-PLead');
    const a = await t.member('K-PA');
    const v1 = await t.member('K-PV1');
    const v2 = await t.member('K-PV2');
    const p = await project(lead);
    await join([a, v1, v2], p.id);
    const task = (await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Priced',
      question: 'What is the digest?',
      done_when: 'A digest is reported.',
      how_to_check: 'Recompute it.',
      karma_offered: 20,
    })).task;
    const sub = await a.call('uain_contribute', {
      project_id: p.id, task_id: task.id, title: 'Answer', detail: 'Recomputed.', claim: 'The digest is 42.',
    });
    assert.equal(sub.submitted, true, JSON.stringify(sub));
    await verdict(v1, sub.contribution.id);
    const done = await verdict(v2, sub.contribution.id);
    assert.equal(done.settled, true, JSON.stringify(done));
    const { row, e } = await lastRow(a.id, 'settlement');
    assert.ok(row.delta > 0);
    assert.equal(row.delta, done.contribution.karma_awarded, 'the price');
    assert.match(row.reason, new RegExp(`price of ${task.id}`));
    assert.equal(e.kind, 'karma');
    assert.equal(await karmaOf(a.id), row.delta);
  });

  test("an award a future task's KPI held, paid once the KPI is met", async () => {
    const sources = await import('../dist/src/integrations/sources.js');
    // The KPI's result source is checked when it resolves: never the network here.
    sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    sources.setSourceFetcher(async () => ({
      ok: true, status: 200, headers: new Headers(), json: async () => ({}), text: async () => '',
    }));
    try {
      const lead = await t.member('K-KLead');
      const a = await t.member('K-KAnswer');
      const v1 = await t.member('K-KV1');
      const v2 = await t.member('K-KV2');
      const resolver = await t.member('K-KResolver');
      const p = await project(lead);
      await join([a, v1, v2, resolver], p.id);
      const opened = await lead.call('uain_task_open', {
        project_id: p.id, title: 'Future', kind: 'future',
        question: 'What response rate will the phase 3 trial report?',
        done_when: 'A forecast with its reasoning.', how_to_check: 'Re-derive it.',
        kpi: {
          statement: 'The phase 3 trial reports an objective response rate of at least 40 percent.',
          metric: 'objective response rate', comparator: '>=', threshold: 40, unit: '%',
          source: 'NCT01234567',
          resolves_by: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10),
        },
      });
      assert.ok(opened.task, JSON.stringify(opened));
      const sub = await a.call('uain_contribute', {
        project_id: p.id, task_id: opened.task.id, title: 'Forecast', detail: 'Pooled the cohorts.',
        claim: 'The response rate will be about 45 percent.', karma_claimed: 20,
      });
      await verdict(v1, sub.contribution.id);
      await verdict(v2, sub.contribution.id);
      assert.deepEqual(await rowsOf(a.id), [], 'held: no karma yet, so no row');
      const r = await resolver.call('uain_kpi_resolve', {
        task_id: opened.task.id, observed: 45, source: 'https://example.org/trial-results',
        note: 'The registry posted the primary endpoint results.',
      });
      assert.equal(r.met, true, JSON.stringify(r));
      const { row, e } = await lastRow(a.id, 'settlement');
      assert.ok(row.delta > 0);
      assert.equal(row.delta, await karmaOf(a.id));
      assert.equal(row.ref, sub.contribution.id);
      assert.match(row.reason, new RegExp(`KPI of ${opened.task.id} was met`));
      assert.equal(e.kind, 'karma');
    } finally {
      sources.setSourceFetcher(null);
      sources.setSourceResolver(null);
    }
  });

  test('an overturned dispute', async () => {
    const lead = await t.member('K-DLead');
    const disputer = await t.member('K-Disputer');
    const arbiter = await t.member('K-Arbiter');
    const p = await project(lead);
    await join([disputer, arbiter], p.id);
    await makeT2(arbiter);
    const id = await work(lead, p.id, 5);
    await verdict(disputer, id, 'disputed');
    const resolved = await verdict(arbiter, id, 'confirmed');
    assert.equal(resolved.settled, true, JSON.stringify(resolved));
    const { row, e } = await lastRow(disputer.id, 'dispute_overturned');
    assert.equal(row.delta, -2);
    assert.equal(row.ref, id);
    assert.equal(e.actor, disputer.id);
    assert.match(e.summary, /^Lost 2κ: a dispute on/);
    assert.equal(await karmaOf(disputer.id), -2);
  });

  test('work an arbiter finds no effort in', async () => {
    const lead = await t.member('K-NLead');
    const author = await t.member('K-NAuthor');
    const v1 = await t.member('K-NV1');
    const judge = await t.member('K-NJudge');
    const p = await project(lead);
    await join([author, v1, judge], p.id);
    await makeT2(judge);
    const id = await work(author, p.id, 5);
    await verdict(v1, id, 'disputed');
    const closed = await verdict(judge, id, 'disputed', { no_effort: true });
    assert.equal(closed.rejected, true, JSON.stringify(closed));
    const { row, e } = await lastRow(author.id, 'no_effort');
    assert.equal(row.delta, -2);
    assert.equal(row.ref, id);
    assert.match(e.summary, /no effort/);
    assert.equal(e.peer, judge.id);
  });

  test('an overturned dispute of a claim revision', async () => {
    const people = await Promise.all(
      ['lead', 'a', 'b', 'v1', 'v2', 'judge', 'critic'].map((x) => t.member(`K-Claims ${x}`)),
    );
    const [lead, a, b, v1, v2, judge, critic] = people;
    const p = await project(lead);
    await join(people.slice(1), p.id);
    await makeT2(judge);
    const believed = async () => {
      const task = (await lead.call('uain_task_open', {
        project_id: p.id, title: `Task ${Math.random().toString(36).slice(2, 8)}`,
        question: 'What is the measured number?', done_when: 'A reproducible number.',
        how_to_check: 'Recompute from the inputs.',
      })).task;
      const sub = await a.call('uain_contribute', {
        project_id: p.id, task_id: task.id, title: 'Measured', detail: 'Recomputed.', claim: 'The number is 42.',
      });
      await verdict(v1, sub.contribution.id);
      const done = await verdict(v2, sub.contribution.id);
      return { claim: await lead.call('uain_claims', { claim_id: done.claim.id }), contribution: sub.contribution };
    };
    const base = await believed();
    const evidence = await believed();
    const edit = await b.call('uain_claim_edit', {
      claim_id: base.claim.id, base_revision: base.claim.believed_revision, statement: 'The number is 43.',
      sources: [base.contribution.id, evidence.contribution.id], reason: 'New evidence.',
    });
    assert.ok(edit.revision, JSON.stringify(edit));
    const review = (who, v) => who.call('uain_claim_review', { revision_id: edit.revision, verdict: v, note: 'Checked the evidence.' });
    assert.equal((await review(critic, 'dispute')).outcome, 'contested');
    const overturned = await review(judge, 'confirm');
    assert.equal(overturned.error, undefined, JSON.stringify(overturned));
    const { row, e } = await lastRow(critic.id, 'claim_dispute_overturned');
    assert.equal(row.delta, -2);
    assert.equal(row.ref, `${base.claim.id} revision ${edit.revision}`);
    assert.match(e.summary, /a dispute of revision/);
  });

  test('every agent’s rows add up to its karma', async () => {
    const check = await karma.karmaConsistency();
    assert.equal(check.ok, true, JSON.stringify(check.mismatched));
    assert.ok(check.checked > 10);
    const sums = await t.db
      .prepare(
        `SELECT p.id, p.karma, COALESCE(SUM(k.delta), 0) AS summed
         FROM participants p LEFT JOIN karma_events k ON k.participant_id = p.id
         GROUP BY p.id, p.karma`,
      )
      .all();
    for (const r of sums) assert.equal(r.karma, r.summed, r.id);
    // Every row written since the karma ledger began names its entry, and no
    // entry has two rows for one agent.
    const live = await t.db.prepare("SELECT COUNT(*) AS n FROM karma_events WHERE event_id IS NULL AND kind <> 'opening_balance'").get();
    assert.equal(live.n, 0);
  });
});

describe('the backfill from the ledger', () => {
  test('entries from before the karma ledger become rows; the rest is one opening balance', async () => {
    const old = await t.member('K-Old');
    // As the ledger held them before karma_events: entries, and the counter.
    await t.db.record('karma', old.id, '15κ settled for "Work from before"');
    await t.db.record('karma', old.id, 'Lost 2κ: a dispute on RC-9999 was overturned by an arbiter', 'someone');
    await t.db.record('karma', old.id, `9 credits minted to ${old.id} for RC-9999 (bounty)`);
    await t.db.record('karma', old.id, 'RC-9998 is the first verified result of T-9 and earns its price: 15κ');
    await t.db.prepare('UPDATE participants SET karma = 20 WHERE id = ?').run(old.id);

    const first = await karma.backfillKarmaEvents();
    assert.equal(first.rows, 2);
    assert.equal(first.opening, 1);
    const rows = await rowsOf(old.id);
    assert.deepEqual(
      rows.map((r) => [r.kind, r.delta]),
      [['opening_balance', 7], ['settlement', 15], ['dispute_overturned', -2]],
    );
    const [opening, settled, lost] = rows;
    assert.equal(opening.reason, 'opening balance');
    assert.equal(opening.event_id, null);
    assert.match(settled.reason, new RegExp(`^backfilled from ledger event #${settled.event_id}$`));
    assert.equal((await event(settled.event_id)).summary, '15κ settled for "Work from before"');
    assert.equal(lost.ref, 'RC-9999');
    assert.equal((await karma.karmaConsistency([old.id])).ok, true);

    // Again: nothing to do, nothing written.
    assert.deepEqual(await karma.backfillKarmaEvents(), { rows: 0, opening: 0 });
    assert.equal((await rowsOf(old.id)).length, 3);

    // Karma moved without a row later is reported, never absorbed: an agent
    // gets one opening balance.
    await t.db.prepare('UPDATE participants SET karma = 23 WHERE id = ?').run(old.id);
    assert.deepEqual(await karma.backfillKarmaEvents(), { rows: 0, opening: 0 });
    const off = await karma.karmaConsistency([old.id]);
    assert.equal(off.ok, false);
    assert.deepEqual(off.mismatched, [{ participant_id: old.id, karma: 23, recorded: 20 }]);
    await t.db.prepare('UPDATE participants SET karma = 20 WHERE id = ?').run(old.id);
  });

  test('a server starting up backfills, once', async () => {
    const late = await t.member('K-Late');
    // An entry written by a server on the code before the karma ledger.
    await t.db.record('karma', late.id, '4κ settled for RC-9997');
    await t.db.prepare('UPDATE participants SET karma = 4 WHERE id = ?').run(late.id);
    const count = async () => (await t.db.prepare('SELECT COUNT(*) AS n FROM karma_events').get()).n;
    const before_ = await count();
    // Any process that loads the store runs the start-up backfill: the
    // maintenance script's list is one.
    for (let i = 0; i < 2; i++) {
      const r = await maintain({ ACTION: 'list' });
      assert.equal(r.code, 0, r.err);
    }
    assert.equal(await count(), before_ + 1);
    const [row] = await rowsOf(late.id);
    assert.equal(row.kind, 'settlement');
    assert.equal(row.ref, 'RC-9997');
    assert.equal(row.delta, 4);
    assert.equal((await karma.karmaConsistency()).ok, true);
  });

  test('what an entry says about karma', () => {
    const f = karma.karmaFromEntry;
    assert.deepEqual(f({ kind: 'karma', actor: 'a', peer: null, summary: '12κ settled for "T"' }), {
      participant: 'a', delta: 12, kind: 'settlement', ref: null,
    });
    assert.equal(f({ kind: 'karma', actor: 'a', peer: null, summary: 'Transferred 5 credits' }), null);
    assert.equal(f({ kind: 'karma', actor: 'a', peer: null, summary: 'Released 40 deferred credits across 2 award(s)' }), null);
    assert.equal(f({ kind: 'karma', actor: 'a', peer: null, summary: 'RC-1 is verified but restates public knowledge; nothing is paid' }), null);
    assert.deepEqual(f({ kind: 'karma', actor: 'a', peer: null, summary: 'Lost 2κ: for a reason no rule names' }), {
      participant: 'a', delta: -2, kind: 'backfill', ref: null,
    });
    assert.deepEqual(
      f({
        kind: 'amendment', actor: 'operator:x', peer: 'kestrel',
        summary: 'Restated the verdict on RC-4502 from partial to confirmed with one artefact excluded; award 60κ to 100κ',
      }),
      { participant: 'kestrel', delta: 40, kind: 'operator_restatement', ref: 'RC-4502' },
    );
    assert.equal(f({ kind: 'verification', actor: 'a', peer: null, summary: '12κ settled for "T"' }), null);
  });
});

describe('the track record', () => {
  let x;
  before(async () => {
    const [lead, a, v1, v2, judge] = await Promise.all(
      ['lead', 'a', 'v1', 'v2', 'judge'].map((n) => t.member(`TR-${n}`)),
    );
    const a2 = await t.instance(a.key, 'TR-a', 'TR-a-second');
    const p = await project(lead);
    await join([a, a2, v1, v2, judge], p.id);
    await makeT2(judge);
    const task = (await lead.call('uain_task_open', {
      project_id: p.id, title: 'Priced', question: 'What is the digest?', done_when: 'A digest.',
      how_to_check: 'Recompute it.', karma_offered: 10,
    })).task;
    // a: an answer that wins the price, attested new.
    const answer = await a.call('uain_contribute', {
      project_id: p.id, task_id: task.id, title: 'Answer', detail: 'Recomputed.', claim: 'The digest is 42.',
    });
    await verdict(v1, answer.contribution.id, 'confirmed', NEW);
    await verdict(v2, answer.contribution.id, 'confirmed', NEW);
    // a2 (the same member): work shown to be known, settled with nothing paid.
    const known = await work(a2, p.id, 10);
    await verdict(v1, known, 'confirmed', KNOWN);
    await verdict(v2, known, 'confirmed', KNOWN);
    // a: work rejected on arbitration, v1's dispute upheld.
    const rejected = await work(a, p.id, 10);
    await verdict(v1, rejected, 'disputed');
    await verdict(judge, rejected, 'disputed');
    // a: work v2 disputes and the arbiter confirms: v2 loses its dispute.
    const contested = await work(a, p.id, 10);
    await verdict(v2, contested, 'disputed');
    await verdict(judge, contested, 'confirmed', NEW);
    // a: work still held.
    const held = await work(a, p.id, 10);
    // a checks lead's work, which settles: a check that agreed.
    const leads = await work(lead, p.id, 10);
    await verdict(a, leads, 'confirmed', NEW);
    await verdict(v1, leads, 'confirmed', NEW);
    x = { lead, a, a2, v1, v2, judge, p, task, answer: answer.contribution.id, known, rejected, contested, held, leads };
  });

  const get = async (path) => {
    const res = await t.http(path);
    return { status: res.status, body: await res.json() };
  };

  test("a member's record: all its agents, derived from the record", async () => {
    const member = (await t.db.getParticipant(x.a.id)).member;
    const { status, body } = await get(`/api/members/${member.address}/track-record`);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.subject.kind, 'member');
    assert.deepEqual(body.subject.agents.sort(), [x.a.id, x.a2.id].sort());
    const s = body.summary;
    assert.equal(s.contributions.submitted, 5);
    assert.equal(s.contributions.settled, 3);
    assert.equal(s.contributions.rejected, 1);
    assert.equal(s.contributions.held, 1);
    assert.equal(s.contributions.novelty.new, 2);
    assert.equal(s.contributions.novelty.known, 1);
    assert.equal(s.contributions.settled_known, 1);
    assert.equal(s.checks.given, 1);
    assert.equal(s.checks.agreed, 1);
    assert.deepEqual(s.disputes.against_its_work, { won: 1, lost: 1, pending: 0 });
    assert.equal(s.tasks_answered, 1);
    assert.equal(s.prizes_won, 1);
    assert.equal(s.projects_led, 0);
    assert.equal(s.karma.consistent, true);
    assert.equal(s.karma.balance, member.karma);
    assert.equal(s.karma.from_karma_ledger, member.karma);
    assert.ok(body.contributions.every((c) => [x.a.id, x.a2.id].includes(c.agent)));
    assert.equal(body.prizes[0].task_id, x.task.id);
    assert.equal(body.prizes[0].contribution_id, x.answer);
    assert.equal(body.tasks_answered[0].task_id, x.task.id);
    assert.ok(body.test_results, 'test results are part of it');
    // Every karma row names its entry, and the running balance ends at karma.
    const h = body.karma_history;
    assert.equal(h.order, 'newest_first');
    assert.equal(h.events[0].balance_after, member.karma);
    assert.ok(h.events.every((r) => r.event_id));
    assert.ok(h.kinds.settlement);
  });

  test("an agent's record: its own checks and disputes, and who led what", async () => {
    const v2 = (await get(`/api/directory/${x.v2.id}/track-record`)).body;
    assert.equal(v2.subject.kind, 'agent');
    assert.deepEqual(v2.summary.disputes.raised_on_work, { won: 0, lost: 1, pending: 0 });
    const lost = v2.checks.find((c) => c.contribution_id === x.contested);
    assert.equal(lost.agreement, 'disagreed');
    assert.equal(lost.dispute, 'lost');
    assert.equal(v2.summary.karma.balance, -2);
    assert.equal(v2.karma_history.events[0].kind, 'dispute_overturned');

    const v1 = (await get(`/api/directory/${x.v1.id}/track-record`)).body;
    assert.deepEqual(v1.summary.disputes.raised_on_work, { won: 1, lost: 0, pending: 0 });
    assert.equal(v1.checks.find((c) => c.contribution_id === x.rejected).agreement, 'agreed');
    assert.equal(v1.summary.checks.given, 4);
    assert.equal(v1.summary.checks.agreed, 4);

    const lead = (await get(`/api/directory/${x.lead.id}/track-record`)).body;
    assert.equal(lead.summary.projects_led, 1);
    assert.equal(lead.projects_led[0].id, x.p.id);
    assert.equal(lead.summary.contributions.settled, 1);
  });

  test('the karma history comes a page at a time', async () => {
    const all = (await get(`/api/directory/${x.a.id}/track-record`)).body.karma_history;
    assert.ok(all.count >= 2);
    const one = (await get(`/api/directory/${x.a.id}/track-record?page=2&page_size=1`)).body.karma_history;
    assert.equal(one.page, 2);
    assert.equal(one.page_size, 1);
    assert.equal(one.pages, all.count);
    assert.equal(one.events.length, 1);
    assert.deepEqual(one.events[0], all.events[1]);
  });

  test('over MCP: by address, by agent, and your own member by default', async () => {
    const member = (await t.db.getParticipant(x.a.id)).member;
    const byAddress = await x.lead.call('uain_track_record', { address: member.address });
    assert.equal(byAddress.subject.address, member.address);
    const mine = await x.a2.call('uain_track_record', {});
    assert.equal(mine.subject.address, member.address);
    assert.deepEqual(mine.summary, byAddress.summary);
    const agent = await x.lead.call('uain_track_record', { id: x.v1.id, page_size: 1 });
    assert.equal(agent.subject.id, x.v1.id);
    assert.equal((await x.lead.call('uain_track_record', { id: 'nobody-here' })).error, 'not_found');
    const anon = await (await t.connect()).call('uain_track_record', {});
    assert.equal(anon.error, 'not_authenticated');
  });

  test('unknown members and agents are 404s, and profiles link their records', async () => {
    assert.equal((await get(`/api/members/uain1${'0'.repeat(40)}/track-record`)).status, 404);
    assert.equal((await get('/api/directory/nobody-here/track-record')).status, 404);
    const profile = (await get(`/api/directory/${x.a.id}`)).body;
    assert.equal(profile.track_record, `/api/directory/${x.a.id}/track-record`);
    const member = (await t.db.getParticipant(x.a.id)).member;
    const record = (await get(`/api/members/${member.address}`)).body;
    assert.equal(record.track_record, `/api/members/${member.address}/track-record`);
  });
});
