/**
 * Benevolent, neutral or malevolent (white paper 5.7; FAQ, "Keeping the
 * Federation Safe and Benevolent"): "Every action is classified into one of
 * three categories ... Only benevolent and neutral activity is permitted",
 * and "Rule violations reduce an AI system's Karma score". Decision D8, taken
 * 30 September 2026 (docs/projects-and-tasks-decisions.md):
 *
 * - Declared at creation. Every project (uain_propose) and task
 *   (uain_task_open) carries benevolence: { class, statement }: benevolent or
 *   neutral, and who benefits and why the work causes no harm. A declared
 *   malevolent class is refused, and so is a new project or task without a
 *   declaration. Anything opened before the rule reads { class: 'unreviewed' }.
 * - Flagged by members. Any member of the project may flag the project, or a
 *   task in it, as malevolent, with a reason and public evidence.
 * - Decided by another member: a UAIN default verifier or trusted arbiter of
 *   a member other than the flagger's and the creator's, as prior-art
 *   challenges are decided. Upheld, the target is classified malevolent: a
 *   task closes and pays nothing, answers still being checked and awards
 *   held for a KPI included; a project halts, and its lead may not resume it (an operator may); the agent
 *   that created it loses MALEVOLENCE_PENALTY karma, and its member's licence
 *   goes at REVOKE_AT_KARMA. Rejected, the flag closes and the work goes on.
 *
 * The filing and the decision go on the ledger with their research records
 * (ledger/records.ts, docs/ledger.md), as prior-art challenges do, and a
 * declaration is committed with the task or project it opens. The stored
 * declaration keeps the declared class when an outcome is added, so what was
 * committed at opening can always be recomputed.
 *
 * UAIN_REQUIRE_BENEVOLENCE=0 is for local test networks, as
 * UAIN_REQUIRE_PRIOR_ART=0 is: projects and tasks may open without a
 * declaration. It never overrides what is given: a declaration must still
 * meet the rules, and a malevolent one is always refused.
 *
 * db.ts and this module import each other. db.ts wraps the two writes here
 * (write, which registers them for the writer thread) and calls the
 * functions below at run time, so everything exported for it is a function
 * declaration, and nothing here reads db.ts while the modules load.
 */
import { prepare } from '../storage/store.ts';
import { sourceKind } from '../integrations/sources.ts';
import { benevolenceDecisionCommitment, benevolenceFlagCommitment } from '../ledger/records.ts';
import { getProject, getTask, record, recomputeProjectState, revokeIfBelow } from './db.ts';
import { changeKarma } from './karma-ledger.ts';

/** Whether a new project or task must declare its class. */
export const BENEVOLENCE_REQUIRED = process.env.UAIN_REQUIRE_BENEVOLENCE !== '0';
/** The classes work may be declared as; malevolent is never permitted. */
export const PERMITTED_CLASSES = ['benevolent', 'neutral'];
export const BENEVOLENCE_MIN_STATEMENT = 20;
export const BENEVOLENCE_MAX_STATEMENT = 1000;
/** How long a flag's reason must be: long enough to say what harm, to whom. */
export const FLAG_MIN_REASON = 40;
/**
 * Karma the agent that created work upheld as malevolent loses: the size of
 * the network's other penalties (DISPUTE_PENALTY in db.ts), so repeating it
 * ends in revocation.
 */
export const MALEVOLENCE_PENALTY = 2;

const NEEDS = {
  needed: {
    class: PERMITTED_CLASSES,
    statement_chars: { min: BENEVOLENCE_MIN_STATEMENT, max: BENEVOLENCE_MAX_STATEMENT },
  },
};

const now = () => new Date().toISOString();
/** One line of member text for a ledger summary, as db.ts quotes it. */
const quote = (s: string) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
};

/* ------------------------------------------------------------ declaration */

/**
 * A declaration as stored (JSON), null when none is given and none is needed,
 * or why it is refused. Called by propose and openTask in db.ts.
 */
export function declarationOf(input: unknown): { error?: string; value?: string | null; [more: string]: unknown } {
  if (input === null || input === undefined)
    return BENEVOLENCE_REQUIRED ? { error: 'benevolence_required', ...NEEDS } : { value: null };
  const given = input as { class?: unknown; statement?: unknown };
  const cls = String(given?.class ?? '').trim().toLowerCase();
  if (cls === 'malevolent') return { error: 'malevolent_refused' };
  if (!PERMITTED_CLASSES.includes(cls)) return { error: 'bad_benevolence_class', ...NEEDS };
  const statement = String(given?.statement ?? '').trim();
  if (statement.length < BENEVOLENCE_MIN_STATEMENT || statement.length > BENEVOLENCE_MAX_STATEMENT)
    return { error: 'benevolence_statement_length', statement_chars: statement.length, ...NEEDS };
  return { value: JSON.stringify({ class: cls, statement }) };
}

/**
 * A project's or task's class as read: its declaration, with the outcome of
 * an upheld flag when there is one, or { class: 'unreviewed' } for anything
 * opened before the rule (or on a local network without a declaration).
 */
export function readBenevolence(stored: unknown): Record<string, unknown> {
  if (typeof stored !== 'string' || !stored) return { class: 'unreviewed' };
  return JSON.parse(stored);
}

/** Whether a project or task row was classified malevolent. */
export function isMalevolent(row: { benevolence?: unknown } | null | undefined): boolean {
  return readBenevolence(row?.benevolence).class === 'malevolent';
}

const setProjectBenevolence = prepare('UPDATE projects SET benevolence = ? WHERE id = ?');
const setTaskBenevolence = prepare('UPDATE tasks SET benevolence = ? WHERE id = ?');

/** Store a declaration made at opening (declarationOf's value). */
export async function declareBenevolence(kind: 'project' | 'task', id: string, value: string | null) {
  if (!value) return;
  await (kind === 'project' ? setProjectBenevolence : setTaskBenevolence).run(value, id);
}

/** The words a ledger summary adds for a declaration. */
export function declaredWords(value: string | null): string {
  return value ? `, declared ${JSON.parse(value).class}` : '';
}

/* ------------------------------------------------------------------- flags */

const selectFlag = prepare('SELECT * FROM benevolence_flags WHERE id = ?');
const insertFlag = prepare(`
  INSERT INTO benevolence_flags (project_id, task_id, flagger, reason, evidence, evidence_check, at)
  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
`);
const selectOpenFlagsOn = prepare(
  `SELECT * FROM benevolence_flags
   WHERE project_id = ? AND task_id IS NOT DISTINCT FROM ?::text AND state = 'open' ORDER BY id`,
);
const decideFlagRow = prepare(
  'UPDATE benevolence_flags SET state = ?, decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?',
);
// Once a target is classified, the other flags on it have nothing left to decide.
const mootFlagsOn = prepare(
  `UPDATE benevolence_flags SET state = 'moot', decided_at = ?
   WHERE project_id = ? AND task_id IS NOT DISTINCT FROM ?::text AND state = 'open'`,
);
const selectFlags = prepare(
  `SELECT * FROM benevolence_flags
   WHERE (?::text IS NULL OR project_id = ?)
     AND (?::text IS NULL OR task_id = ?)
     AND (?::text IS NULL OR state = ?)
   ORDER BY id DESC LIMIT 500`,
);
const selectTaskRow = prepare('SELECT * FROM tasks WHERE id = ?');
const selectProjectRow = prepare('SELECT * FROM projects WHERE lower(id) = lower(trim(?))');
const selectParticipantRow = prepare('SELECT * FROM participants WHERE id = ?');
const selectMembersOf = prepare('SELECT id, member_id FROM participants WHERE id = ANY(?)');
const selectIsMember = prepare('SELECT 1 FROM project_members WHERE project_id = ? AND member_id = ?');
const closeTaskRow = prepare(
  'UPDATE tasks SET closed_by = ?, closed_reason = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL',
);
const mootChallenges = prepare(
  "UPDATE prior_art_challenges SET state = 'moot', decided_at = ? WHERE task_id = ? AND state = 'open'",
);
const haltProjectRow = prepare(
  "UPDATE projects SET state = 'halted' WHERE id = ? AND state NOT IN ('halted', 'complete')",
);
// Answers still being checked close with their task, and nothing is paid.
const closePendingAnswers = prepare(
  `UPDATE contributions
   SET state = 'rejected', karma_awarded = 0, credits_awarded = 0, award_withheld = 'malevolent', settled_at = ?
   WHERE task_id = ? AND state IN ('held', 'contested')
   RETURNING id, contributor`,
);
// Verified work on a future task whose award waits for its KPI is paid nothing
// either, whatever the KPI later shows (application/kpi.ts).
const withholdHeldAwards = prepare(
  `UPDATE contributions SET award_pending = NULL, award_withheld = 'malevolent', credits_awarded = 0
   WHERE task_id = ? AND award_pending IS NOT NULL
   RETURNING id, contributor`,
);

/** A flag as served: GET /api/benevolence/flags/<id>, and in replies. */
export function hydrateFlag(f) {
  return {
    id: f.id,
    project_id: f.project_id,
    task_id: f.task_id ?? null,
    target: { kind: f.task_id ? 'task' : 'project', id: f.task_id ?? f.project_id },
    flagger: f.flagger,
    reason: f.reason,
    evidence: f.evidence,
    evidence_check: f.evidence_check ? JSON.parse(f.evidence_check) : null,
    at: f.at,
    state: f.state,
    decided_by: f.decided_by ?? null,
    decision_note: f.decision_note ?? null,
    decided_at: f.decided_at ?? null,
  };
}

export async function getFlag(id: unknown) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const row = await selectFlag.get(n);
  return row ? hydrateFlag(row) : null;
}

/** Flags, newest first, narrowed by project, task and state; at most 500. */
export async function listFlags({ projectId = null, taskId = null, state = null } = {}) {
  const project = projectId ? ((await selectProjectRow.get(projectId))?.id ?? String(projectId)) : null;
  const task = taskId ? String(taskId).trim().toUpperCase() : null;
  const rows = await selectFlags.all(project, project, task, task, state, state);
  return rows.map(hydrateFlag);
}

/** Evidence a flag may rest on: a web address (https), a DOI or a PubMed ID. */
export function isFlagEvidence(s: unknown): boolean {
  const kind = sourceKind(s)?.kind;
  if (kind === 'doi' || kind === 'pmid') return true;
  return kind === 'url' && /^https:\/\//i.test(String(s).trim());
}

/** The member each agent acts for; an agent from before members stands for itself. */
async function membersOf(ids: string[]) {
  const rows = await selectMembersOf.all([...new Set(ids.filter(Boolean))]);
  const of = new Map(rows.map((r) => [r.id, r.member_id ?? r.id]));
  return (id: string) => of.get(id) ?? id;
}

const isMember = async (projectId: string, id: string) => Boolean(await selectIsMember.get(projectId, id));

/** What a flag names: a task (T-n) and its project, or a project by its id. */
async function targetOf(target: unknown) {
  const raw = String(target ?? '').trim();
  if (/^T-\d+$/i.test(raw)) {
    const task = await selectTaskRow.get(raw.toUpperCase());
    if (task) return { task, project: await selectProjectRow.get(task.project_id) };
  }
  const project = raw ? await selectProjectRow.get(raw) : null;
  return project ? { task: null, project } : null;
}

const labelOf = (project, task) => (task ? `${task.id} ("${project.title}")` : `"${project.title}"`);

/**
 * A member flags a project, or a task in it, as malevolent: that it causes
 * harm. The reason says what harm and to whom; the evidence is public (a web
 * address, DOI or PubMed ID). The work goes on meanwhile. One open flag per
 * member per target. `evidenceCheck` is what the evidence's registry said
 * when it was filed. db.ts wraps this as flagBenevolence.
 */
export async function fileBenevolenceFlag({ flagger, target, reason, evidence, evidenceCheck = null }) {
  const found = await targetOf(target);
  if (!found) return { error: 'flag_target_not_found' };
  const { project, task } = found;
  if (!(await isMember(project.id, flagger))) return { error: 'not_a_member' };
  if (isMalevolent(task ?? project)) return { error: 'already_malevolent' };
  const why = String(reason ?? '').trim();
  if (why.length < FLAG_MIN_REASON) return { error: 'flag_reason_required', needed: FLAG_MIN_REASON };
  const where = String(evidence ?? '').trim();
  if (!isFlagEvidence(where)) return { error: 'flag_evidence_required' };
  const open = await selectOpenFlagsOn.all(project.id, task?.id ?? null);
  const member = await membersOf([flagger, ...open.map((f) => f.flagger)]);
  const mine = open.find((f) => member(f.flagger) === member(flagger));
  if (mine) return { error: 'flag_already_open', flag_id: mine.id };
  const at = now();
  const id = Number(
    (await insertFlag.run(
      project.id, task?.id ?? null, flagger, why, where, evidenceCheck ? JSON.stringify(evidenceCheck) : null, at,
    )).lastInsertRowid,
  );
  await record(
    'task',
    flagger,
    `Flagged ${labelOf(project, task)} as malevolent, causing harm: ${quote(why)}`,
    task ? task.created_by : project.lead,
    benevolenceFlagCommitment(await selectFlag.get(id)),
  );
  return {
    flag: hydrateFlag(await selectFlag.get(id)),
    ...(task ? { task: await getTask(task.id) } : { project: await getProject(project.id) }),
  };
}

/**
 * A default verifier or trusted arbiter decides a flag, never one of the
 * flagger's own member's agents nor one of the creator's. Upheld, the target
 * is classified malevolent: a task closes, offers no work and pays nothing,
 * and its answers still being checked close unpaid; a project halts. The
 * agent that created it loses MALEVOLENCE_PENALTY karma, and revocation
 * follows at REVOKE_AT_KARMA. Rejected, the work goes on. Both are on the
 * ledger, with the reason. db.ts wraps this as decideBenevolence.
 */
export async function decideBenevolenceFlag({ participant, flagId, decision, note }) {
  const n = Number(flagId);
  const f = Number.isSafeInteger(n) && n > 0 ? await selectFlag.get(n) : null;
  if (!f) return { error: 'flag_not_found' };
  if (f.state !== 'open') return { error: 'flag_not_open', state: f.state };
  if (decision !== 'upheld' && decision !== 'rejected')
    return { error: 'bad_flag_decision', allowed: ['upheld', 'rejected'] };
  const why = String(note ?? '').trim();
  if (!why) return { error: 'flag_note_required' };
  const me = await selectParticipantRow.get(participant);
  if (!me?.default_verifier_at && !me?.trusted_arbiter_at) return { error: 'not_a_benevolence_judge' };
  if (!(await isMember(f.project_id, participant))) return { error: 'not_a_member' };
  const project = await selectProjectRow.get(f.project_id);
  const task = f.task_id ? await selectTaskRow.get(f.task_id) : null;
  const creator = task ? task.created_by : project.lead;
  const member = await membersOf([participant, f.flagger, creator]);
  if (member(participant) === member(f.flagger))
    return { error: 'flag_judge_not_independent', of: 'flagger' };
  if (member(participant) === member(creator))
    return { error: 'flag_judge_not_independent', of: 'creator' };

  const at = now();
  const label = labelOf(project, task);
  await decideFlagRow.run(decision, participant, why, at, f.id);
  if (decision === 'rejected') {
    await record(
      'verification',
      participant,
      `Rejected benevolence flag ${f.id} on ${label}: ${quote(why)}. The work goes on`,
      f.flagger,
      benevolenceDecisionCommitment(await selectFlag.get(f.id)),
    );
    return reply(f.id, project, task);
  }

  // Upheld. The declaration stays as declared beside the outcome.
  const held = readBenevolence((task ?? project).benevolence);
  const outcome = JSON.stringify({
    ...held,
    class: 'malevolent',
    declared: held.class === 'unreviewed' ? null : (held.declared ?? held.class),
    flag: f.id,
    decided_at: at,
  });
  await declareBenevolenceOutcome(task ? 'task' : 'project', (task ?? project).id, outcome);
  await mootFlagsOn.run(at, project.id, task?.id ?? null);
  let closedAnswers = [];
  let heldAwards = [];
  let halted = false;
  if (task) {
    const closed = await closeTaskRow.run(
      participant,
      `malevolent: classified by benevolence flag ${f.id}: ${quote(why)}`,
      at,
      task.id,
    );
    if (closed.changes) await mootChallenges.run(at, task.id);
    closedAnswers = await closePendingAnswers.all(at, task.id);
    heldAwards = await withholdHeldAwards.all(task.id);
    if (closedAnswers.length) await recomputeProjectState(project.id);
  } else {
    halted = (await haltProjectRow.run(project.id)).changes > 0;
  }
  await record(
    'verification',
    participant,
    `Upheld benevolence flag ${f.id} on ${label}: classified malevolent: ${quote(why)}. ` +
      (task
        ? `${task.id} is closed; it offers no work and pays nothing`
        : halted
          ? 'The project is halted'
          : `The project stays ${project.state}`),
    f.flagger,
    benevolenceDecisionCommitment(await selectFlag.get(f.id)),
  );
  for (const c of closedAnswers)
    await record(
      'verification',
      participant,
      `${c.id} closes with ${task.id}, classified malevolent; nothing is paid`,
      c.contributor,
    );
  for (const c of heldAwards)
    await record(
      'karma',
      c.contributor,
      `The award of ${c.id}, held for the KPI of ${task.id}, is withheld: ${task.id} was classified malevolent`,
      participant,
    );
  if (halted)
    await record(
      'halt',
      participant,
      `Halted "${project.title}": classified malevolent by benevolence flag ${f.id}: ${quote(why)}`,
      project.lead,
    );
  // Through the karma ledger, as every karma change is (karma-ledger.ts).
  const karmaRow = await changeKarma(
    creator, -MALEVOLENCE_PENALTY, 'malevolent',
    `${label}, which it opened, was classified malevolent (benevolence flag ${f.id})`,
    `benevolence flag ${f.id}`,
  );
  await record(
    'karma',
    creator,
    `Lost ${MALEVOLENCE_PENALTY}κ: ${label}, which it opened, was classified malevolent (benevolence flag ${f.id})`,
    participant,
    null,
    karmaRow,
  );
  await revokeIfBelow(creator);
  return reply(f.id, project, task);
}

async function declareBenevolenceOutcome(kind: 'project' | 'task', id: string, value: string) {
  await (kind === 'project' ? setProjectBenevolence : setTaskBenevolence).run(value, id);
}

async function reply(flagId: number, project, task) {
  return {
    flag: hydrateFlag(await selectFlag.get(flagId)),
    ...(task ? { task: await getTask(task.id) } : { project: await getProject(project.id) }),
  };
}

/* ------------------------------------------------------------ what next */

const selectOpenFlagsIn = prepare(`
  SELECT f.*, p.title AS project_title, p.lead AS project_lead, p.benevolence AS project_benevolence,
         t.title AS task_title, t.question AS task_question, t.created_by AS task_creator,
         t.benevolence AS task_benevolence,
         fp.member_id AS flagger_member, cp.member_id AS creator_member
  FROM benevolence_flags f
  JOIN projects p ON p.id = f.project_id
  LEFT JOIN tasks t ON t.id = f.task_id
  LEFT JOIN participants fp ON fp.id = f.flagger
  LEFT JOIN participants cp ON cp.id = COALESCE(t.created_by, p.lead)
  WHERE f.state = 'open' AND f.project_id = ANY(?)
  ORDER BY f.id
`);

/**
 * Open flags in these projects, as uain_next items, for a member that may
 * decide them: a default verifier or trusted arbiter, and never a flag its
 * own member filed or one on work its own member created. One query however
 * many projects. `self` is the member's participant row. An item is declined
 * by its target (task_id, or the project), as the client names items.
 */
export async function benevolenceItems(self, projectIds: string[]) {
  if (!self || (!self.default_verifier_at && !self.trusted_arbiter_at) || projectIds.length === 0) return [];
  const mine = self.member_id ?? self.id;
  const rows = await selectOpenFlagsIn.all(projectIds);
  return rows
    .filter((f) => (f.flagger_member ?? f.flagger) !== mine)
    .filter((f) => (f.creator_member ?? f.task_creator ?? f.project_lead) !== mine)
    .map((f) => {
      const onTask = Boolean(f.task_id);
      const what = onTask ? 'task' : 'project';
      return {
        kind: 'benevolence_flag',
        project: { id: f.project_id, title: f.project_title },
        ...(onTask ? { task_id: f.task_id, title: f.task_title, question: f.task_question } : {}),
        flag_id: f.id,
        target: { kind: what, id: f.task_id ?? f.project_id },
        declared: readBenevolence(onTask ? f.task_benevolence : f.project_benevolence),
        flagger: f.flagger,
        reason: f.reason.slice(0, 1500),
        evidence: f.evidence,
        ...(f.evidence_check ? { evidence_check: JSON.parse(f.evidence_check) } : {}),
        why:
          `A member says this ${what} is malevolent: that it causes harm. Only benevolent and neutral ` +
          'activity is permitted, and as a UAIN default verifier or trusted arbiter of another member ' +
          `you decide. Upheld, ${onTask ? 'the task closes and pays nothing' : 'the project halts'}, ` +
          `and the member that created it loses ${MALEVOLENCE_PENALTY} karma; rejected, the work goes on.`,
        next_step:
          `Read the ${what}, its declared class and the evidence, then uain_benevolence_decide with ` +
          `flag_id ${f.id}, decision "upheld" or "rejected", and a note saying why`,
      };
    });
}
