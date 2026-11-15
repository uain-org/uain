/**
 * How a payment request row reads, joined to the private payment that may
 * already be under way for it. The server keeps a request `open` until the
 * recipient confirms the payment, and refuses a second payment with
 * `payment_request_locked` while one exists (any payment for the request that
 * was not abandoned). Presentation only; the server stays the authority.
 */

/** A request's closed status in plain words; never a raw code. */
export function requestStatusLabel(status) {
  return (
    { open: "Waiting for payment", paid: "Paid", declined: "Declined", cancelled: "Cancelled", expired: "Expired" }[status] ??
    "Closed"
  );
}

/** requestId -> the newest payment for it that still locks the request. */
export function paymentLocksFrom(intents) {
  const locks = new Map();
  for (const i of Array.isArray(intents) ? intents : []) {
    if (
      !i ||
      typeof i.requestId !== "string" ||
      !i.requestId ||
      i.status === "abandoned"
    )
      continue;
    const before = locks.get(i.requestId);
    if (
      !before ||
      String(i.updatedAt ?? i.createdAt ?? "") >
        String(before.updatedAt ?? before.createdAt ?? "")
    )
      locks.set(i.requestId, {
        id: i.id,
        status: i.status,
        updatedAt: i.updatedAt ?? i.createdAt ?? null,
      });
  }
  return locks;
}

/**
 * requestId -> the payment that locks it, read from the `payment` field the
 * server projects on each `/api/requests` row (10 November 2026). Replaces
 * joining `/api/native/payments` on the client.
 */
export function paymentLocksFromRequests(...lists) {
  const locks = new Map();
  for (const list of lists)
    for (const r of Array.isArray(list) ? list : []) {
      const p = r?.payment;
      if (!r || typeof r.id !== "string" || r.status !== "open" || p?.locked !== true) continue;
      const before = locks.get(r.id);
      if (!before || String(p.updatedAt ?? "") > String(before.updatedAt ?? ""))
        locks.set(r.id, {
          id: typeof p.id === "string" ? p.id : null,
          status: typeof p.stage === "string" ? p.stage : "unknown",
          source: p.source === "send" ? "send" : "wallet",
          updatedAt: p.updatedAt ?? null,
        });
    }
  return locks;
}

const stageText = {
  // Browser sends (Send money).
  accepted: "accepted, being prepared",
  building: "being prepared",
  "queued-checker-capacity": "waiting for a checker",
  "awaiting-signature": "waiting for the payer's signature",
  signed: "signed, being sent",
  broadcasting: "being sent",
  finalized: "on the ledger, waiting for the recipient to confirm",
  "cancel-requested": "being cancelled",
  // Wallet payments.
  refused: "refused by the network, needs checking",
  "awaiting-agreement": "waiting for both agreements",
  "intent-ready": "ready to send",
  unknown: "sent, outcome being checked",
  "not-broadcast": "not sent yet",
  "ledger-recorded": "on the ledger, waiting for the recipient to confirm",
  "recipient-confirmed-paid": "paid",
};

/**
 * @returns {{badge: string, tone: string, actions: string[], note: string}}
 * actions are a subset of "pay", "decline", "cancel", "open-payment".
 */
export function requestRowView(request, { address, locks = new Map() } = {}) {
  const payer = request?.to === address;
  const trade = Object.hasOwn(request ?? {}, "trade");
  if (request?.status !== "open")
    return {
      badge: requestStatusLabel(request?.status),
      tone: String(request?.status ?? ""),
      actions: [],
      note: "",
    };
  const lock = locks.get(request.id);
  if (lock) {
    const stage = stageText[lock.status] || "in progress";
    return {
      badge: "Payment in progress",
      tone: "in-progress",
      actions: ["open-payment"],
      note: payer
        ? `Your payment for this request is under way: ${stage}. Continue it in Send money.`
        : `The payer has started a payment: ${stage}. It counts as paid once the ledger records it and you confirm it.`,
    };
  }
  return {
    badge: "Pending",
    tone: "open",
    actions: payer ? ["pay", "decline"] : ["cancel"],
    note: "",
    payLabel: trade ? "Review & pay" : "Pay",
  };
}

/** The member-facing text for a refusal while a payment already exists. */
export const PAYMENT_REQUEST_LOCKED_TEXT =
  "A payment for this request is already in progress. Continue it in Send money instead of starting another.";
