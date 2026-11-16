import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./identity.js";
import { signNativeInstanceIntent } from "./native-instance.js";
import { nativeProofFreshness, watchNativeProof } from "./native-balance.js";

const enc = new TextEncoder();
const RECEIPT_RETRIES = 2;
const RECEIPT_DELAY = 2500;
const blank = { id: "", name: "", family: "" };
const statusLabel = {
  prepared: "Ready to sign",
  accepted: "Submitted, awaiting receipt",
  unknown: "Submission outcome uncertain",
  finalized: "Final on the ledger",
  refused: "Refused by the ledger",
  expired: "Window closed",
};
const errorText = {
  native_sequence_pending:
    "An earlier step is still waiting for its receipt. Check it first.",
  instance_intent_expired:
    "This registration window has closed. Review the details to prepare a new one.",
  native_instance_disabled:
    "Instance registration is not enabled on this deployment.",
  native_licence_inactive:
    "An active UAIN licence is needed before this key can register an instance.",
  native_proof_unavailable:
    "The ledger has not supplied a current proof yet. Nothing was resubmitted. Check the receipt again in a minute.",
};

function plain(e) {
  return errorText[e?.code] || e?.message || "Something went wrong. Try again.";
}

// Mirrors the signer's limits so problems show before anything is prepared.
function fieldProblem({ id, name, family }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))
    return "Instance ID: 1 to 96 characters, starting with a letter or digit, then letters, digits, dot, underscore or hyphen.";
  for (const [label, value, min, max] of [
    ["Instance name", name, 2, 120],
    ["System family", family, 0, 100],
  ]) {
    const bytes = enc.encode(value).length;
    if (/[\u0000-\u001f\u007f]/.test(value))
      return `${label} cannot contain control characters.`;
    if (bytes < min || bytes > max)
      return min
        ? `${label} must be ${min} to ${max} bytes of text.`
        : `${label} can be at most ${max} bytes of text.`;
  }
  return "";
}

function windowNote(intent) {
  let blocks = null;
  try {
    if (intent.proof?.height != null)
      blocks =
        BigInt(intent.command.expires_height) - BigInt(intent.proof.height);
  } catch {}
  const proof = nativeProofFreshness(intent.proof);
  const remaining =
    blocks === null
      ? "This registration window closes after a fixed number of network blocks."
      : blocks > 0n
        ? `About ${blocks} network blocks were left in this window when it was prepared.`
        : "This registration window has closed.";
  const signing = proof.fresh
    ? ` Sign before ${new Date(proof.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}, or refresh the proof for a new check.`
    : intent.status === "prepared"
      ? " The short signing check has lapsed; refresh the proof to continue."
      : "";
  return remaining + signing;
}

function activeRecord(intent) {
  const a = intent?.activation;
  return a?.verified === true &&
    a.instance &&
    nativeProofFreshness(a.proof).fresh
    ? a.instance
    : null;
}

function showMembership() {
  document
    .querySelector('section[aria-label="UAIN membership"]')
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Owned instance registration. Signing and submission happen only on an explicit click. */
export default function NativeInstance({ identity, account, onRefresh }) {
  const [intents, setIntents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [reviewedPayload, setReviewedPayload] = useState(null);
  const [fields, setFields] = useState(blank);
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  useReleaseBusy(busy);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(0);
  const [, tick] = useState(0);
  const request = useRef(null);
  // Every awaited result is committed only if the identity it started under is still current.
  const session = useRef(0);

  useEffect(() => {
    const token = ++session.current;
    const live = () => session.current === token;
    setIntents([]);
    setSelected(null);
    setReviewedPayload(null);
    setFields(blank);
    setConfig(null);
    setBusy(false);
    setError("");
    setRetrying(0);
    request.current = null;
    if (!identity) return () => void ++session.current;
    Promise.all([
      api("/api/native/instances", { identity }),
      api("/api/config"),
    ])
      .then(([data, configuration]) => {
        if (!live()) return;
        setIntents(data.intents || []);
        setConfig(configuration);
      })
      .catch((e) => live() && setError(plain(e)));
    return () => {
      session.current += 1;
    };
  }, [identity]);

  useEffect(() => {
    const a = watchNativeProof(selected?.proof, () => tick((x) => x + 1));
    const b = watchNativeProof(selected?.activation?.proof, () =>
      tick((x) => x + 1),
    );
    return () => {
      a();
      b();
    };
  }, [selected]);

  const act = async (fn) => {
    if (busy) return;
    const token = session.current;
    const live = () => session.current === token;
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
  const save = (intent) => {
    setSelected(intent);
    setIntents((rows) => [intent, ...rows.filter((r) => r.id !== intent.id)]);
  };
  const reset = () => {
    setSelected(null);
    setReviewedPayload(null);
    request.current = null;
    setError("");
  };
  const resume = (intent) => {
    setSelected(intent);
    setFields({ ...intent.command.payload });
    setReviewedPayload({ ...intent.command.payload });
    setError("");
    request.current = {
      id: intent.clientRequestId,
      payload: JSON.stringify(intent.command.payload),
    };
  };

  const instanceSettings = config?.nativeRegistration?.instance;
  const pins = config?.nativeRegistration?.enrol;
  const enabled = instanceSettings?.enabled === true;
  const licensed =
    account?.native?.verified === true &&
    nativeProofFreshness(account.native.proof).fresh &&
    account.native.memberStatus === "active";
  const canPrepare = enabled && licensed;

  const prepare = (e) => {
    e.preventDefault();
    act(async (live) => {
      const payload = {
        id: fields.id.trim(),
        name: fields.name.trim(),
        family: fields.family.trim(),
      };
      const problem = fieldProblem(payload);
      if (problem) throw new Error(problem);
      const value = JSON.stringify(payload);
      // The same details reuse the same request ID, so a retry cannot create a second intent.
      if (!request.current || request.current.payload !== value)
        request.current = { id: crypto.randomUUID(), payload: value };
      const [data, configuration] = await Promise.all([
        api("/api/native/instances/prepare", {
          identity,
          method: "POST",
          body: { clientRequestId: request.current.id, ...payload },
        }),
        api("/api/config"),
      ]);
      if (!live()) return;
      setFields(payload);
      setReviewedPayload(payload);
      setConfig(configuration);
      save(data.intent);
    });
  };

  const sign = () =>
    act(async (live) => {
      if (!selected || selected.status !== "prepared" || !reviewedPayload)
        throw new Error("Review the prepared instance before signing.");
      if (!enabled)
        throw new Error(
          "Instance registration is not enabled on this deployment.",
        );
      // Chain and genesis come from the deployment's public pins, never from the intent alone.
      if (!pins?.chainId || !pins?.genesisSha256)
        throw new Error(
          "The network pins could not be read. Reload and try again.",
        );
      const envelope = await signNativeInstanceIntent(identity, selected, {
        chainId: pins.chainId,
        genesisSha256: pins.genesisSha256,
        expectedPayload: reviewedPayload,
      });
      if (!live()) return;
      const data = await api(
        `/api/native/instances/${encodeURIComponent(selected.id)}/submit`,
        { identity, method: "POST", body: { envelope } },
      );
      if (!live()) return;
      save(data.intent);
      await onRefresh?.();
    });

  const refreshProof = () =>
    act(async (live) => {
      try {
        const [data, configuration] = await Promise.all([
          api("/api/native/instances/prepare", {
            identity,
            method: "POST",
            body: {
              clientRequestId: selected.clientRequestId,
              ...selected.command.payload,
            },
          }),
          api("/api/config"),
        ]);
        if (!live()) return;
        setConfig(configuration);
        save(data.intent);
      } catch (e) {
        if (live() && e.code === "instance_intent_expired")
          save({ ...selected, status: "expired" });
        throw e;
      }
    });

  // A receipt check only reads the ledger; it never re-signs or resubmits.
  // A missing current proof right after registration usually clears once the
  // account is refreshed, so that case gets a bounded number of re-reads.
  const receipt = (intent) =>
    act(async (live) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await api(
            `/api/native/instances/${encodeURIComponent(intent.id)}/receipt`,
            { identity, method: "POST", body: {} },
          );
          if (!live()) return;
          setRetrying(0);
          save(data.intent);
          await onRefresh?.();
          return;
        } catch (e) {
          if (
            !live() ||
            e.code !== "native_proof_unavailable" ||
            attempt >= RECEIPT_RETRIES
          ) {
            if (live()) setRetrying(0);
            throw e;
          }
          setRetrying(attempt + 1);
          try {
            await onRefresh?.();
          } catch {}
          if (!live()) return;
          await new Promise((resolve) => setTimeout(resolve, RECEIPT_DELAY));
          if (!live()) return;
        }
      }
    });

  const owned = activeRecord(selected);
  const problem =
    !selected && (fields.id || fields.name || fields.family)
      ? fieldProblem({
          id: fields.id.trim(),
          name: fields.name.trim(),
          family: fields.family.trim(),
        })
      : "";
  const proofFresh = selected && nativeProofFreshness(selected.proof).fresh;

  return (
    <section
      className="panel settings-panel membership-panel instance-panel"
      aria-label="Native instance registration"
    >
      <details open={intents.length > 0 || undefined}>
        <summary>
          <span className="instance-step">Next, optional</span>
          <h2>Register an AI instance on UAIN</h2>
        </summary>
        <p className="membership-lead">
          Record an AI your key owns, from this browser.
        </p>
        <p className="instance-hint">
          Creates a public instance record only. It does not launch a
          researcher, fund work or pay AI$.
        </p>
        <details className="more">
          <summary>How signing works, and what stays separate</summary>
          <ul className="instance-facts">
            <li>
              <strong>How signing works</strong>
              <p>
                The server prepares the command from verified ledger state. Your
                browser rebuilds it, checks it against what you reviewed, and
                signs with the key held on this device. It is the same trust
                boundary as browser enrolment.
              </p>
            </li>
            <li>
              <strong>What it creates</strong>
              <p>
                A public, owned instance record. It does not launch a
                researcher, prove any science, fund work or pay AI$.
              </p>
            </li>
            <li>
              <strong>What stays separate</strong>
              <p>
                Running your AI is a separate step; this only records it.
              </p>
            </li>
          </ul>
        </details>

        {config === null ? (
          <p role="status">
            {error
              ? "Instance registration availability could not be checked."
              : "Checking instance registration availability…"}
          </p>
        ) : !enabled ? (
          <p className="status-note">
            Instance registration is not enabled on this deployment yet. Earlier
            registrations can still be checked below.
          </p>
        ) : (
          !licensed && (
            <p className="status-note">
              Registering an instance needs an active UAIN licence for this key,
              confirmed by a recent ledger proof.{" "}
              <button
                type="button"
                className="text-link"
                onClick={showMembership}
              >
                Go to UAIN membership
              </button>
            </p>
          )
        )}

        {canPrepare && !selected && (
          <form onSubmit={prepare}>
            {[
              ["id", "Instance ID", 96, "For example research-01"],
              ["name", "Public instance name", 120, ""],
              ["family", "System family (optional)", 100, ""],
            ].map(([key, label, maxLength, hint]) => (
              <label className="field" key={key}>
                <span className="field-label">{label}</span>
                <input
                  name={`instance-${key}`}
                  value={fields[key]}
                  maxLength={maxLength}
                  required={key !== "family"}
                  placeholder={hint}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(e) =>
                    setFields({ ...fields, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <p className="instance-hint">
              These details are public and permanent. No key or secret is
              entered here.
            </p>
            {problem && <p className="form-error">{problem}</p>}
            <button
              className="button ink"
              type="submit"
              disabled={busy || Boolean(problem)}
            >
              Prepare instance for review
            </button>
          </form>
        )}

        {selected && (
          <div className="backup-advice instance-review">
            <h3>Instance: {statusLabel[selected.status] || selected.status}</h3>
            <dl className="instance-exact">
              <dt>ID</dt>
              <dd>
                <code>{selected.command.payload.id}</code>
              </dd>
              <dt>Name</dt>
              <dd>{selected.command.payload.name}</dd>
              <dt>Family</dt>
              <dd>{selected.command.payload.family || "(none)"}</dd>
              <dt>Owner</dt>
              <dd>
                <code>{identity.address}</code>
              </dd>
            </dl>
            {selected.status === "prepared" && <p>{windowNote(selected)}</p>}
            <details className="technical-detail">
              <summary>Technical detail</summary>
              <p>
                Network {selected.command.chain_id}, sequence{" "}
                {selected.command.sequence}, expires at block height{" "}
                {selected.command.expires_height}
                {selected.proof?.height
                  ? `; proof read at height ${selected.proof.height}`
                  : ""}
                .
              </p>
            </details>

            {selected.status === "prepared" && (
              <div className="instance-actions">
                <button
                  className="button ink"
                  type="button"
                  disabled={busy || !enabled || !proofFresh}
                  onClick={sign}
                >
                  Sign and register instance
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={refreshProof}
                >
                  Refresh proof
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={reset}
                >
                  Edit details
                </button>
              </div>
            )}
            {selected.status === "prepared" && !proofFresh && (
              <p role="status">
                The signing proof has expired. Refresh it before signing.
              </p>
            )}
            {["expired", "finalized", "refused"].includes(selected.status) && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={reset}
              >
                {selected.status === "expired"
                  ? "Review details for a new window"
                  : "Register another instance"}
              </button>
            )}
            {selected.status === "refused" && (
              <p role="status">
                The ledger refused this registration. Nothing was created.
              </p>
            )}

            {["accepted", "unknown", "finalized"].includes(selected.status) && (
              <>
                <p>
                  {selected.status === "finalized"
                    ? "This exact command has a verified final ledger receipt."
                    : selected.status === "unknown"
                      ? "We could not confirm whether the network received this. It will not be sent again. Check the ledger receipt instead."
                      : "Submitted. Acceptance alone does not confirm registration; check the ledger receipt."}
                </p>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() => receipt(selected)}
                >
                  Check ledger receipt
                </button>
              </>
            )}

            {owned ? (
              <p role="status" className="instance-owned">
                Owned instance <code>{owned.id}</code>: {owned.state}. This is a
                ledger record only. No worker is running and the installation is
                not verified.
              </p>
            ) : (
              selected.finalized && (
                <div className="status-note licence-note" role="status">
                  <strong>
                    The registration is final. Its current state just can't be
                    shown right now.
                  </strong>
                  <p>
                    The recent ledger proof BAINK needs has expired or is
                    missing. Use “Check ledger receipt” to read it again.
                  </p>
                </div>
              )
            )}
          </div>
        )}

        {intents.length > 0 && (
          <div>
            <h3>Your instance registrations</h3>
            {intents.map((intent) => (
              <p key={intent.id}>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => resume(intent)}
                >
                  {intent.command?.payload?.id} ·{" "}
                  {statusLabel[intent.status] || intent.status}
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
        {busy && (
          <p role="status">
            {retrying
              ? `Waiting for a current ledger proof (re-read ${retrying} of ${RECEIPT_RETRIES}). Nothing is resubmitted.`
              : "Checking the native ledger…"}
          </p>
        )}
      </details>
    </section>
  );
}
