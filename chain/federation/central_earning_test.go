package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/uain-org/uain/chain/coin"
	"strings"
	"testing"
)

func centralDigest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func centralUnplannedFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, lead, peer, guardian := fixture(t)
	put(k.Store, "coin_activation", CoinActivation{CoinPolicy, 2, digest})
	put(k.Store, "coin_supply", coin.Empty())
	put(k.Store, "project/P-central", Project{ID: "P-central", Lead: lead.m.ID, State: "active"})
	command(t, k, guardian, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": guardian.m.ID, "evidence_digest": digest}, 3)
	command(t, k, lead, "central_project_start", map[string]any{"project": "P-central", "manager": lead.m.ID, "evidence_digest": digest}, 4)
	return k, lead, peer, guardian
}
func centralFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, m, p, g := centralUnplannedFixture(t)
	command(t, k, g, "central_fund_configure", map[string]any{"project": "P-central", "evaluator": g.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 4)
	command(t, k, g, "central_fund_plan", fundPlan(1), 4)
	command(t, k, g, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 4)
	return k, m, p, g
}
func centralOpen(t *testing.T, k Keeper, lead actor, id, solver, reviewer string) {
	command(t, k, lead, "central_task_open", map[string]any{"id": id, "project": "P-central", "title": "Check bounded result", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": solver, "reviewer_amount": reviewer, "evidence_digest": digest}, 5)
}
func centralSubmit(t *testing.T, k Keeper, a actor, id, task string) {
	command(t, k, a, "central_submit", map[string]any{"id": id, "task": task, "evidence": "42", "evidence_digest": centralDigest("42")}, 6)
}
func centralReviewInput(sub, verdict, execution string) map[string]any {
	return map[string]any{"submission": sub, "verdict": verdict, "criteria_digest": centralDigest("result equals 42"), "verification_digest": digest, "execution_id": execution, "evidence_digest": centralDigest("42")}
}
func TestCentralEarningAtomicWinnerAndSpendableAwards(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-1", "100000000", "20000000")
	centralSubmit(t, k, lead, "CS-1", "CT-1")
	rejectCommand(t, k, peer, "", "central_submit", map[string]any{"id": "CS-2", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 7)
	rejectCommand(t, k, lead, "", "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-2"), 8)
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-1", "accept", "exec-3"), 9)
	var l coin.Ledger
	get(k.Store, "coin_supply", &l)
	if l.Minted != "120000000" || l.Reserved != "0" {
		t.Fatal(l)
	}
	var balance string
	get(k.Store, "coin_balance/"+lead.m.ID, &balance)
	if balance != "100000000" {
		t.Fatal(balance)
	}
	get(k.Store, "coin_balance/"+g.m.ID, &balance)
	if balance != "20000000" {
		t.Fatal(balance)
	}
	var b CentralBudget
	get(k.Store, "central_project_budget/P-central", &b)
	if b.Paid != "120000000" || b.Reserved != "0" {
		t.Fatal(b)
	}
}
func TestCentralRejectCostsAndCombinedBudgetCap(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-1", "reject", "exec-1"), 7)
	var l coin.Ledger
	get(k.Store, "coin_supply", &l)
	if l.Minted != "20" || l.Reserved != "0" {
		t.Fatal(l)
	}
	if k.Store.Get([]byte("central_award/solver/CS-1")) != nil {
		t.Fatal("rejected solver paid")
	}
	rejectCommand(t, k, lead, "", "central_submit", map[string]any{"id": "CS-2", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 8)
	command(t, k, lead, "central_task_fund", map[string]any{"task": "CT-1", "evidence_digest": digest}, 8)
	centralSubmit(t, k, lead, "CS-2", "CT-1")
	command(t, k, g, "central_review", centralReviewInput("CS-2", "accept", "exec-2"), 9)
	var b CentralBudget
	get(k.Store, "central_project_budget/P-central", &b)
	if b.Paid != "140" || b.Reserved != "0" {
		t.Fatal(b)
	}
	rejectCommand(t, k, lead, "", "central_task_open", map[string]any{"id": "CT-cap", "project": "P-central", "title": "Over budget", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": CentralProjectAllocation, "reviewer_amount": "1", "evidence_digest": digest}, 10)
}
func TestCentralEvidenceAndAuthoritiesFailClosed(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	rejectCommand(t, k, peer, "", "central_project_start", map[string]any{"project": "P-other", "manager": peer.m.ID, "evidence_digest": digest}, 5)
	centralOpen(t, k, lead, "CT-1", "100", "20")
	rejectCommand(t, k, g, "", "central_submit", map[string]any{"id": "CS-self", "task": "CT-1", "evidence": "42", "evidence_digest": centralDigest("42")}, 6)
	rejectCommand(t, k, peer, "", "central_submit", map[string]any{"id": "CS-bad", "task": "CT-1", "evidence": "43", "evidence_digest": centralDigest("42")}, 6)
	centralSubmit(t, k, peer, "CS-1", "CT-1")
	bad := centralReviewInput("CS-1", "accept", "exec-bad")
	bad["evidence_digest"] = digest
	rejectCommand(t, k, g, "", "central_review", bad, 7)
	bad = centralReviewInput("CS-1", "accept", "exec-bad")
	bad["criteria_digest"] = digest
	rejectCommand(t, k, g, "", "central_review", bad, 7)
	var l coin.Ledger
	get(k.Store, "coin_supply", &l)
	if l.Minted != "0" || l.Reserved != "120" {
		t.Fatal(l)
	}
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-good"), 8)
}

func TestCentralDiscoveryAndCumulativeEarnings(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-index", "100", "20")
	var count string
	get(k.Store, "central_task_count", &count)
	if count != "1" {
		t.Fatal(count)
	}
	var index struct {
		ID      string `json:"id"`
		Project string `json:"project"`
	}
	get(k.Store, "central_task_index/00000000000000000001", &index)
	if index.ID != "CT-index" || index.Project != "P-central" {
		t.Fatal(index)
	}
	centralSubmit(t, k, peer, "CS-index", "CT-index")
	command(t, k, g, "central_review", centralReviewInput("CS-index", "accept", "exec-index"), 7)
	var e CentralEarnings
	get(k.Store, "central_earnings/"+g.m.ID, &e)
	if e.Reviewer != "20" || e.Solver != "0" || e.Total != "20" || e.Awards != "1" {
		t.Fatal(e)
	}
	var award struct {
		Submission string `json:"submission"`
		Role       string `json:"role"`
	}
	get(k.Store, "central_award_index/"+g.m.ID+"/00000000000000000001", &award)
	if award.Submission != "CS-index" || award.Role != "reviewer" {
		t.Fatal(award)
	}
}
func TestCentralPublicTextBounds(t *testing.T) {
	for _, s := range []string{"", "   ", string([]byte{0xff}), strings.Repeat("x", 4097)} {
		if centralText(s, centralDigest(s), 4096) {
			t.Fatal("invalid public criteria accepted")
		}
	}
	if !centralText("bounded answer", centralDigest("bounded answer"), 4096) {
		t.Fatal("valid text rejected")
	}
}

func TestCentralRevokedReviewerBlocksNewObligations(t *testing.T) {
	for _, operation := range []string{"open", "submit"} {
		t.Run(operation, func(t *testing.T) {
			k, lead, reviewer, guardian := fixture(t)
			put(k.Store, "coin_activation", CoinActivation{CoinPolicy, 2, digest})
			put(k.Store, "coin_supply", coin.Empty())
			put(k.Store, "project/P-central", Project{ID: "P-central", Lead: lead.m.ID, State: "active"})
			command(t, k, guardian, "central_earning_activate", map[string]any{"policy": CentralEarningPolicy, "reviewer": reviewer.m.ID, "evidence_digest": digest}, 3)
			command(t, k, lead, "central_project_start", map[string]any{"project": "P-central", "manager": lead.m.ID, "evidence_digest": digest}, 4)
			command(t, k, guardian, "central_fund_configure", map[string]any{"project": "P-central", "evaluator": guardian.m.ID, "expected_evaluator": "", "evidence_digest": digest}, 4)
			command(t, k, guardian, "central_fund_plan", fundPlan(1), 4)
			command(t, k, guardian, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, 4)
			if operation == "submit" {
				centralOpen(t, k, lead, "CT-revoked", "100", "20")
			}
			command(t, k, guardian, "licence", map[string]any{"member": reviewer.m.ID, "status": "revoked", "evidence_digest": digest}, 6)
			beforeSupply := string(k.Store.Get([]byte("coin_supply")))
			beforeBudget := string(k.Store.Get([]byte("central_project_budget/P-central")))
			beforeCount := string(k.Store.Get([]byte("central_task_count")))
			if operation == "open" {
				rejectCommand(t, k, lead, "", "central_task_open", map[string]any{"id": "CT-revoked", "project": "P-central", "title": "Bounded reviewer revocation fixture", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "100", "reviewer_amount": "20", "evidence_digest": digest}, 7)
			} else {
				rejectCommand(t, k, lead, "", "central_submit", map[string]any{"id": "CS-revoked", "task": "CT-revoked", "evidence": "42", "evidence_digest": centralDigest("42")}, 7)
			}
			if beforeSupply != string(k.Store.Get([]byte("coin_supply"))) || beforeBudget != string(k.Store.Get([]byte("central_project_budget/P-central"))) || beforeCount != string(k.Store.Get([]byte("central_task_count"))) {
				t.Fatal("revoked reviewer admission changed obligations")
			}
			// Existing licence policy deliberately forbids undoing permanent revocation.
			rejectCommand(t, k, guardian, "", "licence", map[string]any{"member": reviewer.m.ID, "status": "active", "evidence_digest": digest}, 8)
		})
	}
}

func TestCentralReviewerReplacementPreservesPendingAndFunds(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-rotate", "100", "20")
	centralSubmit(t, k, lead, "CS-rotate", "CT-rotate")
	var original CentralActivation
	get(k.Store, "central_earning_activation", &original)
	beforeSupply := string(k.Store.Get([]byte("coin_supply")))
	beforeBudget := string(k.Store.Get([]byte("central_project_budget/P-central")))
	replace := map[string]any{"expected_reviewer": g.m.ID, "new_reviewer": peer.m.ID, "evidence_digest": digest}
	rejectCommand(t, k, lead, "", "central_reviewer_replace", replace, 7)
	stale := map[string]any{"expected_reviewer": lead.m.ID, "new_reviewer": peer.m.ID, "evidence_digest": digest}
	rejectCommand(t, k, g, "", "central_reviewer_replace", stale, 7)
	command(t, k, g, "central_reviewer_replace", replace, 7)
	var current CentralActivation
	get(k.Store, "central_earning_activation", &current)
	if current.Height != original.Height || current.EvidenceDigest != original.EvidenceDigest || current.Reviewer != peer.m.ID || current.UpdatedHeight != 7 {
		t.Fatal(current)
	}
	if beforeSupply != string(k.Store.Get([]byte("coin_supply"))) || beforeBudget != string(k.Store.Get([]byte("central_project_budget/P-central"))) {
		t.Fatal("replacement changed money")
	}
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-rotate", "accept", "old"), 8)
	command(t, k, peer, "central_review", centralReviewInput("CS-rotate", "accept", "new"), 8)
	var earned CentralEarnings
	get(k.Store, "central_earnings/"+peer.m.ID, &earned)
	if earned.Reviewer != "20" {
		t.Fatal(earned)
	}
	rejectCommand(t, k, g, "", "central_reviewer_replace", replace, 9)
}

func TestCentralReplacementRejectsRevokedNewReviewerAndSelfReview(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-self", "100", "20")
	centralSubmit(t, k, lead, "CS-self", "CT-self")
	command(t, k, g, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 7)
	rejectCommand(t, k, g, "", "central_reviewer_replace", map[string]any{"expected_reviewer": g.m.ID, "new_reviewer": peer.m.ID, "evidence_digest": digest}, 8)
	command(t, k, g, "central_reviewer_replace", map[string]any{"expected_reviewer": g.m.ID, "new_reviewer": lead.m.ID, "evidence_digest": digest}, 8)
	rejectCommand(t, k, lead, "", "central_review", centralReviewInput("CS-self", "accept", "self"), 9)
}

func TestCentralRevokedSolverCanBeRejectedWithoutSolverPay(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-revoked-solver", "100", "20")
	centralSubmit(t, k, peer, "CS-revoked-solver", "CT-revoked-solver")
	command(t, k, g, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 7)
	rejectCommand(t, k, g, "", "central_review", centralReviewInput("CS-revoked-solver", "accept", "bad"), 8)
	command(t, k, g, "central_review", centralReviewInput("CS-revoked-solver", "reject", "reject"), 8)
	var supply coin.Ledger
	get(k.Store, "coin_supply", &supply)
	if supply.Minted != "20" || supply.Reserved != "0" || k.Store.Get([]byte("central_award/solver/CS-revoked-solver")) != nil {
		t.Fatal(supply)
	}
}

func TestCentralGuardianRecoversRevokedReviewerWithPendingWork(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	centralOpen(t, k, lead, "CT-recover", "100", "20")
	centralSubmit(t, k, lead, "CS-recover", "CT-recover")
	command(t, k, g, "central_reviewer_replace", map[string]any{"expected_reviewer": g.m.ID, "new_reviewer": peer.m.ID, "evidence_digest": digest}, 7)
	command(t, k, g, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 8)
	rejectCommand(t, k, lead, "", "central_task_fund", map[string]any{"task": "CT-recover", "evidence_digest": digest}, 9)
	command(t, k, g, "central_reviewer_replace", map[string]any{"expected_reviewer": peer.m.ID, "new_reviewer": g.m.ID, "evidence_digest": digest}, 9)
	command(t, k, g, "central_review", centralReviewInput("CS-recover", "accept", "recovered"), 10)
	var supply coin.Ledger
	get(k.Store, "coin_supply", &supply)
	if supply.Minted != "120" || supply.Reserved != "0" {
		t.Fatal(supply)
	}
}

func TestCentralAdoptionFinancialAuditBoundAndNonfinancialVolume(t *testing.T) {
	k, _, _, _ := centralFixture(t)
	for i := 0; i < 300; i++ {
		id := fmt.Sprintf("T-unpriced-%03d", i)
		put(k.Store, "task/"+id, Task{ID: id, Project: "P-central"})
	}
	if e := k.centralAdoptionFinancialAudit("P-central"); e != nil {
		t.Fatal("unpriced tasks blocked adoption", e)
	}
	for i := 0; i < CentralLegacyFinancialAuditLimit; i++ {
		id := fmt.Sprintf("T-priced-%03d", i)
		put(k.Store, "task/"+id, Task{ID: id, Project: "P-other"})
		put(k.Store, "coin_quote/"+id, CoinQuote{Task: id, Amount: "1"})
	}
	if e := k.centralAdoptionFinancialAudit("P-central"); e != nil {
		t.Fatal("complete bounded unrelated history blocked", e)
	}
	id := "T-priced-over"
	put(k.Store, "task/"+id, Task{ID: id, Project: "P-other"})
	put(k.Store, "coin_quote/"+id, CoinQuote{Task: id, Amount: "1"})
	if e := k.centralAdoptionFinancialAudit("P-central"); e == nil {
		t.Fatal("truncated legacy audit accepted")
	}
}
func TestCentralAdoptionDefensivelyChecksReservationOnlyHistory(t *testing.T) {
	k, _, _, _ := centralFixture(t)
	put(k.Store, "task/T-orphan", Task{ID: "T-orphan", Project: "P-central"})
	put(k.Store, "coin_reservation/T-orphan", CoinReservation{Task: "T-orphan", Amount: "1", State: "paid"})
	if e := k.centralAdoptionFinancialAudit("P-central"); e == nil {
		t.Fatal("reservation-only history ignored")
	}
}

func TestCentralSixRoundOpeningAllowanceIsExactlyOnce(t *testing.T) {
	k, lead, _, _ := centralFixture(t)
	var b map[string]any
	if e := get(k.Store, "central_project_budget/P-central", &b); e != nil {
		t.Fatal(e)
	}
	if b["policy"] != "central-earning-five-kpi-fund-v2" || b["allocation"] != "10000000000" || b["lifetime_ceiling"] != "1000000000000000" || b["round"] != float64(1) || b["height"] != "4" || b["evidence_digest"] != digest {
		t.Fatal(b)
	}
	before := string(k.Store.Get([]byte("central_project_budget/P-central")))
	rejectCommand(t, k, lead, "", "central_project_start", map[string]any{"project": "P-central", "manager": lead.m.ID, "evidence_digest": digest}, 5)
	if string(k.Store.Get([]byte("central_project_budget/P-central"))) != before {
		t.Fatal("opening allocation repeated")
	}
	var l coin.Ledger
	get(k.Store, "coin_supply", &l)
	if l.Minted != "0" || l.Reserved != "0" {
		t.Fatal("allowance minted funds", l)
	}
}
func TestCentralOldOneBillionPolicyRefused(t *testing.T) {
	k, _, _, g := fixture(t)
	put(k.Store, "coin_activation", CoinActivation{CoinPolicy, 2, digest})
	put(k.Store, "coin_supply", coin.Empty())
	rejectCommand(t, k, g, "", "central_earning_activate", map[string]any{"policy": "central-earning-project-budget-v1", "reviewer": g.m.ID, "evidence_digest": digest}, 3)
	if k.Store.Get([]byte("central_earning_activation")) != nil {
		t.Fatal("old policy activated")
	}
}
func TestCentralFirstRoundCannotBorrowFutureAllowance(t *testing.T) {
	k, lead, _, _ := centralFixture(t)
	rejectCommand(t, k, lead, "", "central_task_open", map[string]any{"id": "CT-future", "project": "P-central", "title": "Future rounds unavailable", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "10000000000", "reviewer_amount": "1", "evidence_digest": digest}, 5)
	centralOpen(t, k, lead, "CT-full-initial", "9999999999", "1")
	var l coin.Ledger
	get(k.Store, "coin_supply", &l)
	if l.Minted != "0" || l.Reserved != "10000000000" {
		t.Fatal(l)
	}
}
func TestCentralBudgetRejectsUnsupportedRoundAndLifetimeDrift(t *testing.T) {
	for _, change := range []map[string]any{{"round": float64(2)}, {"allocation": "1000000000000000"}, {"lifetime_ceiling": "1111110000000000"}, {"policy": "central-earning-project-budget-v1"}, {"paid": "10000000001"}} {
		k, _, _, _ := centralFixture(t)
		var b map[string]any
		get(k.Store, "central_project_budget/P-central", &b)
		for key, value := range change {
			b[key] = value
		}
		put(k.Store, "central_project_budget/P-central", b)
		if _, _, e := k.centralProject("P-central"); e == nil {
			t.Fatal("unsupported allowance accepted", change)
		}
	}
}
