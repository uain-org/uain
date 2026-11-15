# Prospective research corrections and appeals

`bounded-research-proceedings-v1` extends new compact/pairwise research answers
under the existing arbitration policy. A guardian signs
`activate_research_proceedings` with `policy`, a review `evidence_digest`, and
an explicit `appeal_window_blocks` decimal string from 1 through 1,000,000.
It takes effect at the following height. Existing answers, original-policy
rulings, checks, hashes and settlement behavior retain their original format.
No production window or activation is selected by this implementation.

`arbitrate` may add `revised_claim`, a trimmed 20–4,000-byte statement, only to
a confirmed answer under this new policy. The ruling commits the correction
and its signed evidence. The answer enters `appeal_wait`, preserving its prize
priority and withholding both settlement and any no-effort sanction. The
recorded deadline is the ruling height plus the activated window.

Before that deadline, the author or an original disputer may sign one
`appeal_arbitration` with `contribution`, `evidence_digest`, and a trimmed
20–4,000-byte `reason`. The first arbiter cannot appeal its own ruling. The
answer becomes `appealed`; a new arbiter signs `resolve_appeal` with the same
verdict/novelty/search/evidence fields as `arbitrate` and an optional correction.
Eligibility rechecks current standing, operator relationships and exact trusted
appointments or a fresh bootstrap census. The author, every earlier checker
and the first arbiter are excluded. The appeal decision is final within this
bounded mechanism; it cannot rewrite or appeal an already frozen/paid award.

Without an appeal, any licensed project participant may sign
`close_arbitration` at or after the deadline. Closing or resolving resumes the
ordinary independent-confirmation/default-verifier settlement rules. Rejection
pays nothing. A final no-effort rejection applies its two-Karma sanction once;
there is no premature revocation that prevents the author from appealing.
A final correction records original disputers as `correction_exempt` rather
than labelling them as default-verifier reconsiderations. A final confirmed
ruling without a correction preserves the original claim. It can penalize
unreconsidered overturned disputes, including an overturned first ruling.
Original known-result evidence continues to withhold payment after an appeal;
new attestations cannot outvote discovered public prior art.

New-policy original rulings, appeal requests and appeal decisions use bounded
compressed immutable records. The answer commits the uncompressed JSON digests.
A complete proof requires the original ruling, both appeal records when
present, all check evidence, task and project at one authenticated height.
Missing, modified or cross-height dependencies fail closed. Original-policy
rulings keep their existing raw bytes. At most 23 checks are retained: twenty
original checks, two rulings and one exact default-verifier reconsideration.
KPI failure/expiry keeps the historical appeal readable and permanently
withholds its payment without rewriting its evidence.

The window and appointment authority are explicit governance choices. Signed
judgements do not prove external scientific truth or operator independence.
Historical SQL claim proceedings and native API/client adoption are separate
compatibility/integration requirements.
