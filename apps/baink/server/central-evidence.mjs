/**
 * The member's view of a "needs more evidence" outcome (S6 default, 9 November 2026).
 *
 * It separates two situations a member previously saw as the same stall:
 *  - verification_service: no reviewer decision yet. A verification service (record APIs, the
 *    fixed survey verifier, the central reviewer) is still working; the member need do nothing.
 *  - reviewer_request: the reviewer recorded needs_evidence. The member sees what was found, who
 *    can help, the deadline, and the two supported next steps: one linked revision (the original
 *    stays immutable) or one reassessment of the unchanged evidence. After the deadline the
 *    submission expires with no reviewer fee and the task reopens.
 * Pure projection of already-verified native records; it never signs or sends.
 */
export const EVIDENCE_POLICY = 'central-evidence-window-v1';
/** Observed native block interval used only for a human deadline estimate, never for a check. */
export const ESTIMATED_BLOCK_SECONDS = 2.06; // measured on 10 November 2026 (was 2)
const HEIGHT = /^[1-9][0-9]{0,18}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ADDRESS = /^uain1[0-9a-f]{40}$/;
export function evidenceActivation(record) {
  if (record === null || record === undefined) return null;
  const ok = record && typeof record === 'object' && record.policy === EVIDENCE_POLICY && HEIGHT.test(record.height ?? '')
    && HEIGHT.test(record.window_blocks ?? '') && ADDRESS.test(record.approved_by ?? '') && /^[a-f0-9]{64}$/.test(record.evidence_digest ?? '');
  if (!ok) throw Error('central_evidence_activation_invalid');
  return { height: record.height, windowBlocks: record.window_blocks };
}
function estimate(proof, height) {
  const at = Date.parse(proof?.headerTime ?? '');
  if (!Number.isFinite(at) || !HEIGHT.test(proof?.height ?? '')) return null;
  const blocks = Number(BigInt(height) - BigInt(proof.height));
  return new Date(at + Math.round(blocks * ESTIMATED_BLOCK_SECONDS * 1000)).toISOString();
}
/**
 * @param s native submission record (already verified by the caller)
 * @param t native task record
 * @param review {status, record} proved review for the selected execution, if any
 * @param findings reviewer findings from the verified feedback packet, or null
 * @param help {reviewer, manager} addresses from native records
 */
export function evidenceJourney({ s, t, review, findings = null, activation = null, proof, help = {} }) {
  const helpers = {
    reviewer: ADDRESS.test(help.reviewer ?? '') ? help.reviewer : null,
    manager: ADDRESS.test(help.manager ?? '') ? help.manager : null,
    // How the evidence window works, for members and their agents (docs/baink/needs-evidence.md).
    guide: 'docs/baink/needs-evidence.md',
  };
  if (s.state === 'expired') {
    return { kind: 'expired', message: 'The evidence window closed without a revision. The submission was rejected with no reviewer fee and the task reopened.', expiredAtHeight: s.expired_height ?? null, help: helpers };
  }
  if (s.state === 'superseded') {
    return { kind: 'revised', message: 'You submitted a revision. This original stays on record unchanged; the revision is under review.', revisedBy: ID.test(s.revised_by ?? '') ? s.revised_by : null, help: helpers };
  }
  if (s.state !== 'under_review') return null;
  const requested = review?.record?.verdict === 'needs_evidence';
  if (!requested) {
    return {
      kind: 'verification_service',
      message: 'A verification service is still checking your work, for example reading the cited records. You need to do nothing; the result appears here.',
      revisionOfOriginal: ID.test(s.revises ?? '') ? s.revises : null, help: helpers,
    };
  }
  const base = {
    kind: 'reviewer_request',
    message: 'The reviewer asks for more evidence before deciding.',
    found: Array.isArray(findings) ? findings.slice(0, 64) : null,
    findingsAvailable: Array.isArray(findings), help: helpers,
  };
  if (!activation || !HEIGHT.test(s.evidence_deadline ?? '')) {
    // Requests recorded before the evidence window was activated have no native deadline.
    return { ...base, window: null, actions: [], note: 'This request predates the evidence window. Operators will apply the 72-hour window once it is active on the network.' };
  }
  const deadlineHeight = s.evidence_deadline, open = BigInt(proof.height) <= BigInt(deadlineHeight);
  const window = { requestedAtHeight: s.evidence_request_height ?? null, deadlineHeight, blocksLeft: open ? String(BigInt(deadlineHeight) - BigInt(proof.height)) : '0', deadlineEstimate: estimate(proof, deadlineHeight), open };
  if (s.reassess === true) {
    return { ...base, kind: 'reassessment_pending', message: 'You asked for one reassessment of the unchanged evidence. The reviewer must now accept or reject it.', window, actions: [] };
  }
  if (!open) {
    return { ...base, message: 'The evidence window has closed. The submission will be rejected with no reviewer fee and the task reopened.', window, actions: [{ operation: 'central_evidence_expire', payload: { submission: s.id } }] };
  }
  return {
    ...base, window,
    actions: [
      { operation: 'central_submit', label: 'Submit one revision', payload: { id: null, task: t.id, evidence: null, evidence_digest: null, revises: s.id },
        note: 'A new linked submission. Your original stays on record unchanged. Only one revision is allowed.' },
      { operation: 'central_reassess', label: 'Ask for one reassessment', payload: { submission: s.id },
        note: 'The reviewer looks again at the same evidence and must accept or reject it.' },
    ],
  };
}
