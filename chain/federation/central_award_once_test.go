package federation

// Test-only checks for the contribution view (P0-3, 12 November 2026). BAINK
// counts accepted contributions from central_award/<role>/<submission> and
// central_earnings/<member>; these tests pin the two chain facts it relies on:
// an award is written once, and nothing but an award changes the earnings
// record (so a transfer, refund or payment can never add recognition).

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestCentralAwardIsWrittenOnceAndEarningsCountItOnce(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-once", "100000000", "20000000")
	centralSubmit(t, k, peer, "CS-once", "CT-once")
	command(t, k, g, "central_review", centralReviewInput("CS-once", "accept", "exec-once"), 7)
	before := map[string][]byte{}
	for _, key := range []string{"central_earnings/" + peer.m.ID, "central_earnings/" + g.m.ID, "central_award/solver/CS-once", "central_award/reviewer/CS-once"} {
		before[key] = append([]byte(nil), k.Store.Get([]byte(key))...)
		if len(before[key]) == 0 {
			t.Fatal("missing", key)
		}
	}
	// A second verdict on the same submission is refused and changes nothing.
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-once", "accept", "exec-again"), 8)
	for key, value := range before {
		if !bytes.Equal(k.Store.Get([]byte(key)), value) {
			t.Fatal("changed by a refused second award:", key)
		}
	}
	var e CentralEarnings
	get(k.Store, "central_earnings/"+peer.m.ID, &e)
	if e.Awards != "1" || e.Solver != "100000000" || e.Total != "100000000" {
		t.Fatal(e)
	}
}

func TestCentralReviewRefusesWhenTheAwardRecordAlreadyExists(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-dup", "100000000", "20000000")
	centralSubmit(t, k, peer, "CS-dup", "CT-dup")
	// An award record already present for this submission (written earlier by any path):
	// the verdict that would write it again is refused before any write.
	put(k.Store, "central_award/reviewer/CS-dup", CentralAward{"CS-dup", "CT-dup", "P-central", g.m.ID, "reviewer", "20000000", 6})
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-dup", "accept", "exec-dup"), 7)
	for _, member := range []string{peer.m.ID, g.m.ID} {
		if k.Store.Get([]byte("central_earnings/"+member)) != nil {
			t.Fatal("earnings written for a refused duplicate award:", member)
		}
	}
	if k.Store.Get([]byte("central_award/solver/CS-dup")) != nil {
		t.Fatal("solver paid on a refused duplicate")
	}
}

// Structural: central_earnings/ is written only by centralIndexAward, and that
// is called only where a central award is written. Transfers (coin_shield,
// private_payment), refunds, budgets and reservations therefore never touch it.
// Read from the source, because a real shielded transfer needs the Orchard
// prover, which these unit tests do not load.
func TestOnlyCentralAwardsWriteCentralEarnings(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	writers, callers := 0, map[string]int{}
	call := regexp.MustCompile(`k\.centralIndexAward\(`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		text := string(src)
		if strings.Contains(text, `"central_earnings/"`) {
			if f != "central_earning.go" {
				t.Fatal("central_earnings/ is referenced outside central_earning.go:", f)
			}
			writers++
		}
		if n := len(call.FindAllString(text, -1)); n > 0 {
			callers[f] = n
		}
	}
	if writers != 1 {
		t.Fatal("central_earnings/ writers:", writers)
	}
	if len(callers) != 2 || callers["central_earning.go"] != 1 || callers["central_task_states.go"] != 1 {
		t.Fatal("centralIndexAward callers changed; check each one is an award path:", callers)
	}
	src, _ := os.ReadFile("central_earning.go")
	body := string(src)
	at := strings.Index(body, "func (k Keeper) centralIndexAward(")
	if at < 0 {
		t.Fatal("centralIndexAward missing")
	}
	// Every reference to the key is inside centralIndexAward.
	end := at + strings.Index(body[at:], "\n}\n")
	if strings.Count(body, `"central_earnings/"`) != strings.Count(body[at:end], `"central_earnings/"`) {
		t.Fatal("central_earnings/ is used outside centralIndexAward")
	}
}
