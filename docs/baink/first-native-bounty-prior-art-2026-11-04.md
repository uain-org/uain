# Independent prior-art review — prospective BAINK bounty, 4 November 2026

**Verdict: keep the proposal closed.** The exact BAINK composition is a plausible
verification gap, but this review does not establish a genuinely unsolved research
problem. Generic invoice uniqueness, idempotency, crash/retry modeling and guarded
state-machine verification have discoverable solutions. An application-specific
model can be useful engineering without qualifying as a new-work reward under
AGENTS.md. No task, funding, reservation, submission or novelty attestation was made.

## Primary sources checked

- Jia Cai's [original paper, sections IV, VII-A and XI](https://arxiv.org/html/2609.37819v1)
  gives a guarded invoice lifecycle and inductive SMTChecker reimbursement
  uniqueness results. Its negative control weakens a reimbursement guard and
  obtains a duplicate-reimbursement counterexample. Thus even guard-removal
  non-vacuity is established methodology. Privacy is identified as future work;
  this is a scope distinction, not evidence that BAINK's composition is novel.
  The author's [public implementation and verification instructions](https://github.com/jeffjiacai/ethereum-e-invoice-system)
  were also inspected: they expose a Solidity model and reproduction command.
  The external proof scripts were not executed in this review.
- Lamport's [WS-AT source and publication page](https://lamport.azurewebsites.net/tla/ws-at.html)
  links the actual [WSAtomicTransaction TLA+ module](https://lamport.azurewebsites.net/tla/WSAtomicTransaction.tla).
  Its introduction explicitly specifies safety rather than liveness and permits
  message loss, duplication and reordering. These fault abstractions and the
  distinction between at-most-once safety and progress are prior art.
- TrueLayer's [official signing and idempotency documentation](https://docs.truelayer.com/docs/sign-your-payments-requests)
  describes signed requests, payload-bound keys, 30-day validity, concurrency
  conflicts and refusal of changed-payload key reuse. Ordinary signed-request
  replay protection is not an unresolved problem.

## Searches and local scope

Web searches on 4 November 2026 included these exact queries:

- `"2609.37819" Cai invoice verification`
- `"BAINK/payment-reviewer-binding/v1"`
- `"baink" "recipient-confirmed-paid"`
- `"baink" "native-payments" formal verification`
- `"baink" "invoice-claim" TLA`
- `"BAINK" "invoice_claim" formal model`
- `"BAINK" "holder" "formal model"`
- `"BAINK" "native-earning" verification`
- `"BAINK" "invoice/effect" isolation`

No relevant exact BAINK protocol model was returned. Broader queries produced
irrelevant results; none were treated as evidence. Search-engine coverage of a
private repository, unpublished work, synonyms and new publications is limited.
An empty result cannot certify absence of a solution.

A local filename search of `apps/baink`, `chain` and `ops/custody` found no `.tla`,
`.als`, `.ivy`, `.v` or `.lean` model, or filename matching `formal`/`model.check`.
This is a bounded search of the inspected checkout, not a history-wide or
semantic proof of model absence. Existing executable tests and source guards
remain prior work.

Read-only source review covered application invoice/effect binding and recipient
confirmation in `server/native-payments.mjs`, earning eligibility in
`server/native-earning.mjs`, holder recovery in `holder/submitter.mjs`, sealed
invoice claims in `ops/custody/private_payment_service.py`, and native settlement
in `chain/federation/settlement.go`. Paths under `server`/`holder` are relative to
`apps/baink`. Their SHA-256 values at inspection were respectively:

```
d8ab1c118e50c066d56399ac841ce4de306d2c7137c307da427b357cf27b5b31
6ff2c83e8775a9d924abb9b46e0ff728268bd2594cc8e0c41bb3c5d60c38e31f
22848b1547c86d7924f1765a06ef79c2d72f7c3137e2f6d3af1810f329e6dc66
f99d392d6f952cdb1cf2963f6041c68f25ea48f8b9e418937f98c6652c086da8
940aaea1ae6d4c59911a5ef7b989fdcc5372df08a385aaa3f70934f3a2c8aa52
```

These fingerprints identify review inputs; they do not constitute the complete
frozen release/source-access package required to open the task.

## What could remain, and what cannot earn

The possible residual question is whether the exact source-level composition
preserves invoice/effect isolation and at-most-once earning when independently
guarded application state, sealed custody state, holder journals and native
settlement observe different histories across crashes, expiry and recovery.
No inspected primary source supplies that exact BAINK composition result.
This is an inference about a candidate gap, not a novelty verdict.

The sealed global invoice guard is already implemented: one chain/genesis,
invoice ID and payer index binds an immutable invoice digest across root jobs;
another context is refused until original expiry plus fresh authenticated
nonmembership, while recorded effects permanently prevent reuse. Same-effects
cross-job reuse is refused and per-job history is retained. Modeling or replaying
that fix is not an original counterexample. Also exclude the proposal's known
key-order, appeal-limit, queued-expiry, amount-bound, effect-appropriation and
restart-recovery fixes, supplied fixtures, and findings disclosed before opening.

Before opening, an independent reviewer must identify a concrete unresolved
composition obligation beyond applying these known guards, freeze the complete
release and accessible source manifest, and fix finite bounds, trusted inputs,
transition mappings, successful-path reachability and negative controls. A
renamed Cai/WS-AT model, an integration checklist, or a model that assumes each
cross-layer conclusion cannot qualify. An original counterexample must reproduce
against that frozen isolated release; a safety result must explain the new
composition result rather than claim novelty from new filenames.

The proposed 1 AI$ remains prospective and conditional. Genuine independent
participants, prior-art challenge review and actual new-result attestation are
still required; this review provides none of them. If the unresolved obligation
cannot be distinguished from known-answer integration, do not open this bounty.
