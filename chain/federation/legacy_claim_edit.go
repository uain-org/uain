package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// New claim proposals retain their exact initial evidence independently of the
// mutable review overlay. Original SQL rows remain unchanged.
type LegacyClaimProposal struct {
	Claim    string         `json:"claim"`
	Revision LegacyRevision `json:"revision"`
	Reason   string         `json:"reason"`
	Evidence string         `json:"evidence_digest"`
	At       string         `json:"at"`
}

func (k Keeper) legacyProjectClaims(task LegacyTask) ([]string, error) {
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return nil, e
	}
	ids := append([]string{}, project.ClaimIDs...)
	for _, id := range task.ClaimIDs {
		if !guardianContains(ids, id) {
			ids = append(ids, id)
		}
	}
	if task.Claim != "" && !guardianContains(ids, task.Claim) {
		ids = append(ids, task.Claim)
	}
	var added []string
	if k.Store.Get([]byte("legacy_project_claims/"+task.Project)) != nil {
		if e := get(k.Store, "legacy_project_claims/"+task.Project, &added); e != nil {
			return nil, e
		}
	}
	for _, id := range added {
		if !guardianContains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) > 128 {
		return nil, errors.New("original project claim bound")
	}
	return ids, nil
}
func (k Keeper) legacyIndexClaim(project, id string) error {
	var ids []string
	if k.Store.Get([]byte("legacy_project_claims/"+project)) != nil {
		if e := get(k.Store, "legacy_project_claims/"+project, &ids); e != nil {
			return e
		}
	}
	if guardianContains(ids, id) {
		return nil
	}
	if len(ids) >= 128 {
		return errors.New("original prospective project claim bound")
	}
	return put(k.Store, "legacy_project_claims/"+project, append(ids, id))
}
func (k Keeper) legacyClaimSources(project string, raw []string) ([]string, []string, []string, error) {
	if len(raw) == 0 || len(raw) > 32 {
		return nil, nil, nil, errors.New("bounded original claim sources required")
	}
	ids, settled, claims := []string{}, []string{}, []string{}
	seenTasks := map[string]bool{}
	for _, id := range raw {
		id = strings.TrimSpace(id)
		// Native continuation IDs are case-sensitive. Existing source IDs retain
		// their exact imported spelling; no historical bytes are normalized.
		if guardianContains(ids, id) {
			continue
		}
		w, e := k.legacyWorkStatus(id)
		if e != nil {
			normalized := strings.ToUpper(id)
			w, e = k.legacyWorkStatus(normalized)
			if e != nil {
				return nil, nil, nil, e
			}
			id = normalized
			if guardianContains(ids, id) {
				continue
			}
		}
		if w.Project != project {
			return nil, nil, nil, errors.New("claim source belongs to another project")
		}
		ids = append(ids, id)
		if w.State == "settled" {
			settled = append(settled, id)
		}
		if seenTasks[w.Task] {
			continue
		}
		seenTasks[w.Task] = true
		task := LegacyTask{Project: project}
		if w.Task != "" {
			task, e = k.legacyTask(w.Task)
			if e != nil {
				return nil, nil, nil, e
			}
		}
		found, e := k.legacyProjectClaims(task)
		if e != nil {
			return nil, nil, nil, e
		}
		for _, cid := range found {
			if !guardianContains(claims, cid) {
				claims = append(claims, cid)
			}
		}
	}
	if len(claims) > 128 {
		return nil, nil, nil, errors.New("original project claim bound")
	}
	return ids, settled, claims, nil
}
func legacyRevisionLater(a, b string) bool {
	an, ae := strconv.ParseUint(a, 10, 64)
	bn, be := strconv.ParseUint(b, 10, 64)
	if ae == nil && be == nil {
		return an > bn
	}
	if ae == nil {
		return false
	}
	if be == nil {
		return true
	}
	return a > b
}
func legacySourcesOverlap(a, b []string) bool {
	for _, id := range a {
		if guardianContains(b, id) {
			return true
		}
	}
	return false
}
func (k Keeper) legacyRevisableClaim(claims, sources []string) (bool, error) {
	type item struct {
		claim LegacyClaim
		r     LegacyRevision
	}
	all := []item{}
	bytesRead := 0
	for _, id := range claims {
		raw := k.Store.Get([]byte("legacy_claim/" + id))
		if raw == nil {
			raw = k.Store.Get([]byte("legacy/claim/" + id))
		}
		bytesRead += len(raw)
		if bytesRead > 65536 {
			return false, errors.New("original revision eligibility evidence byte bound")
		}
		c, e := k.legacyClaim(id)
		if e != nil {
			return false, e
		}
		for _, r := range c.Revisions {
			all = append(all, item{c, r})
			if len(all) > 256 {
				return false, errors.New("original revision census bound")
			}
		}
	}
	for _, v := range all {
		if v.claim.Revisions[0].ID != v.r.ID || v.r.State != "rejected" || !legacySourcesOverlap(v.r.Sources, sources) {
			continue
		}
		believed := false
		for _, r := range v.claim.Revisions {
			believed = believed || r.State == "believed"
		}
		if believed {
			continue
		}
		// no_revise is an original SQL eligibility constraint, not inferred from
		// current review state. Missing authenticated source evidence fails closed.
		if k.Store.Get([]byte("legacy_claim_revision/"+v.r.ID)) == nil {
			raw, e := k.LegacyRow("claim_revisions", v.r.ID)
			if e != nil {
				return false, e
			}
			var flag struct {
				NoRevise json.RawMessage `json:"no_revise"`
			}
			if e = json.Unmarshal(raw, &flag); e != nil {
				return false, e
			}
			f := string(flag.NoRevise)
			if f != "0" && f != "false" && f != "null" {
				continue
			}
		}
		attempts, blocked := 0, false
		for _, other := range all {
			if !legacySourcesOverlap(v.r.Sources, other.r.Sources) {
				continue
			}
			if other.r.State == "rejected" {
				attempts++
			}
			if legacyRevisionLater(other.r.ID, v.r.ID) {
				blocked = true
			}
		}
		if attempts <= 2 && !blocked {
			return true, nil
		}
	}
	return false, nil
}
func (k Keeper) legacyClaimWrite(c Command, now time.Time, edit bool) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Project   string   `json:"project"`
		Claim     string   `json:"claim"`
		Base      string   `json:"base"`
		Author    string   `json:"author"`
		Action    string   `json:"action"`
		Statement string   `json:"statement"`
		Sources   []string `json:"sources"`
		Reason    string   `json:"reason"`
		Evidence  string   `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if len(strings.TrimSpace(p.Reason)) < 1 || len(p.Reason) > 4000 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("bounded original claim reason/evidence required")
	}
	var claim LegacyClaim
	var base LegacyRevision
	if edit {
		if p.Action != "edit" && p.Action != "retract" {
			return "", errors.New("original edit or retract action required")
		}
		var e error
		claim, e = k.legacyClaim(p.Claim)
		if e != nil {
			return "", e
		}
		p.Project = claim.Project
		for _, r := range claim.Revisions {
			if r.State == "believed" {
				base = r
			}
		}
		if base.ID == "" || base.ID != p.Base {
			return "", errors.New("original claim belief/base changed")
		}
		if p.Action == "retract" && base.Action == "retract" {
			return "", errors.New("original claim already retracted")
		}
	} else {
		p.Action = "create"
	}
	if !edit && p.Base != "" {
		return "", errors.New("new original claim cannot name a belief base")
	}
	a, e := k.legacyParticipant(c, p.Author, p.Project)
	if e != nil {
		return "", e
	}
	if e = k.legacyReopen(p.Project); e != nil {
		return "", e
	}
	ids, settled, claims, e := k.legacyClaimSources(p.Project, p.Sources)
	if e != nil {
		return "", e
	}
	if edit {
		eligible := false
		for _, id := range settled {
			eligible = eligible || p.Action == "retract" || !guardianContains(base.Sources, id)
		}
		if !eligible {
			return "", errors.New("new settled source required for edit; settled source for retraction")
		}
		if p.Action == "retract" {
			p.Statement = base.Statement
		}
	} else if len(ids) < 2 {
		ok, e := k.legacyRevisableClaim(claims, ids)
		if e != nil {
			return "", e
		}
		if !ok {
			return "", errors.New("manual claim needs multiple sources or eligible rejected draft")
		}
	}
	if len(strings.TrimSpace(p.Statement)) < 1 || len(p.Statement) > 4000 || len(claim.Revisions) >= 128 {
		return "", errors.New("bounded original statement/revisions required")
	}
	textBytes, e := json.Marshal([]string{p.Statement, p.Reason})
	if e != nil || len(textBytes) > 24000 {
		return "", errors.New("original claim statement/reason encoded byte bound")
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	revision := fmt.Sprintf("native:%020d", event)
	if !edit {
		claim = LegacyClaim{ID: fmt.Sprintf("CL-native-%020d", event), Project: p.Project, Revisions: []LegacyRevision{}}
	}
	if k.Store.Get([]byte("legacy_claim_revision/"+revision)) != nil {
		return "", errors.New("original revision ID collision")
	}
	r := LegacyRevision{ID: revision, Base: p.Base, State: "draft", Author: a.ID, Member: a.Member, Action: p.Action, Statement: p.Statement, Sources: ids, Reviews: []LegacyClaimReview{}}
	claim.Revisions = append(claim.Revisions, r)
	if e = k.legacyIndexClaim(claim.Project, claim.ID); e != nil {
		return "", e
	}
	if e = put(k.Store, "legacy_claim_revision/"+revision, LegacyClaimProposal{claim.ID, r, p.Reason, p.Evidence, now.UTC().Format(time.RFC3339Nano)}); e != nil {
		return "", e
	}
	return revision, put(k.Store, "legacy_claim/"+claim.ID, claim)
}
