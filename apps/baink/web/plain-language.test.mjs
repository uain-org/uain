// Plain-language guard (Rahul, 10 Nov 2026: "the system needs to feel simple
// to the user"). The holder was removed in BAINK 0.3.54: members install
// nothing, so no screen may tell them to pair, install or run a wallet.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sendStatus } from "./server-send.js";
import { requestStatusLabel } from "./payment-request-status.js";

const dir = new URL("./", import.meta.url);
const sources = readdirSync(dir).filter((f) => /\.(jsx|js)$/.test(f) && !f.endsWith(".test.mjs"));
const text = Object.fromEntries(sources.map((f) => [f, readFileSync(new URL(f, dir), "utf8")]));

test("no screen mentions a paired, local or device wallet, a Linux/macOS requirement or installing a worker", () => {
  for (const [file, src] of Object.entries(text))
    for (const banned of [/paired(,| ) ?(funded )?wallet/i, /local wallet/i, /old device wallet/i, /Linux (or macOS|native binary)/i, /installed native worker/i, /shield it into your private wallet/i, /your wallet builds/i])
      assert.doesNotMatch(src, banned, `${file}: ${banned}`);
});

test("a send or request status the web does not know is never shown raw", () => {
  const s = sendStatus({ intent: { from: "a" }, status: "weird_new_status" }, "a");
  assert.equal(s.label, "Checking");
  assert.doesNotMatch(s.label + s.detail, /weird_new_status/);
  assert.equal(requestStatusLabel("weird_new_status"), "Closed");
  assert.equal(requestStatusLabel("declined"), "Declined");
});

test("deal, milestone, dispute and refund codes read as plain words, never raw", async () => {
  const m = await import("./plain-labels.js");
  assert.equal(m.dealPaymentLabel("open"), "Waiting for payment");
  assert.equal(m.milestoneLabel("delivered"), "Delivered, waiting for the buyer");
  assert.equal(m.milestoneLabel("confirmed"), "Accepted");
  assert.equal(m.disputeLabel("appealed"), "Appealed");
  assert.equal(m.outcomeLabel("partial-refund"), "A partial refund");
  assert.equal(m.refundSourceLabel("mutual-cancel"), "Agreed cancellation");
  for (const f of [m.dealPaymentLabel, m.milestoneLabel, m.disputeLabel, m.outcomeLabel, m.refundSourceLabel]) assert.doesNotMatch(f("zz_raw_code"), /zz_raw_code/);
});

test("history rows read as one plain sentence; dispute decisions in plain words", async () => {
  const m = await import("./plain-labels.js");
  const me = "uain1me", them = "uain1them";
  assert.equal(m.historyText({ type: "request.created", from: me, to: them, amount: "5" }, me), "You asked uain1them for 5 AI$");
  assert.equal(m.historyText({ type: "request.paid", from: them, to: me, amount: "5" }, me), "You paid uain1them's request for 5 AI$");
  assert.equal(m.historyText({ type: "request.declined", from: me, to: them, amount: "2" }, me), "uain1them declined your request for 2 AI$");
  assert.equal(m.historyText({ type: "something.raw" }, me), "Account activity");
  assert.equal(m.decisionLabel("refund-partial"), "Partial refund to the buyer");
  assert.doesNotMatch(m.decisionLabel("zz_raw"), /zz_raw/);
});

test("Trade asks for a dispute outcome from a list and appeals inline, never with a browser pop-up", () => {
  const src = text["TradeDeals.jsx"];
  assert.doesNotMatch(src, /window\.prompt/);
  assert.match(src, /OUTCOME_CHOICES/);
  assert.match(src, /More options/);
});
