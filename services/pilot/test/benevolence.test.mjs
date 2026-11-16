/**
 * Benevolent, neutral or malevolent (white paper 5.7; decision D8, 30
 * September 2026). Every new project and task declares its class, and a
 * malevolent one is refused; members flag work as malevolent, and a default
 * verifier or trusted arbiter of another member decides. Upheld, a task
 * closes and pays nothing, a project halts, and the member that created it
 * loses karma. Booted with the rule required, as production runs; the rest of
 * the suite runs without it, as a local test network may, and the relaxed
 * mode is checked here in a server of its own.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let sources;
let lead, a, v1, v2, c, judge, plain, p;
before(async () => {
  t = await boot({ UAIN_REQUIRE_BENEVOLENCE: '1' });
  sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  sources.setSourceFetcher(async (url) => ({
    ok: !url.includes('gone'),
    status: url.includes('gone') ? 404 : 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '',
  }));
  [lead, a, v1, v2, c, judge] = await Promise.all(
    ['Lead', 'Answer', 'Check One', 'Check Two', 'Flagger', 'Judge'].map((n) =>
      t.member(`${n} Labs`, `benevolence-${n.toLowerCase().replace(' ', '-')}`)),
  );
  plain = await t.member('Plain Labs', 'benevolence-plain', { uain: false });
  p = (await lead.call('uain_propose', {
    title: 'Benevolence',
    summary: 'Analyse open health data for patients and clinicians.',
    stop_conditions: STOP,
    benevolence: DECLARED,
  })).project;
  await join([a, v1, v2, c, judge, plain], p.id);
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would need restricted data.'];
const DECLARED = {
  class: 'benevolent',
  statement: 'Patients and clinicians benefit from open answers; the work reads public data only and harms nobody.',
};
const HARM =
  'The task asks for a step-by-step route to make a toxin more transmissible, which endangers the public.';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
const digestOf = (record) => sha(JSON.stringify(canonical({ version: 1, ...record })));
const events = async () => await t.db.prepare('SELECT * FROM events ORDER BY id').all();
const committed = async (subject) =>
  (await events()).find((e) => e.commits?.startsWith(`${subject} sha256:`));
const karmaOf = async (id) => (await t.db.getParticipant(id)).karma;
const join = (ms, pid) => Promise.all(ms.map((m) => m.call('uain_join_project', { project_id: pid })));

const openTask = async (who = lead, extra = {}) =>
  (await who.call('uain_task_open', {
    project_id: p.id,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'How often does the open registry record this outcome?',
    done_when: 'A count with the query that produced it.',
    how_to_check: 'Run the query again.',
    benevolence: DECLARED,
    ...extra,
  })).task;
const flag = (who, target, extra = {}) =>
  who.call('uain_benevolence_flag', {
    target,
    reason: HARM,
    evidence: 'https://example.org/harm-report',
    ...extra,
  });
const decide = (who, flagId, decision, note = 'The evidence shows the harm the flag describes, plainly.') =>
  who.call('uain_benevolence_decide', { flag_id: flagId, decision, note });
const menu = async (who) => (await who.call('uain_next', { limit: 50 })).items;
const flagItems = async (who) => (await menu(who)).filter((i) => i.kind === 'benevolence_flag');

describe('declaring a class at opening', () => {
  test('a project needs one, a malevolent one is refused, and it is shown and committed', async () => {
    const base = { title: 'No class', summary: 's', stop_conditions: STOP };
    const none = await lead.call('uain_propose', base);
    assert.equal(none.opened, false);
    assert.equal(none.error, 'benevolence_required');
    assert.match(none.message, /benevolent .* or neutral/);
    const bad = await lead.call('uain_propose', {
      ...base, benevolence: { class: 'malevolent', statement: 'It attacks another party on purpose, at scale.' },
    });
    assert.equal(bad.error, 'malevolent_refused');
    assert.match(bad.message, /not permitted/);
    const odd = await lead.call('uain_propose', { ...base, benevolence: { class: 'good', statement: DECLARED.statement } });
    assert.equal(odd.error, 'bad_benevolence_class');
    assert.deepEqual(odd.needed.class, ['benevolent', 'neutral']);
    const thin = await lead.call('uain_propose', { ...base, benevolence: { class: 'neutral', statement: 'Harmless.' } });
    assert.equal(thin.error, 'benevolence_statement_length');
    assert.deepEqual(thin.needed.statement_chars, { min: 20, max: 1000 });
    const long = await lead.call('uain_propose', {
      ...base, benevolence: { class: 'neutral', statement: 'x'.repeat(1001) },
    });
    assert.equal(long.error, 'benevolence_statement_length');
    assert.equal((await t.db.listProjects()).filter((x) => x.title === 'No class').length, 0);

    assert.deepEqual(p.benevolence, DECLARED);
    const served = await (await t.http(`/api/projects/${p.id}`)).json();
    assert.deepEqual(served.benevolence, DECLARED);
    const read = await v1.call('uain_projects', { project_id: p.id });
    assert.deepEqual(read.project.benevolence, DECLARED);
    // The list carries the class, not the statement.
    const listed = (await (await t.http('/api/projects')).json()).projects.find((x) => x.id === p.id);
    assert.deepEqual(listed.benevolence, { class: 'benevolent' });
    const e = await committed(`project ${p.id}`);
    assert.ok(e, 'the proposal commits the project and its class');
    assert.match(e.summary, /declared benevolent$/);
    assert.equal(e.commits, `project ${p.id} sha256:${digestOf({
      record: 'project', id: served.id, title: served.title, summary: served.summary,
      lead: served.lead, opened_at: served.opened_at, prior_art: null,
      benevolence: { class: 'benevolent', statement: DECLARED.statement },
    })}`);
  });

  test('a task needs one too, and every read shows it, over MCP and HTTP', async () => {
    const none = await lead.call('uain_task_open', {
      project_id: p.id, title: 'No class', question: 'q', done_when: 'd', how_to_check: 'c',
    });
    assert.equal(none.ok, false);
    assert.equal(none.error, 'benevolence_required');
    const bad = await lead.call('uain_task_open', {
      project_id: p.id, title: 'Harm', question: 'q', done_when: 'd', how_to_check: 'c',
      benevolence: { class: 'Malevolent', statement: 'Damage the other party on purpose.' },
    });
    assert.equal(bad.error, 'malevolent_refused');
    const neutral = { class: 'neutral', statement: 'A registry count that neither harms nor directly helps anyone.' };
    const task = await openTask(lead, { benevolence: neutral });
    assert.deepEqual(task.benevolence, neutral);
    assert.deepEqual((await v1.call('uain_tasks', { task_id: task.id })).benevolence, neutral);
    const served = await (await t.http(`/api/tasks/${task.id}`)).json();
    assert.deepEqual(served.benevolence, neutral);
    const listed = await v1.call('uain_tasks', { project_id: p.id });
    assert.deepEqual(listed.tasks.find((x) => x.id === task.id).benevolence, neutral);
    const e = await committed(task.id);
    assert.match(e.summary, /, declared neutral: /);
    assert.equal(e.commits, `${task.id} sha256:${digestOf({
      record: 'task', id: served.id, project_id: served.project_id, title: served.title,
      question: served.question, done_when: served.done_when, how_to_check: served.how_to_check,
      created_by: served.created_by, created_at: served.created_at, prior_art: null,
      benevolence: neutral,
    })}`);
  });

  test('projects and tasks from before the rule read as unreviewed', async () => {
    const at = new Date().toISOString();
    await t.db.prepare(
      "INSERT INTO projects (id, title, summary, lead, state, stop_conditions, opened_at) VALUES ('legacy-benevolence', 'Legacy', 'Old.', ?, 'proposal', '[]', ?)",
    ).run(lead.id, at);
    await t.db.prepare(
      "INSERT INTO tasks (id, project_id, title, question, done_when, how_to_check, created_by, created_at) VALUES ('T-950', 'legacy-benevolence', 'Old task', 'q', 'd', 'c', ?, ?)",
    ).run(lead.id, at);
    assert.deepEqual((await (await t.http('/api/projects/legacy-benevolence')).json()).benevolence, { class: 'unreviewed' });
    assert.deepEqual((await (await t.http('/api/tasks/T-950')).json()).benevolence, { class: 'unreviewed' });
  });

  test('UAIN_REQUIRE_BENEVOLENCE=0 opens work without a class, and still refuses a bad one', async () => {
    // The rule is read when the server loads, so the relaxed mode runs in a
    // server of its own, as a local test network would.
    const helpers = new URL('./helpers.mjs', import.meta.url).href;
    const script = `
      const { boot } = await import(${JSON.stringify(helpers)});
      const t = await boot({ UAIN_REQUIRE_BENEVOLENCE: '0' });
      try {
        const lead = await t.member('Relaxed Labs', 'relaxed-lead');
        const p = (await lead.call('uain_propose', { title: 'Relaxed', summary: 's', stop_conditions: ['Stop.'] })).project;
        const open = (extra = {}) => lead.call('uain_task_open', {
          project_id: p.id, title: 'T' + Math.random(), question: 'q', done_when: 'd', how_to_check: 'c', ...extra,
        });
        const out = {
          project: p.benevolence,
          task: (await open()).task.benevolence,
          declared: (await open({ benevolence: ${JSON.stringify(DECLARED)} })).task.benevolence,
          malevolent: (await open({ benevolence: { class: 'malevolent', statement: 'Damage another party on purpose.' } })).error,
          thin: (await open({ benevolence: { class: 'neutral', statement: 'short' } })).error,
          described: (await (await t.connect()).call('uain_describe')).benevolence,
        };
        console.log('RESULT ' + JSON.stringify(out));
      } finally {
        await t.close();
      }
    `;
    // A file, not --eval: the writer thread takes the process's flags.
    const file = joinPath(mkdtempSync(joinPath(tmpdir(), 'uain-relaxed-')), 'relaxed.mjs');
    writeFileSync(file, script);
    const run = await new Promise((resolve) =>
      execFile(
        process.execPath,
        [file],
        { env: { ...process.env, UAIN_REQUIRE_BENEVOLENCE: '0' } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
      ));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const line = run.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    const out = JSON.parse(line.slice('RESULT '.length));
    assert.deepEqual(out.project, { class: 'unreviewed' });
    assert.deepEqual(out.task, { class: 'unreviewed' });
    assert.deepEqual(out.declared, DECLARED);
    assert.equal(out.malevolent, 'malevolent_refused');
    assert.equal(out.thin, 'benevolence_statement_length');
    assert.match(out.described, /Only benevolent and neutral work is permitted/);
  });
});

describe('flagging work as malevolent', () => {
  test('a flag needs a member of the project, a target, a reason and public evidence', async () => {
    const task = await openTask();
    const outsider = await t.member('Outsider Labs', 'benevolence-outsider');
    assert.equal((await flag(outsider, task.id)).error, 'not_a_member');
    assert.equal((await flag(c, 'T-999999')).error, 'flag_target_not_found');
    assert.equal((await flag(c, task.id, { reason: 'It is bad.' })).error, 'flag_reason_required');
    assert.equal((await flag(c, task.id, { evidence: 'A news story I read' })).error, 'flag_evidence_required');
    assert.equal((await flag(c, task.id, { evidence: 'http://example.org/harm' })).error, 'flag_evidence_required');
    assert.equal((await flag(c, task.id, { evidence: 'https://example.org/gone' })).error, 'source_not_found');
  });

  test('another member decides it; rejected, the work goes on, and both are on the ledger', async () => {
    const task = await openTask();
    const filed = await flag(c, task.id, { evidence: 'PMID 12345678' });
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.equal(filed.flag.state, 'open');
    assert.deepEqual(filed.flag.target, { kind: 'task', id: task.id });
    assert.equal(filed.task.status, 'open');
    assert.equal((await flag(c, task.id)).error, 'flag_already_open');
    const sibling = await t.instance(c.key, 'Flagger Labs', 'benevolence-flagger-sibling');
    await join([sibling], p.id);
    assert.equal((await flag(sibling, task.id)).error, 'flag_already_open', 'one open flag per member');

    // Filing, committed: its record is served and recomputes.
    const e = await committed(`benevolence flag ${filed.flag.id}`);
    assert.ok(e, 'the filing is committed');
    assert.equal(e.actor, c.id);
    assert.equal(e.peer, lead.id);
    const served = await (await t.http(`/api/benevolence/flags/${filed.flag.id}`)).json();
    assert.equal(e.commits, `benevolence flag ${filed.flag.id} sha256:${digestOf({
      record: 'benevolence_flag', flag: served.id, project_id: served.project_id, task_id: served.task_id,
      flagger: served.flagger, reason: served.reason, evidence: served.evidence, at: served.at,
    })}`);

    const rejected = await decide(judge, filed.flag.id, 'rejected', 'The task counts registry records; nothing in it causes harm.');
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.equal(rejected.flag.state, 'rejected');
    assert.equal(rejected.task.status, 'open');
    assert.deepEqual(rejected.task.benevolence, DECLARED);
    assert.equal((await decide(judge, filed.flag.id, 'upheld')).error, 'flag_not_open');
    assert.ok((await events()).some((x) => x.summary.startsWith(`Rejected benevolence flag ${filed.flag.id} on ${task.id}`)));
    const d = await committed(`benevolence flag ${filed.flag.id} decision`);
    const now = await (await t.http(`/api/benevolence/flags/${filed.flag.id}`)).json();
    assert.equal(d.commits, `benevolence flag ${filed.flag.id} decision sha256:${digestOf({
      record: 'benevolence_decision', flag: now.id, project_id: now.project_id, task_id: now.task_id,
      decided_by: now.decided_by, decision: now.state, note: now.decision_note, at: now.decided_at,
    })}`);
    const listed = await (await t.http(`/api/benevolence/flags?task=${task.id}`)).json();
    assert.deepEqual(listed.flags.map((f) => f.state), ['rejected']);
  });

  test('only a default verifier or trusted arbiter of neither the flagger\'s nor the creator\'s member decides', async () => {
    const task = await openTask();
    const filed = await flag(c, task.id);
    const flagSibling = await t.instance(c.key, 'Flagger Labs', 'benevolence-flagger-judge');
    const leadSibling = await t.instance(lead.key, 'Lead Labs', 'benevolence-lead-judge');
    const stranger = await t.member('Stranger Labs', 'benevolence-stranger');
    await join([flagSibling, leadSibling], p.id);
    assert.equal((await decide(plain, filed.flag.id, 'upheld')).error, 'not_a_benevolence_judge');
    const own = await decide(flagSibling, filed.flag.id, 'upheld');
    assert.equal(own.error, 'flag_judge_not_independent');
    assert.equal(own.of, 'flagger');
    assert.equal((await decide(c, filed.flag.id, 'upheld')).of, 'flagger');
    const creator = await decide(leadSibling, filed.flag.id, 'upheld');
    assert.equal(creator.error, 'flag_judge_not_independent');
    assert.equal(creator.of, 'creator');
    assert.equal((await decide(lead, filed.flag.id, 'upheld')).of, 'creator');
    assert.equal((await decide(stranger, filed.flag.id, 'upheld')).error, 'not_a_member');
    assert.equal((await decide(judge, 999999, 'upheld')).error, 'flag_not_found');
    assert.equal((await decide(judge, filed.flag.id, 'upheld', '   ')).error, 'flag_note_required');
    const odd = await t.db.decideBenevolence({ participant: judge.id, flagId: filed.flag.id, decision: 'maybe', note: 'n' });
    assert.equal(odd.error, 'bad_flag_decision');
    // Nothing changed.
    assert.equal((await (await t.http(`/api/benevolence/flags/${filed.flag.id}`)).json()).state, 'open');
    assert.equal((await t.db.getTask(task.id)).status, 'open');
  });

  test('uain_next offers open flags to those who may decide them, and to nobody else', async () => {
    const task = await openTask();
    const filed = await flag(c, task.id);
    const offered = (await flagItems(judge)).find((i) => i.flag_id === filed.flag.id);
    assert.ok(offered, 'offered to a judge of another member');
    assert.equal(offered.task_id, task.id);
    assert.deepEqual(offered.target, { kind: 'task', id: task.id });
    assert.deepEqual(offered.declared, DECLARED);
    assert.equal(offered.reason, HARM);
    assert.equal(offered.evidence, 'https://example.org/harm-report');
    assert.match(offered.next_step, new RegExp(`uain_benevolence_decide with flag_id ${filed.flag.id}`));
    assert.equal(offered.evidence_check.status, 'found');
    // First, before other work.
    assert.equal((await menu(judge))[0].kind, 'benevolence_flag');
    // A client that says it is on every item it takes is told none is needed.
    const started = await judge.call('uain_start', { kind: 'benevolence_flag', id: task.id });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.match(started.message, /needs no uain_start/);
    assert.ok(!(await flagItems(c)).some((i) => i.flag_id === filed.flag.id), 'not to the flagger');
    assert.ok(!(await flagItems(lead)).some((i) => i.flag_id === filed.flag.id), 'not to the creator');
    assert.ok(!(await flagItems(plain)).some((i) => i.flag_id === filed.flag.id), 'not to a member who may not decide');
    // The work is still offered meanwhile.
    assert.ok((await menu(a)).some((i) => i.kind === 'task' && i.task_id === task.id));

    // Declined as the client declines items, by its target, it is not offered again for a while.
    const declined = await t.http('/api/working/decline', {
      method: 'POST',
      headers: { authorization: `Bearer ${v2.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Not mine to judge.', items: [{ kind: 'benevolence_flag', task_id: task.id, project: { id: p.id } }] }),
    });
    assert.equal(declined.status, 200);
    assert.ok(!(await flagItems(v2)).some((i) => i.flag_id === filed.flag.id));
    assert.ok((await flagItems(v1)).some((i) => i.flag_id === filed.flag.id));
    await decide(judge, filed.flag.id, 'rejected', 'The task counts registry records; nothing in it causes harm.');
    assert.ok(!(await flagItems(judge)).some((i) => i.flag_id === filed.flag.id), 'decided, it is gone');
  });
});

describe('upheld', () => {
  test('a task closes as malevolent, pays nothing, answers being checked included, and its creator loses karma', async () => {
    const task = await openTask(lead, { karma_offered: 30 });
    const held = (await a.call('uain_contribute', {
      project_id: p.id,
      task_id: task.id,
      title: `Answer to ${task.id}`,
      detail: 'Counted the registry records.',
      claim: `The count for ${task.id} is 42.`,
      karma_claimed: 20,
    })).contribution;
    await v1.call('uain_verify', { contribution_id: held.id, verdict: 'confirmed', note: 'Counted again: 42.' });
    const first = await flag(c, task.id);
    const second = await flag(a, task.id, { reason: `${HARM} It also names people.` });
    const answerer = await karmaOf(a.id);
    const creator = await karmaOf(lead.id);

    const upheld = await decide(judge, first.flag.id, 'upheld');
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    assert.equal(upheld.flag.state, 'upheld');
    assert.equal(upheld.task.status, 'closed');
    assert.equal(upheld.task.closed.as, 'malevolent');
    assert.equal(upheld.task.closed.flag, first.flag.id);
    assert.match(upheld.task.closed.reason, /^malevolent: classified by benevolence flag/);
    assert.equal(upheld.task.benevolence.class, 'malevolent');
    assert.equal(upheld.task.benevolence.declared, 'benevolent');
    assert.equal(upheld.task.benevolence.statement, DECLARED.statement);
    assert.equal(upheld.task.price.won_by, null);
    // The other open flag on it has nothing left to decide.
    assert.equal((await (await t.http(`/api/benevolence/flags/${second.flag.id}`)).json()).state, 'moot');
    assert.equal((await decide(judge, second.flag.id, 'upheld')).error, 'flag_not_open');
    assert.equal((await flag(v2, task.id)).error, 'already_malevolent');

    // The answer being checked closed with it, and nothing was paid.
    const answer = await (await t.http(`/api/contributions/${held.id}`)).json();
    assert.equal(answer.state, 'rejected');
    assert.equal(answer.award_withheld, 'malevolent');
    assert.equal(answer.karma_awarded, 0);
    assert.equal((await v2.call('uain_verify', { contribution_id: held.id, verdict: 'confirmed', note: 'Counted.' })).error, 'already_settled');
    assert.equal(await karmaOf(a.id), answerer);
    assert.ok((await events()).some((x) => x.summary === `${held.id} closes with ${task.id}, classified malevolent; nothing is paid`));

    // Offered to nobody, and it takes no answers.
    assert.ok(!(await menu(v2)).some((i) => i.task_id === task.id));
    const late = await v2.call('uain_contribute', {
      project_id: p.id, task_id: task.id, title: 'Late', detail: 'Late.', claim: 'Late.', karma_claimed: 5,
    });
    assert.equal(late.error, 'task_closed');

    // The creator loses the penalty, on the record.
    assert.equal(await karmaOf(lead.id), creator - 2);
    const lost = (await events()).find((x) => x.kind === 'karma' && x.actor === lead.id && x.summary.includes(`benevolence flag ${first.flag.id}`));
    assert.match(lost.summary, /^Lost 2κ: /);
    assert.equal(lost.peer, judge.id);
    // On the karma ledger too, pointing at that entry.
    const row = await t.db.prepare(
      "SELECT * FROM karma_events WHERE participant_id = ? AND kind = 'malevolent' ORDER BY id DESC LIMIT 1",
    ).get(lead.id);
    assert.equal(row.delta, -2);
    assert.equal(row.ref, `benevolence flag ${first.flag.id}`);
    assert.equal(row.event_id, lost.id);
    const karmaLedger = await import('../dist/src/application/karma-ledger.js');
    assert.equal((await karmaLedger.karmaConsistency([lead.id])).ok, true);
    assert.ok((await events()).some((x) => x.summary.startsWith(`Upheld benevolence flag ${first.flag.id} on ${task.id}`)));
  });

  test('a future task\'s awards held for its KPI are withheld too', async () => {
    const resolvesBy = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const opened = await lead.call('uain_task_open', {
      project_id: p.id,
      title: 'Future outcome',
      question: 'Will the registry trial report its primary endpoint?',
      done_when: 'A forecast with its reasoning.',
      how_to_check: 'Re-derive it from the cited data.',
      benevolence: DECLARED,
      kind: 'future',
      kpi: {
        statement: 'The trial reports a response rate of at least 40 percent.',
        metric: 'response rate',
        comparator: '>=',
        threshold: 40,
        unit: '%',
        source: 'NCT01234567',
        resolves_by: resolvesBy,
      },
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const task = opened.task;
    const sub = (await a.call('uain_contribute', {
      project_id: p.id,
      task_id: task.id,
      title: `Answer to ${task.id}`,
      detail: 'Derived from the phase 2 data.',
      claim: 'The response rate will be about 45 percent.',
      karma_claimed: 20,
    })).contribution;
    const before = await karmaOf(a.id);
    await v1.call('uain_verify', { contribution_id: sub.id, verdict: 'confirmed', note: 'Derived it again.' });
    await v2.call('uain_verify', { contribution_id: sub.id, verdict: 'confirmed', note: 'Derived it again.' });
    const held = await (await t.http(`/api/contributions/${sub.id}`)).json();
    assert.equal(held.state, 'settled');
    assert.equal(held.award_pending, 'kpi', 'its award waits for the KPI');

    const filed = await flag(c, task.id);
    const upheld = await decide(judge, filed.flag.id, 'upheld');
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    const after_ = await (await t.http(`/api/contributions/${sub.id}`)).json();
    assert.equal(after_.award_pending ?? null, null, 'no longer waiting for the KPI');
    assert.equal(after_.award_withheld, 'malevolent');
    assert.equal(await karmaOf(a.id), before);
    assert.ok((await events()).some((x) => x.summary.startsWith(`The award of ${sub.id}, held for the KPI of ${task.id}, is withheld`)));
  });

  test('a project halts, its lead may not resume it, and it takes no new work', async () => {
    const other = await t.member('Other Lead Labs', 'benevolence-other-lead');
    const q = (await other.call('uain_propose', {
      title: 'To halt',
      summary: 'A project that will be flagged.',
      stop_conditions: STOP,
      benevolence: { class: 'neutral', statement: 'A neutral piece of work that neither harms nor helps anyone.' },
    })).project;
    await join([c, judge, a], q.id);
    const filed = await flag(c, q.id);
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.deepEqual(filed.flag.target, { kind: 'project', id: q.id });
    assert.equal(filed.project.id, q.id);
    const offered = (await flagItems(judge)).find((i) => i.flag_id === filed.flag.id);
    assert.deepEqual(offered.target, { kind: 'project', id: q.id });
    assert.equal(offered.task_id, undefined);

    const before = await karmaOf(other.id);
    const upheld = await decide(judge, filed.flag.id, 'upheld');
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    assert.equal(upheld.project.state, 'halted');
    assert.equal(upheld.project.benevolence.class, 'malevolent');
    assert.equal(upheld.project.benevolence.declared, 'neutral');
    assert.ok((await events()).some((x) => x.kind === 'halt' && x.summary.startsWith(`Halted "To halt": classified malevolent by benevolence flag ${filed.flag.id}`)));
    assert.equal(await karmaOf(other.id), before - 2);

    const resumed = await other.call('uain_project_resume', { project_id: q.id, reason: 'I disagree.' });
    assert.equal(resumed.error, 'project_malevolent');
    assert.match(resumed.message, /may not resume/);
    const task = await other.call('uain_task_open', {
      project_id: q.id, title: 'More', question: 'q', done_when: 'd', how_to_check: 'c', benevolence: DECLARED,
    });
    assert.equal(task.error, 'project_closed');
    assert.equal((await flag(a, q.id)).error, 'already_malevolent');
  });

  test('the penalty can end in revocation, as every other penalty can', async () => {
    const r = await t.member('Risky Labs', 'benevolence-risky', { uain: false });
    await join([r], p.id);
    const task = await openTask(r);
    assert.ok(task, 'any member may open a task');
    // Brought near the threshold through the karma ledger, as karma always moves.
    const karmaLedger = await import('../dist/src/application/karma-ledger.js');
    const store = await import('../dist/src/storage/store.js');
    await store.atomically(() => karmaLedger.changeKarma(r.id, -8, 'operator_restatement', 'Test fixture', null));
    const filed = await flag(c, task.id);
    const upheld = await decide(judge, filed.flag.id, 'upheld');
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    assert.equal(await karmaOf(r.id), -10);
    assert.equal((await karmaLedger.karmaConsistency([r.id])).ok, true);
    assert.ok((await events()).some((x) => x.kind === 'licence' && x.summary.includes('licence was revoked')));
    assert.equal((await r.call('uain_whoami')).authenticated, false);
  });

  test('work from before the rule can be flagged too; it commits no declaration', async () => {
    await join([c, judge], 'legacy-benevolence');
    const filed = await flag(c, 'T-950');
    const upheld = await decide(judge, filed.flag.id, 'upheld');
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    assert.deepEqual(
      { class: upheld.task.benevolence.class, declared: upheld.task.benevolence.declared },
      { class: 'malevolent', declared: null },
    );
  });

  test('every record the rule adds verifies from outside, with the independent verifier', async () => {
    const script = fileURLToPath(new URL('../scripts/verify-ledger.mjs', import.meta.url));
    const clean = { ...process.env };
    delete clean.LEDGER_PUBLIC_KEY_FILE;
    delete clean.LEDGER_PUBLIC_KEY_PEM;
    const run = await new Promise((resolve) =>
      execFile(process.execPath, [script], { env: { ...clean, UAIN_API: t.base } }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr })));
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const kinds = new Set((await events()).filter((e) => e.commits).map((e) => e.commits.split(' sha256:')[0]
      .replace(/^T-\d+/, 'T').replace(/flag \d+/, 'flag').replace(/^project .*/, 'project')));
    for (const kind of ['project', 'T', 'benevolence flag', 'benevolence flag decision'])
      assert.ok(kinds.has(kind), `${kind} is committed`);
  });
});
