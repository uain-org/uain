package federation

import (
	"errors"
	"fmt"
)

// legacyAnswerClaim carries the original SQL claimFromAnswer/judgeAgainst
// consequences into the compatibility policy. It never changes original rows;
// settled source statements, exact check references and later revisions remain
// separate from prospective research proceedings.
func (k Keeper) legacyAnswerClaim(v *LegacyWork, standing []LegacyCheck) error {
	if k.Store.Get([]byte("legacy_answer_claim/"+v.ID)) != nil {
		return nil
	}
	task, e := k.legacyTask(v.Task)
	if e != nil {
		return e
	}
	if task.AnswersWanted > 1 && len(v.Reconciles) == 0 {
		return nil
	}
	statement, author, member := v.Statement, v.Author, v.Member
	for _, check := range v.Checks {
		if check.Revised != "" && (check.Verdict == "disputed" || check.Member != v.Member) {
			statement = check.Revised
			author = check.Verifier
			member = check.Member
			break
		}
	}
	if statement == "" {
		return nil
	}
	belief := ""
	if len(v.Reconciles) == 0 {
		belief, e = k.legacyTaskBelief(task, v.ID)
		if e != nil {
			return e
		}
	}
	event, e := k.nextEvent()
	if e != nil {
		return e
	}
	revision := fmt.Sprintf("native:%020d", event)
	marker := map[string]any{"contribution": v.ID, "check_refs": standing, "revision": revision}
	if belief != "" {
		ids, e := k.legacyProjectClaims(task)
		if e != nil {
			return e
		}
		for _, id := range ids {
			claim, e := k.legacyClaim(id)
			if e != nil {
				return e
			}
			for i := range claim.Revisions {
				base := &claim.Revisions[i]
				if base.ID != belief || base.State != "believed" {
					continue
				}
				action := ""
				for _, check := range v.Checks {
					if check.Verdict != "disputed" && check.Member == v.Member {
						continue
					}
					if check.Relation == "refutes" {
						action = "retract"
						break
					}
					if check.Relation == "contradicts" {
						action = "edit"
					}
				}
				marker["claim"] = claim.ID
				if action != "" {
					if len(claim.Revisions) >= 128 {
						return errors.New("original claim revision bound")
					}
					sources := []string{v.ID}
					if action == "retract" {
						statement = base.Statement
					} else {
						sources = append(append([]string{}, base.Sources...), v.ID)
					}
					if len(sources) > 32 {
						return errors.New("original claim source bound")
					}
					r := LegacyRevision{ID: revision, Base: belief, State: "draft", Author: author, Member: member, Action: action, Statement: statement, Sources: sources, Reviews: []LegacyClaimReview{}}
					claim.Revisions = append(claim.Revisions, r)
				} else {
					found := false
					for _, id := range base.Sources {
						found = found || id == v.ID
					}
					if !found {
						if len(base.Sources) >= 32 {
							return errors.New("original claim source bound")
						}
						base.Sources = append(base.Sources, v.ID)
					}
					marker["revision"] = base.ID
				}
				if e = put(k.Store, "legacy_claim/"+claim.ID, claim); e != nil {
					return e
				}
				return put(k.Store, "legacy_answer_claim/"+v.ID, marker)
			}
		}
		return errors.New("original believed revision missing")
	}
	direct := !v.Arbitrated && len(v.Reconciles) == 0 && len(standing) >= 2
	for _, check := range standing {
		direct = direct && check.Verdict == "confirmed"
	}
	for _, check := range v.Checks {
		if check.Verdict == "disputed" {
			direct = false
		}
	}
	for _, id := range task.Contributions {
		if id == v.ID {
			continue
		}
		r, e := k.legacyWork(id)
		if e != nil {
			return e
		}
		if r.Kind == "work" && r.Author != v.Author && r.State == "settled" && len(r.Reconciles) == 0 {
			direct = false
		}
	}
	if len(task.ClaimIDs) >= 128 {
		return errors.New("original task claim bound")
	}
	id := fmt.Sprintf("CL-native-%020d", event)
	if k.Store.Get([]byte("legacy_claim/"+id)) != nil {
		return errors.New("legacy derived claim ID collision")
	}
	r := LegacyRevision{ID: revision, State: "draft", Author: author, Member: member, Action: "create", Statement: statement, Sources: []string{v.ID}, Reviews: []LegacyClaimReview{}}
	if direct {
		r.State = "believed"
		for _, check := range standing {
			r.Reviews = append(r.Reviews, LegacyClaimReview{ID: check.ID, Reviewer: check.Verifier, Member: check.Member, Verdict: "confirm", Original: check.Original, Evidence: check.Evidence})
		}
	}
	claim := LegacyClaim{ID: id, Project: v.Project, Revisions: []LegacyRevision{r}}
	if e = put(k.Store, "legacy_claim/"+id, claim); e != nil {
		return e
	}
	if e = k.legacyIndexClaim(task.Project, id); e != nil {
		return e
	}
	task.ClaimIDs = append(task.ClaimIDs, id)
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return e
	}
	marker["claim"] = id
	return put(k.Store, "legacy_answer_claim/"+v.ID, marker)
}
