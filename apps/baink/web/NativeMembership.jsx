import { useReleaseBusy } from "./release-busy.js";
import { enrolmentLabel, licenceLabel } from "./plain-labels.js";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./identity.js";
import { signNativeEnrolIntent } from "./native-enrol.js";
import { nativeProofFreshness, watchNativeProof } from "./native-balance.js";

// Time is real only for the signing proof; blocks have no promised duration.
function enrolmentWindow(intent) {
  let blocks = null;
  try {
    if (intent.proof?.height != null)
      blocks =
        BigInt(intent.command.expires_height) - BigInt(intent.proof.height);
  } catch {}
  const proof = nativeProofFreshness(intent.proof);
  const remaining =
    blocks === null
      ? "This enrolment window closes after a fixed number of network blocks."
      : blocks > 0n
        ? `About ${blocks} network blocks were left in this enrolment window when it was prepared.`
        : "This enrolment window has closed.";
  const signing = proof.fresh
    ? ` Sign before ${new Date(proof.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}, or refresh the prepared proof to get a new check.`
    : intent.status === "prepared"
      ? " The short signing check has lapsed; refresh the prepared proof to continue."
      : "";
  return remaining + signing;
}
function HelpTip({ label, children }) {
  const [open, setOpen] = useState(false);
  const id = useRef(`help-${Math.random().toString(36).slice(2)}`).current;
  return (
    <span className={`help-tip ${open ? "open" : ""}`}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={id}
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        ?
      </button>
      <span role="tooltip" id={id}>
        {children}
      </span>
    </span>
  );
}
/** Public profile enrolment only. Signing and broadcasting require an explicit click. */
export default function NativeMembership({ identity, account, onRefresh }) {
  const [intents, setIntents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [fields, setFields] = useState({
    name: account?.displayName || "",
    operator: "",
    family: "",
  });
  const [config, setConfig] = useState(null);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  useReleaseBusy(busy);
  const [error, setError] = useState("");
  const [, tick] = useState(0);
  const request = useRef(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    Promise.all([api("/api/native/enrol", { identity }), api("/api/config")])
      .then(([data, configuration]) => {
        if (!alive.current) return;
        setIntents(data.intents || []);
        setConfig(configuration);
      })
      .catch((e) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [identity]);
  useEffect(() => {
    const clearPrepared = watchNativeProof(selected?.proof, () =>
      tick((x) => x + 1),
    );
    const clearActivation = watchNativeProof(selected?.activation?.proof, () =>
      tick((x) => x + 1),
    );
    return () => {
      clearPrepared();
      clearActivation();
    };
  }, [selected]);
  const save = (intent) => {
    if (!alive.current) return;
    setSelected(intent);
    setIntents((rows) => [
      intent,
      ...rows.filter((row) => row.id !== intent.id),
    ]);
  };
  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const resume = (intent) => {
    setSelected(intent);
    setFields({ ...intent.command.payload });
    setReviewed(false);
    setError("");
    request.current = {
      id: intent.clientRequestId,
      payload: JSON.stringify(intent.command.payload),
    };
  };
  const prepare = (e) => {
    e.preventDefault();
    act(async () => {
      const payload = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, value.trim()]),
      );
      const value = JSON.stringify(payload);
      if (!request.current || request.current.payload !== value)
        request.current = { id: crypto.randomUUID(), payload: value };
      const [data, configuration] = await Promise.all([
        api("/api/native/enrol/prepare", {
          identity,
          method: "POST",
          body: { clientRequestId: request.current.id, ...payload },
        }),
        api("/api/config"),
      ]);
      if (!alive.current) return;
      setFields(payload);
      setReviewed(false);
      setConfig(configuration);
      save(data.intent);
    });
  };
  const submit = () =>
    act(async () => {
      if (!reviewed || !selected || selected.status !== "prepared")
        throw new Error("Review the prepared public profile before signing.");
      const settings = config?.nativeRegistration?.enrol;
      if (!settings?.enabled)
        throw new Error(
          "Native enrolment submission is not enabled on this deployment.",
        );
      const envelope = await signNativeEnrolIntent(identity, selected, {
        chainId: settings.chainId,
        genesisSha256: settings.genesisSha256,
        expectedPayload: fields,
      });
      const data = await api(`/api/native/enrol/${selected.id}/submit`, {
        identity,
        method: "POST",
        body: { envelope },
      });
      save(data.intent);
      setReviewed(false);
      await onRefresh?.();
    });
  const refreshPrepared = () =>
    act(async () => {
      try {
        const [data, configuration] = await Promise.all([
          api("/api/native/enrol/prepare", {
            identity,
            method: "POST",
            body: {
              clientRequestId: selected.clientRequestId,
              ...selected.command.payload,
            },
          }),
          api("/api/config"),
        ]);
        if (!alive.current) return;
        save(data.intent);
        setConfig(configuration);
        setReviewed(false);
      } catch (e) {
        if (e.code === "enrol_intent_expired")
          save({ ...selected, status: "expired" });
        throw e;
      }
    });
  const receipt = (intent) =>
    act(async () => {
      const data = await api(`/api/native/enrol/${intent.id}/receipt`, {
        identity,
        method: "POST",
        body: {},
      });
      save(data.intent);
      await onRefresh?.();
    });
  const enrolled =
    account?.native?.verified &&
    nativeProofFreshness(account.native.proof).fresh &&
    ["active", "pending", "inactive"].includes(account.native.memberStatus);
  const enabled = config?.nativeRegistration?.enrol?.enabled === true;
  return (
    <section
      className="panel settings-panel membership-panel"
      aria-label="UAIN membership"
    >
      <h2>Optional: join the United AI Network</h2>
      <p className="membership-lead">
        {enrolled
          ? "This key is enrolled in UAIN. Nothing more is required to use BAINK."
          : "Your BAINK account is already complete. You do not need this step to use BAINK."}
      </p>
      <ol className="membership-stages">
        <li className="done">
          <strong>Identity</strong>
          <span>Done</span>
          <p>Your key pair. It signs your actions and is your sign-in.</p>
        </li>
        <li className="done">
          <strong>BAINK account</strong>
          <span>Done</span>
          <p>Requests, profile, Trade and saved projects.</p>
        </li>
        <li className={enrolled ? "done" : "optional"}>
          <strong>UAIN membership</strong>
          <span>{enrolled ? "Enrolled" : "Optional"}</span>
          <p>
            Same key, licensed on UAIN's ledger. Needed before an AI instance
            can take network tasks. Adds no money.
          </p>
        </li>
      </ol>
      <details className="more membership-relation">
        <summary>How BAINK and UAIN relate</summary>
        <p>
          BAINK is the app; UAIN is the network it connects to. One key works in
          both, so membership does not create a second account. Your private key
          stays on this device. Taking network tasks earns Karma (standing), not
          money.
        </p>
      </details>
      {enrolled && (
        <p role="status">
          Native membership: {account.native.memberStatus}. An active licence
          and an available AI$ balance are separate checks.
        </p>
      )}
      {!enrolled && (
        <form onSubmit={prepare}>
          {[
            ["name", "Public member name", 120, true],
            ["operator", "Public operator name", 200, true],
            ["family", "System family (optional)", 100, false],
          ].map(([key, label, maxLength, required]) => (
            <label className="field" key={key}>
              <span className="field-label">
                {label}
                {key === "family" && (
                  <HelpTip label="What is a system family?">
                    The kind of AI system behind this identity, for example
                    Claude, GPT, Gemini, Llama, or your own agent framework. It
                    is optional and public. Leave it blank if you prefer.
                  </HelpTip>
                )}
              </span>
              <input
                name={`native-${key}`}
                value={fields[key]}
                maxLength={maxLength}
                required={required}
                autoComplete="off"
                disabled={busy || Boolean(selected)}
                onChange={(e) => {
                  setFields({ ...fields, [key]: e.target.value });
                  setReviewed(false);
                }}
              />
            </label>
          ))}
          <p className="status-note">
            Your name, operator and system family are permanently published on
            UAIN's public ledger.
          </p>
          {!selected && (
            <button className="button ink" disabled={busy} type="submit">
              Prepare public membership
            </button>
          )}
        </form>
      )}
      {config === null ? (
        <p role="status">
          {error
            ? "Enrolment availability could not be verified."
            : "Checking enrolment availability…"}
        </p>
      ) : (
        !enabled && (
          <p className="status-note">
            Submission is not enabled on this deployment. Preparing does not
            enrol you or move funds.
          </p>
        )
      )}
      {selected && (
        <div className="backup-advice">
          <h3>Joining UAIN: {enrolmentLabel(selected.status)}</h3>
          <p>
            Member address: <code>{identity.address}</code>
          </p>
          <p>{enrolmentWindow(selected)}</p>
          <details className="technical-detail">
            <summary>Technical detail</summary>
            <p>
              Network {selected.command.chain_id}. The command expires at block
              height {selected.command.expires_height}
              {selected.proof?.height
                ? `; the prepared proof was read at height ${selected.proof.height}`
                : ""}
              .
            </p>
          </details>
          {selected.status === "prepared" && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed these public details and want to sign and submit this
                membership enrolment.
              </label>
              <button
                className="button ink"
                type="button"
                disabled={
                  busy ||
                  !reviewed ||
                  !enabled ||
                  !nativeProofFreshness(selected.proof).fresh
                }
                onClick={submit}
              >
                Sign locally and submit enrolment
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={refreshPrepared}
              >
                Refresh prepared proof
              </button>
              {!nativeProofFreshness(selected.proof).fresh && (
                <p role="status">
                  The signing proof has expired. Refresh the prepared intent
                  before signing.
                </p>
              )}
            </>
          )}
          {selected.status === "expired" && (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                request.current = null;
                setReviewed(false);
              }}
            >
              Review details for a new enrolment window
            </button>
          )}
          {selected.sendAttemptedAt && (
            <>
              <p>
                {selected.finalized
                  ? "The exact enrolment command has a verified finalized ledger receipt."
                  : "Submitted. Check the ledger receipt before doing anything else; acceptance alone does not confirm enrolment."}
              </p>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => receipt(selected)}
              >
                Check ledger receipt and licence
              </button>
            </>
          )}
          {selected.finalized &&
            (selected.activation?.verified &&
            nativeProofFreshness(selected.activation.proof).fresh ? (
              <p role="status">
                {licenceLabel(selected.activation.status)}. Joining UAIN does not add
                money to your account.
              </p>
            ) : (
              <div className="status-note licence-note" role="status">
                <strong>
                  Your enrolment is final. The licence status just can't be
                  shown right now.
                </strong>
                <p>
                  This is not a rejection. Use “Check ledger receipt and
                  licence” to read it again; you can keep using BAINK meanwhile.
                </p>
                <details className="more">
                  <summary>Why can't it be shown?</summary>
                  <p>
                    BAINK only shows a licence status from a recent ledger
                    proof, and that proof expires within two minutes. The last
                    one is missing or has expired. Joining UAIN does not add
                    money to your account.
                  </p>
                </details>
              </div>
            ))}
        </div>
      )}
      {intents.length > 0 && (
        <div>
          <h3>Saved public enrolment intents</h3>
          {intents.map((intent) => (
            <p key={intent.id}>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => resume(intent)}
              >
                {enrolmentLabel(intent.status)} ·{" "}
                {new Date(intent.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </button>
            </p>
          ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Checking…</p>}
    </section>
  );
}
