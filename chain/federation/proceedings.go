package federation

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

const ResearchProceedingsPolicy = "bounded-research-proceedings-v1"
const MaxProceedingChecks = 23 // twenty checks, original ruling, appeal ruling, default reconsideration

type ResearchProceedingsActivation struct {
	Policy             string `json:"policy"`
	EffectiveHeight    int64  `json:"effective_height,string"`
	Guardian           string `json:"guardian"`
	EvidenceDigest     string `json:"evidence_digest"`
	AppealWindowBlocks int64  `json:"appeal_window_blocks,string"`
}
type ResearchAppeal struct {
	Contribution           string `json:"contribution"`
	Member                 string `json:"member"`
	Instance               string `json:"instance,omitempty"`
	OriginalDecisionDigest string `json:"original_decision_digest"`
	EvidenceDigest         string `json:"evidence_digest"`
	Reason                 string `json:"reason"`
	Height                 int64  `json:"height,string"`
}

func validRevisedClaim(s string) bool {
	return strings.TrimSpace(s) == s && len(s) >= 20 && len(s) <= 4000
}
func (k Keeper) activateResearchProceedings(c Command, height int64) (string, error) {
	var p struct {
		Policy             string `json:"policy"`
		EvidenceDigest     string `json:"evidence_digest"`
		AppealWindowBlocks int64  `json:"appeal_window_blocks,string"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	policy, err := k.arbitrationPolicy(height)
	if err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != ResearchProceedingsPolicy || policy != ArbitrationPolicy || !digestPattern.MatchString(p.EvidenceDigest) || p.AppealWindowBlocks < 1 || p.AppealWindowBlocks > 1000000 || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("research_proceedings_activation")) != nil {
		return "", errors.New("research proceedings need guardian, active arbitration, bounded explicit appeal window and review evidence")
	}
	return p.Policy, put(k.Store, "research_proceedings_activation", ResearchProceedingsActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest, p.AppealWindowBlocks})
}
func (k Keeper) assignResearchProceedings(v *Contribution, height int64) error {
	raw := k.Store.Get([]byte("research_proceedings_activation"))
	if raw == nil {
		return nil
	}
	var a ResearchProceedingsActivation
	if err := Decode(raw, &a); err != nil {
		return err
	}
	if a.Policy != ResearchProceedingsPolicy || a.EffectiveHeight < 2 || a.AppealWindowBlocks < 1 || a.AppealWindowBlocks > 1000000 {
		return errors.New("invalid research proceedings activation")
	}
	if height >= a.EffectiveHeight {
		v.ResearchPolicy = a.Policy
		v.AppealWindowBlocks = a.AppealWindowBlocks
	}
	return nil
}
func (k Keeper) proceedingContext(c Command, now time.Time) (Contribution, Task, error) {
	var p struct {
		Contribution string `json:"contribution"`
	}
	// The caller decodes its full payload strictly. This extracts only its owner.
	if err := json.Unmarshal(c.Payload, &p); err != nil {
		return Contribution{}, Task{}, err
	}
	v, err := k.contributionState(p.Contribution)
	if err != nil {
		return v, Task{}, err
	}
	if v.ResearchPolicy != ResearchProceedingsPolicy || v.ArbitrationClosed || v.Settlement != nil || v.ArbitrationDigest == "" {
		return v, Task{}, errors.New("no open prospective research proceeding")
	}
	t, err := k.taskState(v.Task)
	if err != nil {
		return v, t, err
	}
	project, err := k.projectState(t.Project)
	if err != nil {
		return v, t, err
	}
	if project.State != "active" || (t.State != "open" && t.State != "kpi_met") || t.Winner != "" || (t.Kind == "future" && t.State == "open" && kpiExpired(t.KPI, now)) {
		return v, t, errors.New("closed project, task or KPI cannot continue a proceeding")
	}
	if err = k.requireParticipation(project, c); err != nil {
		return v, t, err
	}
	return v, t, nil
}
func (k Keeper) closeArbitration(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		Contribution string `json:"contribution"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	v, t, err := k.proceedingContext(c, now)
	if err != nil {
		return "", err
	}
	if v.State != "appeal_wait" || v.AppealDigest != "" || height < v.AppealUntil {
		return "", errors.New("appeal window remains open or an appeal awaits decision")
	}
	d, err := k.Arbitration(v.ID)
	if err != nil {
		return "", err
	}
	return v.ID, k.finishResearchProceeding(v, t, d, now)
}
func (k Keeper) appealArbitration(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		Contribution   string `json:"contribution"`
		EvidenceDigest string `json:"evidence_digest"`
		Reason         string `json:"reason"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	v, _, err := k.proceedingContext(c, now)
	if err != nil {
		return "", err
	}
	if v.State != "appeal_wait" || v.AppealDigest != "" || height >= v.AppealUntil || !digestPattern.MatchString(p.EvidenceDigest) || !validRevisedClaim(p.Reason) {
		return "", errors.New("one evidence-bound appeal is allowed inside its recorded window")
	}
	side := c.Member == v.Author
	for _, check := range v.Verifications {
		if check.Member == c.Member && check.Verdict == "dispute" && check.RecordDigest != "" {
			side = true
		}
	}
	d, err := k.Arbitration(v.ID)
	if err != nil {
		return "", err
	}
	if !side || c.Member == d.Member {
		return "", errors.New("only the author or an original disputer may appeal")
	}
	a := ResearchAppeal{v.ID, c.Member, c.Instance, v.ArbitrationDigest, p.EvidenceDigest, p.Reason, height}
	v.AppealDigest, err = storeImmutable(k.Store, "research_appeal/"+v.ID, a)
	if err != nil {
		return "", err
	}
	v.State = "appealed"
	return v.ID, put(k.Store, "contribution/"+v.ID, v)
}
func (k Keeper) resolveAppeal(c Command, height int64, now time.Time) (string, error) {
	var p struct {
		Contribution   string   `json:"contribution"`
		Verdict        string   `json:"verdict"`
		Novelty        string   `json:"novelty"`
		Searches       []string `json:"searches"`
		EvidenceDigest string   `json:"evidence_digest"`
		KnownSource    string   `json:"known_source"`
		NoEffort       bool     `json:"no_effort"`
		RevisedClaim   string   `json:"revised_claim"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	v, t, err := k.proceedingContext(c, now)
	if err != nil {
		return "", err
	}
	if v.State != "appealed" || v.AppealDigest == "" || v.AppealDecisionDigest != "" {
		return "", errors.New("no unresolved appeal")
	}
	if err = k.validateResearchProceedings(v); err != nil {
		return "", err
	}
	if (p.Verdict != "confirm" && p.Verdict != "dispute") || (p.Novelty != "new" && p.Novelty != "known") || !digestPattern.MatchString(p.EvidenceDigest) || !basis(PriorArt{Basis: "appeal checks independent public prior art", Searches: p.Searches}) || (p.Novelty == "known" && !kpiSource(p.KnownSource)) || (p.NoEffort && p.Verdict != "dispute") || (p.RevisedClaim != "" && (p.Verdict != "confirm" || !validRevisedClaim(p.RevisedClaim))) {
		return "", errors.New("invalid appeal ruling evidence or correction")
	}
	m, err := k.Member(c.Member)
	if err != nil {
		return "", err
	}
	if !m.DefaultVerifier && m.Karma < 100 {
		return "", errors.New("appeal ruling needs verifier standing")
	}
	eligibility, err := k.arbitrationEligibility(c, v, m, height)
	if err != nil {
		return "", err
	}
	if len(v.Verifications) >= MaxProceedingChecks-1 {
		return "", errors.New("appeal verification bound exceeded")
	}
	check, err := k.storeVerification(v.ID, Verification{Member: c.Member, Instance: c.Instance, Verdict: p.Verdict, Novelty: p.Novelty, Searches: p.Searches, EvidenceDigest: p.EvidenceDigest, KnownSource: p.KnownSource, Bootstrap: eligibility == "bootstrap"})
	if err != nil {
		return "", err
	}
	d := ArbitrationDecision{Contribution: v.ID, Member: c.Member, Instance: c.Instance, Verdict: p.Verdict, Basis: eligibility, Bootstrap: check.Bootstrap, NoEffort: p.NoEffort, RecordDigest: check.RecordDigest, EvidenceDigest: p.EvidenceDigest, Height: height, RevisedClaim: p.RevisedClaim}
	v.AppealDecisionDigest, err = storeImmutable(k.Store, "research_appeal_decision/"+v.ID, d)
	if err != nil {
		return "", err
	}
	v.Verifications = append(v.Verifications, check)
	return v.ID, k.finishResearchProceeding(v, t, d, now)
}
func (k Keeper) finishResearchProceeding(v Contribution, t Task, d ArbitrationDecision, now time.Time) error {
	v.ArbitrationClosed = true
	if d.Verdict == "dispute" {
		v.State = "rejected"
		if d.NoEffort {
			if err := k.recordKarma(v.Author, v.AuthorInstance, -DisputePenalty, "no_effort", v.ID, now); err != nil {
				return err
			}
		}
	} else {
		v.State = "held"
	}
	if err := put(k.Store, "contribution/"+v.ID, v); err != nil {
		return err
	}
	return k.settlePending(t, now)
}
func (k Keeper) effectiveArbitration(v Contribution) (ArbitrationDecision, error) {
	var d ArbitrationDecision
	key := "arbitration/" + v.ID
	if v.AppealDecisionDigest != "" {
		key = "research_appeal_decision/" + v.ID
	}
	if v.ResearchPolicy == ResearchProceedingsPolicy {
		digest := v.ArbitrationDigest
		if v.AppealDecisionDigest != "" {
			digest = v.AppealDecisionDigest
		}
		err := committedRecord(k.Store, key, digest, &d)
		return d, err
	}
	err := get(k.Store, key, &d)
	return d, err
}
func (k Keeper) validateResearchProceedings(v Contribution) error {
	if v.ResearchPolicy != ResearchProceedingsPolicy || v.ArbitrationPolicy != ArbitrationPolicy || v.AppealWindowBlocks < 1 || v.AppealWindowBlocks > 1000000 || len(v.Verifications) > MaxProceedingChecks {
		return errors.New("invalid prospective proceeding")
	}
	if v.ArbitrationDigest == "" {
		if v.AppealUntil != 0 || v.AppealDigest != "" || v.AppealDecisionDigest != "" || v.ArbitrationClosed {
			return errors.New("orphan proceeding state")
		}
		return nil
	}
	d, err := k.Arbitration(v.ID)
	if err != nil {
		return err
	}
	if d.Height > math.MaxInt64-v.AppealWindowBlocks || v.AppealUntil != d.Height+v.AppealWindowBlocks || d.RevisedClaim != "" && !validRevisedClaim(d.RevisedClaim) {
		return errors.New("invalid proceeding deadline or original correction")
	}
	terminal := v.State == "withheld" && (v.AwardWithheld == "known" || v.AwardWithheld == "kpi_unmet" || v.AwardWithheld == "kpi_expired")
	if v.AppealDigest == "" {
		if v.AppealDecisionDigest != "" || (!v.ArbitrationClosed && v.State != "appeal_wait" && !terminal) {
			return errors.New("orphan appeal decision")
		}
		return nil
	}
	var a ResearchAppeal
	if err = committedRecord(k.Store, "research_appeal/"+v.ID, v.AppealDigest, &a); err != nil {
		return err
	}
	if a.Contribution != v.ID || a.OriginalDecisionDigest != v.ArbitrationDigest || a.Member == d.Member || !digestPattern.MatchString(a.EvidenceDigest) || !validRevisedClaim(a.Reason) || a.Height < d.Height || a.Height >= v.AppealUntil {
		return errors.New("invalid appeal binding")
	}
	side := a.Member == v.Author
	for _, check := range v.Verifications {
		if check.Member == a.Member && check.Verdict == "dispute" {
			side = true
		}
	}
	if !side {
		return errors.New("appeal is not by an original side")
	}
	if v.AppealDecisionDigest == "" {
		if v.ArbitrationClosed || (v.State != "appealed" && !terminal) {
			return errors.New("unresolved appeal lost withholding")
		}
		return nil
	}
	var ruling ArbitrationDecision
	if err = committedRecord(k.Store, "research_appeal_decision/"+v.ID, v.AppealDecisionDigest, &ruling); err != nil {
		return err
	}
	if !v.ArbitrationClosed || ruling.Contribution != v.ID || ruling.Member == v.Author || ruling.Member == a.Member || ruling.Member == d.Member || ruling.Height < a.Height || (ruling.Verdict != "confirm" && ruling.Verdict != "dispute") || (ruling.NoEffort && ruling.Verdict != "dispute") || (ruling.RevisedClaim != "" && (ruling.Verdict != "confirm" || !validRevisedClaim(ruling.RevisedClaim))) || (ruling.Basis != "trusted" && ruling.Basis != "independent" && ruling.Basis != "bootstrap") || ruling.Bootstrap != (ruling.Basis == "bootstrap") {
		return errors.New("invalid appeal ruling binding")
	}
	for _, check := range v.Verifications {
		if check.RecordDigest == ruling.RecordDigest {
			full, err := k.fullVerification(v.ID, check)
			if err != nil {
				return err
			}
			if full.Member == ruling.Member && full.Instance == ruling.Instance && full.Verdict == ruling.Verdict && full.EvidenceDigest == ruling.EvidenceDigest && full.Bootstrap == ruling.Bootstrap {
				return nil
			}
			return errors.New("appeal ruling differs from immutable check")
		}
	}
	return errors.New("appeal ruling check absent")
}
