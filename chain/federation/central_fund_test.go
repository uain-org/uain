package federation

import (
	"fmt"
	"testing"
)

func fundPlan(revision uint64) map[string]any {
	stages := []map[string]any{}
	for i := 1; i <= 5; i++ {
		stages = append(stages, map[string]any{"round": i, "criteria": fmt.Sprintf("Project-specific measurable acceptance criterion for stage %d", i)})
	}
	return map[string]any{"project": "P-central", "revision": revision, "main_kpi": "Main project goal with reproducible measurable result", "stages": stages, "reason": "Initial tailored research plan", "evidence_digest": digest}
}
func fundSetup(t *testing.T) (Keeper, actor, actor, actor) {
	k, m, p, g := centralUnplannedFixture(t)
	command(t, k, g, "central_fund_configure", map[string]any{"project": "P-central", "evaluator": g.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 5)
	command(t, k, g, "central_fund_plan", fundPlan(1), 6)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 7)
	return k, m, p, g
}
func fundApply(id string, round int, revision int) map[string]any {
	return map[string]any{"id": id, "project": "P-central", "round": round, "revision": revision, "evidence_digest": digest}
}
func fundDecision(id, verdict string) map[string]any {
	return map[string]any{"application": id, "verdict": verdict, "verification_digest": digest, "feedback": "All predefined criteria checked against recorded evidence", "main_kpi_achieved": id == "F-5" && verdict == "accept"}
}
func TestCentralFundSequentialCarryoverAndFinalClosure(t *testing.T) {
	k, m, _, g := fundSetup(t)
	centralOpen(t, k, m, "carry", "100", "20")
	want := []string{"10000000000", "110000000000", "1110000000000", "11110000000000", "111110000000000", "1000000000000000"}
	for round := 1; round <= 5; round++ {
		id := fmt.Sprintf("F-%d", round)
		command(t, k, m, "central_fund_apply", fundApply(id, round, 1), int64(10+round*2))
		rejectCommand(t, k, m, "", "central_fund_decide", fundDecision(id, "accept"), int64(11+round*2))
		command(t, k, g, "central_fund_decide", fundDecision(id, "accept"), int64(11+round*2))
		var b CentralBudget
		get(k.Store, "central_project_budget/P-central", &b)
		if b.Round != uint64(round+1) || b.Allocation != want[round] || b.Reserved != "120" || b.Paid != "0" {
			t.Fatal(b)
		}
		rejectCommand(t, k, g, "", "central_fund_decide", fundDecision(id, "accept"), int64(12+round*2))
	}
	rejectCommand(t, k, m, "", "central_fund_apply", fundApply("sixth", 6, 1), 30)
	closeInput := map[string]any{"project": "P-central", "evidence_digest": digest}
	rejectCommand(t, k, g, "", "central_fund_close", closeInput, 31)
	centralSubmit(t, k, m, "carry-result", "carry")
	command(t, k, g, "central_review", centralReviewInput("carry-result", "accept", "final-review"), 32)
	command(t, k, g, "central_fund_close", closeInput, 33)
	rejectCommand(t, k, m, "", "central_task_open", map[string]any{"id": "after-close", "project": "P-central", "title": "No further tasks", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "1", "reviewer_amount": "1", "evidence_digest": digest}, 34)
}
func TestCentralFundRejectsSkippedUnapprovedAndStaleApplications(t *testing.T) {
	k, m, p, g := centralUnplannedFixture(t)
	rejectCommand(t, k, m, "", "central_fund_apply", fundApply("early", 1, 1), 5)
	rejectCommand(t, k, p, "", "central_fund_configure", map[string]any{"project": "P-central", "evaluator": p.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 5)
	command(t, k, g, "central_fund_configure", map[string]any{"project": "P-central", "evaluator": g.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 5)
	command(t, k, g, "central_fund_plan", fundPlan(1), 6)
	rejectCommand(t, k, m, "", "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 7)
	rejectCommand(t, k, m, "", "central_fund_apply", fundApply("early", 1, 1), 7)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 7)
	rejectCommand(t, k, m, "", "central_fund_apply", fundApply("skip", 2, 1), 8)
	command(t, k, m, "central_fund_apply", fundApply("reject", 1, 1), 8)
	rejectCommand(t, k, g, "", "central_fund_plan", fundPlan(2), 9)
	command(t, k, g, "central_fund_decide", fundDecision("reject", "reject"), 9)
	command(t, k, g, "central_fund_plan", fundPlan(2), 10)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 2, "verdict": "accept", "evidence_digest": digest}, 11)
	rejectCommand(t, k, m, "", "central_fund_apply", fundApply("stale", 1, 1), 12)
	command(t, k, m, "central_fund_apply", fundApply("retry", 1, 2), 12)
	command(t, k, g, "central_fund_decide", fundDecision("retry", "accept"), 13)
	// Completed KPI cannot be rewritten by a later amendment.
	amended := fundPlan(3)
	amended["stages"].([]map[string]any)[0]["criteria"] = "Weaken the already accepted KPI"
	rejectCommand(t, k, g, "", "central_fund_plan", amended, 14)
}
func TestLatestFundSpecificationCeilingAndFinalIncrement(t *testing.T) {
	if CentralProjectLifetimeCeiling != "1000000000000000" || centralAllocation(6) != "1000000000000000" {
		t.Fatal("latest one-billion ceiling not implemented")
	}
}

func TestCentralFundNeedsCommunicatedPlanBeforePaidTasks(t *testing.T) {
	k, m, _, _ := centralUnplannedFixture(t)
	rejectCommand(t, k, m, "", "central_task_open", map[string]any{"id": "unplanned", "project": "P-central", "title": "No predefined milestones", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "100", "reviewer_amount": "20", "evidence_digest": digest}, 5)
}
func TestCentralFundFinalGateNeedsMainAchievementAndSpecificFeedback(t *testing.T) {
	k, m, _, g := fundSetup(t)
	for round := 1; round <= 4; round++ {
		id := fmt.Sprintf("F-%d", round)
		command(t, k, m, "central_fund_apply", fundApply(id, round, 1), int64(10+round*2))
		command(t, k, g, "central_fund_decide", fundDecision(id, "accept"), int64(11+round*2))
	}
	command(t, k, m, "central_fund_apply", fundApply("F-5", 5, 1), 25)
	before := string(k.Store.Get([]byte("central_project_budget/P-central")))
	decision := fundDecision("F-5", "accept")
	decision["main_kpi_achieved"] = false
	rejectCommand(t, k, g, "", "central_fund_decide", decision, 26)
	decision = fundDecision("F-5", "reject")
	decision["feedback"] = "no"
	rejectCommand(t, k, g, "", "central_fund_decide", decision, 26)
	if before != string(k.Store.Get([]byte("central_project_budget/P-central"))) {
		t.Fatal("failed final verification changed allowance")
	}
	command(t, k, g, "central_fund_decide", fundDecision("F-5", "accept"), 27)
	var b CentralBudget
	get(k.Store, "central_project_budget/P-central", &b)
	if b.Allocation != "1000000000000000" || !b.Achieved || b.Closed {
		t.Fatal(b)
	}
}
func TestCentralFundRejectedAmendmentKeepsApprovedCriteriaUsable(t *testing.T) {
	k, m, _, g := fundSetup(t)
	command(t, k, g, "central_fund_plan", fundPlan(2), 8)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 2, "verdict": "reject", "evidence_digest": digest}, 9)
	command(t, k, m, "central_fund_apply", fundApply("old-approved-plan", 1, 1), 10)
	command(t, k, g, "central_fund_decide", fundDecision("old-approved-plan", "accept"), 11)
}
