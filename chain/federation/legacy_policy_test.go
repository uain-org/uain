package federation

import (
	"fmt"
	"math/big"
	"testing"
	"time"
)

func TestLegacySourceIssuanceSurvivesImportWithoutMinting(t *testing.T) {
	k, author, _, _ := legacyResearchFixture(t)
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	put(k.Store, "legacy/policy", map[string]any{"version": 1, "daily_credit_cap": "10000", "bootstrap_operators": 3, "issuance_total": "10009"})
	for _, row := range []struct {
		at    time.Time
		total string
	}{{now.Add(-25 * time.Hour), "10000"}, {now.Add(-24 * time.Hour), "10004"}, {now.Add(-time.Hour), "10009"}} {
		put(k.Store, fmt.Sprintf("legacy/issuance_time/%020d", row.at.UnixNano()), row.total)
	}
	issued, err := k.IssuedLast24h(now)
	if err != nil || issued.String() != "5" {
		t.Fatal("original strict rolling window lost", issued, err)
	}
	m, _ := k.Member(author.m.ID)
	if m.Credits != "0" {
		t.Fatal("import minted historical credits", m)
	}
	if err = k.credit(author.m.ID, "old-author", "source-cap", "verified", big.NewInt(10000), now, false, ""); err != nil {
		t.Fatal(err)
	}
	m, _ = k.Member(author.m.ID)
	if m.Credits != "9995" {
		t.Fatal("native issuance ignored imported rolling history", m)
	}
	issued, err = k.IssuedLast24h(now.Add(23 * time.Hour))
	if err != nil || issued.String() != "9995" {
		t.Fatal("source history did not expire", issued, err)
	}
}
func TestLegacyAwardUsesPinnedOriginalCreditCeiling(t *testing.T) {
	k, author, _, _ := legacyResearchFixture(t)
	now := time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)
	put(k.Store, "legacy/policy", map[string]any{"version": 1, "daily_credit_cap": "10", "bootstrap_operators": 3, "issuance_total": "7"})
	put(k.Store, fmt.Sprintf("legacy/issuance_time/%020d", now.Add(-time.Hour).UnixNano()), "7")
	work, _ := k.legacyWork("old-result")
	if err := k.legacyPay(&work, 20, 20, nil, now); err != nil {
		t.Fatal(err)
	}
	m, _ := k.Member(author.m.ID)
	if m.Credits != "3" || m.Karma != 1020 {
		t.Fatal("original cap changed or standing deferred", m)
	}
	var owed CreditOwed
	if err := get(k.Store, "credit_owed/00000000000000000001", &owed); err != nil || owed.Remaining != "17" {
		t.Fatal("original unpaid claim lost", owed, err)
	}
}
func TestLegacyBootstrapNeedsFreshOriginalCensusAndMarksException(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	put(k.Store, "legacy/policy", map[string]any{"version": 1, "daily_credit_cap": "10000", "bootstrap_operators": 3, "issuance_total": "0"})
	for _, id := range []string{"old-author", "old-peer", "old-default"} {
		a, _ := k.legacyActor(id)
		a.Operator = "Shared original operator"
		a.Arbiter = false
		a.Tier = 0
		put(k.Store, "legacy_actor/"+id, a)
		put(k.Store, "legacy/bootstrap_order/"+id, id)
	}
	w, _ := k.legacyWork("old-result")
	w.State = "contested"
	w.Checks = []LegacyCheck{{ID: "1", Verifier: "old-peer", Member: peer.m.ID, Verdict: "disputed", Original: true}}
	put(k.Store, "legacy/work/old-result", w)
	payload := map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}
	rejectCommand(t, k, def, "", "legacy_check", payload, 10)
	command(t, k, def, "legacy_bootstrap_census_page", map[string]any{}, 11)
	command(t, k, def, "legacy_bootstrap_census_page", map[string]any{}, 12)
	command(t, k, def, "legacy_check", payload, 13)
	w, _ = k.legacyWork("old-result")
	if !w.Checks[len(w.Checks)-1].Bootstrap || w.State != "settled" {
		t.Fatal("bootstrap exception unmarked or did not settle", w)
	}
	m, _ := k.Member(author.m.ID)
	if m.Credits != "12" {
		t.Fatal("bootstrap ruling counted as independent", m)
	}
	command(t, k, author, "withdraw", map[string]any{}, 14)
	// Relevant licence change invalidates the cached census, but ordinary
	// settlement balance/Karma/sequence writes above must not invalidate it.
	if _, err := k.legacyBootstrapActive(); err == nil {
		t.Fatal("stale bootstrap census survived withdrawal")
	}
}
