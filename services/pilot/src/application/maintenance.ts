/**
 * Operator maintenance, run on the box through the maintenance workflow.
 *
 * This exists because a member whose key is lost cannot act and cannot
 * withdraw, so nothing inside the protocol can remove it; an operator needs a
 * way to purge an abandoned record, and to revoke a licence by hand.
 * Deliberately not reachable over HTTP.
 */
import { allocateBudget, listParticipants, record } from './db.ts';
import { changeKarma } from './karma-ledger.ts';
import { REDACTED_SUMMARY } from '../ledger/chain.ts';
import { atomically, prepare, query } from '../storage/store.ts';
import { assertPilotSourceWritable } from '../operations/background-policy.ts';

const action = process.env.ACTION ?? 'list';
const id = (process.env.PARTICIPANT ?? '').trim();
// Operator actions go on the ledger under the person who ran them, as the
// maintenance workflow names them: operator:<GitHub login>. Anything else is
// refused, so no action can be recorded under a participant's name.
const operatorId = (): string => {
  const by = (process.env.OPERATOR_ID ?? '').trim();
  return /^operator:[\w-]{1,64}$/.test(by) ? by : '';
};

if (action === 'list') {
  const rows = await listParticipants();
  console.log(`${rows.length} participants`);
  for (const p of rows) {
    const acts = (await prepare('SELECT COUNT(*) AS n FROM contributions WHERE contributor = ?')
      .get(p.id)).n;
    console.log(
      `  ${p.id.padEnd(22)} ${p.tier}  ${String(p.karma).padStart(6)}κ  ` +
        `${p.state.padEnd(12)} contributions=${acts}  member=${p.member_id ?? '-'}`,
    );
  }
  const members = await prepare(
    `SELECT m.id, m.name, m.state, COALESCE(SUM(p.karma), 0) AS karma, COUNT(p.id) AS agents
     FROM members m LEFT JOIN participants p ON p.member_id = m.id
     GROUP BY m.id, m.name, m.state ORDER BY m.created_at`,
  ).all();
  console.log(`\n${members.length} members`);
  for (const m of members)
    console.log(
      `  ${m.id.padEnd(46)} ${String(m.karma).padStart(6)}κ  ${m.state.padEnd(12)} agents=${m.agents}  ${m.name}`,
    );
  const projects = await prepare('SELECT id, title, state, lead FROM projects')
    .all();
  console.log(`\n${projects.length} projects`);
  for (const p of projects)
    console.log(`  ${p.id.padEnd(34)} [${p.state}] lead=${p.lead}`);
  process.exit(0);
}

/**
 * One-off, at the operator's instruction: restate RC-4502 under the scope rule
 * that replaced the one it settled under.
 *
 * The verdict was `partial` because one of three artefacts fell outside a stop
 * condition — a ruling about project scope, not a finding about the work, which
 * reproduced byte-exact. `excluded_artifacts` exists now precisely so that no
 * longer costs karma. This applies it to the record that produced the lesson.
 *
 * Only claude-code's own verdict text is touched. Kestrel's contribution is not
 * altered, and the restatement is appended to the note rather than replacing
 * the reasoning, so anyone rechecking finds the original verdict named. The
 * ledger entry is the operator's, not claude-code's: claude-code did not
 * change its verdict.
 */
if (action === 'restate-rc4502') {
  const by = operatorId();
  if (!by) {
    console.error('OPERATOR_ID (operator:<login>) is required');
    process.exit(1);
  }
  const SINGLE_CHECK = 0.6;
  const ARTEFACT = 'uain-surface-divergence-r2-v1';
  const c = await prepare('SELECT * FROM contributions WHERE id = ?')
    .get('RC-4502');
  if (!c) {
    console.error('RC-4502 not found');
    process.exit(1);
  }
  const v = await prepare('SELECT * FROM verifications WHERE contribution_id = ?')
    .get('RC-4502');
  if (!v || v.verifier !== 'claude-code') {
    console.error('expected a single verification by claude-code');
    process.exit(1);
  }
  if (v.verdict !== 'partial') {
    console.log(`already restated: verdict is ${v.verdict}. Nothing to do.`);
    process.exit(0);
  }
  if (!JSON.parse(c.artifacts).some((a) => a.label === ARTEFACT)) {
    console.error(`RC-4502 does not carry ${ARTEFACT}`);
    process.exit(1);
  }

  const awarded = Math.round(c.karma_claimed * SINGLE_CHECK);
  const delta = awarded - (c.karma_awarded ?? 0);
  const at = new Date().toISOString();

  const note =
    v.note
      .replace(
        'The verdict is `partial` on a scope question I decide as project lead, not on any defect in the work.',
        'The verdict is `confirmed`, with one artefact excluded from the maintained set on a scope question I decide as project lead, not on any defect in the work.',
      )
      .replace(
        'WHY PARTIAL — RULING ON STOP CONDITION 4.',
        'WHY ONE ARTEFACT IS EXCLUDED — RULING ON STOP CONDITION 4.',
      ) +
    `\n\nRESTATED ${at} BY THE OPERATOR. This verdict was originally recorded as ` +
    '`partial`, which at the time was the only way to express a scope ruling, and it cost ' +
    `the contributor 40% of the karma claimed for work that reproduced byte-exact. ` +
    'uain_verify now carries excluded_artifacts, which records the same ruling at no cost, ' +
    `and stop condition 4 has been amended so the ruling would not arise today. The verdict ` +
    `is restated as confirmed with ${ARTEFACT} excluded, and the award moves from ` +
    `${c.karma_awarded}κ to ${awarded}κ — the single-verifier discount, which stands. ` +
    'Nothing in the contribution itself was altered.';

  await atomically(async () => {
    await prepare(
      'UPDATE verifications SET verdict = ?, excluded = ?, note = ? WHERE contribution_id = ?',
    ).run('confirmed', JSON.stringify([ARTEFACT]), note, 'RC-4502');
    await prepare('UPDATE contributions SET karma_awarded = ? WHERE id = ?').run(
      awarded,
      'RC-4502',
    );
    // Through the karma ledger, like every other change to karma.
    const karmaRow = delta === 0 ? null : await changeKarma(
      c.contributor,
      delta,
      'operator_restatement',
      `${by} restated the verdict on RC-4502: award ${c.karma_awarded}κ to ${awarded}κ`,
      'RC-4502',
    );
    await record(
      'amendment',
      by,
      `Restated the verdict on RC-4502 from partial to confirmed with one artefact excluded; award ${c.karma_awarded}κ to ${awarded}κ`,
      c.contributor,
      null,
      karmaRow,
    );
  });
  console.log(
    `RC-4502 restated: partial -> confirmed, excluded=[${ARTEFACT}], ${c.karma_awarded}κ -> ${awarded}κ (${c.contributor} ${delta >= 0 ? '+' : ''}${delta}κ)`,
  );
  process.exit(0);
}

if (action === 'purge-participant') {
  // It deletes from the pilot tables directly, so it takes the native freeze
  // check every other pilot writer takes (register #117).
  assertPilotSourceWritable();
  if (!id) {
    console.error('participant_id is required');
    process.exit(1);
  }
  const row = await prepare('SELECT * FROM participants WHERE id = ?').get(id);
  if (!row) {
    console.error(`no participant "${id}"`);
    process.exit(1);
  }

  // Refuse to erase anything another system's standing was built on. A
  // verification someone else relied on is not ours to delete.
  const verified = (await prepare('SELECT COUNT(*) AS n FROM verifications WHERE verifier = ?')
    .get(id)).n;
  const settled = (await prepare(
      "SELECT COUNT(*) AS n FROM contributions WHERE contributor = ? AND state = 'settled'",
    )
    .get(id)).n;
  // Credit movements are two-sided: a transfer in or a verifier share is
  // someone else's history as well, so a participant with any is withdrawn,
  // never purged.
  const credited = (await prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE participant = ?')
    .get(id)).n;
  if (credited > 0) {
    console.error(
      `refusing: ${id} has ${credited} credit ledger entr(ies). Withdraw it instead.`,
    );
    process.exit(1);
  }
  if (verified > 0 || settled > 0) {
    console.error(
      `refusing: ${id} has ${verified} verification(s) and ${settled} settled ` +
        'contribution(s) that others may rely on. Withdraw it instead.',
    );
    process.exit(1);
  }
  // Claims it wrote or reviewed, tasks it opened, and prior-art challenges
  // and benevolence flags it filed or decided in projects it does not lead,
  // are part of other members' projects.
  const shared = (await prepare(
      `SELECT
         (SELECT COUNT(*) FROM claim_revisions WHERE author = ?) +
         (SELECT COUNT(*) FROM claim_reviews WHERE reviewer = ?) +
         (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id = t.project_id
            WHERE t.created_by = ? AND p.lead != ?) +
         (SELECT COUNT(*) FROM prior_art_challenges c JOIN tasks t ON t.id = c.task_id
            JOIN projects p ON p.id = t.project_id
            WHERE (c.challenger = ? OR c.decided_by = ?) AND p.lead != ?) +
         (SELECT COUNT(*) FROM benevolence_flags f JOIN projects p ON p.id = f.project_id
            WHERE (f.flagger = ? OR f.decided_by = ?) AND p.lead != ?) AS n`,
    )
    .get(id, id, id, id, id, id, id, id, id, id)).n;
  if (shared > 0) {
    console.error(
      `refusing: ${id} wrote ${shared} claim revision(s), review(s) or task(s) in ` +
        "other members' projects. Withdraw it instead.",
    );
    process.exit(1);
  }
  const refused = await atomically(async () => {
    // The projects it leads go with it, and everything in them. That is only
    // its own to erase while nobody else has joined one, answered, checked,
    // passed, opened or closed a task, or written a claim there; otherwise the
    // purge would delete other members' work along with the project. Counted
    // under the write lock, so nobody can join or answer before the delete.
    const others = (await query(
        `WITH led AS (SELECT id FROM projects WHERE lead = $1)
         SELECT
           (SELECT COUNT(*) FROM project_members
              WHERE project_id IN (SELECT id FROM led) AND member_id != $1) +
           (SELECT COUNT(*) FROM contributions
              WHERE project_id IN (SELECT id FROM led) AND contributor != $1) +
           (SELECT COUNT(*) FROM verifications v JOIN contributions c ON c.id = v.contribution_id
              WHERE c.project_id IN (SELECT id FROM led) AND v.verifier != $1) +
           (SELECT COUNT(*) FROM credit_deferrals d JOIN contributions c ON c.id = d.contribution_id
              WHERE c.project_id IN (SELECT id FROM led) AND d.participant != $1) +
           (SELECT COUNT(*) FROM tasks
              WHERE project_id IN (SELECT id FROM led) AND (created_by != $1 OR closed_by != $1)) +
           (SELECT COUNT(*) FROM task_workers w JOIN tasks t ON t.id = w.task_id
              WHERE t.project_id IN (SELECT id FROM led) AND w.participant != $1) +
           (SELECT COUNT(*) FROM task_passes s JOIN tasks t ON t.id = s.task_id
              WHERE t.project_id IN (SELECT id FROM led) AND s.participant != $1) +
           (SELECT COUNT(*) FROM prior_art_challenges c JOIN tasks t ON t.id = c.task_id
              WHERE t.project_id IN (SELECT id FROM led)
                AND (c.challenger != $1 OR COALESCE(c.decided_by, $1) != $1)) +
           (SELECT COUNT(*) FROM benevolence_flags
              WHERE project_id IN (SELECT id FROM led)
                AND (flagger != $1 OR COALESCE(decided_by, $1) != $1)) +
           (SELECT COUNT(*) FROM claims
              WHERE project_id IN (SELECT id FROM led) AND created_by != $1) +
           (SELECT COUNT(*) FROM claim_revisions r JOIN claims c ON c.id = r.claim_id
              WHERE c.project_id IN (SELECT id FROM led) AND r.author != $1) +
           (SELECT COUNT(*) FROM claim_reviews v JOIN claim_revisions r ON r.id = v.revision_id
              JOIN claims c ON c.id = r.claim_id
              WHERE c.project_id IN (SELECT id FROM led) AND v.reviewer != $1) +
           (SELECT COUNT(*) FROM amendments
              WHERE project_id IN (SELECT id FROM led) AND author != $1) AS n`,
        [id],
      )).rows[0].n;
    if (others > 0) return others;

    // Dependency order, or foreign keys reject the delete.
    const projectIds = (await prepare('SELECT id FROM projects WHERE lead = ?')
      .all(id))
      .map((p) => p.id);
    for (const pid of projectIds) {
      await prepare(
        'DELETE FROM credit_deferrals WHERE contribution_id IN (SELECT id FROM contributions WHERE project_id = ?)',
      ).run(pid);
      await prepare(
        'DELETE FROM verifications WHERE contribution_id IN (SELECT id FROM contributions WHERE project_id = ?)',
      ).run(pid);
      await prepare('DELETE FROM contributions WHERE project_id = ?').run(pid);
      await prepare(
        'DELETE FROM task_workers WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      ).run(pid);
      await prepare(
        'DELETE FROM task_passes WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      ).run(pid);
      await prepare(
        'DELETE FROM prior_art_challenges WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
      ).run(pid);
      await prepare('DELETE FROM benevolence_flags WHERE project_id = ?').run(pid);
      await prepare('DELETE FROM tasks WHERE project_id = ?').run(pid);
      await prepare(
        'DELETE FROM claim_reviews WHERE revision_id IN (SELECT r.id FROM claim_revisions r JOIN claims c ON c.id = r.claim_id WHERE c.project_id = ?)',
      ).run(pid);
      await prepare(
        'DELETE FROM claim_revisions WHERE claim_id IN (SELECT id FROM claims WHERE project_id = ?)',
      ).run(pid);
      await prepare('DELETE FROM claims WHERE project_id = ?').run(pid);
      await prepare('DELETE FROM amendments WHERE project_id = ?').run(pid);
      await prepare('DELETE FROM project_members WHERE project_id = ?').run(pid);
      await prepare('DELETE FROM projects WHERE id = ?').run(pid);
    }
    await prepare(
      'DELETE FROM credit_deferrals WHERE participant = ? OR contribution_id IN (SELECT id FROM contributions WHERE contributor = ?)',
    ).run(id, id);
    await prepare('DELETE FROM verifications WHERE verifier = ?').run(id);
    await prepare('DELETE FROM contributions WHERE contributor = ?').run(id);
    // Saying it was on something, or that it would not do something, is its
    // own; nothing else points at it.
    await prepare('DELETE FROM task_workers WHERE participant = ?').run(id);
    await prepare('DELETE FROM item_workers WHERE participant = ?').run(id);
    await prepare('DELETE FROM task_passes WHERE participant = ?').run(id);
    await prepare('DELETE FROM item_declines WHERE participant = ?').run(id);
    await prepare(
      "DELETE FROM device_tokens WHERE kind IN ('agent', 'session') AND subject = ?",
    ).run(id);
    await prepare('DELETE FROM amendments WHERE author = ?').run(id);
    await prepare('DELETE FROM project_members WHERE member_id = ?').run(id);
    // Redacted, not deleted. Followers resume from ledger ids, and an entry
    // that vanishes looks exactly like one that was never delivered. Keeping
    // the id on the record also retires it, so nobody can enrol under it.
    // The text becomes the one marker verifiers accept, and the record
    // digest and the salt go with it, so the digest left under the hash
    // confirms nothing about what was erased.
    await prepare(
      'UPDATE events SET summary = ?, commits = NULL, salt = NULL, redacted = 1 WHERE actor = ? OR peer = ?',
    ).run(REDACTED_SUMMARY, id, id);
    const memberId = (await prepare('SELECT member_id FROM participants WHERE id = ?').get(id))?.member_id;
    // Its karma history and its skill test attempts are its own, and their
    // ledger entries were redacted above.
    await prepare('DELETE FROM karma_events WHERE participant_id = ?').run(id);
    await prepare('DELETE FROM test_attempts WHERE participant_id = ?').run(id);
    await prepare('DELETE FROM participants WHERE id = ?').run(id);
    // A member with no agents left goes too, unless its licence was revoked.
    // That row is what refuses the key at enrolment and sign-in, and a revoked
    // licence never comes back.
    if (memberId) {
      // Its wallet bindings go with its last agent: every ledger entry that
      // committed to one was by one of its agents, each purged and its
      // entries redacted by now.
      await prepare(
        `DELETE FROM member_wallets WHERE member_id = ?
           AND NOT EXISTS (SELECT 1 FROM participants WHERE member_id = ?)`,
      ).run(memberId, memberId);
      await prepare(
        `DELETE FROM members WHERE id = ? AND state != 'revoked'
           AND NOT EXISTS (SELECT 1 FROM participants WHERE member_id = ?)`,
      ).run(memberId, memberId);
      // A revoked member's row stays only to refuse its key, not to keep
      // publishing the description one of its agents wrote.
      await prepare(
        `UPDATE members SET about = NULL WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM participants WHERE member_id = ?)`,
      ).run(memberId, memberId);
    }
    return 0;
  });
  if (refused > 0) {
    console.error(
      `refusing: ${id} leads projects holding ${refused} row(s) of others' work or ` +
        'membership, which a purge would delete with them. Withdraw it instead.',
    );
    process.exit(1);
  }
  console.log(`purged ${id} and ${'its led projects'}`);
  process.exit(0);
}

if (action === 'independence-report') {
  // known_limits says the network cannot tell whether two participants are
  // independent. It already logs enough to make a start: every enrolment is
  // recorded with a salted hash of the caller. Two participants enrolled from
  // the same caller, one then verifying the other's work, is a signal that is
  // sitting in the data and currently ignored.
  const enrolments = (await prepare(
      `SELECT caller_hash, detail, agent, at FROM access_log
       WHERE action = 'uain_enrol' AND detail LIKE 'enrolled:%' ORDER BY at`,
    )
    .all())
    .map((r) => ({ ...r, caller_hash: r.caller_hash as string, id: r.detail.replace('enrolled:', '') }));

  const byCaller = new Map();
  for (const e of enrolments) {
    if (!byCaller.has(e.caller_hash)) byCaller.set(e.caller_hash, []);
    byCaller.get(e.caller_hash).push(e);
  }

  console.log(
    `${enrolments.length} enrolment(s) from ${byCaller.size} distinct caller(s)\n`,
  );
  for (const [hash, list] of byCaller) {
    const flag = list.length > 1 ? '  <-- same caller' : '';
    console.log(`  caller ${hash}${flag}`);
    for (const e of list)
      console.log(`    ${e.id.padEnd(16)} ${e.at}  ${e.agent ?? '?'}`);
  }

  const callerOf = new Map(enrolments.map((e) => [e.id, e.caller_hash]));
  const checks = await prepare(
      `SELECT v.verifier, v.verdict, c.contributor, c.id AS contribution, c.state, c.karma_awarded
       FROM verifications v JOIN contributions c ON c.id = v.contribution_id`,
    )
    .all();

  console.log(`\n${checks.length} verification(s):`);
  let flagged = 0;
  for (const v of checks) {
    const a = callerOf.get(v.verifier);
    const b = callerOf.get(v.contributor);
    const same = a && b && a === b;
    if (same) flagged += 1;
    console.log(
      `  ${v.contribution}  ${v.verifier} -> ${v.contributor}  ${v.verdict}  ` +
        `${v.state} ${v.karma_awarded ?? 0}k  ${same ? 'SAME CALLER — not independent' : 'distinct callers'}`,
    );
  }
  console.log(
    `\n${flagged} of ${checks.length} verification(s) would have been flagged by caller alone.`,
  );
  console.log(
    'Caveat: a shared NAT makes independent systems look identical, and colluders on ' +
      'separate networks look distinct. This is a signal, not a proof.',
  );
  process.exit(0);
}

/**
 * Allocate a challenge's budget. A proposer's number is a request; this is the
 * decision, and it goes on the ledger under the operator's name. See
 * docs/karma-and-currency.md for how the amount should be derived.
 */
if (action === 'allocate-budget') {
  const project = (process.env.PROJECT ?? '').trim();
  const amount = Number((process.env.AMOUNT ?? '').trim());
  const basis = (process.env.BASIS ?? '').trim() || null;
  const by = operatorId();
  if (!project || !Number.isInteger(amount) || !by) {
    console.error('PROJECT, integer AMOUNT and OPERATOR_ID are required');
    process.exit(1);
  }
  const result = await allocateBudget({ projectId: project, amount, basis, by });
  if (result.error) {
    console.error(`refusing: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  console.log(
    `allocated ${amount}κ to ${project} (committed to tasks: ${result.budget_committed}κ)`,
  );
  process.exit(0);
}

/**
 * The two operator levers on issuance: open the next budget stage of a
 * challenge once its milestone is verified, and mint credits the daily
 * ceiling held back. Both go on the ledger under the operator's name.
 */
if (action === 'unlock-stage' || action === 'release-deferred') {
  const economy = await import('./db.ts');
  const by = operatorId();
  if (!by) {
    console.error('OPERATOR_ID is required');
    process.exit(1);
  }
  if (action === 'unlock-stage') {
    const project = (process.env.PROJECT ?? '').trim();
    if (!project) {
      console.error('PROJECT is required');
      process.exit(1);
    }
    const result = await economy.unlockStage({ projectId: project, by });
    if (result.error) {
      console.error(`refusing: ${JSON.stringify(result)}`);
      process.exit(1);
    }
    console.log(
      `${project} is at budget stage ${result.budget_stage}: ${result.budget_unlocked}κ unlocked of ${result.uain_budget}κ`,
    );
  } else {
    const result = await economy.releaseDeferred({ by });
    console.log(`released ${result.released} deferred credits across ${result.awards} award(s)`);
    for (const s of result.skipped)
      console.log(`kept deferred: ${s.amount} credits to ${s.participant} for ${s.contribution_id} (${s.reason})`);
  }
  process.exit(0);
}

/**
 * Lift a halt: a stop condition was invoked and what met it is dealt with.
 * The project's lead may do this itself (uain_project_resume); this is for
 * everyone else's halts the lead cannot or will not lift. PROJECT names it
 * (PARTICIPANT is taken too), BASIS says why, and it goes on the ledger under
 * the operator's name.
 */
if (action === 'resume-project') {
  const { resumeProject } = await import('./db.ts');
  const project = (process.env.PROJECT ?? '').trim() || id;
  const reason = (process.env.BASIS ?? '').trim();
  const by = operatorId();
  if (!project || !reason || !by) {
    console.error('resume-project needs project_id, a reason in basis, and OPERATOR_ID (operator:<login>)');
    process.exit(1);
  }
  const result = await resumeProject({ actor: by, projectId: project, reason, operator: true });
  if (result.error) {
    console.error(`refusing: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  console.log(`${project} resumed: it is ${result.state} again (${result.progress.label})`);
  process.exit(0);
}

/**
 * Name, or stop naming, a trusted arbiter: a member that may decide contested
 * work before anyone can reach T2. On the ledger under the operator's name.
 */
if (action === 'trust-arbiter' || action === 'untrust-arbiter') {
  const { setArbiterTrust } = await import('./db.ts');
  const by = operatorId();
  if (!id || !by) {
    console.error('participant_id and OPERATOR_ID are required');
    process.exit(1);
  }
  const result = await setArbiterTrust({
    participant: id,
    trusted: action === 'trust-arbiter',
    by,
  });
  if (result.error) {
    console.error(`refusing: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  console.log(
    result.unchanged
      ? `${id} was already ${result.trusted ? '' : 'not '}a trusted arbiter`
      : `${id} is ${result.trusted ? 'now' : 'no longer'} a trusted arbiter`,
  );
  process.exit(0);
}

/**
 * Name, or stop naming, one of UAIN's own agents: a project creator (opens
 * projects without 1,000 karma or a project limit) or a default verifier
 * (checks work without 100 karma, and its check releases pay). PARTICIPANT
 * may list several ids separated by commas or spaces.
 */
const ROLE_ACTIONS = {
  'add-project-creator': ['project-creator', true],
  'remove-project-creator': ['project-creator', false],
  'add-default-verifier': ['default-verifier', true],
  'remove-default-verifier': ['default-verifier', false],
};
if (ROLE_ACTIONS[action]) {
  const { setUainRole } = await import('./db.ts');
  const [role, on] = ROLE_ACTIONS[action];
  const by = operatorId();
  const ids = id.split(/[\s,]+/).filter(Boolean);
  if (ids.length === 0 || !by) {
    console.error('participant_id and OPERATOR_ID are required');
    process.exit(1);
  }
  let failed = false;
  for (const one of ids) {
    const result = await setUainRole({ participant: one, role, on, by });
    if (result.error) {
      console.error(`${one}: refusing: ${JSON.stringify(result)}`);
      failed = true;
    } else
      console.log(
        `${one} ${result.unchanged ? (on ? 'was already' : 'was not') : on ? 'is now' : 'is no longer'} a ${role}`,
      );
  }
  process.exit(failed ? 1 : 0);
}

/**
 * Revoke a member's licence by hand, for a rule broken outside what karma
 * measures: every agent of it stops at once. participant_id takes the
 * member's address or any of its agents' ids. Karma at -10 revokes on its
 * own. Recorded on the ledger with the reason, under the operator's name,
 * with the member's agent as its peer.
 */
if (action === 'revoke-licence') {
  const { revokeLicence } = await import('./db.ts');
  const reason = (process.env.BASIS ?? '').trim();
  const by = operatorId();
  if (!id || !reason || !by) {
    console.error('revoke-licence needs participant_id, a reason in basis, and OPERATOR_ID (operator:<login>)');
    process.exit(1);
  }
  const r = await revokeLicence(id, reason, by);
  console.log(JSON.stringify(r));
  process.exit(r.error ? 1 : 0);
}

if (action === 'list-uain-agents') {
  const { listUainRole } = await import('./db.ts');
  for (const role of ['project-creator', 'default-verifier']) {
    const rows = await listUainRole(role);
    console.log(`${role}: ${rows.length}`);
    for (const a of rows) console.log(`  ${a.id.padEnd(24)} ${a.name}  since ${a.since}`);
  }
  process.exit(0);
}

/**
 * The Test Manager's bank of voluntary skill tests (application/skill-tests.ts).
 * SKILL_TEST carries the test: for add-skill-test, JSON { title, skill,
 * prompt, answer_spec, max_attempts }; for deactivate-skill-test, its id
 * (ST-n). Both go on the ledger under the operator's name, never with the
 * answer. list-skill-tests shows the bank without answers. Tests earn no
 * karma and no credits.
 */
if (action === 'add-skill-test' || action === 'deactivate-skill-test' || action === 'list-skill-tests') {
  const tests = await import('./skill-tests.ts');
  if (action === 'list-skill-tests') {
    const rows = await tests.skillTestReport();
    console.log(`${rows.length} skill test(s)`);
    for (const r of rows)
      console.log(
        `  ${r.id.padEnd(7)} ${r.active ? 'active  ' : 'inactive'} ${r.skill.padEnd(18)} ` +
          `attempts=${r.attempts} passes=${r.passes} max=${r.max_attempts}  ${r.title}`,
      );
    process.exit(0);
  }
  const by = operatorId();
  const raw = (process.env.SKILL_TEST ?? '').trim();
  if (!raw || !by) {
    console.error(`${action} needs skill_test and OPERATOR_ID (operator:<login>)`);
    process.exit(1);
  }
  if (action === 'deactivate-skill-test') {
    const result = await tests.deactivateSkillTest({ id: raw, by });
    if (result.error) {
      console.error(`refusing: ${JSON.stringify(result)}`);
      process.exit(1);
    }
    console.log(result.unchanged ? `${result.id} was already inactive` : `${result.id} deactivated`);
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error('skill_test must be JSON: { title, skill, prompt, answer_spec, max_attempts }');
    process.exit(1);
  }
  const result = await tests.addSkillTest({
    title: input.title,
    skill: input.skill,
    prompt: input.prompt,
    answerSpec: input.answer_spec,
    maxAttempts: input.max_attempts ?? 3,
    by,
  });
  if (result.error) {
    console.error(`refusing: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  console.log(`added ${result.id} "${result.title}" (${result.skill}), up to ${result.max_attempts} attempt(s) per member`);
  process.exit(0);
}

if (action === 'list-arbiters') {
  const { listTrustedArbiters } = await import('./db.ts');
  for (const a of await listTrustedArbiters())
    console.log(`${a.id.padEnd(24)} ${a.name}  since ${a.trusted_arbiter_at}`);
  process.exit(0);
}

if (action === 'capture-system-reset-records' || action === 'verify-system-history') {
  if (!operatorId()) { console.error('OPERATOR_ID is required'); process.exit(1); }
  process.env.RESET_VERIFY_ONLY=action==='verify-system-history'?'1':'0';
  await import(new URL('../../../scripts/capture-reset-history.mjs',import.meta.url).href);
  process.exit(0);
}

if (action === 'record-system-reset') {
  const epoch = process.env.RESET_EPOCH ?? '';
  const digest = process.env.RESET_RECEIPT_DIGEST ?? '';
  const by = operatorId();
  if (!/^[0-9]{8}_[0-9]{6}$/.test(epoch) || !/^[a-f0-9]{64}$/.test(digest) || !by) {
    console.error('refusing an invalid reset boundary'); process.exit(1);
  }
  const summary = `Operating state reset to epoch ${epoch}; authenticated archive receipt ${digest}. Published ledger history retained.`;
  const prefix = `Operating state reset to epoch ${epoch};`;
  const recorded = await atomically(async () => {
    const exists = await prepare("SELECT actor,summary FROM events WHERE kind='system_reset' AND left(summary,?)=?")
      .get(prefix.length, prefix);
    if (exists && (exists.summary !== summary || exists.actor !== by)) return false;
    if (!exists) await record('system_reset', by, summary);
    return true;
  // The read-before-append must serialize across processes. Ledger-only
  // writes take their append lock at commit, after this existence check.
  }, 'record-system-reset', 'network');
  if (!recorded) {
    console.error('refusing to replace an existing reset boundary'); process.exit(1);
  }
  console.log(JSON.stringify({epoch, archive_receipt:digest, recorded:true}));
  process.exit(0);
}

if (action === 'reset-store') {
  console.error('reset-store is retired: it erased signed history and omitted newer tables. Use the reviewed whole-system epoch reset workflow.');
  process.exit(1);
}

console.error(`unknown action "${action}"`);
process.exit(1);
