package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func fundingFixture(t *testing.T) (Keeper, actor, actor, actor) {
	return fundingFixtureWithFamily(t, false)
}
func fundingFixtureWithFamily(t *testing.T, commonFamily bool) (Keeper, actor, actor, actor) {
	t.Helper()
	k, payer, observer, guardian := fixture(t)
	if commonFamily {
		for _, a := range []*actor{&payer, &observer, &guardian} {
			a.m.Family = "Claude"
			if e := put(k.Store, "member/"+a.m.ID, a.m); e != nil {
				t.Fatal(e)
			}
		}
	}
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, guardian, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	command(t, k, guardian, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 2)
	for i, a := range []actor{payer, observer, guardian} {
		command(t, k, a, "identity_claim", map[string]any{}, 3)
		command(t, k, a, "operator_claim", map[string]any{"domain": fmt.Sprintf("funding-%d.example", i)}, 3)
		command(t, k, guardian, "operator_attest", dnsObservation(t, k, a.m.ID, "", 4), 4)
	}
	command(t, k, guardian, "activate_funding", map[string]any{"policy": "external-receipts-80-15-5-v1", "evidence_digest": digest, "observers": []string{observer.m.ID, guardian.m.ID}}, 5)
	command(t, k, payer, "open_project", map[string]any{"id": "PF-1", "title": "Fund an unresolved research question", "class": "benevolent", "prior_art": prior}, 6)
	fixtureTreasuryEscrow(t, k, payer, guardian, "ethereum:1", "0x1111111111111111111111111111111111111111")
	command(t, k, payer, "funding_campaign", map[string]any{"id": "FC-1", "project": "PF-1", "network": "ethereum:1", "asset": "native", "escrow": "0x1111111111111111111111111111111111111111", "decimals": 18, "evidence_digest": digest}, 6)
	command(t, k, observer, "project_join", map[string]any{"project": "PF-1"}, 6)
	command(t, k, guardian, "project_join", map[string]any{"project": "PF-1"}, 6)
	command(t, k, payer, "external_wallet_bind", evmWalletPayload(k, payer, 6), 6)
	return k, payer, observer, guardian
}
func fundingDeposit(id string) map[string]any {
	return map[string]any{"id": id, "campaign": "FC-1", "amount": "101", "transaction": "0x" + strings.Repeat("2", 64), "index": "0", "source": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "block": "123", "block_hash": "0x" + strings.Repeat("4", 64), "evidence_digest": digest}
}
func fundingCheck(id, kind, transaction, amount, target string) map[string]any {
	source := "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
	if kind == "refund" {
		source = "0x1111111111111111111111111111111111111111"
	}
	block, blockHash := "123", "0x"+strings.Repeat("4", 64)
	if kind == "refund" {
		block = "130"
		blockHash = "0x" + strings.Repeat("5", 64)
	}
	return map[string]any{"receipt": id, "kind": kind, "transaction": transaction, "index": "0", "amount": amount, "target": target, "source": source, "block": block, "block_hash": blockHash, "evidence_digest": digest}
}

// Catches allocating unverified external money, duplicate external transaction
// filing under a new local ID, self/same-operator approval, and double approval.
func TestFundingReceiptIndependentFinalityAndExactSplit(t *testing.T) {
	k, payer, observer, guardian := fundingFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 7)
	if k.Store.Get([]byte("funding_pool/FR-1")) != nil {
		t.Fatal("unverified funding allocated")
	}
	rejectCommand(t, k, payer, "", "funding_file", fundingDeposit("FR-2"), 7)
	p := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	rejectCommand(t, k, payer, "", "funding_attest", p, 8)
	command(t, k, observer, "funding_attest", p, 8)
	if k.Store.Get([]byte("funding_pool/FR-1")) != nil {
		t.Fatal("one observer allocated funds")
	}
	rejectCommand(t, k, observer, "", "funding_attest", p, 8)
	command(t, k, guardian, "funding_attest", p, 9)
	var pool struct {
		Bounty     struct{ Available string }
		Dividend   struct{ Available string }
		Operations struct{ Available string }
		Dust       string
	}
	if err := json.Unmarshal(k.Store.Get([]byte("funding_pool/FR-1")), &pool); err != nil {
		t.Fatal(err)
	}
	if pool.Bounty.Available != "80" || pool.Dividend.Available != "15" || pool.Operations.Available != "5" || pool.Dust != "1" {
		t.Fatalf("wrong split %+v", pool)
	}
	rejectCommand(t, k, guardian, "", "funding_attest", p, 10)
}

// Catches third-party refunds, redirecting money, refund finality replay and
// making money spendable while a refund is in flight.
func TestFundingRefundLocksOriginalReceiptAndReturnsExactSource(t *testing.T) {
	k, payer, observer, guardian := fundingFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 7)
	d := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, observer, "funding_attest", d, 8)
	command(t, k, guardian, "funding_attest", d, 9)
	request := map[string]any{"receipt": "FR-1", "evidence_digest": digest}
	rejectCommand(t, k, observer, "", "funding_refund", request, 10)
	command(t, k, payer, "funding_refund", request, 10)
	wrong := fundingCheck("FR-1", "refund", "0x"+strings.Repeat("6", 64), "101", "0x7777777777777777777777777777777777777777")
	rejectCommand(t, k, observer, "", "funding_attest", wrong, 11)
	refund := fundingCheck("FR-1", "refund", "0x"+strings.Repeat("6", 64), "101", "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")
	command(t, k, observer, "funding_attest", refund, 11)
	command(t, k, guardian, "funding_attest", refund, 12)
	var pool struct{ Refunded string }
	if err := json.Unmarshal(k.Store.Get([]byte("funding_pool/FR-1")), &pool); err != nil || pool.Refunded != "101" {
		t.Fatal(pool, err)
	}
	rejectCommand(t, k, payer, "", "funding_refund", request, 13)
	before := bytes.Clone(k.Store.Get([]byte("funding_pool/FR-1")))
	rejectCommand(t, k, guardian, "", "funding_attest", refund, 13)
	if !bytes.Equal(before, k.Store.Get([]byte("funding_pool/FR-1"))) {
		t.Fatal("replay mutated pool")
	}
}

func TestFundingUnfundedCHFAndMismatchedAttestationsRefused(t *testing.T) {
	k, payer, observer, guardian := fundingFixture(t)
	rejectCommand(t, k, payer, "", "funding_campaign", map[string]any{"id": "CHF", "project": "PF-1", "network": "fiat:CHF", "asset": "native", "escrow": digest, "decimals": 2, "evidence_digest": digest}, 7)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 7)
	p := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, observer, "funding_attest", p, 8)
	p["amount"] = "102"
	rejectCommand(t, k, guardian, "", "funding_attest", p, 9)
	p["amount"] = "101"
	p["block_hash"] = "0x" + strings.Repeat("8", 64)
	rejectCommand(t, k, guardian, "", "funding_attest", p, 9)
	p["block_hash"] = "0x" + strings.Repeat("5", 64)
	// An operator may not change its declaration to bypass the observer pair.
	m, _ := k.Member(guardian.m.ID)
	m.Operator = observer.m.Operator
	_ = put(k.Store, "member/"+m.ID, m)
	// Proven distinct domains still count: change the actual proof, not its label.
	var proof OperatorProof
	_ = get(k.Store, "operator_proof/"+operatorActorKey(guardian.m.ID, ""), &proof)
	proof.Domain = "funding-1.example"
	_ = put(k.Store, "operator_proof/"+operatorActorKey(guardian.m.ID, ""), proof)
	rejectCommand(t, k, guardian, "", "funding_attest", p, 9)
}

func TestFundingRejectsClaimedUnownedSourceAndNativeIndexAlias(t *testing.T) {
	k, payer, _, _ := fundingFixture(t)
	input := fundingDeposit("FR-bad-source")
	input["source"] = "0x3333333333333333333333333333333333333333"
	rejectCommand(t, k, payer, "", "funding_file", input, 7)
	input = fundingDeposit("FR-index-alias")
	input["index"] = "1"
	rejectCommand(t, k, payer, "", "funding_file", input, 7)
}

// A later finalized head does not prove the filed transaction was included at
// the prospective reward checkpoint. The observers must bind actual inclusion.
func TestFundingRejectsDifferentOriginalInclusionCheckpoint(t *testing.T) {
	k, payer, observer, _ := fundingFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-checkpoint"), 7)
	p := fundingCheck("FR-checkpoint", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	p["block"] = "130"
	p["block_hash"] = "0x" + strings.Repeat("5", 64)
	rejectCommand(t, k, observer, "", "funding_attest", p, 8)
	p["block"] = "123"
	rejectCommand(t, k, observer, "", "funding_attest", p, 8)
	p["block_hash"] = "0x" + strings.Repeat("4", 64)
	p["source"] = "0x3333333333333333333333333333333333333333"
	rejectCommand(t, k, observer, "", "funding_attest", p, 8)
}

// A cached consensus proof is injected only for unrelated arithmetic tests;
// treasury_control_test and SDK/network tests exercise real control signatures.
func fixtureTreasuryEscrow(t *testing.T, k Keeper, controller, guardian actor, network, address string) {
	t.Helper()
	proof := TreasuryEscrowControl{Policy: TreasuryEscrowPolicy, Network: network, Address: address, Controller: controller.m.ID, Height: 1, ExpiresHeight: 100, Guardian: guardian.m.ID, ApprovedHeight: 2, EvidenceDigest: digest, ApprovalEvidence: digest}
	if e := put(k.Store, treasuryEscrowKey("treasury_escrow", network, address), proof); e != nil {
		t.Fatal(e)
	}
}
