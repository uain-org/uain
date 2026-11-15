package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (k Keeper) legacyTaskPriceAllowed(project legacyProject, actor string, price *int64) error {
	if price == nil {
		return nil
	}
	if actor != project.Lead || *price < 0 || *price > MaxReward {
		return errors.New("original lead alone prices bounded tasks")
	}
	if project.BudgetStatus == "" {
		return errors.New("explicit captured original staged budget policy required before new pricing")
	}
	if project.BudgetStatus != "allocated" {
		if *price > 100 {
			return errors.New("original unbudgeted task price exceeds100")
		}
		return nil
	}
	if project.BudgetUnlocked < 0 {
		return errors.New("invalid captured original unlocked budget")
	}
	committed, e := k.legacyBudgetCommitted(project)
	if e != nil {
		return e
	}
	available := project.BudgetUnlocked - committed
	if *price > available {
		return errors.New("original staged project budget exhausted")
	}
	return nil
}
func (k Keeper) legacyTaskPrice(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Task     string `json:"task"`
		Actor    string `json:"actor"`
		Karma    *int64 `json:"karma"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	task, e := k.legacyTask(p.Task)
	if e != nil {
		return "", e
	}
	if task.State != "open" || task.Price != nil || len(task.Contributions) > 0 || p.Karma == nil || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("original unpriced unanswered open task/evidence required")
	}
	a, e := k.legacyParticipant(c, p.Actor, task.Project)
	if e != nil {
		return "", e
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return "", e
	}
	if e = k.legacyTaskPriceAllowed(project, a.ID, p.Karma); e != nil {
		return "", e
	}
	task.Price = p.Karma
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	return task.ID, put(k.Store, "legacy_task_price/"+task.ID, map[string]any{"actor": a.ID, "karma": *p.Karma, "evidence_digest": p.Evidence, "at": now.UTC().Format(time.RFC3339Nano)})
}
func (k Keeper) legacyTaskOpen(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		ID           string          `json:"id"`
		Project      string          `json:"project"`
		Author       string          `json:"author"`
		Title        string          `json:"title"`
		Question     string          `json:"question"`
		DoneWhen     string          `json:"done_when"`
		HowToCheck   string          `json:"how_to_check"`
		Parent       string          `json:"parent_task"`
		Claim        string          `json:"from_claim"`
		Karma        *int64          `json:"karma"`
		Answers      int             `json:"answers_wanted"`
		AnswerType   string          `json:"answer_type"`
		Kind         string          `json:"kind"`
		KPI          json.RawMessage `json:"kpi"`
		Requirements json.RawMessage `json:"requirements"`
		Output       string          `json:"output_format"`
		SourcesHint  string          `json:"sources_hint"`
		PriorArt     struct {
			Statement string   `json:"statement"`
			Searched  []string `json:"searched"`
		} `json:"prior_art"`
		Benevolence struct {
			Class     string `json:"class"`
			Statement string `json:"statement"`
		} `json:"benevolence"`
		Verification struct {
			Criteria string `json:"criteria"`
			Method   string `json:"method"`
		} `json:"verification"`
		Evidence string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if len(c.Payload) > 20000 || len(p.Title) < 5 || len(p.Title) > 200 || len(strings.TrimSpace(p.Question)) < 20 || len(p.Question) > 8000 || len(strings.TrimSpace(p.DoneWhen)) < 20 || len(p.DoneWhen) > 4000 || len(strings.TrimSpace(p.HowToCheck)) < 20 || len(p.HowToCheck) > 4000 || len(p.Requirements) > 8000 || len(p.Output) > 2000 || len(p.SourcesHint) > 2000 || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("bounded original task question/completion/check plan/evidence required")
	}
	if len(strings.TrimSpace(p.PriorArt.Statement)) < 40 || len(p.PriorArt.Statement) > 20000 || len(p.PriorArt.Searched) < 2 || len(p.PriorArt.Searched) > 50 {
		return "", errors.New("original novelty basis with at least2searches required")
	}
	seen := []string{}
	for _, s := range p.PriorArt.Searched {
		s = strings.TrimSpace(s)
		if s == "" || len(s) > 1000 {
			return "", errors.New("original prior-art search bound")
		}
		if !guardianContains(seen, s) {
			seen = append(seen, s)
		}
	}
	if len(seen) < 2 {
		return "", errors.New("distinct original prior-art searches required")
	}
	p.PriorArt.Searched = seen
	p.Benevolence.Class = strings.ToLower(strings.TrimSpace(p.Benevolence.Class))
	p.Benevolence.Statement = strings.TrimSpace(p.Benevolence.Statement)
	if !allowedClass(p.Benevolence.Class) || len(p.Benevolence.Statement) < 20 || len(p.Benevolence.Statement) > 1000 {
		return "", errors.New("original benevolent or neutral declaration required")
	}
	if len(strings.TrimSpace(p.Verification.Criteria)) < 40 || len(p.Verification.Criteria) > 4000 || !guardianContains([]string{"reproduce", "inspect", "forecast-resolve", "review"}, p.Verification.Method) {
		return "", errors.New("original bounded verification criteria/method required")
	}
	if p.Kind == "" {
		p.Kind = "instant"
	}
	if p.Kind != "instant" && p.Kind != "future" {
		return "", errors.New("original instant or future task required")
	}
	raw, end, e := legacyFutureKPI(p.KPI, now)
	if e != nil {
		return "", e
	}
	if p.Kind == "future" && raw == nil {
		return "", errors.New("future task requires KPI")
	}
	a, e := k.legacyParticipant(c, p.Author, p.Project)
	if e != nil {
		return "", e
	}
	project, e := k.legacyProject(p.Project)
	if e != nil {
		return "", e
	}
	if e = k.legacyReopen(project.ID); e != nil {
		return "", e
	}
	if e = k.legacyTaskPriceAllowed(project, a.ID, p.Karma); e != nil {
		return "", e
	}
	if p.Parent != "" {
		parent, e := k.legacyTask(p.Parent)
		if e != nil || parent.Project != project.ID {
			return "", errors.New("original parent task must be in same project")
		}
	}
	if p.Claim != "" {
		claim, e := k.legacyClaim(p.Claim)
		if e != nil || claim.Project != project.ID {
			return "", errors.New("original source claim must be in same project")
		}
	}
	ids, e := k.legacyProjectTaskIDs(project)
	if e != nil {
		return "", e
	}
	if len(ids) >= 128 {
		return "", errors.New("original project task bound")
	}
	if p.ID == "" {
		event, e := k.nextEvent()
		if e != nil {
			return "", e
		}
		p.ID = fmt.Sprintf("T-native-%020d", event)
	}
	if !validID(p.ID) {
		return "", errors.New("valid new original-policy task ID required")
	}
	for _, prefix := range []string{"legacy/task/", "legacy_task/", "legacy/reserved/tasks/", "task/"} {
		if k.Store.Get([]byte(prefix+p.ID)) != nil {
			return "", errors.New("task ID already reserved")
		}
	}
	if p.Answers < 1 {
		p.Answers = 1
	}
	if p.Answers > 50 {
		p.Answers = 50
	}
	if p.AnswerType == "" {
		p.AnswerType = "answer"
	}
	if p.AnswerType != "answer" && p.AnswerType != "forecast" {
		return "", errors.New("original answer/forecast type required")
	}
	prior, e := json.Marshal(p.PriorArt)
	if e != nil {
		return "", e
	}
	task := LegacyTask{ID: p.ID, Project: project.ID, State: "open", Kind: p.Kind, AnswerType: p.AnswerType, AnswersWanted: p.Answers, Price: p.Karma, Creator: a.ID, Claim: p.Claim, ClaimIDs: append([]string{}, project.ClaimIDs...), KPI: raw, Resolves: end, PriorArt: prior, Contributions: []string{}}
	if e = put(k.Store, "legacy_task/"+task.ID, task); e != nil {
		return "", e
	}
	project.TaskIDs = append(ids, task.ID)
	if e = put(k.Store, "legacy_project/"+project.ID, project); e != nil {
		return "", e
	}
	return task.ID, put(k.Store, "legacy_task_opening/"+task.ID, map[string]any{"policy": LegacyImportPolicy, "payload": p, "member": c.Member, "at": now.UTC().Format(time.RFC3339Nano)})
}
