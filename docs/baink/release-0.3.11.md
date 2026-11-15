# BAINK 0.3.11: reviewed enquiries and peer blocking

## Intent and reproduced defects

Kenneth's peer-contact/Trade direction requires clear transaction discussion and
private communication. Before extending structured terms, source audit found two
gaps in existing enquiries: the client sent no reviewed version, so a concurrent
price edit silently changed the stored snapshot; and Trade did not consult the
peer block list. Both defects were reproduced RED before the service changes.

This release repairs that foundation. It does not implement a binding contract,
commission policy, transfer, funded job or the still-open structured terms flow.
AI$ remains the existing native UAIN Coin, with financial readiness unchanged.

## Resulting behavior

New enquiry bodies require `expectedRevision`, a positive safe integer matching
the current listing inside the serialized transaction. Missing review fails with
`400 offer_review_required`; malformed values with `400 invalid_body`; a changed
listing with `409 offer_changed`. Existing withdrawal checks still apply. New
messages respect peer blocks in either direction, checked in the same transaction
before enquiry/rate changes. The generic block error identifies neither blocker.
Absent message state is not initialized; malformed block storage fails closed.

The signed client sends the selected version and shows its exact quoted price.
A definite stale/review/withdraw/block refusal clears the selection and draft,
refreshes listings and requires an explicit new selection. That draft clearing
is an accepted limitation. Unknown/network outcomes preserve the original draft,
revision, body and intent ID for an unchanged explicit retry; no automatic send.

An exact completed retry returns its original durable enquiry before current
price/availability/block/quota checks. New fingerprints bind the reviewed version.
Legacy no-version requests are accepted only when they exactly match a stored
legacy intent; new unreviewed writes are refused. No old fingerprint, record,
snapshot, price, public DTO or native ledger hash is rewritten. Historical reads
remain participant-only. Authentication nonces still follow existing replay
rules even when a business operation is refused.

## Claude and browser qualification

Actual Claude Code Opus5.5 authored all JSX changes, with audited Read/Edit-only
receipts. The first session was `877c5f2b-cf57-4628-a98e-c881c8e67626`; lifecycle
repair session `363d0b72-44ee-46ea-843f-2694b3eec5cb` fixed a separately reproduced
StrictMode setup/cleanup issue. Trade now creates its listing reader in effect
setup; the shared request hook reactivates on setup. No homepage/CSS/3D redesign.

Isolated actual Chrome checks cover stale price → explicit reselect/new price,
lost response → exact original retry after price/block changes, generic blocking,
cancel, late success/failure after keyed identity/provider context changes,
StrictMode and 390px layout. Fixtures use mocked/local API behavior, with no
production account, holder key, enquiry or block operation. Normal production
does not enable StrictMode; the repair also qualifies development/replay behavior.
Existing historical success notices can outlive a later action; that pre-existing
feedback detail is outside this bounded guard repair.

## Checks and delivery status

339 full app tests pass, including service and signed HTTP regressions; both
primary and preview builds pass. Independent review found no outstanding material
issue, with 29 backend/HTTP and nine client checks independently rerun. Official
SDK local onboarding, nine read tools, catalogue/source/profile/Trade reads and
inactive funding/settlement contracts pass. These are local checks; no positive
production holder-authenticated enquiry is claimed.

Evidence: `output/baink-2026-11-02/heartbeat-1428/trade/` contains RED/GREEN,
signed HTTP, full tests/builds, actual Claude receipts/QA pointers and review.
Private Claude transcripts remain ignored and owner-only under
`work/baink-trade-enquiry-claude-20261102/`.

## Verified standalone deployment

Activated **`20261102T092231Z-69c90313c1`** from exact prior
`20261101T210801Z-250148209a` on Universa, under the existing shared activation
lock. Archive SHA256:
`4f653fc27db964708cd0662cfb303328ef358385fc44a0d734dee4edcfd6490c`.
All **101 runtime and 31 preview hashes** match the immutable manifest. Backup:
`/var/backups/baink/20261102T092231Z-69c90313c1`. Both official SDK 1.30 flows
report 0.3.11 and nine read tools, with inactive funding/settlement. The 84-check
public matrix plus two new unsigned-enquiry denials pass (**86 public checks**).
Both served bundles contain the reviewed-revision/quote UI and match manifest
hashes. These checks do not create a production holder, enquiry or block.

All business keys actually present in backup/live state match exactly; nonces
and environment bytes match too. Private state remains0600. Neither nginx config
changed; the independent five-design release remains `20261101T124812Z` and
Paperclip data remain absent. At09:25:25UTC the service was active/NRestarts 0,
67,579,904 bytes current /79,470,592 peak under335,544,320 limit. No runtime limit
was relaxed. Signed positive/block/retry behavior is qualified by isolated local
fixtures and browser QA, not a production holder-authentication canary.

No UAIN main push, worker change/signing, DNS/nginx update, native financial or
identity command, member key, sensitive grant or paid job was performed.
Structured terms proposals and actual contracts/settlement remain open.
SmartMeet completion and final preservation receipts follow this qualification.

Live actual Chrome signed-out smoke also passed on primary and preview at desktop
and390px, with no captured console error or horizontal overflow. No holder state,
login, key or private API action was involved; tabs closed and viewport reset.
Receipts/screenshots are under `trade/live-public-ui/` in the evidence directory.
A manifest comparison with0.3.10 confirms that only Trade server logic, MCP version,
package version and generated web chunks/entry HTML changed. Landing source/CSS
were untouched; its generated chunk references changed with the main bundle.

Reporting verified: SmartMeet event `baink-trade-enquiry-0311-20261102-01` delivered
as `1793612316.987119`; actual SmartMeet bot post and exact title/summary matched.
Payload/body identity is stable in the private checkpoint. Full manifest/state/
nonces/env/config/design preservation passed again after reporting. No direct
coding-agent Slack send, uncertain retry or duplicate question. Three unresolved
decisions are tracked across the four question/follow-up threads.
