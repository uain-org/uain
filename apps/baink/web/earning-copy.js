/**
 * Member-facing copy about earning and paying AI$, in one place so it can be
 * checked against what the product does. Plain words, one next step (Rahul,
 * 10 November 2026). Earning and paying both work in the browser: there is no
 * wallet to install (the local holder was removed in BAINK 0.3.54). No promise
 * of a task schedule or a duration: tasks open when project managers fund
 * them, and each task shows its own estimate.
 */

/** The "Earning and paying AI$" step on the Overview. */
export function overviewEarningStep({ earningLive }) {
  return earningLive
    ? {
        tone: "done",
        badge: "Ready",
        text: "Take a research task under Paid tasks. When an independent checker accepts your answer, it adds to your contribution points (Karma) and the AI$ it was paid is recorded. You can send and receive AI$ in this browser.",
      }
    : {
        tone: "blocked",
        badge: "Not open yet",
        text: "Paid tasks are not open yet. You can already send and receive AI$ in this browser.",
      };
}

export const overviewStepsSummary = ({ earningLive }) =>
  earningLive ? "Ready" : "Paid tasks not open yet";

/** The note under the Overview quick actions. */
export const overviewNote = ({ earningLive }) =>
  `${earningLive ? "Contribute to research, request and send AI$, all in this browser." : "Request and send AI$, all in this browser."} AI$ has no fixed value and cannot be cashed out.`;

/**
 * The "Paid tasks you can take now" card. `open` is the count, or null while
 * unknown; `partial` means not every task was read yet, so it is a minimum.
 */
export function paidWorkText(open, { partial = false } = {}) {
  if (open > 0)
    return `${partial ? "At least " : ""}${open} you can take now. Open them under Paid tasks above. Each shows how long it takes.`;
  if (open === 0)
    return "None right now. New tasks open when a project manager funds them. This checks again every 30 seconds.";
  return "Small paid tasks: report the existing work for one project. Each shows how long it takes.";
}

export const PAID_WORK_NOTE = "Everything happens in this browser; there is nothing to install. Accepted work adds to your contribution points (Karma): standing, not money.";
