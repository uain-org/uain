import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LockKeyhole, RefreshCw } from "lucide-react";
import { api } from "./identity.js";
import { decimalToUnits, displayUnits } from "./exact-amount.js";
import { nativeProofFreshness } from "./native-balance.js";
import { signNativeEarningIntent } from "./native-financial.js";
import { networkPins } from "./network-pins.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const EVENT = /^[0-9]{1,20}$/;
const HASH = /^[a-f0-9]{64}$/;

const blockerText = {
  storage_activation_inactive: "Compact storage is not active on the network.",
  membership_activation_inactive: "Project membership is not active.",
  operator_reward_activation_inactive: "Operator rewards are not active.",
  private_activation_inactive: "Private payments are not active.",
  coin_activation_inactive: "Native AI$ rewards are not active.",
  coin_supply_unavailable: "The AI$ supply record is unavailable.",
  native_licence_inactive: "Your UAIN licence is not active.",
  native_task_required: "No matching task on the network.",
  prospective_native_policies_required:
    "The task was not opened under the current reward rules.",
  project_safety_halted: "The project is halted for safety.",
  unresolved_or_upheld_prior_art: "A prior-art challenge is open or upheld.",
  post_activation_native_opening_required:
    "The task was not opened after rewards went live.",
  unstarted_active_task_required: "The task is no longer open and unstarted.",
  kpi_expired_or_unresolved: "The task's measurable target has lapsed.",
  reservation_already_exists: "A reward is already reserved for this task.",
  project_lead_required: "Only the project lead can price this task.",
  project_participation_required: "You have not joined this project.",
  quote_already_exists: "This task is already priced.",
  opening_event_mismatch: "The opening event does not match the task.",
  valid_native_quote_required: "The task has no valid price yet.",
  guardian_required: "Only a current guardian can reserve a reward.",
  insufficient_unreserved_supply: "Not enough unreserved AI$ supply.",
  winning_author_required: "Only the winning author can claim.",
  settled_unwithheld_winner_required: "The result is not settled as the winner.",
  fully_paid_native_settlement_required: "The settlement is not fully paid.",
  two_independent_operators_required: "Two independent operators must check it.",
  other_model_family_required: "A checker from another model family is needed.",
  frozen_new_novelty_checks_required:
    "Independent checkers have not all confirmed the result is new.",
  unpaid_native_reservation_required: "No reserved reward is waiting.",
  reward_already_claimed: "This reward was already claimed.",
};
const requirementText = {
  genuine_unsolved_problem_and_new_result:
    "A genuinely unsolved problem and a result checkers attest is new",
  reviewer_default_appointment: "An appointed default checker",
  two_independent_operators: "Two independent operators",
  other_model_family: "A checker from another model family",
  reservation_before_submission: "The reward reserved before work is submitted",
  no_unresolved_prior_art_or_safety_challenges:
    "No open prior-art or safety challenge",
  future_kpi_met_before_claim: "Any measurable target met before claiming",
};
const opLabel = {
  coin_quote: "Price a task",
  coin_reserve: "Reserve a reward",
  coin_claim: "Claim a reward",
};
const errorText = {
  native_sequence_pending:
    "An earlier step is still waiting for its receipt. Check it first.",
  native_earning_disabled:
    "This deployment does not submit earning steps yet.",
  native_proof_unavailable:
    "A current network proof is unavailable. Try again shortly.",
  earning_intent_pending:
    "An earlier step is still waiting for its receipt. Check it first.",
  earning_intent_expired:
    "This signing window closed. Prepare the step again.",
  native_sequence_changed:
    "Your account changed on the network. Prepare the step again.",
};
const plain = (e) =>
  errorText[e?.code] ||
  blockerText[e?.code] ||
  e?.message ||
  "Something went wrong. Try again.";
// Exact micro-AI$ to display text, e.g. "1100000" -> "1.1" (shared formatter).
const units = displayUnits;

// Answers to an explicit expiry check. Each one says nothing changed.
const recoveryErrorText = {
  earning_recovery_not_ready:
    "The network has not passed this step's expiry yet, so it may still be used. Nothing changed. Check the receipt again later.",
  native_proof_unavailable:
    "A current network proof is unavailable, so the expiry could not be confirmed. Nothing changed. Try again shortly.",
  earning_not_submitted:
    "This step was never sent, so there is nothing to check. Nothing changed.",
};
const RECOVERY_SCHEMA = "baink-native-earning-recovery-v1";
const sorted = (v) =>
  Array.isArray(v)
    ? `[${v.map(sorted).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${sorted(v[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
// Sent, not finalized, and not already shown as expired: an expiry check may help.
const recoverable = (i) =>
  !!i.sendAttemptedAt &&
  i.status !== "expired-unused" &&
  !i.result?.verified;
// The service's answer is accepted only if it is a verified, unpaid expiry of
// this same intent with its original signed command kept.
function recoveredIntent(original, data) {
  const next = data?.intent,
    r = next?.recovery;
  const ok =
    next?.id === original.id &&
    next.status === "expired-unused" &&
    r?.schema === RECOVERY_SCHEMA &&
    r.verified === true &&
    r.status === "expired-unused" &&
    r.paid === false &&
    r.recordPresent === false &&
    r.commandDigest === original.commandDigest &&
    r.sequence === original.command.sequence &&
    r.expiresHeight === original.command.expires_height &&
    !!r.proof &&
    next.commandDigest === original.commandDigest &&
    next.transactionHash === original.transactionHash &&
    next.sendAttemptedAt === original.sendAttemptedAt &&
    sorted(next.envelope) === sorted(original.envelope) &&
    sorted(next.command) === sorted(original.command);
  if (!ok)
    throw new Error(
      "The expiry answer could not be checked in this browser. Nothing changed here.",
    );
  return next;
}

function resultLabel(intent) {
  // Never earned or paid, whatever any other field says.
  if (intent.status === "expired-unused")
    return "Expired without being used · not earned, not paid";
  const r = intent.result;
  if (r?.verified && r.paid) return `Earned ${units(r.amountUnits)} AI$, paid`;
  if (r?.verified && r.status === "reserved")
    return `Reserved ${units(r.amountUnits)} AI$, not yet earned`;
  if (r?.verified && r.status === "quoted")
    return `Priced at ${units(r.amountUnits)} AI$, not money`;
  if (intent.receiptRequired) return "Sent, receipt pending";
  return intent.status === "prepared" ? "Ready to sign" : intent.status;
}

/** Native AI$ earning: real reserved rewards only, never planning records. */
export default function NativeEarning({ identity, account, config, onToast, onRefresh }) {
  const [readiness, setReadiness] = useState(null);
  const [found, setFound] = useState(null);
  const [intents, setIntents] = useState([]);
  const [fields, setFields] = useState({
    operation: "coin_reserve",
    task: "",
    openEvent: "",
    amount: "",
    evidence: "",
    contribution: "",
  });
  const [reviewed, setReviewed] = useState(null);
  const [busy, setBusy] = useState(false);
  useReleaseBusy(busy);
  const [error, setError] = useState("");
  // The intent whose expiry check the member opened, and the last confirmed one.
  const [recovering, setRecovering] = useState(null);
  const [recovered, setRecovered] = useState(null);
  const session = useRef(0);
  const request = useRef(null);
  const refreshedAwards = useRef(new Set());

  const pins = networkPins(config, account);
  const enabled = config?.nativeEarning?.enabled === true;
  const licensed =
    account?.native?.verified === true &&
    nativeProofFreshness(account.native.proof).fresh &&
    account.native.memberStatus === "active";

  const act = async (fn) => {
    if (busy) return;
    const ticket = session.current;
    const live = () => session.current === ticket;
    setBusy(true);
    setError("");
    try {
      await fn(live);
    } catch (e) {
      if (live()) setError(plain(e));
    } finally {
      if (live()) setBusy(false);
    }
  };
  const save = (intent) =>
    setIntents((rows) => [intent, ...rows.filter((r) => r.id !== intent.id)]);

  // Each answer stands on its own: a failed discovery never reads as "none".
  const check = (selection = {}) =>
    act(async (live) => {
      const [ready, discovered, list] = await Promise.allSettled([
        api("/api/native/earning/readiness", {
          identity,
          method: "POST",
          body: selection,
        }),
        api("/api/native/earning/discover", {
          identity,
          method: "POST",
          body: { afterEvent: "0" },
        }),
        api("/api/native/earning", { identity }),
      ]);
      if (!live()) return;
      if (ready.status === "fulfilled") setReadiness(ready.value);
      if (discovered.status === "fulfilled") setFound(discovered.value);
      else setFound(null);
      if (list.status === "fulfilled") setIntents(list.value.intents || []);
      const failed = [ready, discovered, list].find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
    });

  useEffect(() => {
    session.current++;
    setReadiness(null);
    setFound(null);
    setIntents([]);
    setReviewed(null);
    setRecovering(null);
    setRecovered(null);
    setError("");
    request.current = null;
    if (identity && licensed) check();
    return () => void session.current++;
  }, [identity, licensed]);

  const more = () =>
    act(async (live) => {
      const next = await api("/api/native/earning/discover", {
        identity,
        method: "POST",
        body: { afterEvent: found.scannedThrough },
      });
      if (live())
        setFound({
          ...next,
          opportunities: [...found.opportunities, ...next.opportunities],
        });
    });

  const payloadFor = () => {
    const f = fields;
    if (f.operation === "coin_claim") {
      if (!ID.test(f.contribution.trim()))
        throw new Error("Enter the contribution ID exactly.");
      return { contribution: f.contribution.trim() };
    }
    if (!ID.test(f.task.trim())) throw new Error("Enter the task ID exactly.");
    const evidence = f.evidence.trim().toLowerCase();
    if (!HASH.test(evidence))
      throw new Error("The evidence digest is 64 lowercase hex characters.");
    if (f.operation === "coin_reserve")
      return { task: f.task.trim(), evidence_digest: evidence };
    if (!EVENT.test(f.openEvent.trim()) || BigInt(f.openEvent.trim()) <= 0n)
      throw new Error("Enter the task's opening event number.");
    let amount;
    try {
      amount = decimalToUnits(f.amount.trim());
      if (BigInt(amount) <= 0n) throw new Error();
    } catch {
      throw new Error("Enter a price above zero, up to six decimal places.");
    }
    return {
      task: f.task.trim(),
      open_event: f.openEvent.trim().padStart(20, "0"),
      amount,
      evidence_digest: evidence,
    };
  };

  const prepare = (e) => {
    e.preventDefault();
    act(async (live) => {
      const payload = payloadFor();
      const value = JSON.stringify({ operation: fields.operation, payload });
      if (!request.current || request.current.value !== value)
        request.current = { id: crypto.randomUUID(), value };
      const data = await api("/api/native/earning/prepare", {
        identity,
        method: "POST",
        body: {
          clientRequestId: request.current.id,
          operation: fields.operation,
          payload,
        },
      });
      if (!live()) return;
      save(data.intent);
      setReviewed({ intent: data.intent, operation: fields.operation, payload });
    });
  };

  const signAndSend = () =>
    act(async (live) => {
      const { intent, operation, payload } = reviewed;
      if (!enabled) throw Object.assign(new Error(), { code: "native_earning_disabled" });
      if (!pins) throw new Error("The network pins could not be read.");
      const envelope = await signNativeEarningIntent(identity, intent, {
        chainId: pins.chainId,
        genesisSha256: pins.genesisSha256,
        expectedOperation: operation,
        expectedPayload: payload,
      });
      if (!live()) return;
      const data = await api(
        `/api/native/earning/${encodeURIComponent(intent.id)}/submit`,
        { identity, method: "POST", body: { envelope } },
      );
      if (!live()) return;
      save(data.intent);
      setReviewed(null);
      request.current = null;
      onToast?.("Sent. Check the receipt for the result.");
    });

  const receipt = (intent) =>
    act(async (live) => {
      const data = await api(
        `/api/native/earning/${encodeURIComponent(intent.id)}/receipt`,
        { identity, method: "POST", body: {} },
      );
      if (!live()) return;
      const next = data.intent;
      save(next);
      if (
        next.finalized === true && next.status === "finalized" &&
        next.member === identity.address &&
        next.command?.operation === "coin_claim" &&
        next.result?.verified === true && next.result.paid === true &&
        next.result.status === "earned" &&
        !refreshedAwards.current.has(next.id)
      ) {
        refreshedAwards.current.add(next.id);
        await onRefresh?.();
      }
    });

  // Explicit click only: asks whether a sent step expired unused. It never
  // resends the original envelope or prepares a replacement.
  const reconcile = (intent) =>
    act(async (live) => {
      let data;
      try {
        data = await api(
          `/api/native/earning/${encodeURIComponent(intent.id)}/reconcile`,
          { identity, method: "POST", body: {} },
        );
      } catch (e) {
        if (recoveryErrorText[e?.code])
          throw new Error(recoveryErrorText[e.code]);
        throw e;
      }
      if (!live()) return;
      const next = recoveredIntent(intent, data);
      save(next);
      setRecovering(null);
      setRecovered(next.id);
      // A later step is new work with a new request ID, reviewed on its own.
      const same = sorted({
        operation: intent.command?.operation,
        payload: intent.command?.payload,
      });
      if (request.current && sorted(JSON.parse(request.current.value)) === same)
        request.current = null;
      setReviewed((r) => (r?.intent.id === intent.id ? null : r));
    });

  const bounties = found?.opportunities ?? [];
  // A bounded scan proves only the events it read, never the whole chain.
  const headline = !licensed
    ? "UAIN licence needed to check rewards"
    : !found
      ? "Check available rewards"
      : bounties.length
        ? `${bounties.length} funded ${bounties.length === 1 ? "bounty" : "bounties"} found${found.more ? " so far" : ""}`
        : found.more
          ? `No funded bounties in the first ${found.scannedThrough} events checked`
          : "No funded bounties on the network right now";
  const blockers = readiness?.policyBlockers ?? [];
  const actions = Object.entries(readiness?.actions ?? {});
  const set = (k) => (e) => setFields({ ...fields, [k]: e.target.value });

  return (
    <section className="panel native-earning" aria-label="Earn AI$">
      <div className="nw-head">
        <div>
          <span className="ne-eyebrow">Native AI$ rewards</span>
          <h3>{headline}</h3>
          <p>
            Rewards are paid only for new results that independent checkers
            confirm. A price or a reservation is not money until the claim is
            paid. Earned AI$ goes into your balance, and you can send it from
            Send money.
          </p>
        </div>
        <button
          type="button"
          className="button small"
          onClick={() => check()}
          disabled={busy || !licensed}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />{" "}
          {found ? "Check again" : "Check available rewards"}
        </button>
      </div>

      {!licensed && (
        <p className="status-note">
          <AlertCircle size={16} /> An active UAIN licence is needed to check
          native rewards.
        </p>
      )}

      {bounties.length > 0 && (
        <ul className="ne-bounties">
          {bounties.map((b) => (
            <li key={b.task}>
              <strong>{b.title}</strong>
              <span>
                {units(b.amountUnits)} AI$ reserved · not yet paid · review
                required
              </span>
              <code>{b.task}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="fine-print">
        The projects below are a planning catalogue, listed separately. None of
        them is a funded native bounty, and working on one earns no reward.
      </p>
      {found?.more && (
        <p className="fine-print">
          Checked up to event {found.scannedThrough}. More events exist.{" "}
          <button type="button" className="text-link" onClick={more} disabled={busy}>
            Scan further
          </button>
        </p>
      )}

      {readiness && (
        <>
          <ul className="nw-checks">
            <li className={blockers.length ? "missing" : "done"}>
              {blockers.length ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
              <span>
                <strong>Network reward rules</strong>
                <small>
                  {blockers.length
                    ? blockers.map((b) => blockerText[b] || b).join(" ")
                    : "All reward rules are active."}
                </small>
              </span>
            </li>
            <li className={readiness.account?.licence === "active" ? "done" : "missing"}>
              {readiness.account?.licence === "active" ? (
                <CheckCircle2 size={15} />
              ) : (
                <AlertCircle size={15} />
              )}
              <span>
                <strong>Your licence</strong>
                <small>
                  {readiness.account?.licence ?? "unknown"} · Karma{" "}
                  {readiness.account?.karma ?? "—"}
                </small>
              </span>
            </li>
            <li className={enabled ? "done" : "missing"}>
              {enabled ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
              <span>
                <strong>Submission</strong>
                <small>
                  {enabled
                    ? "Signed steps can be sent."
                    : "This deployment does not send earning steps yet."}
                </small>
              </span>
            </li>
          </ul>
          <details className="more">
            <summary>What a reward needs</summary>
            <ul className="ne-reqs">
              {(readiness.requirements ?? []).map((r) => (
                <li key={r}>{requirementText[r] || r}</li>
              ))}
            </ul>
          </details>
        </>
      )}

      {intents.length > 0 && (
        <ul className="ne-intents">
          {intents.map((i) => (
            <li key={i.id}>
              <span>
                <strong>{opLabel[i.command?.operation] || i.command?.operation}</strong>
                <small>
                  {i.command?.payload?.task || i.command?.payload?.contribution}
                </small>
              </span>
              <em
                className={
                  i.status !== "expired-unused" &&
                  i.result?.verified &&
                  i.result.paid
                    ? "paid"
                    : ""
                }
              >
                {resultLabel(i)}
              </em>
              {i.receiptRequired && i.status !== "expired-unused" && (
                <button
                  type="button"
                  className="small-action"
                  onClick={() => receipt(i)}
                  disabled={busy}
                >
                  Check receipt
                </button>
              )}
              {recoverable(i) && recovering !== i.id && (
                <button
                  type="button"
                  className="small-action"
                  onClick={() => setRecovering(i.id)}
                  disabled={busy}
                >
                  Check if it expired unused
                </button>
              )}
              {recoverable(i) && recovering === i.id && (
                <div className="ne-recovery" role="group" aria-label="Expiry check">
                  <p>
                    Check the receipt first. If it is still pending, this asks
                    the network whether the signing window closed without the
                    step being used. Nothing is resent, signed or paid, and the
                    original signed step is kept.
                  </p>
                  <div className="nw-actions">
                    <button
                      type="button"
                      className="button small"
                      onClick={() => setRecovering(null)}
                      disabled={busy}
                    >
                      Not now
                    </button>
                    <button
                      type="button"
                      className="button small ink"
                      onClick={() => reconcile(i)}
                      disabled={busy}
                    >
                      Check expiry
                    </button>
                  </div>
                </div>
              )}
              {i.status === "expired-unused" && recovered === i.id && (
                <p className="ne-recovery" role="status">
                  <CheckCircle2 size={15} /> The network confirms this step
                  expired without being used. Nothing was earned or paid. The
                  original signed step is kept here and was not resent. To try
                  again, prepare a new step under Advanced and review it on its
                  own.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <details className="technical-detail ne-advanced">
        <summary>Advanced: check or sign an exact step</summary>
        <form onSubmit={prepare}>
          <label className="field">
            Step
            <select value={fields.operation} onChange={set("operation")}>
              <option value="coin_quote">Price a task (project lead)</option>
              <option value="coin_reserve">Reserve a reward (guardian)</option>
              <option value="coin_claim">Claim a reward (winning author)</option>
            </select>
          </label>
          {fields.operation === "coin_claim" ? (
            <label className="field">
              Contribution ID
              <input value={fields.contribution} onChange={set("contribution")} spellCheck="false" />
            </label>
          ) : (
            <>
              <label className="field">
                Task ID
                <input value={fields.task} onChange={set("task")} spellCheck="false" />
              </label>
              {fields.operation === "coin_quote" && (
                <>
                  <label className="field">
                    Opening event
                    <input value={fields.openEvent} onChange={set("openEvent")} inputMode="numeric" />
                  </label>
                  <label className="field">
                    Price
                    <div className="amount-input">
                      <input value={fields.amount} onChange={set("amount")} inputMode="decimal" />
                      <span>AI$</span>
                    </div>
                  </label>
                </>
              )}
              <label className="field">
                Evidence digest (SHA-256)
                <input value={fields.evidence} onChange={set("evidence")} spellCheck="false" />
              </label>
            </>
          )}
          <div className="nw-actions">
            <button
              type="button"
              className="button"
              disabled={busy || !licensed}
              onClick={() => {
                const selection = {};
                if (fields.operation === "coin_claim" && ID.test(fields.contribution.trim()))
                  selection.contribution = fields.contribution.trim();
                else if (ID.test(fields.task.trim())) selection.task = fields.task.trim();
                if (fields.operation === "coin_quote" && EVENT.test(fields.openEvent.trim()))
                  selection.openEvent = fields.openEvent.trim().padStart(20, "0");
                check(selection);
              }}
            >
              Check eligibility
            </button>
            <button type="submit" className="button ink" disabled={busy || !licensed}>
              Prepare step
            </button>
          </div>
        </form>
        {actions.length > 0 && (
          <ul className="nw-checks">
            {actions.map(([op, a]) => (
              <li key={op} className={a.eligible ? "done" : "missing"}>
                {a.eligible ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                <span>
                  <strong>{opLabel[op]}</strong>
                  <small>
                    {a.eligible
                      ? "Eligible now."
                      : a.blockers.map((b) => blockerText[b] || b).join(" ")}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        {reviewed && (
          <div className="nw-review">
            <dl className="nw-exact">
              <dt>Step</dt>
              <dd>{opLabel[reviewed.operation]}</dd>
              {Object.entries(reviewed.payload).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k.replaceAll("_", " ")}</dt>
                  <dd>
                    <code>{k === "amount" ? `${units(v)} AI$` : v}</code>
                  </dd>
                </React.Fragment>
              ))}
              <dt>Expires at block</dt>
              <dd>{reviewed.intent.command?.expires_height}</dd>
            </dl>
            <button
              type="button"
              className="button ink"
              onClick={signAndSend}
              disabled={busy || !enabled}
            >
              <LockKeyhole size={15} /> Sign and send this step
            </button>
          </div>
        )}
      </details>

      {error && (
        <p className="form-error" role="alert">
          <AlertCircle size={16} /> {error}
        </p>
      )}
    </section>
  );
}
