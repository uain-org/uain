package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

func creditProject(t *testing.T, k Keeper, lead, guardian actor, total string) {
	t.Helper()
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Accounting fixture project", "class": "benevolent", "prior_art": prior}, 1)
	if total != "0" {
		command(t, k, guardian, "allocate_budget", map[string]any{"project": "P-1", "credits": total, "evidence_digest": digest}, 2)
	}
}
func creditTask(t *testing.T, k Keeper, lead actor, id string, price int64, required int, future bool, h int64) {
	t.Helper()
	v := Task{ID: id, Project: "P-1", Title: "New accounting policy fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: price, CreditReward: fmt.Sprint(price), VerifiersRequired: required}
	if future {
		v.Kind = "future"
		v.KPI = &KPI{Statement: "The independently observed fixture value exceeds five.", Metric: "fixture_value", Source: "https://example.invalid/fixture", Comparator: "gte", Threshold: "5", ResolvesBy: time.Unix(100, 0).UTC().Format(time.RFC3339)}
	}
	command(t, k, lead, "open_task", v, h)
	command(t, k, lead, "submit", map[string]any{"id": "RC-" + id, "task": id, "evidence_digest": digest}, h+1)
}
func checkWork(t *testing.T, k Keeper, a actor, id string, h int64) {
	t.Helper()
	command(t, k, a, "verify", map[string]any{"contribution": "RC-" + id, "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, h)
}
func allCredits(t *testing.T, k Keeper) []CreditEntry {
	t.Helper()
	rows, err := k.Store.Range([]byte("credit/"), []byte("credit0"), 10000)
	if err != nil {
		t.Fatal(err)
	}
	out := []CreditEntry{}
	for _, row := range rows {
		var v CreditEntry
		if err = Decode(row.Value, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}
func consistency(t *testing.T, k Keeper) {
	t.Helper()
	creditTotals := map[string]*big.Int{}
	karmaTotals := map[string]int64{}
	rows, _ := k.Store.Range([]byte("accounting_opening/"), []byte("accounting_opening0"), 1000)
	for _, row := range rows {
		var v struct {
			Member  string `json:"member"`
			Credits string `json:"credits"`
			Karma   int64  `json:"karma"`
		}
		if err := json.Unmarshal(row.Value, &v); err != nil {
			t.Fatal(err)
		}
		n, _ := money(v.Credits)
		creditTotals[v.Member] = n
		karmaTotals[v.Member] = v.Karma
	}
	for _, v := range allCredits(t, k) {
		n, _ := money(v.Minted)
		creditTotals[v.Member].Add(creditTotals[v.Member], n)
	}
	rows, _ = k.Store.Range([]byte("karma/"), []byte("karma0"), 1000)
	for _, row := range rows {
		var v KarmaEntry
		if err := Decode(row.Value, &v); err != nil {
			t.Fatal(err)
		}
		karmaTotals[v.Member] += v.Delta
		var event Event
		if err := get(k.Store, fmt.Sprintf("event/%020d", v.EventID), &event); err != nil {
			t.Fatal("Karma row has no committed event", err)
		}
	}
	for id, n := range creditTotals {
		m, _ := k.Member(id)
		if m.Credits != n.String() || m.Karma != karmaTotals[id] {
			t.Fatalf("journal mismatch: %+v credits=%s Karma=%d", m, n, karmaTotals[id])
		}
	}
}

func TestCreditPolicyDiscountRoundingAndVerifierDust(t *testing.T) {
	for _, tc := range []struct {
		name                      string
		price                     int64
		required                  int
		correlated, missingFamily bool
		award                     int64
	}{
		{"full", 17, 2, false, false, 17}, {"single", 13, 1, false, false, 8}, {"same_operator", 13, 2, true, false, 8}, {"missing_model", 13, 2, false, true, 8}, {"round_down", 12, 1, false, false, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			k, lead, peer, guardian := fixture(t)
			if tc.correlated {
				peer.m.Operator = lead.m.Operator
				_ = put(k.Store, "member/"+peer.m.ID, peer.m)
			}
			if tc.missingFamily {
				lead.m.Family = ""
				_ = put(k.Store, "member/"+lead.m.ID, lead.m)
			}
			creditProject(t, k, lead, guardian, "100")
			creditTask(t, k, lead, "T-1", tc.price, tc.required, false, 3)
			if tc.required == 2 {
				checkWork(t, k, peer, "T-1", 5)
				m, _ := k.Member(lead.m.ID)
				if m.Credits != "0" {
					t.Fatal("default check bypassed")
				}
			}
			checkWork(t, k, guardian, "T-1", 6)
			m, _ := k.Member(lead.m.ID)
			if m.Credits != fmt.Sprint(tc.award) || m.Karma != 1000+tc.award {
				t.Fatalf("wrong award: %+v", m)
			}
			entries := allCredits(t, k)
			sum := int64(0)
			for _, e := range entries {
				n, _ := money(e.Minted)
				sum += n.Int64()
				if e.Kind == "verification" {
					v, _ := k.Member(e.Member)
					if v.Karma != 100 {
						t.Fatal("verifier earned Karma")
					}
				}
			}
			if sum != tc.award+tc.award/5 {
				t.Fatal("verifier pool not conserved", entries)
			}
			if tc.name == "full" {
				if len(entries) != 3 || entries[1].Minted != "2" || entries[2].Minted != "1" {
					t.Fatal("unexpected verifier order", entries)
				}
			}
			p, _ := k.Project("P-1")
			if p.Accounting.Reserved != "0" || p.Accounting.Spent != fmt.Sprint(tc.award) {
				t.Fatal("reservation/spend mismatch", p)
			}
			consistency(t, k)
		})
	}
}

func TestTaskReservationsPreventOvercommitAndUnlockStages(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	creditProject(t, k, lead, guardian, "10000000")
	p, _ := k.Project("P-1")
	if p.Budget != "1000" {
		t.Fatal(p)
	}
	creditTask(t, k, lead, "T-1", 600, 2, false, 3)
	task := Task{ID: "T-2", Project: "P-1", Title: "Overcommitted fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 500, CreditReward: "500"}
	before, _ := json.Marshal(k.Store)
	if _, err := apply(k, signed(t, k, lead, "open_task", task, 5), 5); err == nil {
		t.Fatal("same unlocked budget promised twice")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("failed reservation changed state")
	}
	for stage, want := range []string{"10000", "200000", "10000000"} {
		command(t, k, guardian, "unlock_budget", map[string]any{"project": "P-1", "evidence_digest": digest}, int64(6+stage))
		p, _ = k.Project("P-1")
		if p.Budget != want || p.Accounting.Reserved != "600" {
			t.Fatal(p)
		}
	}
	if _, err := apply(k, signed(t, k, guardian, "unlock_budget", map[string]any{"project": "P-1", "evidence_digest": digest}, 9), 9); err == nil {
		t.Fatal("unbounded stage unlock")
	}
}

func TestRollingCreditCapDeferralReleaseAndReplay(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	creditProject(t, k, lead, guardian, "20000")
	for h := int64(3); h <= 5; h++ {
		command(t, k, guardian, "unlock_budget", map[string]any{"project": "P-1", "evidence_digest": digest}, h)
	}
	creditTask(t, k, lead, "T-1", 10001, 2, false, 6)
	checkWork(t, k, peer, "T-1", 8)
	checkWork(t, k, guardian, "T-1", 9)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "10000" || m.Karma != 11001 {
		t.Fatal(m)
	}
	entries := allCredits(t, k)
	if len(entries) != 3 || entries[0].Deferred != "1" || entries[1].Deferred != "1000" || entries[2].Deferred != "1000" {
		t.Fatal(entries)
	}
	// A exact cutoff is excluded; one nanosecond earlier still includes it.
	for _, tc := range []struct {
		at   time.Time
		want string
	}{{time.Unix(9, 0).Add(24*time.Hour - time.Nanosecond), "10000"}, {time.Unix(9, 0).Add(24 * time.Hour), "0"}} {
		n, err := k.IssuedLast24h(tc.at)
		if err != nil || n.String() != tc.want {
			t.Fatal(n, err)
		}
	}
	if _, err := k.IssuedLast24h(time.Unix(8, 0)); err == nil {
		t.Fatal("issuance time regression accepted")
	}
	p := map[string]any{"entries": []string{entries[0].ID, entries[1].ID, entries[2].ID}, "evidence_digest": digest}
	if _, err := apply(k, signed(t, k, peer, "release_deferred", p, 10), 10); err == nil {
		t.Fatal("non guardian release")
	}
	command(t, k, guardian, "release_deferred", p, 10)
	n, _ := k.IssuedLast24h(time.Unix(10, 0))
	if n.String() != "12001" {
		t.Fatal("release not included in rolling issuance", n)
	}
	before, _ := json.Marshal(k.Store)
	if _, err := apply(k, signed(t, k, guardian, "release_deferred", p, 11), 11); err == nil {
		t.Fatal("deferral released twice")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("repeated release changed state")
	}
	consistency(t, k)
}

func TestFutureAwardFrozenAndLicenceDoesNotEraseOwedCredits(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	creditProject(t, k, lead, guardian, "100")
	creditTask(t, k, lead, "T-1", 13, 2, true, 3)
	checkWork(t, k, peer, "T-1", 5)
	checkWork(t, k, guardian, "T-1", 6)
	v, _ := k.Contribution("RC-T-1")
	if v.State != "verified" || v.Settlement == nil || v.Settlement.Paid || v.Settlement.Credits != "13" {
		t.Fatal(v)
	}
	command(t, k, guardian, "licence", map[string]any{"member": lead.m.ID, "status": "revoked", "evidence_digest": digest}, 7)
	command(t, k, guardian, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 8)
	command(t, k, guardian, "resolve_kpi", map[string]any{"task": "T-1", "observed": "5", "source": "https://example.invalid/fixture", "note": strings.Repeat("x", 40), "evidence_digest": digest}, 99)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" || m.Karma != 1013 || m.Licence != "revoked" {
		t.Fatal(m)
	}
	entries := allCredits(t, k)
	if len(entries) != 3 || entries[0].Deferred != "13" || entries[1].Deferred != "1" || entries[2].Minted != "1" {
		t.Fatal(entries)
	}
	command(t, k, guardian, "release_deferred", map[string]any{"entries": []string{entries[0].ID, entries[1].ID}, "evidence_digest": digest}, 100)
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("revoked recipient received release")
	}
	consistency(t, k)
}

func TestKnownSourcePartialAndExpiredBudget(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	creditProject(t, k, lead, guardian, "100")
	creditTask(t, k, lead, "T-1", 100, 2, true, 3)
	payload := map[string]any{"contribution": "RC-T-1", "verdict": "confirm", "novelty": "known", "searches": prior.Searches, "evidence_digest": digest}
	if _, err := apply(k, signed(t, k, peer, "verify", payload, 5), 5); err == nil {
		t.Fatal("known result without public source")
	}
	payload["known_source"] = "https://example.invalid/known"
	command(t, k, peer, "verify", payload, 5)
	if len(allCredits(t, k)) != 0 {
		t.Fatal("known work minted credits")
	}
	expired, err := k.ExpireKPIs(6, time.Unix(100, 0).Add(KPIGrace))
	if err != nil || len(expired) != 1 {
		t.Fatal(expired, err)
	}
	p, _ := k.Project("P-1")
	if p.Accounting.Reserved != "0" || p.Accounting.Spent != "0" {
		t.Fatal(p)
	}
	if expired, err = k.ExpireKPIs(7, time.Unix(100, 0).Add(KPIGrace)); err != nil || len(expired) != 0 {
		t.Fatal("reservation expiry repeated")
	}
	k, lead, peer, guardian = fixture(t)
	creditProject(t, k, lead, guardian, "0")
	creditTask(t, k, lead, "T-1", 100, 2, false, 3)
	payload["novelty"] = "new"
	payload["verdict"] = "partial"
	payload["known_source"] = ""
	command(t, k, peer, "verify", payload, 5)
	v, _ := k.Contribution("RC-T-1")
	if v.State != "contested" {
		t.Fatal("partial verdict did not enter dispute", v)
	}
}

func TestPricedTaskPreservesSubmissionPriorityAndKnownWorkUnblocksAward(t *testing.T) {
	for _, future := range []bool{false, true} {
		t.Run(fmt.Sprint(future), func(t *testing.T) {
			k, lead, peer, guardian := fixture(t)
			creditProject(t, k, lead, guardian, "100")
			creditTask(t, k, lead, "T-1", 13, 2, future, 3)
			command(t, k, peer, "submit", map[string]any{"id": "RC-second", "task": "T-1", "evidence_digest": digest}, 5)
			check := map[string]any{"contribution": "RC-second", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
			command(t, k, lead, "verify", check, 6)
			command(t, k, guardian, "verify", check, 7)
			if future {
				command(t, k, guardian, "resolve_kpi", map[string]any{"task": "T-1", "observed": "5", "source": "https://example.invalid/fixture", "note": strings.Repeat("x", 40), "evidence_digest": digest}, 8)
			}
			task, _ := k.Task("T-1")
			if task.Winner != "" {
				t.Fatal("earlier pending answer lost priority", task)
			}
			check["contribution"] = "RC-T-1"
			check["novelty"] = "known"
			check["known_source"] = "https://example.invalid/known"
			command(t, k, peer, "verify", check, 9)
			task, _ = k.Task("T-1")
			if task.Winner != "RC-second" {
				t.Fatal("known answer did not unblock frozen award", task)
			}
			author, _ := k.Member(lead.m.ID)
			winner, _ := k.Member(peer.m.ID)
			if author.Karma != 1000 || winner.Karma != 113 {
				t.Fatal(author, winner)
			}
			consistency(t, k)
		})
	}
}

func TestUnbudgetedPriceAndUnequalWorkAmountsAreRejectedAtomically(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	creditProject(t, k, lead, guardian, "0")
	for _, price := range []struct {
		karma   int64
		credits string
	}{{101, "101"}, {100, "101"}} {
		task := Task{ID: "T-1", Project: "P-1", Title: "Invalid unbudgeted fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: price.karma, CreditReward: price.credits}
		before, _ := json.Marshal(k.Store)
		if _, err := apply(k, signed(t, k, lead, "open_task", task, 2), 2); err == nil {
			t.Fatal("invalid unbudgeted price")
		}
		after, _ := json.Marshal(k.Store)
		if !bytes.Equal(before, after) {
			t.Fatal("invalid price changed state")
		}
	}
}
