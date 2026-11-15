package federation

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"testing"
)

func TestCompactActivationAndExistingRecordsUnchanged(t *testing.T) {
	k, lead, peer, def := fixture(t)
	rejectCommand(t, k, peer, "", "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	rejectCommand(t, k, def, "", "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, math.MaxInt64)
	command(t, k, def, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	creditProject(t, k, lead, def, "0") // same activation height
	old := bytes.Clone(k.Store.Get([]byte("project/P-1")))
	p, _ := k.Project("P-1")
	if p.StoragePolicy != "" || k.Store.Get([]byte("project_metadata/P-1")) != nil {
		t.Fatal("same-height project migrated")
	}
	creditTask(t, k, lead, "T-1", 13, 2, false, 2)
	checkWork(t, k, peer, "T-1", 4)
	checkWork(t, k, def, "T-1", 5)
	if !bytes.Equal(old, k.Store.Get([]byte("project/P-1"))) {
		t.Fatal("old unbudgeted project serialization changed")
	}
	task, _ := k.Task("T-1")
	work, _ := k.Contribution("RC-T-1")
	if task.StoragePolicy != "" || work.StoragePolicy != "" || len(work.Verifications[0].Searches) == 0 || work.Verifications[0].RecordDigest != "" {
		t.Fatal("legacy task or check storage changed")
	}
	rejectCommand(t, k, def, "", "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 6)
}

func TestCompactEvidenceSurvivesBudgetSettlementAndClosure(t *testing.T) {
	k, lead, peer, def := fixture(t)
	command(t, k, def, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, def, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 1)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Compact research project", "class": "benevolent", "prior_art": prior}, 2)
	command(t, k, def, "allocate_budget", map[string]any{"project": "P-1", "credits": "1000", "evidence_digest": digest}, 2)
	metadata := bytes.Clone(k.Store.Get([]byte("project_metadata/P-1")))
	p, err := k.Project("P-1")
	if err != nil || p.Title != "Compact research project" || !reflect.DeepEqual(p.PriorArt, prior) || p.StoragePolicy != CompactStatePolicy {
		t.Fatal(p, err)
	}
	join(t, k, peer, "", 2)
	join(t, k, def, "", 2)
	creditTask(t, k, lead, "T-1", 13, 2, false, 3)
	taskMetadata := bytes.Clone(k.Store.Get([]byte("task_metadata/T-1")))
	checkWork(t, k, peer, "T-1", 4)
	checkWork(t, k, def, "T-1", 5)
	var raw Contribution
	if err = json.Unmarshal(k.Store.Get([]byte("contribution/RC-T-1")), &raw); err != nil {
		t.Fatal(err)
	}
	if raw.State != "settled" || len(raw.Verifications) != 2 || len(raw.Verifications[0].Searches) != 0 || raw.Verifications[0].RecordDigest == "" {
		t.Fatal("mutable record contains large evidence or missed settlement", raw)
	}
	work, err := k.Contribution("RC-T-1")
	if err != nil || !reflect.DeepEqual(work.Verifications[0].Searches, prior.Searches) || !reflect.DeepEqual(work.Settlement.Checks[0].Searches, prior.Searches) {
		t.Fatal("complete/frozen check reconstruction failed", work, err)
	}
	command(t, k, peer, "challenge_prior_art", challengePayload("C-1"), 6)
	command(t, k, def, "decide_prior_art", challengeDecision("C-1", "upheld"), 7)
	if !bytes.Equal(metadata, k.Store.Get([]byte("project_metadata/P-1"))) || !bytes.Equal(taskMetadata, k.Store.Get([]byte("task_metadata/T-1"))) {
		t.Fatal("decision or accounting rewrote immutable research")
	}
	work, err = k.Contribution("RC-T-1")
	p, _ = k.Project("P-1")
	if err != nil || work.State != "settled" || p.Accounting.Reserved != "0" || p.Accounting.Spent != "13" {
		t.Fatal("closure changed paid award", work, p, err)
	}
	// A missing/mismatched evidence row must not become a plausible full answer.
	evidenceKey := "verification_evidence/RC-T-1/" + raw.Verifications[0].RecordDigest
	evidence := bytes.Clone(k.Store.Get([]byte(evidenceKey)))
	k.Store.Set([]byte(evidenceKey), []byte(`{}`))
	if _, err = k.Contribution("RC-T-1"); err == nil {
		t.Fatal("corrupt check evidence reconstructed")
	}
	k.Store.Set([]byte(evidenceKey), evidence)
	k.Store.Delete([]byte("task_metadata/T-1"))
	if _, err = k.Task("T-1"); err == nil {
		t.Fatal("missing task evidence reconstructed")
	}
}
