package federation

import (
	"bytes"
	"github.com/mr-tron/base58"
	"strings"
	"testing"

	"github.com/uain-org/uain/chain/economy"
)

func operationsFixture(t *testing.T) (Keeper, actor, actor, actor, actor) {
	k, payer, o1, g := fundingFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-ops"), 7)
	deposit := fundingCheck("FR-ops", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, o1, "funding_attest", deposit, 8)
	command(t, k, g, "funding_attest", deposit, 9)
	o2 := newActor("Operations verifier", "Independent operations operator", 1000, false, false)
	if e := put(k.Store, "member/"+o2.m.ID, o2.m); e != nil {
		t.Fatal(e)
	}
	command(t, k, o2, "identity_claim", map[string]any{}, 10)
	command(t, k, o2, "operator_claim", map[string]any{"domain": "operations-second.example"}, 10)
	command(t, k, g, "operator_attest", dnsObservation(t, k, o2.m.ID, "", 11), 11)
	command(t, k, g, "funding_observers_rotate", map[string]any{"observers": []string{o1.m.ID, o2.m.ID}, "evidence_digest": digest}, 11)
	return k, payer, o1, o2, g
}
func operationsPayload(id string) map[string]any {
	return map[string]any{"id": id, "receipt": "FR-ops", "network": "ethereum:1", "asset": "native", "escrow": "0x1111111111111111111111111111111111111111", "amount": "5", "target": "0x3333333333333333333333333333333333333333", "payee": "Independent hosting vendor", "invoice_digest": strings.Repeat("b", 64), "evidence_digest": digest}
}
func operationsObservation(id string) map[string]any {
	return map[string]any{"receipt": id, "kind": "operations", "transaction": "0x" + strings.Repeat("6", 64), "index": "0", "amount": "5", "target": "0x3333333333333333333333333333333333333333", "source": "0x1111111111111111111111111111111111111111", "block": "130", "block_hash": "0x" + strings.Repeat("7", 64), "evidence_digest": digest}
}
func TestOperationsExactReserveIndependentFinalityAndConservation(t *testing.T) {
	k, p, o1, o2, g := operationsFixture(t)
	payload := operationsPayload("OPS-1")
	rejectCommand(t, k, p, "", "operations_intent", payload, 12)
	command(t, k, g, "operations_intent", payload, 12)
	var pool economy.Pool
	_ = get(k.Store, "funding_pool/FR-ops", &pool)
	if pool.Operations.Available != "0" || pool.Operations.Reserved != "5" || pool.Operations.Paid != "0" || pool.Bounty.Available != "80" || pool.Dividend.Available != "15" {
		t.Fatal(pool)
	}
	rejectCommand(t, k, g, "", "operations_intent", payload, 13)
	rejectCommand(t, k, g, "", "operations_intent", operationsPayload("OPS-2"), 13)
	filing := bytes.Clone(k.Store.Get([]byte("operations_filing/OPS-1")))
	observe := operationsObservation("OPS-1")
	rejectCommand(t, k, g, "", "operations_attest", observe, 13)
	rejectCommand(t, k, p, "", "operations_attest", observe, 13)
	command(t, k, o1, "operations_attest", observe, 13)
	rejectCommand(t, k, o1, "", "operations_attest", observe, 14)
	_ = get(k.Store, "funding_pool/FR-ops", &pool)
	if pool.Operations.Paid != "0" {
		t.Fatal("one observer spent reserve", pool)
	}
	command(t, k, o2, "operations_attest", observe, 14)
	_ = get(k.Store, "funding_pool/FR-ops", &pool)
	if pool.Operations.Reserved != "0" || pool.Operations.Paid != "5" || pool.Funded != "101" {
		t.Fatal(pool)
	}
	if e := pool.Validate(); e != nil {
		t.Fatal(e)
	}
	liability, e := k.TreasuryLiability("ethereum:1", payload["escrow"].(string))
	if e != nil || liability.Outstanding != "96" || liability.Paid != "5" {
		t.Fatal(liability, e)
	}
	rejectCommand(t, k, o2, "", "operations_attest", observe, 15)
	if !bytes.Equal(filing, k.Store.Get([]byte("operations_filing/OPS-1"))) {
		t.Fatal("immutable original cost authorization changed")
	}
	for _, a := range []actor{p, o1, o2, g} {
		m, _ := k.Member(a.m.ID)
		if m.Credits != "0" {
			t.Fatal("operations minted credits", m)
		}
	}
}

func TestOperationsRejectsAlteredEffectsAndDuplicateForeignTransfers(t *testing.T) {
	k, _, o1, _, g := operationsFixture(t)
	p := operationsPayload("OPS-exact")
	command(t, k, g, "operations_intent", p, 12)
	original := operationsObservation("OPS-exact")
	for field, value := range map[string]any{"kind": "refund", "amount": "4", "target": "0x4444444444444444444444444444444444444444", "source": "0x5555555555555555555555555555555555555555", "block": "122", "block_hash": "bad", "index": "1", "transaction": "not-a-transaction", "evidence_digest": "bad"} {
		changed := map[string]any{}
		for key, v := range original {
			changed[key] = v
		}
		changed[field] = value
		rejectCommand(t, k, o1, "", "operations_attest", changed, 13)
	}
	ref, e := fundingReference("ethereum:1", original["transaction"].(string), "0")
	if e != nil {
		t.Fatal(e)
	}
	if e = put(k.Store, "external_transfer/"+ref, struct{ Kind, ID string }{"refund", "some-other-receipt"}); e != nil {
		t.Fatal(e)
	}
	rejectCommand(t, k, o1, "", "operations_attest", original, 13)
	if k.Store.Get([]byte("operations_quorum/OPS-exact")) != nil {
		t.Fatal("rejected observation mutated quorum")
	}
}
func TestOperationsPermanentControllersAndStaleFirstObserver(t *testing.T) {
	for _, mode := range []string{"source", "target", "target_escrow", "escrow_wallet"} {
		t.Run(mode, func(t *testing.T) {
			k, _, o1, _, g := operationsFixture(t)
			p := operationsPayload("OPS-control")
			command(t, k, g, "operations_intent", p, 12)
			prefix, network, address := "external_wallet_control", "ethereum", p["target"].(string)
			if mode == "source" {
				address = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
			}
			if mode == "target_escrow" {
				prefix, network = "treasury_escrow_control", "ethereum:1"
			}
			if mode == "escrow_wallet" {
				address = p["escrow"].(string)
			}
			if e := k.rememberFundingSourceControl(prefix, network, address, o1.m.ID); e != nil {
				t.Fatal(e)
			}
			rejectCommand(t, k, o1, "", "operations_attest", operationsObservation("OPS-control"), 13)
		})
	}
	k, _, o1, o2, g := operationsFixture(t)
	command(t, k, g, "operations_intent", operationsPayload("OPS-restart"), 12)
	observe := operationsObservation("OPS-restart")
	command(t, k, o1, "operations_attest", observe, 13)
	var q FundingQuorum
	_ = get(k.Store, "operations_quorum/OPS-restart", &q)
	restart := map[string]any{"id": "OPS-restart", "expected_effects_digest": q.EffectsDigest, "evidence_digest": digest}
	rejectCommand(t, k, g, "", "operations_review_restart", restart, 14)
	if e := k.rememberFundingSourceControl("external_wallet_control", "ethereum", observe["target"].(string), o1.m.ID); e != nil {
		t.Fatal(e)
	}
	rejectCommand(t, k, o2, "", "operations_attest", observe, 14)
	rejectCommand(t, k, o2, "", "operations_review_restart", restart, 14)
	command(t, k, g, "operations_review_restart", restart, 14)
	var fresh FundingQuorum
	_ = get(k.Store, "operations_quorum/OPS-restart", &fresh)
	if fresh.EffectsDigest != q.EffectsDigest || len(fresh.Observations) != 0 {
		t.Fatal("restart forgot frozen transfer", fresh)
	}
	changed := operationsObservation("OPS-restart")
	changed["transaction"] = "0x" + strings.Repeat("8", 64)
	rejectCommand(t, k, o2, "", "operations_attest", changed, 15)
	var pool economy.Pool
	_ = get(k.Store, "funding_pool/FR-ops", &pool)
	if pool.Operations.Reserved != "5" || pool.Operations.Paid != "0" {
		t.Fatal("restart released uncertain reserve", pool)
	}
	replacement := newActor("Replacement observer", "Replacement operations operator", 1000, false, false)
	_ = put(k.Store, "member/"+replacement.m.ID, replacement.m)
	command(t, k, replacement, "identity_claim", map[string]any{}, 15)
	command(t, k, replacement, "operator_claim", map[string]any{"domain": "replacement-operations.example"}, 15)
	command(t, k, g, "operator_attest", dnsObservation(t, k, replacement.m.ID, "", 16), 16)
	command(t, k, g, "funding_observers_rotate", map[string]any{"observers": []string{o2.m.ID, replacement.m.ID}, "evidence_digest": digest}, 16)
	command(t, k, o2, "operations_attest", observe, 17)
	command(t, k, replacement, "operations_attest", observe, 18)
	_ = get(k.Store, "funding_pool/FR-ops", &pool)
	if pool.Operations.Paid != "5" {
		t.Fatal(pool)
	}
	rows, e := k.Store.Range([]byte("operations_review_archive/"), []byte("operations_review_archive0"), 10)
	if e != nil || len(rows) != 1 {
		t.Fatal(rows, e)
	}
}
func TestOperationsOptionalMemberFreezesExactOwnedWallet(t *testing.T) {
	k, p, o1, o2, g := operationsFixture(t)
	payload := operationsPayload("OPS-member")
	payload["member"] = p.m.ID
	rejectCommand(t, k, g, "", "operations_intent", payload, 12)
	payload["target"] = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
	command(t, k, g, "operations_intent", payload, 12)
	var intent OperationsIntent
	_ = get(k.Store, "operations_intent/OPS-member", &intent)
	if intent.WalletBinding == "" {
		t.Fatal(intent)
	}
	command(t, k, p, "external_wallet_unbind", map[string]any{"network": "ethereum", "binding": intent.WalletBinding}, 13)
	observe := operationsObservation("OPS-member")
	observe["target"] = payload["target"]
	command(t, k, o1, "operations_attest", observe, 14)
	command(t, k, o2, "operations_attest", observe, 15)
}

func TestOperationsReviewTimeoutAndDomainChangesPreserveEffect(t *testing.T) {
	for _, mode := range []string{"timeout", "domain"} {
		t.Run(mode, func(t *testing.T) {
			k, _, o1, _, g := operationsFixture(t)
			command(t, k, g, "operations_intent", operationsPayload("OPS-time"), 12)
			command(t, k, o1, "operations_attest", operationsObservation("OPS-time"), 13)
			var q FundingQuorum
			_ = get(k.Store, "operations_quorum/OPS-time", &q)
			payload := map[string]any{"id": "OPS-time", "expected_effects_digest": q.EffectsDigest, "evidence_digest": digest}
			height := int64(733)
			if mode == "timeout" {
				rejectCommand(t, k, g, "", "operations_review_restart", payload, height-1)
			} else {
				height = 14
				var proof OperatorProof
				_ = get(k.Store, "operator_proof/"+o1.m.ID+"/", &proof)
				proof.Domain = "changed-operations.example"
				_ = put(k.Store, "operator_proof/"+o1.m.ID+"/", proof)
			}
			command(t, k, g, "operations_review_restart", payload, height)
			rejectCommand(t, k, g, "", "operations_review_restart", payload, height+1)
			var fresh FundingQuorum
			_ = get(k.Store, "operations_quorum/OPS-time", &fresh)
			if fresh.EffectsDigest != q.EffectsDigest || len(fresh.Observations) != 0 {
				t.Fatal(fresh)
			}
		})
	}
}

func TestOperationsSupportedCurrenciesAndBankBinding(t *testing.T) {
	for _, network := range []string{"ethereum:8453", "solana:mainnet", "fiat:USD", "fiat:EUR"} {
		t.Run(network, func(t *testing.T) {
			k, p, o1, o2, g := operationsFixture(t)
			payload := operationsPayload("OPS-currency")
			observe := operationsObservation("OPS-currency")
			var campaign FundingCampaign
			_ = get(k.Store, "funding_campaign/FC-1", &campaign)
			var receipt FundingReceipt
			_ = get(k.Store, "funding_receipt/FR-ops", &receipt)
			var escrow TreasuryEscrowControl
			_ = get(k.Store, "treasury_escrow/ethereum:1/"+campaign.Escrow, &escrow)
			campaign.Network = network
			escrow.Network = network
			if network == "solana:mainnet" {
				campaign.Escrow = base58.Encode(bytes.Repeat([]byte{1}, 32))
				receipt.Source = base58.Encode(bytes.Repeat([]byte{2}, 32))
				payload["target"] = base58.Encode(bytes.Repeat([]byte{3}, 32))
				observe["transaction"] = base58.Encode(bytes.Repeat([]byte{6}, 64))
				observe["block_hash"] = base58.Encode(bytes.Repeat([]byte{7}, 32))
			}
			if strings.HasPrefix(network, "fiat:") {
				campaign.Escrow = strings.Repeat("b", 64)
				receipt.Source = strings.Repeat("c", 64)
				payload["target"] = strings.Repeat("d", 64)
				observe["transaction"] = strings.Repeat("6", 64)
				observe["block_hash"] = strings.Repeat("7", 64)
				payload["member"] = p.m.ID
				bank := FiatBeneficiary{ID: "operations-bank", Member: p.m.ID, Network: network, AccountDigest: payload["target"].(string), EvidenceDigest: digest, Height: 1}
				_ = put(k.Store, "fiat_beneficiary_proof/"+bank.ID, bank)
				_ = put(k.Store, "fiat_beneficiary_current/"+p.m.ID+"/"+network, bank.ID)
			}
			escrow.Address = campaign.Escrow
			payload["network"] = network
			payload["escrow"] = campaign.Escrow
			observe["source"] = campaign.Escrow
			observe["target"] = payload["target"]
			_ = put(k.Store, "funding_campaign/FC-1", campaign)
			_ = put(k.Store, "funding_receipt/FR-ops", receipt)
			_ = put(k.Store, "treasury_escrow/"+network+"/"+campaign.Escrow, escrow)
			_ = put(k.Store, "treasury_liability/"+network+"/"+campaign.Escrow, TreasuryLiability{network, campaign.Escrow, "101", "0", "0", "101"})
			command(t, k, g, "operations_intent", payload, 12)
			if strings.HasPrefix(network, "fiat:") {
				command(t, k, p, "fiat_beneficiary_unbind", map[string]any{"beneficiary": "operations-bank"}, 13)
			}
			command(t, k, o1, "operations_attest", observe, 14)
			command(t, k, o2, "operations_attest", observe, 15)
			liability, e := k.TreasuryLiability(network, campaign.Escrow)
			if e != nil || liability.Outstanding != "96" || liability.Paid != "5" {
				t.Fatal(liability, e)
			}
		})
	}
}

func TestOperationsNativeSolanaKeyCannotObserveOwnPayee(t *testing.T) {
	k, _, o1, _, g := operationsFixture(t)
	network := "solana:mainnet"
	payload := operationsPayload("OPS-sol-key")
	observe := operationsObservation("OPS-sol-key")
	var campaign FundingCampaign
	_ = get(k.Store, "funding_campaign/FC-1", &campaign)
	oldEscrow := campaign.Escrow
	campaign.Network = network
	campaign.Escrow = base58.Encode(bytes.Repeat([]byte{1}, 32))
	var receipt FundingReceipt
	_ = get(k.Store, "funding_receipt/FR-ops", &receipt)
	receipt.Source = base58.Encode(bytes.Repeat([]byte{2}, 32))
	var escrow TreasuryEscrowControl
	_ = get(k.Store, "treasury_escrow/ethereum:1/"+oldEscrow, &escrow)
	escrow.Network = network
	escrow.Address = campaign.Escrow
	payload["network"] = network
	payload["escrow"] = campaign.Escrow
	payload["target"] = base58PublicKey(o1.m.PublicKey)
	observe["source"] = campaign.Escrow
	observe["target"] = payload["target"]
	observe["transaction"] = base58.Encode(bytes.Repeat([]byte{6}, 64))
	observe["block_hash"] = base58.Encode(bytes.Repeat([]byte{7}, 32))
	_ = put(k.Store, "funding_campaign/FC-1", campaign)
	_ = put(k.Store, "funding_receipt/FR-ops", receipt)
	_ = put(k.Store, "treasury_escrow/"+network+"/"+campaign.Escrow, escrow)
	_ = put(k.Store, "treasury_liability/"+network+"/"+campaign.Escrow, TreasuryLiability{network, campaign.Escrow, "101", "0", "0", "101"})
	command(t, k, g, "operations_intent", payload, 12)
	rejectCommand(t, k, o1, "", "operations_attest", observe, 13)
}
