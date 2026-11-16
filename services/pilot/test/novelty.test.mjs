/**
 * The novelty rule (decided 29 September 2026): UAIN only creates and
 * rewards problems that have no open-source or discoverable solution yet.
 * Projects and tasks open on a prior-art basis, a member can show a task is
 * already solved in the open, and work is paid only once a check attests it
 * is new. Booted with the rule required, as production runs; the rest of the
 * suite runs without it, as a local test network may.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { boot } from './helpers.mjs';

let t;
let sources;
let lead, a, b, v1, v2, c, judge, p;
before(async () => {
  t = await boot({ UAIN_REQUIRE_PRIOR_ART: '1' });
  sources = await import('../dist/src/integrations/sources.js');
  sources.setSourceResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
  sources.setSourceFetcher(async (url) => ({
    ok: !url.includes('gone'),
    status: url.includes('gone') ? 404 : 200,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => '',
  }));
  [lead, a, b, v1, v2, c, judge] = await Promise.all(
    ['Lead', 'Answer', 'Rival', 'Check One', 'Check Two', 'Challenger', 'Judge'].map((n) =>
      t.member(`${n} Labs`, `novelty-${n.toLowerCase().replace(' ', '-')}`)),
  );
  p = (await lead.call('uain_propose', {
    title: 'Novelty',
    summary: 'Measure what nobody has measured.',
    stop_conditions: STOP,
    prior_art: BASIS,
  })).project;
  await join([a, b, v1, v2, c, judge], p.id);
});
after(async () => {
  sources.setSourceFetcher(null);
  sources.setSourceResolver(null);
  await t.close();
});

const STOP = ['Halt if the work would need restricted data.'];
const BASIS = {
  statement:
    'No open dataset, paper or repository reports this value; the closest work estimates it only indirectly.',
  searched: [
    'Google Scholar: "sample digest value" 2015-2026',
    'GitHub code search: sample digest value',
    'https://pubmed.ncbi.nlm.nih.gov/?term=sample+digest',
  ],
};
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
const answer = (who, pid, task, extra = {}) =>
  who.call('uain_contribute', {
    project_id: pid,
    task_id: task.id,
    title: `Answer to ${task.id}`,
    detail: 'Recomputed the digest from the pinned inputs.',
    claim: `The digest for ${task.id} is 42.`,
    karma_claimed: 20,
    ...extra,
  });
const confirm = (who, id, extra = {}) =>
  who.call('uain_verify', {
    contribution_id: id,
    verdict: 'confirmed',
    note: 'Re-ran it on the pinned inputs and got the same digest.',
    ...extra,
  });
const NEW = {
  novelty: 'new',
  novelty_checked: ['Google Scholar: "digest 42" sample', 'GitHub code search: digest 42 sample'],
};

const openTask = async (extra = {}) =>
  (await lead.call('uain_task_open', {
    project_id: p.id,
    title: `Task ${Math.random().toString(36).slice(2, 8)}`,
    question: 'What is the digest of the sample?',
    done_when: 'A digest with the code that computed it.',
    how_to_check: 'Recompute it from the pinned inputs.',
    prior_art: BASIS,
    ...extra,
  })).task;

describe('opening on a prior-art basis', () => {
  test('a project needs a basis, shows it, and commits it on the ledger', async () => {
    const none = await lead.call('uain_propose', { title: 'No basis', summary: 's', stop_conditions: STOP });
    assert.equal(none.opened, false);
    assert.equal(none.error, 'prior_art_required');
    assert.match(none.message, /no open-source or discoverable solution/);
    const thin = await lead.call('uain_propose', {
      title: 'Thin basis', summary: 's', stop_conditions: STOP,
      prior_art: { statement: 'Nothing found.', searched: ['Google'] },
    });
    assert.equal(thin.error, 'prior_art_too_thin');
    assert.deepEqual(thin.needed, { statement_chars: 40, searched: 2 });

    assert.deepEqual(p.prior_art, BASIS);
    assert.equal(p.novelty, 'stated');
    const served = await (await t.http(`/api/projects/${p.id}`)).json();
    assert.deepEqual(served.prior_art, BASIS);
    assert.equal(served.novelty, 'stated');
    const e = await committed(`project ${p.id}`);
    assert.ok(e, 'the proposal commits the project and its basis');
    assert.equal(e.commits, `project ${p.id} sha256:${digestOf({
      record: 'project', id: served.id, title: served.title, summary: served.summary,
      lead: served.lead, opened_at: served.opened_at, prior_art: served.prior_art,
    })}`);
  });

  test('a task needs one too, and every read shows it, over MCP and HTTP', async () => {
    const none = await lead.call('uain_task_open', {
      project_id: p.id, title: 'No basis', question: 'q', done_when: 'd', how_to_check: 'c',
    });
    assert.equal(none.ok, false);
    assert.equal(none.error, 'prior_art_required');
    const task = await openTask();
    assert.deepEqual(task.prior_art, BASIS);
    assert.equal(task.novelty, 'stated');
    assert.deepEqual(task.prior_art_challenges, []);
    const read = await v1.call('uain_tasks', { task_id: task.id });
    assert.deepEqual(read.prior_art, BASIS);
    const served = await (await t.http(`/api/tasks/${task.id}`)).json();
    assert.deepEqual(served.prior_art, BASIS);
    assert.equal(served.novelty, 'stated');
    const e = await committed(task.id);
    assert.equal(e.commits, `${task.id} sha256:${digestOf({
      record: 'task', id: served.id, project_id: served.project_id, title: served.title,
      question: served.question, done_when: served.done_when, how_to_check: served.how_to_check,
      created_by: served.created_by, created_at: served.created_at, prior_art: served.prior_art,
    })}`);
    const menu = await a.call('uain_next', { limit: 50 });
    const offer = menu.items.find((i) => i.task_id === task.id && i.kind === 'task');
    assert.equal(offer.novelty, 'stated');
    assert.deepEqual(offer.prior_art, BASIS);
  });

  test('projects and tasks from before the rule read as unreviewed, not as errors', async () => {
    const at = new Date().toISOString();
    await t.db.prepare(
      "INSERT INTO projects (id, title, summary, lead, state, stop_conditions, opened_at) VALUES ('legacy-novelty', 'Legacy', 'Old.', ?, 'proposal', '[]', ?)",
    ).run(lead.id, at);
    await t.db.prepare(
      "INSERT INTO tasks (id, project_id, title, question, done_when, how_to_check, created_by, created_at) VALUES ('T-900', 'legacy-novelty', 'Old task', 'q', 'd', 'c', ?, ?)",
    ).run(lead.id, at);
    const project = await (await t.http('/api/projects/legacy-novelty')).json();
    assert.equal(project.prior_art, null);
    assert.equal(project.novelty, 'unreviewed');
    const task = await (await t.http('/api/tasks/T-900')).json();
    assert.equal(task.prior_art, null);
    assert.equal(task.novelty, 'unreviewed');
    const listed = await lead.call('uain_projects', { project_id: 'legacy-novelty' });
    assert.equal(listed.project.novelty, 'unreviewed');
  });
});

describe('paying only for new work', () => {
  test('confirmations without a novelty attestation settle nothing: the reward waits', async () => {
    const task = await openTask();
    const sub = (await answer(a, p.id, task)).contribution;
    const before = await karmaOf(a.id);
    const one = await confirm(v1, sub.id);
    assert.equal(one.settled, false);
    const two = await confirm(v2, sub.id);
    assert.equal(two.verified, true);
    assert.equal(two.settled, false);
    assert.equal(two.awaiting_novelty, true);
    assert.match(two.what_happens_next, /none attests that it is new/);
    const held = await (await t.http(`/api/contributions/${sub.id}`)).json();
    assert.equal(held.state, 'held');
    assert.equal(held.novelty, 'unattested');
    assert.equal(await karmaOf(a.id), before);

    // A default verifier that confirmed without saying is asked to attest.
    const menu = await v1.call('uain_next', { limit: 50 });
    const item = menu.items.find((i) => i.contribution_id === sub.id);
    assert.equal(item.kind, 'verify');
    assert.equal(item.attest_novelty, true);
    assert.match(item.next_step, /novelty/);

    // It adds the attestation to its check, which changes nothing else.
    const note = held.verifications.find((v) => v.verifier === v1.id).note;
    const attested = await confirm(v1, sub.id, { ...NEW, note: 'Searched Scholar and GitHub; nothing open gives it.' });
    assert.equal(attested.settled, true, JSON.stringify(attested));
    assert.equal(attested.novelty, 'new');
    assert.equal(attested.contribution.karma_awarded, 20);
    assert.equal(await karmaOf(a.id), before + 20);
    const check = attested.contribution.verifications.find((v) => v.verifier === v1.id);
    assert.equal(check.note, note);
    assert.equal(check.novelty, 'new');
    assert.deepEqual(check.novelty_checked, NEW.novelty_checked);
    assert.match(check.novelty_note, /nothing open gives it/);
    assert.ok(check.novelty_event_id);
    assert.equal(attested.contribution.novelty, 'new');
  });

  test('the contributor and its own member never attest, and an attestation is checked', async () => {
    const task = await openTask();
    const sub = (await answer(a, p.id, task)).contribution;
    const sibling = await t.instance(a.key, 'Answer Labs', 'novelty-answer-sibling');
    await join([sibling], p.id);
    const own = await confirm(sibling, sub.id, NEW);
    assert.equal(own.verified, false);
    // Since 30 September 2026 no agent of the contributor's member checks its
    // work at all, so the attestation is refused with the check (same_member,
    // test/sibling-checks.test.mjs), in place of novelty_not_independent.
    assert.equal(own.error, 'same_member');
    assert.equal((await confirm(a, sub.id, NEW)).error, 'self_verification_refused');

    const one = await confirm(v1, sub.id, { novelty: 'new', novelty_checked: ['Google: digest'] });
    assert.equal(one.error, 'novelty_checked_required');
    assert.equal((await confirm(v1, sub.id, { novelty: 'known' })).error, 'known_source_required');
    assert.equal(
      (await confirm(v1, sub.id, { novelty: 'known', known_source: 'A textbook, 2019' })).error,
      'known_source_required',
    );
    const disputed = await v1.call('uain_verify', {
      contribution_id: sub.id, verdict: 'disputed', note: 'Wrong.', ...NEW,
    });
    assert.equal(disputed.error, 'novelty_needs_confirmed');
    assert.equal((await confirm(v1, sub.id, { novelty_checked: NEW.novelty_checked })).error, 'novelty_required');
  });

  test('work a check shows is already public settles verified, with no award, as a restatement', async () => {
    const task = await openTask();
    const sub = (await answer(a, p.id, task)).contribution;
    const before = await karmaOf(a.id);
    assert.equal((await confirm(v1, sub.id, NEW)).settled, false);
    const known = await confirm(v2, sub.id, {
      novelty: 'known',
      known_source: 'https://example.org/already-published',
    });
    assert.equal(known.settled, true, JSON.stringify(known));
    assert.equal(known.award_withheld, 'known');
    assert.equal(known.novelty, 'known');
    assert.match(known.what_happens_next, /no award/);
    assert.equal(known.contribution.karma_awarded, 0);
    assert.equal(known.contribution.credits_awarded, 0);
    assert.equal(known.contribution.award_withheld, 'known');
    assert.equal(known.contribution.novelty, 'known');
    assert.equal(await karmaOf(a.id), before);
    const claim = await lead.call('uain_claims', { claim_id: known.claim.id });
    assert.equal(claim.restates_public_knowledge, true);
    assert.match(claim.history[0].reason, /restatement of public knowledge/);
    assert.ok((await events()).some((e) => e.summary.includes(`${sub.id} is verified but restates public knowledge`)));
  });

  test('a known result earns no price, and the next new one does', async () => {
    const task = await openTask({ karma_offered: 30 });
    const first = (await answer(a, p.id, task)).contribution;
    const second = (await answer(b, p.id, task)).contribution;
    await confirm(v1, first.id, NEW);
    const known = await confirm(v2, first.id, { novelty: 'known', known_source: 'doi:10.1000/182' });
    assert.equal(known.award_withheld, 'known');
    // Its claim is the task's belief, so the next answer is judged against it.
    const revision = (await lead.call('uain_claims', { claim_id: known.claim.id })).believed_revision;
    const against = { against_claim: 'supports', against_claim_revision: revision };
    await confirm(v1, second.id, { ...NEW, ...against });
    const paid = await confirm(v2, second.id, { ...NEW, ...against });
    assert.equal(paid.settled, true, JSON.stringify(paid));
    assert.equal(paid.prize.winner, second.id);
    assert.equal(paid.contribution.karma_awarded, 30);
    assert.equal((await t.db.getTask(task.id)).price.won_by, second.id);
    // The belief now rests on new work too, so it is no longer only a restatement.
    const claim = await lead.call('uain_claims', { claim_id: known.claim.id });
    assert.equal(claim.restates_public_knowledge, undefined);
  });
});

describe('showing a task is already solved', () => {
  let task;
  let held;
  test('a challenge needs a public source and a note', async () => {
    task = await openTask();
    const bare = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'A textbook', note: 'It is in chapter four, table two, exactly.',
    });
    assert.equal(bare.error, 'prior_art_source_required');
    const terse = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'https://example.org/solved', note: 'Solved.',
    });
    assert.equal(terse.error, 'challenge_note_required');
    const gone = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'https://example.org/gone', note: 'It is in chapter four, table two, exactly.',
    });
    assert.equal(gone.error, 'source_not_found');
  });

  test('another member decides it; rejected, the task goes on', async () => {
    const filed = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'https://example.org/solved', note: 'Table 2 gives the digest for this very sample.',
    });
    assert.equal(filed.ok, true, JSON.stringify(filed));
    assert.equal(filed.task.novelty, 'challenged');
    assert.equal(filed.challenge.state, 'open');
    assert.equal(filed.challenge.source_check.status, 'found');
    const again = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'https://example.org/solved', note: 'Table 2 gives the digest for this very sample.',
    });
    assert.equal(again.error, 'challenge_already_open');
    assert.ok(await committed(`${task.id} challenge ${filed.challenge.id}`));

    // Offered to those who may decide it, and not to the challenger's member.
    const offered = (await judge.call('uain_next', { limit: 50 })).items.find((i) => i.kind === 'prior_art_challenge');
    assert.equal(offered.challenge_id, filed.challenge.id);
    assert.ok(!(await c.call('uain_next', { limit: 50 })).items.some((i) => i.kind === 'prior_art_challenge'));
    // Still offered as work meanwhile.
    assert.ok((await a.call('uain_next', { limit: 50 })).items.some((i) => i.kind === 'task' && i.task_id === task.id));

    const plain = await t.member('Plain Labs', 'novelty-plain', { uain: false });
    const sibling = await t.instance(c.key, 'Challenger Labs', 'novelty-challenger-sibling');
    await join([plain, sibling], p.id);
    const decide = (who, decision) => who.call('uain_task_prior_art_decide', {
      challenge_id: filed.challenge.id, decision, note: 'Table 2 is a different sample: its digest is not this one.',
    });
    assert.equal((await decide(plain, 'upheld')).error, 'not_a_prior_art_judge');
    assert.equal((await decide(sibling, 'upheld')).error, 'judge_not_independent');
    const rejected = await decide(judge, 'rejected');
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.equal(rejected.challenge.state, 'rejected');
    assert.equal(rejected.task.status, 'open');
    assert.equal(rejected.task.novelty, 'stated');
    assert.equal((await decide(judge, 'upheld')).error, 'challenge_not_open');
    assert.ok((await events()).some((e) => e.summary.startsWith(`Rejected challenge ${filed.challenge.id} on ${task.id}`)));
    assert.ok(await committed(`${task.id} challenge ${filed.challenge.id} decision`));
  });

  test('upheld, the task closes as known, offers no work and pays nothing', async () => {
    held = (await answer(a, p.id, task)).contribution;
    const filed = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'PMID 12345678', note: 'The abstract reports the digest of this exact sample.',
    });
    const upheld = await judge.call('uain_task_prior_art_decide', {
      challenge_id: filed.challenge.id, decision: 'upheld', note: 'The abstract gives exactly this digest for this sample.',
    });
    assert.equal(upheld.ok, true, JSON.stringify(upheld));
    assert.equal(upheld.task.status, 'closed');
    assert.equal(upheld.task.novelty, 'known');
    assert.equal(upheld.task.closed.as, 'known');
    assert.equal(upheld.task.closed.source, 'PMID 12345678');
    assert.match(upheld.task.closed.reason, /^known:/);
    const served = await (await t.http(`/api/tasks/${task.id}`)).json();
    assert.deepEqual(served.prior_art_challenges.map((x) => x.state), ['rejected', 'upheld']);
    assert.ok((await events()).some((e) => e.summary.includes(`${task.id} is closed as known`)));

    assert.ok(!(await b.call('uain_next', { limit: 50 })).items.some((i) => i.task_id === task.id && i.kind === 'task'));
    const late = await answer(b, p.id, task);
    assert.equal(late.error, 'task_closed');

    // An answer still being checked settles with no award.
    const before = await karmaOf(a.id);
    await confirm(v1, held.id, NEW);
    const settled = await confirm(v2, held.id, NEW);
    assert.equal(settled.settled, true);
    assert.equal(settled.award_withheld, 'known');
    assert.equal(settled.contribution.karma_awarded, 0);
    assert.equal(await karmaOf(a.id), before);
    const closed = await c.call('uain_task_prior_art', {
      task_id: task.id, source: 'https://example.org/solved', note: 'Table 2 gives the digest for this very sample.',
    });
    assert.equal(closed.error, 'task_closed');
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
      .replace(/^RC-\d+/, 'RC').replace(/^CL-\d+ revision \d+/, 'CL revision')
      .replace(/^T-\d+/, 'T').replace(/challenge \d+/, 'challenge').replace(/^project .*/, 'project')));
    for (const kind of ['project', 'T', 'T challenge', 'T challenge decision', 'RC check'])
      assert.ok(kinds.has(kind), `${kind} is committed`);
  });
});
