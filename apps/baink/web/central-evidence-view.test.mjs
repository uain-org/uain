import test from "node:test";
import assert from "node:assert/strict";
import { evidenceJourney } from "../server/central-evidence.mjs";
import { evidenceView, blocksLeftText, evidenceActionPayload } from "./central-evidence-view.js";
import { reviewFeedbackView } from "./central-review-feedback.js";
import { submissionStatus } from "./central-submission-status.js";

const reviewer = "uain1" + "b".repeat(40), manager = "uain1" + "c".repeat(40);
const proof = { height: "1000", headerTime: "2026-11-10T12:00:00Z" };
const activation = { height: "10", windowBlocks: "129600" };
const t = { id: "CT-one" };
const asked = { status: "proved", record: { verdict: "needs_evidence", reviewer } };
const sub = (extra = {}) => ({ id: "CS-one", task: "CT-one", state: "under_review", ...extra });
const journey = (s, opts = {}) =>
  evidenceJourney({ s, t, review: asked, findings: ["Cite the cohort size."], activation, proof, help: { reviewer, manager }, ...opts });

test("an open reviewer request shows kind, findings, helpers, the deadline and the two actions", () => {
  const v = evidenceView(journey(sub({ evidence_request_height: "900", evidence_deadline: "130500" })), "CS-one");
  assert.equal(v.kind, "reviewer_request");
  assert.deepEqual(v.findings, ["Cite the cohort size."]);
  assert.equal(v.help.reviewer, reviewer);
  assert.equal(v.help.manager, manager);
  assert.equal(v.window.deadlineHeight, "130500");
  assert.equal(v.window.blocksLeft, "129500");
  assert.equal(v.window.open, true);
  assert.equal(v.window.deadlineEstimate, new Date(Date.parse(proof.headerTime) + 129500 * 2060).toISOString());
  assert.deepEqual(v.actions.map((a) => a.operation), ["central_submit", "central_reassess"]);
  assert.equal(v.actions[0].revises, "CS-one");
  assert.match(blocksLeftText(v.window.blocksLeft), /^about 2 days 23 hours$/);
});

test("before the window is switched on the request reads sensibly with no deadline and no action", () => {
  const v = evidenceView(journey(sub(), { activation: null }), "CS-one");
  assert.equal(v.kind, "reviewer_request");
  assert.equal(v.window, null);
  assert.deepEqual(v.actions, []);
  assert.match(v.note, /predates the evidence window/);
  // A pre-activation submission still under check by a service needs nothing.
  const s = evidenceView(evidenceJourney({ s: sub(), t, review: null, proof, activation: null }), "CS-one");
  assert.equal(s.kind, "verification_service");
  assert.equal(s.window, null);
});

test("a closed window offers only the fee-free expiry; reassessment pending offers nothing", () => {
  const closed = evidenceView(journey(sub({ evidence_deadline: "900" })), "CS-one");
  assert.equal(closed.window.open, false);
  assert.equal(closed.window.blocksLeft, "0");
  assert.deepEqual(closed.actions, [{ operation: "central_evidence_expire", submission: "CS-one" }]);
  const pending = evidenceView(journey(sub({ evidence_deadline: "130500", reassess: true })), "CS-one");
  assert.equal(pending.kind, "reassessment_pending");
  assert.deepEqual(pending.actions, []);
});

test("superseded and expired submissions become revised and expired journeys", () => {
  const revised = evidenceView(journey(sub({ state: "superseded", revised_by: "CS-two" })), "CS-one");
  assert.equal(revised.kind, "revised");
  assert.equal(revised.revisedBy, "CS-two");
  assert.deepEqual(revised.actions, []);
  const expired = evidenceView(journey(sub({ state: "expired", expired_height: "131000" })), "CS-one");
  assert.equal(expired.kind, "expired");
  assert.equal(expired.expiredAtHeight, "131000");
});

test("unknown kinds, foreign actions and actions outside the window never become display facts", () => {
  assert.equal(evidenceView(null, "CS-one"), null);
  assert.throws(() => evidenceView({ kind: "mint_now" }, "CS-one"));
  const e = journey(sub({ evidence_deadline: "130500" }));
  assert.throws(() => evidenceView({ ...e, actions: [{ operation: "central_reassess", payload: { submission: "CS-other" } }] }, "CS-one"));
  assert.throws(() => evidenceView({ ...e, actions: [{ operation: "central_review", payload: { submission: "CS-one" } }] }, "CS-one"));
  // Revise/reassess while the window says closed, or with no window: dropped.
  assert.deepEqual(evidenceView({ ...e, window: { ...e.window, open: false } }, "CS-one").actions.map((a) => a.operation), []);
  assert.deepEqual(evidenceView({ ...e, window: null }, "CS-one").actions, []);
  assert.equal(evidenceView({ kind: "unavailable" }, "CS-one").kind, "unavailable");
});

test("action payloads are exact and a revision never revises itself", () => {
  assert.deepEqual(evidenceActionPayload("central_reassess", { submission: "CS-one" }), { submission: "CS-one" });
  assert.deepEqual(evidenceActionPayload("central_evidence_expire", { submission: "CS-one" }), { submission: "CS-one" });
  const digest = "a".repeat(64);
  assert.deepEqual(
    evidenceActionPayload("central_submit", { submission: "CS-one", task: "CT-one", id: "CS-two", evidence: "x", evidence_digest: digest }),
    { id: "CS-two", task: "CT-one", evidence: "x", evidence_digest: digest, revises: "CS-one" },
  );
  assert.throws(() => evidenceActionPayload("central_submit", { submission: "CS-one", task: "CT-one", id: "CS-one", evidence: "x", evidence_digest: digest }));
  assert.throws(() => evidenceActionPayload("central_review", { submission: "CS-one" }));
});

test("the verified feedback read accepts superseded and expired outcomes and carries the journey", async () => {
  const { fixture, expected } = await import("./central-review-feedback.fixture.mjs");
  for (const state of ["superseded", "expired"]) {
    const d = fixture();
    d.outcome = state;
    d.submission.state = state;
    d.evidence = state === "expired" ? { kind: "expired", message: "closed", help: {} } : { kind: "revised", message: "revised", revisedBy: "CS-two", help: {} };
    const view = await reviewFeedbackView(d, expected);
    assert.equal(view.status, "ready");
    assert.equal(view.currentOutcome, state);
    assert.equal(view.historical, true);
    assert.equal(view.evidence.kind, state === "expired" ? "expired" : "revised");
  }
  const d = fixture();
  d.feedback = { available: false };
  d.evidence = { kind: "reviewer_request", message: "more please", found: null, help: {}, window: null, actions: [], note: "predates" };
  const v = await reviewFeedbackView(d, expected);
  assert.equal(v.status, "unavailable");
  assert.equal(v.evidence.kind, "reviewer_request");
  // A malformed journey is dropped, the verified feedback still shows.
  const bad = fixture();
  bad.evidence = { kind: "mint_now" };
  assert.equal((await reviewFeedbackView(bad, expected)).evidence, undefined);
});

test("submission status shows revised, expired, reassessment and the deadline instead of 'rejected'", () => {
  const intent = { status: "finalized", finalized: true, result: { verified: true }, sendAttemptedAt: "x", receipt: { event: { height: "100" } }, command: { operation: "central_submit", payload: { id: "CS-one", task: "CT-one" } } };
  const task = { id: "CT-one", state: "under_review", pending: "CS-two", winner: "", provenAt: "200" };
  assert.equal(submissionStatus(intent, { task }).kind, "rejected"); // the old reading
  assert.equal(submissionStatus(intent, { task, revisedBy: true }).kind, "superseded");
  assert.equal(submissionStatus(intent, { task, feedback: { status: "ready", currentOutcome: "superseded" } }).kind, "superseded");
  assert.equal(submissionStatus(intent, { task: { ...task, state: "open", pending: "" }, feedback: { status: "unavailable", currentOutcome: "expired", evidence: { kind: "expired" } } }).kind, "expired");
  assert.equal(submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "needs_evidence", evidence: { kind: "reassessment_pending" } } }).kind, "reassessment_pending");
  assert.match(submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "needs_evidence", evidence: { kind: "reviewer_request", window: { open: true } } } }).label, /add it before the deadline/);
  assert.match(submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "needs_evidence", evidence: { kind: "reviewer_request", window: null } } }).label, /^More evidence needed$/);
  const reassess = { ...intent, command: { operation: "central_reassess", payload: { submission: "CS-one" } } };
  assert.equal(submissionStatus(reassess).kind, "recorded");
  assert.equal(submissionStatus({ ...reassess, finalized: false, result: null, status: "unknown" }).kind, "unknown");
});

test("member-facing step labels stay plain: no internal terms (Rahul, 10 Nov)", () => {
  const intent = { status: "finalized", finalized: true, result: { verified: true }, sendAttemptedAt: "x", receipt: { event: { height: "100" } }, command: { operation: "central_submit", payload: { id: "CS-one", task: "CT-one" } } };
  assert.equal(submissionStatus(intent, { revisedBy: true }).label, "Replaced by your newer submission");
  assert.equal(submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "expired" } }).label, "Time ran out; the task is open again");
  const labels = [
    submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "needs_evidence", evidence: { kind: "reviewer_request", window: { open: true } } } }).label,
    submissionStatus(intent, { feedback: { status: "ready", currentOutcome: "needs_evidence", evidence: { kind: "reassessment_pending" } } }).label,
    submissionStatus({ ...intent, command: { operation: "central_reassess", payload: { submission: "CS-one" } } }).label,
    submissionStatus({ ...intent, command: { operation: "central_evidence_expire", payload: { submission: "CS-one" } } }).label,
  ];
  for (const l of labels) assert.doesNotMatch(l, /native|central|attest|supersed|epoch|reassess|expire/i, l);
});
