/** One answer to "may this payment request already be paid?" for every payment guard
 * (security review, 10 November 2026).
 *
 * A request can be paid on two paths, each with its own journal and lock map: the
 * no-install server send (`serverSendIntents`, `serverSendRequestLocks`) and the
 * device-wallet intent (`nativePaymentIntents`, `nativePaymentRequestLocks`). A guard
 * that reads only one lock misses a payment on the other path, and one whose lock a
 * later attempt took over (request 88a374c3… was paid twice that way). So every guard
 * that creates, prepares, closes, expires or reopens a request scans both journals
 * through this module. It only reads; the lock rules stay in the send paths.
 */

/** A server send in one of these states ended without a debit. */
export const SEND_CLOSED = Object.freeze(['expired', 'cancelled', 'checker-refused']);
/** A wallet intent in one of these states holds no send. */
export const INTENT_CLOSED = Object.freeze(['abandoned', 'expired-unused']);
/** A wallet intent in one of these states is recorded on the ledger. */
export const INTENT_RECORDED = Object.freeze(['ledger-recorded', 'recipient-confirmed-paid']);
export const REQUEST_PAID_MESSAGE = 'This request is already paid; the recipient now confirms receipt, so do not pay it again.';

export function sendsFor(state, requestId) {
  return requestId ? Object.values(state.serverSendIntents ?? {}).filter((r) => r?.intent?.requestId === requestId) : [];
}
export function intentsFor(state, requestId) {
  return requestId ? Object.values(state.nativePaymentIntents ?? {}).filter((i) => i?.requestId === requestId) : [];
}
/** A server send that may have debited: finalized, or any signed attempt not proved unused. */
export function sendMayHaveDebited(row) {
  return row.status === 'finalized' || (row.attempts ?? []).some((a) => (a.envelope || a.sendAttemptedAt) && a.status !== 'expired-unused');
}

/**
 * The payment that already landed on the ledger for this request, confirmed by the
 * recipient or not, or null. `except` is the id of the caller's own payment.
 * `at` is when it landed, as far as the journal knows.
 */
export function requestPaidBy(state, requestId, except = null) {
  const send = sendsFor(state, requestId).find((r) => r.id !== except && r.status === 'finalized');
  if (send) return { source: 'send', id: send.id, confirmed: Boolean(send.recipientConfirmation), at: send.updatedAt ?? send.createdAt ?? null };
  const intent = intentsFor(state, requestId).find((i) => i.id !== except && INTENT_RECORDED.includes(i.status));
  if (intent) return { source: 'wallet', id: intent.id, confirmed: intent.status === 'recipient-confirmed-paid', at: intent.receipt?.proof?.headerTime ?? intent.updatedAt ?? intent.createdAt ?? null };
  return null;
}

/**
 * A payment for this request that has not landed and is not proved dead, so it may
 * still pay the request, or null. Counts every such payment, whichever one the lock
 * maps name: a server send that is neither closed nor finalized, the wallet intent a
 * lock names unless it is closed (a lock without its intent row counts too), and any
 * wallet intent that is neither closed nor recorded.
 */
export function requestHeldBy(state, requestId, except = null) {
  if (!requestId) return null;
  const send = sendsFor(state, requestId).find((r) => r.id !== except && r.status !== 'finalized' && !SEND_CLOSED.includes(r.status));
  if (send) return { source: 'send', id: send.id, status: String(send.status ?? 'unknown') };
  const lock = state.nativePaymentRequestLocks?.[requestId];
  if (lock && lock !== except) {
    const row = state.nativePaymentIntents?.[lock];
    if (!INTENT_CLOSED.includes(row?.status) && !INTENT_RECORDED.includes(row?.status)) return { source: 'wallet', id: lock, status: String(row?.status ?? 'unknown') };
  }
  const intent = intentsFor(state, requestId).find((i) => i.id !== except && !INTENT_CLOSED.includes(i.status) && !INTENT_RECORDED.includes(i.status));
  if (intent) return { source: 'wallet', id: intent.id, status: String(intent.status ?? 'unknown') };
  return null;
}

/**
 * The guard itself: refuse when the request is already paid on the ledger
 * (`payment_request_paid`) or another payment may still pay it
 * (`payment_request_locked`). `check(ok, status, code, message)` is the caller's own
 * refusal helper, so each service keeps its error class.
 */
export function assertRequestUnpaid(state, requestId, check, { except = null, lockedMessage } = {}) {
  check(!requestPaidBy(state, requestId, except), 409, 'payment_request_paid', REQUEST_PAID_MESSAGE);
  check(!requestHeldBy(state, requestId, except), 409, 'payment_request_locked', lockedMessage ?? 'Another payment for this request is still going through; wait for it to finish.');
}
