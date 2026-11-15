# UAIN sovereign chain: requirements and completion evidence

Authorized by Rahul on 8 October 2026: build the full federation and production
on the existing servers using Cosmos SDK. The governing white paper and FAQ
remain unchanged. This register measures the whole goal, not just a running
chain. Every unchecked row remains unfinished.

Rahul confirmed on 8 October that there is no money for CHF redemption now;
backing is a future requirement. Reserve and redemption features may be built,
but cash redemption and claims of funded parity remain inactive without funding.
The existing draft-token deployment restriction remains in effect.

| ID | Governing requirement | Required acceptance evidence | Status |
| --- | --- | --- | --- |
| C01 | Sovereign chain on owned infrastructure | Two nodes agree on committed application state, survive restart and resync | Bootstrap verified 8 October; authoritative cutoff pending |
| C02 | Member keys remain member-owned; stable identity | Existing Ed25519 IDs, client signing, replay/cross-chain rejection | Native signing and local instance attribution verified; existing client integration open |
| C03 | Licences and admission | Screened licence approval, withdrawal, automatic revocation at -10 | Open |
| C04 | Public Karma, track record and skill results | Deterministic changes, proofs, voluntary tests, original attribution | Bounded research-standing witnesses and native recipient-history pages/proofs verified on server and installed in 0.3.6 (PR #207); legacy history, client and skill-result parity open |
| C05 | Projects, tasks, instant/future KPIs | Gates at 100/1000, shared allowance, lifecycle and KPI settlement tests | Native gates/KPI core and local instance attribution verified; prospective credit accounting verified locally; full parity/import open |
| C06 | Independent verification and novelty | No same-member review; default double-check; prior-art and novelty evidence | Native prospective membership/task challenges verified locally; operator proofs, complete import and client composition open |
| C07 | Arbitration and benevolence | Signed flags, independent decisions, appeals, sanctions and payment withholding | Bounded operator census qualified; candidate 0.3.7 research rulings/default reconsideration/penalties implemented with qualification pending; appeals, legacy and API/client adoption remain open |
| C08 | Bounded resources and collaboration | Capability discovery, agreements, execution receipts on real member infrastructure | Open |
| C09 | Permanent history and artifacts | Legacy roots/signatures unchanged; import reconciliation; available replicated artifacts | Legacy commitment verified; complete import/artifact availability open |
| C10 | MCP, HTTP, website, signed client | Existing full member journey uses authoritative finalized chain state | Open |
| C11 | UAIN Coin: 108T cap, mint only for verified rewards | Reviewed issuance rules and integer invariants; deployment gate satisfied | Candidate 0.3.4 signed prospective bounty issuer and exact cap passes server race/vet, SDK/two-node signed-header checks and full PR/main CI (PR #194); private bridge qualified and installed in inactive 0.3.5; reviewed activation and deployment gate remain open |
| C12 | 1 Coin = 1 CHF | Funded issuer/reserves, redemption policy, reconciliation and external review | Pending external funding |
| C13 | Funding rewards and 80/15/5 allocations | Verified payment receipts, reversals/refunds, integer conservation, agreed reward rates | Open |
| C14 | 15% dividend on eligible minted holdings | Eligibility decision, confidential snapshots/claims, zero-supply and rounding tests | Open |
| C15 | Private OTC and benevolence checks | Reviewed confidential payment design, no party/amount leakage, no double spend | Earned-Coin entry/private-payment/exit with wallet, pinned state and encrypted review passes full server/PR/main qualification; pinned 0.3.5 and three tools installed on both shadow nodes (PR #195), policies inactive; signed private client and compact incremental witnesses qualified on server; signed 0.14.7 and real Tor transport qualified/deployed (PR #202), gateway read-only; signed 0.14.8 refuses hosted/proxied selectors and uses holder-owned local state plus anonymous broadcast (PR #204); three-node Tor/51 proofs and actual Linux installer qualification pass, tools installed on both hosts; signed 0.14.9 record-only revocation/restart reconciliation and atomic courier qualify on three Tor nodes with 51 proofs, 27 client and 16 release tests, reader installed on both hosts; full holder cold sync, real adoption and integration/privacy review open |
| C16 | ETH, SOL and fiat bounties | Real reconciled payout receipts, external finality, exactly-once payments | Open |
| C17 | Federation governance and independent validators | Explicit AI-system authority; independent operators; outage/quorum evidence | Rahul confirms only the two owned servers are available (12 October); initial permissioned single-operator network, independent operators deferred; governance and signer/outage recovery acceptance open |
| C18 | Production resilience and security | Resource isolation, signer fence, upgrade rehearsal, backups/restores, monitoring | Isolation, identity custody and upgrade verified; full restore/monitoring open |
| C19 | Million-member growth path | Measured load/storage limits, bounded work, batching with preserved attribution/proofs | Native eight-row history backfill/32-entry pages with compound proofs and maximum-layout gas qualified/installed (PR #207); complete batching, storage/load and migration acceptance open |

## Architecture decisions

- Pin Cosmos SDK 0.55 / CometBFT 0.40 compatible dependencies; native Go
  federation modules and SDK stores. Transaction authorization preserves the
  existing Ed25519 member keys and IDs rather than asking members to surrender
  keys or replacing identity with an Ethereum account.
- Domain-separated commands bind version, chain ID, member, sequence, expiration
  height, operation and payload. Consensus code performs no network requests,
  random sampling or floating-point reward calculations.
- Every consequential transition is a chain transaction. PostgreSQL becomes a
  rebuildable index only after rehearsed migration and an explicit cutoff.
- Evidence executes off-chain; content manifests are committed on-chain and
  artifact availability has its own storage/retention acceptance.
- Bootstrap may use one isolated signing validator and a non-signing full node.
  It is centrally operated and stops when the validator is unavailable. It does
  not satisfy C17. Two equal validators cannot tolerate either going offline.
- Existing credits are nonmonetary accounting; imported credits are never
  silently converted to UAIN Coin. No speculative premint or stock inflation.
- Transparent credits do not satisfy private OTC. Confidential settlement and
  dividends remain separate acceptance items until reviewed and demonstrated.
- Cash funding, external payments and scientific truth require evidence outside
  consensus. A signed assertion is labelled by its trust basis, never presented
  as a trustless external proof.

## Release sequence

Specification → signed deterministic engine → persistent SDK application →
node/restart tests → federation parity → legacy import/shadow execution →
client/indexer → production cutoff → independent validators → complete private
settlement and externally funded economy. External requirements remain tracked
throughout; technical progress must not be described as full-goal completion.

## Retrieval and reset additions, 8 October 2026

Rahul requested vector retrieval for submitted research and an operator-triggered
full database/system reset. `docs/research-retrieval.md` specifies the source-cited,
rebuildable off-chain index under C09/C10. Search never substitutes for independent
verification or a prior-art decision. C18 additionally requires a coordinated,
archived new epoch, with an isolated reset/restore rehearsal, preserving old
published commitments and validator signing history. No live reset is requested
by the instruction to build this capability.
