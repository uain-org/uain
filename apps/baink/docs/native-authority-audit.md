# BAINK native Coin authority audit — 31 October 2026

Read-only audit against the deployed clean checkout
`~/Work/uain-paperclip-release-20261026` and the live native
chain. The user-selected display name AI$ refers to existing native UAIN Coin;
it does not introduce a second asset or convert existing pilot credits.

## Fresh cryptographic observation

The installed Linux amd64 `uain-state` executable and public genesis were
SHA-256 checked before execution. Its independent pins are recorded in the
clean checkout's `docs/chain/proofs/native-public-bootstrap-readonly-20261013.json`
and `docs/chain/proofs/native-runtime-live-20261012.json`, and were independently
cross-checked against the installed runtime receipt over authenticated SSH.

| Trust setting | Exact value |
| --- | --- |
| Reader executable SHA-256 | `136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860` |
| Public genesis SHA-256 / epoch | `54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff` |
| Chain ID | `uain-shadow-20261008-1` |
| Public RPC origin | `https://uain.global` |
| Reader freshness bound | `2m` |

The first read used the app server's existing node RPC on
`http://127.0.0.1:26667`. The verifier exited zero at state height `1018585`,
signed header time `2026-10-31T15:58:45.444075352Z`, application hash
`efcb2f625440fdb4f95fe06a3abb4ca0385de5b29289c5b08703300801cb6563`,
and event count `466`. Seven queries authenticated the mandatory anchor records
and these selected records:

```json
{
  "coin_activation": null,
  "coin_supply": null,
  "private_activation": null,
  "coin_balance/uain10000000000000000000000000000000000000000": null
}
```

Here null is cryptographically proved absence, not a failed lookup. The selected
balance belongs to a deliberately nonexistent test address; this is not a
statement about a particular user's holdings. Absence of activation and supply
means the native Coin economy remains inactive. Do not present an activated
minted supply, spendable funds, or credit conversion.

A second independent execution through the production HTTPS RPC origin also
exited zero at height `1018598`, header time
`2026-10-31T15:59:11.620497519Z`, the same application hash/event count, and the
same authenticated absence of `coin_activation`, `coin_supply` and
`private_activation`. The proposed public adapter transport is therefore
verified with the real pinned reader, not inferred from a JSON wrapper.

`GET /api/native/authority` also reported native authority, ready/selected,
permissioned operation and one independent operator. Its projection cursor has
an older state height/time; the fresh signed-header proof above establishes the
current observation. These descriptive HTTP responses are not trust anchors.

## Adapter contract safe to implement now

Configure the executable path/hash, genesis path/hash, expected chain ID and RPC
origin independently of gateway JSON. Before each trusted execution verify the
artifact hashes, invoke the executable without a shell, and pass a bounded
selection on stdin:

```json
{
  "keys": [
    "coin_activation",
    "coin_supply",
    "private_activation",
    "coin_balance/uain1<40 lowercase hex digits>"
  ]
}
```

The CLI takes `--genesis FILE --genesis-sha256 PIN --rpc ORIGIN --max-age 2m
--out NEW_FILE`. Read only a newly created snapshot after a successful exit.
Require the expected chain ID, fresh header and exact selected record keys.
Preserve amount strings; global supply exceeds JavaScript safe integers and
uint64. Reader errors, stale proofs, unexpected epochs, invalid policy or absent
required supply fail closed. Missing data must not become a fabricated balance.

The verified reader anchors the fixed genesis validator set using a mandatory
`guardians` inclusion, verifies query height H against signed header H+1, and
checks SDK inclusion/absence against that one application hash. This remains
the existing permissioned bootstrap trust model, with a single operator; it is
not independent multi-operator consensus.

## Actual payment capability and browser boundary

The deployed source's native command dispatcher has no `coin_transfer` or
ordinary public account-to-account Coin payment. It supports prospective bounty
issuance and `coin_shield`, `coin_exit`, and `private_payment`. The governing
implementation explicitly avoids a transparent OTC bypass. Adding a new
public transfer would be a consensus and policy change, not a BAINK adapter.

The existing signed client provides a local CLI private workflow. The holder
uses a separate Orchard spending key, a holder-owned local full node, pinned
`uain-private-state`, `uain-coin-wallet` and `uain-private-wallet` executables,
proof-authenticated note witnesses, purpose-bound owner consents and independent
ethical-review approvals. `chain/client/private-workflow.mjs` implements proof
production, encrypted review, approval verification and local signing; it does
not itself broadcast. A separate journaled submit path sends the signed public
envelope through the configured onion relay and requires verified finality.
See `docs/chain/private-client.md` in the clean checkout for its full contract.

There is no existing browser WebCrypto replacement for the Orchard prover,
holder-owned node, local files and review workflow. WebCrypto Ed25519 alone
does not authorize a private payment or a Coin boundary. Current Coin/private
policy absence also prevents a real production payment through the CLI today.
BAINK may expose verified readiness/balance state and prepare integration work;
it must keep sends unavailable until these actual prerequisites are satisfied.

## Native enrolment signing

The browser's existing Ed25519 key produces the same native member address:
`uain1` plus the first 40 lowercase hex digits of SHA-256(raw public key).
Its BAINK API-auth signature is a different protocol from a native command.
Native command signing bytes are exactly `uain:chain-command:v1\n` followed by
the fixed field order `version, chain_id, member, sequence, expires_height,
operation, payload` (and optional instance last). Payload keys use UTF-8 byte
ordering and Go-compatible JSON escaping for `<`, `>`, `&`, U+2028 and U+2029.
Signatures/public keys use unpadded base64url. Use the canonical protocol in
`chain/client/signing.mjs`; do not reuse a generic object-key sorting function.

Enrolment payload is `{name, operator, family}`. A proof of member absence
permits sequence `"0"`; enrolment creates a pending licence with zero standing.
Automatic screening/guardian activation is separate. CheckTx acceptance is
pending; require a verifier-authenticated exact successful event receipt.

No production writes, activations, rewards, broadcasts, spending keys or private
key reads occurred in this audit. Temporary local proof snapshots were removed.
