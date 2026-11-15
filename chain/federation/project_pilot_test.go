package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

// This is an isolated engineering fixture, not evidence of a new scientific
// result or a production reward. All actors/keys exist only in test memory.
func singleProjectPilot(t *testing.T, sharedOperator bool) (Keeper, actor, actor, actor) {
	t.Helper()
	k, creator, reviewer, defaultReviewer := fixture(t)
	if sharedOperator {
		reviewer.m.Operator = creator.m.Operator
		if err := put(k.Store, "member/"+reviewer.m.ID, reviewer.m); err != nil {
			t.Fatal(err)
		}
	}
	createInstance(t, k, creator, "pilot-author", "Fixture author family")
	createInstance(t, k, reviewer, "pilot-reviewer", "Fixture review family")
	createInstance(t, k, defaultReviewer, "pilot-default", "Fixture default family")
	command(t, k, defaultReviewer, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 2)
	instanceCommand(t, k, creator, "pilot-author", "open_project", map[string]any{
		"id": "opp-00002-isolated-pilot", "title": "Synthetic isolated project lifecycle fixture", "class": "neutral", "prior_art": prior,
	}, 3)
	instanceCommand(t, k, creator, "pilot-author", "open_task", Task{
		ID: "pilot-task", Project: "opp-00002-isolated-pilot", Title: "Synthetic bounded integration task", Class: "neutral", PriorArt: prior,
		Criteria: "This isolated fixture checks canonical command, membership and review transitions; it is never production research.",
		Kind:     "instant", KarmaReward: 0, CreditReward: "0", VerifiersRequired: 2,
	}, 4)
	return k, creator, reviewer, defaultReviewer
}

func pilotSubmission() map[string]any {
	return map[string]any{"id": "pilot-result", "task": "pilot-task", "evidence_digest": digest}
}

func pilotCheck(novelty string) map[string]any {
	return map[string]any{"contribution": "pilot-result", "verdict": "confirm", "novelty": novelty, "searches": prior.Searches, "evidence_digest": digest}
}

func pilotJoin(t *testing.T, k Keeper, a actor, instance string, height int64) {
	t.Helper()
	instanceCommand(t, k, a, instance, "project_join", map[string]any{"project": "opp-00002-isolated-pilot"}, height)
}

func TestSingleProjectPilotCanonicalLifecycle(t *testing.T) {
	k, creator, reviewer, defaultReviewer := singleProjectPilot(t, false)
	project, err := k.Project("opp-00002-isolated-pilot")
	if err != nil || project.Lead != creator.m.ID || project.LeadInstance != "pilot-author" || project.State != "active" || project.Budget != "0" || project.MembershipPolicy != MembershipPolicy {
		t.Fatal("native project missing or incorrectly bound", project, err)
	}
	// Opening the project admits only the exact creator actor. A sibling
	// instance is not silently allowed to submit on that actor's behalf.
	createInstance(t, k, creator, "pilot-sibling", "Fixture author family")
	rejectCommand(t, k, creator, "pilot-sibling", "submit", pilotSubmission(), 5)
	rejectCommand(t, k, reviewer, "pilot-reviewer", "submit", pilotSubmission(), 5)
	pilotJoin(t, k, reviewer, "pilot-reviewer", 5)
	pilotJoin(t, k, defaultReviewer, "pilot-default", 6)
	instanceCommand(t, k, creator, "pilot-author", "submit", pilotSubmission(), 7)
	contribution, err := k.Contribution("pilot-result")
	if err != nil || contribution.State != "held" || contribution.Author != creator.m.ID || contribution.AuthorInstance != "pilot-author" {
		t.Fatal("submission must be held, not locally accepted", contribution, err)
	}
	rejectCommand(t, k, creator, "pilot-author", "verify", pilotCheck("new"), 8)
	instanceCommand(t, k, reviewer, "pilot-reviewer", "verify", pilotCheck("new"), 8)
	contribution, _ = k.Contribution("pilot-result")
	if contribution.State != "held" || len(contribution.Verifications) != 1 || contribution.Settlement != nil {
		t.Fatal("one reviewer must not establish settlement", contribution)
	}
	raw := instanceSigned(t, k, defaultReviewer, "pilot-default", "verify", pilotCheck("new"), 9)
	if _, err = apply(k, raw, 9); err != nil {
		t.Fatal(err)
	}
	contribution, err = k.Contribution("pilot-result")
	task, taskErr := k.Task("pilot-task")
	if err != nil || taskErr != nil || contribution.State != "settled" || task.State != "settled" || task.Winner != contribution.ID || contribution.Settlement == nil || contribution.Settlement.IndependentOperators != 2 || !contribution.Settlement.OtherFamily {
		t.Fatal("native checks did not establish their canonical outcome", contribution, task, err, taskErr)
	}
	// Zero-priced engineering work must not imply monetary issuance. In
	// particular a native credit settlement is not a Coin earning receipt.
	for _, a := range []actor{creator, reviewer, defaultReviewer} {
		member, err := k.Member(a.m.ID)
		if err != nil || member.Credits != "0" || member.Karma != a.m.Karma {
			t.Fatal("zero-priced fixture changed participant rewards", member, err)
		}
	}
	if k.Store.Get([]byte("coin_supply")) != nil || k.Store.Get([]byte("coin_reservation/pilot-task")) != nil {
		t.Fatal("project admission unexpectedly activated money")
	}
	rejectCommand(t, k, creator, "pilot-author", "coin_claim", map[string]any{"contribution": "pilot-result"}, 10)
	// Read the signed ledger, not a parallel local acceptance record.
	var count uint64
	if err = get(k.Store, "event_count", &count); err != nil {
		t.Fatal(err)
	}
	operations := map[string]int{}
	for n := uint64(1); n <= count; n++ {
		var event Event
		if err = get(k.Store, fmt.Sprintf("event/%020d", n), &event); err != nil {
			t.Fatal(err)
		}
		operations[event.Operation]++
	}
	for op, want := range map[string]int{"open_project": 1, "open_task": 1, "project_join": 2, "submit": 1, "verify": 2} {
		if operations[op] != want {
			t.Fatalf("ledger %s count=%d want=%d", op, operations[op], want)
		}
	}
	before, _ := json.Marshal(k.Store)
	if _, err = apply(k, raw, 10); err == nil {
		t.Fatal("same signed review replay was accepted")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("failed replay altered canonical state")
	}
}

func TestSingleProjectPilotAuthorityAndMetadataGates(t *testing.T) {
	k, creator, reviewer, defaultReviewer := singleProjectPilot(t, false)
	candidate := map[string]any{"id": "second-project", "title": "Another synthetic integration project", "class": "neutral", "prior_art": prior}
	// Licence/instance ownership alone is not project-creator authority.
	rejectCommand(t, k, reviewer, "pilot-reviewer", "open_project", candidate, 5)
	// The existing 1,000-Karma actor has consumed its one-project allowance.
	rejectCommand(t, k, creator, "pilot-author", "open_project", candidate, 5)
	rejectCommand(t, k, reviewer, "pilot-reviewer", "open_task", Task{ID: "unauthorized-task", Project: "opp-00002-isolated-pilot"}, 5)
	invalidTask := Task{ID: "invalid-task", Project: "opp-00002-isolated-pilot", Title: "Synthetic invalid criteria", Class: "neutral", PriorArt: prior, Criteria: "too short", Kind: "instant", KarmaReward: 0, CreditReward: "0"}
	rejectCommand(t, k, creator, "pilot-author", "open_task", invalidTask, 5)
	pilotJoin(t, k, reviewer, "pilot-reviewer", 5)
	rejectCommand(t, k, reviewer, "pilot-reviewer", "project_join", map[string]any{"project": "opp-00002-isolated-pilot"}, 6)
	instanceCommand(t, k, creator, "pilot-author", "submit", pilotSubmission(), 6)
	duplicate := pilotSubmission()
	duplicate["id"] = "second-result"
	rejectCommand(t, k, creator, "pilot-author", "submit", duplicate, 7)
	// Verifier authority does not bypass joining this particular project.
	rejectCommand(t, k, defaultReviewer, "pilot-default", "verify", pilotCheck("new"), 7)
	pilotJoin(t, k, defaultReviewer, "pilot-default", 7)
	missingSearches := pilotCheck("new")
	missingSearches["searches"] = []string{}
	rejectCommand(t, k, defaultReviewer, "pilot-default", "verify", missingSearches, 8)
	rejectCommand(t, k, defaultReviewer, "pilot-default", "verify", pilotCheck("invented-novelty"), 8)
}

func TestSingleProjectPilotRejectsMissingPriorArt(t *testing.T) {
	k, creator, _, _ := fixture(t)
	for _, invalidPrior := range []PriorArt{{}, {Basis: prior.Basis, Searches: []string{"one source only"}}, {Basis: "too short", Searches: prior.Searches}} {
		rejectCommand(t, k, creator, "", "open_project", map[string]any{"id": "invalid-pilot", "title": "Synthetic project must establish prior art", "class": "neutral", "prior_art": invalidPrior}, 1)
	}
	if k.Store.Get([]byte("project/invalid-pilot")) != nil {
		t.Fatal("invalid admission left canonical project state")
	}
}

func TestSingleProjectPilotKnownPriorArtWithholds(t *testing.T) {
	k, creator, reviewer, defaultReviewer := singleProjectPilot(t, false)
	pilotJoin(t, k, reviewer, "pilot-reviewer", 5)
	pilotJoin(t, k, defaultReviewer, "pilot-default", 6)
	instanceCommand(t, k, creator, "pilot-author", "submit", pilotSubmission(), 7)
	check := pilotCheck("known")
	check["known_source"] = "https://example.invalid/synthetic-known-answer"
	instanceCommand(t, k, reviewer, "pilot-reviewer", "verify", check, 8)
	contribution, err := k.Contribution("pilot-result")
	if err != nil || contribution.State != "withheld" || contribution.AwardWithheld != "known" {
		t.Fatal("known prior art must not become accepted new work", contribution, err)
	}
	rejectCommand(t, k, defaultReviewer, "pilot-default", "verify", pilotCheck("new"), 9)
}

func TestSingleProjectPilotDoesNotInventOperatorIndependence(t *testing.T) {
	k, creator, reviewer, defaultReviewer := singleProjectPilot(t, true)
	pilotJoin(t, k, reviewer, "pilot-reviewer", 5)
	pilotJoin(t, k, defaultReviewer, "pilot-default", 6)
	instanceCommand(t, k, creator, "pilot-author", "submit", pilotSubmission(), 7)
	instanceCommand(t, k, reviewer, "pilot-reviewer", "verify", pilotCheck("new"), 8)
	instanceCommand(t, k, defaultReviewer, "pilot-default", "verify", pilotCheck("new"), 9)
	contribution, err := k.Contribution("pilot-result")
	// Existing nonmonetary credit policy has an explicit reduced-factor
	// fallback, not a universal hard refusal. Never relabel it as Coin-safe.
	if err != nil || contribution.Settlement == nil || contribution.Settlement.IndependentOperators != 1 || contribution.Settlement.FactorNumerator != 3 || contribution.Settlement.FactorDenominator != 5 {
		t.Fatal("existing operator policy was bypassed or misrepresented", contribution, err)
	}
	if k.Store.Get([]byte("coin_supply")) != nil {
		t.Fatal("non-independent credit fallback issued native Coin")
	}
}
