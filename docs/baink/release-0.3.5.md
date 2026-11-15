# BAINK0.3.5 - fast holder entry and independent verified data

Qualified1 November2026 IST. Release `20261031T191539Z-e8c0ecb4c5` is live
at https://baink.money and https://aidollar.money/baink/ on Universa. Previous
release0.3.4: `20261031T185159Z-faa0afa070`. No UAIN main push or style changes.

## User-visible change and measured result

Returning holders enter from a signed local account-metadata read while native
verification continues independently. Before this change, the first full account
read was on the login critical path. Actual Chrome measured that request at5060ms.
After deployment, the new entry request returned in83ms, and Chrome observed the
Dashboard before the full native account response finished. That independent
native read took5225ms. These are request timings plus an observed DOM checkpoint,
not a claimed83ms end-to-end paint benchmark or faster consensus verification.

Request/history reads finished independently in66-118ms. The first full native
request is deduplicated with manual/visibility/timer refreshes. Later30-second
periodic native reads are labelled by start offset in the timing evidence; they
are not duplicated initial login reads. Existing proofs still expire normally.

Until qualified native data arrives, status is checking/unknown and balance stays
null/unavailable. Local metadata cannot establish missing membership, active
licensing, funds or transfer authority. New-account creation and missing-local-
account paths keep their previous qualified POST/read behavior and routing.

## Signed metadata contract

`GET /api/account/metadata` requires the existing signature, exact audience/method/
path/body, timestamp, nonce, owner, origin and rate checks. Only an existing local
account can read it. Unknown keys cannot register an account or reserve a durable
metadata nonce. POST/extra query/body fields are rejected. Identity/key mismatch
fails unavailable rather than exposing another record.

Response account allowlist: address, publicKey, displayName, createdAt, updatedAt,
currency label AI$, balance:null, nativeRegistration:unavailable. Top-level
nativeStatus is not-requested. No raw store fields, private memo/key, native proof
or financial authority are returned, and no native/project/source read is started.
The client validates this projection and holder before entering the workspace.

## Independent activity and race handling

Incoming, all requests and history each track pending/error/ready. No count, rows,
empty-state or pager is asserted before that source succeeds. Malformed HTTP200
payloads cannot become zero/empty. One failed or stalled read does not withhold a
successful sibling. Failed refreshes hide stale rows/counts until a qualified read.
The old unconditional Transactions availability claim is neutralized.

Metadata/proof/activity generations prevent late responses from reopening a closed
session, crossing identities or replacing a saved Settings update. Unsaved form
state survives unrelated proof refresh. A synchronous request failure remains
retryable; promise ownership is assigned before transport invocation. Login resolves
the latest validated URL when metadata commits, preserving browser back/new provider
intent rather than restoring a captured old route. Cancel/logout invalidate entry.

## Verification and real browser acceptance

-236/236 complete app tests pass, including8 metadata HTTP and13 bootstrap/helper
checks. Independent focused33-check review is clear. Both builds pass. RED failures
were reproduced before route/refresh/readiness corrections.
-Backend fixture points to a pinned executable that would block indefinitely;
metadata response succeeds without starting it or a source/private read. Signature,
owner, nonce/replay/rate, missing-account and projection failures remain qualified.
-Actual local Chrome uses a deliberately stalled test reader, not a production
native proof fixture. Dashboard opens while native status checks, then remains
unavailable after timeout without zero/missing-member inference. A paused incoming
fetch shows loading/no count while successful history stays visible. Controlled
incoming-only network failure shows unavailable; retry confirms empty only after
its real successful read. Temporary interception patterns were cleared.
-Live Chrome metadata83ms / independent full account5225ms; Dashboard and existing
request/cancellation history are visible before native completion. Later the test
identity is correctly proved missing from native membership. No native member,
public profile, listing, message, order, request or funds were created.
-Live unsaved Account name survives a successful account refresh; no mutation
request is observed. The draft is discarded, viewport reset and held QA key logged
out.390px has scrollWidth390. Local and live keys are cleared after acceptance.
-All business fields in the union of backup/live keys match, excluding expiring
signature nonces. Actual memberProfiles/peerMessages/trade collections are absent
in both, not invented preserved records. The QA display name remains unchanged.

## Deployment evidence

94 runtime+31 preview hashes verify before immutable activation. Expected-prior
check and root-only backup:
`/var/backups/baink/20261031T191539Z-e8c0ecb4c5`.
Public19-check matrix validates primary/preview exact bundles, metadata/private401,
owner filter/access/machine guide and health. AI Dollar root retains its existing
manifest. No production native command or financial policy activation.

Evidence under output/baink-2026-10-31: fast-login-{full-tests,main-build,
preview-build}.log; fast-login-{deployment-result,public-acceptance,
state-preservation}.json; live-034-login-network-timing.json (baseline),
live-035-login-{checkpoint,network-timing}.json; live-035-unsaved-draft-check.json;
live-035-fast-dashboard.png; live-035-settings-mobile.png;
local-035-{stalled-proof-fast-entry,activity-pending,activity-unavailable,
recovered-mobile}.png.

Paperclip exact image/runtime/ACL/recovery qualification is a separate ongoing
operation. Full commissioned research, current native history, trust discovery,
native financial completion and member meeting evidence remain open. Use the
implementation register and tester packet; source counts are not completion counts.
