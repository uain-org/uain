import { verifyAcceptance } from "./trade-deals-view.js";
export const DEAL_SCHEMA = "baink-trade-deal-payment-v1";
// Mirrors server/trade-payment.mjs. The browser recomputes the snapshot digest
// itself and refuses any request whose snapshot, parties, price or memo differ.
// The digest form is the identity-style one: sorted keys with JSON.stringify
// strings (ordinary Unicode and HTML characters kept as is), not
// nativeCanonicalJSON. /pay takes expectedTradeDigest + confirmTradeReview.
const ADDRESS = /^uain1[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
export const ID = /^[a-f0-9-]{36}$/;
const PRICE = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/;
const SCHEMA = "baink-trade-payment-v1";
const MAX_SNAPSHOT_BYTES = 24576;
const enc = new TextEncoder();

export class TradeReviewError extends Error {}
export const insist = (ok, text) => {
  if (!ok)
    throw new TradeReviewError(
      text || "This Trade snapshot does not match its payment request.",
    );
};
const plain = (x) =>
  x !== null &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x)) &&
  Reflect.ownKeys(x).every(
    (k) =>
      typeof k === "string" && "value" in Object.getOwnPropertyDescriptor(x, k),
  );
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (plain(v))
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  insist(
    v === null ||
      ["string", "boolean"].includes(typeof v) ||
      (typeof v === "number" && Number.isSafeInteger(v)),
  );
  return JSON.stringify(v);
}
const hex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 of the canonical full proposal DTO, exactly as the service hashes it. */
export async function tradeSnapshotDigest(proposal) {
  const bytes = enc.encode(canonical(proposal));
  insist(bytes.length <= MAX_SNAPSHOT_BYTES, "This Trade snapshot is too large.");
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
export const tradePaymentMemo = (p, digest) =>
  `Trade: ${Array.from(p.terms.scope).slice(0, 120).join("")}${Array.from(p.terms.scope).length > 120 ? " [scope excerpt]" : ""}; proposal ${p.id}; snapshot SHA-256 ${digest}`;
// Exact base units as text; a price never passes through a float.
const unitsOf = (price) => {
  const [whole, fraction = ""] = price.split(".");
  return (whole + fraction.padEnd(6, "0")).replace(/^0+/, "");
};
const sixPlaces = (price) => {
  const [whole, fraction = ""] = price.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
};

/** A sent, nonbinding seller proposal whose enquiry names both parties. */
export function sellerProposalError(p, signedDeal = false) {
  const e = p?.enquirySnapshot;
  if (
    !plain(p) ||
    p.kind !== "nonbinding-terms-proposal" ||
    p.binding !== false ||
    p.nonbinding !== true ||
    p.settlementAvailable !== false ||
    p.acceptanceAvailable !== false ||
    typeof p.id !== "string" ||
    !ID.test(p.id) ||
    !plain(e) ||
    e.kind !== "nonbinding-enquiry" ||
    e.binding !== false ||
    !ADDRESS.test(e.seller ?? "") ||
    !ADDRESS.test(e.buyer ?? "") ||
    e.seller === e.buyer ||
    (p.author !== e.seller && !(signedDeal && p.author === e.buyer)) ||
    p.enquiryId !== e.id ||
    !plain(p.terms) ||
    typeof p.terms.scope !== "string" ||
    p.terms.scope.trim() === "" ||
    p.terms.currency !== "AI$" ||
    typeof p.terms.price !== "string" ||
    !PRICE.test(p.terms.price) ||
    sixPlaces(p.terms.price) !== p.terms.price ||
    unitsOf(p.terms.price) === "" ||
    p.terms.priceUnits !== unitsOf(p.terms.price)
  )
    return "Only terms you sent as the seller of this enquiry can become a payment request.";
  return "";
}

/** Independently verifies a Trade payment request. Returns its digest. */
export async function verifyTradeRequest(request, deal) {
  insist(plain(request) && Object.hasOwn(request, "trade"));
  const tr = request.trade;
  const bound = tr?.schema === DEAL_SCHEMA;
  insist(
    plain(tr) &&
      Object.keys(tr).length === (bound ? 5 : 3) &&
      (bound ? ID.test(tr.dealId) && HASH.test(tr.dealDigest) : tr.schema === SCHEMA) &&
      typeof tr.snapshotDigest === "string" &&
      HASH.test(tr.snapshotDigest),
  );
  const p = tr.proposal;
  insist(sellerProposalError(p, bound) === "");
  const digest = await tradeSnapshotDigest(p);
  insist(
    digest === tr.snapshotDigest,
    "The Trade snapshot does not match its SHA-256. Do not continue.",
  );
  const e = p.enquirySnapshot;
  insist(
    request.from === e.seller &&
      request.to === e.buyer &&
      request.currency === "AI$" &&
      request.amount === p.terms.price &&
      request.memo === tradePaymentMemo(p, digest),
    "The payment request's parties, price or purpose differ from the Trade snapshot. Do not continue.",
  );
  if (bound) {
    const signed = deal?.digestInput;
    const linked = deal?.payment?.request;
    insist(signed?.schema === "baink-trade-deal-v1" && deal.id === tr.dealId &&
      signed.dealId === deal.id && deal.dealDigest === tr.dealDigest &&
      signed.proposalId === p.id && signed.proposalDigest === digest &&
      signed.seller === request.from && signed.buyer === request.to &&
      canonical(signed.terms) === canonical(p.terms) &&
      await tradeSnapshotDigest(signed) === tr.dealDigest,
      "The signed deal differs from this payment request.");
    insist(linked && ["id", "from", "to", "amount", "currency", "expiresAt", "status"]
      .every(field => linked[field] === request[field]) &&
      request.clientRequestId === "deal-" + deal.id && request.status === "open" &&
      Date.parse(request.expiresAt) > Date.now() && deal.status === "agreed" &&
      deal.payment.next?.action === "pay" && deal.payment.next.actor === "buyer" &&
      deal.payment.next.requestId === request.id,
      "This deal has no matching open payment due.");
    for (const role of ["buyer", "seller"]) {
      const a = deal.acceptances?.[role];
      insist(a?.role === role && a.address === signed[role] &&
        ["https://baink.money", "https://aidollar.money", globalThis.location?.origin].includes(a.audience) &&
        typeof a.audience === "string" && a.method === "POST" &&
        a.path === "/api/trade/deals/" + deal.id + "/accept" &&
        a.body?.confirmBinding === true && a.body.dealDigest === tr.dealDigest &&
        await verifyAcceptance(a), "The signed deal acceptance could not be verified.");
    }
    insist(signed.fee?.currency === "AI$" && signed.fee.amountUnits === "0",
      "The deal fee differs from the supported zero fee.");
  }
  return digest;
}
