import React from 'react';

// Presentation only. The parent verifies the checker feedback, owns onRead and
// rejects invalid input. Findings are React text children, so they render as
// escaped plain text, unchanged. Every finding stays accessible: the first
// few show inline and the rest sit behind an explicit expansion.

const INLINE_FINDINGS = 8;

const wrapText = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' };

const OUTCOME_LABELS = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  needs_evidence: 'More evidence requested',
  under_review: 'Under review',
  superseded: 'Replaced by your newer submission',
  expired: 'Time ran out; the task is open again',
};

const VERDICT_LABELS = {
  accept: 'Accepted',
  reject: 'Rejected',
  needs_evidence: 'More evidence requested',
};

function FindingItems({ findings }) {
  return findings.map((finding, index) => (
    <li key={index} style={wrapText}>
      {finding}
    </li>
  ));
}

function Findings({ findings }) {
  if (findings.length === 0) return <p className="fine-print">No findings were recorded.</p>;
  const inline = findings.slice(0, INLINE_FINDINGS);
  const rest = findings.slice(INLINE_FINDINGS);
  return (
    <>
      <ol>
        <FindingItems findings={inline} />
      </ol>
      {rest.length > 0 && (
        <details>
          <summary>
            Show {rest.length} more finding{rest.length === 1 ? '' : 's'} ({findings.length} in
            total)
          </summary>
          <ol start={INLINE_FINDINGS + 1}>
            <FindingItems findings={rest} />
          </ol>
        </details>
      )}
    </>
  );
}

export default function CentralReviewFeedback({ view, onRead, disabled = false }) {
  const status = view ? view.status : null;
  const loading = status === 'loading';
  const label = !view ? 'Read checker feedback' : loading ? 'Loading feedback' : 'Refresh checker feedback';
  const historical = status === 'ready' && view.historical === true;
  const findings = status === 'ready' && Array.isArray(view.findings) ? view.findings : [];

  return (
    <section className="ne-recovery">
      {loading && (
        <p role="status" aria-live="polite">
          Loading checker feedback…
        </p>
      )}
      {status === 'unavailable' && (
        <p role="status" aria-live="polite">
          Checker feedback is not available right now.
        </p>
      )}
      {status === 'ready' && (
        <details>
          <summary>{historical ? 'Earlier checker feedback' : 'Checker feedback'}</summary>
          {historical && (
            <>
              <p>
                Current outcome: <strong>{OUTCOME_LABELS[view.currentOutcome]}</strong>
              </p>
              <p className="fine-print">
                The feedback below is from an earlier check. It is not the current result and does
                not decide any award.
              </p>
            </>
          )}
          <p>
            {historical ? 'Earlier checker verdict' : 'Checker verdict'}:{' '}
            <strong>{VERDICT_LABELS[view.verdict]}</strong>
          </p>
          <Findings findings={findings} />
        </details>
      )}
      <p>
        <button type="button" className="small-action" onClick={onRead} disabled={loading || disabled}>
          {label}
        </button>
      </p>
    </section>
  );
}
