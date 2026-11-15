package federation

// Prospective fund authority. Allocations unlock reward allowance, never mint
// money or transfer assets to managers. Task review and fund evaluation are
// separate roles; UAIN's guardian appoints the licensed fund evaluator.
import (
	"errors"
	"fmt"
	"math"
	"strings"
)

var centralAllowances = [...]string{"10000000000", "110000000000", "1110000000000", "11110000000000", "111110000000000", "1000000000000000"}

func centralAllocation(round uint64) string {
	if round < 1 || round > 6 {
		return ""
	}
	return centralAllowances[round-1]
}

type CentralFundConfig struct {
	Project        string `json:"project"`
	Evaluator      string `json:"evaluator"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
}
type CentralStage struct {
	Round    uint64 `json:"round"`
	Criteria string `json:"criteria"`
}
type CentralFundPlan struct {
	MainKPI        string         `json:"main_kpi"`
	Project        string         `json:"project"`
	Revision       uint64         `json:"revision"`
	Stages         []CentralStage `json:"stages"`
	Reason         string         `json:"reason"`
	EvidenceDigest string         `json:"evidence_digest"`
	Manager        string         `json:"manager"`
	State          string         `json:"state"`
	Reviewer       string         `json:"reviewer"`
	Height         int64          `json:"height,string"`
}
type CentralFundState struct {
	Revision         uint64 `json:"revision"`
	ApprovedRevision uint64 `json:"approved_revision"`
	Pending          string `json:"pending"`
	Completed        uint64 `json:"completed"`
}
type CentralFundApplication struct {
	ID                 string `json:"id"`
	Project            string `json:"project"`
	Round              uint64 `json:"round"`
	Revision           uint64 `json:"revision"`
	EvidenceDigest     string `json:"evidence_digest"`
	Manager            string `json:"manager"`
	State              string `json:"state"`
	Evaluator          string `json:"evaluator"`
	VerificationDigest string `json:"verification_digest"`
	Feedback           string `json:"feedback"`
	MainKPIAchieved    bool   `json:"main_kpi_achieved"`
	Height             int64  `json:"height,string"`
}

func fundPlanKey(project string, revision uint64) string {
	return fmt.Sprintf("central_fund_plan/%s/%020d", project, revision)
}
func (k Keeper) centralFundTransition(c Command, height int64) (string, error) {
	bad := errors.New("invalid central fund transition")
	if _, e := k.centralActive(height); e != nil {
		return "", e
	}
	if c.Operation == "central_fund_configure" {
		var in struct {
			Project           string `json:"project"`
			Evaluator         string `json:"evaluator"`
			ExpectedEvaluator string `json:"expected_evaluator"`
			EvidenceDigest    string `json:"evidence_digest"`
		}
		if e := Decode(c.Payload, &in); e != nil {
			return "", e
		}
		_, b, e := k.centralProject(in.Project)
		m, me := k.Member(in.Evaluator)
		if e != nil || me != nil || !k.guardian(c.Member) || m.Licence != "active" || in.Evaluator == b.Manager || b.Closed || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		var old CentralFundConfig
		if k.Store.Get([]byte("central_fund_config/"+in.Project)) != nil {
			if e = get(k.Store, "central_fund_config/"+in.Project, &old); e != nil {
				return "", e
			}
		}
		if old.Evaluator != in.ExpectedEvaluator || old.Evaluator == in.Evaluator {
			return "", bad
		}
		next := CentralFundConfig{in.Project, in.Evaluator, height, in.EvidenceDigest}
		history := fmt.Sprintf("central_fund_config_history/%s/%020d/%s", in.Project, height, in.Evaluator)
		if k.Store.Get([]byte(history)) != nil {
			return "", bad
		}
		if e = put(k.Store, history, next); e != nil {
			return "", e
		}
		return in.Project, put(k.Store, "central_fund_config/"+in.Project, next)
	}
	// Every payload has a project, except decisions which resolve their exact application.
	var project string
	var application CentralFundApplication
	if c.Operation == "central_fund_decide" {
		var in struct {
			Application        string `json:"application"`
			Verdict            string `json:"verdict"`
			VerificationDigest string `json:"verification_digest"`
			Feedback           string `json:"feedback"`
			MainKPIAchieved    bool   `json:"main_kpi_achieved"`
		}
		if e := Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if !validID(in.Application) {
			return "", bad
		}
		if e := get(k.Store, "central_fund_application/"+in.Application, &application); e != nil {
			return "", e
		}
		project = application.Project
	} else {
		// Decode the full operation below, never silently accept unknown fields.
		var raw map[string]any
		if e := Decode(c.Payload, &raw); e != nil {
			return "", e
		}
		project, _ = raw["project"].(string)
	}
	_, b, e := k.centralProject(project)
	if e != nil {
		return "", e
	}
	if b.Closed {
		return "", bad
	}
	var config CentralFundConfig
	if e = get(k.Store, "central_fund_config/"+project, &config); e != nil {
		return "", e
	}
	evaluator, err := k.Member(config.Evaluator)
	if err != nil || evaluator.Licence != "active" || config.Project != project || config.Evaluator == b.Manager {
		return "", bad
	}
	var state CentralFundState
	if k.Store.Get([]byte("central_fund_state/"+project)) != nil {
		if e = get(k.Store, "central_fund_state/"+project, &state); e != nil {
			return "", e
		}
	}
	switch c.Operation {
	case "central_fund_plan":
		var in struct {
			MainKPI        string         `json:"main_kpi"`
			Project        string         `json:"project"`
			Revision       uint64         `json:"revision"`
			Stages         []CentralStage `json:"stages"`
			Reason         string         `json:"reason"`
			EvidenceDigest string         `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if c.Member != config.Evaluator || len(strings.TrimSpace(in.MainKPI)) < 20 || len(in.MainKPI) > 4096 || state.Pending != "" || state.Revision == math.MaxUint64 || in.Revision != state.Revision+1 || len(in.Stages) != 5 || len(strings.TrimSpace(in.Reason)) < 10 || len(in.Reason) > 2048 || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		var previous CentralFundPlan
		if state.ApprovedRevision > 0 {
			if e = get(k.Store, fundPlanKey(project, state.ApprovedRevision), &previous); e != nil {
				return "", e
			}
		}
		if state.ApprovedRevision > 0 && in.MainKPI != previous.MainKPI {
			return "", bad
		}
		for i, s := range in.Stages {
			if s.Round != uint64(i+1) || len(strings.TrimSpace(s.Criteria)) < 20 || len(s.Criteria) > 4096 {
				return "", bad
			}
			if uint64(i) < state.Completed && (len(previous.Stages) != 5 || s.Criteria != previous.Stages[i].Criteria) {
				return "", bad
			}
		}
		plan := CentralFundPlan{MainKPI: in.MainKPI, Project: project, Revision: in.Revision, Stages: in.Stages, Reason: in.Reason, EvidenceDigest: in.EvidenceDigest, Manager: b.Manager, State: "proposed", Height: height}
		state.Revision = in.Revision
		if e = put(k.Store, fundPlanKey(project, in.Revision), plan); e != nil {
			return "", e
		}
	case "central_fund_plan_review":
		var in struct {
			Project        string `json:"project"`
			Revision       uint64 `json:"revision"`
			Verdict        string `json:"verdict"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if c.Member != config.Evaluator || state.Pending != "" || in.Revision != state.Revision || !digestPattern.MatchString(in.EvidenceDigest) || (in.Verdict != "accept" && in.Verdict != "reject") {
			return "", bad
		}
		var plan CentralFundPlan
		if e = get(k.Store, fundPlanKey(project, in.Revision), &plan); e != nil {
			return "", e
		}
		if plan.State != "proposed" || plan.Manager == c.Member {
			return "", bad
		}
		plan.State = in.Verdict
		plan.Reviewer = c.Member
		if in.Verdict == "accept" {
			state.ApprovedRevision = in.Revision
		}
		if e = put(k.Store, fundPlanKey(project, in.Revision), plan); e != nil {
			return "", e
		}
		if e = put(k.Store, fmt.Sprintf("central_fund_plan_review/%s/%020d", project, in.Revision), struct {
			Reviewer       string `json:"reviewer"`
			Verdict        string `json:"verdict"`
			EvidenceDigest string `json:"evidence_digest"`
			Height         int64  `json:"height,string"`
		}{c.Member, in.Verdict, in.EvidenceDigest, height}); e != nil {
			return "", e
		}
	case "central_fund_apply":
		var in struct {
			ID             string `json:"id"`
			Project        string `json:"project"`
			Round          uint64 `json:"round"`
			Revision       uint64 `json:"revision"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if e = k.centralFundReady(project, b); e != nil {
			return "", e
		}
		if c.Member != b.Manager || !validID(in.ID) || state.Pending != "" || in.Round > 5 || b.Achieved || in.Round != b.Round || in.Round != state.Completed+1 || in.Revision == 0 || in.Revision != state.ApprovedRevision || !digestPattern.MatchString(in.EvidenceDigest) || k.Store.Get([]byte("central_fund_application/"+in.ID)) != nil {
			return "", bad
		}
		application = CentralFundApplication{ID: in.ID, Project: project, Round: in.Round, Revision: in.Revision, EvidenceDigest: in.EvidenceDigest, Manager: c.Member, State: "pending", Height: height}
		state.Pending = in.ID
		if e = put(k.Store, "central_fund_application/"+in.ID, application); e != nil {
			return "", e
		}
	case "central_fund_decide":
		var in struct {
			Application        string `json:"application"`
			Verdict            string `json:"verdict"`
			VerificationDigest string `json:"verification_digest"`
			Feedback           string `json:"feedback"`
			MainKPIAchieved    bool   `json:"main_kpi_achieved"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if len(strings.TrimSpace(in.Feedback)) < 20 || len(in.Feedback) > 4096 || (in.MainKPIAchieved != (application.Round == 5 && in.Verdict == "accept")) || c.Member != config.Evaluator || c.Member == application.Manager || application.State != "pending" || state.Pending != in.Application || application.Round != b.Round || application.Round != state.Completed+1 || application.Revision != state.ApprovedRevision || !digestPattern.MatchString(in.VerificationDigest) || (in.Verdict != "accept" && in.Verdict != "reject") {
			return "", bad
		}
		if in.Verdict == "accept" {
			b.Round++
			b.Allocation = centralAllocation(b.Round)
			if application.Round == 5 {
				b.Achieved = true
			}
			state.Completed = application.Round
			if e = put(k.Store, "central_project_budget/"+project, b); e != nil {
				return "", e
			}
		}
		application.Feedback = in.Feedback
		application.MainKPIAchieved = in.MainKPIAchieved

		application.State = in.Verdict
		application.Evaluator = c.Member
		application.VerificationDigest = in.VerificationDigest
		state.Pending = ""
		if e = put(k.Store, "central_fund_application/"+in.Application, application); e != nil {
			return "", e
		}
	case "central_fund_close":
		var in struct {
			Project        string `json:"project"`
			EvidenceDigest string `json:"evidence_digest"`
		}
		if e = Decode(c.Payload, &in); e != nil {
			return "", e
		}
		if c.Member != config.Evaluator || !b.Achieved || b.Round != 6 || state.Completed != 5 || b.Reserved != "0" || state.Pending != "" || !digestPattern.MatchString(in.EvidenceDigest) {
			return "", bad
		}
		b.Closed = true
		if e = put(k.Store, "central_project_budget/"+project, b); e != nil {
			return "", e
		}
	default:
		return "", bad
	}
	return project, put(k.Store, "central_fund_state/"+project, state)
}

// Paid task terms must follow a Fund Manager-defined plan available in native
// state from the start; opening allowance alone does not authorize publication.
func (k Keeper) centralFundReady(project string, b CentralBudget) error {
	var state CentralFundState
	var config CentralFundConfig
	var plan CentralFundPlan
	if e := get(k.Store, "central_fund_state/"+project, &state); e != nil {
		return e
	}
	if e := get(k.Store, "central_fund_config/"+project, &config); e != nil {
		return e
	}
	if state.ApprovedRevision == 0 {
		return errors.New("current Fund Manager KPI plan not approved")
	}
	if state.Revision != state.ApprovedRevision {
		var latest CentralFundPlan
		if e := get(k.Store, fundPlanKey(project, state.Revision), &latest); e != nil {
			return e
		}
		if latest.State != "reject" {
			return errors.New("pending Fund Manager amendment requires decision")
		}
	}
	if e := get(k.Store, fundPlanKey(project, state.ApprovedRevision), &plan); e != nil {
		return e
	}
	evaluator, e := k.Member(config.Evaluator)
	if e != nil || evaluator.Licence != "active" || config.Project != project || config.Evaluator == b.Manager || plan.Project != project || plan.Manager != b.Manager || plan.State != "accept" || len(plan.Stages) != 5 || len(strings.TrimSpace(plan.MainKPI)) < 20 {
		return errors.New("Fund Manager plan not qualified")
	}
	return nil
}
