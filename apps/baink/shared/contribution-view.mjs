// One derivation of a member's contribution (P0-3, 12 November 2026).
//
// Rahul ruled on 11 November 2026 that contribution points are Karma: no new
// quantity. This module turns records BAINK already reads as native proofs
// into the view every surface shows (the signed status route, the public read,
// the baink_contribution MCP tool, the kit and the browser):
//
//   points      the member's Karma on the chain. Always the chain's number.
//   accepted    the member's accepted answers (solver awards), each with its
//               task, project, submission, the points it gave and its AI$.
//   checks      the checks the member did for others (reviewer awards),
//               listed apart. A reviewer is awarded on every verdict, a
//               rejection too, so a check is never an accepted contribution.
//   remainder   Karma from earlier or Karma-only work, so the listed points
//               plus the remainder equal the total.
//   notCounted  submissions awaiting review, needing more evidence or
//               rejected: shown apart, never counted.
//   ledger      AI$ earned by role and the balance: ledger facts, second.
//
// The points of one award are the chain's own rule (chain/federation/
// karma_policy.go, centralAwardKarma): 1 Karma per whole AI$ of the award, to
// the solver and to the reviewer. If the listed points ever exceed the chain's
// Karma (an award paid before the Karma policy and never backfilled), nothing
// is clamped or hidden: the total stays the chain's, the list stays as read,
// and the attribution is marked incomplete.
//
// Pure: no I/O, no clock, no model call. Transfers, refunds, payment requests,
// budgets, reservations and legacy pilot-credits-v1 claims are not inputs, so
// they can never add points or accepted contributions. Plain JavaScript so the
// server, the browser bundle and the tests load the same file.

export const CONTRIBUTION_SCHEMA = 'uain-contribution-v1';
/** At most this many rows per list in one view (counts and points cover every award read). */
export const CONTRIBUTION_LIST_LIMIT = 50;
const UNITS_PER_AI = 1000000n;
const UINT = /^(0|[1-9][0-9]{0,20})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** "1.1" for 1100000 micro-AI$, never "1.100000" (it was read as 1.1 million). */
export function aiDollars(units) {
  if (typeof units !== 'string' || !UINT.test(units)) return null;
  const n = BigInt(units), whole = n / UNITS_PER_AI, frac = n % UNITS_PER_AI;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(6, '0').replace(/0+$/, '')}`;
}

/** The Karma one award gave: 1 per whole AI$ (the chain's centralAwardKarma). */
export function awardPoints(amount) {
  if (typeof amount !== 'string' || !UINT.test(amount)) return 0;
  return Number(BigInt(amount) / UNITS_PER_AI);
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

function row(a) {
  return {
    task: a.task,
    project: a.project,
    submission: a.submission,
    points: awardPoints(a.amount),
    'amountAI$': aiDollars(a.amount),
    amountUnits: a.amount,
    height: a.height,
  };
}

/**
 * The contribution view.
 *
 * input:
 *   member        uain1 address
 *   enrolled      false when the chain has no member record for it
 *   karma         the member record's karma (an integer) or null if unreadable
 *   strikes       the member record's strikes (0 when absent)
 *   licence       the member record's licence
 *   earnings      central_earnings/<member>: {solver, reviewer, total, awards}
 *   awards        the award records read (any order; repeats are counted once)
 *   awardsComplete true when every award position of the member was read
 *   submissions   the member's own submission records read ({id, task, state, evidence_deadline?})
 *   submissionsComplete true when every submission BAINK relayed for the member was read
 *   balanceUnits  the transparent balance in micro-AI$, or null when not shown
 *   proofHeight   the height every record above was proved at
 */
export function deriveContribution(input) {
  const member = input.member;
  const karma = Number.isSafeInteger(input.karma) ? input.karma : null;
  const seen = new Set(), solver = [], reviewer = [];
  for (const a of Array.isArray(input.awards) ? input.awards : []) {
    if (!a || a.member !== member || !['solver', 'reviewer'].includes(a.role) || !ID.test(a.submission ?? '') || !UINT.test(a.amount ?? '') || !UINT.test(a.height ?? '')) continue;
    const key = a.role + '/' + a.submission;
    if (seen.has(key)) continue;
    seen.add(key);
    (a.role === 'solver' ? solver : reviewer).push(a);
  }
  const newest = (x, y) => (BigInt(y.height) > BigInt(x.height) ? 1 : BigInt(y.height) < BigInt(x.height) ? -1 : y.submission < x.submission ? -1 : y.submission > x.submission ? 1 : 0);
  solver.sort(newest);
  reviewer.sort(newest);
  const sum = (rows) => rows.reduce((n, a) => n + awardPoints(a.amount), 0);
  const fromAccepted = sum(solver), fromChecks = sum(reviewer), listed = fromAccepted + fromChecks;
  const walked = input.awardsComplete === true;
  let attribution = 'complete', why = null, remainder = null;
  if (karma === null) { attribution = 'incomplete'; why = 'karma_unreadable'; }
  else if (listed > karma) { attribution = 'incomplete'; why = 'listed_exceeds_karma'; }
  else if (!walked) { attribution = 'incomplete'; why = 'not_all_awards_read'; }
  else remainder = karma - listed;
  const total = karma ?? 0;
  const pointsNote = karma === null
    ? 'Your Karma could not be read just now, so no total is shown. Try again in a minute.'
    : why === 'listed_exceeds_karma'
      ? `The awards listed here would give ${listed} points, more than the ${total} Karma on the chain. The chain's Karma is the total; some award was paid before Karma was counted for it. The list is shown as read, not adjusted.`
      : why === 'not_all_awards_read'
        ? `${total} contribution points (Karma). Not every award was read yet, so the list is partial; ask again in a minute.`
        : remainder > 0
          ? `${total} contribution points (Karma): ${fromAccepted} from accepted answers, ${fromChecks} from checks for others, and ${remainder} from earlier or Karma-only work.`
          : `${total} contribution points (Karma)${listed ? `: ${fromAccepted} from accepted answers and ${fromChecks} from checks for others` : ''}.`;
  const states = { awaitingReview: [], needsEvidence: [], rejected: [] };
  const seenSubmissions = new Set();
  for (const s of Array.isArray(input.submissions) ? input.submissions : []) {
    if (!s || !ID.test(s.id ?? '') || seenSubmissions.has(s.id)) continue;
    seenSubmissions.add(s.id);
    const item = { submission: s.id, task: s.task ?? null };
    // An evidence request waits for its author until they revise or ask for a reassessment (then it is back with the reviewer).
    if (s.state === 'under_review' && UINT.test(String(s.evidence_deadline ?? '')) && s.reassess !== true) states.needsEvidence.push({ ...item, deadlineHeight: String(s.evidence_deadline) });
    else if (s.state === 'under_review') states.awaitingReview.push(item);
    else if (s.state === 'rejected') states.rejected.push(item);
  }
  const e = input.earnings ?? {};
  return {
    schema: CONTRIBUTION_SCHEMA,
    authority: 'native',
    verified: true,
    member,
    enrolled: input.enrolled !== false,
    points: {
      total,
      label: 'Contribution points (Karma)',
      fromAccepted,
      fromChecks,
      fromEarlierOrKarmaOnly: remainder,
      attribution,
      ...(why ? { incompleteBecause: why } : {}),
      note: pointsNote,
      rule: '1 point per whole AI$ of each accepted award, to the solver and to the reviewer; Karma-only research tasks add points too. Points never fall and cannot be spent, sent or bought.',
    },
    accepted: { count: solver.length, points: fromAccepted, items: solver.slice(0, CONTRIBUTION_LIST_LIMIT).map(row), more: solver.length > CONTRIBUTION_LIST_LIMIT },
    checks: { count: reviewer.length, points: fromChecks, items: reviewer.slice(0, CONTRIBUTION_LIST_LIMIT).map(row), more: reviewer.length > CONTRIBUTION_LIST_LIMIT,
      note: 'Checks you did for other members. A check is awarded on every verdict, a rejection too, so checks are listed apart from your accepted answers.' },
    notCounted: {
      awaitingReview: states.awaitingReview,
      needsEvidence: states.needsEvidence,
      rejected: states.rejected,
      complete: input.submissionsComplete === true,
      note: 'Work waiting for review, work that needs more evidence and rejected work give no points and are not counted.',
    },
    ledger: {
      'earnedAI$': aiDollars(e.total ?? '0'),
      'forAnswersAI$': aiDollars(e.solver ?? '0'),
      'forChecksAI$': aiDollars(e.reviewer ?? '0'),
      'balanceAI$': typeof input.balanceUnits === 'string' ? aiDollars(input.balanceUnits) : null,
      note: 'AI$ is the ledger record of what accepted work and checks were paid. It is shown apart from your contribution, and your balance changes when you pay or are paid; points do not.',
    },
    strikes: Number.isSafeInteger(input.strikes) ? input.strikes : 0,
    licence: typeof input.licence === 'string' ? input.licence : null,
    source: {
      awardsRead: seen.size,
      awardsTotal: UINT.test(String(e.awards ?? '')) ? String(e.awards) : null,
      awardsComplete: walked,
      proofHeight: input.proofHeight ?? null,
    },
  };
}

/**
 * The same view as short plain lines (the browser and the MCP reply use it;
 * the kit has a copy of these lines because it is one file). Points first,
 * then accepted work, then checks, then what is not counted, then the ledger.
 */
export function contributionLines(view) {
  if (!view || view.schema !== CONTRIBUTION_SCHEMA) return [];
  const p = view.points, lines = [];
  lines.push(p.attribution === 'complete' || p.incompleteBecause === 'not_all_awards_read' ? p.note : `${p.total} contribution points (Karma). ${p.note}`);
  lines.push(view.accepted.count ? `${plural(view.accepted.count, 'accepted answer')}, ${view.accepted.points} points.` : 'No accepted answer yet.');
  if (view.checks.count) lines.push(`${plural(view.checks.count, 'check')} for other members, ${view.checks.points} points.`);
  const n = view.notCounted, waiting = [
    n.awaitingReview.length ? `${n.awaitingReview.length} waiting for review` : null,
    n.needsEvidence.length ? `${n.needsEvidence.length} needing more evidence` : null,
    n.rejected.length ? `${n.rejected.length} rejected` : null,
  ].filter(Boolean);
  if (waiting.length) lines.push(`Not counted: ${waiting.join(', ')}.`);
  const l = view.ledger;
  lines.push(`Ledger: ${l['earnedAI$']} AI$ earned (${l['forAnswersAI$']} for answers, ${l['forChecksAI$']} for checks)${l['balanceAI$'] !== null ? `; balance ${l['balanceAI$']} AI$` : ''}.`);
  return lines;
}

/** The figures every surface must agree on (tests compare these across surfaces). */
export function contributionTotals(view) {
  return {
    points: view.points.total,
    accepted: view.accepted.count,
    acceptedPoints: view.accepted.points,
    checks: view.checks.count,
    checksPoints: view.checks.points,
    remainder: view.points.fromEarlierOrKarmaOnly,
    attribution: view.points.attribution,
    'earnedAI$': view.ledger['earnedAI$'],
  };
}
