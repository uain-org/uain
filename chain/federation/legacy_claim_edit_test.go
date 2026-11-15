package federation

import (
	"bytes"
	"testing"
)

func legacyClaimEditFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, a, p, d := legacyResearchFixture(t)
	w, _ := k.legacyWork("old-result")
	w.State = "settled"
	w.Paid = true
	_ = put(k.Store, "legacy_work/old-result", w)
	w.ID = "new-source"
	_ = put(k.Store, "legacy_work/new-source", w)
	_ = put(k.Store, "legacy/claim/old-claim", LegacyClaim{ID: "old-claim", Project: "old-project", Revisions: []LegacyRevision{{ID: "9", State: "believed", Author: "old-author", Member: a.m.ID, Action: "create", Statement: "The originally believed statement remains auditable.", Sources: []string{"old-result"}}}})
	task, _ := k.legacyTask("old-task")
	task.Claim = "old-claim"
	task.ClaimIDs = []string{"old-claim"}
	task.Contributions = append(task.Contributions, "new-source")
	_ = put(k.Store, "legacy_task/old-task", task)
	return k, a, p, d
}
func legacyEditPayload(action string, sources []string) map[string]any {
	return map[string]any{"claim": "old-claim", "base": "9", "author": "old-author", "action": action, "statement": "A revised statement follows newly verified evidence.", "sources": sources, "reason": "The new source changes the previously believed conclusion.", "evidence_digest": digest}
}
func TestLegacyClaimEditRequiresNewSettledSourceAndImmutableBase(t *testing.T) {
	k, a, _, _ := legacyClaimEditFixture(t)
	original := bytes.Clone(k.Store.Get([]byte("legacy/claim/old-claim")))
	guardianReject(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"old-result"}), 10)
	bad := legacyEditPayload("edit", []string{"new-source"})
	bad["base"] = "stale"
	guardianReject(t, k, a, "legacy_claim_edit", bad, 10)
	w, _ := k.legacyWork("new-source")
	w.State = "held"
	_ = put(k.Store, "legacy_work/new-source", w)
	guardianReject(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"new-source"}), 10)
	w.State = "settled"
	_ = put(k.Store, "legacy_work/new-source", w)
	command(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"old-result", "new-source"}), 10)
	claim, _ := k.legacyClaim("old-claim")
	if len(claim.Revisions) != 2 || claim.Revisions[0].State != "believed" || claim.Revisions[1].State != "draft" || claim.Revisions[1].Base != "9" {
		t.Fatal("editing bypassed review", claim)
	}
	if !bytes.Equal(original, k.Store.Get([]byte("legacy/claim/old-claim"))) {
		t.Fatal("original claim bytes rewritten")
	}
	m, _ := k.Member(a.m.ID)
	if m.Credits != "0" {
		t.Fatal("claim editing issued money")
	}
}
func TestLegacyClaimRetractionNeedsEvidenceAndExistingReview(t *testing.T) {
	k, a, p, d := legacyClaimEditFixture(t)
	guardianReject(t, k, a, "legacy_claim_edit", legacyEditPayload("retract", nil), 10)
	command(t, k, a, "legacy_claim_edit", legacyEditPayload("retract", []string{"new-source"}), 10)
	claim, _ := k.legacyClaim("old-claim")
	r := claim.Revisions[1]
	if r.Statement != claim.Revisions[0].Statement || r.Action != "retract" {
		t.Fatal("retraction changed original statement", r)
	}
	command(t, k, p, "legacy_claim_review", map[string]any{"claim": claim.ID, "revision": r.ID, "reviewer": "old-peer", "verdict": "confirm", "evidence_digest": digest}, 11)
	command(t, k, d, "legacy_claim_review", map[string]any{"claim": claim.ID, "revision": r.ID, "reviewer": "old-default", "verdict": "confirm", "evidence_digest": digest}, 12)
	claim, _ = k.legacyClaim("old-claim")
	if claim.Revisions[0].State != "superseded" || claim.Revisions[1].State != "believed" {
		t.Fatal(claim)
	}
	again := legacyEditPayload("retract", []string{"new-source"})
	again["base"] = r.ID
	guardianReject(t, k, a, "legacy_claim_edit", again, 13)
}
func TestLegacyManualClaimRequiresMultipleSources(t *testing.T) {
	k, a, _, _ := legacyClaimEditFixture(t)
	p := map[string]any{"project": "old-project", "author": "old-author", "statement": "A synthesis from independently verified contributions.", "sources": []string{"old-result"}, "reason": "These sources together establish a new combined conclusion.", "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_claim_assert", p, 10)
	p["sources"] = []string{"old-result", "new-source"}
	command(t, k, a, "legacy_claim_assert", p, 10)
	var ids []string
	if err := get(k.Store, "legacy_project_claims/old-project", &ids); err != nil || len(ids) != 1 {
		t.Fatal(ids, err)
	}
	claim, err := k.legacyClaim(ids[0])
	if err != nil || claim.Project != "old-project" || len(claim.Revisions) != 1 || claim.Revisions[0].State != "draft" {
		t.Fatal(claim, err)
	}
}

func TestLegacyRejectedClaimSingleSourceEligibilityAndAttemptLimit(t *testing.T) {
	for _, tc := range []struct {
		name     string
		flag     int
		later    string
		attempts int
		want     bool
	}{
		{"eligible", 0, "", 1, true}, {"no-revise", 1, "", 1, false}, {"later-draft", 0, "draft", 1, false}, {"later-rejected", 0, "rejected", 1, false}, {"third-attempt", 0, "", 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			k, a, _, _ := legacyClaimEditFixture(t)
			claim, _ := k.legacyClaim("old-claim")
			claim.Revisions[0].State = "rejected"
			_ = put(k.Store, "legacy_claim/old-claim", claim)
			_ = put(k.Store, "legacy/lookup/claim_revisions/9", map[string]any{"source": "source9"})
			_ = put(k.Store, "legacy/row/claim_revisions/source9", map[string]any{"table": "claim_revisions", "row": map[string]any{"id": 9, "no_revise": tc.flag}})
			if tc.later != "" {
				claim.ID = "later"
				claim.Revisions[0].ID = "10"
				claim.Revisions[0].State = tc.later
				_ = put(k.Store, "legacy_claim/later", claim)
				_ = put(k.Store, "legacy_project_claims/old-project", []string{"later"})
			}
			if tc.attempts > 1 {
				ids := []string{}
				for i := 1; i < tc.attempts; i++ {
					id := []string{"earlier-one", "earlier-two"}[i-1]
					claim.ID = id
					claim.Revisions[0].ID = []string{"7", "8"}[i-1]
					_ = put(k.Store, "legacy_claim/"+id, claim)
					ids = append(ids, id)
				}
				_ = put(k.Store, "legacy_project_claims/old-project", ids)
			}
			payload := map[string]any{"project": "old-project", "author": "old-author", "statement": "Corrected rejected draft.", "sources": []string{"old-result"}, "reason": "Corrected evidence.", "evidence_digest": digest}
			if tc.want {
				command(t, k, a, "legacy_claim_assert", payload, 10)
			} else {
				guardianReject(t, k, a, "legacy_claim_assert", payload, 10)
			}
		})
	}
}
func TestLegacyClaimEditAuthorityScopeBoundsAndProspectiveEvidence(t *testing.T) {
	k, a, p, _ := legacyClaimEditFixture(t)
	guardianReject(t, k, p, "legacy_claim_edit", legacyEditPayload("edit", []string{"new-source"}), 10)
	w, _ := k.legacyWork("new-source")
	w.Project = "elsewhere"
	_ = put(k.Store, "legacy_work/new-source", w)
	guardianReject(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"new-source"}), 10)
	w.Project = "old-project"
	_ = put(k.Store, "legacy_work/new-source", w)
	command(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{" new-source ", "new-source"}), 10)
	claim, _ := k.legacyClaim("old-claim")
	r := claim.Revisions[1]
	var evidence LegacyClaimProposal
	if e := get(k.Store, "legacy_claim_revision/"+r.ID, &evidence); e != nil || evidence.Reason == "" || evidence.Revision.State != "draft" || len(evidence.Revision.Sources) != 1 {
		t.Fatal(evidence, e)
	}
	task, _ := k.legacyTask("old-task")
	task.Claim = ""
	task.ClaimIDs = nil
	claim.Revisions[1].State = "believed"
	claim.Revisions[0].State = "superseded"
	_ = put(k.Store, "legacy_claim/old-claim", claim)
	belief, e := k.legacyTaskBelief(task, "")
	if e != nil || belief != r.ID {
		t.Fatal("project-index belief invisible", belief, e)
	}
}
