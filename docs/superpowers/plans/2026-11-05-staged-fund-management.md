LATEST POLICY OVERRIDE — 5 November 2026: read `docs/baink/fund-manager-specification-2026-11-05.md` from repository root. Rahul’s later pasted specification replaces the earlier 1,111,110,000 total with exactly 1,000,000,000 AI$ (final increment 888,890,000), exactly five Fund-Manager-defined sub-KPIs plus one Main KPI, and Main KPI achievement BEFORE final unlock. Earlier contrary text below is superseded. Centralized UAIN review, carryover, reward-only spending and no monthly limit remain.

# Staged fund and management implementation plan

> Execute inline using superpowers:executing-plans; user explicitly requested implementation after confirming policy. Preserve concurrent work and index; no production push implied.

**Goal:** Implement missing sequential funding authority and truthful project/task oversight atop existing central earning and private admin boundaries.
**Architecture:** Native ledger owns versioned milestones, fund evaluator designation, manager applications, evaluation receipts and cumulative allowances. JS clients validate the same exact schedule. Catalogue-wide task preparation stays nonpayable until native admission and reservations. Reuse existing private super-admin rather than a second authentication system.
**Tech Stack:** Go federation keeper, Node native signing/BAINK management, existing portal framework.
**Spec:** docs/baink/fund-manager-specification-2026-11-05.md.

## Constraints and review focus

No historical hash changes, key exposure, automatic admin grants, unreserved bounties or duplicate production financial operations. Main and unrelated dirty source/index preserved. Gates bind exact project, current round, approved plan version, evidence and independent designated evaluator. Carryover conserves paid/reserved amounts. Final closure cannot strand reserved rewards. Unknown or stale inputs fail closed.

## Tasks

- [x] Write failing native tests for evaluator authority, approved Main KPI plus five-Sub-KPI plan, amendments, application rejection/resubmission, six sequential releases/carryover, duplicate/stale gates and final closure.
- [x] Implement native staged fund transitions in a separate central_fund.go, dispatch from keeper, extend budget validation to exact cumulative six-round allowances; keep round-one behavior compatible.
- [x] Add typed JS funding commands and exact cumulative budget validation shared by earning reads; test command bounds and post-round-one reads.
- [x] Implement catalogue-wide source-bound initial task preparation with bounded pagination, explicit holds, stable task identity and no invented reward/native authority. Integrate management oversight reads.
- [ ] Finish private portal integration (source panel and authorization tests complete). Inspect/reuse private super-admin; delegate UI design to Claude Opus 5.5, retain OIDC/MFA/product/source grants and audit. Test allowed/denied access and real data integration; report unavailable deployment dependencies.
- [x] Run relevant native/app/admin tests and builds, review diff, document exact scope/results and remaining activation blockers. Update decision record, context, changelogs and remaining_work.

## Execution record

Initial inspection: concurrent earning source already implements six-round lifetime ceiling and exactly-once first allowance; later rounds are deliberately blocked. Existing management provides persistent plans/chat, not paid execution. Separate admin handoff exists; source API read boundaries exist, portal checkout not found in Work root. Runtime activation/release remains independently gated.

Source tasks above are implemented and qualified separately from runtime/portal deployment. Separate portal integration and Fund Manager provider/custody provisioning remain open in the implementation handoff.

Additional regression: rejecting a proposed amendment preserves use of the previously approved plan; specific final Main KPI attestation and feedback are required. Native command/data contracts are documented in apps/baink/docs/project-funding.md.
