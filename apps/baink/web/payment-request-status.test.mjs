import test from "node:test";
import assert from "node:assert/strict";
import { paymentLocksFrom, paymentLocksFromRequests, requestRowView, PAYMENT_REQUEST_LOCKED_TEXT } from "./payment-request-status.js";

const me = "uain1" + "a".repeat(40), them = "uain1" + "b".repeat(40);
const request = { id: "R1", status: "open", to: me, from: them, trade: { proposal: {} } };

test("a request with a payment under way reads Payment in progress, with no Pay or Decline", () => {
  const locks = paymentLocksFrom([{ id: "P1", requestId: "R1", status: "awaiting-agreement", updatedAt: "2026-11-09T01:00:00Z" }]);
  const row = requestRowView(request, { address: me, locks });
  assert.equal(row.badge, "Payment in progress");
  assert.deepEqual(row.actions, ["open-payment"]);
  assert.match(row.note, /waiting for both agreements/);
  const payee = requestRowView(request, { address: them, locks });
  assert.deepEqual(payee.actions, ["open-payment"]);
  assert.match(payee.note, /you confirm it/);
});

test("an open request without a payment stays Pending · Review & pay", () => {
  const row = requestRowView(request, { address: me, locks: paymentLocksFrom([]) });
  assert.deepEqual([row.badge, row.payLabel, row.actions], ["Pending", "Review & pay", ["pay", "decline"]]);
  assert.deepEqual(requestRowView(request, { address: them }).actions, ["cancel"]);
});

test("abandoned payments do not lock; the newest live payment names the stage", () => {
  const locks = paymentLocksFrom([
    { id: "P1", requestId: "R1", status: "abandoned", updatedAt: "2026-11-09T03:00:00Z" },
    { id: "P2", requestId: "R1", status: "awaiting-agreement", updatedAt: "2026-11-09T01:00:00Z" },
    { id: "P3", requestId: "R1", status: "ledger-recorded", updatedAt: "2026-11-09T02:00:00Z" },
    { id: "P4", requestId: null, status: "awaiting-agreement" },
  ]);
  assert.equal(locks.size, 1);
  assert.equal(locks.get("R1").id, "P3");
  assert.equal(paymentLocksFrom([{ id: "P1", requestId: "R1", status: "abandoned" }]).size, 0);
  assert.equal(paymentLocksFrom(undefined).size, 0);
});

test("a closed request keeps its own status", () => {
  assert.equal(requestRowView({ ...request, status: "paid" }, { address: me }).badge, "Paid");
  assert.equal(requestRowView({ ...request, status: "paid" }, { address: me }).tone, "paid");
  // A status the web does not know is never shown raw.
  assert.equal(requestRowView({ ...request, status: "weird_code" }, { address: me }).badge, "Closed");
  assert.match(PAYMENT_REQUEST_LOCKED_TEXT, /already in progress/);
});

test("locks come from the payment the server projects on /api/requests rows", () => {
  const all = [
    { id: "R1", status: "open", from: "uain1payee", to: "uain1payer", payment: { locked: true, source: "send", id: "S1", stage: "awaiting-signature", updatedAt: "2026-11-10T01:00:00Z" } },
    { id: "R2", status: "open", payment: null },
    { id: "R3", status: "paid", payment: { locked: true, stage: "finalized" } },
  ];
  const incoming = [{ ...all[0], payment: { ...all[0].payment, stage: "accepted", updatedAt: "2026-11-10T00:00:00Z" } }];
  const locks = paymentLocksFromRequests(all, incoming, undefined);
  assert.deepEqual([...locks.keys()], ["R1"]);
  assert.equal(locks.get("R1").status, "awaiting-signature");
  const payer = requestRowView(all[0], { address: "uain1payer", locks });
  assert.equal(payer.badge, "Payment in progress");
  assert.deepEqual(payer.actions, ["open-payment"]);
  assert.match(payer.note, /waiting for the payer's signature/);
  assert.equal(requestRowView(all[1], { address: "uain1payer", locks }).badge, "Pending");
});
