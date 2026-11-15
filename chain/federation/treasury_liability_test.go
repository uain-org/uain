package federation

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTreasuryLiabilityCreditsOnlyConfirmedDistinctDeposits(t *testing.T) {
	k, payer, first, second := fundingFixture(t)
	escrow := "0x1111111111111111111111111111111111111111"
	command(t, k, payer, "funding_file", fundingDeposit("FR-liability-a"), 7)
	check := fundingCheck("FR-liability-a", "deposit", "0x"+strings.Repeat("2", 64), "101", escrow)
	command(t, k, first, "funding_attest", check, 8)
	if k.Store.Get([]byte("treasury_liability/ethereum:1/"+escrow)) != nil {
		t.Fatal("unconfirmed funds became a treasury liability")
	}
	command(t, k, second, "funding_attest", check, 9)
	want := func(funded, paid, refunded, outstanding string) {
		t.Helper()
		got, e := k.TreasuryLiability("ethereum:1", escrow)
		if e != nil || got.Funded != funded || got.Paid != paid || got.Refunded != refunded || got.Outstanding != outstanding {
			t.Fatalf("liability %+v err=%v", got, e)
		}
	}
	want("101", "0", "0", "101")
	deposit := fundingDeposit("FR-liability-b")
	deposit["transaction"] = "0x" + strings.Repeat("7", 64)
	deposit["amount"] = "202"
	command(t, k, payer, "funding_file", deposit, 10)
	check = fundingCheck("FR-liability-b", "deposit", deposit["transaction"].(string), "202", escrow)
	command(t, k, first, "funding_attest", check, 11)
	command(t, k, second, "funding_attest", check, 12)
	want("303", "0", "0", "303")
	command(t, k, payer, "funding_refund", map[string]any{"receipt": "FR-liability-a", "evidence_digest": digest}, 13)
	want("303", "0", "0", "303")
	check = fundingCheck("FR-liability-a", "refund", "0x"+strings.Repeat("8", 64), "101", "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")
	command(t, k, first, "funding_attest", check, 14)
	want("303", "0", "0", "303")
	command(t, k, second, "funding_attest", check, 15)
	want("303", "0", "101", "202")
}

func TestTreasuryLiabilityConservationDeduplicationAndAssetBounds(t *testing.T) {
	k, _, _, _ := fundingFixture(t)
	campaign := FundingCampaign{Network: "solana:mainnet", Escrow: solanaAddressForTest()}
	receipt := FundingReceipt{ID: "liability-deposit", Amount: "100"}
	if e := k.creditTreasuryLiability(campaign, receipt); e != nil {
		t.Fatal(e)
	}
	before := string(k.Store.Get([]byte("treasury_liability/" + campaign.Network + "/" + campaign.Escrow)))
	if e := k.creditTreasuryLiability(campaign, receipt); e == nil {
		t.Fatal("duplicate deposit credited")
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "101", "payout", "overdraw"); e == nil {
		t.Fatal("treasury overdraw accepted")
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "1", "unknown", "kind"); e == nil {
		t.Fatal("unknown liability debit accepted")
	}
	if string(k.Store.Get([]byte("treasury_liability/"+campaign.Network+"/"+campaign.Escrow))) != before {
		t.Fatal("refused effect changed balance")
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "60", "payout", "work-1"); e != nil {
		t.Fatal(e)
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "60", "payout", "work-1"); e == nil {
		t.Fatal("duplicate payment debited")
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "20", "dividend", "withdrawal-1"); e != nil {
		t.Fatal(e)
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "5", "operations", "operation-1"); e != nil {
		t.Fatal(e)
	}
	if e := k.debitTreasuryLiability(campaign.Network, campaign.Escrow, "15", "refund", "refund-1"); e != nil {
		t.Fatal(e)
	}
	got, e := k.TreasuryLiability(campaign.Network, campaign.Escrow)
	if e != nil || got.Outstanding != "0" || got.Paid != "85" || got.Refunded != "15" {
		t.Fatal(got, e)
	}
	raw, _ := json.Marshal(TreasuryLiability{Network: campaign.Network, Escrow: campaign.Escrow, Funded: "100", Paid: "85", Refunded: "15", Outstanding: "1"})
	k.Store.Set([]byte("treasury_liability/"+campaign.Network+"/"+campaign.Escrow), raw)
	if _, e = k.TreasuryLiability(campaign.Network, campaign.Escrow); e == nil {
		t.Fatal("corrupt conservation record accepted")
	}
	for _, item := range []struct{ network, amount string }{{"solana:mainnet", "18446744073709551616"}, {"ethereum:1", "115792089237316195423570985008687907853269984665640564039457584007913129639936"}, {"fiat:CHF", "1"}} {
		if fundingAssetAmount(item.network, item.amount) == nil {
			t.Fatalf("unsupported asset amount accepted %+v", item)
		}
	}
}
func solanaAddressForTest() string { return "9oTb3dYY4GNyAdwSRvJHKoJ1UzuRYC1Dk1ebf6r6Ceb" }
