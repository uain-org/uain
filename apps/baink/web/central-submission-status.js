/**
 * What a member's own central earning step means now, joined to the proven
 * award list, the task's winner and pending submission, and checker feedback.
 * Presentation only: the server and the ledger stay the authority, and this
 * never marks anything earned that the award list or the task does not show.
 */
import { displayUnits } from "./exact-amount.js";
import { centralTaskOpen } from "./central-task-actions.js";

const UINT = /^\d+$/;

/** Sent to the network (or recorded there), so its outcome is not "not sent". */
export const sentIntent = (i) => !!i?.sendAttemptedAt || i?.finalized === true;

/**
 * Recorded on the network. A step whose earlier final receipt cannot be
 * re-checked right now (`proof_unavailable` with `historicalReceipt: false`,
 * which the server sets only for a stored final receipt) is still recorded: a
 * transient proof problem must not make it count as waiting again.
 */
export const settledIntent = (i) =>
  (i?.finalized === true && i.result?.verified === true) ||
  (i?.status === "proof_unavailable" && i.historicalReceipt === false);

/** Sent and neither refused nor recorded: its outcome is still open. */
export const outstandingIntent = (i) =>
  sentIntent(i) && !settledIntent(i) && i.status !== "refused";

const eventHeight = (i) => {
  const h = i?.receipt?.event?.height ?? i?.receipt?.state_height;
  return typeof h === "string" && UINT.test(h) ? BigInt(h) : null;
};
const provenHeight = (task) =>
  typeof task?.provenAt === "string" && UINT.test(task.provenAt)
    ? BigInt(task.provenAt)
    : null;

/**
 * The status of one own step.
 * @returns {{kind: string, label: string, amount?: string}}
 *   kind is one of: joined, accepted, rejected, not_accepted, needs_evidence,
 *   superseded, expired, reassessment_pending,
 *   under_review, submitted, refused, proof_unavailable, waiting, unknown,
 *   prepared, or the raw status.
 */
export function submissionStatus(
  intent,
  { awards = [], task = null, feedback = null, revisedBy = null, now = Date.now() } = {},
) {
  // Honest review time (10 November 2026): past about 15 minutes say so, with the reason.
  const waiting = (kind, label) => {
    const late = reviewDelay(intent, now);
    return late ? { kind, label: "Sent · review delayed", delayed: true, detail: late } : { kind, label };
  };
  const join = intent?.command?.operation === "project_join";
  const settled = settledIntent(intent);
  if (join) {
    if (settled)
      return { kind: "joined", label: "Joined the project" };
    return networkStatus(intent);
  }
  const operation = intent?.command?.operation;
  if (operation === "central_reassess" || operation === "central_evidence_expire") {
    if (!settled) return networkStatus(intent);
    return operation === "central_reassess"
      ? { kind: "recorded", label: "Done · the reviewer is looking again" }
      : { kind: "recorded", label: "Done · the task is open again" };
  }
  const id = intent?.command?.payload?.id;
  // 1. The proven award list is the strongest fact: this submission was paid.
  const award = Array.isArray(awards)
    ? awards.find((a) => a?.role === "solver" && a.submission === id)
    : null;
  if (award)
    return {
      kind: "accepted",
      amount: award.amount,
      label: `Accepted · you earned ${displayUnits(award.amount)} AI$`,
    };
  const decided = feedback?.status === "ready" ? feedback.currentOutcome : null;
  // 2. The task names this submission as its winner (the award may sit past
  // the 12 most recent awards). The solver reward is the task's solver amount.
  if ((task && task.winner === id) || decided === "accepted") {
    const amount =
      task && UINT.test(task.solver_amount ?? "") ? task.solver_amount : null;
    return {
      kind: "accepted",
      ...(amount ? { amount } : {}),
      label: amount
        ? `Accepted · you earned ${displayUnits(amount)} AI$`
        : "Accepted · you earned the reward",
    };
  }
  if (decided === "rejected") return rejected(task);
  // S6 evidence journey: a revised original and a closed evidence window are
  // final for this submission, so a later task read never shows them rejected.
  const journey = feedback?.evidence?.kind ?? null;
  if (decided === "superseded" || journey === "revised" || revisedBy)
    return {
      kind: "superseded",
      label: "Replaced by your newer submission",
    };
  if (decided === "expired" || journey === "expired")
    return {
      kind: "expired",
      label: "Time ran out; the task is open again",
    };
  if (journey === "reassessment_pending")
    return {
      kind: "reassessment_pending",
      label: "The reviewer is looking again",
    };
  if (decided === "needs_evidence")
    return {
      kind: "needs_evidence",
      label:
        feedback?.evidence?.window?.open === true
          ? "More evidence needed · add it before the deadline"
          : feedback?.evidence?.window?.open === false
            ? "Time ran out · reopen the task"
            : "More evidence needed",
    };
  if (!settled) return networkStatus(intent);
  // 3. Recorded on the network: read the task, but only from a proof at or
  // after this submission's own record, so an older task read cannot pass for
  // a decision.
  const at = eventHeight(intent),
    seen = provenHeight(task);
  if (task && at !== null && seen !== null && seen >= at) {
    if (task.pending === id)
      return waiting("under_review", "Sent · being checked");
    if (task.winner && task.winner !== id)
      return {
        kind: "not_accepted",
        label: "Not accepted · another submission was accepted",
      };
    // Recorded, no longer pending and not the winner: the checker rejected it.
    return rejected(task);
  }
  if (intent.status === "proof_unavailable")
    return {
      kind: "proof_unavailable",
      label: "Sent earlier · confirming it again shortly",
    };
  return waiting("submitted", "Sent · waiting for the checker");
}

/** Why a review that has waited about 15 minutes or more is late, in plain words; null before that.
 * The reviewer usually decides in 2 to 10 minutes but checks at most 16 submissions an hour. */
export function reviewDelay(intent, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(intent?.sendAttemptedAt ?? intent?.createdAt ?? "")) / 60000);
  if (!Number.isFinite(minutes) || minutes < 15) return null;
  const waited = minutes >= 120 ? `${Math.floor(minutes / 60)} hours` : `${minutes} minutes`;
  return `Sent ${waited} ago and not reviewed yet. The reviewer starts at most 16 reviews in each clock hour (UTC), so when many submissions arrive together the rest wait for the next hour. Your submission stays recorded; do not send it again.`;
}

/** How many waiting submissions were sent before this one, from BAINK's public queue figure
 * (/api/public/review-queue), with the reviewer's hourly limit. An upper bound; no time is promised.
 * '' when the figure is not there. */
export function reviewQueueLine(queue, sentAt) {
  const perHour = queue?.limits?.perHour, perDay = queue?.limits?.perDay;
  if (!Number.isInteger(perHour) || !Number.isInteger(perDay)) return "";
  const cap = `up to ${perHour} start in each clock hour (UTC) and ${perDay} a day`, sent = Date.parse(sentAt ?? "");
  if (queue.status !== "available" || !Array.isArray(queue.waitingSince) || !Number.isFinite(sent))
    return `The reviewer starts at most ${perHour} reviews in each clock hour (UTC) and ${perDay} a day.`;
  const n = queue.waitingSince.filter((t) => Date.parse(t) < sent).length,
    more = queue.partial === true || queue.waiting > queue.waitingSince.length,
    checked = typeof queue.asOf === "string" ? ` Checked ${queue.asOf.slice(11, 16)} UTC.` : "";
  return `${n === 0 && !more ? "No review is ahead of yours" : `${more ? "At least" : "At most"} ${n} ${n === 1 ? "review is" : "reviews are"} ahead of yours`}; ${cap}${n >= perHour ? ", so yours may have to wait for the next hour" : ""}.${checked}`;
}

function rejected(task) {
  return {
    kind: "rejected",
    label:
      task?.state === "open_unfunded"
        ? "Not accepted · the task reopens when its manager funds it again"
        : "Not accepted by the checker",
  };
}

function networkStatus(i) {
  if (i?.status === "refused")
    return {
      kind: "refused",
      label: "Not accepted · nothing was sent",
    };
  if (i?.status === "proof_unavailable")
    return {
      kind: "proof_unavailable",
      label: "Sent earlier · confirming it again shortly",
    };
  if (i?.status === "accepted")
    return { kind: "waiting", label: "Sent · confirming…" };
  if (i?.status === "unknown")
    return { kind: "unknown", label: "Sent · use Check status to confirm it" };
  if (i?.status === "prepared")
    return { kind: "prepared", label: "Ready to sign · not sent yet" };
  // Never show a raw status code to the member.
  return {
    kind: String(i?.status ?? "unknown"),
    label: "Status not known yet · use Check status",
  };
}

/** Explanation shown on a task that is open but unfunded. */
export const UNFUNDED_TASK_TEXT =
  "Waiting for its project manager to fund and reopen it. It is not available for paid work yet; submissions open once the reward is reserved again.";

/**
 * Load the task list window. Tasks are listed oldest first, so newly opened
 * tasks sit at the end. Read the first page, then up to `tailPages` pages from
 * the end; the older pages between them load on "Show more tasks".
 * `fetchPage(cursor, limit)` returns the server page.
 */
export async function loadTaskWindow(
  fetchPage,
  { page = 12, tailPages = 4 } = {},
) {
  const first = await fetchPage("0", page);
  if (first === undefined) return undefined;
  const stamp = (data) =>
    (Array.isArray(data?.tasks) ? data.tasks : []).map((t) => ({
      ...t,
      provenAt: data?.proof?.height,
    }));
  let list = stamp(first);
  const total = UINT.test(String(first?.total ?? ""))
    ? BigInt(first.total)
    : 0n;
  const headEnd = UINT.test(String(first?.nextCursor ?? ""))
    ? BigInt(first.nextCursor)
    : 0n;
  let gapEnd = headEnd;
  if (first?.more === true && total > headEnd) {
    const span = BigInt(page * tailPages);
    const tailStart = total - span > headEnd ? total - span : headEnd;
    gapEnd = tailStart;
    for (let cursor = tailStart; cursor < total;) {
      const limit = Number(
        total - cursor < BigInt(page) ? total - cursor : BigInt(page),
      );
      const next = await fetchPage(String(cursor), limit);
      if (next === undefined) return undefined;
      list = merge(list, stamp(next));
      const after = UINT.test(String(next?.nextCursor ?? ""))
        ? BigInt(next.nextCursor)
        : total;
      if (after <= cursor) break;
      cursor = after;
    }
  }
  return {
    list,
    nextCursor: String(headEnd),
    gapEnd: String(gapEnd),
    more: headEnd < gapEnd,
    total: first?.total,
    active: first?.active === true,
  };
}

/** Load the next older page inside the gap left by `loadTaskWindow`. */
export async function loadOlderTasks(fetchPage, window, { page = 12 } = {}) {
  const from = BigInt(window.nextCursor),
    end = BigInt(window.gapEnd);
  if (from >= end) return window;
  const limit = Number(end - from < BigInt(page) ? end - from : BigInt(page));
  const data = await fetchPage(String(from), limit);
  if (data === undefined) return undefined;
  const added = (Array.isArray(data?.tasks) ? data.tasks : []).map((t) => ({
    ...t,
    provenAt: data?.proof?.height,
  }));
  const next = UINT.test(String(data?.nextCursor ?? ""))
    ? BigInt(data.nextCursor)
    : end;
  const cursor = next > end ? end : next;
  return {
    ...window,
    list: merge(window.list, added),
    nextCursor: String(cursor),
    more: cursor < end,
  };
}

/**
 * A refreshed window replaces the tasks it read; older tasks loaded by "Show
 * more" stay. The older-page cursor never moves backwards.
 */
export function mergeTaskWindow(previous, fresh) {
  if (!previous) return fresh;
  const list = merge(previous.list, fresh.list);
  const prevNext = BigInt(previous.nextCursor ?? "0"),
    end = BigInt(fresh.gapEnd);
  const nextCursor =
    prevNext > BigInt(fresh.nextCursor)
      ? prevNext < end
        ? prevNext
        : end
      : BigInt(fresh.nextCursor);
  return {
    ...fresh,
    list,
    nextCursor: String(nextCursor),
    more: nextCursor < end,
  };
}

function merge(list, rows) {
  const fresh = new Map(rows.map((t) => [t.id, t]));
  const kept = list.map((t) => fresh.get(t.id) ?? t);
  return [...kept, ...rows.filter((t) => !list.some((p) => p.id === t.id))];
}

/**
 * Every task open for work now, newest first, from the server's open-only
 * listing (`order=newest&state=open`, 10 November 2026). Each page scans a
 * bounded slice of the list, so this pages until the server says there is no
 * more, up to `maxPages`. `complete` is true only when the whole list was
 * scanned, so `count` is then exact.
 * `fetchOpenPage(cursor, limit)` returns the server page.
 */
export async function loadOpenTasks(fetchOpenPage, { page = 12, maxPages = 25 } = {}) {
  let cursor = "0", list = [], complete = false;
  for (let n = 0; n < maxPages; n++) {
    const data = await fetchOpenPage(cursor, page);
    if (data === undefined) return undefined;
    const rows = (Array.isArray(data?.tasks) ? data.tasks : []).map((t) => ({
      ...t,
      provenAt: data?.proof?.height,
    }));
    list = merge(list, rows);
    if (data?.more !== true) {
      complete = true;
      break;
    }
    const next = String(data?.nextCursor ?? "");
    if (!UINT.test(next) || BigInt(next) <= BigInt(cursor)) break;
    cursor = next;
  }
  return { list, complete, count: complete ? list.length : null };
}

/**
 * Add the open tasks to a task window. When the open list is complete, a task
 * the window kept from an earlier read that still looks open but is no longer
 * listed as open is dropped (it was taken or closed since), unless this read
 * of the window itself returned it.
 */
export function withOpenTasks(window, open, freshIds = null) {
  if (!window || !open) return window;
  const openIds = new Set(open.list.map((t) => t.id));
  const kept = open.complete
    ? window.list.filter((t) => !centralTaskOpen(t) || openIds.has(t.id) || freshIds?.has(t.id))
    : window.list;
  const fresh = new Map(open.list.map((t) => [t.id, t]));
  const list = [...kept.map((t) => fresh.get(t.id) ?? t), ...open.list.filter((t) => !kept.some((k) => k.id === t.id))];
  return { ...window, list, openCount: open.complete ? String(open.count) : null };
}
