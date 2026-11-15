//go:build orchard && cgo

package federation

import "testing"

func TestCentralBudgetRejectsAdditionalV1Quote(t *testing.T) {
	k, lead, _, g := coinFixture(t)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 7)
	command(t, k, lead, "central_project_start", map[string]any{"project": "P-1", "manager": lead.m.ID, "evidence_digest": digest}, 8)
	command(t, k, g, "central_fund_configure", map[string]any{"project": "P-1", "evaluator": g.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 8)
	plan := fundPlan(1)
	plan["project"] = "P-1"
	command(t, k, g, "central_fund_plan", plan, 8)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-1", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 8)
	command(t, k, lead, "central_task_open", map[string]any{"id": "CT-full", "project": "P-1", "title": "Full allocated budget fixture", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "9999999999", "reviewer_amount": "1", "evidence_digest": digest}, 9)
	quote := quoteFixtureTask(t, k, lead, "T-bypass", 2, false, 10)
	rejectCommand(t, k, lead, "", "coin_quote", quote, 11)
}
func TestCentralAdoptionRejectsExistingV1Money(t *testing.T) {
	for _, state := range []string{"quoted", "reserved", "released", "paid"} {
		t.Run(state, func(t *testing.T) {
			k, lead, peer, g := coinFixture(t)
			quote := quoteFixtureTask(t, k, lead, "T-old", 2, false, 7)
			command(t, k, lead, "coin_quote", quote, 8)
			allocation := map[string]any{"task": "T-old", "evidence_digest": digest}
			if state != "quoted" {
				command(t, k, g, "coin_reserve", allocation, 9)
			}
			if state == "released" {
				command(t, k, lead, "coin_release", allocation, 10)
			}
			if state == "paid" {
				command(t, k, lead, "submit", map[string]any{"id": "RC-T-old", "task": "T-old", "evidence_digest": digest}, 10)
				checkWork(t, k, peer, "T-old", 11)
				checkWork(t, k, g, "T-old", 12)
				command(t, k, lead, "coin_claim", map[string]any{"contribution": "RC-T-old"}, 13)
			}
			command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 14)
			rejectCommand(t, k, lead, "", "central_project_start", map[string]any{"project": "P-1", "manager": lead.m.ID, "evidence_digest": digest}, 15)
		})
	}
}
func TestCentralRefusedAdoptionPreservesExistingV1Claim(t *testing.T) {
	k, lead, peer, g := coinFixture(t)
	quote := quoteFixtureTask(t, k, lead, "T-honored", 2, false, 7)
	command(t, k, lead, "coin_quote", quote, 8)
	command(t, k, g, "coin_reserve", map[string]any{"task": "T-honored", "evidence_digest": digest}, 9)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 10)
	rejectCommand(t, k, lead, "", "central_project_start", map[string]any{"project": "P-1", "manager": lead.m.ID, "evidence_digest": digest}, 11)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-honored", "task": "T-honored", "evidence_digest": digest}, 12)
	checkWork(t, k, peer, "T-honored", 13)
	checkWork(t, k, g, "T-honored", 14)
	command(t, k, lead, "coin_claim", map[string]any{"contribution": "RC-T-honored"}, 15)
	l, e := k.coinLedger()
	if e != nil || l.Minted != "5000000" || l.Reserved != "0" || k.Store.Get([]byte("central_project_budget/P-1")) != nil {
		t.Fatal(l, e)
	}
}
func TestCentralPolicyLeavesNewV1QuotesForNonadoptedProjects(t *testing.T) {
	k, lead, _, g := coinFixture(t)
	command(t, k, g, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": g.m.ID, "evidence_digest": digest}, 7)
	quote := quoteFixtureTask(t, k, lead, "T-nonadopted", 2, false, 8)
	command(t, k, lead, "coin_quote", quote, 9)
	command(t, k, g, "coin_reserve", map[string]any{"task": "T-nonadopted", "evidence_digest": digest}, 10)
}
