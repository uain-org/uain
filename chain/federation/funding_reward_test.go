package federation

import (
	"github.com/uain-org/uain/chain/coin"
	"strings"
	"testing"
)

// The unit fixture supplies a previously activated Coin ledger. Actual Coin
// activation, linked proof availability and SDK restart are covered separately.
func fundingRewardFixture(t *testing.T) (Keeper, actor, actor, actor) {
	t.Helper()
	k, payer, peer, guardian := fundingFixture(t)
	if e := put(k.Store, "coin_activation", CoinActivation{CoinPolicy, 7, digest}); e != nil {
		t.Fatal(e)
	}
	if e := put(k.Store, "coin_supply", coin.Empty()); e != nil {
		t.Fatal(e)
	}
	return k, payer, peer, guardian
}
func fundingRewardSchedule() map[string]any {
	return map[string]any{"campaign": "FC-1", "policy": "verified-funding-bounties-v1", "funding_amount": "101", "coin_units": "5000000", "karma": "13", "max_claims": 2, "first_external_block": "100", "evidence_digest": digest}
}
func TestFundingRewardRequiresProspectiveGuardianBudgetAndVerifiedReceipt(t *testing.T) {
	k, payer, peer, guardian := fundingRewardFixture(t)
	rejectCommand(t, k, payer, "", "funding_reward_schedule", fundingRewardSchedule(), 7)
	command(t, k, guardian, "funding_reward_schedule", fundingRewardSchedule(), 7)
	ledger, e := k.coinLedger()
	if e != nil || ledger.Minted != "0" || ledger.Reserved != "10000000" {
		t.Fatal(ledger, e)
	}
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 8)
	claim := map[string]any{"receipt": "FR-1"}
	rejectCommand(t, k, payer, "", "funding_reward_claim", claim, 9)
	deposit := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, peer, "funding_attest", deposit, 9)
	command(t, k, guardian, "funding_attest", deposit, 10)
	rejectCommand(t, k, peer, "", "funding_reward_claim", claim, 11)
	before, _ := k.Member(payer.m.ID)
	command(t, k, payer, "funding_reward_claim", claim, 11)
	after, _ := k.Member(payer.m.ID)
	if after.Karma-before.Karma != 13 || after.Credits != before.Credits {
		t.Fatal("funding confused Karma, Coin and legacy credits", before, after)
	}
	ledger, e = k.coinLedger()
	if e != nil || ledger.Minted != "5000000" || ledger.Reserved != "5000000" || ledger.Transparent != "5000000" {
		t.Fatal(ledger, e)
	}
	rejectCommand(t, k, payer, "", "funding_reward_claim", claim, 12)
	rejectCommand(t, k, payer, "", "funding_refund", map[string]any{"receipt": "FR-1", "evidence_digest": digest}, 12)
	rejectCommand(t, k, guardian, "", "funding_reward_schedule", fundingRewardSchedule(), 12)
}
func TestFundingRewardScheduleRefusesRetroactiveAndUnfundedMint(t *testing.T) {
	k, payer, _, guardian := fundingRewardFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 7)
	rejectCommand(t, k, guardian, "", "funding_reward_schedule", fundingRewardSchedule(), 8)
	rejectCommand(t, k, payer, "", "funding_reward_claim", map[string]any{"receipt": "FR-1"}, 9)
	ledger, e := k.coinLedger()
	if e != nil || ledger.Minted != "0" || ledger.Reserved != "0" {
		t.Fatal(ledger, e)
	}
}

func TestFundingRewardRefundAndForfeitReleaseOnlyUnearnedReservations(t *testing.T) {
	k, payer, peer, guardian := fundingRewardFixture(t)
	command(t, k, guardian, "funding_reward_schedule", fundingRewardSchedule(), 7)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 8)
	forfeit := map[string]any{"receipt": "FR-1", "evidence_digest": digest}
	rejectCommand(t, k, peer, "", "funding_reward_forfeit", forfeit, 9)
	command(t, k, payer, "funding_reward_forfeit", forfeit, 9)
	rejectCommand(t, k, payer, "", "funding_reward_forfeit", forfeit, 10)
	deposit := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, peer, "funding_attest", deposit, 11)
	command(t, k, guardian, "funding_attest", deposit, 12)
	rejectCommand(t, k, payer, "", "funding_reward_claim", map[string]any{"receipt": "FR-1"}, 13)
	command(t, k, payer, "funding_refund", forfeit, 13)
	ledger, e := k.coinLedger()
	if e != nil || ledger.Minted != "0" || ledger.Reserved != "5000000" {
		t.Fatal(ledger, e)
	}
	command(t, k, guardian, "funding_reward_release", map[string]any{"campaign": "FC-1", "evidence_digest": digest}, 14)
	ledger, e = k.coinLedger()
	if e != nil || ledger.Minted != "0" || ledger.Reserved != "0" {
		t.Fatal(ledger, e)
	}
	rejectCommand(t, k, guardian, "", "funding_reward_release", map[string]any{"campaign": "FC-1", "evidence_digest": digest}, 15)
}
