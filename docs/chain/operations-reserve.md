# Federation operations reserve

The governing FAQ and whitepaper reserve 5% of confirmed funding for federation
operations. This candidate lets a current guardian record an exact public
operating-cost intent against one receipt's existing operations bucket. It
supports outside vendors without requiring membership. An invoice and signed
authorization are attributable evidence, not a proof that a cost is legitimate.
The governing texts and historical source records remain unchanged.

## Signed commands

All commands use the ordinary licensed member envelope with an empty instance.
Only current guardians may file a cost or restart an impaired review. All
monetary amounts are canonical positive atomic-unit decimal strings.

| Operation | Payload |
| --- | --- |
| `operations_intent` | `id,receipt,network,asset:"native",escrow,amount,target,payee,invoice_digest,evidence_digest`; optional `member` |
| `operations_attest` | `receipt` (operations intent ID), `kind:"operations",transaction,index,amount,target,source,block,block_hash,evidence_digest` |
| `operations_review_restart` | `id,expected_effects_digest,evidence_digest` |

Payee text is trimmed, nonempty and at most 500 bytes. Evidence and invoice
commitments are lowercase SHA-256 hex. The network, asset and escrow must match
the original confirmed funding campaign. The target must differ from escrow.
Supported denominations are native ETH on Ethereum1/Base, native SOL, and
USD/EUR bank account commitments. No command carries bank account details,
contract calldata, a private key, or a conversion into Coin.

An optional member recipient must be licensed and have a current proved
wallet/bank binding matching the exact target when the intent is filed. The
binding is frozen as immutable evidence. A later unbind cannot redirect or
invalidate that already authorized cost. Nonmember payees are identified by
the approved target, public payee text and invoice commitment.

## Conservation and finality

Filing moves only this receipt's `operations.available` to
`operations.reserved`. It changes no bounty/dividend/dust amount and issues no
credits or Coin. There is no cancellation or release command: no observations
alone does not prove that an external signed transaction is absent.

Two appointed, currently licensed observers with proved independent operator
domains must attest the same actual finalized outbound transfer and checkpoint.
They must be independent of the original payer, project lead, escrow
controllers, intent guardian, known member recipient and each other.
Permanent source/target controller history survives unbinding. Current and
historical proved control is checked for the payer source, outbound escrow and
payee target, including later proved operator domains. The first observer's
appointment, licence, standing, control exclusions and operator domain are
rechecked when the second observation arrives.

The first observation permanently consumes its exact foreign transfer reference
for this intent. Effects cannot change on review restart, even with an empty
observation list. The second valid observation alone moves Reserved to Paid and
debits the aggregate treasury liability once as `operations/<id>`.
Finality is an explicit independent-observer assurance model; these records do
not cryptographically verify an external bank or chain inside consensus.

A current guardian may restart exactly one stale observation if its observer is
ineligible or after the existing 720-block financial review timeout. The old
quorum is archived immutably. The amount, target, transfer, effects digest and
full reserve remain fixed. Two fresh eligible observations are still required.
No timeout releases or reallocates an uncertain external payment.

## Proved records

- `operations_filing/<id>` is the immutable original intent.
- `operations_intent/<id>` carries the same identity and pending/paid state:
  `id,receipt,guardian,network,asset,escrow,amount,target,payee,invoice_digest,
  evidence_digest,member?,wallet_binding?,height,state`.
- `operations_quorum/<id>` is the standard funding effects digest and bounded
  two-observation quorum.
- `operations_review_archive/<20-digit native event>` preserves each impaired
  quorum and guardian evidence.
- `treasury_effect/operations/<id>` is the once-only finalized liability effect.

The dedicated treasury custody executor uses intent domain `operations/ID`.
Consensus intent acceptance is distinct from custody signing, broadcasting and
independently observed final settlement. Fiat execution remains a separate
bank-custody operation; crypto custody permits exact native transfers only.

## Qualification

Isolated capped server tests cover signed SDK execution, proofs, restart,
replays, independent controller exclusions, all supported denominations,
source/member binding preservation, stale-review recovery and conservation.
The maximum fixture uses 20 controller-history entries at every relevant
address and maximum public payee text. Exact logs, gas and source hashes are
recorded in `chain/reports/operations-reserve-server-20261012.json`.
No production operating cost was filed or paid by these tests.
