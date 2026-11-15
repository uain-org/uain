//go:build orchard && cgo

package federation

import (
	"fmt"
	"github.com/uain-org/uain/chain/coin"
	"strings"
	"testing"
	"time"
)

func coinFixture(t *testing.T) (Keeper, actor, actor, actor) {
	t.Helper()
	k, lead, peer, def := fixture(t)
	command(t, k, def, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, def, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	command(t, k, def, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 2)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Fictional Coin bounty fixture", "class": "benevolent", "prior_art": prior}, 3)
	join(t, k, peer, "", 3)
	join(t, k, def, "", 3)
	coinFixtureDomains(t, k, lead, peer, def)
	// Schedule both empty-pool asset policies in one block; neither admits a
	// payment before the following height, avoiding an unfunded-note race.
	command(t, k, def, "activate_private_exchange", map[string]any{"policy": PrivateExchangePolicy, "relayer": peer.m.ID, "evidence_digest": digest}, 6)
	command(t, k, def, "activate_coin", map[string]any{"policy": CoinPolicy, "evidence_digest": digest}, 6)
	return k, lead, peer, def
}

func TestCoinKnownRevokedAndExpiredBountiesNeverMint(t *testing.T) {
	for _, reason := range []string{"known", "revoked", "expired"} {
		t.Run(reason, func(t *testing.T) {
			k, lead, peer, guardian := coinFixture(t)
			quote := quoteFixtureTask(t, k, lead, "T-1", 2, reason == "expired", 7)
			command(t, k, lead, "coin_quote", quote, 8)
			allocation := map[string]any{"task": "T-1", "evidence_digest": digest}
			command(t, k, guardian, "coin_reserve", allocation, 9)
			command(t, k, lead, "submit", map[string]any{"id": "RC-T-1", "task": "T-1", "evidence_digest": digest}, 10)
			checkWork(t, k, peer, "T-1", 11)
			checkWork(t, k, guardian, "T-1", 12)
			if reason == "known" {
				command(t, k, peer, "challenge_prior_art", challengePayload("C-coin"), 13)
				rejectCommand(t, k, lead, "", "coin_claim", map[string]any{"contribution": "RC-T-1"}, 14)
				command(t, k, guardian, "decide_prior_art", challengeDecision("C-coin", "upheld"), 14)
			} else if reason == "revoked" {
				command(t, k, lead, "withdraw", map[string]any{}, 13)
			} else {
				if _, err := k.ExpireKPIs(13, time.Unix(100, 0).Add(KPIGrace)); err != nil {
					t.Fatal(err)
				}
			}
			rejectCommand(t, k, lead, "", "coin_claim", map[string]any{"contribution": "RC-T-1"}, 15)
			if reason != "revoked" {
				command(t, k, guardian, "coin_release", allocation, 15)
			}
			ledger, err := k.coinLedger()
			if err != nil || ledger.Minted != "0" || ledger.Transparent != "0" || ledger.Shielded != "0" {
				t.Fatal("ineligible work minted", ledger, err)
			}
		})
	}
}

func TestCoinFutureBountyMintsOnlyAfterConfirmedKPI(t *testing.T) {
	k, lead, peer, guardian := coinFixture(t)
	quote := quoteFixtureTask(t, k, lead, "T-1", 2, true, 7)
	command(t, k, lead, "coin_quote", quote, 8)
	allocation := map[string]any{"task": "T-1", "evidence_digest": digest}
	command(t, k, guardian, "coin_reserve", allocation, 9)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-1", "task": "T-1", "evidence_digest": digest}, 10)
	checkWork(t, k, peer, "T-1", 11)
	checkWork(t, k, guardian, "T-1", 12)
	rejectCommand(t, k, lead, "", "coin_claim", map[string]any{"contribution": "RC-T-1"}, 13)
	command(t, k, guardian, "resolve_kpi", map[string]any{"task": "T-1", "observed": "6", "source": "https://example.invalid/fixture", "note": "An independent fictional observation confirms the threshold.", "evidence_digest": digest}, 14)
	command(t, k, lead, "coin_claim", map[string]any{"contribution": "RC-T-1"}, 15)
	ledger, err := k.coinLedger()
	if err != nil || ledger.Minted != "5000000" || ledger.Reserved != "0" {
		t.Fatal(ledger, err)
	}
}

func coinFixtureDomains(t *testing.T, k Keeper, lead, peer, def actor) {
	for _, a := range []actor{lead, peer, def} {
		command(t, k, a, "identity_claim", map[string]any{}, 3)
	}
	for i, a := range []actor{lead, peer, def} {
		command(t, k, a, "operator_claim", map[string]any{"domain": fmt.Sprintf("fixture-%d.example", i)}, 4)
	}
	for _, a := range []actor{lead, peer, def} {
		command(t, k, def, "operator_attest", dnsObservation(t, k, a.m.ID, "", 5), 5)
	}
}

func quoteFixtureTask(t *testing.T, k Keeper, lead actor, id string, required int, future bool, height int64) map[string]any {
	t.Helper()
	v := Task{ID: id, Project: "P-1", Title: "Fictional prospective Coin bounty", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 13, CreditReward: "13", VerifiersRequired: required}
	if future {
		v.Kind = "future"
		v.KPI = &KPI{Statement: "An independently observed fictional KPI exceeds five.", Metric: "fixture_value", Source: "https://example.invalid/fixture", Comparator: "gte", Threshold: "5", ResolvesBy: time.Unix(100, 0).UTC().Format(time.RFC3339)}
	}
	command(t, k, lead, "open_task", v, height)
	var event uint64
	if err := get(k.Store, "event_count", &event); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"task": id, "open_event": fmt.Sprintf("%020d", event), "amount": "5000000", "evidence_digest": digest}
}

func TestCoinProspectivePriceReservationVerifiedMintAndReplay(t *testing.T) {
	k, lead, peer, def := coinFixture(t)
	quote := quoteFixtureTask(t, k, lead, "T-coin", 2, false, 7)
	rejectCommand(t, k, peer, "", "coin_quote", quote, 8)
	bad := map[string]any{"task": "T-coin", "open_event": "00000000000000000001", "amount": "5000000", "evidence_digest": digest}
	rejectCommand(t, k, lead, "", "coin_quote", bad, 8)
	command(t, k, lead, "coin_quote", quote, 8)
	rejectCommand(t, k, lead, "", "coin_quote", quote, 9)
	allocation := map[string]any{"task": "T-coin", "evidence_digest": digest}
	rejectCommand(t, k, peer, "", "coin_reserve", allocation, 9)
	command(t, k, def, "coin_reserve", allocation, 9)
	ledger, err := k.coinLedger()
	if err != nil || ledger.Reserved != "5000000" || ledger.Minted != "0" || k.Store.Get([]byte("coin_balance/"+lead.m.ID)) != nil {
		t.Fatal("reservation created spendable Coin", ledger, err)
	}
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-coin", "task": "T-coin", "evidence_digest": digest}, 10)
	claim := map[string]any{"contribution": "RC-T-coin"}
	rejectCommand(t, k, lead, "", "coin_claim", claim, 11)
	checkWork(t, k, peer, "T-coin", 11)
	rejectCommand(t, k, lead, "", "coin_claim", claim, 12)
	checkWork(t, k, def, "T-coin", 12)
	before, _ := k.Member(lead.m.ID)
	rejectCommand(t, k, peer, "", "coin_claim", claim, 13)
	command(t, k, lead, "coin_claim", claim, 13)
	ledger, err = k.coinLedger()
	if err != nil || ledger.Minted != "5000000" || ledger.Transparent != "5000000" || ledger.Reserved != "0" || ledger.Shielded != "0" {
		t.Fatal("verified mint did not conserve issuance", ledger, err)
	}
	var balance string
	if err = get(k.Store, "coin_balance/"+lead.m.ID, &balance); err != nil || balance != "5000000" {
		t.Fatal("wrong separate Coin balance", balance, err)
	}
	after, _ := k.Member(lead.m.ID)
	if before.Credits != after.Credits || before.Karma != after.Karma {
		t.Fatal("Coin claim converted or rewrote pilot standing/credits")
	}
	rejectCommand(t, k, lead, "", "coin_claim", claim, 14)
	rejectCommand(t, k, def, "", "coin_reserve", allocation, 14)
	rejectCommand(t, k, def, "", "activate_coin", map[string]any{"policy": CoinPolicy, "evidence_digest": digest}, 14)
}

func TestCoinRefusesHistoricalTasksAndLatePricesOrAllocations(t *testing.T) {
	k, lead, peer, def := fixture(t)
	command(t, k, def, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, def, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	command(t, k, def, "activate_private_exchange", map[string]any{"policy": PrivateExchangePolicy, "relayer": peer.m.ID, "evidence_digest": digest}, 2)
	command(t, k, def, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 2)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Fictional historical bounty fixture", "class": "benevolent", "prior_art": prior}, 3)
	join(t, k, peer, "", 3)
	join(t, k, def, "", 3)
	oldQuote := quoteFixtureTask(t, k, lead, "T-before-coin", 2, false, 3)
	rejectCommand(t, k, peer, "", "activate_coin", map[string]any{"policy": CoinPolicy, "evidence_digest": digest}, 4)
	coinFixtureDomains(t, k, lead, peer, def)
	command(t, k, def, "activate_coin", map[string]any{"policy": CoinPolicy, "evidence_digest": digest}, 6)
	rejectCommand(t, k, lead, "", "coin_quote", oldQuote, 6)
	rejectCommand(t, k, lead, "", "coin_quote", oldQuote, 7)
	lateQuote := quoteFixtureTask(t, k, lead, "T-late-price", 2, false, 7)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-late-price", "task": "T-late-price", "evidence_digest": digest}, 8)
	rejectCommand(t, k, lead, "", "coin_quote", lateQuote, 9)
	quote := quoteFixtureTask(t, k, lead, "T-late-allocation", 2, false, 9)
	command(t, k, lead, "coin_quote", quote, 10)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-late-allocation", "task": "T-late-allocation", "evidence_digest": digest}, 11)
	rejectCommand(t, k, def, "", "coin_reserve", map[string]any{"task": "T-late-allocation", "evidence_digest": digest}, 12)
	ledger, err := k.coinLedger()
	if err != nil || ledger.Minted != "0" || ledger.Reserved != "0" {
		t.Fatal("old or retroactively priced work gained Coin", ledger, err)
	}
}

func TestCoinFutureKPIAndReducedVerificationDoNotMint(t *testing.T) {
	for _, future := range []bool{true, false} {
		t.Run(fmt.Sprintf("future=%v", future), func(t *testing.T) {
			k, lead, peer, def := coinFixture(t)
			required := 2
			if !future {
				required = 1
			}
			quote := quoteFixtureTask(t, k, lead, "T-gated", required, future, 7)
			command(t, k, lead, "coin_quote", quote, 8)
			command(t, k, def, "coin_reserve", map[string]any{"task": "T-gated", "evidence_digest": digest}, 9)
			command(t, k, lead, "submit", map[string]any{"id": "RC-T-gated", "task": "T-gated", "evidence_digest": digest}, 10)
			if future {
				checkWork(t, k, peer, "T-gated", 11)
			}
			checkWork(t, k, def, "T-gated", 12)
			rejectCommand(t, k, lead, "", "coin_claim", map[string]any{"contribution": "RC-T-gated"}, 13)
			ledger, err := k.coinLedger()
			if err != nil || ledger.Minted != "0" || ledger.Reserved != "5000000" {
				t.Fatal("incomplete or reduced verification minted Coin", ledger, err)
			}
		})
	}
}

func TestCoinReservationReleaseProtectsPendingAndEarnedWork(t *testing.T) {
	k, lead, peer, guardian := coinFixture(t)
	quote := quoteFixtureTask(t, k, lead, "T-release", 2, false, 7)
	command(t, k, lead, "coin_quote", quote, 8)
	payload := map[string]any{"task": "T-release", "evidence_digest": digest}
	command(t, k, guardian, "coin_reserve", payload, 9)
	rejectCommand(t, k, guardian, "", "coin_release", payload, 10)
	rejectCommand(t, k, peer, "", "coin_release", payload, 10)
	command(t, k, lead, "coin_release", payload, 10)
	rejectCommand(t, k, lead, "", "coin_release", payload, 11)
	rejectCommand(t, k, guardian, "", "coin_reserve", payload, 11)
	ledger, err := k.coinLedger()
	if err != nil || ledger != coin.Empty() {
		t.Fatal(ledger, err)
	}
	quote = quoteFixtureTask(t, k, lead, "T-pending", 2, false, 11)
	command(t, k, lead, "coin_quote", quote, 12)
	payload["task"] = "T-pending"
	command(t, k, guardian, "coin_reserve", payload, 13)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-pending", "task": "T-pending", "evidence_digest": digest}, 14)
	rejectCommand(t, k, lead, "", "coin_release", payload, 15)
	rejectCommand(t, k, guardian, "", "coin_release", payload, 15)
	checkWork(t, k, peer, "T-pending", 16)
	checkWork(t, k, guardian, "T-pending", 17)
	rejectCommand(t, k, lead, "", "coin_release", payload, 18)
	command(t, k, lead, "coin_claim", map[string]any{"contribution": "RC-T-pending"}, 18)
	rejectCommand(t, k, guardian, "", "coin_release", payload, 19)
}
