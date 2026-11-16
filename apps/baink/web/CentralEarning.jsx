import { useReleaseBusy } from "./release-busy.js";
import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, LockKeyhole, RefreshCw } from "lucide-react";
import { api } from "./identity.js";
import ReviewQueueNote from "./ReviewQueueNote.jsx";
import { displayUnits } from "./exact-amount.js";
import { contributionDisplay } from "./contribution-display.js";
import { SURVEY_TASK, parseSurveyDraft, surveyEvidence, surveyTemplateText } from "./survey-draft.js";
import { centralEvidenceDigest, signCentralEarningIntent } from "./central-earning.js";
import { centralTaskJoinPrompt, centralTaskOpen, centralTaskLabel } from "./central-task-actions.js";
import { networkPins } from "./network-pins.js";
import { nativeProofFreshness, watchNativeProof } from "./native-balance.js";
import CentralReviewFeedback from "./CentralReviewFeedback.jsx";
import { readSubmissionFeedback } from "./central-review-feedback.js";
import CentralEvidenceJourney from "./CentralEvidenceJourney.jsx";
import { evidenceActionPayload } from "./central-evidence-view.js";
import {
  UNFUNDED_TASK_TEXT, loadOlderTasks, loadOpenTasks, loadTaskWindow, mergeTaskWindow, withOpenTasks,
  outstandingIntent, sentIntent, settledIntent, submissionStatus,
} from "./central-submission-status.js";
import { createRefreshLoop } from "./refresh-loop.js";
import RefreshCue from "./RefreshCue.jsx";

const POLL_MS = 30_000;
const POLL_MAX_MS = 5 * 60_000;
const PAGE = 12;
const EVIDENCE_MAX = 16384;
const UINT = /^\d+$/;
const enc = new TextEncoder();
const byteLength = (s) => enc.encode(s).length;

const errorText = {
  native_sequence_pending:
    "An earlier step is still being confirmed. Use Check status on it first.",
  central_earning_disabled: "Submitting is not open yet. Check back later.",
  central_proof_unavailable:
    "We couldn't check the network just now. Try again in a moment.",
  central_licence_inactive: "Join UAIN first (Account → Security). It is free and takes one signature.",
  central_inactive: "Paid tasks are paused right now.",
  central_project_inactive: "This project is not active or is halted for safety.",
  central_project_join_required: "Join the project before submitting.",
  central_already_joined: "You have already joined this project.",
  central_self_review_forbidden: "The appointed checker cannot submit work.",
  central_task_missing: "This task is not on the network.",
  central_task_specification_unusable: "This task is on hold while UAIN corrects its specification. Choose another available task.",
  central_task_not_open: "This task is not open for submissions.",
  central_task_not_funded: "This task's reward is not fully reserved yet.",
  central_submission_exists: "That answer was already sent. Review it again to send a new one.",
  central_intent_pending:
    "An earlier step is still waiting. Use Check status on it, or wait a few minutes.",
  central_intent_changed:
    "Something changed while you were reviewing. Review again; nothing was sent.",
  central_intent_missing: "That step was not found.",
  central_not_submitted: "This step was never sent, so there is nothing to check.",
  central_envelope_conflict:
    "This step was already sent. Use Check status.",
  central_envelope_mismatch: "The signed step did not match. Nothing was sent.",
  central_evidence_action_refused: "This step isn't available for this answer any more. Refresh to see where it stands.",
  invalid_central_payload: "The submission is not in the accepted format.",
  central_evidence_window_inactive:
    "The evidence window is not switched on for the network yet, so this request has no deadline or action yet.",
  central_evidence_request_absent: "This submission has no open evidence request.",
  central_evidence_window_open: "The evidence window is still open; it can be closed only after the deadline.",
  central_evidence_action_unavailable:
    "This evidence request already has its one revision or reassessment, or its window has closed.",
  central_submission_forbidden: "Only the submission's author can revise it or ask for a reassessment.",
};
const plain = (e) =>
  e?.name === "TimeoutError"
    ? "No answer in time. The outcome is unknown; use Check status before anything else."
    : errorText[e?.code] || errorText[e?.message] || e?.message || "Something went wrong. Try again.";
const aborted = (e) => e?.name === "AbortError";
// Exact micro-AI$ to display text, e.g. "1100000" -> "1.1" (shared formatter).
const units = displayUnits;

/** The server's advisory difficulty estimate, e.g. "Starter, about 50–100 min". */
export function difficultyLabel(d) {
  const names = { starter: "Starter", standard: "Standard", advanced: "Advanced" };
  if (!d || !names[d.level] || !Number.isInteger(d.minutes?.min) || !Number.isInteger(d.minutes?.max)) return "";
  return `${names[d.level]}, about ${d.minutes.min}–${d.minutes.max} min`;
}

export function TaskRequirements({ requirements, task }) {
  if (requirements?.available !== true) {
    return /listed in the verification policy/.test(task.criteria) ? (
      <p className="form-error" role="alert">
        This task's checklist is not available right now, so it can't be done yet. Pick another task;
        UAIN will publish the checklist for this one.
      </p>
    ) : null;
  }
  const policy = requirements.policy;
  const survey = policy?.successTests?.[0];
  if (requirements.authority !== "operator-published" || !survey || !Array.isArray(survey.requiredIds)) return null;
  return (
    <details className="nw-details" open>
      <summary>What your answer must include</summary>
      <p className="fine-print">Published by UAIN for this task.</p>
      <p><strong>Main goal:</strong> {survey.mainKpi}</p>
      <p>Include at least {survey.minIncluded} items (excluding screened-out items), from at least {survey.minKinds} identifier kinds.
        Account for every identifier below: include it or explain why it was screened out.</p>
      <ul>{survey.requiredIds.map(r => <li key={`${r.kind}:${r.id}`}><strong>{r.kind}</strong>: <code>{r.id}</code></li>)}</ul>
      <details><summary>Technical details</summary>
        <pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(policy, null, 2)}</pre>
        <p className="fine-print" style={{overflowWrap:"anywhere"}}>Checklist fingerprint: <code>{requirements.policyDigest}</code></p>
      </details>
    </details>
  );
}

const takesWork = centralTaskOpen;
const rank = (t) => (takesWork(t) ? 0 : t?.state === "under_review" ? 1 : t?.state === "open_unfunded" ? 2 : 3);
const byOpenFirst = (a, b) => rank(a) - rank(b);

const stateLabel = {
  open: "Open",
  open_unfunded: "Not funded yet",
  under_review: "Being checked",
  accepted: "Closed · accepted",
};

// Validate the public adapter context before replacing last proven income.
// Cryptographic native state verification remains with the pinned server reader.
function qualifiedStatus(data, identity, account, config) {
  try {
    const p = data?.proof, e = data?.earnings, expected = networkPins(config, account);
    const hash = /^[a-f0-9]{64}$/, uint = /^(0|[1-9][0-9]{0,19})$/;
    const cap = 108000000000000000000n;
    const amount = (v) => typeof v === "string" && /^(0|[1-9][0-9]{0,20})$/.test(v) && BigInt(v) <= cap;
    const keyProofs = [config?.native?.proof, account?.native?.proof].filter(Boolean);
    if (!expected || account.address !== identity.address || account.publicKey !== identity.publicKeyBase64 ||
        data?.verified !== true || data.authority !== "native" || data.member !== identity.address ||
        !["active", "pending", "revoked", "withdrawn"].includes(data.licence) || typeof data.active !== "boolean" ||
        data.assetId !== "uain-native-coin" || data.symbol !== "AI$" || data.decimals !== 6 ||
        data.balanceScope !== "transparent" || data.earningsScope !== "ever-earned-central-awards" ||
        !nativeProofFreshness(p).fresh || p.chainId !== expected.chainId || p.epoch !== expected.genesisSha256 ||
        p.genesisSha256 !== expected.genesisSha256 || !hash.test(p.appHash ?? "") || !hash.test(p.verifierSha256 ?? "") ||
        !keyProofs.length || keyProofs.some((x) => !hash.test(x.verifierSha256 ?? "") || x.verifierSha256 !== p.verifierSha256) ||
        typeof p.height !== "string" || !uint.test(p.height) || BigInt(p.height) < 1n || BigInt(p.height) > 9223372036854775807n ||
        e?.member !== identity.address || !amount(e.solver) || !amount(e.reviewer) || !amount(e.total) ||
        BigInt(e.solver) + BigInt(e.reviewer) !== BigInt(e.total) || typeof e.awards !== "string" || !uint.test(e.awards) ||
        BigInt(e.awards) > 18446744073709551615n || (data.balanceUnits !== null && (!amount(data.balanceUnits) || data.licence !== "active")) ||
        !Array.isArray(data.awards) || data.awards.length > 12) return false;
    const count = BigInt(e.awards), seen = new Set(), sums = { solver: 0n, reviewer: 0n };
    for (const a of data.awards) {
      if (a?.member !== identity.address || !["solver", "reviewer"].includes(a.role) || !amount(a.amount) ||
          BigInt(a.amount) === 0n || typeof a.height !== "string" || !uint.test(a.height) ||
          BigInt(a.height) < 1n || BigInt(a.height) > BigInt(p.height) ||
          ![a.submission, a.task, a.project].every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id))) return false;
      const ref = `${a.role}/${a.submission}`;
      if (seen.has(ref)) return false;
      seen.add(ref); sums[a.role] += BigInt(a.amount);
    }
    return data.awardsScope?.limit === 12 && data.awardsScope.total === e.awards &&
      data.awardsScope.complete === (count <= 12n) && data.awards.length === Number(count < 12n ? count : 12n) &&
      ["solver", "reviewer"].every((role) => sums[role] <= BigInt(e[role]) && (count > 12n || sums[role] === BigInt(e[role])));
  } catch { return false; }
}

const sent = sentIntent;
// Recorded on the network, including a recorded receipt that can't be
// re-checked right now (it must not count as waiting again).
const confirmed = settledIntent;
// Sent and not refused or recorded: the outcome is still open.
const outstanding = outstandingIntent;

/** Central AI$ earning: proven awards, funded tasks and public evidence only. */
export default function CentralEarning({ identity, account, config, onRefresh, onToast, onNavigate }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [, setProofClock] = useState(0);
  const [tasks, setTasks] = useState(null);
  const [tasksError, setTasksError] = useState("");
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [intents, setIntents] = useState([]);
  const [feedbackViews, setFeedbackViews] = useState({});
  const [drafts, setDrafts] = useState({});
  // Revised evidence text per original submission (S6 evidence journey).
  const [revisionDrafts, setRevisionDrafts] = useState({});
  const [reviewed, setReviewed] = useState(null);
  const [busy, setBusy] = useState("");
  useReleaseBusy(busy);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const session = useRef(0);
  const busyRef = useRef(false);
  const selectedRef = useRef(null);
  const statusFlight = useRef(null);
  const loop = useRef(null);
  const pollRef = useRef(null);
  const tasksRef = useRef(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [pollFailed, setPollFailed] = useState(false);
  const lastTotal = useRef(null);
  // One stable submission ID per task while its evidence is unchanged, so a
  // second review returns the same prepared step instead of a new one.
  const submissionIds = useRef(new Map());
  // Public survey templates (required identifiers, Main KPI, minimums) by survey task.
  const [templates, setTemplates] = useState({});
  const surveyId = detail?.task?.id && SURVEY_TASK.test(detail.task.id) ? detail.task.id : null;
  useEffect(() => {
    if (!surveyId || templates[surveyId]) return undefined;
    let live = true;
    api(`/api/native/central/survey-template/${encodeURIComponent(surveyId)}`)
      .then((t) => {
        if (!live || !t || !Array.isArray(t.required)) return;
        setTemplates((m) => ({ ...m, [surveyId]: t }));
        setDrafts((d) => (d[surveyId] ? d : { ...d, [surveyId]: surveyTemplateText(t) }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [surveyId]);
  // Inline parent callbacks must not restart effects or the poll.
  const refreshRef = useRef(onRefresh);
  const toastRef = useRef(onToast);
  refreshRef.current = onRefresh;
  toastRef.current = onToast;

  const pins = networkPins(config, account);
  const feedbackProofs = [config?.native?.proof, account?.native?.proof].filter(Boolean);
  const feedbackVerifier = feedbackProofs[0]?.verifierSha256;
  const feedbackContext = JSON.stringify([identity?.address, identity?.publicKeyBase64, account?.address,
    pins?.chainId, pins?.genesisSha256, ...feedbackProofs.map(p => p.verifierSha256)]);
  const feedbackContextRef = useRef(feedbackContext);
  feedbackContextRef.current = feedbackContext;
  const enabled = config?.centralEarning?.enabled === true;
  const statusFresh = nativeProofFreshness(status?.proof).fresh;
  const licensed = status?.licence === "active";
  const networkActive = status?.active === true;
  const canSign = Boolean(identity && account && pins && enabled && licensed && networkActive && statusFresh);

  useEffect(() => watchNativeProof(status?.proof, () => setProofClock((n) => n + 1)), [status?.proof]);

  const owner = () => {
    const ticket = session.current;
    return () => session.current === ticket;
  };

  async function readStatus(live) {
    // One status read per session at a time, whether polled or clicked.
    const key = session.current;
    if (statusFlight.current === key) return true;
    statusFlight.current = key;
    try {
      const data = await api("/api/native/central/status", { identity, isCurrent: live });
      if (!live()) return;
      if (!qualifiedStatus(data, identity, account, config))
        throw Object.assign(new Error(), { code: "central_proof_unavailable" });
      setStatus(data);
      setStatusError("");
      const total = data.earnings?.total;
      if (typeof total === "string" && UINT.test(total)) {
        const before = lastTotal.current;
        lastTotal.current = total;
        // Only a proven increase updates the parent's balance, once per rise.
        if (before !== null && BigInt(total) > BigInt(before)) refreshRef.current?.();
      }
      return true;
    } catch (e) {
      if (live() && !aborted(e)) {
        setStatusError(plain(e));
        // Keep proven past income, but a failed read cannot retain current authority.
        setStatus((previous) => previous && { ...previous, proof: null });
      }
      return false;
    } finally {
      if (statusFlight.current === key) statusFlight.current = null;
    }
  }

  // mode: "fresh" replaces the list, "merge" refreshes it and keeps older
  // tasks already shown, "older" loads the next older page.
  async function readTasks(live, mode = "fresh") {
    const fetchPage = async (cursor, limit) => {
      const data = await api(
        `/api/native/central/tasks?cursor=${encodeURIComponent(cursor)}&limit=${limit}`,
        { identity, isCurrent: live },
      );
      return live() ? data : undefined;
    };
    // Open tasks, newest first, from the open-only listing: never hidden in
    // unread middle pages.
    const fetchOpen = async (cursor, limit) => {
      const data = await api(
        `/api/native/central/tasks?cursor=${encodeURIComponent(cursor)}&limit=${limit}&order=newest&state=open`,
        { identity, isCurrent: live },
      );
      return live() ? data : undefined;
    };
    try {
      if (mode === "older") {
        if (!tasksRef.current) return true;
        const w = await loadOlderTasks(fetchPage, tasksRef.current, { page: PAGE });
        if (!w || !live()) return false;
        setTasks((prev) => (prev ? mergeTaskWindow(prev, w) : w));
      } else {
        // The newest pages are read too, so newly opened tasks are never hidden
        // behind older closed ones.
        const [w, open] = await Promise.all([
          loadTaskWindow(fetchPage, { page: PAGE, tailPages: 4 }),
          // An older server without the open-only listing still shows the window.
          loadOpenTasks(fetchOpen, { page: PAGE }).catch((e) => {
            if (aborted(e)) throw e;
            return null;
          }),
        ]);
        if (!w || !live()) return false;
        const freshIds = new Set(w.list.map((t) => t.id));
        setTasks((prev) => withOpenTasks(mode === "merge" ? mergeTaskWindow(prev, w) : w, open, freshIds));
      }
      setTasksError("");
      return true;
    } catch (e) {
      if (live() && !aborted(e)) setTasksError(plain(e));
      return false;
    }
  }

  async function readDetail(live, id) {
    try {
      const data = await api(`/api/native/central/tasks/${encodeURIComponent(id)}`, {
        identity,
        isCurrent: live,
      });
      if (!live() || selectedRef.current !== id) return true;
      // The proof height says how current this task read is (see submissionStatus).
      const stamped = data?.task ? { ...data, task: { ...data.task, provenAt: data.proof?.height } } : data;
      setDetail(stamped);
      setDetailError("");
      if (data?.task?.id === id)
        setTasks((prev) =>
          prev && { ...prev, list: prev.list.map((t) => (t.id === id ? stamped.task : t)) },
        );
      return true;
    } catch (e) {
      if (live() && selectedRef.current === id && !aborted(e)) setDetailError(plain(e));
      return false;
    }
  }

  async function readIntents(live) {
    try {
      const data = await api("/api/native/central/intents", { identity, isCurrent: live });
      if (live()) setIntents(Array.isArray(data?.intents) ? data.intents : []);
      return true;
    } catch (e) {
      if (live() && !aborted(e)) setError(plain(e));
      return false;
    }
  }

  useEffect(() => {
    const ticket = ++session.current;
    const live = () => session.current === ticket;
    setStatus(null);
    setStatusError("");
    setTasks(null);
    setTasksError("");
    setSelected(null);
    setDetail(null);
    setDetailError("");
    setIntents([]);
    setFeedbackViews({});
    setDrafts({});
    setRevisionDrafts({});
    setReviewed(null);
    setError("");
    setNote("");
    setBusy("");
    setLoading(false);
    selectedRef.current = null;
    lastTotal.current = null;
    submissionIds.current = new Map();
    if (!identity) return () => void session.current++;
    setUpdatedAt(null);
    setPollFailed(false);
    Promise.all([readStatus(live), readTasks(live), readIntents(live)]).then((r) => {
      if (live()) { setUpdatedAt(Date.now()); setPollFailed(r.includes(false)); }
    });
    // Reads only: status, the task list, the open task and your steps, every 30
    // seconds while the page is visible, never two at once, backing off on errors.
    const current = loop.current = createRefreshLoop({
      intervalMs: POLL_MS,
      maxIntervalMs: POLL_MAX_MS,
      run: () => (live() ? pollRef.current(live) : false),
      onSettled: ({ ok, at }) => {
        if (!live()) return;
        setUpdatedAt(at);
        setPollFailed(!ok);
      },
    });
    return () => {
      session.current++;
      current.stop();
      if (loop.current === current) loop.current = null;
    };
  }, [identity]);

  const act = async (label, fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const live = owner();
    setBusy(label);
    setError("");
    setNote("");
    try {
      await fn(live);
    } catch (e) {
      if (live() && !aborted(e)) setError(plain(e));
    } finally {
      busyRef.current = false;
      if (live()) setBusy("");
    }
  };

  const readFeedbackFor = (intent) => act("Reading checker feedback…", async (live) => {
    const context = feedbackContext, submission = intent.command?.payload?.id, taskId = intent.command?.payload?.task;
    const current = () => live() && feedbackContextRef.current === context;
    if (!current()) return;
    setFeedbackViews(m => ({...m, [submission]: {context, view: {status: "loading"}}}));
    try {
      if (!pins || !feedbackProofs.length || !/^[a-f0-9]{64}$/.test(feedbackVerifier ?? "") ||
          feedbackProofs.some(p => p.verifierSha256 !== feedbackVerifier)) throw Error("Feedback proof unavailable");
      const view = await readSubmissionFeedback({submission, task: taskId, author: identity.address, pins, verifierSha256: feedbackVerifier}, {
        isCurrent: current, apiCall: (path, options) => api(path, {...options, identity}),
      });
      if (current()) setFeedbackViews(m => ({...m, [submission]: {context, view}}));
    } catch {
      if (current()) setFeedbackViews(m => ({...m, [submission]: {context, view: {status: "unavailable"}}}));
    }
  });

  // Needs evidence is only in the checker's decision record, so read it
  // quietly for your submissions that are still being checked.
  const outcomeRef = useRef(null);
  outcomeRef.current = { intents, status, tasks, detail, feedbackContext, feedbackViews, pins, feedbackProofs, feedbackVerifier };
  async function readOutcomes(live) {
    const now = outcomeRef.current;
    const context = now.feedbackContext;
    if (!now.pins || !now.feedbackProofs.length || !/^[a-f0-9]{64}$/.test(now.feedbackVerifier ?? "") ||
        now.feedbackProofs.some((p) => p.verifierSha256 !== now.feedbackVerifier)) return;
    const awardsNow = Array.isArray(now.status?.awards) ? now.status.awards : [];
    const taskOf = (id) => (now.detail?.task?.id === id ? now.detail.task : now.tasks?.list?.find((t) => t.id === id) ?? null);
    // Still being checked, or waiting on an evidence request (its deadline,
    // revision or expiry changes without the task list showing it).
    const views = now.feedbackViews ?? {};
    const journeyOpen = (id) => {
      const v = views[id]?.context === context ? views[id].view : null;
      return v?.currentOutcome === "needs_evidence" || ["reviewer_request", "reassessment_pending", "verification_service"].includes(v?.evidence?.kind);
    };
    const checking = now.intents.filter((i) => i.command?.operation === "central_submit" && confirmed(i) &&
      (journeyOpen(i.command.payload?.id) ||
        submissionStatus(i, { awards: awardsNow, task: taskOf(i.command.payload?.task) }).kind === "under_review")).slice(0, 4);
    for (const i of checking) {
      const submission = i.command.payload.id, taskId = i.command.payload.task;
      const current = () => live() && feedbackContextRef.current === context;
      try {
        const view = await readSubmissionFeedback({ submission, task: taskId, author: identity.address, pins: now.pins, verifierSha256: now.feedbackVerifier }, {
          isCurrent: current, apiCall: (path, options) => api(path, { ...options, identity }),
        });
        if (current() && (view?.status === "ready" || view?.evidence)) setFeedbackViews((m) => ({ ...m, [submission]: { context, view } }));
      } catch {
        // Quiet: the explicit "checker feedback" read still reports problems.
      }
    }
  }

  // One poll: status, tasks (keeping older ones shown), the open task, your
  // steps, then the checker outcome of your submissions still being checked.
  pollRef.current = async (live) => {
    const results = await Promise.all([
      readStatus(live),
      readTasks(live, "merge"),
      readIntents(live),
      selectedRef.current ? readDetail(live, selectedRef.current) : true,
    ]);
    if (live()) await readOutcomes(live);
    return !results.includes(false);
  };
  tasksRef.current = tasks;

  // Refresh joins the poll in flight, so two reads never overlap.
  const refreshAll = async () => {
    if (loading) return;
    const live = owner();
    setLoading(true);
    if (loop.current) await loop.current.runNow();
    else await pollRef.current(live);
    if (live()) setLoading(false);
  };

  const choose = (id) => {
    if (selectedRef.current === id) return;
    selectedRef.current = id;
    setSelected(id);
    setDetail(null);
    setDetailError("");
    setReviewed(null);
    readDetail(owner(), id);
  };

  const saveIntent = (intent) =>
    setIntents((rows) => [intent, ...rows.filter((r) => r.id !== intent.id)]);

  async function prepare(live, operation, payload, taskId, draft = payload.evidence, evidenceFor = null) {
    const data = await api("/api/native/central/prepare", {
      identity,
      method: "POST",
      body: { operation, payload },
      isCurrent: live,
    });
    if (!live()) return;
    const intent = data?.intent;
    if (!intent || intent.command?.operation !== operation)
      throw new Error("The prepared step does not match. Nothing was signed.");
    if (intent.status !== "prepared") {
      saveIntent(intent);
      throw new Error("This step was already sent. Use Check status below.");
    }
    setReviewed(
      Object.freeze({ intent, operation, payload: Object.freeze({ ...payload }), taskId, identity, draft, evidenceFor }),
    );
  }

  const reviewJoin = () =>
    act("Preparing to join…", async (live) => {
      const task = detail?.task;
      if (!task) return;
      await prepare(live, "project_join", { project: task.project }, task.id);
    });

  // The exact evidence text for a task: a survey becomes the canonical artifact
  // the fixed verifier reads, naming the submission and your address.
  async function buildEvidence(live, taskId, draftText, submissionId) {
    if (!draftText.trim()) throw new Error("Write your evidence first.");
    if (!draftText.isWellFormed()) throw new Error("The evidence contains invalid characters.");
    let evidence = draftText;
    if (SURVEY_TASK.test(taskId)) {
      let template = templates[taskId];
      if (!template) {
        template = await api(`/api/native/central/survey-template/${encodeURIComponent(taskId)}`, { isCurrent: live });
        if (!live()) return null;
        if (!template || !Array.isArray(template.required)) throw new Error("The survey template is unavailable. Try again in a moment.");
        setTemplates((m) => ({ ...m, [taskId]: template }));
      }
      const parsed = parseSurveyDraft(draftText, template);
      if (parsed.errors) throw new Error(`Fix the survey first: ${parsed.errors.slice(0, 4).join("; ")}.`);
      evidence = surveyEvidence({ taskId, submissionId, author: identity.address, survey: parsed.survey });
    }
    if (byteLength(evidence) > EVIDENCE_MAX)
      throw new Error("Your answer is too long. Shorten the notes.");
    return evidence;
  }

  // S6 evidence journey: one linked revision, one reassessment, or closing an
  // expired request. Each is prepared here, reviewed, then signed on this device.
  const reviewEvidenceAction = (intent, operation) =>
    act("Getting it ready to sign…", async (live) => {
      const submission = intent.command?.payload?.id, taskId = intent.command?.payload?.task;
      if (operation !== "central_submit") {
        await prepare(live, operation, evidenceActionPayload(operation, { submission }), taskId, undefined, submission);
        return;
      }
      const draftText = revisionDrafts[submission] ?? "";
      const key = `revise:${submission}`;
      let slot = submissionIds.current.get(key);
      if (!slot || slot.draft !== draftText) {
        slot = { draft: draftText, id: `CS-${crypto.randomUUID()}` };
        submissionIds.current.set(key, slot);
      }
      const evidence = await buildEvidence(live, taskId, draftText, slot.id);
      if (evidence === null || !live()) return;
      const payload = evidenceActionPayload("central_submit", {
        submission, task: taskId, id: slot.id, evidence, evidence_digest: await centralEvidenceDigest(evidence),
      });
      if (!live()) return;
      await prepare(live, "central_submit", payload, taskId, draftText, submission);
    });

  const reviewSubmission = (e) => {
    e.preventDefault();
    act("Preparing your submission for review…", async (live) => {
      const task = detail?.task;
      if (!task) return;
      const draftText = drafts[task.id] ?? "";
      if (!draftText.trim()) throw new Error("Write your evidence first.");
      if (!draftText.isWellFormed()) throw new Error("The evidence contains invalid characters.");
      let slot = submissionIds.current.get(task.id);
      if (!slot || slot.draft !== draftText) {
        slot = { draft: draftText, id: `CS-${crypto.randomUUID()}` };
        submissionIds.current.set(task.id, slot);
      }
      let evidence = draftText;
      if (SURVEY_TASK.test(task.id)) {
        // A survey is submitted as the canonical artifact the fixed verifier reads,
        // naming this submission and your address.
        const template = templates[task.id];
        if (!template) throw new Error("The survey template is still loading. Try again in a moment.");
        const parsed = parseSurveyDraft(draftText, template);
        if (parsed.errors) throw new Error(`Fix the survey first: ${parsed.errors.slice(0, 4).join("; ")}.`);
        evidence = surveyEvidence({ taskId: task.id, submissionId: slot.id, author: identity.address, survey: parsed.survey });
      }
      if (byteLength(evidence) > EVIDENCE_MAX)
        throw new Error("Your answer is too long. Shorten the notes.");
      const payload = {
        id: slot.id,
        task: task.id,
        evidence,
        evidence_digest: await centralEvidenceDigest(evidence),
      };
      if (!live()) return;
      await prepare(live, "central_submit", payload, task.id, draftText);
    });
  };

  const signAndSend = () =>
    act("Signing on this device and sending…", async (live) => {
      const r = reviewed;
      if (!r) return;
      if (r.identity !== identity) throw new Error("The signed-in identity changed. Nothing was sent.");
      if (!r.evidenceFor && r.taskId !== selectedRef.current)
        throw new Error("The selected task changed. Review again; nothing was sent.");
      if (r.operation === "central_submit" &&
          (r.evidenceFor ? revisionDrafts[r.evidenceFor] : drafts[r.taskId]) !== r.draft)
        throw new Error("The evidence changed after review. Review again; nothing was sent.");
      if (!enabled) throw Object.assign(new Error(), { code: "central_earning_disabled" });
      if (!pins) throw new Error("Network details for signing are unavailable. Nothing was sent.");
      let envelope;
      try {
        envelope = await signCentralEarningIntent(identity, r.intent, {
          ...pins,
          expectedOperation: r.operation,
          expectedPayload: r.payload,
        });
      } catch {
        if (live()) setReviewed(null);
        throw new Error(
          "Signing stopped: the step or its network proof changed or expired. Review again; nothing was sent.",
        );
      }
      if (!live()) return;
      // This review is spent. An unclear send is checked, never re-sent from here.
      setReviewed(null);
      let data;
      try {
        data = await api(
          `/api/native/central/intents/${encodeURIComponent(r.intent.id)}/submit`,
          { identity, method: "POST", body: { envelope }, isCurrent: live },
        );
      } catch (e) {
        if (live()) await readIntents(live);
        throw e;
      }
      if (!live()) return;
      if (data?.intent?.id !== r.intent.id) throw new Error("The reply did not match. Use Check status.");
      saveIntent(data.intent);
      const message =
        data.intent.status === "refused"
          ? "The network refused this step. Nothing was recorded."
          : "Sent. Use Check status for the network record. Nothing is earned yet.";
      setNote(message);
      toastRef.current?.(message);
    });

  // A read: finds the exact receipt for a step already sent. Never re-sends.
  const checkStatus = (intent) =>
    act("Checking the network record…", async (live) => {
      const data = await api(
        `/api/native/central/intents/${encodeURIComponent(intent.id)}/reconcile`,
        { identity, method: "POST", body: {}, isCurrent: live },
      );
      if (!live()) return;
      const next = data?.intent;
      if (next?.id !== intent.id) throw new Error("The reply did not match this step.");
      saveIntent(next);
      if (!confirmed(next)) {
        setNote(
          data.moreEvents || next.moreEvents
            ? "Not found yet; more network events remain. Check again."
            : "Not recorded yet. Check again shortly.",
        );
        return;
      }
      const p = next.command?.payload ?? {};
      if (next.command?.operation === "central_submit") {
        // The draft is cleared only once its exact text is confirmed on the network.
        setDrafts((d) => {
          if (d[p.task] !== p.evidence && !SURVEY_TASK.test(p.task ?? "")) return d;
          const rest = { ...d };
          delete rest[p.task];
          return rest;
        });
        if (submissionIds.current.get(p.task)?.id === p.id) submissionIds.current.delete(p.task);
        if (p.revises) {
          if (submissionIds.current.get(`revise:${p.revises}`)?.id === p.id) submissionIds.current.delete(`revise:${p.revises}`);
          setRevisionDrafts((d) => {
            const rest = { ...d };
            delete rest[p.revises];
            return rest;
          });
        }
        setNote(p.revises
          ? "Resubmitted. The reviewer checks your new answer; it earns only if accepted."
          : "Your submission is on the network. It earns only if a checker accepts it.");
      } else if (next.command?.operation === "central_reassess")
        setNote("Sent. The reviewer will look again and accept or reject it.");
      else if (next.command?.operation === "central_evidence_expire")
        setNote("The task is open again. Nothing was charged.");
      else setNote("You have joined the project.");
      const current = selectedRef.current;
      await Promise.all([
        current && readDetail(live, current),
        next.command?.operation === "central_submit" && readTasks(live, "merge"),
      ]);
    });

  const editDraft = (taskId) => (e) => {
    const value = e.target.value;
    setDrafts((d) => ({ ...d, [taskId]: value }));
    setReviewed((r) => (r?.operation === "central_submit" && r.taskId === taskId ? null : r));
  };

  const earnings = status?.earnings;
  const awards = Array.isArray(status?.awards) ? status.awards : [];
  // Contribution leads (P0-3): points are the chain's Karma; AI$ is the ledger record below.
  const contribution = contributionDisplay(status?.contribution);
  const headline = !identity
    ? "Sign in to see research tasks"
    : !status
      ? statusError
        ? "Your contribution is unavailable right now"
        : "Checking your contribution…"
      : contribution
        ? contribution.headline
        : "Contribution points unavailable right now";

  const task = detail?.task?.id === selected ? detail.task : null;
  const own = intents.filter(sent);
  const ownPending = task
    ? intents.find(
        (i) =>
          i.command?.operation === "central_submit" &&
          i.command.payload?.task === task.id &&
          outstanding(i),
      )
    : null;
  const joinPending = task
    ? intents.find(
        (i) =>
          i.command?.operation === "project_join" &&
          i.command.payload?.project === task.project &&
          outstanding(i),
      )
    : null;
  const ownSubmissionIds = new Set(
    intents.filter((i) => i.command?.operation === "central_submit").map((i) => i.command.payload?.id),
  );
  const open = centralTaskOpen(task);
  const draft = task ? drafts[task.id] ?? "" : "";
  const draftBytes = byteLength(draft);
  const reviewHere = reviewed && !reviewed.evidenceFor && task && reviewed.taskId === task.id ? reviewed : null;
  // Each own step joined to the awards, its task and any checker decision read.
  const taskById = (id) =>
    detail?.task?.id === id ? detail.task : tasks?.list?.find((t) => t.id === id) ?? null;
  const stepOf = (i) => {
    const submission = i.command?.payload?.id;
    const fb = feedbackViews[submission]?.context === feedbackContext ? feedbackViews[submission].view : null;
    const revisedBy = submission && intents.some((j) => j.command?.operation === "central_submit" &&
      j.command.payload?.revises === submission && settledIntent(j));
    return submissionStatus(i, { awards, task: taskById(i.command?.payload?.task), feedback: fb, revisedBy });
  };
  const stepClass = (kind) =>
    kind === "accepted" ? "paid" : ["rejected", "not_accepted", "refused", "expired"].includes(kind) ? "refused" : undefined;
  const STEP_NAMES = {
    project_join: "Join project",
    central_reassess: "Asked for another look",
    central_evidence_expire: "Reopened a task",
  };
  const stepName = (i) =>
    STEP_NAMES[i.command?.operation] ?? (i.command?.payload?.revises ? "Resubmission" : "Submission");
  const stepWhere = (i) =>
    i.command?.operation === "project_join"
      ? i.command?.payload?.project
      : i.command?.payload?.submission
        ? `submission ${i.command.payload.submission}`
        : i.command?.payload?.revises
          ? `task ${i.command?.payload?.task}`
          : `task ${i.command?.payload?.task}`;

  return (
    <section className="panel native-earning" aria-label="Paid tasks" aria-busy={!!busy || loading}>
      <div className="nw-head">
        <div>
          <span className="ne-eyebrow">Research tasks · contribution points (Karma)</span>
          <h3>{headline}</h3>
          <p>
            Pick a task and send your answer. When an independent checker accepts it, it adds
            to your contribution points, and the AI$ it was paid is recorded below.
          </p>
        </div>
        <div className="nw-head-actions">
          <button
            type="button"
            className="button small"
            onClick={refreshAll}
            disabled={!identity || loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" /> Refresh
          </button>
          {identity && <RefreshCue at={updatedAt} busy={loading} failed={pollFailed} />}
        </div>
      </div>

      {!identity || !account ? (
        <p className="status-note">
          <AlertCircle size={16} aria-hidden="true" /> Sign in with your account to see
          earnings and tasks.
        </p>
      ) : (
        <>
          {statusError && (
            <p className="status-note" role="alert">
              <AlertCircle size={16} aria-hidden="true" /> {statusError}
              {status ? " Showing your last known figures." : ""}
            </p>
          )}
          {status && !licensed && (
            <p className="status-note">
              <AlertCircle size={16} aria-hidden="true" /> Join UAIN to take paid tasks. It is free
              and takes one signature.{" "}
              {onNavigate && (
                <button type="button" className="small-action" onClick={() => onNavigate("Security")}>
                  Join UAIN
                </button>
              )}
            </p>
          )}
          {status && !networkActive && (
            <p className="status-note">
              <AlertCircle size={16} aria-hidden="true" /> Paid tasks are paused right now. You
              can still read them.
            </p>
          )}
          {!enabled && (
            <p className="status-note">
              <AlertCircle size={16} aria-hidden="true" /> Submitting is not open yet. Check back
              later.
            </p>
          )}
          {!pins && (
            <p className="status-note">
              <AlertCircle size={16} aria-hidden="true" /> We can't reach the network right now, so
              nothing can be signed. Try Refresh.
            </p>
          )}

          {status && contribution && (
            <div className="ne-contribution" aria-label="Your contribution">
              <dl className="nw-exact">
                <dt>{contribution.label}</dt>
                <dd>{contribution.totals.points}</dd>
                <dt>Accepted answers</dt>
                <dd>{contribution.totals.accepted}</dd>
                {contribution.checksText && (
                  <>
                    <dt>Checks for others</dt>
                    <dd>{contribution.totals.checks}</dd>
                  </>
                )}
              </dl>
              <p className="fine-print">{contribution.note}</p>
              {contribution.accepted.length > 0 && (
                <ul className="ne-intents" aria-label="Accepted answers">
                  {contribution.accepted.map((a) => (
                    <li key={a.key}>
                      <span>
                        <strong>{a.points} points</strong>
                        <small>
                          Task {a.task} · project {a.project}
                        </small>
                      </span>
                      <em className="paid">Accepted</em>
                    </li>
                  ))}
                </ul>
              )}
              {contribution.notCountedText && <p className="fine-print">{contribution.notCountedText}</p>}
            </div>
          )}
          {status?.contribution?.available === false && (
            <p className="status-note">
              <AlertCircle size={16} aria-hidden="true" /> {status.contribution.note}
            </p>
          )}

          {status && earnings && (
            <>
              <h4 className="ne-ledger-head">AI$ ledger</h4>
              <dl className="nw-exact" aria-label="Your AI$ ledger">
                <dt>AI$ earned so far</dt>
                <dd>{units(earnings.total)} AI$</dd>
                <dt>For your answers</dt>
                <dd>{units(earnings.solver)} AI$</dd>
                <dt>For checking others</dt>
                <dd>{units(earnings.reviewer)} AI$</dd>
                {typeof status.balanceUnits === "string" && (
                  <>
                    <dt>Balance now</dt>
                    <dd>{statusFresh ? `${units(status.balanceUnits)} AI$` : "Unavailable"}</dd>
                  </>
                )}
              </dl>
              <p className="fine-print">
                "AI$ earned so far" adds up what accepted answers and checks were paid; your
                balance is what you have now. Paying or being paid changes the balance, never your
                points.
              </p>
              {awards.length > 0 && (
                <ul className="ne-intents" aria-label="Recent awards">
                  {awards.map((a) => (
                    <li key={`${a.role}/${a.submission}`}>
                      <span>
                        <strong>{units(a.amount)} AI$</strong>
                        <small>
                          {a.role === "reviewer" ? "For checking" : "For your answer"} · task {a.task}
                        </small>
                      </span>
                      <em className="paid">Awarded</em>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="nw-grid">
            <div className="nw-list">
              <h4>
                Tasks
                {tasks && UINT.test(tasks.total ?? "") ? ` (${tasks.total})` : ""}
              </h4>
              {tasks && UINT.test(tasks.openCount ?? "") && (
                <p className="fine-print">
                  {tasks.openCount === "1" ? "1 task you can take now" : `${tasks.openCount} tasks you can take now`}, newest
                  first.
                </p>
              )}
              {tasksError && (
                <p className="form-error" role="alert">
                  <AlertCircle size={16} aria-hidden="true" /> {tasksError}
                </p>
              )}
              {!tasks && !tasksError && <p className="nw-empty">Loading tasks…</p>}
              {tasks && tasks.list.length === 0 && (
                <p className="nw-empty">No paid tasks are on the network yet.</p>
              )}
              {tasks && tasks.list.length > 0 && !tasks.list.some(takesWork) && (
                <p className="status-note">
                  <AlertCircle size={16} aria-hidden="true" /> No paid task is open right now.
                  New tasks open when a project manager funds them, on no fixed schedule.
                  This list checks again every 30 seconds while the page is open.
                </p>
              )}
              {tasks && tasks.list.length > 0 && (
                <ul>
                  {[...tasks.list].sort(byOpenFirst).map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={t.id === selected ? "active" : ""}
                        aria-pressed={t.id === selected}
                        onClick={() => choose(t.id)}
                      >
                        <FileText size={15} aria-hidden="true" />
                        <span>
                          <strong>{t.title}</strong>
                          <small>
                            {units(t.solver_amount)} AI$ reward · {t.project}
                            {difficultyLabel(t.difficulty) && ` · ${difficultyLabel(t.difficulty)}`}
                          </small>
                        </span>
                        <em
                          className={`nw-status${t.state === "accepted" ? " s-recipient-confirmed-paid" : ""}`}
                        >
                          {centralTaskLabel(t, stateLabel)}
                        </em>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {tasks?.more && (
                <button
                  type="button"
                  className="text-link"
                  disabled={loading}
                  onClick={() => readTasks(owner(), "older")}
                >
                  Show older tasks
                </button>
              )}
            </div>

            <div className="nw-detail" aria-live="polite">
              {!selected && <p className="nw-empty">Choose a task to see its criteria.</p>}
              {selected && !task && !detailError && <p className="nw-empty">Loading task…</p>}
              {detailError && (
                <p className="form-error" role="alert">
                  <AlertCircle size={16} aria-hidden="true" /> {detailError}
                </p>
              )}
              {task && (
                <>
                  <h3>{task.title}</h3>
                  <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {task.criteria}
                  </p>
                  <TaskRequirements requirements={detail.requirements} task={task} />
                  <dl className="nw-exact">
                    <dt>Reward if accepted</dt>
                    <dd>{units(task.solver_amount)} AI$</dd>
                    <dt>Checker reward</dt>
                    <dd>{units(task.reviewer_amount)} AI$</dd>
                    <dt>State</dt>
                    <dd>{centralTaskLabel(task, stateLabel)}</dd>
                    {difficultyLabel(detail.difficulty) && (
                      <>
                        <dt>Difficulty (estimate)</dt>
                        <dd title={(detail.difficulty.reasons || []).map((r) => r.note).join("\n")}>
                          {difficultyLabel(detail.difficulty)}
                        </dd>
                      </>
                    )}
                    <dt>Project</dt>
                    <dd>
                      <code>{task.project}</code>
                      {detail.joined ? " · joined" : " · not joined"}
                    </dd>
                    {detail.budget && (
                      <>
                        <dt>Project budget left</dt>
                        <dd>
                          {units(detail.budget.available)} of {units(detail.budget.allocation)}{" "}
                          AI$ · not your balance
                        </dd>
                      </>
                    )}
                    <dt>Task ID</dt>
                    <dd>
                      <code>{task.id}</code>
                    </dd>
                  </dl>

                  {task.winner && (
                    <p className="status-note">
                      <CheckCircle2 size={16} aria-hidden="true" />{" "}
                      {ownSubmissionIds.has(task.winner)
                        ? "Your submission was accepted."
                        : "Another submission was accepted. This task is closed."}
                    </p>
                  )}
                  {!task.winner && task.pending && (
                    <p className="status-note">
                      <AlertCircle size={16} aria-hidden="true" />{" "}
                      {ownSubmissionIds.has(task.pending)
                        ? "Your submission is being checked."
                        : "A submission is being checked. New submissions wait until it is decided."}
                    </p>
                  )}
                  {task.state === "open_unfunded" && (
                    <p className="status-note">
                      <AlertCircle size={16} aria-hidden="true" /> Not funded yet. {UNFUNDED_TASK_TEXT}
                    </p>
                  )}

                  {centralTaskJoinPrompt(task, detail) &&
                    (joinPending ? (
                      <p className="fine-print">
                        Your join request was sent. Use Check status below.
                      </p>
                    ) : (
                      <div className="nw-actions">
                        <button
                          type="button"
                          className="button"
                          onClick={reviewJoin}
                          disabled={!!busy || !canSign || detail.active !== true || !!reviewHere}
                        >
                          Review joining this project
                        </button>
                        <span className="fine-print">Join the project before submitting.</span>
                      </div>
                    ))}

                  {detail.joined && ownPending && (
                    <p className="fine-print">
                      Your submission for this task was sent. Use Check status below; only
                      one submission per task can wait at a time.
                    </p>
                  )}

                  {detail.joined && open && !ownPending && (
                    <form onSubmit={reviewSubmission}>
                      <label className="field">
                        <span>Public evidence</span>
                        <textarea
                          rows={8}
                          value={draft}
                          onChange={editDraft(task.id)}
                          aria-describedby="ce-evidence-warning ce-evidence-count"
                          aria-invalid={draftBytes > EVIDENCE_MAX}
                          spellCheck="true"
                        />
                      </label>
                      <p id="ce-evidence-warning" className="fine-print">
                        <AlertCircle size={14} aria-hidden="true" /> Your submission is
                        recorded publicly. Never include secrets, keys or private data.
                      </p>
                      <p id="ce-evidence-count" className="fine-print">
                        {draftBytes > 14000
                          ? `Nearly full: ${Math.min(100, Math.round((draftBytes / 16384) * 100))}% of the space used`
                          : `${Math.round((draftBytes / 16384) * 100)}% of the space used`}
                      </p>
                      <div className="nw-actions">
                        <button
                          type="submit"
                          className="button"
                          disabled={
                            !!busy ||
                            !canSign ||
                            detail.active !== true ||
                            !draft.trim() ||
                            draftBytes > EVIDENCE_MAX ||
                            !!reviewHere
                          }
                        >
                          Review submission
                        </button>
                      </div>
                    </form>
                  )}

                  {reviewHere && (
                    <div className="nw-review" role="group" aria-label="Review before signing">
                      <dl className="nw-exact">
                        <dt>Step</dt>
                        <dd>
                          {reviewHere.operation === "project_join"
                            ? "Join the project"
                            : "Send your answer"}
                        </dd>
                        {reviewHere.operation === "project_join" ? (
                          <>
                            <dt>Project</dt>
                            <dd>
                              <code>{reviewHere.payload.project}</code>
                            </dd>
                          </>
                        ) : (
                          <>
                            <dt>Task</dt>
                            <dd>
                              <code>{reviewHere.payload.task}</code>
                            </dd>
                            <dt>Answer</dt>
                            <dd>Exactly as written above</dd>
                          </>
                        )}
                        <dt>Sign within</dt>
                        <dd>about 3 minutes</dd>
                      </dl>
                      <p>
                        Signing happens on this device.
                        {reviewHere.operation === "central_submit"
                          ? " The evidence becomes public. Nothing is earned unless a checker accepts it."
                          : ""}
                      </p>
                      <div className="nw-actions">
                        <button
                          type="button"
                          className="button small"
                          onClick={() => setReviewed(null)}
                          disabled={!!busy}
                        >
                          Not now
                        </button>
                        <button
                          type="button"
                          className="button ink"
                          onClick={signAndSend}
                          disabled={!!busy || !canSign}
                        >
                          <LockKeyhole size={15} aria-hidden="true" />{" "}
                          {reviewHere.operation === "project_join" ? "Sign and join" : "Sign and submit"}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {own.length > 0 && (
            <>
              <h4>Your steps</h4>
              <ul className="ne-intents" aria-label="Your joins and submissions">
                {own.map((i) => (
                  <li key={i.id}>
                    <span>
                      <strong>{stepName(i)}</strong>
                      <small>{stepWhere(i)}</small>
                    </span>
                    <em className={stepClass(stepOf(i).kind)} title={stepOf(i).detail}>{stepOf(i).label}</em>
                    {stepOf(i).delayed && <small className="review-delay" role="note">{stepOf(i).detail}</small>}
                    {["under_review", "submitted"].includes(stepOf(i).kind) && <ReviewQueueNote sentAt={i.sendAttemptedAt ?? i.createdAt} />}
                    {i.command?.operation === "central_submit" && confirmed(i) && (
                      <CentralReviewFeedback
                        view={feedbackViews[i.command.payload.id]?.context === feedbackContext ? feedbackViews[i.command.payload.id].view : null}
                        onRead={() => readFeedbackFor(i)} disabled={!!busy}
                      />
                    )}
                    {i.command?.operation === "central_submit" && confirmed(i) && (() => {
                      const submission = i.command.payload.id;
                      const fv = feedbackViews[submission]?.context === feedbackContext ? feedbackViews[submission].view : null;
                      if (!fv?.evidence) return null;
                      const mine = reviewed?.evidenceFor === submission ? reviewed : null;
                      return (
                        <CentralEvidenceJourney
                          view={fv.evidence}
                          showFindings={fv.status !== "ready"}
                          canSign={canSign}
                          disabled={!!busy}
                          revisionDraft={revisionDrafts[submission] ?? ""}
                          onRevisionDraft={(value) => {
                            setRevisionDrafts((d) => ({ ...d, [submission]: value }));
                            setReviewed((r) => (r?.evidenceFor === submission && r.operation === "central_submit" ? null : r));
                          }}
                          onReviewRevision={() => reviewEvidenceAction(i, "central_submit")}
                          onReviewReassess={() => reviewEvidenceAction(i, "central_reassess")}
                          onReviewExpire={() => reviewEvidenceAction(i, "central_evidence_expire")}
                          reviewed={mine}
                          onSign={signAndSend}
                          onCancel={() => setReviewed(null)}
                        />
                      );
                    })()}
                    {outstanding(i) && i.receiptRequired && (
                      <button
                        type="button"
                        className="small-action"
                        onClick={() => checkStatus(i)}
                        disabled={!!busy}
                      >
                        Check status
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <p className="fine-print" role="status" aria-live="polite">
        {busy || note}
      </p>
      {error && (
        <p className="form-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" /> {error}
        </p>
      )}
    </section>
  );
}
