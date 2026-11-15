import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useId, useRef, useState } from "react";
import { api } from "./identity.js";
import { displayAmount } from "./exact-amount.js";

import { DEAL_SCHEMA, ID, insist, TradeReviewError, tradeSnapshotDigest, tradePaymentMemo, sellerProposalError, verifyTradeRequest } from "./trade-request-review.js";
export { TradeReviewError, tradeSnapshotDigest, tradePaymentMemo, sellerProposalError, verifyTradeRequest };
const PAGE_SIZE = 10;
const WRAP = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const short = (value) =>
  value ? value.slice(0, 12) + "…" + value.slice(-6) : "Unknown";
const when = (value) => {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "Not stated";
};

/** The immutable snapshot, shown in full: service, scope, price, parties. */
function Snapshot({ proposal, digest, viewer, signedDeal = false }) {
  const e = proposal.enquirySnapshot,
    t = proposal.terms,
    you = (address) => (address === viewer ? " (you)" : "");
  return (
    <div className="trade-pay-snapshot">
      <dl className="trade-pay-facts">
        <div>
          <dt>Service</dt>
          <dd style={WRAP}>
            {e.offer?.title || e.offerId} · listing revision{" "}
            {e.offer?.revision ?? "unknown"}
          </dd>
        </div>
        <div className="trade-pay-price">
          <dt>Exact price</dt>
          <dd>
            <strong>{displayAmount(t.price)} AI$</strong>
            <small>{t.priceUnits} base units</small>
          </dd>
        </div>
        <div>
          <dt>Seller, receives</dt>
          <dd>
            <code>{e.seller}</code>
            {you(e.seller)}
          </dd>
        </div>
        <div>
          <dt>Buyer, pays</dt>
          <dd>
            <code>{e.buyer}</code>
            {you(e.buyer)}
          </dd>
        </div>
      </dl>
      <dl className="trade-pay-terms">
        {[
          ["Scope", t.scope],
          ["Deliverables", t.deliverables],
          ["Timeline", t.timeline],
          ["Acceptance criteria", t.acceptanceCriteria],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd style={WRAP}>{value}</dd>
          </div>
        ))}
        <div>
          <dt>Informational end time</dt>
          <dd>{t.expiresAt ? when(t.expiresAt) : "None"}</dd>
        </div>
        <div>
          <dt>Proposal</dt>
          <dd>
            <code>{proposal.id}</code> · sent {when(proposal.sentAt)}
          </dd>
        </div>
        <div>
          <dt>Snapshot SHA-256 (checked in this browser)</dt>
          <dd>
            <code className="trade-pay-digest">{digest}</code>
          </dd>
        </div>
      </dl>
      <p className="trade-pay-notice">
        {signedDeal ? "Both parties signed this deal. Deal fee: 0 AI$." :
          "A nonbinding proposal. A payment request is not acceptance, a legal agreement, escrow, a delivery guarantee or a payment."}
      </p>
    </div>
  );
}

const SELLER_CODES = {
  trade_offer_changed:
    "Your service listing changed after these terms were sent. Send updated terms, then request payment for them.",
  trade_terms_expired: "These terms' informational end time has passed.",
  trade_proposal_already_requested:
    "A payment request already exists for this proposal.",
  trade_payment_changed:
    "These terms changed since you reviewed them. Review them again.",
  trade_payment_intent_conflict:
    "This request ID was already used for different terms. Nothing new was created.",
  trade_seller_required:
    "Only the seller who sent these terms can request payment.",
  trade_proposal_missing: "These terms are no longer available.",
  request_limit: "You have reached the payment-request limit.",
  peer_blocked: "Requests between you and this member are blocked.",
  offer_withdrawn: "This service listing was withdrawn.",
};
// A definite refusal ends the attempt. Anything else may have reached the
// service, so the same request is offered again, unchanged.
const DEFINITE = new Set([
  ...Object.keys(SELLER_CODES),
  "invalid_trade_payment_request",
  "enquiry_not_found",
  "offer_not_found",
  "terms_not_found",
]);
// Stable per seller, proposal and snapshot, so any retry, tab or reload
// recovers the one original request instead of creating another.
const clientRequestIdFor = (proposal, digest) =>
  `trade-${proposal.id.replaceAll("-", "")}-${digest.slice(0, 32)}`;

/** Seller: pick one of your own sent terms, review it, then create a request. */
export function SellerTradePaymentRequest({ identity, enquiry }) {
  const address = identity?.address,
    headingId = useId(),
    confirmId = useId();
  const [open, setOpen] = useState(false),
    [list, setList] = useState(null),
    [page, setPage] = useState(1),
    [review, setReview] = useState(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(false),
    [receipt, setReceipt] = useState(null);
  useReleaseBusy(busy);
  const generation = useRef(0),
    running = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  if (!address || enquiry?.seller !== address || !enquiry?.id) return null;
  const begin = () => {
    if (running.current) return null;
    running.current = true;
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    return () => generation.current === ticket;
  };
  const end = (live) => {
    if (!live()) return;
    running.current = false;
    setBusy(false);
  };
  const load = async (n) => {
    const live = begin();
    if (!live) return;
    try {
      const raw = await api(
        `/api/trade/enquiries/${encodeURIComponent(enquiry.id)}/terms?page=${n}&pageSize=${PAGE_SIZE}`,
        { identity, isCurrent: live },
      );
      if (!live()) return;
      if (!Array.isArray(raw?.proposals) || !Number.isSafeInteger(raw.pages))
        throw Error("Your sent terms could not be read.");
      setPage(n);
      setList({
        pages: raw.pages,
        proposals: raw.proposals.filter(
          (p) =>
            sellerProposalError(p) === "" &&
            p.author === address &&
            p.enquiryId === enquiry.id &&
            p.enquirySnapshot.buyer === enquiry.buyer,
        ),
      });
    } catch (e) {
      if (live()) setError(e.message || "Your sent terms could not be read.");
    } finally {
      end(live);
    }
  };
  // Reads the exact stored DTO and hashes it here before anything is shown.
  const choose = async (id) => {
    const live = begin();
    if (!live) return;
    try {
      const raw = await api(`/api/trade/terms/${encodeURIComponent(id)}`, {
        identity,
        isCurrent: live,
      });
      if (!live()) return;
      const p = raw?.proposal;
      const problem = sellerProposalError(p);
      if (problem || p.id !== id || p.author !== address) throw Error(problem);
      const digest = await tradeSnapshotDigest(p);
      if (!live()) return;
      setReview({ proposal: p, digest });
      setConfirmed(false);
      setRetry(false);
      setReceipt(null);
    } catch (e) {
      if (live())
        setError(
          e.message || "These terms could not be read. Refresh to try again.",
        );
    } finally {
      end(live);
    }
  };
  const create = async () => {
    if (!review || !confirmed) return;
    const live = begin();
    if (!live) return;
    const { proposal, digest } = review;
    try {
      const raw = await api(
        `/api/trade/terms/${encodeURIComponent(proposal.id)}/payment-request`,
        {
          identity,
          method: "POST",
          isCurrent: live,
          body: {
            clientRequestId: clientRequestIdFor(proposal, digest),
            snapshotDigest: digest,
            confirmPaymentRequest: true,
          },
        },
      );
      if (!live()) return;
      const request = raw?.request;
      // The receipt must carry this exact snapshot, from you, to the buyer.
      if (
        typeof raw?.created !== "boolean" ||
        (await verifyTradeRequest(request)) !== digest ||
        request.trade.proposal.id !== proposal.id ||
        request.from !== address ||
        request.to !== proposal.enquirySnapshot.buyer
      )
        throw new TradeReviewError(
          "The service returned an unexpected payment request.",
        );
      if (!live()) return;
      setReceipt({ request, created: raw.created });
      setRetry(false);
    } catch (e) {
      if (!live()) return;
      // Retrying is always safe: the same ID recovers, never duplicates.
      const definite = DEFINITE.has(e?.code);
      setRetry(!definite);
      setError(
        SELLER_CODES[e?.code] ||
          (definite
            ? e.message
            : e instanceof TradeReviewError
              ? `${e.message} Retry sends the same request; it cannot create a second one.`
              : "The service response could not be confirmed. Retry sends the same request; it cannot create a second one."),
      );
    } finally {
      end(live);
    }
  };
  const close = () => {
    generation.current++;
    running.current = false;
    setBusy(false);
    setOpen(false);
    setReview(null);
    setConfirmed(false);
    setError("");
    setRetry(false);
  };
  if (!open)
    return (
      <div className="trade-pay-entry">
        <button
          type="button"
          className="button small"
          onClick={() => {
            setOpen(true);
            setReceipt(null);
            load(1);
          }}
        >
          Request payment for sent terms
        </button>
      </div>
    );
  return (
    <section className="trade-pay" aria-labelledby={headingId}>
      <h4 id={headingId}>Request payment for sent terms</h4>
      {receipt ? (
        <div className="trade-pay-receipt" role="status">
          <p>
            <strong>
              {receipt.created
                ? "Payment request created."
                : "This payment request already existed and was recovered."}
            </strong>{" "}
            {displayAmount(receipt.request.amount)} AI$ to {short(receipt.request.to)}. The
            buyer must review this snapshot before paying. Nothing has been
            paid.
          </p>
          <button type="button" className="button small" onClick={close}>
            Done
          </button>
        </div>
      ) : review ? (
        <>
          <Snapshot
            proposal={review.proposal}
            digest={review.digest}
            viewer={address}
          />
          <label className="check-label" htmlFor={confirmId}>
            <input
              id={confirmId}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed this exact service, scope, price and both parties. Ask
            the buyer to pay {displayAmount(review.proposal.terms.price)} AI$.
          </label>
          <div className="trade-pay-actions">
            <button
              type="button"
              className="button ink small"
              disabled={busy || !confirmed}
              onClick={create}
            >
              {retry ? "Retry the same request" : "Create payment request"}
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy || retry}
              onClick={() => {
                setReview(null);
                setError("");
              }}
            >
              Choose other terms
            </button>
            <button type="button" className="button small" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {busy && !list && <p role="status">Reading your sent terms…</p>}
          {list && list.proposals.length === 0 && (
            <p>
              No terms you sent on this page. Send terms first; drafts and the
              buyer's proposals cannot be used.
            </p>
          )}
          {list && list.proposals.length > 0 && (
            <ul className="trade-pay-choices">
              {list.proposals.map((p) => (
                <li key={p.id}>
                  <span style={WRAP}>
                    <strong>{displayAmount(p.terms.price)} AI$</strong> ·{" "}
                    {Array.from(p.terms.scope).slice(0, 80).join("")}
                    <small> · sent {when(p.sentAt)}</small>
                  </span>
                  <button
                    type="button"
                    className="button small"
                    disabled={busy}
                    onClick={() => choose(p.id)}
                  >
                    Review
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="trade-pay-actions">
            {list?.pages > 1 && (
              <>
                <button
                  type="button"
                  className="button small"
                  disabled={busy || page <= 1}
                  onClick={() => load(page - 1)}
                >
                  Previous
                </button>
                <span>
                  Page {page} of {list.pages}
                </span>
                <button
                  type="button"
                  className="button small"
                  disabled={busy || page >= list.pages}
                  onClick={() => load(page + 1)}
                >
                  Next
                </button>
              </>
            )}
            <button type="button" className="button small" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}

/** Buyer: the full snapshot, checked here, before any private payment starts. */
export default function TradePaymentReview({
  request,
  identity,
  onContinue,
  onClose,
}) {
  const confirmId = useId();
  const [state, setState] = useState({ digest: null, error: "" }),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useReleaseBusy(busy);
  useEffect(() => {
    let active = true;
    setState({ digest: null, error: "" });
    setConfirmed(false);
    (async () => {
      try {
        insist(
          request?.to === identity?.address,
          "Only the buyer named in this Trade snapshot can pay it.",
        );
        insist(request.status === "open", "This payment request is closed.");
        const deal = request.trade?.schema === DEAL_SCHEMA && ID.test(request.trade.dealId)
          ? (await api("/api/trade/deals/" + encodeURIComponent(request.trade.dealId))).deal
          : undefined;
        const digest = await verifyTradeRequest(request, deal);
        if (active) setState({ digest, error: "" });
      } catch (e) {
        if (active)
          setState({
            digest: null,
            error:
              e instanceof TradeReviewError
                ? e.message
                : "This Trade snapshot could not be checked in this browser. Do not continue.",
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [request, identity]);
  const run = async () => {
    if (!state.digest || !confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await onContinue(state.digest);
    } catch (e) {
      // A closed or superseded review is dropped by the parent, never shown.
      if (e?.name === "AbortError") return;
      setError(
        e?.code === "trade_payment_changed"
          ? "The Trade snapshot changed since you reviewed it. Refresh your requests and review it again."
          : e.message || "The payment could not be prepared.",
      );
      setBusy(false);
    }
  };
  return (
    <div className="trade-pay-review">
      {!state.digest && !state.error && (
        <p role="status">Checking the Trade snapshot in this browser…</p>
      )}
      {state.error && (
        <p role="alert" className="form-error">
          {state.error}
        </p>
      )}
      {state.digest && (
        <>
          <Snapshot
            proposal={request.trade.proposal}
            digest={state.digest}
            viewer={identity.address}
            signedDeal={request.trade.schema === DEAL_SCHEMA}
          />
          <label className="check-label" htmlFor={confirmId}>
            <input
              id={confirmId}
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed this exact snapshot. Prepare a private payment of{" "}
            {displayAmount(request.trade.proposal.terms.price)} AI$ to the seller.
          </label>
          <p className="trade-pay-notice">
            This only prepares it. Nothing is sent until you sign it on Send
            money.
          </p>
          <p className="trade-pay-notice">
            You review the full proposal above. Checkers see only the declared
            payment purpose, a short excerpt in the memo. The SHA-256 binds this
            payment to these exact bytes; it is not a review of every term, and
            it is not acceptance, a legal agreement, escrow or a delivery
            guarantee.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button
          type="button"
          className="button"
          onClick={onClose}
          disabled={busy}
        >
          Go back
        </button>
        <button
          type="button"
          className="button ink"
          onClick={run}
          disabled={busy || !state.digest || !confirmed}
        >
          {busy ? "Preparing…" : "Continue to private payment"}
        </button>
      </div>
    </div>
  );
}
