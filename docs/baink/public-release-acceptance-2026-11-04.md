# Public release acceptance — 4 November 2026

The activated BAINK0.3.23 release `20261104T173604Z-3dd7516943` passed **153/153 public checks** between17:41:28 and17:44:07UTC. There were153wire attempts and zero rate refusals in the paced run. This verifies public artifacts, read-only behavior and unsigned authentication refusals; it does not claim an actual production earning or payment.

## Observed result

- Every primary and preview public artifact matched its exact SHA-256 from the actual activated server manifest:54assets across `https://baink.money` and `https://aidollar.money/baink/`.
- Both origins passed health/storage, source/coordination distinctions, active/held counts, unified work discovery, capability boundaries and private/financial authentication checks. All70active coordination details were read once from the primary public origin and had an active record, at least one preparation task, a coordinator and a starter contribution. This is coordination availability, not70scientific executions or funded crews.
- Empty unsigned POSTs to the new Trade payment-request and unused-earning reconcile routes returned401 on both origins. There were no signed requests, created accounts or financial commands. These are refusal probes, not successful transactions.
- The canonical redirect retained its query and returned308 from the legacy origin to `https://baink.money/`.
- Fresh native asset responses verified active coin/private status and expected chain/genesis/reader pins at heights1192953and1192965. Minted, reserved, transparent and shielded supply were all zero. The visitor selected no member and received no fabricated balance. Production earned/spent receipts remain separate.

## Reproducible harness and rate limits

`ops/qualification/baink-public-release.mjs --manifest FILE --output FILE` requires an explicit manifest and fixes its two public origins. It validates safe artifact paths, exact hashes and a fresh pinned native asset response with nonnegative conserved supply. It never accepts a signing key or account identity.

The first unpaced run attempted153checks and encountered30HTTP429refusals. That receipt is preserved; the rate caps were not changed. The corrected read-only harness runs API requests serially at1.6-second intervals, respects actual Retry-After or a conservative60-second fallback, permits at most three attempts and retains an eight-minute global deadline. Every wire attempt/refusal is counted. Retrying is limited to safe public GETs and the exact empty unsigned rejection probes; signed/account/financial operations and ambiguous network failures are never retried. A130.4-second cooldown preceded the successful run.

Four portable mock tests passed, covering argument/path safety, fresh pins and supply conservation, unsigned-only request behavior, bounded rate refusal recovery and Retry-After handling. They do not depend on ignored files or make real network calls.

The ignored exact report is `output/readiness-20261104/release-0.3.23-public-acceptance.json` (SHA-256 `973af08438a40c9362251cad63d6e9e1c732bfdab37f204385381e0c24f3c804`). The corresponding log, actual live manifest, initial rate-refusal receipt and mock-test receipt are retained under the same ignored evidence directory. Host business-state, environment and nginx verification belong to the separate release record; this harness does not replace them.
