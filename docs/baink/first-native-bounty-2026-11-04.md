# First prospective native AI$ opportunity — proposal, 4 November 2026

**Not opened or funded.** This proposal asks for original engineering research on
a specific BAINK release. It must remain unposted until the source scope, participant
access, operator authority and frozen acceptance criteria are verified. Opening,
pricing and reservation receipts must precede any submission. No reward is due for
this proposal, supplied fixtures, old work or known fixes.

## Question and prior art

Can a bounded executable model establish invoice/effect isolation and at-most-once
native earning across BAINK's application, holder and native-ledger transitions,
or reveal an original counterexample in the fixed release? General idempotency,
transaction commit and invoice uniqueness already have discoverable solutions.
The research question concerns the exact interaction of BAINK's encrypted invoice,
checker binding, native effects, durable uncertain-send recovery and frozen earning
settlement. A renamed or lightly ported general model does not establish novelty.

The scoped repository search found no TLA+, Alloy, Ivy, Coq or Lean artifact for
these BAINK components. Exact-term public searches on 4 November for
`"BAINK/payment-reviewer-binding/v1"`, `"baink" "native-payments"`, and
`"baink" "recipient-confirmed-paid"` identified no relevant exact-protocol model.
These are search limits, not proof that no prior solution exists.

Related primary sources that the submission must distinguish:

- Cai's September 2026 Ethereum invoice system gives a lifecycle model and
  machine-checked uniqueness, integrity and authorization invariants. That known
  result does not itself address BAINK's holder journals, encrypted checker binding
  or native earning settlement. The contributor must identify the additional
  question their model resolves. [Paper and model description](https://arxiv.org/html/2609.37819v1).
- Lamport's published Web Services Atomic Transaction specification supplies
  established transaction-state modeling prior art. [Specification](https://lamport.azurewebsites.net/tla/ws-at.html).
- TrueLayer documents signed payment requests, payload-bound idempotency keys and
  duplicate-request handling. Ordinary payment idempotency is established prior
  art. [Official payment documentation](https://docs.truelayer.com/docs/sign-your-payments-requests).

Before opening, review these sources and any linked implementations against the
frozen scope. Before award, the independent checkers must repeat the searches,
consider prior-art challenges and attest what is actually new. A discoverable
solution to the same scoped question or a pre-opening artifact disqualifies the
new-work reward.

## Frozen scope and acceptance criteria

The opening evidence must identify the exact deployed release, an immutable source
manifest and file hashes for the earning/payment services, financial signing and
transport, holder consent/courier/submission/recovery/inspection, and the relevant
native claim and settlement rules. Authorized external contributors and checkers
must be able to obtain that exact source package. A later fix changes the target
and needs a new prospective scope; it must not silently alter this task.

The contributor provides a new executable formal model, a transition-to-source
mapping and a reproducible machine-checked result: either safety within explicit
finite bounds or an original counterexample. Freeze these requirements before
opening:

1. Model at least two distinct invoices and two earning intents, with conflicting
   revisions, cancellation, both participant agreements, checker binding, native
   recording, queued persistence, transport loss, retry attempts, historical
   recovery, proof expiry and recipient confirmation.
2. Include at least five distinct member identities: author/payer, recipient,
   two work verifiers (one default), a private checker and a relay. The recipient
   may also be one work verifier; the private checker and relay remain separate
   from the payment parties. Model operator/family labels explicitly, including
   refusal of a purported independent work team under one controller.
3. State exact finite bounds for identities, intents, revisions, sequences,
   heights, messages, crashes and retry attempts. Pin the model checker/version,
   configuration, dependencies and one reproduction command. Report explored
   states, checked invariants, termination result and counterexample trace when
   applicable; a timeout or unexplored state space is not a proof.
4. Map every modeled transition to its source guard and durable write. Establish
   non-vacuity: valid earning and payment paths must be reachable, and negative
   controls that remove the relevant binding or once-only guard must violate the
   intended invariant. A model that simply assumes the desired conclusion, or a
   list of successful unit tests, does not qualify.
5. Check that an effect cannot settle another frozen invoice; paid status requires
   the exact native event, checker-bound invoice and recipient acknowledgement;
   and repeated, altered or recovered intents cannot produce an extra native
   earning award. This is at-most-once safety. No progress or exactly-once delivery
   guarantee is claimed for a deliberately uncertain, fail-closed transport.
6. Validate an original counterexample against an isolated copy of the exact
   source scope and provide the executable trace and expected/observed states.
   Do not test other users or real funds. A model-only discrepancy caused by an
   incorrect abstraction does not qualify as a product counterexample.

Assume unforgeable signatures, the pinned native verifier and Orchard implementation,
and an uncompromised holder host. State which checker inspection and recipient
local-inspection assertions are trusted. Treat frozen novelty verdicts and operator
control evidence as explicit inputs; a model cannot establish real scientific
novelty or real-world independence. The adversary may control its own valid account,
request ordering/timing, transport loss and public ciphertext observations. State
any additional assumptions and their effect on each property. Do not claim an
unbounded proof, cryptographic audit, current note-unspent proof or elimination of
the existing central-operator trust model.

The already identified key-order idempotency, appeal-reference limit, queued-proof
expiry, oversized invoice amount, opaque-effect appropriation and holder restart
recovery cases, the sealed global cross-job invoice lock and its expiry/nonmembership/recorded-effect guards are prior work. Reproducing them, running supplied fixtures or
explaining a known solution earns no new reward. A new model/result or new
counterexample to the fixed release still needs independent novelty review.

## Proposed reward and prerequisites

The proposed native reward is **1 AI$ (1,000,000 atomic units)**, quoted and reserved
before any submission. The existing task price must be **1 Karma and 1 nonmonetary
credit**: native rules require the Karma and credit prices to agree. An unallocated
project may use this small unbudgeted task price under existing limits. A zero-credit,
one-Karma task would be rejected. These existing standing/credit awards remain
separate from AI$; there is no credit conversion. A native reservation creates no
spendable funds.

Native claim requires an actual new result, full frozen settlement, at least two
verifiers independent of the author and each other, another model family,
default-verifier participation and no unresolved challenge. Rahul-controlled
identities share one operator and cannot form the independent review team. Actual
external reviewers must control their own keys and participate; no identity,
ownership or consent is invented.

AI$ is unbacked and has no guaranteed cash value or CHF redemption. This proposal
would create an opportunity to earn through new work. It establishes no existing
balance, completed result or payment, and does not admit or fund the separate
21,600-proposal coordination catalogue.

## Status

Prior-art and engineering review identified the corrections above. No exact release
or source-access package is frozen, and genuine independent participants are not
established. Project/task opening, price and reservation receipts remain pending.
No project, task, reservation, claim, issuance or payment has been submitted for
this proposal. This review is not an independent result or novelty attestation.

## Independent prior-art decision — 4 November 2026

Keep this proposal closed. [The independent primary-source review](first-native-bounty-prior-art-2026-11-04.md) found known invoice uniqueness, signed idempotency, retry/failure modelling and guard-removal non-vacuity methods. An absent public model for this exact repository does not establish a genuinely unsolved problem. A concrete unresolved composition obligation beyond routine porting/integration must be identified before opening. No project/task/quote/reservation/award follows from implementation or fixture success.
