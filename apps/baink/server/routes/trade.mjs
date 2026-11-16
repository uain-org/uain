// Trade and payment-request routes: offers, enquiries and terms, the Trade
// payment request, local payment requests (create, cancel, decline, pay),
// holder-private transfers and the request history. Paying a request or a
// transfer only prepares a holder-signed native payment intent after a fresh
// native account proof; nothing here settles or caches a balance.
import { createHash, randomUUID } from "node:crypto";
import { fail } from "../http-errors.mjs";
import { createTradeAvailability } from "../trade-availability.mjs";
import { nativeUnitsFromDecimal } from "../native-asset.mjs";
import { validateTradePaymentRequest } from "../trade-payment.mjs";
import { PAYMENT_REQUEST_EXPIRY_MS, addPaymentRequestHistory, paymentRequestExpired, paymentRequestView } from "../native-payments.mjs";
import { address, amount, only, text } from "./context.mjs";
import { INTENT_CLOSED, SEND_CLOSED, requestHeldBy, requestPaidBy } from "../request-payment-guard.mjs";

function tradePaths({ method, path }) {
  const offerPath = path.match(
    /^\/api\/trade\/offers\/([a-f0-9-]{36})(?:\/(withdraw|enquiries))?$/,
  );
  const tradePaymentPath = path.match(/^\/api\/trade\/terms\/([a-f0-9-]{36})\/payment-request$/);
  const enquiryTermsPath = path.match(
    /^\/api\/trade\/enquiries\/([a-f0-9-]{36})\/terms$/,
  );
  const termsPath = path.match(
    /^\/api\/trade\/terms\/([a-f0-9-]{36})(?:\/(send))?$/,
  );
  const termsOperation =
    (enquiryTermsPath && ["GET", "POST"].includes(method)) ||
    (termsPath &&
      ((!termsPath[2] && ["GET", "PATCH"].includes(method)) ||
        (termsPath[2] === "send" && method === "POST")));
  const peerOperation =
    (tradePaymentPath && method === "POST") ||
    (path === "/api/trade/offers" && method === "POST") ||
    (path === "/api/trade/enquiries" && method === "GET") ||
    (offerPath &&
      ((method === "PATCH" && !offerPath[2]) ||
        (method === "POST" && offerPath[2])));
  return { offerPath, tradePaymentPath, enquiryTermsPath, termsPath, termsOperation, peerOperation };
}

const addHistory = addPaymentRequestHistory;
// An intent in these states holds no send and no request lock (T1).
const CLOSED_INTENTS = INTENT_CLOSED;
// A browser send (server-send.mjs) stops locking its request once it is one of
// these, as the request close route below also treats it.
const CLOSED_SENDS = SEND_CLOSED;

/**
 * The payment that currently locks an open request, projected on
 * `/api/requests` (10 November 2026) so clients no longer join
 * `/api/native/payments`: its source, id, stage and last update. Null when
 * none locks it. Read-only; the lock rules stay in the send paths.
 */
export function requestPaymentLock(state, request) {
  if (request?.status !== "open") return null;
  const nativeId = state.nativePaymentRequestLocks?.[request.id];
  const nativeIntent = nativeId ? state.nativePaymentIntents?.[nativeId] : null;
  const sendId = state.serverSendRequestLocks?.[request.id];
  const send = sendId ? state.serverSendIntents?.[sendId] : null;
  const live = [];
  if (nativeIntent && !CLOSED_INTENTS.includes(nativeIntent.status))
    live.push({ source: "wallet", id: nativeId, stage: String(nativeIntent.status ?? "unknown"), updatedAt: nativeIntent.updatedAt ?? nativeIntent.createdAt ?? null });
  if (send && !CLOSED_SENDS.includes(send.status))
    live.push({ source: "send", id: sendId, stage: String(send.status ?? "unknown"), updatedAt: send.updatedAt ?? send.createdAt ?? null });
  if (!live.length) return null;
  live.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return { locked: true, ...live[0] };
}

// T1 payment recovery sits beside the wallet payment-intent routes.
const RECONCILE = /^\/api\/native\/payments\/([a-f0-9-]{36})\/reconcile$/;

export function createTradeRoutes({
  store,
  trade,
  tradeTerms,
  tradePayments,
  nativeAsset,
  nativePayments,
  tradeDeals,
  tradeAvailability = createTradeAvailability(),
}) {
  // Every Trade write asks trade-availability.mjs first (P0-4). A refused write
  // stops here, before any state is read or written, so a retry stays refused
  // and creates nothing.
  const allow = (operation, state) => tradeAvailability.assert(operation, state);
  return {
    name: "trade",
    public(ctx) {
      const { method, path } = ctx;
      const { offerPath } = tradePaths(ctx);
      if (method === "GET" && path === "/api/trade/offers")
        return ctx.send(200, trade.list(ctx.query()));
      if (method === "GET" && offerPath && !offerPath[2])
        return ctx.send(200, trade.detail(offerPath[1]));
    },
    isPrivate(ctx) {
      const { method, path } = ctx;
      const { termsOperation, peerOperation } = tradePaths(ctx);
      return Boolean(
        termsOperation ||
        peerOperation ||
        (path === "/api/requests" && ["GET", "POST"].includes(method)) ||
        (method === "POST" &&
          /^\/api\/requests\/[a-f0-9-]{36}\/(cancel|decline|pay)$/.test(path)) ||
        (method === "POST" && path === "/api/transfers") ||
        (method === "POST" && RECONCILE.test(path)) ||
        (method === "GET" && path === "/api/history"),
      );
    },
    async private(ctx) {
      const { method, path, body, user } = ctx;
      const { offerPath, tradePaymentPath, enquiryTermsPath, termsPath, termsOperation } = tradePaths(ctx);
      if (termsOperation && method !== "GET")
        allow(enquiryTermsPath ? "terms.create" : method === "PATCH" ? "terms.update" : "terms.send");
      if (path === "/api/trade/offers" && method === "POST") allow("offer.create");
      if (offerPath && method === "PATCH") allow("offer.update");
      if (offerPath?.[2] === "withdraw") allow("offer.withdraw");
      if (offerPath?.[2] === "enquiries") allow("enquiry.create");
      if (tradePaymentPath && method === "POST") allow("terms.payment-request");
      if (termsOperation) {
        const account = store.account(user.address);
        if (!account || account.publicKey !== user.publicKey)
          fail(404, "account_missing", "Create your BAINK profile to continue.");
        if (method === "GET") only(body, []);
        else only(ctx.query(), []);
        if (enquiryTermsPath)
          return ctx.send(method === "GET" ? 200 : 201,
            method === "GET"
              ? tradeTerms.list(user, enquiryTermsPath[1], ctx.query())
              : await tradeTerms.create(user, enquiryTermsPath[1], body),
          );
        if (method === "GET") {
          only(ctx.query(), []);
          return ctx.send(200, tradeTerms.detail(user, termsPath[1]));
        }
        return ctx.send(method === "PATCH" ? 200 : 201,
          method === "PATCH"
            ? await tradeTerms.update(user, termsPath[1], body)
            : await tradeTerms.send(user, termsPath[1], body),
        );
      }
      if (path === "/api/trade/offers" && method === "POST")
        return ctx.send(201, await trade.create(user, body));
      if (path === "/api/trade/enquiries")
        return ctx.send(200, trade.listEnquiries(user, ctx.query()));
      if (offerPath) {
        if (method === "PATCH")
          return ctx.send(200, await trade.update(user, offerPath[1], body));
        if (offerPath[2] === "withdraw") {
          only(body, []);
          return ctx.send(200, await trade.withdraw(user, offerPath[1]));
        }
        if (offerPath[2] === "enquiries")
          return ctx.send(201,
            await trade.enquire(user, offerPath[1], body),
          );
      }
      if (tradePaymentPath && method === "POST") {
        const result = await tradePayments.create(user,tradePaymentPath[1],body);
        return ctx.send(result.created?201:200,result);
      }
    },
    async member(ctx) {
      const { method, path, url, body, user } = ctx;
      if (method === "GET" && path === "/api/requests") {
        const direction = url.searchParams.get("direction") ?? "all",
          status = url.searchParams.get("status") ?? "all";
        if (
          !["all", "incoming", "outgoing"].includes(direction) ||
          !["all", "open", "paid", "declined", "cancelled", "expired"].includes(status)
        )
          fail(400, "invalid_query", "Invalid payment-request filters.");
        const page = Math.min(
          10000,
          Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1),
        );
        const pageSize = Math.min(
          100,
          Math.max(
            1,
            parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50,
          ),
        );
        const now = Date.now();
        const state = store.read();
        const requests = Object.values(state.requests)
          .map((r) => {
            const view = paymentRequestView(r, now);
            return { ...view, payment: requestPaymentLock(state, view) };
          })
          .filter(
            (r) =>
              (direction === "incoming"
                ? r.to === user.address
                : direction === "outgoing"
                  ? r.from === user.address
                  : r.from === user.address || r.to === user.address) &&
              (status === "all" || r.status === status),
          )
          .sort(
            (a, b) =>
              (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id),
          );
        return ctx.send(200, {
          requests: requests.slice((page - 1) * pageSize, page * pageSize),
          count: requests.length,
          page,
          pageSize,
          pages: Math.max(1, Math.ceil(requests.length / pageSize)),
        });
      }
      if (method === "POST" && path === "/api/requests") {
        only(body, ["to", "amount", "memo", "clientRequestId"]);
        const to = address(body.to),
          normalized = amount(body.amount),
          memo = text(body.memo, 500, "Memo", { optional: true });
        const clientRequestId = text(
          body.clientRequestId,
          100,
          "Client request identifier",
        );
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientRequestId))
          fail(
            400,
            "invalid_request_id",
            "Provide a unique client request identifier of 8–100 letters, numbers, dashes or underscores.",
          );
        if (to === user.address)
          fail(
            400,
            "self_request",
            "Choose another member for a payment request.",
          );
        const result = await store.transactRequestCreate((state) => {
          const existing = Object.values(state.requests).find(
            (r) =>
              r.from === user.address && r.clientRequestId === clientRequestId,
          );
          if (existing) {
            if (
              existing.to !== to ||
              existing.amount !== normalized ||
              existing.memo !== memo
            )
              fail(
                409,
                "idempotency_conflict",
                "This client request identifier was used for different details.",
              );
            return { created: false, request: existing };
          }
          if (
            Object.values(state.requests).filter((r) => r.from === user.address)
              .length >= 1000
          )
            fail(
              429,
              "request_limit",
              "The payment-request limit for this profile was reached.",
            );
          if (Object.keys(state.requests).length >= 10_000)
            fail(429, "capacity", "Payment-request storage capacity reached.");
          const created = Date.now(), now = new Date(created).toISOString();
          const request = {
            id: randomUUID(),
            from: user.address,
            to,
            amount: normalized,
            memo,
            clientRequestId,
            status: "open",
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(created + PAYMENT_REQUEST_EXPIRY_MS).toISOString(),
            currency: "AI$",
            settlementAvailable: false,
          };
          state.requests[request.id] = request;
          addHistory(state, "request.created", request, user.address);
          return { created: true, request };
        });
        return ctx.send(result.created ? 201 : 200, {
          request: result.request,
        });
      }
      const action = path.match(
        /^\/api\/requests\/([a-f0-9-]{36})\/(cancel|decline|pay)$/,
      );
      if (method === "POST" && action) {
        if (action[2] !== "pay") {
          allow(action[2] === "cancel" ? "request.cancel" : "request.decline");
          only(body, []);
        }
        if (action[2] === "pay") {
          const request = store.read().requests[action[1]];
          if (
            !request ||
            (request.from !== user.address && request.to !== user.address)
          )
            fail(404, "request_missing", "Payment request not found.");
          if (request.to !== user.address)
            fail(
              403,
              "forbidden",
              "You cannot perform this action on this payment request.",
            );
          if (request.status !== "open")
            fail(
              409,
              "request_closed",
              "This payment request is already closed.",
            );
          if (paymentRequestExpired(request))
            fail(409, "payment_request_expired", "This payment request has expired.");
          // A terms payment request with no signed deal is new business (P0-4).
          allow("request.pay", { request });
          tradeDeals?.assertPayable(request);
          const tradeReview = validateTradePaymentRequest(request);
          only(body, tradeReview ? ["expectedTradeDigest","confirmTradeReview"] : []);
          if (tradeReview) {
            if (body.confirmTradeReview !== true || typeof body.expectedTradeDigest !== "string") fail(400,"trade_review_required","Review the complete Trade snapshot before paying.");
            if (body.expectedTradeDigest !== tradeReview.tradeDigest) fail(409,"trade_payment_changed","The reviewed Trade snapshot changed.");
          }
          const current = await nativeAsset.account(user.address, user.publicKey);
          if (current.native?.verified !== true || current.native.memberStatus !== "active" || current.native.assetStatus !== "active")
            fail(503, current.settlement.code, current.settlement.message);
          const abandoned = Object.values(store.read().nativePaymentIntents ?? {}).filter(i => i.requestId === request.id && i.requestVersion === request.updatedAt && CLOSED_INTENTS.includes(i.status)).length;
          const result = await nativePayments.prepare(user, {
            clientRequestId: `request-${createHash("sha256").update(request.id + "\0" + request.updatedAt).digest("hex")}-${abandoned}`,
            to: request.from, amountUnits: nativeUnitsFromDecimal(request.amount),
            requestId: request.id, requestVersion: request.updatedAt,
            ...(tradeReview ? {expectedTradeDigest:tradeReview.tradeDigest} : {}),
          });
          return ctx.send(202, {intent: result.intent, workflow: "holder-private-payment", settled: false});
        }
        const result = await store.transact((state) => {
          const request = state.requests[action[1]];
          if (
            !request ||
            (request.from !== user.address && request.to !== user.address)
          )
            fail(404, "request_missing", "Payment request not found.");
          if (
            (action[2] === "cancel" ? request.from : request.to) !== user.address
          )
            fail(
              403,
              "forbidden",
              "You cannot perform this action on this payment request.",
            );
          if (request.status !== "open")
            fail(
              409,
              "request_closed",
              "This payment request is already closed.",
            );
          // One shared answer for every payment guard (request-payment-guard.mjs):
          // a request that a payment already reached on the ledger, or that one
          // may still pay, is never closed under it, whichever payment the lock
          // maps name (a later refused attempt can take a lock over).
          if (requestPaidBy(state, request.id))
            fail(409, "payment_request_paid", "This request is already paid on the ledger; the recipient confirms receipt to finish it, so it cannot be closed.");
          const held = requestHeldBy(state, request.id);
          if (held)
            fail(409, "payment_request_locked", held.source === "wallet"
              ? "Abandon the unsent payment intent, or reconcile a submitted payment, before closing this request."
              : "Cancel the payment in progress on the Pay screen before closing this request.");
          // What is left is a lock on a payment proved dead: stale, released here.
          if (state.nativePaymentRequestLocks?.[request.id]) delete state.nativePaymentRequestLocks[request.id];
          if (state.serverSendRequestLocks?.[request.id]) delete state.serverSendRequestLocks[request.id];
          request.status = action[2] === "cancel" ? "cancelled" : "declined";
          request.updatedAt = new Date().toISOString();
          addHistory(state, `request.${request.status}`, request, user.address);
          return request;
        });
        return ctx.send(200, { request: result });
      }
      const reconcile = method === "POST" && path.match(RECONCILE);
      if (reconcile) {
        only(ctx.query(), []);
        return ctx.send(200, await nativePayments.reconcile(user, reconcile[1], body));
      }
      if (method === "POST" && path === "/api/transfers") {
        only(body, ["to", "amount", "memo", "clientRequestId"]);
        address(body.to);
        const normalized = amount(body.amount);
        const memo = text(body.memo, 500, "Memo", { optional: true });
        const current = await nativeAsset.account(user.address, user.publicKey);
        if (current.native?.verified !== true || current.native.memberStatus !== "active" || current.native.assetStatus !== "active")
          fail(503, current.settlement.code, current.settlement.message);
        const result = await nativePayments.prepare(user, {
          clientRequestId: body.clientRequestId, to: body.to,
          amountUnits: nativeUnitsFromDecimal(normalized), memo,
        });
        return ctx.send(202, {intent: result.intent, workflow: "holder-private-payment", settled: false});
      }
      if (method === "GET" && path === "/api/history") {
        const history = store
          .read()
          .history.filter((h) => h.from === user.address || h.to === user.address)
          .reverse();
        return ctx.send(200, {
          history: history.slice(0, 1000),
          count: history.length,
          notice: "Payment-request activity only; no transfers have settled.",
        });
      }
    },
  };
}
