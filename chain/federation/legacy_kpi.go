package federation

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strings"
	"time"
)

func (k Keeper) legacyFrozenKPI(v *LegacyWork, now time.Time) error {
	task, e := k.legacyTask(v.Task)
	if e != nil {
		return e
	}
	if task.Outcome == "" {
		return nil
	}
	if task.Outcome != "met" || task.Known {
		v.Pending = ""
		v.Withheld = "kpi_" + task.Outcome
		if task.Known {
			v.Withheld = "known"
		}
		v.Paid = true
		return put(k.Store, "legacy_work/"+v.ID, v)
	}
	if v.Paid {
		return errors.New("frozen KPI already paid")
	}
	checks := []LegacyCheck{}
	refs := v.Held.CheckRefs
	if len(refs) == 0 {
		for _, id := range v.Held.Verifications {
			refs = append(refs, new(big.Int).SetInt64(id).String())
		}
	}
	for _, id := range refs {
		found := false
		for _, c := range v.Checks {
			if c.ID == id && c.Verdict != "disputed" {
				checks = append(checks, c)
				found = true
				break
			}
		}
		if !found {
			return errors.New("original frozen verifier reference missing")
		}
	}
	v.Pending = ""
	if task.Price != nil && len(v.Reconciles) == 0 {
		if v.Due == nil {
			n := v.Held.Credibility
			v.Due = &n
		}
		if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
			return e
		}
		return k.legacyPrize(task.ID, now)
	}
	if len(checks) > 4 {
		return k.legacyStageAward(v, v.Held.Credibility, v.Held.Credits, checks)
	}
	if e = k.legacyPay(v, v.Held.Credibility, v.Held.Credits, checks, now); e != nil {
		return e
	}
	v.Paid = true
	return put(k.Store, "legacy_work/"+v.ID, v)
}

var legacyDecimal = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

func legacyObserved(kpi json.RawMessage, observed json.RawMessage) (bool, error) {
	var k struct {
		Comparator string          `json:"comparator"`
		Threshold  json.RawMessage `json:"threshold"`
	}
	if e := json.Unmarshal(kpi, &k); e != nil {
		return false, e
	}
	if k.Comparator == "occurs" {
		var value bool
		if e := json.Unmarshal(observed, &value); e != nil {
			return false, errors.New("original occurs KPI needs boolean observation")
		}
		return value, nil
	}
	text := string(observed)
	if strings.HasPrefix(text, `"`) {
		if e := json.Unmarshal(observed, &text); e != nil {
			return false, e
		}
	}
	if len(text) > 100 || len(k.Threshold) > 100 || !legacyDecimal.MatchString(text) || !legacyDecimal.Match(k.Threshold) {
		return false, errors.New("bounded exact decimal KPI observation required")
	}
	a, ok := legacyNumber(text)
	if !ok {
		return false, errors.New("invalid KPI observation")
	}
	b, ok := legacyNumber(string(k.Threshold))
	if !ok {
		return false, errors.New("invalid original threshold")
	}
	cmp := a.Cmp(b)
	switch k.Comparator {
	case ">=":
		return cmp >= 0, nil
	case "<=":
		return cmp <= 0, nil
	case "==":
		return cmp == 0, nil
	}
	return false, errors.New("unknown original KPI comparator")
}
func (k Keeper) legacyResolveKPI(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Task     string          `json:"task"`
		Resolver string          `json:"resolver"`
		Observed json.RawMessage `json:"observed"`
		Source   string          `json:"source"`
		Note     string          `json:"note"`
		Evidence string          `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	task, e := k.legacyTask(p.Task)
	if e != nil {
		return "", e
	}
	if task.Kind != "future" || task.Outcome != "" || len(strings.TrimSpace(p.Note)) < 20 || len(p.Note) > 2000 || !kpiSource(p.Source) || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("original future KPI/source/note/evidence required")
	}
	a, e := k.legacyActor(p.Resolver)
	if e != nil {
		return "", e
	}
	if a.Member != c.Member || c.Instance != "" && c.Instance != a.ID || (!a.Default && !a.Arbiter) {
		return "", errors.New("exact source default verifier/trusted arbiter required")
	}
	if e = k.validateInstance(c.Member, a.ID); e != nil {
		return "", e
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return "", e
	}
	if project.State == "halted" {
		return "", errors.New("original project closed")
	}
	lead, e := k.legacyActor(project.Lead)
	if e != nil {
		return "", e
	}
	creator, e := k.legacyActor(task.Creator)
	if e != nil {
		return "", e
	}
	if a.Member == lead.Member || a.Member == creator.Member {
		return "", errors.New("KPI resolver is original project lead/task creator")
	}
	joined := false
	for _, p := range a.Projects {
		joined = joined || p == task.Project
	}
	if !joined {
		return "", errors.New("original project membership required")
	}
	for _, id := range task.Contributions {
		v, e := k.legacyWorkStatus(id)
		if e != nil {
			return "", e
		}
		if v.Task != task.ID || v.Project != task.Project {
			return "", errors.New("original task/status index mismatch")
		}
		if v.State != "rejected" && v.Member == a.Member {
			return "", errors.New("KPI resolver contributed original work")
		}
	}
	deadline, err := time.Parse(time.RFC3339Nano, task.Resolves)
	if err != nil {
		deadline, err = time.Parse("2006-01-02", task.Resolves)
		deadline = deadline.Add(24 * time.Hour)
	}
	if err != nil {
		return "", errors.New("original KPI deadline missing")
	}
	if !now.Before(deadline.Add(30 * 24 * time.Hour)) {
		return "", errors.New("original KPI expired unresolved")
	}
	challenges, e := k.legacyChallenges(task.Project, task.ID, "prior_art")
	if e != nil {
		return "", e
	}
	for _, v := range challenges {
		if v.State == "open" {
			return "", errors.New("original prior-art challenge remains open")
		}
	}
	met, e := legacyObserved(task.KPI, p.Observed)
	if e != nil {
		return "", e
	}
	task.State = "closed"
	task.Outcome = "unmet"
	if met {
		task.Outcome = "met"
	}
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	if e = put(k.Store, "legacy_kpi_resolution/"+task.ID, map[string]any{"member": a.Member, "instance": a.ID, "observed": p.Observed, "source": p.Source, "note": p.Note, "evidence_digest": p.Evidence, "outcome": task.Outcome}); e != nil {
		return "", e
	}
	if e = k.legacyMootChallenges(task.Project, task.ID, "prior_art"); e != nil {
		return "", e
	}
	if e = k.legacyApplySingleton(task, now); e != nil {
		return "", e
	}

	return task.ID, nil
}
