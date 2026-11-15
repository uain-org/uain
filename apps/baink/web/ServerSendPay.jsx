import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./identity.js";
import { displayAmount } from "./exact-amount.js";
import { networkPins } from "./network-pins.js";
import {
  amountToUnits, unitsToAmount, buildSendIntent, signSendIntent,
  signPreparedCommand, signReceipt, signReceivingAddress, sendStatus, readyToSign,
} from "./server-send.js";
import { signReceivingKey } from "./orchard-receiving.js";

const ADDRESS = /^uain1[a-f0-9]{40}$/;
// Earlier payment attempts from the retired device wallet (9 Nov 2026). One that
// was never sent, or was proved unused, can be abandoned so its request is free.
const WALLET_CLOSED = ["abandoned", "ledger-recorded", "recipient-confirmed-paid"];
const releasable = (i) => i.status === "expired-unused" || (!i.envelope && !i.sendAttemptedAt);
const short = (a) => (a ? a.slice(0, 10) + "…" + a.slice(-4) : "");

/** Pay without installing anything: sign in this browser, the UAIN server
 * builds and relays, and this screen follows the payment to the ledger. */
export default function ServerSendPay({ identity, account, config, onToast, onChanged }) {
  const [sends, setSends] = useState([]);
  const [enabled, setEnabled] = useState(null);
  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState({ to: "", amount: "", memo: "", requestId: null });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [receiving, setReceiving] = useState({ loaded: false, address: null, draft: "" });
  const [walletAttempts, setWalletAttempts] = useState([]);
  const signing = useRef(new Set());
  const pins = networkPins(config, account);
  const me = identity?.address;

  const load = useCallback(async () => {
    if (!identity) return;
    try {
      const [list, open, mine, wallet] = await Promise.all([
        api("/api/native/sends", { identity }),
        api("/api/requests?direction=incoming&status=open", { identity }).catch(() => ({ requests: [] })),
        api(`/api/native/receiving-address/${identity.address}`, { identity }).catch(() => null),
        api("/api/native/payments", { identity }).catch(() => ({ intents: [] })),
      ]);
      setSends(list.sends || []);
      setEnabled(list.enabled === true);
      setRequests((open.requests || []).filter((r) => r.currency === "AI$" && r.status === "open"));
      setReceiving((r) => ({ ...r, loaded: true, address: mine?.address ?? null }));
      setWalletAttempts((wallet.intents || []).filter((i) => i.payer === identity.address && !WALLET_CLOSED.includes(i.status) && releasable(i)));
    } catch (e) {
      setError(e.message);
    }
  }, [identity]);

  // Sign any prepared command that matches an intent this member signed.
  const signReady = useCallback(async (list) => {
    for (const s of list) {
      // Only this payer's live, unspent sends; signPreparedCommand repeats every check (FE-4).
      if (!readyToSign(s, me) || signing.current.has(s.id + ":" + s.current?.n)) continue;
      signing.current.add(s.id + ":" + s.current?.n);
      try {
        const body = await signPreparedCommand(identity, s);
        await api(`/api/native/sends/${s.id}/sign`, { identity, method: "POST", body });
      } catch (e) {
        setError(e.message);
      }
    }
  }, [identity, me]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const active = sends.some((s) => !sendStatus(s, me).final || sendStatus(s, me).needsMe);
    if (!active) return undefined;
    void signReady(sends);
    const timer = setTimeout(async () => {
      for (const s of sends.filter((x) => !sendStatus(x, me).final)) {
        await api(`/api/native/sends/${s.id}/refresh`, { identity, method: "POST", body: {} }).catch(() => {});
      }
      load();
    }, 4000);
    return () => clearTimeout(timer);
  }, [sends, me, identity, load, signReady]);

  async function pay(event) {
    event.preventDefault();
    setError("");
    setBusy("pay");
    try {
      if (!ADDRESS.test(form.to.trim())) throw Error("Enter the recipient's member address (uain1…).");
      const units = amountToUnits(form.amount);
      const target = await api(`/api/native/receiving-address/${form.to.trim()}`, { identity });
      if (!target.address) throw Error("This member can't receive AI$ yet. Ask them to open Send money and choose Set up receiving.");
      const intent = buildSendIntent({ pins, from: me, to: form.to.trim(), recipientAddress: target.address, amountUnits: units, requestId: form.requestId, memo: form.memo });
      const body = await signSendIntent(identity, intent);
      await api("/api/native/sends", { identity, method: "POST", body });
      setForm({ to: "", amount: "", memo: "", requestId: null });
      onToast?.("Payment signed. Preparing it now.");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function abandonWalletAttempt(intent) {
    setError("");
    setBusy("abandon" + intent.id);
    try {
      await api(`/api/native/payments/${intent.id}/abandon`, { identity, method: "POST", body: {} });
      onToast?.("Earlier attempt released. Nothing was sent.");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function act(s, kind) {
    setError("");
    setBusy(s.id + kind);
    try {
      const body = kind === "confirm" ? await signReceipt(identity, s) : {};
      await api(`/api/native/sends/${s.id}/${kind}`, { identity, method: "POST", body });
      if (kind === "confirm") onToast?.("Receipt confirmed");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function setUpReceiving() {
    setError("");
    setBusy("receiving");
    try {
      const body = await signReceivingKey(identity, { chainId: pins?.chainId });
      const saved = await api("/api/native/receiving-key", { identity, method: "POST", body });
      setReceiving({ loaded: true, address: saved.address, draft: "" });
      onToast?.("You can now be paid");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function saveReceiving(event) {
    event.preventDefault();
    setError("");
    setBusy("receiving");
    try {
      const body = await signReceivingAddress(identity, { address: receiving.draft.trim().toLowerCase(), chainId: pins?.chainId });
      const saved = await api("/api/native/receiving-address", { identity, method: "POST", body });
      setReceiving({ loaded: true, address: saved.address, draft: "" });
      onToast?.("Receiving address saved");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }

  if (!identity) return null;
  return (
    <section className="panel server-send" aria-labelledby="pay-title">
      <h2 id="pay-title">Pay</h2>
      <p className="fine-print">
        You sign here; UAIN does the rest. Nothing moves without your signature. The amount and your account are public; the recipient is not.
      </p>
      {enabled === false && <p className="status-note" role="status">Sending is paused right now. You can still set up receiving.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {requests.length > 0 && (
        <div className="ss-requests">
          <h3>Requests to pay</h3>
          <ul className="nw-list">
            {requests.map((r) => (
              <li key={r.id}>
                <span>{displayAmount(r.amount)} AI$ to {short(r.from)}{r.memo ? ` · ${r.memo}` : ""}</span>
                <button type="button" className="button small" onClick={() => setForm({ to: r.from, amount: String(r.amount), memo: "", requestId: r.id })}>
                  Pay this
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form className="ss-form" onSubmit={pay}>
        <label className="field">
          <span>To (member address)</span>
          <input inputMode="text" autoComplete="off" spellCheck={false} value={form.to} disabled={!!form.requestId}
            onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="uain1…" />
        </label>
        <label className="field">
          <span>Amount (AI$)</span>
          <input inputMode="decimal" value={form.amount} disabled={!!form.requestId}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="25" />
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input value={form.memo} maxLength={200} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
        </label>
        {form.requestId && (
          <p className="fine-print">Paying {form.amount} AI$ to {short(form.to)} for their request. <button type="button" className="text-link" onClick={() => setForm({ to: "", amount: "", memo: "", requestId: null })}>Clear</button></p>
        )}
        <button className="button ink" disabled={busy === "pay" || enabled !== true || !pins}>
          {busy === "pay" ? "Signing…" : "Sign and pay"}
        </button>
        {enabled !== false && (enabled !== true || !pins) && (
          <p className="fine-print" role="status">Checking the network… Sign and pay turns on in a moment.</p>
        )}
      </form>

      {sends.length > 0 && (
        <div className="ss-list">
          <h3>Your payments</h3>
          <ul className="nw-list">
            {sends.map((s) => {
              const st = sendStatus(s, me), out = s.intent.from === me;
              return (
                <li key={s.id} className={st.final ? "final" : "active"}>
                  <div>
                    <strong>{out ? "To" : "From"} {short(out ? s.intent.to : s.intent.from)} · {unitsToAmount(s.intent.amountUnits)} AI$</strong>
                    <div role="status" aria-live="polite"><span className="ss-badge">{st.label}</span> {st.detail}</div>
                  </div>
                  <div className="nw-actions">
                    {!out && s.status === "finalized" && !s.recipientConfirmation && (
                      <button type="button" className="button small" disabled={busy === s.id + "confirm"} onClick={() => act(s, "confirm")}>Confirm received</button>
                    )}
                    {out && !st.final && s.status !== "cancel-requested" && (
                      <button type="button" className="button small" disabled={busy === s.id + "cancel"} onClick={() => act(s, "cancel")}>Cancel</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {walletAttempts.length > 0 && (
        <div className="ss-requests">
          <h3>Unfinished earlier payments</h3>
          <p className="fine-print">
            These were never sent, so nothing was paid. Release one to pay its request here instead.
          </p>
          <ul className="nw-list">
            {walletAttempts.map((i) => (
              <li key={i.id}>
                <span>{unitsToAmount(i.amountUnits)} AI$ to {short(i.payee)}{i.requestId ? " (request)" : ""}</span>
                <button type="button" className="button small" disabled={busy === "abandon" + i.id} onClick={() => abandonWalletAttempt(i)}>Release</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="ss-receiving" open={receiving.loaded && !receiving.address}>
        <summary>{receiving.address ? "Receiving is set up" : "Set up receiving"}</summary>
        {receiving.address ? (
          <p className="fine-print">Payments to you arrive at {short(receiving.address)}.</p>
        ) : (
          <>
          <p className="fine-print">
            One step, nothing to install. Your receiving key comes from your account key on this device and never leaves it;
            UAIN gets only the part that lets it see payments to you. Your account backup also restores it.
          </p>
          <button type="button" className="button small" disabled={busy === "receiving" || !pins} onClick={setUpReceiving}>Set up receiving</button>
          <form onSubmit={saveReceiving}>
            <p className="fine-print">Already have a receiving address? Paste it here instead.</p>
            <label className="field">
              <span>Receiving address</span>
              <input value={receiving.draft} spellCheck={false} autoComplete="off" onChange={(e) => setReceiving({ ...receiving, draft: e.target.value })} />
            </label>
            <button className="button small" disabled={busy === "receiving" || !pins}>Save</button>
          </form>
          </>
        )}
      </details>
    </section>
  );
}
