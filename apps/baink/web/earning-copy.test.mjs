import test from "node:test";
import assert from "node:assert/strict";
import { overviewEarningStep, overviewNote, overviewStepsSummary, paidWorkText, PAID_WORK_NOTE } from "./earning-copy.js";
import { UNFUNDED_TASK_TEXT } from "./central-submission-status.js";

const all = (earningLive) => [
  overviewEarningStep({ earningLive }).text, overviewEarningStep({ earningLive }).badge,
  overviewNote({ earningLive }), overviewStepsSummary({ earningLive }),
  paidWorkText(null), paidWorkText(0), paidWorkText(2), paidWorkText(2, { partial: true }), PAID_WORK_NOTE,
].join("\n");

test("with central earning on, the Overview says earning is live, not 'Not live yet'", () => {
  const step = overviewEarningStep({ earningLive: true });
  assert.equal(step.badge, "Ready");
  assert.doesNotMatch(all(true), /not live yet|transfers are not|No funded tasks/i);
  assert.match(step.text, /in this browser/);
});

test("copy makes no schedule or duration promise", () => {
  for (const live of [true, false])
    assert.doesNotMatch(all(live), /under an hour|15 minutes|within \d+ minutes|fewer than three/i);
});

test("copy says everything works in the browser; no wallet, holder, install or OS requirement (holder removed in 0.3.54)", () => {
  for (const live of [true, false]) {
    assert.doesNotMatch(all(live), /local wallet|holder|Linux|macOS|paired|install a|download/i);
    assert.match(all(live), /in this browser/);
  }
  assert.match(PAID_WORK_NOTE, /nothing to install/);
  assert.match(paidWorkText(2, { partial: true }), /^At least 2 you can take now/);
});

test("copy uses no internal terms", () => {
  for (const live of [true, false]) assert.doesNotMatch(all(live), /native|central|ledger verification|deployment|proof/i);
});

test("public copy never says 'AI agents' on its own", () => {
  assert.doesNotMatch(all(true) + all(false) + UNFUNDED_TASK_TEXT, /AI agents/i);
});

test("an unfunded task says it waits for its manager and is not available for paid work", () => {
  assert.match(UNFUNDED_TASK_TEXT, /project manager to fund and reopen it/);
  assert.match(UNFUNDED_TASK_TEXT, /not available for paid work yet/);
});
