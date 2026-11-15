import React from "react";
import { blocksLeftText } from "./central-evidence-view.js";

// What happens next when a reviewer asks for more evidence, for one of your own
// submissions. Kept simple on purpose (Rahul, 10 November 2026): plain words,
// one clear next step, the deadline as a date and time left, findings as a
// short list, no internal terms. The parent owns every action (prepare, sign
// on this device, send). Findings render as escaped plain text.

const wrapText = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" };
const short = (a) => (a ? `${a.slice(0, 11)}…${a.slice(-6)}` : "");
const when = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : null;
};

/** The headline and one-line explanation for each step, in plain words. */
export const JOURNEY_TEXT = {
  verification_service: ["Being checked", "Nothing to do. The result shows here."],
  reviewer_request: ["More evidence needed", "The reviewer needs a little more before deciding."],
  reassessment_pending: ["The reviewer is looking again", "Nothing to do. They will accept or reject it."],
  revised: ["Replaced by your newer submission", "The reviewer checks the new one."],
  expired: ["Time ran out; the task is open again", "Nothing was charged. You can submit again."],
  unavailable: ["Status not available right now", "Try Refresh in a moment."],
};

const ACTION_LABELS = {
  central_submit: "Sign and resubmit",
  central_reassess: "Sign and ask for another look",
  central_evidence_expire: "Sign and reopen the task",
};

export default function CentralEvidenceJourney({
  view,
  showFindings = true,
  canSign = false,
  disabled = false,
  revisionDraft = "",
  onRevisionDraft,
  onReviewRevision,
  onReviewReassess,
  onReviewExpire,
  reviewed = null,
  onSign,
  onCancel,
}) {
  if (!view) return null;
  const [title, line] = JOURNEY_TEXT[view.kind] ?? JOURNEY_TEXT.unavailable;
  const w = view.window;
  const can = (op) => view.actions.some((a) => a.operation === op);
  const deadline = w ? when(w.deadlineEstimate) : null;
  return (
    <section className="ne-recovery" aria-label="What happens next">
      <p>
        <strong>{title}</strong> · {line}
      </p>
      {showFindings && view.findings && view.findings.length > 0 && (
        <>
          <p className="fine-print">What the reviewer asked for:</p>
          <ul>
            {view.findings.map((f, i) => (
              <li key={i} style={wrapText}>
                {f}
              </li>
            ))}
          </ul>
        </>
      )}
      {view.kind === "reviewer_request" && w?.open && (
        <p>
          Add it by <strong>{deadline ?? "the deadline"}</strong> ({blocksLeftText(w.blocksLeft)} left).
        </p>
      )}
      {view.kind === "reviewer_request" && w?.open && (
        <p data-evidence-choices>
          You can do one of two things, once: resubmit with what the reviewer asked for, or ask the reviewer to
          look again at the same answer. If you do neither in time, this submission closes unpaid and the task
          reopens for others.
        </p>
      )}
      {view.kind === "reviewer_request" && !w && (
        <p className="fine-print">There is no deadline yet. Nothing to do for now.</p>
      )}
      {view.kind === "reviewer_request" && w && !w.open && (
        <p>Time ran out. Reopen the task so it can be taken again; nothing is charged.</p>
      )}
      {(view.help.reviewer || view.help.manager) && view.kind === "reviewer_request" && (
        <p className="fine-print">
          Questions? Ask the {view.help.reviewer ? <>reviewer <code title={view.help.reviewer}>{short(view.help.reviewer)}</code></> : null}
          {view.help.reviewer && view.help.manager ? " or the " : ""}
          {view.help.manager ? <>project manager <code title={view.help.manager}>{short(view.help.manager)}</code></> : null}.
        </p>
      )}

      {can("central_submit") && !reviewed && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReviewRevision?.();
          }}
        >
          <label>
            <span>Add the missing evidence and resubmit (write the full answer again)</span>
            <textarea
              value={revisionDraft}
              onChange={(e) => onRevisionDraft?.(e.target.value)}
              rows={6}
              disabled={disabled}
            />
          </label>
          <p>
            <button type="submit" className="button ink small" disabled={disabled || !revisionDraft.trim()}>
              Review and resubmit
            </button>
          </p>
          {can("central_reassess") && (
            <details>
              <summary>Think your answer was already enough?</summary>
              <p className="fine-print">
                Instead of resubmitting, you can ask the reviewer to look again at the same answer. You get one of
                the two, once.
              </p>
              <button type="button" className="small-action" onClick={onReviewReassess} disabled={disabled}>
                Ask for another look
              </button>
            </details>
          )}
        </form>
      )}
      {can("central_evidence_expire") && !reviewed && (
        <p>
          <button type="button" className="button ink small" onClick={onReviewExpire} disabled={disabled}>
            Reopen the task
          </button>
        </p>
      )}

      {reviewed && (
        <div className="nw-review" role="group" aria-label="Check before signing">
          <p>
            <strong>{ACTION_LABELS[reviewed.operation]?.replace(/^Sign and /, "") ?? "Confirm"}</strong>
            {reviewed.operation === "central_submit"
              ? ". Your new answer replaces this one; the first stays on record."
              : "."}
          </p>
          <p className="fine-print">You sign on this device. Nothing is paid by this step.</p>
          <div className="nw-actions">
            <button type="button" className="button small" onClick={onCancel} disabled={disabled}>
              Not now
            </button>
            <button type="button" className="button ink" onClick={onSign} disabled={disabled || !canSign}>
              {ACTION_LABELS[reviewed.operation] ?? "Sign"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
