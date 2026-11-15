package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

const legacyBudgetMax int64 = 9007199254740991

// Source Math.ceil(amount * binary64 share), evaluated with integers. Round the
// exact binary product to 53 significant bits, ties to even, before ceiling.
// This preserves the original JS result at large safe-integer budgets too.
func legacyBudgetUnlocked(amount int64, stage int) (int64, error) {
	if amount < 0 || amount > legacyBudgetMax || stage < 0 || stage > 3 {
		return 0, errors.New("bounded original budget/stage required")
	}
	if stage == 3 {
		return amount, nil
	}
	numerators := []int64{7378697629483821, 1152921504606847, 5764607523034235}
	shifts := []uint{66, 60, 58}
	n := new(big.Int).Mul(big.NewInt(amount), big.NewInt(numerators[stage]))
	if bits := n.BitLen(); bits > 53 {
		shift := uint(bits - 53)
		q := new(big.Int).Rsh(new(big.Int).Set(n), shift)
		remainder := new(big.Int).Sub(n, new(big.Int).Lsh(new(big.Int).Set(q), shift))
		half := new(big.Int).Lsh(big.NewInt(1), shift-1)
		cmp := remainder.Cmp(half)
		if cmp > 0 || cmp == 0 && q.Bit(0) == 1 {
			q.Add(q, big.NewInt(1))
		}
		n.Lsh(q, shift)
	}
	denominator := new(big.Int).Lsh(big.NewInt(1), shifts[stage])
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(n, denominator, remainder)
	if remainder.Sign() > 0 {
		quotient.Add(quotient, big.NewInt(1))
	}
	unlocked := quotient.Int64()
	if unlocked < 1000 {
		unlocked = 1000
	}
	if unlocked > amount {
		unlocked = amount
	}
	return unlocked, nil
}

// The independently proved mutable budget avoids rewriting unrelated bounded
// task, claim, participant and work indexes on each operator decision.
type legacyProjectBudget struct {
	Total    *int64  `json:"budget_total"`
	Stage    *int    `json:"budget_stage"`
	Basis    *string `json:"budget_basis"`
	Status   string  `json:"budget_status"`
	Unlocked int64   `json:"budget_unlocked"`
}

// A derived compact index keeps a project's committed-prize census bounded in
// gas independently of immutable KPI/evidence body sizes. Old captures fall
// back to their original task records; all native task mutations update it.
type legacyTaskBudget struct {
	ID      string `json:"id"`
	Project string `json:"project"`
	State   string `json:"state"`
	Price   *int64 `json:"price"`
	Winner  string `json:"winner"`
}

func legacyWriteTaskBudget(s Store, t LegacyTask) error {
	return put(s, "legacy_task_budget/"+t.ID, legacyTaskBudget{t.ID, t.Project, t.State, t.Price, t.Winner})
}
func (k Keeper) legacyTaskBudget(id string) (legacyTaskBudget, error) {
	var v legacyTaskBudget
	// Older mutable overlays take precedence over an imported source index.
	// Native writes now always refresh the compact mutable record.
	raw := k.Store.Get([]byte("legacy_task_budget/" + id))
	if raw == nil && k.Store.Get([]byte("legacy_task/"+id)) == nil {
		raw = k.Store.Get([]byte("legacy/task_budget/" + id))
	}
	if raw != nil {
		if e := json.Unmarshal(raw, &v); e != nil {
			return v, e
		}
		if v.ID != id {
			return v, errors.New("original task budget index mismatch")
		}
		return v, nil
	}
	t, e := k.legacyTask(id)
	return legacyTaskBudget{t.ID, t.Project, t.State, t.Price, t.Winner}, e
}
func (k Keeper) legacyBudgetCommitted(project legacyProject) (int64, error) {
	ids, e := k.legacyProjectTaskIDs(project)
	if e != nil {
		return 0, e
	}
	var committed int64
	for _, id := range ids {
		task, e := k.legacyTaskBudget(id)
		if e != nil {
			return 0, e
		}
		if task.Project != project.ID {
			return 0, errors.New("original project task index mismatch")
		}
		if task.Price != nil && (task.State != "closed" || task.Winner != "") {
			if *task.Price < 0 || *task.Price > MaxReward {
				return 0, errors.New("invalid original committed price")
			}
			committed += *task.Price
		}
	}
	return committed, nil
}
func (k Keeper) legacyBudgetChange(c Command, now time.Time, unlock bool) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" {
		return "", errors.New("current guardian's explicit original operator budget decision required")
	}
	var p struct {
		Project  string  `json:"project"`
		Amount   *int64  `json:"amount,omitempty"`
		Basis    *string `json:"basis,omitempty"`
		Evidence string  `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !digestPattern.MatchString(p.Evidence) || p.Basis != nil && len(*p.Basis) > 4000 {
		return "", errors.New("bounded original budget evidence/basis required")
	}
	policy, e := k.legacyPublicPolicy()
	if e != nil || policy == nil {
		return "", errors.New("explicit original public policy capture required")
	}
	project, e := k.legacyProject(p.Project)
	if e != nil {
		return "", e
	}
	before := project
	stage := 0
	if project.BudgetStage != nil {
		stage = *project.BudgetStage
	}
	amount := int64(0)
	if project.BudgetTotal != nil {
		amount = *project.BudgetTotal
	}
	op := "allocate"
	if unlock {
		op = "unlock"
		if p.Amount != nil || project.BudgetStatus != "allocated" || stage >= 3 {
			return "", errors.New("allocated original budget with next locked stage required")
		}
		stage++
	} else {
		if p.Amount == nil || *p.Amount < 0 || *p.Amount > legacyBudgetMax {
			return "", errors.New("exact safe-integer original budget required")
		}
		amount = *p.Amount
		committed, e := k.legacyBudgetCommitted(project)
		if e != nil {
			return "", e
		}
		if amount < committed {
			return "", errors.New("original budget below already committed task prizes")
		}
		project.BudgetStatus = "allocated"
	}
	unlocked, e := legacyBudgetUnlocked(amount, stage)
	if e != nil {
		return "", e
	}
	project.BudgetTotal = &amount
	project.BudgetStage = &stage
	project.BudgetUnlocked = unlocked
	if p.Basis != nil && !unlock {
		project.BudgetBasis = p.Basis
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	key := fmt.Sprintf("%020d", event)
	if k.Store.Get([]byte("legacy_budget_decision/"+key)) != nil {
		return "", errors.New("original budget decision already recorded")
	}
	if e = put(k.Store, "legacy_project_budget/"+project.ID, legacyProjectBudget{project.BudgetTotal, project.BudgetStage, project.BudgetBasis, project.BudgetStatus, project.BudgetUnlocked}); e != nil {
		return "", e
	}
	return project.ID, put(k.Store, "legacy_budget_decision/"+key, map[string]any{"event": key, "operation": op, "project": project.ID, "guardian": c.Member, "before": map[string]any{"budget_total": before.BudgetTotal, "budget_stage": before.BudgetStage, "budget_unlocked": before.BudgetUnlocked, "budget_status": before.BudgetStatus}, "after": map[string]any{"budget_total": amount, "budget_stage": stage, "budget_unlocked": unlocked, "budget_status": project.BudgetStatus}, "basis": p.Basis, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)})
}
func (k Keeper) legacyProjectDoneWhen(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Project  string `json:"project"`
		Actor    string `json:"actor"`
		DoneWhen string `json:"done_when"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	p.DoneWhen = strings.TrimSpace(p.DoneWhen)
	if len(p.DoneWhen) < 1 || len(p.DoneWhen) > 4000 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("bounded original completion criterion/evidence required")
	}
	project, e := k.legacyProject(p.Project)
	if e != nil {
		return "", e
	}
	a, e := k.legacyActor(p.Actor)
	if e != nil {
		return "", e
	}
	if a.ID != project.Lead || a.Member != c.Member || c.Instance != "" && c.Instance != a.ID {
		return "", errors.New("exact original project lead must sign criterion amendment")
	}
	if e = k.validateInstance(c.Member, a.ID); e != nil {
		return "", e
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	key := fmt.Sprintf("%020d", event)
	if k.Store.Get([]byte("legacy_project_criteria_revision/"+key)) != nil {
		return "", errors.New("original criterion revision already recorded")
	}
	record := map[string]any{"event": key, "project": project.ID, "actor": a.ID, "member": c.Member, "done_when": p.DoneWhen, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)}
	if e = put(k.Store, "legacy_project_criteria_revision/"+key, record); e != nil {
		return "", e
	}
	return project.ID, put(k.Store, "legacy_project_criteria/"+project.ID, record)
}
