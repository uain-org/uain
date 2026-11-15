package federation

import (
	"fmt"
	"strings"
	"testing"
)

func TestCentralFundingScheduleBypassRejected(t *testing.T) {
	k, payer, _, g := fundingRewardFixture(t)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 7)
	command(t, k, payer, "central_project_start", map[string]any{"project": "PF-1", "manager": payer.m.ID, "evidence_digest": digest}, 8)
	rejectCommand(t, k, g, "", "funding_reward_schedule", fundingRewardSchedule(), 9)
}
func TestCentralAdoptionFundingHistoryRejected(t *testing.T) {
	k, payer, _, g := fundingRewardFixture(t)
	command(t, k, g, "funding_reward_schedule", fundingRewardSchedule(), 7)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 8)
	rejectCommand(t, k, payer, "", "central_project_start", map[string]any{"project": "PF-1", "manager": payer.m.ID, "evidence_digest": digest}, 9)
}
func TestCentralAdoptionRefusesReleasedAndPaidFundingRewards(t *testing.T) {
	for _, state := range []string{"released", "paid"} {
		t.Run(state, func(t *testing.T) {
			k, payer, peer, g := fundingRewardFixture(t)
			command(t, k, g, "funding_reward_schedule", fundingRewardSchedule(), 7)
			if state == "released" {
				command(t, k, g, "funding_reward_release", map[string]any{"campaign": "FC-1", "evidence_digest": digest}, 8)
			} else {
				command(t, k, payer, "funding_file", fundingDeposit("FR-old"), 8)
				check := fundingCheck("FR-old", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
				command(t, k, peer, "funding_attest", check, 9)
				command(t, k, g, "funding_attest", check, 10)
				command(t, k, payer, "funding_reward_claim", map[string]any{"receipt": "FR-old"}, 11)
			}
			command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 12)
			rejectCommand(t, k, payer, "", "central_project_start", map[string]any{"project": "PF-1", "manager": payer.m.ID, "evidence_digest": digest}, 13)
		})
	}
}
func TestCentralPolicyHonorsNonadoptedFundingRewardContract(t *testing.T) {
	k, payer, peer, g := fundingRewardFixture(t)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 7)
	command(t, k, g, "funding_reward_schedule", fundingRewardSchedule(), 8)
	rejectCommand(t, k, payer, "", "central_project_start", map[string]any{"project": "PF-1", "manager": payer.m.ID, "evidence_digest": digest}, 9)
	command(t, k, payer, "funding_file", fundingDeposit("FR-honored"), 10)
	check := fundingCheck("FR-honored", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, peer, "funding_attest", check, 11)
	command(t, k, g, "funding_attest", check, 12)
	command(t, k, payer, "funding_reward_claim", map[string]any{"receipt": "FR-honored"}, 13)
	l, e := k.coinLedger()
	if e != nil || l.Minted != "5000000" || l.Reserved != "5000000" {
		t.Fatal(l, e)
	}
}
func TestCentralAdoptionFundingAuditBindingAndBound(t *testing.T) {
	k, _, _, _ := centralFixture(t)
	for i := 0; i < CentralLegacyFinancialAuditLimit; i++ {
		id := fmt.Sprintf("FC-old-%03d", i)
		put(k.Store, "funding_campaign/"+id, FundingCampaign{ID: id, Project: "P-other"})
		put(k.Store, "funding_reward_schedule/"+id, FundingRewardSchedule{Campaign: id})
	}
	if e := k.centralAdoptionFinancialAudit("P-central"); e != nil {
		t.Fatal(e)
	}
	put(k.Store, "funding_reward_schedule/FC-over", FundingRewardSchedule{Campaign: "FC-over"})
	if e := k.centralAdoptionFinancialAudit("P-central"); e == nil {
		t.Fatal("truncated funding history accepted")
	}
	k, _, _, _ = centralFixture(t)
	put(k.Store, "funding_reward_schedule/FC-missing", FundingRewardSchedule{Campaign: "FC-missing"})
	if e := k.centralAdoptionFinancialAudit("P-central"); e == nil {
		t.Fatal("missing campaign accepted")
	}
}
