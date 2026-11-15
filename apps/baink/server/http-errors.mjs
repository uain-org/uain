// Shared HTTP error and JSON response shaping for the BAINK API.
//
// Every API error on the wire is {"error":{"code","message"}} with a JSON
// content type and Cache-Control: no-store. Route modules throw through
// fail(); the request handler turns known errors into that shape and hides
// everything else behind internal_error.

export class ApiError extends Error {
  constructor(status, code, message, { retryAfterSeconds } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const fail = (status, code, message, options) => {
  throw new ApiError(status, code, message, options);
};

export const errorBody = (code, message) => ({ error: { code, message } });

// Retry hints (11 November 2026). Every 429 and 503 refusal tells the caller how
// long to wait: a Retry-After header, error.retryAfterSeconds and a plain error.next
// sentence. Where the server knows the exact wait (a rate window, an expiring
// signature) the caller passes it; otherwise the default for the code applies. The
// limits themselves are unchanged.
const DEFAULT_WAIT = {
  client_busy: 2,
  busy: 5,
  storage_busy: 2,
  rate_limited: 10,
  registration_busy: 30,
  member_nonce_limit: 30,
  central_proof_unavailable: 30,
  catalogue_unavailable: 30,
  management_source_unavailable: 30,
  public_review_unavailable: 60,
  frontend_unavailable: 60,
};
const NEXT = {
  client_busy: (s) => `Too many of your requests are still running. Wait ${s} seconds, then send one again.`,
  busy: (s) => `BAINK is busy. Wait ${s} seconds, then try again.`,
  rate_limited: (s) => `You reached the request limit for now. Wait ${s} seconds, then try again.`,
  member_nonce_limit: (s) => `Too many signed requests from this key are still open. Wait ${s} seconds for the oldest to expire, then sign a fresh request.`,
  central_proof_unavailable: (s) => `The network could not prove its current state just now. Wait ${s} seconds, then try again.`,
  registration_busy: (s) => `Many new members are joining right now. Wait ${s} seconds, then try again.`,
};
export function retryHint(status, code, seconds) {
  if (status !== 429 && status !== 503) return null;
  let wait = Number.isFinite(seconds) ? Math.ceil(seconds) : DEFAULT_WAIT[code] ?? (status === 429 ? 10 : 30);
  wait = Math.min(3600, Math.max(1, wait));
  const next = NEXT[code]?.(wait) ?? `This is a temporary refusal. Wait ${wait} seconds, then try again.`;
  return { retryAfterSeconds: wait, next };
}
/** Adds the retry hint to a 429/503 error body and sets Retry-After; other bodies pass unchanged. */
export function withRetryHint(res, status, body, seconds) {
  const hint = retryHint(status, body?.error?.code, seconds);
  if (!hint || !body?.error || typeof body.error !== "object") return body;
  if (!res.headersSent) res.setHeader("Retry-After", String(hint.retryAfterSeconds));
  return { ...body, error: { ...body.error, ...hint } };
}

export function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}

export const sendError = (res, status, code, message, retryAfterSeconds) =>
  sendJson(res, status, withRetryHint(res, status, errorBody(code, message), retryAfterSeconds));

// Domain services raise their own error classes carrying {status, code,
// message}. Only those listed here are shown to the caller; anything else is
// reported through onError and answered as a generic 500.
export function shapeError(error, knownErrors) {
  const known = knownErrors.some((Known) => error instanceof Known);
  // A refusal that names its own next step (trade_paused, 12 November 2026) carries it as error.next.
  const body = known ? errorBody(error.code, error.message) : null;
  if (body && typeof error.next === "string") body.error.next = error.next;
  return known
    ? { known, status: error.status, body }
    : {
        known,
        status: 500,
        body: errorBody("internal_error", "The operation could not be completed."),
      };
}
