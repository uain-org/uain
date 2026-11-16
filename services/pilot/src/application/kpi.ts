/**
 * Future-solvable tasks and KPIs (white paper 5.3; decision D7, taken on 30
 * September 2026). The rules are in domain/kpi.ts; settlement's hold, which
 * keeps a future task's verified work from being paid before its KPI
 * resolves, is holdForKpi in application/db.ts. Here:
 *
 * - setKpi: the task's creator or the project's lead states or restates a
 *   task's KPI until the task has a submission, and the lead a project's.
 * - resolveKpi: a UAIN default verifier or trusted arbiter, of a member other
 *   than the lead's, the task creator's and every member with standing work on
 *   the task, records what was observed. Met, the held awards are paid as
 *   settlement would have paid them; not met, they stay withheld.
 * - expireKpis: a KPI nobody resolved within KPI_GRACE_DAYS of its date
 *   expires, and its awards are withheld. Every read already shows it
 *   expired; this, run hourly, records it and closes the task.
 *
 * Each resolution is one ledger entry committing `T-n kpi resolution`
 * (ledger/records.ts, docs/ledger.md). Contributions stay verified whatever
 * the KPI does: only their awards wait for it.
 *
 * The writer thread imports this module too (runtime/writer-thread.ts), so it
 * finds these writes by name.
 */
import { isMainThread } from 'node:worker_threads';
import { schedulePilotMaintenance } from '../operations/background-policy.ts';
import { kpiResolutionCommitment } from '../ledger/records.ts';
import { changesOnlyProject, later, prepare } from '../storage/store.ts';
import {
  describeKpi,
  expiresAt,
  hydrateResolution,
  isKpiSource,
  kpiMet,
  kpiOf,
  kpiStatus,
  observedOf,
  KPI_GRACE_DAYS,
  KPI_NOTE_MIN,
} from '../domain/kpi.ts';
import {
  finishItem,
  getProject,
  getTask,
  isMember,
  membersOf,
  pay,
  record,
  settlePrize,
  write,
} from './db.ts';

const now = () => new Date().toISOString();
const key = (id: unknown) => String(id ?? '').trim().toUpperCase();
/** The actor of an expiry: nobody resolved it, so the network records it. */
export const EXPIRY_ACTOR = 'uain:kpi-expiry';

const selectTask = prepare('SELECT * FROM tasks WHERE id = ?');
const selectProject = prepare('SELECT * FROM projects WHERE id = ?');
const selectProjectLoose = prepare('SELECT * FROM projects WHERE lower(id) = lower(trim(?))');
const selectParticipant = prepare('SELECT * FROM participants WHERE id = ?');
const selectResolution = prepare('SELECT * FROM kpi_resolutions WHERE task_id = ?');
const selectContributions = prepare('SELECT * FROM contributions WHERE task_id = ? ORDER BY submitted_at, id');
const selectOpenChallenge = prepare(
  "SELECT id FROM prior_art_challenges WHERE task_id = ? AND state = 'open' ORDER BY id LIMIT 1",
);
const selectUpheld = prepare(
  "SELECT source FROM prior_art_challenges WHERE task_id = ? AND state = 'upheld' ORDER BY id LIMIT 1",
);
const selectVerifications = prepare('SELECT * FROM verifications WHERE contribution_id = ? ORDER BY at');
const selectExpired = prepare(
  `SELECT * FROM tasks t WHERE t.kind = 'future' AND t.resolves_by IS NOT NULL AND t.resolves_by <= ?
     AND NOT EXISTS (SELECT 1 FROM kpi_resolutions r WHERE r.task_id = t.id)
   ORDER BY t.resolves_by, t.id`,
);
const insertResolution = prepare(`
  INSERT INTO kpi_resolutions
    (task_id, outcome, observed, source, source_check, note, resolved_by, kpi, contributions, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
`);
const setTaskKpi = prepare('UPDATE tasks SET kpi = ?, resolves_by = ? WHERE id = ?');
const setProjectKpi = prepare('UPDATE projects SET kpi = ? WHERE id = ?');
const closeIfOpen = prepare(
  'UPDATE tasks SET closed_by = ?, closed_reason = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL',
);
const mootChallenges = prepare(
  "UPDATE prior_art_challenges SET state = 'moot', decided_at = ? WHERE task_id = ? AND state = 'open'",
);
const releaseHold = prepare('UPDATE contributions SET award_pending = NULL WHERE id = ?');
const withhold = prepare(
  'UPDATE contributions SET award_pending = NULL, award_withheld = ?, credits_awarded = 0 WHERE id = ?',
);
const setKarmaAwarded = prepare('UPDATE contributions SET karma_awarded = ? WHERE id = ?');

/* ------------------------------------------------------------ stating a KPI */

/** The project a KPI write stays in, for its lock (as db.ts's writes name it). */
async function scopeOfKpi({ taskId = null, projectId = null }: { taskId?: unknown; projectId?: unknown }) {
  if (taskId) return (await selectTask.get(key(taskId)))?.project_id ?? null;
  return projectId ? (await selectProjectLoose.get(String(projectId)))?.id ?? null : null;
}

/**
 * State or restate a KPI: a task's, by its creator or the project's lead,
 * until the task has a submission (then it is frozen, `kpi_frozen`: the work
 * was done against it); or a project's, by its lead, as a marker of success
 * it may restate as the work shows more. A future task always has one; an
 * instant task's may be cleared with null. Each change is on the ledger.
 */
export const setKpi = write(async function setKpi({ participant, taskId = null, projectId = null, kpi }) {
  if (Boolean(taskId) === Boolean(projectId)) return { error: 'task_or_project_required' };
  const marker = kpi === null || kpi === undefined ? null : kpiOf(kpi);
  if (marker?.error) return marker;
  if (projectId) {
    const project = await selectProjectLoose.get(String(projectId));
    if (!project) return { error: 'project_not_found' };
    if (project.lead !== participant) return { error: 'not_the_lead', lead: project.lead };
    if (project.state === 'halted' || project.state === 'complete')
      return { error: 'project_closed', state: project.state };
    await setProjectKpi.run(marker ? JSON.stringify(marker.value) : null, project.id);
    await record(
      'amendment',
      participant,
      marker
        ? `Stated the KPI of "${project.title}": ${describeKpi(marker.value)}`
        : `Cleared the KPI of "${project.title}"`,
    );
    return later(async () => ({ project: await getProject(project.id) }));
  }
  const task = await selectTask.get(key(taskId));
  if (!task) return { error: 'task_not_found' };
  const project = await selectProject.get(task.project_id);
  if (participant !== task.created_by && participant !== project.lead)
    return { error: 'not_creator_or_lead', created_by: task.created_by, lead: project.lead };
  if (project.state === 'halted' || project.state === 'complete')
    return { error: 'project_closed', state: project.state };
  if (task.closed_at) return { error: 'task_closed' };
  const first = (await selectContributions.all(task.id))[0];
  if (first) return { error: 'kpi_frozen', first_submission: first.id };
  if (task.kind === 'future' && !marker) return { error: 'kpi_required' };
  await setTaskKpi.run(marker ? JSON.stringify(marker.value) : null, marker?.deadline ?? null, task.id);
  await record(
    'task',
    participant,
    marker
      ? `Stated the KPI of ${task.id} on "${project.title}": ${describeKpi(marker.value)}`
      : `Cleared the KPI of ${task.id} on "${project.title}"`,
  );
  return later(async () => ({ task: await getTask(task.id) }));
}, scopeOfKpi);

/* ------------------------------------------------------------ resolving one */

/**
 * Pay, or withhold, the awards a future task's KPI held. Met, each held
 * contribution is paid what settlement would have paid it, with pay(): its
 * credibility, its credits within the issuance ceiling, and the verifier share
 * to the checks that stood when it settled; a priced task's price goes, as
 * settlePrize decides it, to its first result verified. Not met, or when the
 * task was closed as known, nothing is paid and the contribution stays
 * verified. Must run inside a write.
 */
async function decideHeld(task, held, met: boolean, known: string | null) {
  const decided = [];
  for (const c of held) {
    if (!met || known) {
      const why = known ? 'known' : 'kpi_unmet';
      await withhold.run(why, c.id);
      decided.push({ contribution_id: c.id, contributor: c.contributor, award_withheld: why });
      continue;
    }
    await releaseHold.run(c.id);
    const priced = task.karma_offered !== null && c.kind === 'work' && JSON.parse(c.reconciles ?? '[]').length === 0;
    if (priced) {
      decided.push({ contribution_id: c.id, contributor: c.contributor, price: 'decided below' });
      continue;
    }
    const h = JSON.parse(c.award_held ?? '{}');
    const checks = new Set(h.verifications ?? []);
    const standing = (await selectVerifications.all(c.id)).filter((v) => checks.has(v.id));
    await setKarmaAwarded.run(h.credibility ?? 0, c.id);
    const paid = await pay(c, h.credibility ?? 0, h.credits ?? 0, standing, `The KPI of ${task.id} was met: the award held for ${c.id} is paid`);
    decided.push({ contribution_id: c.id, contributor: c.contributor, karma_awarded: h.credibility ?? 0, ...paid });
  }
  const prize = (met && !known && task.karma_offered !== null ? await settlePrize(task.id) : null) as
    { winner?: string } | null;
  if (prize?.winner)
    for (const d of decided)
      if (d.price) d.price = d.contribution_id === prize.winner ? 'won' : `went to ${prize.winner}`;
  return { decided, prize };
}

/**
 * Record how a future task's KPI resolved. Only a UAIN default verifier or
 * trusted arbiter decides, of a member other than the project lead's, the
 * task creator's, and any member with standing work on the task: none of them
 * judges an outcome it stands to be paid for, or wrote. It says what it
 * observed (a number, or for "occurs" whether it happened), where it read it,
 * and what the source shows. Before the KPI's date it may resolve early, once
 * the outcome is on the public record. Refused once the KPI expired, and while
 * a challenge that the task is already solved waits for its decision.
 */
export const resolveKpi = write(async function resolveKpi({
  participant,
  taskId,
  observed,
  source,
  note,
  sourceCheck = null,
}) {
  const task = await selectTask.get(key(taskId));
  if (!task) return { error: 'task_not_found' };
  if (task.kind !== 'future') return { error: 'not_a_future_task', kind: task.kind ?? 'instant' };
  // It pays and withholds members' awards (read fresh, never kept in memory);
  // of what servers keep, it changes only this project's rows.
  changesOnlyProject(task.project_id);
  const done = await selectResolution.get(task.id);
  if (done) return { error: 'kpi_already_resolved', outcome: done.outcome, at: done.at };
  const kpi = JSON.parse(task.kpi);
  if (kpiStatus(task, null) === 'expired')
    return { error: 'kpi_expired', resolves_by: kpi.resolves_by, expired_at: expiresAt(task.resolves_by) };
  const project = await selectProject.get(task.project_id);
  // A halted project stops, pay included, until it resumes.
  if (project.state === 'halted') return { error: 'project_closed', state: project.state };
  const me = await selectParticipant.get(participant);
  if (!me?.default_verifier_at && !me?.trusted_arbiter_at) return { error: 'not_a_kpi_resolver' };
  if (!await isMember(task.project_id, participant)) return { error: 'not_a_member' };
  const contributions = await selectContributions.all(task.id);
  const standing = contributions.filter((c) => c.state !== 'rejected');
  const member = await membersOf([
    participant, project.lead, task.created_by, ...standing.map((c) => c.contributor),
  ]);
  const mine = member.get(participant);
  if (member.get(project.lead) === mine) return { error: 'resolver_not_independent', conflict: 'lead' };
  if (member.get(task.created_by) === mine) return { error: 'resolver_not_independent', conflict: 'creator' };
  const theirs = standing.filter((c) => member.get(c.contributor) === mine).map((c) => c.id);
  if (theirs.length) return { error: 'resolver_not_independent', conflict: 'contributor', contributions: theirs };
  const open = await selectOpenChallenge.get(task.id);
  if (open) return { error: 'prior_art_challenge_open', challenge_id: open.id };
  const seen = observedOf(kpi, observed);
  if (seen.error) return seen;
  const where = String(source ?? '').trim();
  if (where.length > 500 || !isKpiSource(where)) return { error: 'kpi_evidence_required' };
  const why = String(note ?? '').trim();
  if (why.length < KPI_NOTE_MIN) return { error: 'kpi_note_required', needed: KPI_NOTE_MIN };

  const met = kpiMet(kpi, seen.value);
  const held = contributions.filter((c) => c.award_pending === 'kpi');
  const known = (await selectUpheld.get(task.id))?.source ?? null;
  const at = now();
  const outcome = met ? 'met' : 'unmet';
  await insertResolution.run(
    task.id, outcome, JSON.stringify(seen.value), where, sourceCheck ? JSON.stringify(sourceCheck) : null,
    why, participant, task.kpi, JSON.stringify(held.map((c) => c.id)), at,
  );
  await finishItem(participant, 'kpi_resolution', task.id);
  await closeIfOpen.run(
    participant,
    `KPI ${met ? 'met' : 'not met'}: observed ${String(seen.value)} against ${describeKpi(kpi)}`,
    at,
    task.id,
  );
  await mootChallenges.run(at, task.id);
  const ids = held.map((c) => c.id).join(', ');
  // The resolution first: what it pays follows it on the ledger.
  await record(
    'verification',
    participant,
    `Resolved the KPI of ${task.id} on "${project.title}": observed ${String(seen.value)} against ` +
      `${describeKpi(kpi)}; ${met ? 'met' : 'not met'}` +
      (held.length
        ? met && !known
          ? `. The held awards of ${ids} are paid`
          : `. The awards of ${ids} are withheld`
        : '. No award was waiting on it'),
    task.created_by,
    kpiResolutionCommitment(await selectResolution.get(task.id)),
  );
  const { decided, prize } = await decideHeld(task, held, met, known);
  return later(async () => ({
    resolution: hydrateResolution(await selectResolution.get(task.id)),
    met,
    decided,
    ...(prize ? { prize } : {}),
    task: await getTask(task.id),
  }));
});

/* -------------------------------------------------------------- expiring */

/**
 * Record every future task whose KPI nobody resolved within KPI_GRACE_DAYS of
 * its date: one ledger entry each, committing the expiry as a resolution, the
 * held awards withheld (`kpi_expired`) and the task closed. Idempotent: a task
 * with a resolution is never touched again. Returns the tasks it expired.
 */
export const expireKpis = write(async function expireKpis() {
  const cutoff = new Date(Date.now() - KPI_GRACE_DAYS * 86_400_000).toISOString();
  const expired = [];
  for (const task of await selectExpired.all(cutoff)) {
    const kpi = JSON.parse(task.kpi);
    const held = (await selectContributions.all(task.id)).filter((c) => c.award_pending === 'kpi');
    const at = now();
    await insertResolution.run(
      task.id, 'expired', null, null, null,
      `Nobody resolved it within ${KPI_GRACE_DAYS} days of its date.`,
      null, task.kpi, JSON.stringify(held.map((c) => c.id)), at,
    );
    for (const c of held) await withhold.run('kpi_expired', c.id);
    await closeIfOpen.run(null, `KPI expired: unresolved ${KPI_GRACE_DAYS} days after ${kpi.resolves_by}`, at, task.id);
    await mootChallenges.run(at, task.id);
    await record(
      'task',
      EXPIRY_ACTOR,
      `The KPI of ${task.id} (${describeKpi(kpi)}) went unresolved for ${KPI_GRACE_DAYS} days after its date; ` +
        `${task.id} closes as expired` +
        (held.length ? `, and the held awards of ${held.map((c) => c.id).join(', ')} are withheld` : ''),
      task.created_by,
      kpiResolutionCommitment(await selectResolution.get(task.id)),
    );
    expired.push(task.id);
  }
  return { expired };
});

// Hourly, and once shortly after start, on the main thread only: the writer
// thread imports this module for its writes, not to sweep twice.
if (isMainThread) {
  const sweep = () =>
    expireKpis().catch((e) => console.error('kpi expiry:', e?.message ?? e));
  schedulePilotMaintenance(sweep, 3_600_000, 60_000);
}
