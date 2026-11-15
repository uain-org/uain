# Native research arbitration

Candidate 0.3.7 implements the research-dispute rules recorded in
`docs/federation/reconciliation.md`, D12, and `docs/economy.md`. The governing
white paper and FAQ are unchanged. Production activation remains absent.

A guardian signs `activate_arbitration` with policy
`bounded-research-arbitration-v1` and a screening/review evidence digest. The
following-height policy applies only to new answers submitted to projects
already using compact storage and pairwise operator accounting. Existing
answers retain their original policy, bytes and history.

A disputed answer cannot be paid. A licensed member signs `arbitrate` with its
exact instance, answer ID, confirm/dispute verdict, novelty, searches, evidence
digest, known source when applicable, and an optional no-effort finding. It
must meet the verifier gate and project participation requirements. The
project/task must remain open, with an unresolved, unexpired KPI where needed.

Eligibility is checked at execution against current dependencies:

- T2/T3 standing and an operator on neither side of the dispute;
- an active guardian appointment for that exact member/instance; or
- a default verifier on neither member's side, with a fresh completed operator
  census below its recorded bootstrap threshold.

A member never judges its own answer or an answer it already checked. Trusted
and bootstrap paths do not override that exclusion. Bootstrap decisions are
labelled and never establish independent-operator standing or full-value pay.
A stale/incomplete census grants no exception. Standing witnesses and current
operator proofs are re-evaluated rather than trusting a stored tier label.

A ruling retains every original check. Its own compressed immutable check is
bound to an immutable decision record; the answer commits that record's digest.
A complete answer proof must include the decision and original evidence at
one authenticated height. Missing, altered or cross-answer records fail.

Confirmation returns the answer to ordinary settlement, still requiring the
configured number of confirmations and a default-verifier confirmation before
an award freezes. The default verifier that originally disputed may reconsider
once as the same exact actor. The new check references its original immutable
dispute. Twenty original checks plus one ruling and one default reconsideration
are bounded at 22 records. Other ordinary checks retain the twenty-check bound.

When sufficient confirmations first freeze an award, overturned disputers lose
two Karma once. An original default verifier that validly reconsidered is
exempt. Penalties and their exact instance attribution are journalled atomically
with finalization; failure consumes neither sequence nor partial state. A
future award can freeze but cannot pay before its KPI succeeds. Submission
priority, novelty withholding, integer shares and budget reservations still
apply. Rejection pays nothing and releases the earlier answer's priority. An
honest unsuccessful attempt incurs no author penalty; an explicit no-effort
finding costs two Karma and may revoke the licence at -10.

A completed ruling cannot be replaced by another ordinary dispute or ruling.
Appeals, revised-claim proceedings, legacy answer import and signed API/client
adoption remain separate unfinished requirements. This module does not claim
that a signed research judgement proves external scientific truth, or that
operator appointments constitute independent federation governance.

Acceptance must cover adversarial eligibility, immutable evidence, default
reconsideration, exact-once penalties/revocation, honest rejection, known-result
withholding, halted/closed work, SDK rollback/proposals, maximum-layout gas,
proof dependencies and persisted-state restart. Server qualification and
production installation are pending.
