/**
 * "What can I do now?" for the first screen after sign-in (Rahul, 10 November
 * 2026: the system must feel simple). Three plain lines (anything waiting on
 * you, tasks you can take, your contribution points) and exactly one primary
 * next action, chosen in this order: evidence to add before a deadline, a
 * request to pay, a task to take. Presentation only; every screen it points to
 * re-checks its own facts.
 */
import { displayUnits } from "./exact-amount.js";

const UINT = /^(0|[1-9][0-9]*)$/;
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * @param {object} facts
 * @param {number|null} facts.openTasks tasks the member can take now (null while unknown)
 * @param {boolean} facts.openPartial true when not every task was read, so openTasks is a minimum
 * @param {number|null} facts.toPay open incoming requests with no payment under way
 * @param {number|null} facts.evidence own submissions waiting for more evidence before their deadline
 * @param {number|null} facts.points contribution points (Karma), or null while unknown; leads over AI$ (12 November 2026)
 * @param {string|null} facts.earned AI$ units earned so far (string of digits), or null while unknown
 * @param {boolean} facts.earningLive paid tasks are open on this site
 * @param {boolean} facts.needsJoin the member has not joined UAIN yet (or waits for approval)
 * @returns {{items: Array<{key: string, text: string, tab: string}>, primary: {label: string, tab: string}|null}}
 */
export function nextStepsView({ openTasks = null, openPartial = false, toPay = null, evidence = null, points = null, earned = null, earningLive = false, needsJoin = false } = {}) {
  const items = [];
  let primary = null;
  if (needsJoin) {
    items.push({ key: "join", tab: "Security", text: "Join UAIN to take paid tasks and see your balance. It is free and takes one signature." });
    primary = { label: "Join UAIN", tab: "Security" };
  }
  const ev = count(evidence), pay = count(toPay), open = count(openTasks);
  if (ev > 0) {
    items.push({ key: "evidence", tab: "Mine money", text: `${ev} of your answers ${plural(ev, "needs", "need")} more evidence before the deadline.` });
    primary ??= { label: "Add the evidence", tab: "Mine money" };
  }
  if (pay > 0) {
    items.push({ key: "pay", tab: "Incoming requests", text: `${pay} payment ${plural(pay, "request is", "requests are")} waiting for you.` });
    primary ??= { label: pay === 1 ? "Review the request" : "Review the requests", tab: "Incoming requests" };
  }
  if (!earningLive) items.push({ key: "tasks", tab: "Mine money", text: "Paid tasks are not open yet." });
  else if (open === null) items.push({ key: "tasks", tab: "Mine money", text: "Checking which paid tasks you can take…" });
  else if (open > 0) {
    items.push({ key: "tasks", tab: "Mine money", text: `${openPartial ? "At least " : ""}${open} paid ${plural(open, "task", "tasks")} you can take now.` });
    primary ??= { label: "Take a paid task", tab: "Mine money" };
  } else items.push({ key: "tasks", tab: "Mine money", text: "No paid task is open right now. New ones open when a project manager funds them." });
  // Contribution points (Karma) lead; AI$ earned is a ledger fact shown on the earnings screen
  // (P0-3 contract). The AI$ line is kept only for when the points cannot be read.
  const pts = count(points);
  if (pts !== null)
    items.push({ key: "earned", tab: "Mine money", text: pts === 0 ? "You have no contribution points yet; each accepted answer adds them." : `You have ${pts} contribution ${plural(pts, "point", "points")} (Karma) so far.` });
  else if (typeof earned === "string" && UINT.test(earned))
    items.push({ key: "earned", tab: "Mine money", text: earned === "0" ? "You have not earned AI$ yet." : `You have earned ${displayUnits(earned)} AI$ so far.` });
  if (ev === 0 && pay === 0 && !needsJoin && !items.some((i) => i.key === "pay" || i.key === "evidence"))
    items.unshift({ key: "waiting", tab: null, text: "Nothing is waiting on you." });
  return { items, primary };
}
