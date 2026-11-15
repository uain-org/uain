# Bounded durable group commit — 4 November 2026

Observed bottleneck: each signed operation reserves its nonce and then writes its
business mutation through separate whole-JSON temp-write, file fsync, rename and
directory fsync. The actual browser API's bounded four-attempt 200-write burst
completed127 and explicitly refused73; sustained32-worker controls completed200.
Increasing the64-active admission limit is not justified by this evidence.

Implement a new isolated group-commit engine and narrowly wire existing loadStore
into it. At most32 queued mutations share one persist; at most128 may wait.
Callbacks remain strictly ordered and see prior successful tentative mutations.
Each receives a fresh clone; callback/result-clone/capacity errors discard only
that mutation. Async callbacks remain serialized, and awaited reentrant
transactions refuse instead of deadlocking. No callback may perform external
irreversible effects; existing financial callers await transact before broadcast.

Public reads expose only the last committed snapshot. No successful result or
financial send-marker acknowledgement resolves until the existing temp-file
fsync, rename and directory fsync complete. A persist failure rejects the entire
unacknowledged group and queued work and poisons the engine until restart because
failure after rename can be ambiguous. Never continue by overwriting disk from
stale in-memory state. Restart loads the existing authenticated process-locked
state file; no hashing, nonce, native command or financial retry rules change.

Keep per-mutation byte-cap checks before group acceptance, retain the existing
writer lock and all HTTP admission/body/deadline limits. Queue saturation returns
an explicit storage-specific refusal; it is not the pre-auth busy response that
permits automatic browser retries. Close stops admission and waits for accepted
work to settle before releasing the writer lock.

Qualification requires red/green durability barriers, independent-error rollback,
strict order/async/reentry, bounded queue/batch, failure poison, close and restart
checks; full application/native regression checks; independent source review; and
an isolated rerun of the actual browser-API capacity fixture. Improved throughput
or production readiness must not be claimed before those observations.

## Candidate implementation checkpoint

The new `apps/baink/server/store.mjs` is wired only into existing loadStore;
filesystem ownership, lock, byte limits and atomic replacement remain there.
Seven engine cases and seven existing capacity/Trade integration cases passed in
under one second; this small check is not a throughput benchmark. Missing-module
and selective-lookup regressions were observed red before implementation. Two
independent source reviewers found no material durability/authority blocker.

Callback audit found only the profile-endorsement operations currently async;
their awaited profile projection reads the supplied local transaction snapshot,
without a network call or nested writer. All actual financial send sites continue
to await their durable markers. A callback's rejection can conservatively observe
an earlier tentative mutation before that group fsyncs (for example, an intent
conflict); if persistence then fails, no success was acknowledged and the writer
remains poisoned. This is not a successful write or authority to retry a financial
submission. Group successes remain behind the complete shared durability barrier.

Combined server checks and the identical actual browser-API A/B workload are owned
by the existing qualification runner. Their results, release and browser acceptance
were still pending at this checkpoint; no throughput increase or deployment is
claimed by this document.

## Observed isolated A/B result

The identical browser-API workload passed in14.43seconds under the same one-CPU,
512MiB,180-second limits.32-worker controls each completed200/200 first attempt.
200 signed reads completed200/200 first attempt (no503), operation p951948ms,
versus baseline3149ms.200 request writes completed175 and explicitly refused25
after the same four-attempt bound (561wire attempts including386503), versus
baseline127success/73refused. Write operation p95 was4564ms. All375created
requests persisted exactly through restart, and refused attempts reserved no
nonce. Maximum RSS106872KiB. Global64/per-IP16 admission and retry bounds stayed
unchanged. This improves the observed workload but does not accept200-writer
capacity. No repeated benchmark is needed without a new change or failure.

Combined store, earning recovery HTTP, native payment and Trade bridge focused
server checks passed78/78. Ignored evidence: `output/readiness-20261104/` files
`browser-group-capacity.log`, `browser-group-capacity-result.json` and the
qualification owner's focused-run receipt. Full release/native/browser checks
and deployment remain distinct from these observations.
