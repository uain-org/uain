package federation

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func legacyBudgetFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, a, p, d := legacyResearchFixture(t)
	_ = put(k.Store, "legacy/policy", map[string]any{"version": 1, "daily_credit_cap": "10000", "bootstrap_operators": 3, "issuance_total": "0"})
	_ = put(k.Store, "legacy_project/old-project", map[string]any{"id": "old-project", "state": "active", "lead": "old-author", "task_ids": []string{"old-task"}, "budget_status": "proposed", "budget_total": 10000000, "budget_stage": 0, "budget_unlocked": 0})
	return k, a, p, d
}
func legacyBudgetTestProject(k Keeper, p *map[string]any) error {
	v, e := k.legacyProject("old-project")
	if e != nil {
		return e
	}
	raw, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return json.Unmarshal(raw, p)
}
func TestLegacyBudgetOnlyExplicitGuardianOperatorMayAllocateAndUnlock(t *testing.T) {
	k, a, p, d := legacyBudgetFixture(t)
	payload := map[string]any{"project": "old-project", "amount": 10000000, "basis": "The operator approves this original project budget with recorded public evidence.", "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_budget_allocate", payload, 10)
	guardianReject(t, k, p, "legacy_budget_allocate", payload, 10)
	command(t, k, d, "legacy_budget_allocate", payload, 10)
	var project map[string]any
	_ = legacyBudgetTestProject(k, &project)
	if project["budget_status"] != "allocated" || project["budget_total"] != float64(10000000) || project["budget_unlocked"] != float64(1000) {
		t.Fatal(project)
	}
	unlock := map[string]any{"project": "old-project", "basis": "The operator verifies the original milestone before releasing this next stage.", "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_budget_unlock", unlock, 11)
	for stage, want := range []float64{10000, 200000, 10000000} {
		command(t, k, d, "legacy_budget_unlock", unlock, 11+int64(stage))
		_ = legacyBudgetTestProject(k, &project)
		if project["budget_stage"] != float64(stage+1) || project["budget_unlocked"] != want {
			t.Fatal(project)
		}
	}
	guardianReject(t, k, d, "legacy_budget_unlock", unlock, 14)
	if project["budget_basis"] != payload["basis"] {
		t.Fatal("stage release rewrote original allocation basis", project)
	}
	for _, x := range []actor{a, p, d} {
		m, _ := k.Member(x.m.ID)
		if m.Credits != "0" {
			t.Fatal("budget decision minted credits", m)
		}
	}
	var original map[string]any
	_ = get(k.Store, "legacy/project/old-project", &original)
	if _, ok := original["budget_status"]; ok {
		t.Fatal("original source bytes changed", original)
	}
}
func TestLegacyBudgetPreservesCommittedPrizesAndSourceOperatorScope(t *testing.T) {
	k, _, _, d := legacyBudgetFixture(t)
	payload := map[string]any{"project": "old-project", "amount": 19, "evidence_digest": digest}
	guardianReject(t, k, d, "legacy_budget_allocate", payload, 10)
	payload["amount"] = 20
	command(t, k, d, "legacy_budget_allocate", payload, 11)
	task, _ := k.legacyTask("old-task")
	task.State = "closed"
	_ = put(k.Store, "legacy_task/old-task", task)
	payload["amount"] = 0
	command(t, k, d, "legacy_budget_allocate", payload, 12)
	task.Winner = "historic-paid-winner"
	_ = put(k.Store, "legacy_task/old-task", task)
	guardianReject(t, k, d, "legacy_budget_allocate", payload, 13)
	// Original operator allocation is not restricted by original project state.
	task.Winner = ""
	_ = put(k.Store, "legacy_task/old-task", task)
	var project map[string]any
	_ = legacyBudgetTestProject(k, &project)
	project["state"] = "halted"
	_ = put(k.Store, "legacy_project/old-project", project)
	command(t, k, d, "legacy_budget_allocate", payload, 14)
	payload["amount"] = 9007199254740992
	guardianReject(t, k, d, "legacy_budget_allocate", payload, 15)
}
func TestLegacyProjectDoneWhenIsExactLeadAndImmutable(t *testing.T) {
	k, a, p, d := legacyBudgetFixture(t)
	payload := map[string]any{"project": "old-project", "actor": "old-peer", "done_when": "The specified independently observable condition is met.", "evidence_digest": digest}
	guardianReject(t, k, p, "legacy_project_done_when", payload, 10)
	payload["actor"] = "old-author"
	guardianReject(t, k, d, "legacy_project_done_when", payload, 10)
	command(t, k, a, "legacy_project_done_when", payload, 10)
	var first map[string]any
	_ = get(k.Store, "legacy_project_criteria/old-project", &first)
	event := first["event"].(string)
	immutable := append([]byte{}, k.Store.Get([]byte("legacy_project_criteria_revision/"+event))...)
	payload["done_when"] = "A later precise condition replaces the original completion criterion."
	command(t, k, a, "legacy_project_done_when", payload, 11)
	if string(immutable) != string(k.Store.Get([]byte("legacy_project_criteria_revision/"+event))) {
		t.Fatal("completion amendment history rewritten")
	}
	payload["done_when"] = strings.Repeat(" ", 40)
	guardianReject(t, k, a, "legacy_project_done_when", payload, 12)
}
func TestLegacyBudgetOriginalIEEEIntegerOutputVectors(t *testing.T) {
	path := os.Getenv("UAIN_LEGACY_BUDGET_VECTORS")
	if path == "" {
		t.Skip("independent Node corpus supplied by isolated server qualification")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var rows []struct {
		Budget   int64 `json:"budget"`
		Stage    int   `json:"stage"`
		Expected int64 `json:"expected"`
	}
	if e = json.Unmarshal(raw, &rows); e != nil {
		t.Fatal(e)
	}
	for _, r := range rows {
		got, e := legacyBudgetUnlocked(r.Budget, r.Stage)
		if e != nil || got != r.Expected {
			t.Fatal("source Math.ceil parity", r, got, e)
		}
	}
	t.Logf("independent Node binary64 vectors=%d", len(rows))
}

func TestLegacyBudgetBinaryIntegerRoundingBounds(t *testing.T) {
	for _, row := range []struct {
		amount int64
		stage  int
		want   int64
	}{{0, 0, 0}, {999, 0, 999}, {10000000, 0, 1000}, {10000000, 1, 10000}, {10000000, 2, 200000}, {10000000, 3, 10000000}, {9007199254740991, 0, 900719925475}, {9007199254740991, 1, 9007199254741}, {9007199254740991, 2, 180143985094820}} {
		got, e := legacyBudgetUnlocked(row.amount, row.stage)
		if e != nil || got != row.want {
			t.Fatal(row, got, e)
		}
	}
	for _, row := range []struct {
		amount int64
		stage  int
	}{{-1, 0}, {9007199254740992, 0}, {1, -1}, {1, 4}} {
		if _, e := legacyBudgetUnlocked(row.amount, row.stage); e == nil {
			t.Fatal("invalid budget/stage accepted", row)
		}
	}
}

func TestLegacyBudgetCompactSourceAndMutablePrecedence(t *testing.T) {
	k, _, _, _ := legacyBudgetFixture(t)
	source := legacyTaskBudget{ID: "old-task", Project: "old-project", State: "closed"}
	if e := put(k.Store, "legacy/task_budget/old-task", source); e != nil {
		t.Fatal(e)
	}
	task, e := k.legacyTaskBudget("old-task")
	if e != nil || task.State != "closed" {
		t.Fatal(task, e)
	}
	original, e := k.legacyTask("old-task")
	if e != nil {
		t.Fatal(e)
	}
	// An old mutable overlay without the new index supersedes the source index.
	raw, _ := json.Marshal(original)
	k.Store.Set([]byte("legacy_task/old-task"), raw)
	task, e = k.legacyTaskBudget("old-task")
	if e != nil || task.State != "open" {
		t.Fatal(task, e)
	}
	// Both typed value and pointer writes keep the compact record current.
	original.State = "closed"
	if e = put(k.Store, "legacy_task/old-task", &original); e != nil {
		t.Fatal(e)
	}
	task, e = k.legacyTaskBudget("old-task")
	if e != nil || task.State != "closed" {
		t.Fatal(task, e)
	}
	original.State = "open"
	if e = put(k.Store, "legacy_task/old-task", original); e != nil {
		t.Fatal(e)
	}
	task, e = k.legacyTaskBudget("old-task")
	if e != nil || task.State != "open" {
		t.Fatal(task, e)
	}
}
