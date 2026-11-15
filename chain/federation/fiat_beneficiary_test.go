package federation

import (
	"strings"
	"testing"
)

func TestFiatBeneficiaryRequiresIndependentOwnershipAndPreservesIntentBinding(t *testing.T) {
	k, member, peer, guardian := fundingFixture(t)
	request := map[string]any{"id": "FB-1", "network": "fiat:USD", "account_digest": strings.Repeat("a", 64), "evidence_digest": digest}
	command(t, k, member, "fiat_beneficiary_bind", request, 7)
	if _, e := k.FiatBeneficiary(member.m.ID, "fiat:USD"); e == nil {
		t.Fatal("unverified bank account accepted")
	}
	approval := map[string]any{"beneficiary": "FB-1", "account_digest": strings.Repeat("a", 64), "evidence_digest": digest}
	rejectCommand(t, k, member, "", "fiat_beneficiary_attest", approval, 8)
	command(t, k, peer, "fiat_beneficiary_attest", approval, 8)
	if _, e := k.FiatBeneficiary(member.m.ID, "fiat:USD"); e == nil {
		t.Fatal("one bank observer accepted")
	}
	command(t, k, guardian, "fiat_beneficiary_attest", approval, 9)
	binding, e := k.FiatBeneficiary(member.m.ID, "fiat:USD")
	if e != nil || binding.ID != "FB-1" {
		t.Fatal(binding, e)
	}
	rejectCommand(t, k, guardian, "", "fiat_beneficiary_attest", approval, 10)
	command(t, k, member, "fiat_beneficiary_unbind", map[string]any{"beneficiary": "FB-1"}, 10)
	if _, e := k.FiatBeneficiary(member.m.ID, "fiat:USD"); e == nil {
		t.Fatal("unbound beneficiary accepted")
	}
	if k.Store.Get([]byte("fiat_beneficiary_proof/FB-1")) == nil || k.Store.Get([]byte("fiat_beneficiary_end/FB-1")) == nil {
		t.Fatal("bank ownership history lost")
	}
}

func TestFiatBountyLocksCommitmentAndRequiresBankTransferFinality(t *testing.T) {
	k, member, peer, guardian := fundingFixture(t)
	account := strings.Repeat("a", 64)
	escrow := strings.Repeat("b", 64)
	fixtureTreasuryEscrow(t, k, member, guardian, "fiat:USD", escrow)
	command(t, k, member, "funding_campaign", map[string]any{"id": "FC-USD", "project": "PF-1", "network": "fiat:USD", "asset": "native", "escrow": escrow, "decimals": 2, "evidence_digest": digest}, 7)
	command(t, k, member, "fiat_beneficiary_bind", map[string]any{"id": "FB-USD", "network": "fiat:USD", "account_digest": account, "evidence_digest": digest}, 7)
	approval := map[string]any{"beneficiary": "FB-USD", "account_digest": account, "evidence_digest": digest}
	command(t, k, peer, "fiat_beneficiary_attest", approval, 8)
	command(t, k, guardian, "fiat_beneficiary_attest", approval, 9)
	command(t, k, member, "funding_file", map[string]any{"id": "FR-USD", "campaign": "FC-USD", "amount": "101", "transaction": strings.Repeat("2", 64), "index": "0", "source": account, "block": "123", "block_hash": strings.Repeat("4", 64), "evidence_digest": digest}, 10)
	deposit := fundingCheck("FR-USD", "deposit", strings.Repeat("2", 64), "101", escrow)
	deposit["block_hash"] = strings.Repeat("4", 64)
	deposit["source"] = account
	command(t, k, peer, "funding_attest", deposit, 11)
	command(t, k, guardian, "funding_attest", deposit, 12)
	command(t, k, guardian, "allocate_budget", map[string]any{"project": "PF-1", "credits": "1000", "evidence_digest": digest}, 13)
	task := Task{ID: "FT-1", Project: "PF-1", Title: "New fiat funded research", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 13, CreditReward: "13", VerifiersRequired: 2}
	command(t, k, member, "open_task", task, 14)
	command(t, k, member, "external_bounty_quote", map[string]any{"task": "FT-1", "receipt": "FR-USD", "amount": "70", "evidence_digest": digest}, 15)
	finishExternalWork(t, k, member, peer, guardian, 16)
	command(t, k, member, "external_bounty_intent", map[string]any{"id": "EP-USD", "contribution": "FW-1", "evidence_digest": digest}, 19)
	command(t, k, member, "fiat_beneficiary_unbind", map[string]any{"beneficiary": "FB-USD"}, 20)
	payout := map[string]any{"intent": "EP-USD", "transaction": strings.Repeat("9", 64), "index": "0", "amount": "70", "target": account, "source": escrow, "block": "140", "block_hash": strings.Repeat("7", 64), "evidence_digest": digest}
	command(t, k, peer, "external_bounty_attest", payout, 21)
	command(t, k, guardian, "external_bounty_attest", payout, 22)
	var intent ExternalPayoutIntent
	if e := get(k.Store, "external_payout/EP-USD", &intent); e != nil || intent.State != "paid" || intent.Address != account || intent.WalletBinding != "fiat/FB-USD" {
		t.Fatal(intent, e)
	}
	rejectCommand(t, k, guardian, "", "external_bounty_attest", payout, 23)
}
