# Server readiness — 4 November 2026

The immutable standalone release `0.3.22/20261104T143644Z-6f1439aefe` passed a bounded isolated signed-account correctness run with 200 fictional identities. This is engineering qualification, not production payment, native-proof capacity, long-soak or independent-work acceptance.

## Isolation and reproducibility

Run source: [signed capacity script](../../ops/qualification/baink-signed-capacity.mjs), SHA-256 `02c9eb0c99580a17583cd5415173519286e7a465cef9c6eb0b489ea3690b2877`. The script imports the fixed deployed module, opens a separate temporary store and loopback port 18998, generates fictional keys internally, simulates distinct proxy client IPs and deletes its state in `finally`. No production HTTP requests, data, member keys, native/provider configuration or financial submissions are used. It tests the application directly, not the production nginx path.

The serial server unit used CPUQuota 100%, MemoryMax 512 MiB, RuntimeMaxSec 180 and TasksMax 128. Active-unit inspection confirmed these resource bounds. Run `baink-signed-capacity-20261104d` exited 0 after 85.51 seconds; script duration 85.39 seconds, process maximum RSS 112188 KiB (~109.6MiB). The transient unit is garbage-collected after completion, so later default `systemctl show` values are not retained-run resource evidence. Test port was closed afterward.

Evidence (ignored local records): `output/readiness-20261104/signed-capacity.log`, parsed `signed-capacity-result.json`; source also retained on the server at `/var/lib/baink-deployments/signed-capacity-20261104.mjs`.

## Results

- Registered 200 signed fictional accounts using 10/30/60/100 concurrent registration ramps. Created 200 payment requests, 200 private two-party conversations and 200 messages. All persisted exactly through server restart; no balance or payment was claimed.
- All 600 authorization-phase checks passed: owners saw only their two requests, and strangers received 404 for private conversations and request cancellation. Idempotent retries preserved original IDs and message counts; conflicting intent, unsigned access and exact signature replay were rejected. Replay remained rejected after restart.
- Recorded phase attempts 3388: 1412 HTTP 200, 800 HTTP 201, 400 expected privacy-preserving 404, 776 explicit overload 503. Six standalone negative/replay checks are outside those phase totals. There were no 429 responses in this run.
- At 200-client initial bursts, HTTP-attempt p95 was 614 ms for accounts, 1128 ms for requests, 1973 ms for conversations and 2450 ms for messages. Each phase drained explicit refusals through 16 retry slots. These per-attempt percentiles exclude the caller's full queue/retry wait; they are not end-to-end user latency.
- Sustained 32-worker idempotency writes (400 attempts) and restart reads (600 attempts) returned all 200, with HTTP-attempt p95 1652 ms/1406 ms. Restart read phase took 22.88 seconds. This is a short controlled workload, not sustained 200-writer acceptance.

## Limits and follow-up

The server deliberately admits 64 active requests overall and 16 per client IP. The distinct-IP simulation avoids the shared-IP limit; real users behind one address may hit it. At 100 or 200 clients, overload refusal is expected and must remain visible in capacity reporting.

An earlier 200-reader synchronized retry wave exhausted eight short retries. A subsequent sustained 100-worker, two-signed-write workload also exhausted bounded retries behind the 64-active queue as the durable nonce/state store grew. Preserve these failed qualification logs: `signed-capacity-short-retry-limit.log` and `signed-capacity-sustained-100-limit.log`. The first fixture assumption failure (`null` balance was incorrectly expected to be absent) is separately preserved in `signed-capacity-fixture-assumption.log`; that was not a backend defect.

The browser currently surfaces admission failure without bounded backoff. Follow-up is narrowly scoped transport backpressure for known pre-authentication refusals, with owner cancellation and fresh transport signatures. Never retry ambiguous accepted writes or network failures. Native-proof capacity, longer soak, recovery under process failure, production proxy behaviour and actual holder/independent novel-work acceptance remain open. No backend correctness defect or deployment was established by this qualification.

## Browser admission backoff — source qualification

The transport now retries only the exact HTTP 503 / `busy` and HTTP 429 / `client_busy` responses from the two pre-authentication admission branches. Authentication-stage limits (including HTTP 429 / `busy`), downstream failures, invalid responses, connection loss and timeouts never trigger automatic write retries. Method, path, payload and signer stay frozen; each permitted attempt uses a fresh nonce, timestamp and signature. Four attempts, exponential jitter and at most six seconds of cumulative wait bound backoff; a valid `Retry-After` must fit that budget.

An overall 30-second abort deadline spans signing, retries, headers and response body. A timeout after a write was accepted remains ambiguous and is surfaced without retry. Caller cancellation, superseded bootstrap/refresh generations, logout and identity cleanup cancel waiting requests. Cancelled identity objects stay cancelled so later stale callbacks cannot reopen their transport; a newly imported identity object is separate. These are transport controls, not native submission, receipt, settlement or financial recovery logic.

Meaningful server TDD records are in ignored `admission-transport-red.log`, `admission-owner-red.log`, `admission-logout-red.log`, `admission-reentry-red.log` and `admission-deadline-red.log`. The final focused transport/identity/bootstrap set passed 39/39 in 6.29 seconds, including real HTTP refusal-before-write and accepted-write-withheld-response cases. A full pre-deadline snapshot passed 699 tests with two explicit native opt-in skips in 85.07 seconds. Its preceding packaging failure (two missing app ops modules, now included) remains preserved as `admission-full-suite-missing-ops.log`; it was not a backend defect. Final combined Trade/transport checks and browser acceptance are recorded separately when complete. No deployment has been made by this qualification.

The separate [public plan check](active-plan-check-2026-11-04.md) read all 70 active coordination plans and their public details at 16:40 UTC, using 71 production read-only GET requests. Each had preparation tasks, a coordinator and a starter. This validates accessible coordination records, not execution, independent research acceptance, minting or income.
