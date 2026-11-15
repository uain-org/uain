# BAINK staged funding proposal implementation plan

> **For agentic workers:** Use superpowers:executing-plans; user authorized continuing implementation, independent review and standalone releases. Preserve dirty main.

**Goal:** Replace the previous direct-project-budget assumption with tested, versioned staged-funding proposal validation and an honest non-executable public readiness contract.
**Architecture:** Pure exact-amount validator and a source-bound private proposal snapshot; sanitized public DTO exposed through existing config, GET and one public MCP read. No native/treasury/application write or reviewer agent is created.
**Tech stack:** Node22, existing native-unit converter, BigInt, existing HTTP/MCP and Node tests.
**Spec:** Kenneth1November22:21–22:25 source receipts in ignored work/slack-baink-followup, current native authority/governing whitepaper and docs/baink/slack-followup-2026-11-01.md.

## Constraints and approach

- The source explicitly replaces immediate1B access with6rounds and an internal agent-group fund evaluating progress before later rounds.
- Literal rounds10K,100K,1,000K,10,000K,100,000K,1,000K total112,110,000; stated total1,111,110,000. Round6=1B is a candidate correction only. SmartMeet clarification requested; dependent financial implementation waits for a real answer.
- No automatic authority, reviewer setup, funds, paid jobs, native changes or grants. AI$ remains native UAIN Coin; native credits and allowances remain different.
- Public DTO contains no private Slack text/URLs, raw amounts or candidate numbers. Issued/reserved/spendable remain null/unestablished. An arithmetically valid candidate alone can never become an adopted or funded policy.
- Immutable inventory/whitepaper wording stays; add source overrides to affected register entries. No design work required for this API-only milestone.

## Review focus

1.Exact quantities, fractional/malformed/overflow/zero/negative inputs and BigInt total comparison.
2.Round identity/order/count/duplicate amount and sum mismatch must block acceptance.
3.No raw source, IDs/private notes or amounts leak into public readiness DTO.
4.Valid arithmetic never implies policy adoption, authority, prior-round progress, application acceptance or spendable balances.
5.HTTP/MCP strict selectors, unknown mutation paths, existing private scope and durable business state preserved.

### Task1: Pure proposal validation and safe read contract

Files: server/funding-policy.mjs, test/funding-policy.test.mjs.
- [x] Write RED tests for exact six-round validation, literal mismatch/nonincrease, unconfirmed candidate and fixed no-execution/null balance flags.
- [x] Implement strict bounded string amounts/rounds, exact BigInt checks, reproducible source-revision digest and cloned sanitized DTO.
- [x] GREEN focused tests and independent review; no generic application/approval API built from caller claims.

### Task2: HTTP/MCP integration

Files: server/app.mjs, server/mcp.mjs, server/mcp-content.mjs, test/funding-policy-http.test.mjs, existing MCP tests and public/llms.txt.
- [x] RED HTTP public-read/noquery/nomutation tests and MCP discovery/read tests.
- [x] Add GET/api/funding/policy, config.projectFunding and baink_funding_policy, share one sanitized DTO, update onboarding/source boundaries without changing short activation intent.
- [x] Both actual SDK flows continue, now9public tools; no private/source amounts in serialized tool/config/API output.

### Task3: Source reconciliation, qualification and standalone release

- [x] Save all new source text/overlap receipts/watermarks privately, read relevant replies and reconcile SmartMeet clarification if answered.
- [x] Add latest-source overrides to affected earlier1B/aggregate/manager/task entries, preserve historical counts/source records.
- [x] Full suite/both builds/independent review; exact immutable package and expected-prior standalone activation, no main push or ingress replacement.
- [x] Verify primary+preview SDK/API/security/served hashes/business/env preservation, update root/app CHANGELOG/context/register/remaining_work/checkpoint and report through SmartMeet with receipt/readback.
- [x] Fresh Paperclip admission is a separate read-only reassessment; no activation inferred from a passing point sample.

The actual internal-fund applications, reviewer authority/evaluation, native funding receipts, funds and budget-policy adoption remain future guarded work. Resolving a typo is not funding approval.

## Completion and rulings

All bounded tasks qualified as0.3.8release20261101T170617Z-6677241df8.
294tests/bothbuilds/bothpublicSDK/46publicchecks and afterreport statepreservation.
SmartMeetquestion1793552307.278779 remainsunanswered; completion1793553009.961829
actualbotverified. No funds/authority granted. Existing dirtymain/staging retained.
Ruling: publish only sanitized readiness, not private planning amounts/source.
Ruling: do not assume a corrected sixthamount or invent progress thresholds.
Ruling: publicpreview forbidden sourcepath is existingSPAHTML200, not a source
leak; adjust content-validation expectation and preserve nginx config.
Ruling: Paperclippassing preflight is expired; no unsafe use for lateractivation.
Sparse-array and incomplete-revision review findings reproducedRED→GREEN.
Actual fund applications/reviewer/nativefinance remain open in remaining_work.md.
