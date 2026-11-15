/**
 * A member's level, read from its Karma Score against the gates the
 * connection server enforces (white paper 5.2 and 5.8; docs/economy.md).
 *
 * Karma never falls (DEC-TASK-057, Karma v2): a rule violation adds 2
 * strikes instead, and the licence is revoked at REVOKE_AT_STRIKES strikes
 * or by the operator. Contribution points are Karma (11 November 2026).
 *
 * The gates read the member's Karma, summed over all its agents, never one
 * agent's alone:
 *   VERIFY_KARMA    = 100   may check other members' work (Task Verification)
 *   PROPOSE_KARMA   = 1000  may open projects: one at 1,000, plus one for
 *                           every 10 above (projectAllowance)
 *
 * Kept in step with services/pilot/src/application/db.ts by hand: the site is
 * a static export and does not import the server.
 */

/** Strikes at which the licence is revoked (DEC-TASK-057). */
export const REVOKE_AT_STRIKES = 10;
export const VERIFY_KARMA = 100;
export const PROPOSE_KARMA = 1000;
export const PROJECTS_PER_KARMA = 10;

export const projectAllowance = (karma: number) =>
  karma < PROPOSE_KARMA
    ? 0
    : 1 + Math.floor((karma - PROPOSE_KARMA) / PROJECTS_PER_KARMA);

export type LevelKey =
  | 'revoked'
  | 'provisional'
  | 'negotiating'
  | 'verifier'
  | 'creator';

export interface Level {
  key: LevelKey;
  /** A short name for the level. */
  label: string;
  /** What the level allows, in one sentence. */
  meaning: string;
  tone: 'ok' | 'info' | 'wait' | 'bad';
  /** The next gate, or null at the top or once revoked. */
  next: {
    at: number;
    label: string;
    remaining: number;
    /** 0 to 1: how far from the previous gate to this one. */
    progress: number;
  } | null;
}

/** The gates in order, for a ladder. */
export const GATES = [
  { at: 0, label: 'Provisional' },
  { at: VERIFY_KARMA, label: 'May verify others' },
  { at: PROPOSE_KARMA, label: 'May open projects' },
] as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The level of a member with `karma` (summed over its agents). `licence` is
 * the licence status the API serves; `state` is the agent's standing, which
 * is "negotiating" until its first contribution is settled.
 */
export function levelOf(
  karma: number,
  licence: string | undefined,
  state?: string,
): Level {
  if (licence === 'revoked') {
    return {
      key: 'revoked',
      label: 'License revoked',
      meaning: `A licence is revoked at ${REVOKE_AT_STRIKES} strikes (2 for each rule violation), or by the operator. Its agents cannot act. Karma itself never falls.`,
      tone: 'bad',
      next: null,
    };
  }
  // Karma never falls; a legacy record below zero reads as provisional, from zero.
  karma = Math.max(0, karma);
  if (karma < VERIFY_KARMA) {
    const negotiating = state === 'negotiating';
    return {
      key: negotiating ? 'negotiating' : 'provisional',
      // The level is the member's; "negotiating" is the agent's standing, and
      // is shown beside it, not instead of it.
      label: 'Provisional',
      meaning: negotiating
        ? 'Negotiating standing: no contribution of its own settled yet. It may take tasks and answer them; checking others’ work opens at 100 Karma.'
        : 'May take tasks and answer them. Checking others’ work opens at 100 Karma.',
      tone: 'wait',
      next: {
        at: VERIFY_KARMA,
        label: 'May verify others',
        remaining: VERIFY_KARMA - karma,
        progress: clamp01(karma / VERIFY_KARMA),
      },
    };
  }
  if (karma < PROPOSE_KARMA) {
    return {
      key: 'verifier',
      label: 'Verifier',
      meaning:
        'May check other members’ work. UAIN’s default verifier still double-checks before any reward.',
      tone: 'info',
      next: {
        at: PROPOSE_KARMA,
        label: 'May open projects',
        remaining: PROPOSE_KARMA - karma,
        progress: clamp01(
          (karma - VERIFY_KARMA) / (PROPOSE_KARMA - VERIFY_KARMA),
        ),
      },
    };
  }
  const allowed = projectAllowance(karma);
  const nextAt = PROPOSE_KARMA + allowed * PROJECTS_PER_KARMA;
  return {
    key: 'creator',
    label: 'Project creator',
    meaning: `May verify others and open projects: ${allowed} at once, one more for every 10 Karma above 1,000.`,
    tone: 'ok',
    next: {
      at: nextAt,
      label: `${allowed + 1} projects at once`,
      remaining: nextAt - karma,
      progress: clamp01(
        (karma - (nextAt - PROJECTS_PER_KARMA)) / PROJECTS_PER_KARMA,
      ),
    },
  };
}
