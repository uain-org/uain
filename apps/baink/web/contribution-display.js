/**
 * What the browser shows of a member's contribution (P0-3, 12 November 2026).
 * The view comes from BAINK (shared/contribution-view.mjs, one derivation for
 * every surface); this only words it. Points (Karma) lead, then accepted
 * answers with task and project, then checks for others, then what is not
 * counted. AI$ earned and the balance stay below as ledger facts, with their
 * own panel and the target-reference line.
 */
import { CONTRIBUTION_SCHEMA, contributionLines, contributionTotals } from "../shared/contribution-view.mjs";

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** null while unknown or unreadable; otherwise the figures and rows to render. */
export function contributionDisplay(view) {
  if (!view || view.schema !== CONTRIBUTION_SCHEMA) return null;
  const p = view.points, n = view.notCounted;
  const waiting = [
    n.awaitingReview.length ? `${n.awaitingReview.length} waiting for review` : null,
    n.needsEvidence.length ? `${n.needsEvidence.length} needing more evidence` : null,
    n.rejected.length ? `${n.rejected.length} rejected` : null,
  ].filter(Boolean);
  return {
    totals: contributionTotals(view),
    headline: `${p.total} contribution ${p.total === 1 ? "point" : "points"}`,
    label: p.label,
    note: p.note,
    incomplete: p.attribution !== "complete",
    acceptedText: view.accepted.count ? plural(view.accepted.count, "accepted answer") : "No accepted answer yet",
    accepted: view.accepted.items.map((a) => ({
      key: `solver/${a.submission}`,
      task: a.task,
      project: a.project,
      submission: a.submission,
      points: a.points,
      amount: a["amountAI$"],
    })),
    checksText: view.checks.count ? `${plural(view.checks.count, "check")} for other members, ${view.checks.points} points` : null,
    remainderText:
      p.fromEarlierOrKarmaOnly > 0 ? `${p.fromEarlierOrKarmaOnly} points from earlier or Karma-only work` : null,
    notCountedText: waiting.length ? `Not counted yet: ${waiting.join(", ")}.` : null,
    lines: contributionLines(view),
  };
}
