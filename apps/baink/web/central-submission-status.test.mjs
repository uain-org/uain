import test from "node:test";
import assert from "node:assert/strict";
import {
  submissionStatus, settledIntent, outstandingIntent,
  loadTaskWindow, loadOlderTasks, mergeTaskWindow, loadOpenTasks, withOpenTasks, reviewDelay, reviewQueueLine,
} from "./central-submission-status.js";

const submit = (id, extra = {}) => ({
  id: `intent-${id}`, status: "finalized", finalized: true, result: { verified: true },
  sendAttemptedAt: "2026-11-09T01:00:00Z",
  receipt: { event: { height: "100" }, state_height: "101" },
  command: { operation: "central_submit", payload: { id, task: "T1" } },
  ...extra,
});
const task = (extra = {}) => ({ id: "T1", state: "open", pending: "", winner: "", solver_amount: "200000000", provenAt: "150", ...extra });

test("an awarded submission shows Accepted · Awarded N AI$, never 'not earned until accepted'", () => {
  const awards = [{ role: "solver", submission: "CS-1", amount: "200000000", task: "T1" }];
  const s = submissionStatus(submit("CS-1"), { awards, task: task({ state: "accepted", winner: "CS-1" }) });
  assert.equal(s.kind, "accepted");
  assert.equal(s.label, "Accepted · you earned 200 AI$");
  assert.doesNotMatch(s.label, /not earned/);
});

test("a checker award for the same member never counts as the solver award", () => {
  const awards = [{ role: "reviewer", submission: "CS-1", amount: "1000000", task: "T1" }];
  const s = submissionStatus(submit("CS-1"), { awards, task: task({ pending: "CS-1", state: "under_review" }) });
  assert.equal(s.kind, "under_review");
});

test("the task winner marks the submission awarded when the award is past the recent list", () => {
  const s = submissionStatus(submit("CS-1"), { awards: [], task: task({ state: "accepted", winner: "CS-1" }) });
  assert.deepEqual([s.kind, s.label], ["accepted", "Accepted · you earned 200 AI$"]);
});

test("a final rejection shows Rejected, and explains an unfunded task", () => {
  assert.equal(submissionStatus(submit("CS-1"), { task: task() }).kind, "rejected");
  const unfunded = submissionStatus(submit("CS-1"), { task: task({ state: "open_unfunded" }) });
  assert.equal(unfunded.kind, "rejected");
  assert.match(unfunded.label, /reopens when its manager funds it again/);
  const other = submissionStatus(submit("CS-1"), { task: task({ state: "accepted", winner: "CS-9" }) });
  assert.equal(other.kind, "not_accepted");
});

test("a task read older than the submission's record is never taken as a decision", () => {
  const s = submissionStatus(submit("CS-1"), { task: task({ provenAt: "99" }) });
  assert.equal(s.kind, "submitted");
  assert.equal(submissionStatus(submit("CS-1"), { task: task({ provenAt: undefined }) }).kind, "submitted");
  assert.equal(submissionStatus(submit("CS-1"), { task: task({ pending: "CS-1", state: "under_review" }) }).kind, "under_review");
});

test("checker feedback sets Needs evidence, Rejected or Accepted", () => {
  const ready = (currentOutcome) => ({ status: "ready", currentOutcome });
  assert.equal(submissionStatus(submit("CS-1"), { task: task({ pending: "CS-1" }), feedback: ready("needs_evidence") }).kind, "needs_evidence");
  assert.equal(submissionStatus(submit("CS-1"), { feedback: ready("rejected") }).kind, "rejected");
  assert.equal(submissionStatus(submit("CS-1"), { feedback: ready("accepted") }).label, "Accepted · you earned the reward");
  assert.equal(submissionStatus(submit("CS-1"), { feedback: { status: "unavailable" } }).kind, "submitted");
});

test("a recorded receipt that can't be re-checked right now neither counts as pending nor blocks resubmission", () => {
  const historical = submit("CS-1", { status: "proof_unavailable", finalized: false, historicalReceipt: false, receiptRequired: true });
  assert.equal(settledIntent(historical), true);
  assert.equal(outstandingIntent(historical), false);
  assert.equal(submissionStatus(historical, { task: task() }).kind, "rejected");
  assert.equal(submissionStatus(historical, {}).kind, "proof_unavailable");
  // A step that was only sent is still outstanding.
  const sentOnly = submit("CS-2", { status: "unknown", finalized: false });
  assert.equal(outstandingIntent(sentOnly), true);
  assert.equal(outstandingIntent({ ...sentOnly, status: "refused" }), false);
});

test("joins keep their own labels", () => {
  const join = { status: "finalized", finalized: true, result: { verified: true }, command: { operation: "project_join", payload: { project: "P" } } };
  assert.equal(submissionStatus(join, {}).label, "Joined the project");
  assert.equal(submissionStatus({ ...join, finalized: false, status: "prepared" }, {}).kind, "prepared");
});

// A fake server: tasks oldest first, numeric cursors, at most 12 per page.
function server(count, openAt = new Set()) {
  const calls = [];
  const fetchPage = async (cursor, limit) => {
    calls.push([cursor, limit]);
    const from = Number(cursor), to = Math.min(count, from + limit);
    const tasks = [];
    for (let n = from + 1; n <= to; n++) tasks.push({ id: `T${n}`, state: openAt.has(n) ? "open" : "accepted" });
    return { tasks, nextCursor: String(to), more: to < count, total: String(count), active: true, proof: { height: "500" } };
  };
  return { fetchPage, calls };
}

test("the first load reaches the newest open tasks however many older tasks exist", async () => {
  const { fetchPage, calls } = server(70, new Set([70]));
  const w = await loadTaskWindow(fetchPage);
  assert.ok(w.list.some((t) => t.id === "T70" && t.state === "open"), "the newest open task is listed");
  assert.equal(w.list.length, 12 + 48);
  assert.equal(calls.length, 5);
  assert.equal(w.more, true);
  assert.equal(w.list.find((t) => t.id === "T70").provenAt, "500");
  // "Show more" fills the gap between the first page and the newest pages.
  let older = await loadOlderTasks(fetchPage, w);
  assert.equal(older.list.length, 70);
  assert.equal(older.more, false);
});

test("a short list is read once", async () => {
  const { fetchPage, calls } = server(7);
  const w = await loadTaskWindow(fetchPage);
  assert.equal(w.list.length, 7);
  assert.equal(calls.length, 1);
  assert.equal(w.more, false);
});

test("a refreshed window keeps older tasks already shown and picks up new ones", async () => {
  const s1 = server(70);
  const first = await loadOlderTasks(s1.fetchPage, await loadTaskWindow(s1.fetchPage));
  const s2 = server(71, new Set([71]));
  const merged = mergeTaskWindow(first, await loadTaskWindow(s2.fetchPage));
  assert.equal(merged.list.length, 71);
  assert.ok(merged.list.some((t) => t.id === "T71" && t.state === "open"));
});

test("open tasks load newest first through every bounded open-only page and give an exact count", async () => {
  const pages = {
    "0": { tasks: [task({ id: "T60" })], more: true, nextCursor: "48", proof: { height: "9" } },
    "48": { tasks: [task({ id: "T20" })], more: false, nextCursor: "60", proof: { height: "9" } },
  };
  const calls = [];
  const open = await loadOpenTasks(async (cursor, limit) => { calls.push([cursor, limit]); return pages[cursor]; });
  assert.deepEqual(calls, [["0", 12], ["48", 12]]);
  assert.deepEqual(open.list.map((t) => t.id), ["T60", "T20"]);
  assert.equal(open.complete, true);
  assert.equal(open.count, 2);
  assert.equal(open.list[0].provenAt, "9");
  const capped = await loadOpenTasks(async () => pages["0"], { maxPages: 1 });
  assert.equal(capped.complete, false);
  assert.equal(capped.count, null);
});

test("open tasks join the window; a stale open row from an earlier read is dropped once the open list is complete", () => {
  const window = { list: [task({ id: "T1", state: "accepted", winner: "CS-x" }), task({ id: "T5" }), task({ id: "T9" })], more: true };
  const open = { list: [task({ id: "T9" }), task({ id: "T60" })], complete: true, count: 2 };
  const joined = withOpenTasks(window, open, new Set(["T1"]));
  assert.deepEqual(joined.list.map((t) => t.id), ["T1", "T9", "T60"]);
  assert.equal(joined.openCount, "2");
  // Not complete: nothing is dropped and there is no count.
  const partial = withOpenTasks(window, { ...open, complete: false, count: null });
  assert.deepEqual(partial.list.map((t) => t.id), ["T1", "T5", "T9", "T60"]);
  assert.equal(partial.openCount, null);
  assert.equal(withOpenTasks(window, null), window);
});

test("no step label shows a raw status code or internal term", () => {
  const labels = ["prepared", "accepted", "unknown", "refused", "proof_unavailable", "broadcasting", "weird-new-status"].map((status) =>
    submissionStatus({ status, sendAttemptedAt: status === "prepared" ? null : "x", command: { operation: "central_submit", payload: { id: "CS-1", task: "T1" } } }).label);
  for (const l of labels) assert.doesNotMatch(l, /weird-new-status|proof|native|network record|broadcast|intent/i, l);
});

test("a review that has waited about 15 minutes says it is delayed and why; before that it does not", () => {
  const at = Date.parse("2026-11-10T12:00:00Z"), sent = (m) => ({ sendAttemptedAt: new Date(at - m * 60000).toISOString() });
  const checking = { task: task({ pending: "CS-1", state: "under_review" }) };
  let s = submissionStatus(submit("CS-1", sent(5)), { ...checking, now: at });
  assert.deepEqual(s, { kind: "under_review", label: "Sent · being checked" });
  s = submissionStatus(submit("CS-1", sent(36)), { ...checking, now: at });
  assert.equal(s.kind, "under_review"); assert.equal(s.label, "Sent · review delayed"); assert.equal(s.delayed, true);
  assert.match(s.detail, /^Sent 36 minutes ago and not reviewed yet\. The reviewer starts at most 16 reviews in each clock hour \(UTC\)/);
  assert.match(s.detail, /do not send it again\.$/);
  assert.match(reviewDelay(sent(90), at), /the rest wait for the next hour/);
  assert.equal(reviewDelay({}, at), null, "an unknown time never claims a delay");
  // Recorded but the task read is older than the submission: still honest about the wait.
  s = submissionStatus(submit("CS-1", sent(40)), { now: at });
  assert.equal(s.kind, "submitted"); assert.equal(s.label, "Sent · review delayed");
  // A decided submission never reads as delayed.
  const awards = [{ role: "solver", submission: "CS-1", amount: "200000000", task: "T1" }];
  assert.equal(submissionStatus(submit("CS-1", sent(400)), { awards, task: task({ state: "accepted", winner: "CS-1" }), now: at }).delayed, undefined);
});

test("the queue line says how many reviews are ahead and the hourly limit, and never promises a time", () => {
  const limits = { perHour: 16, perDay: 128 }, at = (m) => `2026-11-10T08:${String(m).padStart(2, "0")}:00.000Z`;
  const queue = { status: "available", waiting: 3, waitingSince: [at(1), at(5), at(9)], limits, asOf: "2026-11-10T09:05:10.000Z" };
  assert.equal(reviewQueueLine(queue, at(9)), "At most 2 reviews are ahead of yours; up to 16 start in each clock hour (UTC) and 128 a day. Checked 09:05 UTC.");
  assert.equal(reviewQueueLine(queue, at(1)), "No review is ahead of yours; up to 16 start in each clock hour (UTC) and 128 a day. Checked 09:05 UTC.");
  const long = { ...queue, waiting: 20, waitingSince: Array.from({ length: 20 }, (_, n) => at(n)) };
  assert.match(reviewQueueLine(long, at(30)), /^At most 20 reviews are ahead of yours; .* so yours may have to wait for the next hour\./);
  assert.match(reviewQueueLine({ ...queue, partial: true }, at(9)), /^At least 2 reviews are ahead of yours/);
  assert.equal(reviewQueueLine({ status: "unavailable", limits }, at(9)), "The reviewer starts at most 16 reviews in each clock hour (UTC) and 128 a day.");
  assert.equal(reviewQueueLine(null, at(9)), "");
  for (const text of [reviewQueueLine(queue, at(9)), reviewQueueLine(long, at(30))]) assert.doesNotMatch(text, /within \d+ minutes|by \d\d:\d\d|will be reviewed/);
});
