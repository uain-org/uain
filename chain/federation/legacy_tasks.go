package federation

import (
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"time"
)

func (k Keeper) legacyParticipant(c Command, id, project string) (LegacyActor, error) {
	a, e := k.legacyActor(id)
	if e != nil {
		return a, e
	}
	if a.Member != c.Member || c.Instance != "" && c.Instance != id {
		return a, errors.New("signing member must own original instance")
	}
	if e = k.validateInstance(c.Member, id); e != nil {
		return a, e
	}
	joined := false
	for _, p := range a.Projects {
		joined = joined || p == project
	}
	if !joined {
		return a, errors.New("original project membership required")
	}
	p, e := k.legacyProject(project)
	if e != nil {
		return a, e
	}
	if p.State == "halted" || p.State == "complete" {
		return a, errors.New("original project closed")
	}
	return a, nil
}
func (k Keeper) legacySubmit(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		ID       string `json:"id"`
		Task     string `json:"task"`
		Author   string `json:"author"`
		Title    string `json:"title"`
		Detail   string `json:"detail"`
		Claim    string `json:"claim"`
		Claimed  int64  `json:"karma_claimed"`
		Required int    `json:"verifiers_required"`
		Forecast *struct {
			Statement   string `json:"statement"`
			Probability string `json:"probability"`
			Horizon     string `json:"horizon"`
		} `json:"forecast"`
		Reconciles []string        `json:"reconciles"`
		Sources    []string        `json:"sources"`
		Artifacts  json.RawMessage `json:"artifacts"`
		Evidence   string          `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !validID(p.ID) || len(p.Title) < 5 || len(p.Title) > 200 || len(strings.TrimSpace(p.Detail)) < 20 || len(p.Detail) > 8000 || len(strings.TrimSpace(p.Claim)) < 20 || len(p.Claim) > 4000 || len(p.Artifacts) > 8000 || len(p.Sources) > 16 || len(p.Reconciles) > 32 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("bounded original research/claim/evidence required")
	}
	for _, key := range []string{"legacy/work/", "legacy_work/", "contribution/", "legacy/reserved/contributions/"} {
		if k.Store.Get([]byte(key+p.ID)) != nil {
			return "", errors.New("contribution ID already reserved")
		}
	}
	task, e := k.legacyTask(p.Task)
	if e != nil {
		return "", e
	}
	if task.State != "open" || task.Known || len(task.Contributions) >= 128 {
		return "", errors.New("original task closed/known or submission bound reached")
	}
	if task.Kind == "future" {
		end, e := deadline(task.Resolves)
		if e != nil || task.Outcome != "" || !now.Before(end) {
			return "", errors.New("original future task no longer takes submissions")
		}
	}
	if task.AnswerType == "forecast" && len(p.Reconciles) == 0 {
		if p.Forecast == nil || len(strings.TrimSpace(p.Forecast.Statement)) < 1 || len(p.Forecast.Statement) > 4000 || len(p.Forecast.Horizon) > 200 || len(p.Forecast.Probability) > 100 || !legacyDecimal.MatchString(p.Forecast.Probability) {
			return "", errors.New("bounded original forecast probability/statement required")
		}
		probability, ok := legacyNumber(p.Forecast.Probability)
		if !ok || probability.Sign() < 0 || probability.Cmp(big.NewRat(1, 1)) > 0 {
			return "", errors.New("original forecast probability must be zero to one")
		}
	}
	a, e := k.legacyParticipant(c, p.Author, task.Project)
	if e != nil {
		return "", e
	}
	if e = k.legacyReopen(task.Project); e != nil {
		return "", e
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return "", e
	}
	if project.EvidenceCutoff != "" {
		checkable := false
		for _, source := range p.Sources {
			checkable = checkable || kpiSource(source)
		}
		if !checkable {
			return "", errors.New("original evidence cutoff requires checkable source")
		}
	}
	held := 0
	if len(project.WorkIDs) >= 128 {
		return "", errors.New("original project work bound")
	}
	for _, id := range project.WorkIDs {
		v, e := k.legacyWork(id)
		if e != nil {
			return "", e
		}
		if v.Author == a.ID && (v.State == "held" || v.State == "contested") {
			held++
		}
	}
	for _, id := range task.Contributions {
		v, e := k.legacyWork(id)
		if e != nil {
			return "", e
		}
		if v.Author == a.ID && (v.State == "held" || v.State == "contested") {
			return "", errors.New("original answer already held for this instance/task")
		}
	}
	if held >= 5 && !a.Default && !a.Creator {
		return "", errors.New("original held-per-project bound")
	}
	if len(p.Reconciles) == 1 {
		return "", errors.New("original comparison needs at least two results")
	}
	seen, members := map[string]bool{}, map[string]bool{}
	for _, id := range p.Reconciles {
		v, e := k.legacyWork(id)
		if e != nil {
			return "", e
		}
		if seen[id] || v.Task != task.ID || v.Member == a.Member || v.State == "rejected" {
			return "", errors.New("comparison must cite distinct standing results of other members")
		}
		seen[id] = true
		members[v.Member] = true
	}
	if len(p.Reconciles) > 0 && len(members) < 2 {
		return "", errors.New("original comparison needs two different members")
	}
	amount := p.Claimed
	if amount < 0 {
		amount = 0
	}
	if amount > 100 {
		amount = 100
	}
	if task.Price != nil && len(p.Reconciles) == 0 {
		amount = *task.Price
	}
	required := 2
	if p.Required == 1 {
		required = 1
	}
	v := LegacyWork{ID: p.ID, Project: task.Project, Task: task.ID, Author: a.ID, Member: a.Member, Kind: "work", State: "held", Claimed: amount, Required: required, Statement: p.Claim, Submitted: now.UTC().Format(time.RFC3339Nano), Reconciles: p.Reconciles, Checks: []LegacyCheck{}}
	if e = put(k.Store, "legacy_submission/"+v.ID, map[string]any{"policy": LegacyImportPolicy, "member": c.Member, "instance": a.ID, "submitted_at": v.Submitted, "payload": c.Payload}); e != nil {
		return "", e
	}
	if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
		return "", e
	}
	task.Contributions = append(task.Contributions, v.ID)
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	project.WorkIDs = append(project.WorkIDs, v.ID)
	if e = put(k.Store, "legacy_project/"+project.ID, project); e != nil {
		return "", e
	}
	return v.ID, nil
}
func (k Keeper) legacyTaskClose(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Task     string `json:"task"`
		Actor    string `json:"actor"`
		Reason   string `json:"reason"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if len(strings.TrimSpace(p.Reason)) < 20 || len(p.Reason) > 2000 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("original close reason/evidence required")
	}
	task, e := k.legacyTask(p.Task)
	if e != nil {
		return "", e
	}
	a, e := k.legacyActor(p.Actor)
	if e != nil {
		return "", e
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return "", e
	}
	if a.Member != c.Member || c.Instance != "" && c.Instance != a.ID || a.ID != task.Creator && a.ID != project.Lead || task.State != "open" {
		return "", errors.New("exact original creator/lead required to close open task")
	}
	if e = k.validateInstance(c.Member, a.ID); e != nil {
		return "", e
	}
	if e = k.legacyMootChallenges(task.Project, task.ID, "prior_art"); e != nil {
		return "", e
	}
	task.State = "closed"
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	return task.ID, put(k.Store, "legacy_task_closed/"+task.ID, map[string]any{"member": c.Member, "instance": a.ID, "reason": p.Reason, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano), "existing_claims_remain_valid": true})
}
