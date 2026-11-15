package federation

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type LegacyActor struct {
	ID               string   `json:"id"`
	Member           string   `json:"member"`
	Account          string   `json:"account"`
	Operator         string   `json:"operator"`
	OperatorVerified bool     `json:"operator_verified"`
	OperatorDomain   string   `json:"operator_domain"`
	Family           string   `json:"family"`
	Default          bool     `json:"default_verifier"`
	Arbiter          bool     `json:"trusted_arbiter"`
	Creator          bool     `json:"creator"`
	Tier             int      `json:"tier"`
	Projects         []string `json:"projects"`
	SourceState      string   `json:"source_state,omitempty"`
	EnrolledAt       string   `json:"enrolled_at,omitempty"`
}
type LegacyCheck struct {
	ID        string `json:"id"`
	Verifier  string `json:"verifier"`
	Member    string `json:"member"`
	Verdict   string `json:"verdict"`
	Novelty   string `json:"novelty"`
	Bootstrap bool   `json:"bootstrap"`
	Against   string `json:"against_claim_revision"`
	Relation  string `json:"against_claim"`
	Revised   string `json:"revised_claim"`
	Original  bool   `json:"original"`
	Evidence  string `json:"evidence_digest,omitempty"`
}
type LegacyHeld struct {
	Credibility   int64    `json:"credibility"`
	Credits       int64    `json:"credits"`
	Verifications []int64  `json:"verifications"`
	CheckRefs     []string `json:"check_refs,omitempty"`
}
type LegacyWork struct {
	ID               string          `json:"id"`
	Project          string          `json:"project"`
	Task             string          `json:"task"`
	Author           string          `json:"author"`
	Member           string          `json:"member"`
	Kind             string          `json:"kind"`
	State            string          `json:"state"`
	Claimed          int64           `json:"claimed"`
	Required         int             `json:"required"`
	Submitted        string          `json:"submitted_at"`
	Statement        string          `json:"claim_statement"`
	Reconciles       []string        `json:"reconciles"`
	Due              *int64          `json:"prize_due"`
	Pending          string          `json:"pending"`
	Withheld         string          `json:"withheld"`
	Held             *LegacyHeld     `json:"held"`
	Checks           []LegacyCheck   `json:"checks"`
	RawMeta          json.RawMessage `json:"raw_meta"`
	Paid             bool            `json:"paid"`
	PenaltiesApplied bool            `json:"penalties_applied"`
	Arbitrated       bool            `json:"arbitrated"`
}
type LegacyTask struct {
	ID            string          `json:"id"`
	Project       string          `json:"project"`
	State         string          `json:"state"`
	Kind          string          `json:"kind"`
	AnswerType    string          `json:"answer_type"`
	AnswersWanted int             `json:"answers_wanted"`
	Price         *int64          `json:"price"`
	Winner        string          `json:"winner"`
	Creator       string          `json:"created_by"`
	Claim         string          `json:"claim"`
	ClaimIDs      []string        `json:"claim_ids"`
	KPI           json.RawMessage `json:"kpi"`
	Resolves      string          `json:"resolves_by"`
	PriorArt      json.RawMessage `json:"prior_art"`
	Known         bool            `json:"known"`
	Contributions []string        `json:"contributions"`
	Outcome       string          `json:"outcome,omitempty"`
}
type legacyProject struct {
	BudgetTotal    *int64   `json:"budget_total,omitempty"`
	BudgetStage    *int     `json:"budget_stage,omitempty"`
	BudgetBasis    *string  `json:"budget_basis,omitempty"`
	BudgetStatus   string   `json:"budget_status,omitempty"`
	BudgetUnlocked int64    `json:"budget_unlocked,omitempty"`
	ParticipantIDs []string `json:"participant_ids,omitempty"`
	ClaimIDs       []string `json:"claim_ids,omitempty"`
	TaskIDs        []string `json:"task_ids,omitempty"`
	ID             string   `json:"id"`
	State          string   `json:"state"`
	Lead           string   `json:"lead"`
	EvidenceCutoff string   `json:"evidence_cutoff"`
	WorkIDs        []string `json:"work_ids"`
}

func (k Keeper) legacyWork(id string) (LegacyWork, error) {
	var v LegacyWork
	key := "legacy_work/" + id
	if k.Store.Get([]byte(key)) == nil {
		key = "legacy/work/" + id
	}
	e := get(k.Store, key, &v)
	if e == nil && (v.ID != id || len(v.Checks) > 32 || v.Claimed < 0 || v.Claimed > MaxReward) {
		e = errors.New("invalid bounded legacy work capsule")
	}
	return v, e
}
func (k Keeper) legacyTask(id string) (LegacyTask, error) {
	var v LegacyTask
	key := "legacy_task/" + id
	if k.Store.Get([]byte(key)) == nil {
		key = "legacy/task/" + id
	}
	e := get(k.Store, key, &v)
	if e == nil && (v.ID != id || len(v.Contributions) > 128) {
		e = errors.New("invalid bounded legacy task capsule")
	}
	return v, e
}
func (k Keeper) legacyActor(id string) (LegacyActor, error) {
	var a LegacyActor
	key := "legacy_actor/" + id
	if k.Store.Get([]byte(key)) == nil {
		key = "legacy/actor/" + id
	}
	e := get(k.Store, key, &a)
	if e == nil && (a.ID != id || a.Member == "" || len(a.Projects) > 128) {
		e = errors.New("unclaimed legacy actor cannot sign or receive a new award")
	}
	return a, e
}
func (k Keeper) legacyReady() error {
	s, e := k.legacyState()
	if e != nil || s.Status != "ready" {
		return errors.New("complete source account reconciliation required")
	}
	return nil
}
func legacySame(a, b LegacyActor) bool {
	if a.Member != "" && a.Member == b.Member || a.Account != "" && a.Account == b.Account {
		return true
	}
	if a.OperatorVerified && b.OperatorVerified {
		return a.OperatorDomain == b.OperatorDomain
	}
	x, y := normaliseOperator(a.Operator), normaliseOperator(b.Operator)
	return x == "" || y == "" || x == y
}

var legacyOpenAIModel = regexp.MustCompile(`\bo[1-9]\b`)

func legacyFamily(model string) string {
	m := strings.ToLower(model)
	if legacyOpenAIModel.MatchString(m) {
		return "openai"
	}
	for _, group := range [][]string{{"anthropic", "claude", "anthropic", "opus", "sonnet", "haiku"}, {"openai", "codex", "gpt", "openai", "chatgpt"}, {"google", "gemini", "gemma", "google", "bard"}, {"meta", "llama", "meta"}, {"mistral", "mistral", "mixtral"}, {"deepseek", "deepseek"}, {"alibaba", "qwen", "alibaba"}, {"xai", "grok", "xai"}} {
		for _, name := range group[1:] {
			if strings.Contains(m, name) {
				return group[0]
			}
		}
	}
	return ""
}
func (k Keeper) legacyReviewer(c Command, id, project, author string) (LegacyActor, error) {
	a, e := k.legacyActor(id)
	if e != nil {
		return a, e
	}
	if a.Member != c.Member || c.Instance != "" && c.Instance != id {
		return a, errors.New("signing member must own exact original reviewer instance")
	}
	if e = k.validateInstance(c.Member, id); e != nil {
		return a, e
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return a, e
	}
	if !a.Default && m.Karma < 100 {
		return a, errors.New("original review requires100 member Karma or exact default verifier")
	}
	own, e := k.legacyActor(author)
	if e != nil {
		return a, e
	}
	if own.Member == a.Member {
		return a, errors.New("original same-member review refused")
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
func (k Keeper) legacyArbiter(a, author LegacyActor, checks []LegacyCheck) error {
	if a.Member == author.Member {
		return errors.New("same-member arbitration")
	}
	for _, check := range checks {
		if check.Verdict == "disputed" && check.Member == a.Member {
			return errors.New("arbiter is member of disputing side")
		}
	}
	if a.Arbiter {
		return nil
	}
	if a.Tier < 2 || legacySame(a, author) {
		return errors.New("original independent T2 arbiter required")
	}
	for _, v := range checks {
		if v.Verdict == "disputed" {
			b, e := k.legacyActor(v.Verifier)
			if e != nil || legacySame(a, b) {
				return errors.New("arbiter shares disputer operator")
			}
		}
	}
	return nil
}
func (k Keeper) legacyCheck(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	var p struct {
		Contribution string `json:"contribution"`
		Verifier     string `json:"verifier"`
		Verdict      string `json:"verdict"`
		Novelty      string `json:"novelty"`
		Evidence     string `json:"evidence_digest"`
		Against      string `json:"against_claim_revision"`
		Relation     string `json:"against_claim"`
		Revised      string `json:"revised_claim"`
		NoEffort     bool   `json:"no_effort"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if p.Relation != "" && p.Relation != "supports" && p.Relation != "contradicts" && p.Relation != "refutes" {
		return "", errors.New("original claim relationship invalid")
	}
	if p.Verdict == "partial" {
		p.Verdict = "disputed"
	}
	if p.Verdict != "confirmed" && p.Verdict != "disputed" || !digestPattern.MatchString(p.Evidence) || p.Novelty != "" && p.Novelty != "new" && p.Novelty != "known" || p.Novelty != "" && p.Verdict != "confirmed" {
		return "", errors.New("original verdict/novelty and evidence required")
	}
	v, e := k.legacyWork(p.Contribution)
	if e != nil {
		return "", e
	}
	if v.State != "held" && v.State != "contested" {
		return "", errors.New("original contribution already decided")
	}
	if len(v.Checks) >= 32 {
		return "", errors.New("legacy review bound reached")
	}
	a, e := k.legacyReviewer(c, p.Verifier, v.Project, v.Author)
	if e != nil {
		return "", e
	}
	author, e := k.legacyActor(v.Author)
	if e != nil {
		return "", e
	}

	belief := ""
	if v.Task != "" {
		task, e := k.legacyTask(v.Task)
		if e != nil {
			return "", e
		}
		if k.legacyTaskFinalBlocks(task) {
			return "", errors.New("final task decision closes additional original checks")
		}
		belief, e = k.legacyTaskBelief(task, v.ID)
		if e != nil {
			return "", e
		}
	}
	previous := -1
	for i, check := range v.Checks {
		if check.Verifier == a.ID {
			previous = i
			break
		}
	}
	refreshing, attesting := false, false
	if previous >= 0 {
		old := v.Checks[previous]
		refreshing = old.Verdict == "confirmed" && p.Verdict == "confirmed" && belief != "" && p.Against == belief && old.Against != belief && (v.State == "held" || legacyAwaitsDefault(v))
		attesting = old.Verdict == "confirmed" && p.Verdict == "confirmed" && old.Novelty == "" && p.Novelty != ""
	}
	if (refreshing || attesting) && (p.Revised != "" || p.NoEffort) {
		return "", errors.New("original refresh/novelty attestation cannot overwrite ruling")
	}
	if !refreshing && !attesting && !a.Default && legacyAwaitsDefault(v) {
		return "", errors.New("original default double-check required")
	}
	arbitrating := v.State == "contested"
	double := arbitrating && a.Default && legacyAwaitsDefault(v)
	bootstrap := false
	if arbitrating && !double && !refreshing && !attesting {
		if e = k.legacyArbiter(a, author, v.Checks); e != nil {
			// The original exception never permits the author or a disputing member
			// to decide their own side, and never counts as operator independence.
			eligible := a.Default && a.Member != author.Member
			for _, old := range v.Checks {
				if old.Verdict == "disputed" && old.Member == a.Member {
					eligible = false
				}
			}
			if !eligible {
				return "", e
			}
			active, censusErr := k.legacyBootstrapActive()
			if censusErr != nil {
				return "", censusErr
			}
			if !active {
				return "", e
			}
			bootstrap = true
		}
	}
	if p.Revised != "" && (!arbitrating || p.Verdict != "confirmed" || len(strings.TrimSpace(p.Revised)) < 20 || len(p.Revised) > 4000) {
		return "", errors.New("only original arbiter may revise claim")
	}
	if p.NoEffort && (!arbitrating || p.Verdict != "disputed") {
		return "", errors.New("no-effort penalty requires original rejection arbitration")
	}
	replaced := -1
	for i, check := range v.Checks {
		if check.Verifier == a.ID {
			if double && check.Verdict == "disputed" || refreshing || attesting {
				replaced = i
			} else {
				return "", errors.New("original verifier already checked")
			}
		}
	}
	if v.Task != "" {
		task, e := k.legacyTask(v.Task)
		if e != nil {
			return "", e
		}
		for _, id := range task.Contributions {
			r, e := k.legacyWork(id)
			if e != nil {
				return "", e
			}
			if !refreshing && !attesting && r.Member == a.Member && r.State != "rejected" && (!a.Default && v.State == "held" || len(v.Reconciles) > 0) {
				return "", errors.New("reviewer has rival result")
			}
		}
		{
			belief, e := k.legacyTaskBelief(task, v.ID)
			if e != nil {
				return "", e
			}
			if belief != "" && p.Verdict == "confirmed" && (p.Against != belief || p.Relation == "") {
				return "", errors.New("current original claim judgement required")
			}
		}
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	check := LegacyCheck{Bootstrap: bootstrap, ID: "native:" + strconv.FormatUint(event, 10), Verifier: a.ID, Member: a.Member, Verdict: p.Verdict, Novelty: p.Novelty, Against: p.Against, Relation: p.Relation, Revised: p.Revised, Evidence: p.Evidence}
	if e = put(k.Store, "legacy_check/"+v.ID+"/"+check.ID, check); e != nil {
		return "", e
	}
	if replaced >= 0 {
		if refreshing || attesting {
			old := v.Checks[replaced]
			if refreshing {
				old.Against = p.Against
				old.Relation = p.Relation
			}
			if attesting {
				old.Novelty = p.Novelty
			}
			old.Evidence = p.Evidence
			v.Checks[replaced] = old
		} else {
			v.Checks[replaced] = check
		}
	} else {
		v.Checks = append(v.Checks, check)
	}
	if v.State == "held" && p.Verdict == "disputed" {
		v.State = "contested"
		return v.ID, put(k.Store, "legacy_work/"+v.ID, v)
	}
	if arbitrating {
		v.Arbitrated = true
		if p.Verdict == "disputed" {
			v.State = "rejected"
			if p.NoEffort {
				if e = k.recordKarma(v.Member, v.Author, -2, "legacy_no_effort", v.ID, now); e != nil {
					return "", e
				}
			}
			if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
				return "", e
			}
			return v.ID, k.legacyPrize(v.Task, now)
		}
	}
	if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
		return "", e
	}
	return v.ID, k.legacyMaybeSettle(&v, now)
}
func (k Keeper) legacySettle(c Command, now time.Time) (string, error) {
	if e := k.legacyReady(); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) {
		return "", errors.New("guardian may resume frozen source settlement")
	}
	var p struct {
		Contribution string `json:"contribution"`
		Evidence     string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("source settlement evidence required")
	}
	v, e := k.legacyWork(p.Contribution)
	if e != nil {
		return "", e
	}
	if v.Paid || v.State == "rejected" {
		return "", errors.New("original obligation already resolved")
	}
	if v.State == "settled" && v.Pending == "" {
		return "", errors.New("already-determined historic result cannot be repriced")
	}
	return v.ID, k.legacyMaybeSettle(&v, now)
}
func (k Keeper) legacyMaybeSettle(v *LegacyWork, now time.Time) error {
	if v.Pending == "kpi_award" || k.Store.Get([]byte("legacy_future_award/"+v.ID)) != nil {
		return errors.New("immutable future recipient slots must be applied without recomputing settlement")
	}
	if v.Pending == "kpi" && v.Held != nil {
		return k.legacyFrozenKPI(v, now)
	}
	if v.Kind != "work" {
		return errors.New("non-work legacy formula needs its reviewed adopter")
	}
	author, e := k.legacyActor(v.Author)
	if e != nil {
		return e
	}
	standing := []LegacyCheck{}
	defaultPresent, known, fresh := false, false, false
	partial := false
	independent := []LegacyActor{}
	family := legacyFamily(author.Family)
	otherFamily := family == ""
	for _, v := range v.Checks {
		if v.Verdict == "disputed" || v.Member == author.Member {
			continue
		}
		a, e := k.legacyActor(v.Verifier)
		if e != nil {
			return e
		}
		standing = append(standing, v)
		defaultPresent = defaultPresent || a.Default
		known = known || v.Novelty == "known"
		fresh = fresh || v.Novelty == "new"
		partial = partial || v.Verdict == "partial"
		f := legacyFamily(a.Family)
		otherFamily = otherFamily || f != "" && f != family
		if v.Bootstrap || legacySame(author, a) {
			continue
		}
		unique := true
		for _, b := range independent {
			if legacySame(a, b) {
				unique = false
			}
		}
		if unique {
			independent = append(independent, a)
		}
	}
	if !defaultPresent || !v.Arbitrated && v.State == "contested" || v.State == "held" && len(standing) < v.Required {
		return nil
	}
	var task LegacyTask
	if v.Task != "" {
		task, e = k.legacyTask(v.Task)
		if e != nil {
			return e
		}
		known = known || task.Known
		{
			belief, e := k.legacyTaskBelief(task, v.ID)
			if e != nil {
				return e
			}
			for _, check := range standing {
				if belief != "" && check.Against != belief {
					return nil
				}
			}
		}
	}
	if !known && !fresh {
		return nil
	}
	if v.Arbitrated && !v.PenaltiesApplied {
		rewritten := false
		for _, c := range v.Checks {
			rewritten = rewritten || c.Revised != ""
		}
		if !rewritten {
			for _, c := range v.Checks {
				if c.Verdict == "disputed" {
					if e = k.recordKarma(c.Member, c.Verifier, -2, "legacy_dispute_overturned", v.ID, now); e != nil {
						return e
					}
				}
			}
		}
		v.PenaltiesApplied = true
	}
	award := legacyValue(v.Claimed, partial, v.Required < 2 || len(independent) < 2 || !otherFamily)
	v.State = "settled"
	if v.Task != "" {
		if e = k.legacyAnswerClaim(v, standing); e != nil {
			return e
		}
	}
	if known {
		v.Withheld = "known"
		award = 0
		v.Paid = true
	}
	if !known && task.Kind == "future" && task.Outcome != "met" {
		v.Pending = "kpi"
		if v.Held == nil {
			refs := []string{}
			for _, c := range standing {
				refs = append(refs, c.ID)
			}
			v.Held = &LegacyHeld{Credibility: award, Credits: award, CheckRefs: refs}
		}
		if task.Outcome == "unmet" || task.Outcome == "expired" {
			v.Pending = ""
			v.Withheld = "kpi_" + task.Outcome
			v.Paid = true
		}
		return put(k.Store, "legacy_work/"+v.ID, v)
	}
	if !known && task.Price != nil && len(v.Reconciles) == 0 {
		v.Due = &award
		if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
			return e
		}
		return k.legacyPrize(task.ID, now)
	}
	if !known {
		if e = k.legacyPay(v, award, award, standing, now); e != nil {
			return e
		}
		v.Paid = true
	}
	return put(k.Store, "legacy_work/"+v.ID, v)
}
func (k Keeper) legacyPay(v *LegacyWork, karma, credits int64, checks []LegacyCheck, now time.Time) error {
	if karma < 0 || credits < 0 || karma > MaxReward || credits > MaxReward {
		return errors.New("invalid bounded original award")
	}
	if karma > 0 {
		if e := k.recordKarma(v.Member, v.Author, karma, "legacy_verified", v.ID, now); e != nil {
			return e
		}
	}
	if e := k.legacyCredit(v.Member, v.Author, v.ID, "legacy_verified", big.NewInt(credits), now); e != nil {
		return e
	}
	if len(checks) == 0 {
		return nil
	}
	pool := credits / 5
	base, remainder := pool/int64(len(checks)), pool%int64(len(checks))
	for i, c := range checks {
		amount := base
		if int64(i) < remainder {
			amount++
		}
		if e := k.legacyCredit(c.Member, c.Verifier, v.ID, "legacy_verifier_share", big.NewInt(amount), now); e != nil {
			return e
		}
	}
	return nil
}
func (k Keeper) legacyPrize(id string, now time.Time) error {
	if id == "" {
		return nil
	}
	task, e := k.legacyTask(id)
	if e != nil {
		return e
	}
	if task.Price == nil || task.Winner != "" {
		return nil
	}
	for _, id := range task.Contributions {
		status, e := k.legacyWorkStatus(id)
		if e != nil {
			return e
		}
		if status.Task != task.ID || status.Project != task.Project {
			return errors.New("original task/status index mismatch")
		}
		if status.Kind != "work" || status.Comparison || status.State == "rejected" || status.Withheld != "" {
			continue
		}
		if status.State != "settled" || status.Pending != "" {
			return nil
		}
		if status.Paid {
			return errors.New("historic paid task missing winner; requires reconciliation")
		}
		v, e := k.legacyWork(id)
		if e != nil {
			return e
		}
		award := int64(0)
		if v.Due != nil {
			award = *v.Due
		}
		standing := []LegacyCheck{}
		for _, c := range v.Checks {
			if c.Verdict != "disputed" && c.Member != v.Member {
				standing = append(standing, c)
			}
		}
		if task.Kind == "future" && len(standing) > 4 {
			if e = k.legacyStageAward(&v, award, award, standing); e != nil {
				return e
			}
			task.Winner = v.ID
			return put(k.Store, "legacy_task/"+task.ID, task)
		}
		if e = k.legacyPay(&v, award, award, standing, now); e != nil {
			return e
		}
		v.Paid = true
		task.Winner = v.ID
		if e = put(k.Store, "legacy_work/"+v.ID, v); e != nil {
			return e
		}
		return put(k.Store, "legacy_task/"+task.ID, task)
	}
	return nil
}

func legacyAwaitsDefault(v LegacyWork) bool {
	checks := []LegacyCheck{}
	for _, c := range v.Checks {
		if c.Verdict == "disputed" || c.Member != v.Member {
			checks = append(checks, c)
		}
	}
	if v.State == "held" {
		return len(checks) >= v.Required
	}
	if v.State == "contested" {
		first := -1
		for i, c := range checks {
			if c.Verdict == "disputed" {
				first = i
				break
			}
		}
		if first < 0 {
			return true
		}
		for _, c := range checks[first+1:] {
			if c.Verdict != "disputed" {
				return true
			}
		}
	}
	return false
}
func (k Keeper) legacyProject(id string) (legacyProject, error) {
	var v legacyProject
	raw := k.Store.Get([]byte("legacy_project/" + id))
	if raw == nil {
		raw = k.Store.Get([]byte("legacy/project/" + id))
	}
	if raw == nil {
		return v, errors.New("original project not found")
	}
	e := json.Unmarshal(raw, &v)
	if e == nil {
		if raw := k.Store.Get([]byte("legacy_project_budget/" + id)); raw != nil {
			var budget legacyProjectBudget
			e = json.Unmarshal(raw, &budget)
			if e == nil {
				v.BudgetTotal = budget.Total
				v.BudgetStage = budget.Stage
				v.BudgetBasis = budget.Basis
				v.BudgetStatus = budget.Status
				v.BudgetUnlocked = budget.Unlocked
			}
		}
	}
	if e == nil && (v.ID != id || len(v.WorkIDs) > 128 || len(v.ClaimIDs) > 128 || len(v.TaskIDs) > 128 || len(v.ParticipantIDs) > 128) {
		e = errors.New("invalid original project capsule")
	}
	return v, e
}

// All permitted source claims are nonnegative integers <=1,000,000. Exact
// rational arithmetic reproduces SQL Math.round for every such input while
// keeping consensus free of floating point reward calculations.
func legacyValue(claim int64, partial, single bool) int64 {
	numerator := int64(100)
	if partial {
		numerator = 60
	}
	if single {
		numerator = numerator * 60 / 100
	}
	return (claim*numerator + 50) / 100
}
