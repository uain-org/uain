/**
 * Plain words for status codes the web shows (plain-language pass, Rahul,
 * 10 November 2026). Every mapper falls back to a neutral word, never to the
 * raw code.
 */
const pick = (map, code, fallback) => (Object.hasOwn(map, code) ? map[code] : fallback);

/** A UAIN membership request's status. */
export const enrolmentLabel = (status) =>
  pick({ prepared: "Ready to sign", broadcasting: "Sent, being confirmed", ready: "Ready to sign", accepted: "Sent, being confirmed", submitted: "Sent, being confirmed", unknown: "Sent, being confirmed", finalized: "Done", refused: "Not accepted; try again", "expired-unused": "Expired; try again", expired: "Expired; try again" }, status, "In progress");

/** A UAIN membership's approval status. */
export const licenceLabel = (status) =>
  pick({ active: "Membership active", pending: "Waiting for approval", revoked: "Membership ended", withdrawn: "Membership withdrawn" }, status, "Being checked");

/** A deal's payment request status. */
export const dealPaymentLabel = (status) =>
  pick({ open: "Waiting for payment", paid: "Paid", declined: "Declined", cancelled: "Cancelled", expired: "Expired" }, status, "Closed");

/** A milestone's status. */
export const milestoneLabel = (status) =>
  pick({ pending: "Not started", delivered: "Delivered, waiting for the buyer", accepted: "Accepted", confirmed: "Accepted", rejected: "Sent back for changes", refunded: "Refunded", cancelled: "Cancelled" }, status, "In progress");

/** A dispute's status. */
export const disputeLabel = (status) =>
  pick({ open: "Open", evidence: "Collecting evidence", decided: "Decided", appealed: "Appealed", final: "Final", closed: "Closed", withdrawn: "Withdrawn" }, status, "In progress");

/** What a party asked for in a dispute. */
export const outcomeLabel = (code) =>
  pick({ refund: "A full refund", "partial-refund": "A partial refund", redelivery: "Delivery again", "release-payment": "Release the payment", cancel: "Cancel the deal", other: "Something else" }, code, "Something else");

/** What a dispute decision said. */
export const decisionLabel = (code) =>
  pick({ "refund-full": "Full refund to the buyer", "refund-partial": "Partial refund to the buyer", "no-refund": "No refund; the seller is paid", redeliver: "The seller delivers again", "cancel-deal": "The deal is cancelled", "pay-me": "The seller is paid" }, code, "Decided");

/** Where a refund came from. */
export const refundSourceLabel = (code) => pick({ seller: "Offered by the seller", "mutual-cancel": "Agreed cancellation", dispute: "Decided in a dispute", steward: "Decided by UAIN" }, code, "Refund");

/**
 * One plain sentence for an account history row (payment requests). `me` is
 * the member's address; `name` shortens another address. Never shows a raw
 * event code.
 */
export function historyText(row, me, name = (a) => a, amount = (v) => v) {
  const mine = row?.from === me, other = name(mine ? row?.to : row?.from), n = row?.amount != null ? `${amount(row.amount)} AI$` : "AI$";
  switch (row?.type) {
    case "request.created": return mine ? `You asked ${other} for ${n}` : `${other} asked you for ${n}`;
    case "request.paid": return mine ? `${other} paid your request for ${n}` : `You paid ${other}'s request for ${n}`;
    case "request.declined": return mine ? `${other} declined your request for ${n}` : `You declined ${other}'s request for ${n}`;
    case "request.cancelled": return mine ? `You cancelled your request for ${n}` : `${other} cancelled their request for ${n}`;
    case "request.expired": return `A request for ${n} expired`;
    case "request.reopened": return `A request for ${n} is open again`;
    default: return "Account activity";
  }
}
