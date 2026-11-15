// Public Trade deals: the public record (feed, deals, disputes, decisions,
// member history, enquiries and sent proposals), the parties' signed deal
// actions, and the UAIN trade steward and central-review actions. Reads need
// no signature. Every write is a signed request; acceptance stores it.
import { fail } from "../http-errors.mjs";
import { createTradeAvailability } from "../trade-availability.mjs";

const UUID = "([a-f0-9-]{36})";
const match = (path, pattern) => path.match(new RegExp(`^${pattern}$`));

function writes({ method, path }) {
  if (method !== "POST") return null;
  let m;
  if (path === "/api/trade/deals") return { action: "create" };
  if ((m = match(path, `/api/trade/deals/${UUID}/(accept|cancel|refunds|rating|disputes)`)))
    return { action: m[2], dealId: m[1] };
  if ((m = match(path, `/api/trade/deals/${UUID}/milestones/([0-9])/(deliver|confirm|reject)`)))
    return { action: `milestone-${m[3]}`, dealId: m[1], index: Number(m[2]) };
  if ((m = match(path, `/api/trade/disputes/${UUID}/(evidence|appeal)`)))
    return { action: m[2], disputeId: m[1] };
  if ((m = match(path, `/api/trade/steward/disputes/${UUID}/decision`)))
    return { action: "steward-decision", disputeId: m[1] };
  if ((m = match(path, `/api/trade/steward/deals/${UUID}/(retry-payment|confirm-delivery|note)`)))
    return { action: "steward-action", dealId: m[1], stewardAction: m[2] };
  if ((m = match(path, `/api/trade/appeals/${UUID}/decision`)))
    return { action: "appeal-decision", disputeId: m[1] };
  return null;
}

// Route action -> trade-availability.mjs operation (P0-4). deal.accept is decided
// inside the deal service, where the deal's state is read in the same transaction.
const OPERATION = {
  create: "deal.create", accept: "deal.accept", cancel: "deal.cancel", refunds: "deal.refund", rating: "deal.rate",
  disputes: "dispute.open", "milestone-deliver": "milestone.deliver", "milestone-confirm": "milestone.confirm",
  "milestone-reject": "milestone.reject", evidence: "dispute.evidence", appeal: "dispute.appeal",
  "steward-decision": "steward.decision", "steward-action": "steward.action", "appeal-decision": "appeal.decision",
};

export function createTradeDealRoutes({ tradeDeals, tradeAvailability = createTradeAvailability() }) {
  return {
    name: "trade-deals",
    public(ctx) {
      const { method, path } = ctx;
      if (method !== "GET") return;
      let m;
      if (path === "/api/trade/feed") return ctx.send(200, tradeDeals.feed(ctx.query()));
      if (path === "/api/trade/deals") return ctx.send(200, tradeDeals.list(ctx.query()));
      if ((m = match(path, `/api/trade/deals/${UUID}`))) return ctx.send(200, tradeDeals.detail(m[1]));
      if (path === "/api/trade/disputes") return ctx.send(200, tradeDeals.disputes(ctx.query()));
      if ((m = match(path, `/api/trade/disputes/${UUID}`))) return ctx.send(200, tradeDeals.dispute(m[1]));
      if (path === "/api/trade/decisions") return ctx.send(200, tradeDeals.decisions(ctx.query()));
      if (path === "/api/trade/attention") return ctx.send(200, tradeDeals.attention());
      if (path === "/api/trade/policy") return ctx.send(200, { policy: tradeDeals.policy(), ...tradeDeals.stewards(), availability: tradeAvailability.view() });
      if (path === "/api/trade/public/enquiries") return ctx.send(200, tradeDeals.publicEnquiries(ctx.query()));
      if (path === "/api/trade/public/proposals") return ctx.send(200, tradeDeals.publicProposals(ctx.query()));
      if ((m = match(path, "/api/trade/members/(uain1[a-f0-9]{40})"))) return ctx.send(200, tradeDeals.member(m[1]));
    },
    isPrivate(ctx) {
      return Boolean(writes(ctx));
    },
    async private(ctx) {
      const w = writes(ctx);
      if (!w) return;
      const { body, user } = ctx;
      if (w.action !== "accept") tradeAvailability.assert(OPERATION[w.action]);
      if (Object.keys(ctx.query()).length) fail(400, "invalid_query", "Trade writes take no query.");
      const send = (status, result) => ctx.send(status, result);
      switch (w.action) {
        case "create": {
          const r = await tradeDeals.create(user, body);
          return send(r.created ? 201 : 200, r);
        }
        case "accept":
          return send(200, await tradeDeals.accept(user, w.dealId, body, user.signedRequest));
        case "cancel":
          return send(200, await tradeDeals.cancel(user, w.dealId, body));
        case "refunds": {
          const r = await tradeDeals.refund(user, w.dealId, body);
          return send(r.created ? 201 : 200, r);
        }
        case "rating":
          return send(200, await tradeDeals.rate(user, w.dealId, body));
        case "disputes": {
          const r = await tradeDeals.openDispute(user, w.dealId, body);
          return send(r.created ? 201 : 200, r);
        }
        case "milestone-deliver":
          return send(200, await tradeDeals.deliver(user, w.dealId, w.index, body));
        case "milestone-confirm":
          return send(200, await tradeDeals.reviewDelivery(user, w.dealId, w.index, body, true));
        case "milestone-reject":
          return send(200, await tradeDeals.reviewDelivery(user, w.dealId, w.index, body, false));
        case "evidence": {
          const r = await tradeDeals.addEvidence(user, w.disputeId, body);
          return send(r.created ? 201 : 200, r);
        }
        case "appeal":
          return send(200, await tradeDeals.appeal(user, w.disputeId, body));
        case "steward-decision":
          return send(200, await tradeDeals.stewardDecide(user, w.disputeId, body));
        case "steward-action":
          return send(200, await tradeDeals.stewardAction(user, w.dealId, w.stewardAction, body));
        case "appeal-decision":
          return send(200, await tradeDeals.appealDecide(user, w.disputeId, body));
      }
    },
  };
}
