package federation

import (
	"encoding/json"
	"errors"
	"time"
)

type LegacyWorkStatus struct {
	ID         string `json:"id"`
	Project    string `json:"project"`
	Task       string `json:"task"`
	Member     string `json:"member"`
	Kind       string `json:"kind"`
	Comparison bool   `json:"comparison"`
	Withheld   string `json:"withheld"`
	State      string `json:"state"`
	Pending    string `json:"pending"`
	Paid       bool   `json:"paid"`
}

func legacyWriteWorkStatus(s Store, w LegacyWork) error {
	if e := legacyFreezeAward(s, w); e != nil {
		return e
	}
	status := LegacyWorkStatus{ID: w.ID, Project: w.Project, Task: w.Task, Member: w.Member, Kind: w.Kind, Comparison: len(w.Reconciles) > 0, Withheld: w.Withheld, State: w.State, Pending: w.Pending, Paid: w.Paid}
	raw, e := json.Marshal(status)
	if e != nil {
		return e
	}
	s.Set([]byte("legacy_work_status/"+w.ID), raw)
	return nil
}
func (k Keeper) legacyWorkStatus(id string) (LegacyWorkStatus, error) {
	var v LegacyWorkStatus
	if k.Store.Get([]byte("legacy_work_status/"+id)) != nil {
		e := get(k.Store, "legacy_work_status/"+id, &v)
		if e == nil && v.ID != id {
			e = errors.New("original work status identity mismatch")
		}
		return v, e
	}
	w, e := k.legacyWork(id)
	return LegacyWorkStatus{ID: w.ID, Project: w.Project, Task: w.Task, Member: w.Member, Kind: w.Kind, Comparison: len(w.Reconciles) > 0, Withheld: w.Withheld, State: w.State, Pending: w.Pending, Paid: w.Paid}, e
}
func (k Keeper) legacyTaskFinalBlocks(task LegacyTask) bool {
	return task.Known || task.Outcome == "expired" || k.Store.Get([]byte("legacy_malevolent/"+task.Project+"/"+task.ID)) != nil
}
func (k Keeper) legacyApplyFutureWork(w *LegacyWork, task LegacyTask, now time.Time) error {
	if w.Paid {
		return errors.New("original future award already materialized")
	}
	why := ""
	if k.Store.Get([]byte("legacy_malevolent/"+task.Project+"/"+task.ID)) != nil {
		why = "malevolent"
	} else if task.Known {
		why = "known"
	} else if task.Outcome == "expired" {
		why = "kpi_expired"
	}
	if why != "" {
		if w.State == "held" || w.State == "contested" {
			w.State = "rejected"
		}
		w.Pending = ""
		w.Withheld = why
		w.Paid = true
		return put(k.Store, "legacy_work/"+w.ID, *w)
	}
	if w.Pending != "kpi" || w.Held == nil || w.State != "settled" || task.Outcome == "" {
		return errors.New("final original KPI and immutable verified award hold required")
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return e
	}
	if project.State == "halted" {
		return errors.New("original project halted before award materialization")
	}
	return k.legacyFrozenKPI(w, now)
}
func (k Keeper) legacyFutureApply(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Contribution string `json:"contribution"`
		Recipient    *int   `json:"recipient,omitempty"`
		Evidence     string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("future materialization evidence required")
	}
	w, e := k.legacyWork(p.Contribution)
	if e != nil {
		return "", e
	}
	if w.Paid || k.Store.Get([]byte("legacy_future_application/"+w.ID)) != nil {
		return "", errors.New("original future award already materialized")
	}
	task, e := k.legacyTask(w.Task)
	if e != nil {
		return "", e
	}
	if task.Project != w.Project {
		return "", errors.New("future work/task project mismatch")
	}
	if k.Store.Get([]byte("legacy_future_award/"+w.ID)) == nil {
		if e = k.legacyApplyFutureWork(&w, task, now); e != nil {
			return "", e
		}
		w, e = k.legacyWork(w.ID)
		if e != nil {
			return "", e
		}
	}
	if p.Recipient != nil && k.Store.Get([]byte("legacy_future_award/"+w.ID)) == nil {
		return "", errors.New("recipient index requires a large immutable award plan")
	}
	if w.Pending == "kpi_award" {
		if e = k.legacyApplyAwardSlot(&w, task, p.Recipient, c.Member, p.Evidence, now); e != nil {
			return "", e
		}
	}
	if !w.Paid {
		return w.ID, nil
	}
	return w.ID, put(k.Store, "legacy_future_application/"+w.ID, map[string]any{"task": task.ID, "outcome": task.Outcome, "known": task.Known, "withheld": w.Withheld, "member": c.Member, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)})
}

// A singleton remains cheap. Multiple obligations are committed as due by the
// final task decision and materialized individually under the normal gas cap.
func (k Keeper) legacyApplySingleton(task LegacyTask, now time.Time) error {
	eligible := ""
	for _, id := range task.Contributions {
		status, e := k.legacyWorkStatus(id)
		if e != nil {
			return e
		}
		if status.Task != task.ID || status.Project != task.Project {
			return errors.New("original task/status index mismatch")
		}
		if status.Paid || status.State == "rejected" && status.Pending == "" {
			continue
		}
		if status.Pending != "kpi" && !k.legacyTaskFinalBlocks(task) {
			continue
		}
		if eligible != "" {
			return nil
		}
		eligible = id
	}
	if eligible == "" {
		return nil
	}
	w, e := k.legacyWork(eligible)
	if e != nil {
		return e
	}
	return k.legacyApplyFutureWork(&w, task, now)
}
