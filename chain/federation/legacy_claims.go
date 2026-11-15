package federation

import (
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

type LegacyClaimReview struct {
	ID       string `json:"id"`
	Reviewer string `json:"reviewer"`
	Member   string `json:"member"`
	Verdict  string `json:"verdict"`
	Original bool   `json:"original"`
	Evidence string `json:"evidence_digest,omitempty"`
}
type LegacyRevision struct {
	ID        string              `json:"id"`
	Base      string              `json:"base"`
	State     string              `json:"state"`
	Author    string              `json:"author"`
	Member    string              `json:"member"`
	Action    string              `json:"action"`
	Statement string              `json:"statement"`
	Sources   []string            `json:"sources"`
	Reviews   []LegacyClaimReview `json:"reviews"`
}
type LegacyClaim struct {
	ID        string           `json:"id"`
	Project   string           `json:"project"`
	Revisions []LegacyRevision `json:"revisions"`
}

func (k Keeper) legacyClaim(id string) (LegacyClaim, error) {
	var v LegacyClaim
	key := "legacy_claim/" + id
	if k.Store.Get([]byte(key)) == nil {
		key = "legacy/claim/" + id
	}
	e := get(k.Store, key, &v)
	if e == nil && (v.ID != id || len(v.Revisions) > 128) {
		e = errors.New("invalid bounded original claim")
	}
	return v, e
}
func (k Keeper) legacyBelief(id string) (string, error) {
	v, e := k.legacyClaim(id)
	if e != nil {
		return "", e
	}
	for _, r := range v.Revisions {
		if r.State == "believed" {
			return r.ID, nil
		}
	}
	return "", nil
}
func (k Keeper) legacyClaimReview(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Claim    string `json:"claim"`
		Revision string `json:"revision"`
		Reviewer string `json:"reviewer"`
		Verdict  string `json:"verdict"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if p.Verdict != "confirm" && p.Verdict != "dispute" || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("original claim verdict and evidence required")
	}
	claim, e := k.legacyClaim(p.Claim)
	if e != nil {
		return "", e
	}
	index := -1
	for i, r := range claim.Revisions {
		if r.ID == p.Revision {
			index = i
		}
	}
	if index < 0 {
		return "", errors.New("original claim revision missing")
	}
	r := &claim.Revisions[index]
	if r.State != "draft" && r.State != "contested" || len(r.Reviews) >= 32 || len(r.Sources) > 32 {
		return "", errors.New("original revision closed or bound reached")
	}
	a, e := k.legacyReviewer(c, p.Reviewer, claim.Project, r.Author)
	if e != nil {
		return "", e
	}
	for _, id := range r.Sources {
		work, e := k.legacyWork(id)
		if e != nil {
			return "", e
		}
		for _, check := range work.Checks {
			if check.Member == a.Member {
				return "", errors.New("claim reviewer verified a cited source")
			}
		}
	}
	for _, review := range r.Reviews {
		if review.Member == a.Member {
			return "", errors.New("member already reviewed original claim")
		}
	}
	if r.Base != "" {
		current, e := k.legacyBelief(claim.ID)
		if e != nil {
			return "", e
		}
		if current != r.Base {
			return "", errors.New("original revision stale base")
		}
	}
	arbitrating := r.State == "contested"
	if arbitrating {
		author, e := k.legacyActor(r.Author)
		if e != nil {
			return "", e
		}
		checks := []LegacyCheck{}
		for _, v := range r.Reviews {
			if v.Verdict == "dispute" {
				checks = append(checks, LegacyCheck{Verifier: v.Reviewer, Member: v.Member, Verdict: "disputed"})
			}
		}
		if e = k.legacyArbiter(a, author, checks); e != nil {
			return "", e
		}
		if p.Verdict == "confirm" {
			for _, v := range checks {
				if e = k.recordKarma(v.Member, v.Verifier, -2, "legacy_claim_dispute_overturned", r.ID, now); e != nil {
					return "", e
				}
			}
		}
	}
	r.Reviews = append(r.Reviews, LegacyClaimReview{Reviewer: a.ID, Member: a.Member, Verdict: p.Verdict, Evidence: p.Evidence})
	if p.Verdict == "dispute" {
		r.State = "contested"
		if arbitrating {
			r.State = "rejected"
		}
	} else {
		r.State = "draft"
		confirmed := map[string]bool{}
		for _, v := range r.Reviews {
			if v.Verdict == "confirm" {
				confirmed[v.Member] = true
			}
		}
		if len(confirmed) >= 2 {
			r.State = "believed"
			for i := range claim.Revisions {
				if i == index {
					continue
				}
				switch claim.Revisions[i].State {
				case "believed":
					claim.Revisions[i].State = "superseded"
				case "draft", "contested":
					claim.Revisions[i].State = "stale"
				}
			}
		}
	}
	return r.ID, put(k.Store, "legacy_claim/"+claim.ID, claim)
}

func (k Keeper) legacyTaskBelief(task LegacyTask, except string) (string, error) {
	ids, e := k.legacyProjectClaims(task)
	if e != nil {
		return "", e
	}
	citing := map[string]bool{}
	for _, id := range task.Contributions {
		if id == except {
			continue
		}
		work, e := k.legacyWork(id)
		if e != nil {
			return "", e
		}
		if work.State == "settled" {
			citing[id] = true
		}
	}
	sort.SliceStable(ids, func(i, j int) bool {
		a, ae := strconv.ParseUint(strings.TrimPrefix(ids[i], "CL-"), 10, 64)
		b, be := strconv.ParseUint(strings.TrimPrefix(ids[j], "CL-"), 10, 64)
		if ae == nil && be == nil {
			return a < b
		}
		if ae == nil {
			return true
		}
		if be == nil {
			return false
		}
		return ids[i] < ids[j]
	})
	fallback := ""
	for _, id := range ids {
		claim, e := k.legacyClaim(id)
		if e != nil {
			return "", e
		}
		for _, r := range claim.Revisions {
			if r.State != "believed" || r.Action == "retract" {
				continue
			}
			if claim.ID == task.Claim {
				fallback = r.ID
			}
			for _, source := range r.Sources {
				if citing[source] {
					return r.ID, nil
				}
			}
		}
	}
	return fallback, nil
}
