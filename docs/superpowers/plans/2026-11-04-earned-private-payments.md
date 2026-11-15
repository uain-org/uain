# Earned AI$ and Private Payments Implementation Plan

> **For agentic workers:** Use subagent-driven-development/executing-plans for independent bounded work, with tests and independent review.

**Goal:** Deliver actual native earning and private payment workflows, preserving real work, consent, custody and proof requirements.

**Architecture:** Reuse existing consensus and qualified holder wallet primitives. BAINK adds durable narrow earning/payment intents, participant binding and authenticated receipt reconciliation. A separate holder-local companion provides pinned proof generation with external browser signing; production role/relay setup uses reviewed operator evidence.

**Tech Stack:** Existing Node22/React, native pinned Go/Rust Orchard tools, signed native protocol, current JSON store and SQLite coordination.

**Spec:** ../specs/2026-11-04-earned-private-payments.md

- [x] Prove actual current authority, zero supply, actor/role/task inventory and qualified tool pins; identify receipt/custody gaps.
- [x] TDD earning discovery, readiness, quote/reserve/claim intents; exact authorization, source gates, nonce/receipt/retry tests.
- [x] TDD participant-bound private-payment intents; immutable invoice, both agreements, narrow relay submission, exact finality and recipient confirmation.
- [x] TDD external signing adapter; browser keys remain nonexportable, Orchard key remains holder-local, exact consent/pin/expiry verification.
- [x] Integrate narrow native transport and authenticated HTTP routes with app tests; no arbitrary command broadcasting.
- [x] Qualify a holder-owned Linux runtime on this Mac, including exact amd64 tool execution if emulated, independent original-state sync and no validator power.
- [x] Review and provision actual eligible creator/default-verifier/private-reviewer and relay capabilities through exact custody/public journals; do not fake external independence.
- [x] Actual Claude Opus5.5 authors earning/wallet/payment UI using real capability gates and concise copy.
- [x] Independent security review, complete app tests/builds/deployment checks and real fixture proof execution. Deploy standalone under normal gates and verify live.
- [x] Record concrete remaining genuine earned-work/payment dependencies: no qualifying new work, independent acceptance or paired legitimate holder is established; no production earned/spent funds claimed. Keep actual acceptance open in remaining_work.md.
- [x] Update detailed changelogs/context/remaining work, publish reviewed source on existing private ref (verified`ad952b08d3629809a2ccd1ce77a9181886bbebdf`), and report through SmartMeet with bot/image readback (parent1793803930.700679/fileF0CEYVB72J0).

Release acceptance: standalone0.3.22/20261104T143644Z-6f1439aefe;686app tests/two opt-in skips,both builds,25deployment checks,107runtime/27preview hashes and77public checks. All six real isolated native stages pass; the root invoice guard is adopted and fresh native health-qualified, and no production bounty will open from its test success: independent prior-art review keeps the initial proposal closed until a genuinely unresolved composition obligation is identified. Holder pairing and genuine earned/spent receipts remain separate.
