import test from "node:test";
import assert from "node:assert/strict";
import { nextStepsView } from "./next-steps.js";

test("one primary action: evidence first, then a request to pay, then a task to take", () => {
  assert.deepEqual(nextStepsView({ earningLive: true, openTasks: 3, toPay: 1, evidence: 1, earned: "0" }).primary, { label: "Add the evidence", tab: "Mine money" });
  assert.deepEqual(nextStepsView({ earningLive: true, openTasks: 3, toPay: 2, evidence: 0 }).primary, { label: "Review the requests", tab: "Incoming requests" });
  assert.deepEqual(nextStepsView({ earningLive: true, openTasks: 3, toPay: 0, evidence: 0 }).primary, { label: "Take a paid task", tab: "Mine money" });
  assert.equal(nextStepsView({ earningLive: true, openTasks: 0, toPay: 0, evidence: 0 }).primary, null);
});

test("lines read plainly: what waits on you, tasks you can take, what you earned", () => {
  const v = nextStepsView({ earningLive: true, openTasks: 1, toPay: 0, evidence: 0, earned: "20000000" });
  assert.deepEqual(v.items.map((i) => i.text), ["Nothing is waiting on you.", "1 paid task you can take now.", "You have earned 20 AI$ so far."]);
  assert.match(nextStepsView({ earningLive: true, openTasks: 2, openPartial: true }).items.find((i) => i.key === "tasks").text, /^At least 2 paid tasks/);
  assert.match(nextStepsView({ earningLive: false }).items.find((i) => i.key === "tasks").text, /not open yet/);
  assert.match(nextStepsView({ earningLive: true, openTasks: null }).items.find((i) => i.key === "tasks").text, /Checking/);
});

test("a member who has not joined is led to Join UAIN first", () => {
  const v = nextStepsView({ earningLive: true, openTasks: 3, needsJoin: true });
  assert.deepEqual(v.primary, { label: "Join UAIN", tab: "Security" });
  assert.equal(v.items[0].key, "join");
});

test("no internal terms reach the member", () => {
  const all = [nextStepsView({ earningLive: true, openTasks: 2, toPay: 2, evidence: 2, earned: "5" }), nextStepsView({}), nextStepsView({ earningLive: true, openTasks: 0, earned: "0" })]
    .flatMap((v) => [...v.items.map((i) => i.text), v.primary?.label ?? ""]).join("\n");
  assert.doesNotMatch(all, /native|central|proof|ledger|holder|wallet|licence|intent/i);
});

// 12 November 2026 (P0-3 contract): contribution points lead the first screen; AI$ only when points are unknown.
test("the first screen shows contribution points, not AI$, when the points are known", () => {
  const with50 = nextStepsView({ earningLive: true, openTasks: 0, points: 50, earned: "50000000" });
  assert.equal(with50.items.find((i) => i.key === "earned").text, "You have 50 contribution points (Karma) so far.");
  assert.doesNotMatch(with50.items.map((i) => i.text).join("\n"), /AI\$/);
  assert.equal(nextStepsView({ points: 1 }).items.find((i) => i.key === "earned").text, "You have 1 contribution point (Karma) so far.");
  assert.equal(nextStepsView({ points: 0, earned: "0" }).items.find((i) => i.key === "earned").text, "You have no contribution points yet; each accepted answer adds them.");
  assert.equal(nextStepsView({ points: null, earned: "20000000" }).items.find((i) => i.key === "earned").text, "You have earned 20 AI$ so far.", "points unknown: the ledger line");
  assert.equal(nextStepsView({ points: -1, earned: null }).items.find((i) => i.key === "earned"), undefined);
});
