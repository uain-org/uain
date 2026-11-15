package federation

import (
	"strings"
	"testing"

	"github.com/uain-org/uain/chain/coin"
)

func centralHardeningOn(t *testing.T, k Keeper, g actor, blocks string, height int64) {
	command(t, k, g, "central_hardening_activate", map[string]any{"policy": CentralHardeningPolicy, "review_blocks": blocks, "evidence_digest": digest}, height)
}
func hardenedSubmit(id, task, evidence string) map[string]any {
	return map[string]any{"id": id, "task": task, "evidence": evidence, "evidence_digest": centralDigest(evidence)}
}

func TestCentralHardeningActivationIsGuardianOnlyOnceAndBounded(t *testing.T) {
	k, lead, _, g := centralFixture(t)
	in := func(policy, blocks string) map[string]any {
		return map[string]any{"policy": policy, "review_blocks": blocks, "evidence_digest": digest}
	}
	rejectCommand(t, k, lead, "", "central_hardening_activate", in(CentralHardeningPolicy, "100"), 5)
	rejectCommand(t, k, g, "", "central_hardening_activate", in(CentralHardeningPolicy, "0"), 5)
	rejectCommand(t, k, g, "", "central_hardening_activate", in(CentralHardeningPolicy, "0100"), 5)
	rejectCommand(t, k, g, "", "central_hardening_activate", in(CentralHardeningPolicy, "1000001"), 5)
	rejectCommand(t, k, g, "", "central_hardening_activate", in("other", "100"), 5)
	centralHardeningOn(t, k, g, "100", 5)
	rejectCommand(t, k, g, "", "central_hardening_activate", in(CentralHardeningPolicy, "100"), 6)
	var a CentralHardeningActivation
	get(k.Store, "central_hardening_activation", &a)
	if a.Height != 6 || a.ReviewBlocks != 100 || a.ApprovedBy != g.m.ID {
		t.Fatal(a)
	}
}

func TestCentralHardeningInactiveKeepsLegacyBytes(t *testing.T) {
	k, lead, peer, _ := centralFixture(t)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	if raw := string(k.Store.Get([]byte("central_submission/CS-1"))); strings.Contains(raw, "review_deadline") {
		t.Fatal("inactive policy wrote a review deadline", raw)
	}
	if k.Store.Get([]byte("central_evidence_digest/"+centralDigest("42"))) != nil {
		t.Fatal("inactive policy indexed evidence")
	}
	// Without the policy a plain submission never expires.
	rejectCommand(t, k, peer, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 1_000_000)
}

func TestCentralReviewDeadlineExpiresWithoutFeeAndReopensTask(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralHardeningOn(t, k, g, "10", 5) // no evidence window: the deadline works on its own
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	if v := centralSubmission(t, k, "CS-1"); v.ReviewDeadline != 16 {
		t.Fatal(v)
	}
	var before coin.Ledger
	get(k.Store, "coin_supply", &before)
	var budgetBefore CentralBudget
	get(k.Store, "central_project_budget/P-central", &budgetBefore)
	rejectCommand(t, k, lead, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 16)
	// Past the deadline: no late verdict, only expiry.
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "reject", "exec-1"), 17)
	command(t, k, lead, "central_evidence_expire", map[string]any{"submission": "CS-1"}, 17)
	v, task := centralSubmission(t, k, "CS-1"), centralTaskRecord(t, k, "CT-1")
	if v.State != "expired" || v.ExpiredHeight != 17 || task.State != "open" || task.Pending != "" || task.Reserved != "120" {
		t.Fatal(v, task)
	}
	var after coin.Ledger
	get(k.Store, "coin_supply", &after)
	var budget CentralBudget
	get(k.Store, "central_project_budget/P-central", &budget)
	if after != before || budget.Paid != budgetBefore.Paid || budget.Reserved != budgetBefore.Reserved || k.Store.Get([]byte("central_award/reviewer/CS-1")) != nil {
		t.Fatal("expiry moved funds", after, budget)
	}
	// The author may submit the same evidence again; another member may not reuse it.
	rejectCommand(t, k, lead, "", "central_submit", hardenedSubmit("CS-2", "CT-1", "42"), 18)
	command(t, k, peer, "central_submit", hardenedSubmit("CS-3", "CT-1", "42"), 18)
}

func TestCentralReviewDeadlineLazyExpiryOnNewSubmission(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralHardeningOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	rejectCommand(t, k, lead, "", "central_submit", hardenedSubmit("CS-2", "CT-1", "43"), 16)
	command(t, k, lead, "central_submit", hardenedSubmit("CS-2", "CT-1", "43"), 17)
	if v := centralSubmission(t, k, "CS-1"); v.State != "expired" {
		t.Fatal(v)
	}
	if task := centralTaskRecord(t, k, "CT-1"); task.Pending != "CS-2" || task.State != "under_review" {
		t.Fatal(task)
	}
}

func TestCentralReviewDeadlineYieldsToEvidenceWindowAndCoversRevision(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "100", 5)
	centralHardeningOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	if v := centralSubmission(t, k, "CS-1"); v.ReviewDeadline != 0 || v.EvidenceDeadline != 107 {
		t.Fatal(v)
	}
	// Well past the old review deadline, the author still has the evidence window.
	rejectCommand(t, k, lead, "", "central_evidence_expire", map[string]any{"submission": "CS-1"}, 50)
	command(t, k, peer, "central_submit", revisionInput("CS-2", "CS-1", "43"), 50)
	if v := centralSubmission(t, k, "CS-2"); v.ReviewDeadline != 60 {
		t.Fatal(v)
	}
	// A revision no longer holds the task forever.
	command(t, k, lead, "central_evidence_expire", map[string]any{"submission": "CS-2"}, 61)
	if task := centralTaskRecord(t, k, "CT-1"); task.State != "open" || task.Pending != "" {
		t.Fatal(task)
	}
}

func TestCentralReassessmentGetsReviewDeadline(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralEvidenceOn(t, k, g, "100", 5)
	centralHardeningOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	command(t, k, peer, "central_reassess", map[string]any{"submission": "CS-1"}, 8)
	if v := centralSubmission(t, k, "CS-1"); v.ReviewDeadline != 18 {
		t.Fatal(v)
	}
	command(t, k, lead, "central_evidence_expire", map[string]any{"submission": "CS-1"}, 19)
}

func TestCentralEvidenceReuseAcrossMembersRefused(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralHardeningOn(t, k, g, "10", 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralOpen(t, k, lead, "CT-2", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	rejectCommand(t, k, lead, "", "central_submit", hardenedSubmit("CS-2", "CT-2", "42"), 7)
	command(t, k, lead, "central_submit", hardenedSubmit("CS-2", "CT-2", "different work"), 7)
}
