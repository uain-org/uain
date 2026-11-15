package federation

import (
	"encoding/json"
	"errors"
	"sort"
)

// Full immutable source indexes are emitted in new capture profiles. Old
// profiles use a bounded, deterministic census; no omitted index means empty.
func (k Keeper) legacyProjectTaskIDs(p legacyProject) ([]string, error) {
	if p.TaskIDs != nil {
		return append([]string{}, p.TaskIDs...), nil
	}
	var captured legacyProject
	if raw := k.Store.Get([]byte("legacy/project/" + p.ID)); raw != nil {
		if e := json.Unmarshal(raw, &captured); e != nil {
			return nil, e
		}
		if captured.TaskIDs != nil {
			return append([]string{}, captured.TaskIDs...), nil
		}
	}
	ids := []string{}
	for _, prefix := range []string{"legacy/task/", "legacy_task/"} {
		rows, e := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), 129)
		if e != nil {
			return nil, e
		}
		if len(rows) > 128 {
			return nil, errors.New("old snapshot task census bound; complete captured index required")
		}
		for _, row := range rows {
			var task LegacyTask
			if e = json.Unmarshal(row.Value, &task); e != nil {
				return nil, e
			}
			if task.Project == p.ID && !guardianContains(ids, task.ID) {
				ids = append(ids, task.ID)
			}
		}
	}
	sort.Strings(ids)
	return ids, nil
}
func (k Keeper) legacyProjectFinished(p legacyProject) (bool, error) {
	if p.State == "halted" {
		return false, nil
	}
	if p.State == "complete" {
		return true, nil
	}
	participants := p.ParticipantIDs
	if participants == nil {
		participants = []string{}
		for _, prefix := range []string{"legacy/actor/", "legacy_actor/"} {
			rows, e := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), 129)
			if e != nil {
				return false, e
			}
			if len(rows) > 128 {
				return false, errors.New("old snapshot participant census bound")
			}
			for _, row := range rows {
				var actor LegacyActor
				if e = json.Unmarshal(row.Value, &actor); e != nil {
					return false, e
				}
				if guardianContains(actor.Projects, p.ID) && !guardianContains(participants, actor.ID) {
					participants = append(participants, actor.ID)
				}
			}
		}
	}
	if len(participants) < 2 {
		return false, nil
	}
	for _, id := range p.WorkIDs {
		w, e := k.legacyWork(id)
		if e != nil {
			return false, e
		}
		if w.State == "held" || w.State == "contested" {
			return false, nil
		}
	}
	tasks, e := k.legacyProjectTaskIDs(p)
	if e != nil {
		return false, e
	}
	done := len(tasks) == 0 && len(p.WorkIDs) > 0
	for _, id := range tasks {
		task, e := k.legacyTask(id)
		if e != nil {
			return false, e
		}
		if task.Project != p.ID {
			return false, errors.New("original task index crosses projects")
		}
		if task.State == "closed" {
			continue
		}
		standing, comparisons := []LegacyWork{}, []LegacyWork{}
		members, settled := map[string]bool{}, map[string]bool{}
		for _, id := range task.Contributions {
			w, e := k.legacyWork(id)
			if e != nil {
				return false, e
			}
			if w.State == "rejected" {
				continue
			}
			if len(w.Reconciles) > 0 {
				comparisons = append(comparisons, w)
			} else {
				standing = append(standing, w)
				members[w.Member] = true
				if w.State == "settled" {
					settled[w.Member] = true
				}
			}
		}
		if len(standing) == 0 {
			return false, nil
		}
		if task.AnswersWanted <= 1 {
			if len(settled) == 0 {
				return false, nil
			}
			done = true
			continue
		}
		if len(members) < task.AnswersWanted {
			return false, nil
		}
		covered := false
		for _, comparison := range comparisons {
			if comparison.State != "settled" {
				continue
			}
			all := true
			for _, w := range standing {
				all = all && guardianContains(comparison.Reconciles, w.ID)
			}
			covered = covered || all
		}
		if !covered || len(settled) < task.AnswersWanted {
			return false, nil
		}
		done = true
	}
	// Original claim IDs are common to every original task. Merge prospective
	// project IDs, including claims created from a different task's result.
	claimIDs := append([]string{}, p.ClaimIDs...)
	for _, id := range tasks {
		task, e := k.legacyTask(id)
		if e != nil {
			return false, e
		}
		for _, id := range task.ClaimIDs {
			if !guardianContains(claimIDs, id) {
				claimIDs = append(claimIDs, id)
			}
		}
	}
	ids, e := k.legacyProjectClaims(LegacyTask{Project: p.ID, ClaimIDs: claimIDs})
	if e != nil {
		return false, e
	}
	for _, id := range ids {
		claim, e := k.legacyClaim(id)
		if e != nil {
			return false, e
		}
		for _, r := range claim.Revisions {
			if r.State == "draft" || r.State == "contested" {
				return false, nil
			}
			if r.State == "believed" && r.Action != "retract" {
				done = true
			}
		}
	}
	return done, nil
}
func (k Keeper) legacyReopen(project string) error {
	p, e := k.legacyProject(project)
	if e != nil {
		return e
	}
	lead, e := k.legacyActor(p.Lead)
	if e != nil {
		return e
	}
	if lead.Creator {
		return nil
	}
	finished, e := k.legacyProjectFinished(p)
	if e != nil {
		return e
	}
	if !finished {
		return nil
	}
	member, e := k.Member(lead.Member)
	if e != nil {
		return e
	}
	if member.Karma < 1000 {
		return errors.New("original lead member karma below project threshold")
	}
	allowed := 1 + (member.Karma-1000)/10
	running := int64(member.ActiveProjects)
	seen := map[string]bool{}
	for _, prefix := range []string{"legacy/project/", "legacy_project/"} {
		rows, e := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), 129)
		if e != nil {
			return e
		}
		if len(rows) > 128 {
			return errors.New("original project census bound")
		}
		for _, row := range rows {
			var entry legacyProject
			if e = json.Unmarshal(row.Value, &entry); e != nil {
				return e
			}
			if seen[entry.ID] {
				continue
			}
			seen[entry.ID] = true
			other, e := k.legacyProject(entry.ID)
			if e != nil {
				return e
			}
			if other.State == "halted" || other.State == "complete" {
				continue
			}
			owner, e := k.legacyActor(other.Lead)
			if e != nil {
				return e
			}
			if owner.Member != lead.Member {
				continue
			}
			finished, e := k.legacyProjectFinished(other)
			if e != nil {
				return e
			}
			if !finished {
				running++
				if running >= allowed {
					return errors.New("original lead member running project allowance exhausted")
				}
			}
		}
	}
	if running >= allowed {
		return errors.New("original lead member running project allowance exhausted")
	}
	return nil
}
