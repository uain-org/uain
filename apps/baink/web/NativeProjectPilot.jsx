import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useRef, useState } from "react";
import { api } from "./identity.js";
import { signNativeProjectPilotIntent } from "./native-project-pilot.js";
import { nativeProofFreshness, watchNativeProof } from "./native-balance.js";
import {
  canonicalJSON,
  researchEvidenceCanonical,
  validateResearchPayload,
} from "../integrations/native-research-codec.mjs";

const enc = new TextEncoder();
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const BASE = "/api/native/project-pilot";
const CREATOR_OPS = ["open_project", "open_task"];
const opLabel = {
  open_project: "Open the project",
  open_task: "Open the task",
  project_join: "Join the project",
  submit: "Submit a contribution",
  verify: "Review a contribution",
};
const statusLabel = {
  prepared: "Prepared, not signed",
  accepted: "Submitted, awaiting receipt",
  unknown: "Submission outcome uncertain",
  finalized: "Final on the ledger",
  refused: "Refused by the ledger",
  expired: "Window closed",
  expired_unincluded: "Expired without inclusion",
};
const publicationLabel = {
  pending: "Evidence not yet published",
  published: "Evidence published",
};
const errorText = {
  native_pilot_disabled: "This pilot is not enabled on this deployment.",
  native_source_changed:
    "The source proposal changed since this pilot was configured. Nothing was prepared.",
  native_proof_unavailable:
    "The ledger has not supplied a current proof. No new action was sent; check the existing receipt again shortly.",
  native_licence_inactive:
    "An active UAIN licence is needed for this key.",
  native_instance_not_owned:
    "That instance is not an active instance owned by this key.",
  native_creator_required:
    "Only the configured project creator, from its configured instance, can do this.",
  native_project_exists: "The project is already open on the ledger.",
  native_project_not_active: "The project is not open on the ledger yet.",
  native_project_lead_required:
    "Only the project lead can open the task, and it must not exist yet.",
  native_project_join_required:
    "Join the project from this instance before submitting or reviewing.",
  native_already_joined: "This instance has already joined the project.",
  native_task_not_open: "The pilot task is not open on the ledger.",
  native_contribution_exists: "A contribution with that ID already exists.",
  native_contribution_not_reviewable:
    "That contribution is not held for review on this task.",
  native_self_review: "You cannot review your own contribution.",
  native_reviewer_required:
    "Reviewing needs default verifier standing or at least 100 Karma on the ledger.",
  native_pilot_intent_pending:
    "Another pilot action from this key is still waiting for its receipt. Check it first.",
  native_pilot_other_intent_pending:
    "Another native action from this key is still waiting for its receipt. Check it first.",
  native_pilot_intent_expired:
    "This signing window has closed. Prepare the action again.",
  native_sequence_changed:
    "Your account moved on since this was prepared. Prepare the action again.",
  native_pilot_config_changed:
    "The pilot configuration changed. Reload before continuing.",
  native_pilot_publication_unavailable:
    "The chain submission is final, but the public evidence could not be published yet. Nothing was lost; try publishing again later.",
  native_pilot_publication_not_ready:
    "Evidence can only be published after its submission is final.",
  native_evidence_digest_mismatch:
    "The evidence digest does not match the evidence body.",
};

class Local extends Error {}
function plain(e) {
  if (e instanceof Local) return e.message;
  if (errorText[e?.code]) return errorText[e.code];
  if (e?.code)
    return `The request could not be completed (${e.code}). Nothing was resent.`;
  return "Something went wrong. Nothing was resent.";
}
const need = (ok, message) => {
  if (!ok) throw new Local(message);
};
const lines = (text) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const pretty = (value) => JSON.stringify(value, null, 2);
async function sha256(text) {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const blank = {
  operation: "project_join",
  instance: "",
  contributionId: "",
  title: "",
  detail: "",
  sources: "",
  verdict: "confirm",
  novelty: "new",
  searches: "",
  reviewText: "",
  knownSource: "",
};

// Builds exactly what will be sent to /prepare. The result is frozen as the reviewed action.
async function buildAction(pilot, fields, creator) {
  const op = fields.operation;
  need(Object.hasOwn(opLabel, op), "Choose an operation.");
  if (CREATOR_OPS.includes(op)) {
    need(creator, "Only the configured project creator can do this.");
    return {
      operation: op,
      instance: pilot.creatorInstance,
      payload: structuredClone(
        op === "open_project" ? pilot.projectPayload : pilot.taskPayload,
      ),
    };
  }
  const instance = fields.instance.trim();
  need(
    ID.test(instance),
    "Instance ID: 1 to 96 characters, starting with a letter or digit, then letters, digits, dot, underscore or hyphen.",
  );
  if (op === "project_join")
    return { operation: op, instance, payload: { project: pilot.projectId } };
  const contribution = fields.contributionId.trim();
  need(ID.test(contribution), "Contribution ID: same rules as an instance ID.");
  need(
    contribution !== pilot.projectId && contribution !== pilot.taskId,
    "The contribution ID must differ from the project and task IDs.",
  );
  if (op === "submit") {
    const body = {
      title: fields.title.trim(),
      detail: fields.detail.trim(),
      sources: lines(fields.sources),
    };
    need(body.title && body.title.length <= 200, "Title: 1 to 200 characters.");
    need(
      body.detail.length >= 20 && body.detail.length <= 48000,
      "Detail: 20 to 48,000 characters.",
    );
    need(
      body.sources.length <= 16 && body.sources.every((s) => s.length <= 2048),
      "Sources: at most 16, one per line, each up to 2,048 characters.",
    );
    let canonical;
    try {
      canonical = researchEvidenceCanonical(body);
    } catch {
      throw new Local("The evidence is too large or contains invalid text.");
    }
    const payload = {
      id: contribution,
      task: pilot.taskId,
      evidence_digest: await sha256("uain:research-evidence:v1\n" + canonical),
    };
    return { operation: op, instance, payload, body };
  }
  const searches = lines(fields.searches);
  need(
    searches.length >= 2 &&
      searches.length <= 16 &&
      new Set(searches).size === searches.length,
    "Searches: 2 to 16 different searches, one per line.",
  );
  const reviewText = fields.reviewText.trim();
  need(reviewText, "Add your review evidence.");
  const payload = {
    contribution,
    verdict: fields.verdict,
    novelty: fields.novelty,
    searches,
    evidence_digest: await sha256(reviewText),
  };
  if (fields.novelty === "known") {
    const known = fields.knownSource.trim();
    need(
      /^https:\/\//.test(known),
      "Known source: a public HTTPS link of at most 500 bytes, without credentials.",
    );
    payload.known_source = known;
  }
  return { operation: op, instance, payload };
}

function checkPayload(action) {
  try {
    validateResearchPayload(action.operation, action.payload);
  } catch {
    throw new Local(
      "These details are outside the ledger's limits (search lines are 5 to 2,048 bytes each).",
    );
  }
}

function freezeFromIntent(intent) {
  const c = intent.command;
  return {
    operation: c.operation,
    instance: c.instance,
    payload: structuredClone(c.payload),
    ...(intent.publicBody ? { body: structuredClone(intent.publicBody) } : {}),
  };
}

function ProofLine({ proof, label }) {
  const fresh = nativeProofFreshness(proof);
  if (!proof) return null;
  return fresh.fresh ? (
    <p className="instance-hint">
      {label} verified against a native ledger proof at height{" "}
      <code>{proof.height}</code>, current until{" "}
      {new Date(fresh.expiresAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}
      .
    </p>
  ) : (
    <p className="status-note" role="status">
      The ledger proof for this view has expired (last read at height{" "}
      <code>{proof.height}</code>). Refresh to see verified state.
    </p>
  );
}

/** The single canonical UAIN project pilot. Signing happens only on an explicit, acknowledged click. */
export default function NativeProjectPilot({ identity, config, onToast }) {
  const base = config?.nativeProjectPilot ?? null;
  const [served, setServed] = useState(undefined);
  const [intents, setIntents] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [lookup, setLookup] = useState("");
  const [fields, setFields] = useState(blank);
  const [selected, setSelected] = useState(null);
  const [reviewed, setReviewed] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [publishAck, setPublishAck] = useState(false);
  const [busy, setBusy] = useState(false);
  useReleaseBusy(busy);
  const [error, setError] = useState("");
  const [, tick] = useState(0);
  const request = useRef(null);
  // Every awaited result is applied only if the identity it started under is still current.
  const session = useRef(0);

  // The newest server view of the pilot wins; a server reply of null means it is off.
  const pilot = served === undefined ? base : served;
  const enabled = pilot?.enabled === true;
  const creator = Boolean(
    identity && pilot && identity.address === pilot.creatorAddress,
  );

  useEffect(() => {
    const token = ++session.current;
    const live = () => session.current === token;
    setServed(undefined);
    setIntents([]);
    setSnapshot(null);
    setLookup("");
    setFields(blank);
    setSelected(null);
    setReviewed(null);
    setAcknowledged(false);
    setPublishAck(false);
    setBusy(false);
    setError("");
    request.current = null;
    if (!identity) return () => void ++session.current;
    api(BASE, { identity, isCurrent: live })
      .then((data) => {
        if (!live()) return;
        setServed(data.config ?? null);
        setIntents(data.intents || []);
      })
      .catch((e) => live() && setError(plain(e)));
    if (base) api(`${BASE}/snapshot`, {
      identity,
      method: "POST",
      body: {},
      isCurrent: live,
    })
      .then((data) => live() && setSnapshot(data))
      .catch(() => {});
    return () => {
      session.current += 1;
    };
    // The pilot binding, not object identity, decides when to reload.
  }, [identity, base?.sourceDigest, base?.projectId, Boolean(base)]);

  useEffect(() => {
    const a = watchNativeProof(snapshot?.proof, () => tick((x) => x + 1));
    const b = watchNativeProof(selected?.proof, () => tick((x) => x + 1));
    return () => {
      a();
      b();
    };
  }, [snapshot, selected]);

  if (!identity || (!pilot && intents.length === 0)) return null;

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
  const choose = (intent) => {
    setSelected(intent);
    setReviewed(freezeFromIntent(intent));
    setAcknowledged(false);
    setPublishAck(false);
    setError("");
    request.current = null;
  };
  const reset = () => {
    setSelected(null);
    setReviewed(null);
    setAcknowledged(false);
    setPublishAck(false);
    request.current = null;
    setError("");
  };
  const set = (key) => (e) => setFields({ ...fields, [key]: e.target.value });

  const refreshSnapshot = () =>
    act(async (live) => {
      const id = lookup.trim();
      need(!id || ID.test(id), "Contribution ID: same rules as an instance ID.");
      const data = await api(`${BASE}/snapshot`, {
        identity,
        method: "POST",
        body: id ? { contributionId: id } : {},
        isCurrent: live,
      });
      if (!live()) return;
      setSnapshot(data);
      if (data.config !== undefined) setServed(data.config);
    });

  const prepare = (e) => {
    e.preventDefault();
    act(async (live) => {
      need(enabled, "This pilot is not enabled on this deployment.");
      const action = await buildAction(
        pilot,
        { ...fields, operation: op },
        creator,
      );
      checkPayload(action);
      const key = canonicalJSON({ ...action, body: action.body ?? null });
      // Identical details reuse one request ID, so a retried prepare cannot create a second intent.
      if (!request.current || request.current.key !== key)
        request.current = { id: crypto.randomUUID(), key };
      const data = await api(`${BASE}/prepare`, {
        identity,
        method: "POST",
        body: {
          clientRequestId: request.current.id,
          sourceDigest: pilot.sourceDigest,
          ...action,
        },
        isCurrent: live,
      });
      if (!live()) return;
      save(data.intent);
      setReviewed(structuredClone(action));
      setAcknowledged(false);
    });
  };

  // Re-reads the proof for the same frozen action and request ID; never builds a new action.
  const refreshProof = () =>
    act(async (live) => {
      need(selected && reviewed, "Choose the prepared action again.");
      try {
        const data = await api(`${BASE}/prepare`, {
          identity,
          method: "POST",
          body: {
            clientRequestId: selected.clientRequestId,
            sourceDigest: selected.sourceDigest,
            ...reviewed,
          },
          isCurrent: live,
        });
        if (!live()) return;
        save(data.intent);
      } catch (e) {
        if (live() && e?.code === "native_pilot_intent_expired")
          save({ ...selected, status: "expired" });
        throw e;
      }
    });

  const sign = () =>
    act(async (live) => {
      need(
        selected?.status === "prepared" && reviewed && acknowledged,
        "Review the action and confirm before signing.",
      );
      need(enabled, "This pilot is not enabled on this deployment.");
      let envelope;
      try {
        envelope = await signNativeProjectPilotIntent(identity, selected, {
          config: pilot,
          operation: reviewed.operation,
          instance: reviewed.instance,
          payload: reviewed.payload,
        });
      } catch (e) {
        throw new Local(
          e?.message || "The action could not be signed. Nothing was sent.",
        );
      }
      if (!live()) return;
      const data = await api(
        `${BASE}/${encodeURIComponent(selected.id)}/submit`,
        { identity, method: "POST", body: { envelope }, isCurrent: live },
      );
      if (!live()) return;
      setAcknowledged(false);
      save(data.intent);
      onToast?.("Sent. Check the ledger receipt for the result.");
    });

  const recover = () => act(async (live) => {
    const data = await api(`${BASE}/${encodeURIComponent(selected.id)}/recover`, {identity, method:"POST", body:{}, isCurrent:live});
    if (live()) { save(data.intent); onToast?.(data.recoveryPending ? "More ledger events remain to scan. Nothing was resent." : "Recovery checked. Nothing was resent."); }
  });

  // Reads only. Never re-signs, never resubmits.
  const receipt = () =>
    act(async (live) => {
      const data = await api(
        `${BASE}/${encodeURIComponent(selected.id)}/receipt`,
        { identity, method: "POST", body: {}, isCurrent: live },
      );
      if (!live()) return;
      save(data.intent);
      if (data.intent.status === "finalized") {
        onToast?.("Final on the ledger.");
        // Read the new canonical state; never infer it from CheckTx or a local card.
        try {
          const id = data.intent.command.operation === "submit" ? data.intent.command.payload.id :
            data.intent.command.operation === "verify" ? data.intent.command.payload.contribution : null;
          const current = await api(`${BASE}/snapshot`, {identity, method:"POST", body:id ? {contributionId:id} : {}, isCurrent:live});
          if (live()) setSnapshot(current);
        } catch { if (live()) setSnapshot(null); }
      }
    });

  const publish = () =>
    act(async (live) => {
      need(publishAck, "Confirm the publication first.");
      const data = await api(
        `${BASE}/${encodeURIComponent(selected.id)}/publish`,
        { identity, method: "POST", body: {}, isCurrent: live },
      );
      if (!live()) return;
      setPublishAck(false);
      save(data.intent);
      onToast?.("Evidence published.");
    });

  const operations = creator
    ? Object.keys(opLabel)
    : Object.keys(opLabel).filter((op) => !CREATOR_OPS.includes(op));
  const op = operations.includes(fields.operation)
    ? fields.operation
    : "project_join";
  const creatorOp = CREATOR_OPS.includes(op);
  const proofFresh =
    selected && nativeProofFreshness(selected.proof).fresh === true;
  const snapFresh = nativeProofFreshness(snapshot?.proof).fresh === true;
  const ownedByMe =
    op === "verify" &&
    snapFresh &&
    snapshot?.contribution?.id === fields.contributionId.trim() &&
    snapshot.contribution.author === identity?.address;
  const title = pilot?.projectPayload?.title || base?.projectPayload?.title || "Previous UAIN pilot actions";
  const historicalSource = selected?.source ?? intents[0]?.source;
  const pending = intents.filter((i) => i.status !== "finalized" && i.status !== "expired" && i.status !== "refused");
  const pendingPublication = intents.filter(
    (i) => i.status === "finalized" && i.publication?.status === "pending",
  );

  return (
    <section
      className="panel settings-panel membership-panel instance-panel"
      aria-label="UAIN project pilot"
    >
      <details open={intents.length > 0 || undefined}>
        <summary>
          <span className="instance-step">Pilot</span>
          <h2>{title}</h2>
        </summary>
        <p className="membership-lead">
          Source <code>{pilot?.sourceId ?? base?.sourceId ?? historicalSource?.id}</code> → UAIN project{" "}
          <code>{pilot?.projectId ?? base?.projectId ?? "previous configuration"}</code>
        </p>
        <p className="instance-hint">
          UAIN is the project record. Local preparation notes are not
          automatically published.
        </p>
        <p className="instance-hint">
          No AI$ or Karma reward is configured for this pilot.
        </p>

        {!enabled && (
          <p className="status-note">
            This pilot is not enabled on this deployment, so nothing can be
            prepared or signed. Earlier actions can still be checked and their finalized evidence published below.
          </p>
        )}

        <div className="backup-advice instance-review">
          <h3>Source proposal</h3>
          <p className="instance-hint">
            The proposal this pilot was drawn from. It is an inactive source
            record, not the project.
          </p>
          <dl className="instance-exact">
            <dt>Source</dt>
            <dd>
              <code>{pilot?.sourceId ?? base?.sourceId ?? historicalSource?.id}</code>
            </dd>
            <dt>Digest</dt>
            <dd>
              <code>{pilot?.sourceDigest ?? base?.sourceDigest ?? historicalSource?.digest}</code>
            </dd>
          </dl>
        </div>

        <div className="backup-advice instance-review">
          <h3>Canonical UAIN project</h3>
          <p className="instance-hint">
            {snapshot?.notice ||
              "Native project state only. Admission is not funding, scientific acceptance or an AI$ reward."}
          </p>
          {snapshot ? (
            <>
              <ProofLine proof={snapshot.proof} label="State" />
              <dl className="instance-exact">
                <dt>Project</dt>
                <dd>
                  {snapFresh
                    ? snapshot.project
                      ? `${snapshot.project.id}: ${snapshot.project.state}`
                      : "Not opened yet"
                    : "Unverified"}
                </dd>
                <dt>Task</dt>
                <dd>
                  {snapFresh
                    ? snapshot.task
                      ? `${snapshot.task.id}: ${snapshot.task.state}`
                      : "Not opened yet"
                    : "Unverified"}
                </dd>
                {snapshot.contribution && (
                  <>
                    <dt>Contribution</dt>
                    <dd>
                      {snapFresh
                        ? `${snapshot.contribution.id}: ${snapshot.contribution.state}`
                        : "Unverified"}
                    </dd>
                  </>
                )}
              </dl>
              {snapFresh && (snapshot.project || snapshot.contribution) && (
                <details className="technical-detail">
                  <summary>Exact ledger records</summary>
                  <pre style={{maxWidth:"100%",overflowX:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
                    {pretty({
                      project: snapshot.project,
                      task: snapshot.task,
                      contribution: snapshot.contribution,
                    })}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <p role="status">Native project state has not been read yet.</p>
          )}
          <label className="field">
            <span className="field-label">Contribution ID (optional)</span>
            <input
              value={lookup}
              maxLength={96}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setLookup(e.target.value)}
            />
          </label>
          <button
            className="button"
            type="button"
            disabled={busy || !pilot}
            onClick={refreshSnapshot}
          >
            Refresh project state
          </button>
        </div>

        {!selected && pilot && (
          <form onSubmit={prepare}>
            <label className="field">
              <span className="field-label">Operation</span>
              <select
                value={op}
                disabled={busy || !enabled}
                onChange={set("operation")}
              >
                {operations.map((o) => (
                  <option key={o} value={o}>
                    {opLabel[o]}
                  </option>
                ))}
              </select>
            </label>

            {creatorOp ? (
              <>
                <p className="instance-hint">
                  Fixed by the pilot configuration. Signed from instance{" "}
                  <code>{pilot.creatorInstance}</code>.
                </p>
                <pre className="technical-detail" style={{maxWidth:"100%",overflowX:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>
                  {pretty(
                    op === "open_project"
                      ? pilot.projectPayload
                      : pilot.taskPayload,
                  )}
                </pre>
              </>
            ) : (
              <label className="field">
                <span className="field-label">Your instance ID</span>
                <input
                  value={fields.instance}
                  maxLength={96}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || !enabled}
                  onChange={set("instance")}
                />
              </label>
            )}

            {(op === "submit" || op === "verify") && (
              <label className="field">
                <span className="field-label">Contribution ID</span>
                <input
                  value={fields.contributionId}
                  maxLength={96}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || !enabled}
                  onChange={set("contributionId")}
                />
              </label>
            )}

            {op === "submit" && (
              <>
                <label className="field">
                  <span className="field-label">Title</span>
                  <input
                    value={fields.title}
                    maxLength={200}
                    required
                    disabled={busy || !enabled}
                    onChange={set("title")}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Detail</span>
                  <textarea
                    value={fields.detail}
                    rows={6}
                    required
                    disabled={busy || !enabled}
                    onChange={set("detail")}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Sources (one per line)</span>
                  <textarea
                    value={fields.sources}
                    rows={3}
                    spellCheck={false}
                    disabled={busy || !enabled}
                    onChange={set("sources")}
                  />
                </label>
                <p className="instance-hint">
                  Only a digest of this evidence goes on the chain. The exact
                  title, detail and sources are published only when you choose
                  to, after the submission is final.
                </p>
              </>
            )}

            {op === "verify" && (
              <>
                <label className="field">
                  <span className="field-label">Verdict</span>
                  <select
                    value={fields.verdict}
                    disabled={busy || !enabled}
                    onChange={set("verdict")}
                  >
                    <option value="confirm">Confirm</option>
                    <option value="dispute">Dispute</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Novelty</span>
                  <select
                    value={fields.novelty}
                    disabled={busy || !enabled}
                    onChange={set("novelty")}
                  >
                    <option value="new">New</option>
                    <option value="known">Already known</option>
                  </select>
                </label>
                {fields.novelty === "known" && (
                  <label className="field">
                    <span className="field-label">Known source link</span>
                    <input
                      value={fields.knownSource}
                      maxLength={500}
                      required
                      spellCheck={false}
                      disabled={busy || !enabled}
                      onChange={set("knownSource")}
                    />
                  </label>
                )}
                <label className="field">
                  <span className="field-label">
                    Searches you ran (at least 2, one per line)
                  </span>
                  <textarea
                    value={fields.searches}
                    rows={3}
                    required
                    disabled={busy || !enabled}
                    onChange={set("searches")}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Review evidence</span>
                  <textarea
                    value={fields.reviewText}
                    rows={5}
                    required
                    disabled={busy || !enabled}
                    onChange={set("reviewText")}
                  />
                </label>
                <p className="instance-hint">
                  Only the SHA-256 digest of this text goes on the chain. Keep
                  the text; it is not published from here. Reviewing earns no
                  reward in this pilot. The ledger refuses reviews of your own
                  contribution.
                </p>
                {ownedByMe && (
                  <p className="form-error">
                    The verified ledger record shows you wrote this
                    contribution. You cannot review it.
                  </p>
                )}
              </>
            )}

            <button
              className="button ink"
              type="submit"
              disabled={busy || !enabled || ownedByMe}
            >
              Prepare for review
            </button>
          </form>
        )}

        {selected && reviewed && (
          <div className="backup-advice instance-review">
            <h3>
              {opLabel[reviewed.operation]}:{" "}
              {statusLabel[selected.status] || selected.status}
            </h3>
            {selected.publication && (
              <p role="status">
                {publicationLabel[selected.publication.status] ||
                  selected.publication.status}
              </p>
            )}
            <dl className="instance-exact">
              <dt>Operation</dt>
              <dd>
                <code>{reviewed.operation}</code>
              </dd>
              <dt>Instance</dt>
              <dd>
                <code>{reviewed.instance}</code>
              </dd>
              <dt>Signer</dt>
              <dd>
                <code>{identity.address}</code>
              </dd>
            </dl>
            <p className="field-label">Exact payload</p>
            <pre className="technical-detail" style={{maxWidth:"100%",overflowX:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{pretty(reviewed.payload)}</pre>
            {reviewed.body && (
              <>
                <p className="field-label">
                  Exact public evidence (its digest is in the payload)
                </p>
                <pre className="technical-detail" style={{maxWidth:"100%",overflowX:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{pretty(reviewed.body)}</pre>
              </>
            )}
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
              <>
                {!proofFresh && (
                  <p role="status">
                    The signing proof has expired. Refresh it before signing.
                  </p>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={busy || !enabled}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  I reviewed this exact operation, instance and payload.
                  Signing submits a permanent, public action to the UAIN chain
                  that cannot be undone.
                </label>
                <div className="instance-actions">
                  <button
                    className="button ink"
                    type="button"
                    disabled={busy || !enabled || !proofFresh || !acknowledged}
                    onClick={sign}
                  >
                    Sign and submit {opLabel[reviewed.operation].toLowerCase()}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !enabled}
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
                    Back
                  </button>
                </div>
              </>
            )}

            {["accepted", "unknown"].includes(selected.status) && (
              <p>
                {selected.status === "unknown"
                  ? "We could not confirm whether the network received this. It will not be sent again. Check the ledger receipt instead."
                  : "Submitted. Acceptance alone does not make it final; check the ledger receipt."}
                {selected.moreEvents
                  ? " More ledger events remain to scan; check again."
                  : ""}
              </p>
            )}
            {selected.receiptRequired && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={receipt}
              >
                Check ledger receipt
              </button>
            )}
            {selected.receiptRequired && (
              <button className="button secondary" type="button" disabled={busy} onClick={recover}>Check whether this expired unused</button>
            )}
            {selected.status === "expired_unincluded" && <p>The original command expired and was not included in the proved ledger range. It will never be resent. You may deliberately prepare a new action.</p>}
            {selected.status === "refused" && (
              <p role="status">
                The submission endpoint refused this action. Check its receipt or prove that its signing window closed unused before preparing another.
              </p>
            )}
            {selected.status === "finalized" && (
              <p role="status">
                This exact command has a verified final ledger receipt.
              </p>
            )}

            {selected.status === "finalized" &&
              selected.publication?.status === "pending" && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={publishAck}
                      disabled={busy}
                      onChange={(e) => setPublishAck(e.target.checked)}
                    />
                    Publish the exact evidence above as permanent, public
                    evidence for this contribution. It cannot be edited or
                    withdrawn.
                  </label>
                  <button
                    className="button ink"
                    type="button"
                    disabled={busy || !publishAck}
                    onClick={publish}
                  >
                    Publish evidence
                  </button>
                </>
              )}

            {["expired", "finalized", "refused"].includes(selected.status) && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={reset}
              >
                Prepare another action
              </button>
            )}
            {["accepted", "unknown"].includes(selected.status) && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={reset}
              >
                Back
              </button>
            )}
          </div>
        )}

        {intents.length > 0 && (
          <div>
            <h3>Your pilot actions</h3>
            {(pending.length > 0 || pendingPublication.length > 0) && (
              <p className="instance-hint">
                {pending.length > 0 &&
                  `${pending.length} waiting for signing or a receipt. `}
                {pendingPublication.length > 0 &&
                  `${pendingPublication.length} final with evidence not yet published.`}
              </p>
            )}
            {intents.map((intent) => (
              <p key={intent.id}>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => choose(intent)}
                >
                  {opLabel[intent.command?.operation] ||
                    intent.command?.operation}{" "}
                  · <code>{intent.command?.instance}</code> ·{" "}
                  {statusLabel[intent.status] || intent.status}
                  {intent.publication
                    ? ` · ${publicationLabel[intent.publication.status] || intent.publication.status}`
                    : ""}
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
        {busy && <p role="status">Checking the native ledger…</p>}
      </details>
    </section>
  );
}
