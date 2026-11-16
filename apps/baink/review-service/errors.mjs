/** Typed public-review errors. The message stays the stable code for existing callers;
 * HTTP mapping uses the exact code, never a pattern over free-form message text. */
export class ReviewError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "ReviewError";
    this.code = code;
    this.retryable = retryable === true || TRANSIENT.has(code);
  }
}
/** Codes that describe a short-lived condition. Safe to retry with the same request. */
export const TRANSIENT = new Set([
  "review_vault_busy", "review_store_lock_unavailable", "review_gateway_proof",
  "review_gateway_vault_unavailable", "review_gateway_native_unavailable", "review_gateway_recovery_busy",
]);
const CLASSES = {
  missing: [404, "public_review_missing", "No such public review job for this member."],
  notReady: [409, "public_review_not_ready", "This step's result is not ready yet. Check its status again shortly."],
  busy: [429, "public_review_busy", "The public checker is busy. Retry the same request shortly."],
  unavailable: [503, "public_review_unavailable", "The public checker is temporarily unavailable. Retry the same request; it is kept for recovery."],
  refused: [409, "public_review_refused", "The checker could not accept this step. Retain the original request for recovery."],
  auth: [401, "review_worker_auth_refused", "Worker authentication refused."],
  error: [500, "public_review_error", "The public checker hit an internal error. The request is kept for recovery and operators were alerted."],
};
const TABLE = new Map();
const assign = (cls, codes) => { for (const code of codes) TABLE.set(code, cls); };
assign("missing", ["review_gateway_missing"]);
assign("notReady", ["review_gateway_artifact_not_ready"]);
assign("busy", ["review_gateway_capacity", "review_gateway_review_budget", "review_gateway_recovery_capacity",
  "review_gateway_recovery_busy", "review_vault_busy", "review_store_lock_unavailable", "review_model_queue_capacity"]);
assign("unavailable", ["review_gateway_proof", "review_gateway_vault_unavailable", "review_gateway_native_unavailable",
  "public_review_closed", "public_review_unavailable"]);
assign("refused", ["review_gateway_identity", "review_gateway_licence", "review_gateway_body", "review_gateway_context",
  "review_gateway_request", "review_gateway_action", "review_gateway_size", "review_gateway_idempotency_conflict",
  "review_gateway_job", "review_gateway_pending", "review_gateway_phase", "review_gateway_abandon_unavailable",
  "review_gateway_artifact_unavailable", "review_gateway_recovery_unavailable", "review_gateway_context_expired",
  "public_review_identity", "public_review_worker_body", "review_model_queue_binding", "review_model_queue_conflict"]);
assign("auth", ["review_worker_auth_refused"]);
/** Map an error to {status, code, message, report}. report=true means operators must see it (onError). */
export function classifyReviewError(error, { worker = false } = {}) {
  const typed = error instanceof ReviewError ? error.code : null;
  let cls = typed ? TABLE.get(typed) : undefined;
  if (cls === "auth" && !worker) cls = "refused";
  // Untyped retryable dependency failures (for example the native proof reader) are unavailability.
  if (!cls && error?.retryable === true) cls = "unavailable";
  const [status, code, message] = CLASSES[cls ?? "error"];
  // Unknown errors, integrity failures (vault data loss, bindings) and dependency outages are logged.
  const report = !cls || cls === "unavailable";
  return { status, code, message, report, cause: typed ?? (error?.name || "Error") };
}
