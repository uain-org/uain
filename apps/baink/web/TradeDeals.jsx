import React, { useEffect, useRef, useState } from "react";
import { decisionLabel, dealPaymentLabel, disputeLabel, milestoneLabel, outcomeLabel, refundSourceLabel } from "./plain-labels.js";

// The outcomes a dispute can ask for (server `DESIRED`), shown in plain words.
const OUTCOME_CHOICES = ["refund", "partial-refund", "redelivery", "release-payment", "cancel", "other"];
import { api } from "./identity.js";
import { displayAmount } from "./exact-amount.js";
import { useReleaseBusy } from "./release-busy.js";
import { dealStatus, dealActions, dealNotes, roleIn, verifyAcceptance, verifyDealDigest, eventLabel, shortAddress } from "./trade-deals-view.js";

const intent = (label) => `${label}-${crypto.randomUUID()}`;
function useAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false);
  useReleaseBusy(busy);
  const run = async (fn) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError("");
    try { return await fn(); } catch (e) { setError(e.message); } finally { running.current = false; setBusy(false); }
  };
  return { busy, error, run };
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/** Make one sent proposal binding: draft the deal, then each party signs it. */
export function DealFromEnquiry({ identity, enquiry, onOpen, pausedSentence = null }) {
  const [proposals, setProposals] = useState(null), [form, setForm] = useState(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let live = true;
    api(`/api/trade/public/proposals?enquiryId=${encodeURIComponent(enquiry.id)}&pageSize=10`).then((r) => live && setProposals(r.proposals)).catch(() => live && setProposals([]));
    return () => { live = false; };
  }, [enquiry.id]);
  if (!proposals?.length) return null;
  // Creating a deal is new business, refused while Trade is paused: say so instead of offering it.
  if (pausedSentence) return <div className="deal-from"><p className="deal-hint" data-deal-note="trade_paused">{pausedSentence}</p></div>;
  return (
    <div className="deal-from">
      <h4>Make it binding</h4>
      <p className="deal-hint">Turn sent terms into a public deal. Both of you sign the exact terms; then the payment request opens with a deadline.</p>
      {proposals.map((p) => (
        <div key={p.id} className="deal-proposal">
          <div>
            <strong>{displayAmount(p.terms.price)} AI$</strong> · {p.terms.scope}
            <span className="deal-meta">Sent {when(p.sentAt)} by {p.author === identity.address ? "you" : shortAddress(p.author)}</span>
          </div>
          {form?.id === p.id ? (
            <form className="deal-form" onSubmit={(e) => { e.preventDefault(); run(async () => {
              const milestones = form.milestones.split("\n").map((s) => s.trim()).filter(Boolean);
              const r = await api("/api/trade/deals", { identity, method: "POST", body: { clientRequestId: form.intent, proposalId: p.id, proposalDigest: p.proposalDigest, confirmBindingDraft: true, ...(milestones.length ? { milestones } : {}), paymentWindowHours: Number(form.hours) } });
              setForm(null); onOpen?.(r.deal.id);
            }); }}>
              <label>Milestones, one per line<textarea rows={3} value={form.milestones} onChange={(e) => setForm({ ...form, milestones: e.target.value })} placeholder="Delivery of the agreed deliverables" /></label>
              <label>Payment window (hours)<input type="number" min={1} max={720} value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
              <div className="deal-buttons">
                <button className="button ink small" disabled={busy}>Draft binding deal</button>
                <button type="button" className="button small" onClick={() => setForm(null)}>Back</button>
              </div>
            </form>
          ) : (
            <button className="button small" disabled={busy} onClick={() => setForm({ id: p.id, milestones: "", hours: 72, intent: intent("deal") })}>Draft deal</button>
          )}
        </div>
      ))}
      {error && <p className="deal-error" role="alert">{error}</p>}
    </div>
  );
}

function Signature({ acceptance, role }) {
  const [ok, setOk] = useState(null);
  useEffect(() => { if (acceptance) verifyAcceptance(acceptance).then(setOk); }, [acceptance?.signature]);
  if (!acceptance) return <li className="deal-sig pending"><span>{role}</span> not signed yet</li>;
  return (
    <li className={`deal-sig ${ok === false ? "bad" : "ok"}`}>
      <span>{role}</span> signed {when(acceptance.at)}{" "}
      <em>{ok === null ? "checking…" : ok ? "signature verified in this browser" : "signature does not verify"}</em>
    </li>
  );
}

function DealView({ identity, id, onClose, onPay, onPayments, onProfile, pausedSentence = null }) {
  const [deal, setDeal] = useState(null), [prompt, setPrompt] = useState(null), [loadError, setLoadError] = useState("");
  const { busy, error, run } = useAction();
  const load = () => api(`/api/trade/deals/${id}`).then((r) => setDeal(r.deal)).catch((e) => setLoadError(e.message));
  useEffect(() => { load(); }, [id]);
  // FE-4: Sign is offered only once this browser recomputed the digest from the terms it shows.
  // The result counts only for the deal object it was computed from, so a reload never shows Sign early.
  const [checked, setChecked] = useState({ deal: null, ok: null }), digestOk = checked.deal === deal ? checked.ok : null;
  useEffect(() => { let live = true; if (deal) verifyDealDigest(deal).then((ok) => live && setChecked({ deal, ok })); return () => { live = false; }; }, [deal]);
  if (!deal) return <section className="card deal-view"><p role="status">{loadError || "Loading deal…"}</p></section>;
  // pausedSentence comes from the availability read (/api/config `trade`); null when Trade is open.
  const me = identity?.address, role = roleIn(deal, me), st = dealStatus(deal.status);
  const actions = (me ? dealActions(deal, me, { paused: Boolean(pausedSentence) }) : []).filter((a) => a !== "sign" || digestOk === true);
  const digestRefused = digestOk === false && deal.status === "proposed" && role && !deal.signed?.[role];
  const post = (path, body) => run(async () => { await api(path, { identity, method: "POST", body: { clientRequestId: intent("deal"), ...body } }); setPrompt(null); await load(); });
  const ask = (kind, fields, submit, label) => setPrompt({ kind, fields, submit, label, values: {} });
  const base = `/api/trade/deals/${deal.id}`;
  const dispute = deal.disputes?.at(-1);
  return (
    <section className="card deal-view" aria-labelledby={`deal-${deal.id}`}>
      <header className="deal-top">
        <button className="button small" onClick={onClose}>← All deals</button>
        <span className={`deal-pill ${st.tone}`}>{st.label}</span>
      </header>
      <h3 id={`deal-${deal.id}`}>{deal.title}</h3>
      <p className="deal-hint">{st.hint}</p>
      <dl className="deal-facts">
        <div><dt>Price</dt><dd>{displayAmount(deal.price)} AI$ <small>fee {displayAmount(deal.fee.amount)} AI$</small></dd></div>
        <div><dt>Seller</dt><dd><button className="trade-provider" onClick={() => onProfile?.(deal.seller)}>{deal.seller === me ? "You" : shortAddress(deal.seller)}</button></dd></div>
        <div><dt>Buyer</dt><dd><button className="trade-provider" onClick={() => onProfile?.(deal.buyer)}>{deal.buyer === me ? "You" : shortAddress(deal.buyer)}</button></dd></div>
        <div><dt>Payment</dt><dd>{deal.payment ? `${dealPaymentLabel(deal.payment.request.status)}${deal.payment.request.expiresAt && deal.payment.request.status === "open" ? ` · due ${when(deal.payment.request.expiresAt)}` : ""}` : "After you both sign"}</dd></div>
      </dl>
      {deal.payment?.next?.why && deal.payment.request?.status !== "paid" && <p className="deal-hint" data-payment-next={deal.payment.next.action}>{deal.payment.next.actor === role ? "Your step: " : ""}{deal.payment.next.why}</p>}
      <details className="deal-terms" open={deal.status === "proposed"}>
        <summary>Signed terms</summary>
        <p><b>Scope</b> {deal.terms.scope}</p>
        <p><b>Deliverables</b> {deal.terms.deliverables}</p>
        <p><b>Timeline</b> {deal.terms.timeline}</p>
        <p><b>Acceptance criteria</b> {deal.terms.acceptanceCriteria}</p>
        <p className="deal-digest">Deal digest <code>{deal.dealDigest}</code></p>
      </details>
      <ul className="deal-sigs"><Signature role="Seller" acceptance={deal.acceptances.seller} /><Signature role="Buyer" acceptance={deal.acceptances.buyer} /></ul>
      <ol className="deal-milestones">
        {deal.milestones.map((m) => (
          <li key={m.index} className={`ms ${m.status}`}>
            <div><strong>{m.title}</strong> <span className="ms-status">{milestoneLabel(m.status)}</span>
              {m.delivery && <p>{m.delivery.note}{m.delivery.url && <> · <a href={m.delivery.url} rel="noreferrer noopener" target="_blank">evidence</a></>}</p>}
              {m.rejection && <p className="deal-error">Rejected: {m.rejection.reason}</p>}
            </div>
            <div className="deal-buttons">
              {actions.includes(`deliver:${m.index}`) && <button className="button small" disabled={busy} onClick={() => ask("deliver", [["note", "What you delivered"], ["url", "Evidence link (https, optional)"]], (v) => post(`${base}/milestones/${m.index}/deliver`, { note: v.note, ...(v.url ? { url: v.url } : {}) }), "Mark delivered")}>{m.status === "delivered" ? "Update delivery" : "Deliver"}</button>}
              {actions.includes(`confirm:${m.index}`) && <button className="button ink small" disabled={busy} onClick={() => post(`${base}/milestones/${m.index}/confirm`, {})}>Confirm</button>}
              {actions.includes(`reject:${m.index}`) && <button className="button small" disabled={busy} onClick={() => ask("reject", [["reason", "What is missing against the criteria"]], (v) => post(`${base}/milestones/${m.index}/reject`, { reason: v.reason }), "Reject delivery")}>Reject</button>}
            </div>
          </li>
        ))}
      </ol>
      {me && dealNotes(deal, me, { pausedSentence }).map((n) => <p key={n.code} className="deal-hint" data-deal-note={n.code}>{n.text}</p>)}
      {digestRefused && <p className="deal-error" role="alert" data-deal-note="digest_mismatch">This deal's digest does not match the terms shown, so it cannot be signed here. Do not sign it; reload the page and check the terms again.</p>}
      {role && (
        <div className="deal-buttons deal-actions">
          {actions.includes("sign") && <button className="button ink" disabled={busy} onClick={() => ask("sign", [], () => post(`${base}/accept`, { dealDigest: deal.dealDigest, confirmBinding: true }), `Sign as ${role}: binding and public`)}>Sign deal</button>}
          {actions.includes("pay") && <button className="button ink" onClick={() => onPay?.()}>Review & pay</button>}
          {actions.includes("sign-payment") && <button className="button ink" onClick={() => onPayments?.()}>Confirm your payment</button>}
          {actions.includes("confirm-received") && <button className="button ink" onClick={() => onPayments?.()}>Confirm payment received</button>}
          {["refund", "dispute", "rate", "cancel"].some((a) => actions.includes(a)) && (
          <details className="deal-more">
            <summary>More options</summary>
          {actions.includes("refund") && <button className="button" disabled={busy} onClick={() => ask("refund", [["amount", "Amount in AI$"], ["reason", "Reason"]], (v) => post(`${base}/refunds`, v), role === "seller" ? "Offer a refund" : "Ask for a refund")}>Refund</button>}
          {actions.includes("dispute") && <button className="button" disabled={busy} onClick={() => ask("dispute", [["reason", "What went wrong"], ["desiredOutcome", "What would put it right", OUTCOME_CHOICES]], (v) => post(`${base}/disputes`, { reason: v.reason, desiredOutcome: (v.desiredOutcome || "other").trim() }), "Open a public dispute")}>Dispute</button>}
          {actions.includes("rate") && <button className="button" disabled={busy} onClick={() => ask("rate", [["score", "Score 1–5"], ["comment", "Comment (optional)"]], (v) => post(`${base}/rating`, { score: Number(v.score), ...(v.comment ? { comment: v.comment } : {}) }), "Rate the other party")}>Rate</button>}
          {actions.includes("cancel") && <button className="button" disabled={busy} onClick={() => ask("cancel", [["reason", "Reason"]], (v) => post(`${base}/cancel`, v), deal.status === "paid" ? "Ask to cancel (both must agree; the buyer is refunded)" : "Cancel deal")}>Cancel</button>}
          </details>
          )}
        </div>
      )}
      {prompt && (
        <form className="deal-form" onSubmit={(e) => { e.preventDefault(); prompt.submit(prompt.values); }}>
          <strong>{prompt.label}</strong>
          {prompt.kind === "sign" && <p className="deal-hint">You sign digest <code>{deal.dealDigest.slice(0, 16)}…</code> for {displayAmount(deal.price)} AI$ and {deal.milestones.length} milestone(s). Your signed request is published so anyone can verify it.</p>}
          {prompt.fields.map(([k, label, choices]) => (
            <label key={k}>{label}{choices ? (
              <select value={prompt.values[k] ?? ""} onChange={(e) => setPrompt({ ...prompt, values: { ...prompt.values, [k]: e.target.value } })}>
                <option value="">Choose…</option>
                {choices.map((c) => <option key={c} value={c}>{outcomeLabel(c)}</option>)}
              </select>
            ) : <input value={prompt.values[k] ?? ""} onChange={(e) => setPrompt({ ...prompt, values: { ...prompt.values, [k]: e.target.value } })} />}</label>
          ))}
          <div className="deal-buttons"><button className="button ink small" disabled={busy}>Confirm</button><button type="button" className="button small" onClick={() => setPrompt(null)}>Back</button></div>
        </form>
      )}
      {error && <p className="deal-error" role="alert">{error}</p>}
      {deal.refunds.length > 0 && (
        <div className="deal-block"><h4>Refunds</h4><ul>{deal.refunds.map((r) => <li key={r.id}>{displayAmount(r.amount)} AI$ · {refundSourceLabel(r.source)} · {dealPaymentLabel(r.request?.status)}</li>)}</ul></div>
      )}
      {dispute && <DisputeBlock identity={identity} disputeId={dispute.id} deal={deal} onChanged={load} />}
      <details className="deal-block"><summary>Public timeline ({deal.timeline.length})</summary>
        <ol className="deal-timeline">{deal.timeline.slice().reverse().map((e) => <li key={e.seq}><time>{when(e.at)}</time> <b>{eventLabel(e.type)}</b> {e.summary}</li>)}</ol>
      </details>
    </section>
  );
}

function DisputeBlock({ identity, disputeId, deal, onChanged }) {
  const [x, setX] = useState(null), [text, setText] = useState(""), [appeal, setAppeal] = useState("");
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState("");
  const load = () => api(`/api/trade/disputes/${disputeId}`).then((r) => { setX(r.dispute); setLoadError(""); }, () => setLoadError("We couldn't load the dispute."));
  useEffect(() => { load(); }, [disputeId, deal.updatedAt]);
  if (!x) return loadError ? <div className="deal-block deal-dispute"><p className="deal-error" role="alert">{loadError} <button className="link" onClick={load}>Try again</button></p></div> : null;
  const me = identity?.address, party = [deal.seller, deal.buyer].includes(me);
  const post = (path, body) => run(async () => { await api(path, { identity, method: "POST", body: { clientRequestId: intent("dispute"), ...body } }); setText(""); setAppeal(""); await load(); await onChanged(); });
  const d = x.appealDecision ?? x.decision;
  return (
    <div className="deal-block deal-dispute">
      <h4>Dispute · {disputeLabel(x.status)}</h4>
      <p>{x.reason} <small>(asked for: {outcomeLabel(x.desiredOutcome)})</small></p>
      <ul className="deal-evidence">{x.evidence.map((e) => <li key={e.id}><b>{e.role}</b> {e.statement}{e.url && <> · <a href={e.url} target="_blank" rel="noreferrer noopener">link</a></>}</li>)}</ul>
      {d && <div className="deal-decision"><b>{x.appealDecision ? "Appeal decision" : "UAIN decision"}: {decisionLabel(d.outcome)}</b>{d.refundAmount ? ` · ${displayAmount(d.refundAmount)} AI$` : ""}. {d.reasons} <details className="deal-tech"><summary>Details</summary><small>Policy {d.policyClauses.join(", ")}{x.decision?.model ? ` · ${x.decision.model}` : ""}{x.appealDecision ? ` · appeal ${x.appealDecision.result}` : ""}</small></details></div>}
      {party && ["open", "appealed"].includes(x.status) && (
        <form className="deal-form" onSubmit={(e) => { e.preventDefault(); post(`/api/trade/disputes/${x.id}/evidence`, { statement: text }); }}>
          <label>Add evidence<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <button className="button small" disabled={busy || !text.trim()}>File evidence</button>
        </form>
      )}
      {party && x.status === "decided" && (
        <form className="deal-form" onSubmit={(e) => { e.preventDefault(); if (appeal.trim()) post(`/api/trade/disputes/${x.id}/appeal`, { reason: appeal.trim() }); }}>
          <label>Disagree with the decision? Say why (you can appeal until {when(x.appealDeadline)})<textarea rows={2} value={appeal} onChange={(e) => setAppeal(e.target.value)} /></label>
          <button className="button small" disabled={busy || !appeal.trim()}>Appeal the decision</button>
        </form>
      )}
      {error && <p className="deal-error" role="alert">{error}</p>}
    </div>
  );
}

/** Public deals and feed; every member's deals, payments, disputes and decisions are visible. */
export default function TradeDeals({ identity, onPay, onPayments, onProfile, open: initial = null, pausedSentence = null }) {
  const [view, setView] = useState(identity ? "mine" : "feed"), [rows, setRows] = useState(null), [open, setOpen] = useState(initial), [error, setError] = useState("");
  useEffect(() => { setOpen(initial); }, [initial]);
  useEffect(() => {
    let live = true; setRows(null); setError("");
    const path = view === "feed" ? "/api/trade/feed?pageSize=30" : view === "disputes" ? "/api/trade/disputes?pageSize=30" : `/api/trade/deals?pageSize=30${view === "mine" && identity ? `&member=${identity.address}` : ""}`;
    api(path).then((r) => live && setRows(r)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [view, identity?.address, open]);
  if (open) return <DealView identity={identity} id={open} onClose={() => setOpen(null)} onPay={onPay} onPayments={onPayments} onProfile={onProfile} pausedSentence={pausedSentence} />;
  return (
    <section className="card trade-panel deal-panel">
      <header className="trade-head"><div><h2>Deals</h2><p>Every Trade deal is public: signed terms, payment, delivery, refunds, disputes and the UAIN steward decisions.</p></div></header>
      <div className="deal-tabs" role="tablist">
        {[["mine", "My deals"], ["all", "All deals"], ["feed", "Live feed"], ["disputes", "Disputes"]].filter(([k]) => identity || k !== "mine").map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {error && <p className="deal-error" role="alert">{error}</p>}
      {!rows && !error && <p role="status">Loading…</p>}
      {rows?.deals && (rows.deals.length ? (
        <ul className="deal-list">{rows.deals.map((d) => { const st = dealStatus(d.status); return (
          <li key={d.id}><button onClick={() => setOpen(d.id)}>
            <span className="deal-title">{d.title}</span>
            <span className={`deal-pill ${st.tone}`}>{st.label}</span>
            <span className="deal-meta">{displayAmount(d.price)} AI$ · {shortAddress(d.seller)} → {shortAddress(d.buyer)} · {d.milestonesConfirmed}/{d.milestoneCount} confirmed</span>
          </button></li>); })}</ul>
      ) : <p>No deals yet. A deal starts from terms you agree in an enquiry under Trade.</p>)}
      {rows?.events && <ol className="deal-timeline deal-feed">{rows.events.map((e, i) => <li key={`${e.type}-${e.seq ?? i}-${e.at}`}><time>{when(e.at)}</time> <b>{eventLabel(e.type)}</b> {e.summary} {e.dealId && <button className="link" onClick={() => setOpen(e.dealId)}>open</button>}</li>)}</ol>}
      {rows?.disputes && (rows.disputes.length ? <ul className="deal-list">{rows.disputes.map((x) => <li key={x.id}><button onClick={() => setOpen(x.dealId)}><span className="deal-title">{outcomeLabel(x.desiredOutcome)}</span><span className="deal-pill alert">{disputeLabel(x.status)}</span><span className="deal-meta">opened {when(x.openedAt)}{x.outcome ? ` · ${x.outcome}` : ""}</span></button></li>)}</ul> : <p>No disputes.</p>)}
    </section>
  );
}
