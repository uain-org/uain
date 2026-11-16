/**
 * Where a task or a contribution stands, as one stepper:
 *
 *   Open → Answered → Checking → Verified → Settled
 *
 * mapped from the states the connection server really uses
 * (services/pilot/src/application/db.ts):
 *
 * - A contribution is `held` until its checks are in, then `settled`, or
 *   `rejected`, or `contested` when checkers disagree and an arbiter must
 *   decide. A settled one may still wait for its award (`award_pending`
 *   "kpi", a future task's KPI) or be paid nothing (`award_withheld`
 *   "known" or "malevolent").
 * - A task is `open`, `needs_comparison` (it asked for several answers and
 *   they need comparing), `awaiting_verification`, `answered` (a result
 *   settled) or `closed` (taskStatus in db.ts).
 *
 * Contested, disputed, rejected and closed are not steps: they are shown
 * beside the stepper as a side state, so a reader sees both how far the work
 * got and what is holding it.
 */
import type {
  LiveContribution,
  LiveRequirements,
  LiveTask,
} from './live';

export const STEPS = ['Open', 'Answered', 'Checking', 'Verified', 'Settled'] as const;

export type StepState = 'done' | 'current' | 'problem' | 'todo';
export type SideTone = 'wait' | 'bad' | 'muted' | 'info';

export interface Progress {
  steps: StepState[];
  /** The step in hand: the first not done. */
  at: number;
  /** What the stepper says, in a few words. */
  label: string;
  side: { label: string; tone: SideTone } | null;
}

/** The stepper with the first `done` steps done and the next in hand. */
function upTo(done: number, problem = false): StepState[] {
  return STEPS.map((_, i) =>
    i < done ? 'done' : i === done ? (problem ? 'problem' : 'current') : 'todo',
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the stepper reads of a contribution: its state, checks and award. */
export interface ProgressOf {
  state: string;
  verifications?: { verifier: string; verdict: string }[];
  verifiers_required?: number;
  karma_awarded?: number | null;
  award_pending?: string | null;
  award_withheld?: string | null;
}

/** A contribution's progress, from its state, checks and award. */
export function contributionProgress(c: ProgressOf): Progress {
  const checks = c.verifications ?? [];
  const confirmed = checks.filter((v) => v.verdict === 'confirmed').length;
  const disputed = checks.filter((v) => v.verdict === 'disputed');
  const needed = Math.max(1, c.verifiers_required ?? 1);

  if (c.state === 'settled') {
    if (c.award_pending === 'kpi') {
      return {
        steps: upTo(4),
        at: 4,
        label: 'Verified',
        side: { label: 'Award held until its KPI resolves', tone: 'wait' },
      };
    }
    const nothing =
      c.award_withheld === 'known'
        ? 'Settled with no reward: already known'
        : c.award_withheld === 'malevolent'
          ? 'Settled with no reward: malevolent'
          : null;
    return {
      steps: upTo(5),
      at: 5,
      label:
        c.karma_awarded != null && !nothing
          ? `Settled · ${c.karma_awarded}κ`
          : 'Settled',
      side: nothing ? { label: nothing, tone: 'muted' } : null,
    };
  }
  if (c.state === 'rejected') {
    return {
      steps: upTo(2, true),
      at: 2,
      label: 'Rejected',
      side: {
        label:
          c.award_withheld === 'malevolent'
            ? 'Rejected: upheld as malevolent'
            : 'Rejected by its checks',
        tone: 'bad',
      },
    };
  }
  if (c.state === 'contested' || c.state === 'disputed') {
    return {
      steps: upTo(2, true),
      at: 2,
      label: 'Checking',
      side: { label: 'Contested: waiting for an arbiter', tone: 'wait' },
    };
  }
  // held: answered, and waiting for its checks.
  if (confirmed >= needed) {
    return {
      steps: upTo(3),
      at: 3,
      label: 'Verified, settling',
      side: null,
    };
  }
  return {
    steps: upTo(2),
    at: 2,
    label: `Checking · ${checks.length} of ${plural(needed, 'check')}`,
    side: disputed.length
      ? { label: `Disputed by ${disputed.map((v) => v.verifier).join(', ')}`, tone: 'wait' }
      : null,
  };
}

/** The furthest any of a task's standing results got: the one to show. */
function leadResult(
  task: LiveTask,
  byId: Map<string, LiveContribution>,
): LiveContribution | null {
  const all = [...task.results, ...task.comparisons]
    .map((r) => byId.get(r.id))
    .filter((c): c is LiveContribution => Boolean(c));
  const standing = all.filter((c) => c.state !== 'rejected');
  const rank = (c: LiveContribution) => contributionProgress(c).at;
  return (
    [...standing].sort((a, b) => rank(b) - rank(a))[0] ?? all.at(-1) ?? null
  );
}

/** A task's progress, from its status and its results. */
export function taskProgress(
  task: LiveTask,
  byId: Map<string, LiveContribution>,
): Progress {
  const lead = leadResult(task, byId);
  const working = task.working?.count ?? 0;
  const results = task.results ?? [];
  const contested = results.some((r) => r.state === 'contested');

  if (task.status === 'closed') {
    const reached = lead ? contributionProgress(lead).at : results.length ? 2 : 0;
    return {
      steps: STEPS.map((_, i) => (i < reached ? 'done' : 'todo')),
      at: reached,
      label: 'Closed',
      side: {
        label: task.closed?.reason ? `Closed: ${task.closed.reason}` : 'Closed',
        tone: 'muted',
      },
    };
  }
  if (task.status === 'answered') {
    const p = lead ? contributionProgress(lead) : null;
    if (p && p.at === 4)
      return { ...p, label: 'Verified' };
    return {
      steps: upTo(5),
      at: 5,
      label: task.price?.won_by ? `Settled · price to ${task.price.won_by}` : 'Settled',
      side: null,
    };
  }
  if (task.status === 'awaiting_verification') {
    const p = lead ? contributionProgress(lead) : null;
    return {
      steps: p && p.at >= 2 ? p.steps : upTo(2),
      at: p && p.at >= 2 ? p.at : 2,
      label: p?.label ?? 'Checking',
      side: contested
        ? { label: 'Contested: waiting for an arbiter', tone: 'wait' }
        : (p?.side ?? null),
    };
  }
  if (task.status === 'needs_comparison') {
    return {
      steps: upTo(1),
      at: 1,
      label: 'Answered',
      side: { label: 'Answers need comparing', tone: 'info' },
    };
  }
  // open: it wants (more) answers.
  const standing = results.filter((r) => r.state !== 'rejected');
  if (standing.length > 0) {
    // It asked for more answers than it has; what holds the ones it has
    // (a contest, a dispute) still shows.
    const held = lead ? contributionProgress(lead).side : null;
    return {
      steps: upTo(1),
      at: 1,
      label: `Answered · wants more`,
      side:
        held && held.tone !== 'muted'
          ? held
          : working
            ? { label: `${working} working on it`, tone: 'info' }
            : null,
    };
  }
  return {
    steps: upTo(0),
    at: 0,
    label: working ? `Open · ${working} working on it` : 'Open',
    side:
      results.length > 0
        ? { label: 'Earlier answers rejected', tone: 'bad' }
        : null,
  };
}

/**
 * What a task needs, in short words, whatever form it was stored in: a list
 * in words (before 30 September 2026), or tools, compute, data, proof and
 * needs. Optional everywhere: a task without any gives [].
 */
export function needsOf(r: LiveTask['requirements'] | undefined): string[] {
  if (!r) return [];
  if (Array.isArray(r)) return r.filter((x) => typeof x === 'string');
  const q = r as Partial<LiveRequirements>;
  return [
    ...(q.tools ?? []),
    ...(q.compute?.gpu ? ['GPU'] : []),
    ...(q.compute?.min_memory_gb ? [`${q.compute.min_memory_gb} GB memory`] : []),
    ...(q.data ?? []),
    ...(q.needs ?? []),
  ].filter((x) => typeof x === 'string' && x.trim().length > 0);
}

/** The proof a task's result should attach, if the task says. */
export function proofOf(r: LiveTask['requirements'] | undefined): string[] {
  if (!r || Array.isArray(r)) return [];
  return (r as Partial<LiveRequirements>).proof?.artifacts ?? [];
}
