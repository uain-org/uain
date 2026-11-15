package federation

import (
	"encoding/json"
	"strings"
	"testing"
)

func externalBountyFixture(t *testing.T) (Keeper, actor, actor, actor) {
	return externalBountyFixtureWithFamily(t, false)
}
func externalBountyFixtureWithFamily(t *testing.T, commonFamily bool) (Keeper, actor, actor, actor) {
	t.Helper()
	k, lead, peer, guardian := fundingFixtureWithFamily(t, commonFamily)
	command(t, k, lead, "funding_file", fundingDeposit("FR-1"), 7)
	d := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, peer, "funding_attest", d, 8)
	command(t, k, guardian, "funding_attest", d, 9)
	command(t, k, guardian, "allocate_budget", map[string]any{"project": "PF-1", "credits": "1000", "evidence_digest": digest}, 10)
	task := Task{ID: "FT-1", Project: "PF-1", Title: "Resolve a new bounded question", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 13, CreditReward: "13", VerifiersRequired: 2}
	command(t, k, lead, "open_task", task, 11)
	command(t, k, lead, "external_bounty_quote", map[string]any{"task": "FT-1", "receipt": "FR-1", "amount": "70", "evidence_digest": digest}, 12)
	return k, lead, peer, guardian
}
func finishExternalWork(t *testing.T, k Keeper, lead, peer, guardian actor, start int64) {
	t.Helper()
	command(t, k, lead, "submit", map[string]any{"id": "FW-1", "task": "FT-1", "evidence_digest": digest}, start)
	p := map[string]any{"contribution": "FW-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	command(t, k, peer, "verify", p, start+1)
	command(t, k, guardian, "verify", p, start+2)
}
func externalPayoutCheck() map[string]any {
	return map[string]any{"intent": "EP-1", "transaction": "0x" + strings.Repeat("9", 64), "index": "0", "amount": "70", "target": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", "source": "0x1111111111111111111111111111111111111111", "block": "140", "block_hash": "0x" + strings.Repeat("7", 64), "evidence_digest": digest}
}

// Catches paying incomplete/known research, changing a quoted amount/recipient,
// duplicate external transfers, and paying before independent finality.
func TestExternalBountyVerifiedWinnerFrozenWalletAndExactlyOnceFinality(t *testing.T) {
	k, lead, peer, guardian := externalBountyFixture(t)
	intent := map[string]any{"id": "EP-1", "contribution": "FW-1", "evidence_digest": digest}
	rejectCommand(t, k, lead, "", "external_bounty_intent", intent, 13)
	finishExternalWork(t, k, lead, peer, guardian, 14)
	rejectCommand(t, k, peer, "", "external_bounty_intent", intent, 17)
	command(t, k, lead, "external_bounty_intent", intent, 17)
	var current struct{ Binding string }
	_ = get(k.Store, "external_wallet/"+lead.m.ID+"/ethereum", &current)
	// Replacement cannot redirect an already member-authorized transfer.
	command(t, k, lead, "external_wallet_unbind", map[string]any{"network": "ethereum", "binding": current.Binding}, 18)
	p := externalPayoutCheck()
	bad := map[string]any{}
	for a, b := range p {
		bad[a] = b
	}
	bad["amount"] = "71"
	rejectCommand(t, k, peer, "", "external_bounty_attest", bad, 19)
	command(t, k, peer, "external_bounty_attest", p, 19)
	var pool struct {
		Bounty struct{ Available, Reserved, Paid string }
	}
	_ = json.Unmarshal(k.Store.Get([]byte("funding_pool/FR-1")), &pool)
	if pool.Bounty.Reserved != "70" || pool.Bounty.Paid != "0" {
		t.Fatal("paid before finality", pool)
	}
	command(t, k, guardian, "external_bounty_attest", p, 20)
	_ = json.Unmarshal(k.Store.Get([]byte("funding_pool/FR-1")), &pool)
	if pool.Bounty.Available != "10" || pool.Bounty.Reserved != "0" || pool.Bounty.Paid != "70" {
		t.Fatal("incorrect settlement", pool)
	}
	rejectCommand(t, k, guardian, "", "external_bounty_attest", p, 21)
	rejectCommand(t, k, lead, "", "external_bounty_intent", map[string]any{"id": "EP-2", "contribution": "FW-1", "evidence_digest": digest}, 21)
	rejectCommand(t, k, lead, "", "funding_refund", map[string]any{"receipt": "FR-1", "evidence_digest": digest}, 21)
}
func TestExternalBountyQuoteCannotChangeAfterSubmissionAndUnstartedRelease(t *testing.T) {
	k, lead, peer, guardian := externalBountyFixture(t)
	release := map[string]any{"task": "FT-1", "evidence_digest": digest}
	command(t, k, lead, "external_bounty_release", release, 14)
	rejectCommand(t, k, lead, "", "external_bounty_release", release, 15)
	rejectCommand(t, k, lead, "", "external_bounty_quote", map[string]any{"task": "FT-1", "receipt": "FR-1", "amount": "70", "evidence_digest": digest}, 15)
	finishExternalWork(t, k, lead, peer, guardian, 16)
	rejectCommand(t, k, lead, "", "external_bounty_intent", map[string]any{"id": "EP-1", "contribution": "FW-1", "evidence_digest": digest}, 19)
}

func TestExternalBountyReleasesPermanentlyDiscountedWinner(t *testing.T) {
	k, lead, peer, guardian := externalBountyFixtureWithFamily(t, true)
	// Same-family independent verifiers yield a genuinely settled discounted
	// credit winner, which is permanently ineligible for the full external bounty.

	finishExternalWork(t, k, lead, peer, guardian, 14)
	rejectCommand(t, k, lead, "", "external_bounty_intent", map[string]any{"id": "EP-1", "contribution": "FW-1", "evidence_digest": digest}, 17)
	command(t, k, guardian, "external_bounty_release", map[string]any{"task": "FT-1", "evidence_digest": digest}, 17)
	var pool struct {
		Bounty struct{ Available, Reserved string }
	}
	_ = json.Unmarshal(k.Store.Get([]byte("funding_pool/FR-1")), &pool)
	if pool.Bounty.Available != "80" || pool.Bounty.Reserved != "0" {
		t.Fatal("unpayable bounty remained locked", pool)
	}
}
