package federation

import (
	"encoding/json"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// Limit mathematical work before allocating big integers. SQL numbers were
// finite IEEE-754 values; consensus uses exact arithmetic within this bound.
func legacyNumber(text string) (*big.Rat, bool) {
	if len(text) > 100 || !legacyDecimal.MatchString(text) {
		return nil, false
	}
	if n := strings.IndexAny(text, "eE"); n >= 0 {
		exp, e := strconv.ParseInt(text[n+1:], 10, 32)
		if e != nil || exp < -324 || exp > 308 {
			return nil, false
		}
	}
	n, ok := new(big.Rat).SetString(text)
	if !ok {
		return nil, false
	}
	max, _ := new(big.Rat).SetString("1.7976931348623157e308")
	if new(big.Rat).Abs(n).Cmp(max) > 0 {
		return nil, false
	}
	return n, true
}
func legacyFutureKPI(raw json.RawMessage, now time.Time) (json.RawMessage, string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, "", nil
	}
	var p struct {
		Statement  string          `json:"statement"`
		Metric     string          `json:"metric"`
		Comparator string          `json:"comparator"`
		Threshold  json.RawMessage `json:"threshold"`
		Unit       *string         `json:"unit"`
		Source     string          `json:"source"`
		Resolves   string          `json:"resolves_by"`
	}
	if e := Decode(raw, &p); e != nil {
		return nil, "", e
	}
	p.Statement = strings.TrimSpace(p.Statement)
	p.Metric = strings.TrimSpace(p.Metric)
	p.Source = strings.TrimSpace(p.Source)
	p.Resolves = strings.TrimSpace(p.Resolves)
	if len(p.Statement) < 20 || len(p.Statement) > 2000 || len(p.Metric) < 1 || len(p.Metric) > 200 || !kpiSource(p.Source) {
		return nil, "", errors.New("original bounded measurable KPI/public source required")
	}
	if p.Unit != nil {
		u := strings.TrimSpace(*p.Unit)
		p.Unit = &u
		if len(u) == 0 || len(u) > 50 {
			return nil, "", errors.New("original KPI unit bound")
		}
	}
	if p.Comparator == "occurs" {
		if p.Unit != nil || len(p.Threshold) > 0 && string(p.Threshold) != "null" {
			return nil, "", errors.New("occurs KPI has no threshold or unit")
		}
		p.Threshold = json.RawMessage("null")
	} else {
		if p.Comparator != ">=" && p.Comparator != "<=" && p.Comparator != "==" {
			return nil, "", errors.New("original KPI comparator required")
		}
		if _, ok := legacyNumber(string(p.Threshold)); !ok {
			return nil, "", errors.New("bounded exact numeric KPI threshold required")
		}
	}
	end, e := deadline(p.Resolves)
	if e != nil || !end.After(now) || end.After(now.Add(time.Duration(50*365.25*24)*time.Hour)) {
		return nil, "", errors.New("original future KPI deadline within50years required")
	}
	out, e := json.Marshal(p)
	return out, end.UTC().Format(time.RFC3339Nano), e
}
func (k Keeper) legacyKPISet(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Task     string          `json:"task"`
		Project  string          `json:"project"`
		Actor    string          `json:"actor"`
		KPI      json.RawMessage `json:"kpi"`
		Evidence string          `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if (p.Task == "") == (p.Project == "") || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("exact task or project KPI/evidence required")
	}
	var task LegacyTask
	if p.Task != "" {
		var e error
		task, e = k.legacyTask(p.Task)
		if e != nil {
			return "", e
		}
		p.Project = task.Project
	}
	a, e := k.legacyParticipant(c, p.Actor, p.Project)
	if e != nil {
		return "", e
	}
	project, e := k.legacyProject(p.Project)
	if e != nil {
		return "", e
	}
	if a.ID != project.Lead && (p.Task == "" || a.ID != task.Creator) {
		return "", errors.New("exact original creator or project lead required")
	}
	raw, end, e := legacyFutureKPI(p.KPI, now)
	if e != nil {
		return "", e
	}
	if p.Task != "" {
		if task.State != "open" || len(task.Contributions) > 0 || task.Kind == "future" && raw == nil {
			return "", errors.New("original task KPI frozen/closed or future KPI missing")
		}
		task.KPI = raw
		task.Resolves = end
		if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
			return "", e
		}
	} else {
		if e = put(k.Store, "legacy_project_kpi/"+project.ID, map[string]any{"kpi": raw, "actor": a.ID, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)}); e != nil {
			return "", e
		}
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	return p.Project, put(k.Store, "legacy_kpi_amendment/"+strconv.FormatUint(event, 10), map[string]any{"task": p.Task, "project": p.Project, "actor": a.ID, "kpi": raw, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)})
}
func (k Keeper) legacyKPIExpire(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Task     string `json:"task"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	task, e := k.legacyTask(p.Task)
	if e != nil {
		return "", e
	}
	end, e := deadline(task.Resolves)
	if e != nil || task.Kind != "future" || task.Outcome != "" || now.Before(end.Add(KPIGrace)) || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("unresolved original future KPI must reach30day grace")
	}
	task.Outcome = "expired"
	task.State = "closed"
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	if e = k.legacyMootChallenges(task.Project, task.ID, "prior_art"); e != nil {
		return "", e
	}
	if e = k.legacyApplySingleton(task, now); e != nil {
		return "", e
	}
	return task.ID, put(k.Store, "legacy_kpi_resolution/"+task.ID, map[string]any{"outcome": "expired", "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano), "actor": c.Member})
}

type LegacyChallenge struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Project  string `json:"project"`
	Task     string `json:"task"`
	Actor    string `json:"actor"`
	Member   string `json:"member"`
	Source   string `json:"source"`
	Note     string `json:"note"`
	Evidence string `json:"evidence_digest"`
	At       string `json:"at"`
	State    string `json:"state"`
}

func legacyChallengeIndex(project, task, kind string) string {
	return "legacy_challenges/" + project + "/" + task + "/" + kind
}
func (k Keeper) legacyChallenges(project, task, kind string) ([]LegacyChallenge, error) {
	var ids []string
	key := legacyChallengeIndex(project, task, kind)
	if k.Store.Get([]byte(key)) == nil {
		return nil, nil
	}
	if e := get(k.Store, key, &ids); e != nil {
		return nil, e
	}
	if len(ids) > 32 {
		return nil, errors.New("original challenge bound")
	}
	out := []LegacyChallenge{}
	for _, id := range ids {
		var v LegacyChallenge
		if e := get(k.Store, "legacy_challenge/"+id, &v); e != nil {
			return nil, e
		}
		if v.Project != project || v.Task != task || v.Kind != kind {
			return nil, errors.New("original challenge index mismatch")
		}
		out = append(out, v)
	}
	return out, nil
}
func (k Keeper) legacyMootChallenges(project, task, kind string) error {
	rows, e := k.legacyChallenges(project, task, kind)
	if e != nil {
		return e
	}
	for _, v := range rows {
		if v.State == "open" {
			v.State = "moot"
			if e = put(k.Store, "legacy_challenge/"+v.ID, v); e != nil {
				return e
			}
		}
	}
	return nil
}
func (k Keeper) legacyChallengeFile(c Command, now time.Time, kind string) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		ID       string `json:"id"`
		Kind     string `json:"kind"`
		Project  string `json:"project"`
		Task     string `json:"task"`
		Actor    string `json:"actor"`
		Source   string `json:"source"`
		Note     string `json:"note"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if kind != "" {
		if p.Kind != "" && p.Kind != kind {
			return "", errors.New("challenge kind mismatch")
		}
		p.Kind = kind
	}
	if !validID(p.ID) || (p.Kind != "prior_art" && p.Kind != "benevolence") || p.Kind == "prior_art" && p.Task == "" || !publicPriorArtSource(p.Source) || len(strings.TrimSpace(p.Note)) < 20 || len(p.Note) > 2000 || !digestPattern.MatchString(p.Evidence) || k.Store.Get([]byte("legacy_challenge_filing/"+p.ID)) != nil {
		return "", errors.New("bounded original public challenge evidence required")
	}
	var task LegacyTask
	if p.Task != "" {
		var e error
		task, e = k.legacyTask(p.Task)
		if e != nil {
			return "", e
		}
		if p.Project != "" && p.Project != task.Project {
			return "", errors.New("challenge project mismatch")
		}
		p.Project = task.Project
		if p.Kind == "prior_art" && task.State != "open" {
			return "", errors.New("original task closed")
		}
	}
	if p.Kind == "benevolence" && (len(strings.TrimSpace(p.Note)) < 40 || !kpiSource(p.Source) || strings.HasPrefix(strings.ToUpper(p.Source), "NCT")) {
		return "", errors.New("original harm reason/public evidence required")
	}
	a, e := k.legacyChallengeActor(c, p.Actor, p.Project, p.Kind == "benevolence")
	if e != nil {
		return "", e
	}
	target := p.Project
	if p.Task != "" {
		target = p.Task
	}
	if k.Store.Get([]byte("legacy_malevolent/"+p.Project+"/"+p.Task)) != nil {
		return "", errors.New("original target already malevolent")
	}
	rows, e := k.legacyChallenges(p.Project, p.Task, p.Kind)
	if e != nil {
		return "", e
	}
	ids := []string{}
	for _, old := range rows {
		if old.State == "open" {
			if old.Member == a.Member {
				return "", errors.New("one open original challenge per member/target")
			}
			ids = append(ids, old.ID)
		}
	}
	if len(ids) >= 32 {
		return "", errors.New("original open challenge bound")
	}
	v := LegacyChallenge{p.ID, p.Kind, p.Project, p.Task, a.ID, a.Member, p.Source, p.Note, p.Evidence, now.UTC().Format(time.RFC3339Nano), "open"}
	if e = put(k.Store, "legacy_challenge_filing/"+v.ID, v); e != nil {
		return "", e
	}
	state := v
	state.Source = ""
	state.Note = ""
	state.Evidence = ""
	state.At = ""
	if e = put(k.Store, "legacy_challenge/"+v.ID, state); e != nil {
		return "", e
	}
	if e = put(k.Store, legacyChallengeIndex(p.Project, p.Task, p.Kind), append(ids, v.ID)); e != nil {
		return "", e
	}
	return target, nil
}

// Benevolence flags remain possible even after a target closes or halts.
func (k Keeper) legacyChallengeActor(c Command, id, project string, closed bool) (LegacyActor, error) {
	if !closed {
		return k.legacyParticipant(c, id, project)
	}
	a, e := k.legacyActor(id)
	if e != nil {
		return a, e
	}
	if a.Member != c.Member || c.Instance != "" && c.Instance != a.ID || !guardianContains(a.Projects, project) {
		return a, errors.New("owned original project member required")
	}
	return a, k.validateInstance(c.Member, a.ID)
}
func (k Keeper) legacyChallengeDecide(c Command, now time.Time, kind string) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Challenge string `json:"challenge"`
		Actor     string `json:"actor"`
		Decision  string `json:"decision"`
		Note      string `json:"note"`
		Evidence  string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	var v LegacyChallenge
	if e := get(k.Store, "legacy_challenge/"+p.Challenge, &v); e != nil {
		return "", e
	}
	if v.State != "open" || kind != "" && kind != v.Kind || (p.Decision != "upheld" && p.Decision != "rejected") || len(strings.TrimSpace(p.Note)) < 1 || len(p.Note) > 2000 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("open original challenge/exact decision required")
	}
	a, e := k.legacyChallengeActor(c, p.Actor, v.Project, v.Kind == "benevolence")
	if e != nil {
		return "", e
	}
	if (!a.Default && !a.Arbiter) || a.Member == v.Member {
		return "", errors.New("independent original default verifier/arbiter required")
	}
	project, e := k.legacyProject(v.Project)
	if e != nil {
		return "", e
	}
	creator := project.Lead
	var task LegacyTask
	if v.Task != "" {
		task, e = k.legacyTask(v.Task)
		if e != nil {
			return "", e
		}
		creator = task.Creator
		if v.Kind == "prior_art" && task.State != "open" {
			return "", errors.New("original task closed")
		}
	}
	if v.Kind == "benevolence" {
		owner, e := k.legacyActor(creator)
		if e != nil {
			return "", e
		}
		if owner.Member == a.Member {
			return "", errors.New("original creator cannot judge its own harm")
		}
	}
	v.State = p.Decision
	if e = put(k.Store, "legacy_challenge/"+v.ID, v); e != nil {
		return "", e
	}
	if p.Decision == "upheld" {
		if v.Kind == "benevolence" {
			if e = put(k.Store, "legacy_malevolent/"+v.Project+"/"+v.Task, map[string]any{"flag": v.ID, "actor": a.ID, "at": now.UTC().Format(time.RFC3339Nano)}); e != nil {
				return "", e
			}
		}
		if v.Task != "" {
			task.State = "closed"
			if v.Kind == "prior_art" {
				task.Known = true
			}
			if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
				return "", e
			}
			if e = k.legacyApplySingleton(task, now); e != nil {
				return "", e
			}
			if e = k.legacyMootChallenges(v.Project, v.Task, "prior_art"); e != nil {
				return "", e
			}
		} else if project.State != "halted" && project.State != "complete" {
			project.State = "halted"
			if e = put(k.Store, "legacy_project/"+project.ID, project); e != nil {
				return "", e
			}
		}
		if e = k.legacyMootChallenges(v.Project, v.Task, v.Kind); e != nil {
			return "", e
		}
		if v.Kind == "benevolence" {
			owner, e := k.legacyActor(creator)
			if e != nil {
				return "", e
			}
			if e = k.recordKarma(owner.Member, owner.ID, -2, "legacy_malevolent", v.ID, now); e != nil {
				return "", e
			}
		}
	}
	return v.ID, put(k.Store, "legacy_challenge_decision/"+v.ID, map[string]any{"actor": a.ID, "member": a.Member, "decision": p.Decision, "note": p.Note, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)})
}
