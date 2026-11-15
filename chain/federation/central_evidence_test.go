package federation

import (
	"bytes"
	"testing"

	"github.com/uain-org/uain/chain/coin"
)

func centralEvidenceOn(t *testing.T, k Keeper, g actor, window string, height int64) {
	command(t, k, g, "central_evidence_activate", map[string]any{"policy": CentralEvidencePolicy, "window_blocks": window, "evidence_digest": digest}, height)
}
func centralSubmission(t *testing.T, k Keeper, id string) CentralSubmission {
	var v CentralSubmission
	if e := get(k.Store, "central_submission/"+id, &v); e != nil {
		t.Fatal(e)
	}
	return v
}
func centralTaskRecord(t *testing.T, k Keeper, id string) CentralTask {
	var x CentralTask
	if e := get(k.Store, "central_task/"+id, &x); e != nil {
		t.Fatal(e)
	}
	return x
}
func revisionInput(id, revises, evidence string) map[string]any {
	return map[string]any{"id": id, "task": "CT-1", "evidence": evidence, "evidence_digest": centralDigest(evidence), "revises": revises}
}
func revisionReview(sub, verdict, execution, evidence string) map[string]any {
	in := centralReviewInput(sub, verdict, execution)
	in["evidence_digest"] = centralDigest(evidence)
	return in
}

func TestCentralEvidenceInactiveKeepsLegacyBehaviourAndBytes(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	before := append([]byte(nil), k.Store.Get([]byte("central_submission/CS-1"))...)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-2"), 8)
	if !bytes.Equal(before, k.Store.Get([]byte("central_submission/CS-1"))) {
		t.Fatal("inactive policy changed the submission record")
	}
	rejectCommand(t, k, peer, "", "central_submit", revisionInput("CS-2", "CS-1", "43"), 9)
	rejectCommand(t, k, peer, "", "central_reassess", map[string]any{"submission": "CS-1"}, 9)
	rejectCommand(t, k, peer, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 9)
}

func TestCentralEvidenceActivationIsGuardianOnlyOnceAndBounded(t *testing.T) {
	k, lead, _, g := centralFixture(t)
	rejectCommand(t, k, lead, "", "central_evidence_activate", map[string]any{"policy": CentralEvidencePolicy, "window_blocks": "100", "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "central_evidence_activate", map[string]any{"policy": CentralEvidencePolicy, "window_blocks": "0", "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "central_evidence_activate", map[string]any{"policy": CentralEvidencePolicy, "window_blocks": "0100", "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "central_evidence_activate", map[string]any{"policy": "other", "window_blocks": "100", "evidence_digest": digest}, 5)
	centralEvidenceOn(t, k, g, "100", 5)
	rejectCommand(t, k, g, "", "central_evidence_activate", map[string]any{"policy": CentralEvidencePolicy, "window_blocks": "100", "evidence_digest": digest}, 6)
	var a CentralEvidenceActivation
	get(k.Store, "central_evidence_activation", &a)
	if a.Height != 6 || a.WindowBlocks != 100 || a.ApprovedBy != g.m.ID {
		t.Fatal(a)
	}
}

func TestCentralEvidenceOneRequestThenLinkedRevisionPreservesOriginal(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "100", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	original := centralSubmission(t, k, "CS-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	v := centralSubmission(t, k, "CS-1")
	if v.EvidenceRequestHeight != 7 || v.EvidenceDeadline != 107 || v.State != "under_review" {
		t.Fatal(v)
	}
	// One request only.
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-2"), 8)
	// Only the author may revise, only once, only within the window.
	rejectCommand(t, k, lead, "", "central_submit", revisionInput("CS-2", "CS-1", "43"), 8)
	command(t, k, peer, "central_submit", revisionInput("CS-2", "CS-1", "43"), 8)
	rejectCommand(t, k, peer, "", "central_submit", revisionInput("CS-3", "CS-1", "44"), 9)
	o := centralSubmission(t, k, "CS-1")
	if o.State != "superseded" || o.RevisedBy != "CS-2" || o.Evidence != original.Evidence || o.EvidenceDigest != original.EvidenceDigest || o.Height != original.Height {
		t.Fatal("original not preserved", o)
	}
	r := centralSubmission(t, k, "CS-2")
	if r.Revises != "CS-1" || r.State != "under_review" || r.Author != peer.m.ID {
		t.Fatal(r)
	}
	if task := centralTaskRecord(t, k, "CT-1"); task.Pending != "CS-2" || task.State != "under_review" {
		t.Fatal(task)
	}
	// The superseded original can no longer be decided; the revision cannot get a second request.
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "accept", "exec-3"), 9)
	rejectCommand(t, k, g, "", "central_review", revisionReview("CS-2", "needs_evidence", "exec-3", "43"), 9)
	command(t, k, g, "central_review", revisionReview("CS-2", "accept", "exec-3", "43"), 9)
	var bal string
	get(k.Store, "coin_balance/"+peer.m.ID, &bal)
	if bal != "100" {
		t.Fatal(bal)
	}
}

func TestCentralEvidenceReassessmentOnceThenVerdictRequired(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "100", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	rejectCommand(t, k, peer, "", "central_reassess", map[string]any{"submission": "CS-1"}, 7)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	rejectCommand(t, k, lead, "", "central_reassess", map[string]any{"submission": "CS-1"}, 8)
	command(t, k, peer, "central_reassess", map[string]any{"submission": "CS-1"}, 8)
	rejectCommand(t, k, peer, "", "central_reassess", map[string]any{"submission": "CS-1"}, 9)
	rejectCommand(t, k, peer, "", "central_submit", revisionInput("CS-2", "CS-1", "43"), 9)
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-2"), 9)
	// A reassessment does not expire; the reviewer must still decide after the window.
	rejectCommand(t, k, peer, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 200)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "reject", "exec-2"), 200)
}

func TestCentralEvidenceExpiryRejectsWithoutFeeAndReopensTask(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	var before coin.Ledger
	get(k.Store, "coin_supply", &before)
	var budgetBefore CentralBudget
	get(k.Store, "central_project_budget/P-central", &budgetBefore)
	rejectCommand(t, k, peer, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 17)
	// After the window: no revision, no late verdict.
	rejectCommand(t, k, peer, "", "central_submit", revisionInput("CS-2", "CS-1", "43"), 18)
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "reject", "exec-2"), 18)
	command(t, k, lead, "central_evidence_expire", map[string]any{"submission": "CS-1"}, 18)
	v := centralSubmission(t, k, "CS-1")
	task := centralTaskRecord(t, k, "CT-1")
	if v.State != "expired" || v.ExpiredHeight != 18 || task.State != "open" || task.Pending != "" || task.Reserved != "120" {
		t.Fatal(v, task)
	}
	var after coin.Ledger
	get(k.Store, "coin_supply", &after)
	var budget CentralBudget
	get(k.Store, "central_project_budget/P-central", &budget)
	if after != before || budget.Paid != budgetBefore.Paid || budget.Reserved != budgetBefore.Reserved {
		t.Fatal("expiry moved funds", after, budget)
	}
	if k.Store.Get([]byte("central_award/reviewer/CS-1")) != nil {
		t.Fatal("expired submission paid a reviewer fee")
	}
	rejectCommand(t, k, peer, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 19)
	// The reopened task accepts a new submission from anyone eligible.
	command(t, k, peer, "central_submit", map[string]any{"id": "CS-3", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 19)
}

func TestCentralEvidenceLazyExpiryOnNewSubmission(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	rejectCommand(t, k, peer, "", "central_submit", map[string]any{"id": "CS-2", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 17)
	command(t, k, peer, "central_submit", map[string]any{"id": "CS-2", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 18)
	if v := centralSubmission(t, k, "CS-1"); v.State != "expired" {
		t.Fatal(v)
	}
	if task := centralTaskRecord(t, k, "CT-1"); task.Pending != "CS-2" || task.State != "under_review" {
		t.Fatal(task)
	}
}
