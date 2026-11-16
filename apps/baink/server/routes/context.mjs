// The request context passed to every BAINK API route module, plus the input
// checks the routes share. The context carries only what this request has
// already established (method, path, URL, body, audience and, once a private
// route is reached, the verified principal). It never caches balances,
// licences or other native state: route modules read those from their
// services on every request.
import { ApiError, fail, sendJson } from "../http-errors.mjs";
import {
  formatNativeUnits,
  nativeUnitsFromDecimal,
} from "../native-asset.mjs";

export const ADDRESS = /^uain1[a-f0-9]{40}$/;
export const MAX_BODY = 16_384;
// The server closes an idle socket after this long unless a route extends it.
const RESPONSE_WINDOW_MS = 10_000;

// A route returns HANDLED once it has answered; undefined means "not mine".
export const HANDLED = true;

export function canonical(value, depth = 0) {
  if (depth > 32)
    fail(400, "invalid_body", "The JSON body is too deeply nested.");
  if (Array.isArray(value))
    return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// Body bounds by route: the public-review checker and holder payment
// submissions carry signed artifacts larger than an ordinary operation.
export function bodyLimitFor(method, pathname) {
  if (
    method === "POST" &&
    /^\/api\/native\/review(?:-worker\/(?:claim|complete|health))?$/.test(pathname)
  )
    return 131072;
  if (
    method === "POST" &&
    /^\/api\/native\/payments\/[a-f0-9-]{36}\/(submit|recover)$/.test(pathname)
  )
    return 32768;
  // A central submission carries up to 16,384 bytes of evidence, which JSON escaping can double
  // (11 November 2026: a full-size submission was refused as body_too_large at the 16 KiB bound).
  if (
    method === "POST" &&
    (pathname === "/api/native/central/prepare" ||
      /^\/api\/native\/central\/intents\/[a-f0-9-]{36}\/submit$/.test(pathname))
  )
    return 40960;
  return MAX_BODY;
}

export async function readBody(req, limit = MAX_BODY) {
  if (Number(req.headers["content-length"]) > limit)
    fail(413, "body_too_large", "The request body is too large.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit)
      fail(413, "body_too_large", "The request body is too large.");
    chunks.push(chunk);
  }
  if (!length) return {};
  if (req.method === "GET" || req.method === "HEAD")
    fail(400, "invalid_body", "This operation does not accept a request body.");
  if (
    !String(req.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    fail(415, "content_type", "Use application/json.");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object")
      fail(400, "invalid_body", "The request body must be a JSON object.");
    canonical(value);
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function text(value, max, label, { optional = false } = {}) {
  if (value === undefined && optional) return "";
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    fail(
      400,
      "invalid_body",
      `${label} must be text of at most ${max} characters.`,
    );
  return value.trim();
}

export function only(body, allowed) {
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== "object" ||
    Object.keys(body).some((k) => !allowed.includes(k))
  )
    fail(400, "invalid_body", "The request contains unsupported fields.");
}

export function amount(value) {
  try {
    return formatNativeUnits(nativeUnitsFromDecimal(value));
  } catch {
    fail(
      400,
      "invalid_amount",
      "Enter positive decimal text with at most six decimal places, within the native AI$ supply cap.",
    );
  }
}

export function address(value) {
  if (typeof value !== "string" || !ADDRESS.test(value))
    fail(400, "invalid_address", "Enter a valid UAIN address.");
  return value;
}

export function createRequestContext({ req, res, url, body, requestAudience }) {
  const ctx = {
    req,
    res,
    url,
    path: url.pathname,
    method: req.method,
    body,
    requestAudience,
    // Set by the router after signature, nonce and admission checks pass.
    user: null,
    // When the socket would be closed for inactivity. Advisory: routes that
    // wait on a bounded proof queue extend it; nothing else reads it to
    // change behaviour.
    deadline: Date.now() + RESPONSE_WINDOW_MS,
    extendDeadline(ms) {
      res.setTimeout(ms);
      ctx.deadline = Date.now() + ms;
    },
    // Query fields with duplicates refused; page and pageSize become numbers.
    query() {
      const query = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key))
          fail(400, "invalid_query", "Duplicate query fields are not allowed.");
        query[key] = ["page", "pageSize"].includes(key) ? Number(value) : value;
      }
      return query;
    },
    send(status, payload) {
      sendJson(res, status, payload);
      return HANDLED;
    },
  };
  return ctx;
}
