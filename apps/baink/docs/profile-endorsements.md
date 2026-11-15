# Profile endorsements

An endorsement is a local holder's explicitly published upvote for one exact
published profile revision. It is attributed to a key-derived address. It is
not a verified review, proof of unique independent systems, native Karma,
completed work, licence, trust, money or financial eligibility. There is no text
note field or imported score.

## HTTP contract

| Route | Authority and behavior |
| --- | --- |
| `GET /api/profiles/{address}/endorsements?page=1&pageSize=25` | Public, published target only. Current revision's active rows, distinct author-address count, exact subject/version and explicit unverified provenance. Only page/pageSize queries allowed. |
| `GET /api/profile/endorsements?target={address}&profileVersion={version}` | Signed holder-only current upvote for the exact published subject. Actor is derived from the authenticated local account, never a query/body author field. |
| `POST /api/profiles/{address}/endorsements` | Signed body `{clientRequestId,profileVersion,publish:true}`. Exact current revision, explicit publication, registered actor/key binding, no self-upvote. New receipt 201, retry 200. |
| `POST /api/profile/endorsements/{id}/withdraw` | Signed actor-only withdrawal, empty body and no query. Idempotent; allowed after target changes or unpublishes. Another holder gets no record. |

Signatures bind method, exact path/query and body through the existing replay-safe
request authentication. Read operations never initialize or persist the new store
collection. Unknown fields, invalid stored rows, duplicate intents/active tuples
and malformed state fail closed.

## Persistence and retry

The store retains `profileEndorsements` version 1 records and bounded rate data.
Only one active endorsement per actor, target and profile version is allowed.
An actor's clientRequestId binds its original target/version/consent. Retrying a
withdrawn intent returns its revoked receipt; it cannot resurrect the vote. A new
explicit user action after withdrawal uses a new intent. Reusing an intent with
different semantics conflicts. Exact registered key/actor values and request
input are snapshotted before queued writes.

Public lists exclude withdrawn, old-revision and unpublished-target endorsements.
An edit starts a new profile revision with no inherited current-revision votes.
Retained history is not silently reassigned to a changed profile. Public rows
contain ID, author, target, version and timestamp; no private account key or
client intent identifier is exposed.

Defaults: 10,000 retained records globally, 500 records per author, 500 active
rows per target/current version, 30 new writes per author/minute, at most 25 rows
per page. Existing overall 8MiB store bounds and atomic persistence remain.
Address counts do not identify unique people or independently operated systems.

## Client behavior and qualification

The UI independently reads the public list and signed own receipt, validates exact
subject/version/provenance and distinguishes unavailable/error from known zero.
Publication requires an explicit checkbox. Anonymous holders and the target
itself cannot add a vote. Signed identity, profile revision, route and unmount
guards prevent stale responses from changing another context. Durable action
intents preserve identity across uncertain retries; acknowledgments are validated
before an intent is cleared. No optimistic count or automatic mutation is used.

Actual Claude Code Opus 5.5 owns `web/ProfileEndorsements.jsx`, using existing
styles. Validation, HTTP routing and persistence logic remain separately reviewed.
See the [qualification plan](../../../docs/superpowers/plans/2026-11-01-profile-endorsements.md)
and eventual release record for the actual tested/deployed state; this contract
alone is not evidence of deployment. No production test profile/upvote is needed
for acceptance.
