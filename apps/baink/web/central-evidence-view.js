/**
 * The member's view of the S6 evidence journey (docs/baink/needs-evidence.md):
 * one evidence request, a 72-hour window, one linked revision or one
 * reassessment, and a fee-free expiry that reopens the task.
 *
 * Presentation only. It reads the `evidence` object the server builds from
 * verified native records (server/central-evidence.mjs) and refuses any shape
 * it does not know, so an unexpected field never becomes a display fact or an
 * action. The server still refuses every action the chain would refuse.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ADDRESS = /^uain1[0-9a-f]{40}$/;
const HEIGHT = /^[1-9][0-9]{0,18}$/;
const UINT = /^(0|[1-9][0-9]{0,18})$/;
export const EVIDENCE_KINDS = [
  "verification_service",
  "reviewer_request",
  "reassessment_pending",
  "revised",
  "expired",
  "unavailable",
];
const ACTIONS = ["central_submit", "central_reassess", "central_evidence_expire"];
const plainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v, max = 2048) => typeof v === "string" && v.isWellFormed() && v.length <= max;

const TITLES = {
  verification_service: "Still being checked",
  reviewer_request: "The reviewer asks for more evidence",
  reassessment_pending: "Reassessment asked",
  revised: "Revised",
  expired: "Evidence window closed",
  unavailable: "Evidence status unavailable",
};

function helpers(h) {
  if (h === undefined || h === null) return { reviewer: null, manager: null, guide: null };
  if (!plainObject(h)) throw Error("central_evidence_view_refused");
  const pick = (v) => (ADDRESS.test(v ?? "") ? v : null);
  return {
    reviewer: pick(h.reviewer),
    manager: pick(h.manager),
    guide: h.guide === "docs/baink/needs-evidence.md" ? h.guide : null,
  };
}

function windowOf(w) {
  if (w === undefined || w === null) return null;
  if (!plainObject(w) || !HEIGHT.test(w.deadlineHeight ?? "") || !UINT.test(w.blocksLeft ?? "") || typeof w.open !== "boolean")
    throw Error("central_evidence_view_refused");
  const at = typeof w.deadlineEstimate === "string" ? Date.parse(w.deadlineEstimate) : NaN;
  return {
    requestedAtHeight: HEIGHT.test(w.requestedAtHeight ?? "") ? w.requestedAtHeight : null,
    deadlineHeight: w.deadlineHeight,
    blocksLeft: w.open ? w.blocksLeft : "0",
    deadlineEstimate: Number.isFinite(at) ? new Date(at).toISOString() : null,
    open: w.open,
  };
}

function actionOf(a, submission) {
  if (!plainObject(a) || !ACTIONS.includes(a.operation) || !plainObject(a.payload)) throw Error("central_evidence_view_refused");
  const p = a.payload;
  if (a.operation === "central_submit") {
    if (p.revises !== submission || !ID.test(p.task ?? "")) throw Error("central_evidence_view_refused");
    return { operation: a.operation, task: p.task, revises: p.revises };
  }
  if (p.submission !== submission) throw Error("central_evidence_view_refused");
  return { operation: a.operation, submission: p.submission };
}

/**
 * @param evidence the server's `evidence` object, or null/undefined
 * @param submission the submission id this evidence belongs to
 * @returns null when there is no journey to show, otherwise a frozen view
 */
export function evidenceView(evidence, submission) {
  if (evidence === undefined || evidence === null) return null;
  if (!plainObject(evidence) || !EVIDENCE_KINDS.includes(evidence.kind) || !ID.test(submission ?? ""))
    throw Error("central_evidence_view_refused");
  const kind = evidence.kind;
  if (kind === "unavailable") return Object.freeze({ kind, title: TITLES[kind], message: "The evidence status could not be read right now. Try again later.", findings: null, help: helpers(null), window: null, actions: [], revisedBy: null, revisionOf: null, note: null, expiredAtHeight: null });
  if (evidence.message !== undefined && !text(evidence.message)) throw Error("central_evidence_view_refused");
  const found = evidence.found;
  if (found !== undefined && found !== null && !(Array.isArray(found) && found.length <= 64 && found.every((f) => text(f, 8192))))
    throw Error("central_evidence_view_refused");
  const actions = Array.isArray(evidence.actions) ? evidence.actions.map((a) => actionOf(a, submission)) : [];
  if (evidence.actions !== undefined && !Array.isArray(evidence.actions)) throw Error("central_evidence_view_refused");
  const window = windowOf(evidence.window);
  // A member action is offered only for a request with a native deadline, and
  // revise/reassess only while that window is open.
  const usable = actions.filter((a) =>
    window && (a.operation === "central_evidence_expire" ? !window.open : window.open),
  );
  return Object.freeze({
    kind,
    title: TITLES[kind],
    message: typeof evidence.message === "string" ? evidence.message : "",
    findings: Array.isArray(found) ? [...found] : null,
    help: helpers(evidence.help),
    window,
    actions: usable,
    revisedBy: ID.test(evidence.revisedBy ?? "") ? evidence.revisedBy : null,
    revisionOf: ID.test(evidence.revisionOfOriginal ?? "") ? evidence.revisionOfOriginal : null,
    note: text(evidence.note) ? evidence.note : null,
    expiredAtHeight: HEIGHT.test(evidence.expiredAtHeight ?? "") ? evidence.expiredAtHeight : null,
  });
}

/** "about 3 days 4 hours" style wording for blocks left (2 s per block, an estimate). */
export function blocksLeftText(blocksLeft, secondsPerBlock = 2) {
  if (!UINT.test(blocksLeft ?? "")) return "";
  const minutes = Math.floor((Number(blocksLeft) * secondsPerBlock) / 60);
  if (minutes < 1) return "less than a minute";
  const d = Math.floor(minutes / 1440),
    h = Math.floor((minutes % 1440) / 60),
    m = minutes % 60;
  const part = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (d > 0) return `about ${part(d, "day")}${h ? " " + part(h, "hour") : ""}`;
  if (h > 0) return `about ${part(h, "hour")}${m ? " " + part(m, "minute") : ""}`;
  return `about ${part(m, "minute")}`;
}

/** Exact payloads for the member's evidence actions; the server checks them again. */
export function evidenceActionPayload(operation, { submission, task, id, evidence, evidence_digest } = {}) {
  if (operation === "central_reassess" || operation === "central_evidence_expire") {
    if (!ID.test(submission ?? "")) throw Error("central_evidence_action_refused");
    return { submission };
  }
  if (operation === "central_submit") {
    if (![submission, task, id].every((v) => ID.test(v ?? "")) || id === submission || typeof evidence !== "string" || !/^[a-f0-9]{64}$/.test(evidence_digest ?? ""))
      throw Error("central_evidence_action_refused");
    return { id, task, evidence, evidence_digest, revises: submission };
  }
  throw Error("central_evidence_action_refused");
}
