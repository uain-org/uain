# Earned Coin entry, private OTC payment and exit

Native 0.3.5, installed on both shadow servers, connects the prospective bounty issuer to the corrected
Orchard pool. The governing whitepaper/FAQ wording is unchanged. Existing pilot
credits are separate; neither credits nor an arbitrary funding note can enter
this asset. Production policy activation and signed member-client adoption are
separate from installing the implementation. CHF redemption remains inactive;
Rahul confirmed there are no reserves now.

## Consensus and confidentiality

An active licensed member signs `coin_shield` or `coin_exit`. Both contain
`bundle` (canonical base64url) and a flat `approval` object. Its fields are
`reviewer`, `effects`, `purpose_commitment`, `class`, `expires_height`,
`licence_revision`, `direction`, `member`, `amount` and `signature`.
Amounts, heights and licence revisions are canonical decimal strings. The
signature uses base64url without padding. Individual amounts are positive and
at most 9,223,372,036,854,775,807 atomic units; global supply uses wide integers.

Entry requires the owner's already-earned transparent balance, a negative
Orchard value balance exactly equal to its debit, an accepted epoch root and an
appointed independent high-Karma reviewer's current licence/purpose approval.
Exit requires a positive value balance exactly equal to its public credit and
sufficient aggregate pool backing. Both use the same global nullifiers and
append-only note tree as `private_payment`. Supply, owner balance, notes,
nullifiers and the `private_boundary/<effects>` receipt commit in one SDK cache.
Neither boundary changes minted supply. Rejection consumes no account balance,
note or command sequence.

The approval domain is `UAIN/coin-boundary/approval/v1`, distinct from existing
OTC approval. It additionally binds the prospective Coin policy/denomination,
public member, direction and exact amount. Chain epoch, expiry, current global
licence revision, effects, purpose, classification and reviewer remain bound.
An old OTC approval cannot authorize a boundary or a second account. Existing
private approvals, ledger hashes and zero-value-balance OTC rules retain their
formats. A reviewer losing appointment or licence invalidates authorization;
licence changes invalidate outstanding revision-bound approvals.

Public entry/exit exposes its member and amount. Private OTC exposes encrypted
notes, proof, nullifiers, salted purpose/classification and the separate relay;
it exposes neither trading member, shielded address, payment amount nor terms.
Small-pool/timing and RPC metadata can still permit inference. Licence-to-note
identity is the reviewer's attestation after checking member-signed address
consents; the unmodified Orchard circuit proves note ownership and conservation,
not membership or ethics. The present bootstrap is centrally operated and does
not claim anonymity from its operator.

## Member and checker protocol

`uain-coin-wallet keygen <new-mode-600-file>` creates a separate member-held
Orchard key and refuses overwrite. `shield` and `exit` use two private stdin
lines: an intent, then its checked approval. Proof generation occurs on the
member's own machine; disposable acceptance fixtures run on the server. Never
send a real spending/member signing key to the connection server or a checker.

The intent contains `chain_id`, string `expires_height`/`licence_revision`,
`key_file`, verified `commitments`/`expected_root`, `member`, string `amount`,
`purpose_commitment`, `reviewer_public_key`, `memo` and a new `review_file`.
Exit additionally specifies the proof-authenticated `source_bundle` (hex) and
its global `source_position`; entry must omit them. The wallet checks its
witness against the finalized root, keeps both entry/change outputs under its
own key, writes a mode-600 one-time review packet, and emits the public effects
request. It verifies every approval field/signature before generating and
self-verifying the final proof. The wallet's approval line uses signature hex;
the native payload uses base64url. `inspect-review <mode-600-file>` returns the
committed effects, exact value balance and both recovered outputs with local
action positions. It never returns a spending or full viewing key.

The checker transport uses the existing reviewer-certified X25519/HKDF/AES-GCM
channel. `coinBoundaryPurposeCommitment(agreement, boundary)` combines the exact
salted agreement with the Coin policy, member, direction and amount. That purpose
also binds certificates, encryption and member address consent.
`signBoundaryFromPrivateState` requires a fresh frozen snapshot issued by the
pinned native verifier, verifies exact agreement, owner consent, output values,
reviewer and available value, and requires an explicit benevolent/neutral
judgement. Copied indexer JSON cannot confer approval authority.

The state reader accepts either two OTC parties or one `boundary_member`, never
both. It verifies Coin activation/supply and the boundary owner's licence,
balance and independent reviewer against the same finalized application hash.
A never-credited owner is zero only after a genuine SDK absence proof. Up to 16
combined `source_payments` and `source_boundaries` authenticate ciphertexts;
all ordered notes reconstruct the proven tree. Full synchronization remains
bounded to 1,048,576 notes; incremental authenticated witnesses remain open.

`uain-private-wallet pay` continues to make confidential zero-balance payments
with separate licensed sender/recipient consents. Amounts and expiry accept
canonical decimal strings. Existing small integer inputs remain compatible;
integers above JavaScript's safe range are refused, and output expiry is a
string. Checker inspection includes private action positions for later witnesses.

## Acceptance and release gate

Server acceptance starts with an actual signed, prospectively priced bounty
settled by independent novelty checkers; it does not inject a Coin balance.
Real proofs then debit 70 atomic units, privately pay 26, and credit 26 on exit.
Minted supply stays 5,000,000, final transparent supply is 4,999,956 and pool
backing is 44. SDK tests cover tampered records, genuine balance absence proofs,
revoked reviewers, unknown source roots, replay, rollback and persistent restart.
The wallet-driven fixture uses two actual disposable SDK/Comet daemons, the
pinned reader, encrypted review and independent signed-header/state proofs.

Full server race/vet/build, the exact installed 0.3.3 → 0.3.5 upgrade rehearsal,
and PR/main native/private and backend/site CI pass. PR #195 merged at
`2006cb1d760fe875bb02d56a32b63590fb57f6e0`; qualification is recorded in
`chain/reports/coin-boundary-server-20261008.json`. Both original shadow nodes
run the pinned linked 0.3.5 binary and all three public wallet/state tools are
installed root-owned mode 555. All 28 post-upgrade proofs preserve the original
member/legacy state and application hash; see
`docs/chain/proofs/private-coin-shadow-0.3.5-20261008.json`. Coin/private policies
remain inactive. These fixtures use only explicitly fictional keys,
agreements and work; no production mint or pool activation is demonstrated.
Independent integration review, signed member-client/checker/relay adoption and
complete authoritative federation cutover remain open. Funding, dividends and
external payouts have separate C12/C13/C14/C16 acceptance gates.
