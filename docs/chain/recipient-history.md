# Bounded native recipient history

The `recipient-history-v1` index supports chain-backed public profiles and
migration without scanning all members or rewriting the existing credit/Karma
journals. It indexes nonmonetary native journal rows; it does not index private
Orchard notes or convert historical credits into UAIN Coin.

A guardian signs `activate_recipient_history` with `policy` and a SHA-256
`evidence_digest`. Activation applies from the following height. Each licensed
member may then sign `recipient_history_page` with `kind: "credit"` or `"karma"`.
One command processes at most eight consecutive global journal rows. A failed
command preserves the cursor, indexes and member sequence through SDK rollback.
Caught-up commands are refused. Original journal bytes and payout paths remain
unchanged; index work has its own bounded transaction gas budget.

The index appends original row IDs in global journal order to each member's
aggregate history and, when present, its exact instance history. Each recipient
page has at most 32 IDs. Instance attribution creates no extra credit or Karma.
An interrupted backfill resumes from its committed cursor; new awards are picked
up on subsequent commands. Deployment must arrange continued signed backfill
calls before presenting the index as current. No background operator or member
key is invented by this feature.

## Records and queries

Use `/store/federation/key` at a fixed finalized height with proofs. For a member
scope the prefix is `recipient_history/KIND/member/MEMBER`; for one instance it
is `recipient_history/KIND/instance/MEMBER/INSTANCE`. The five base dependencies:

- `recipient_history_activation`
- `KIND_count`
- `recipient_history_progress/KIND`
- `PREFIX/count`
- `PREFIX/page/00000000000000000000` (zero-based, 20-digit page number)

Fetch each original `KIND/ID` named by that page. A verifier requires all five
base inclusion/absence proofs and exactly those original journal proofs against
one trusted app hash and height. Omitted data cannot stand in for a proven zero.
Duplicate, unrelated, cross-recipient, malformed, tampered and mixed-height
bundles fail. Pages expose string-valued `indexed_through` and `journal_head`;
`complete` is true only when they match. `next_page` refers to the recipient's
materialized prefix, even while new global rows remain unindexed.

The application method `RecipientHistoryPage` reconstructs at most 32 rows. The
proof API `VerifyRecipientHistory` requires a previously authenticated header.
For offline verification, use a separately obtained canonical genesis and a
JSON bundle containing `signed_header` plus `queries`:

```sh
uain-proof --genesis trusted-genesis.json --bundle history.json \
  --history-kind credit --history-member uain1PUBLIC_MEMBER_ID --history-page 0
```

Add `--history-instance INSTANCE_ID` for exact instance attribution. The CLI
first authenticates the signed header and activation proof, then verifies the
complete page bundle; it emits the verified history JSON. It reads no signing
keys and performs no network requests. The 16 MiB bundle cap is enforced while
reading. This fixed-validator verifier shares the existing bootstrap trust
limit; validator transitions still need a general light client.

## Acceptance and remaining migration

Native 0.3.6 passes server race/vet and all fifteen PR checks (PR #207).
Fresh and installed-0.3.5 upgrade two-node rehearsals each verify six complete
pages, including absence proofs, omitted/wrong-recipient rejection and restart.
The maximum tested full-tail page uses 1,574,310 of the 3,000,000 gas limit
(718,118 with compact accounts). Three-node Tor exchange regression passes
51 independent SDK proofs, encrypted review, replay and restart.

Both original shadow hosts run the pinned 0.3.6 daemon and have the public
verifier installed. All 28 original public state proofs, genesis, identities,
app hash and service limits verify after the guarded upgrade. Production
Coin/private/history activations remain absent. The public signed 0.14.9 client
and all ten files verify; no worker release changes were needed. Evidence:
`docs/chain/proofs/recipient-history-release-20261009.json`.

The guarded installer pins daemon SHA-256
`a92cb71beb69852269daed730472e36f961b4f6e5bb979bcc349c3319b88c028`;
`ops/chain/install-history-tools.sh` installs only the public offline verifier
SHA-256 `2e85f43fb1e3af3b6c7bc48ce6a7e148177f54f16b5b9d591100eb19082790bf`.

`complete` means the entire native credit or Karma journal is indexed at that
height. Pre-journal opening balances and the pilot's legacy ledger require their
own proof/import reconciliation. This does not complete federation migration,
public API/member-client integration, million-member storage/load acceptance or
independent governance. Production policies remain inactive; no real balances, coins or historical
hashes are changed.
