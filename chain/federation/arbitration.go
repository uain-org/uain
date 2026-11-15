package federation

import (
	"encoding/json"
	"errors"
	"math"
	"time"
)

const ArbitrationPolicy = "bounded-research-arbitration-v1"
const MaxArbitrationChecks = 22 // twenty original checks, one ruling, one default reconsideration
const DisputePenalty = int64(2)

type ArbitrationDecision struct {
	Contribution   string `json:"contribution"`
	Member         string `json:"member"`
	Instance       string `json:"instance,omitempty"`
	Verdict        string `json:"verdict"`
	Basis          string `json:"basis"`
	Bootstrap      bool   `json:"bootstrap,omitempty"`
	NoEffort       bool   `json:"no_effort,omitempty"`
	RecordDigest   string `json:"record_digest"`
	EvidenceDigest string `json:"evidence_digest"`
	Height         int64  `json:"height,string"`
	RevisedClaim   string `json:"revised_claim,omitempty"`
}
type ArbitrationFinalization struct {
	Contribution     string        `json:"contribution"`
	Penalized        []CensusActor `json:"penalized"`
	Reconsidered     []CensusActor `json:"reconsidered"`
	CorrectionExempt []CensusActor `json:"correction_exempt,omitempty"`
}

func (k Keeper) activateArbitration(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	operator, err := k.operatorRewardPolicy(height)
	if err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != ArbitrationPolicy || !digestPattern.MatchString(p.EvidenceDigest) || operator != OperatorRewardPolicy || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("arbitration_activation")) != nil {
		return "", errors.New("arbitration requires guardian, active pairwise storage policy and unscheduled following-height evidence")
	}
	return p.Policy, put(k.Store, "arbitration_activation", MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest})
}
func (k Keeper) arbitrationPolicy(height int64) (string, error) {
	var raw []byte
	if reader, ok := k.Store.(interface{ ArbitrationMarker() []byte }); ok {
		raw = reader.ArbitrationMarker()
	} else {
		raw = k.Store.Get([]byte("arbitration_activation"))
	}
	if raw == nil {
		return "", nil
	}
	var a MembershipActivation
	if err := Decode(raw, &a); err != nil {
		return "", err
	}
	if a.Policy != ArbitrationPolicy || a.EffectiveHeight < 2 {
		return "", errors.New("invalid arbitration activation")
	}
	if height < a.EffectiveHeight {
		return "", nil
	}
	return a.Policy, nil
}

func (k Keeper) arbitrationEligibility(c Command, v Contribution, m Member, height int64) (string, error) {
	if c.Member == v.Author {
		return "", errors.New("same member cannot arbitrate")
	}
	sides := []CensusActor{{Member: v.Author, Instance: v.AuthorInstance}}
	for _, check := range v.Verifications {
		if check.Member == c.Member {
			return "", errors.New("a checking member cannot decide its own dispute or verdict")
		}
		if check.Verdict == "dispute" {
			sides = append(sides, CensusActor{Member: check.Member, Instance: check.Instance})
		}
	}
	if len(sides) == 1 {
		return "", errors.New("arbitration needs a recorded dispute")
	}
	trusted, err := k.trustedArbiter(c)
	if err != nil {
		return "", err
	}
	if trusted {
		return "trusted", nil
	}
	tier, err := k.ResearchTier(c.Member, c.Instance)
	if err != nil {
		return "", err
	}
	independent := tier == "T2" || tier == "T3"
	if independent {
		for _, side := range sides {
			same, err := k.sameOperator(c.Member, c.Instance, side.Member, side.Instance)
			if err != nil {
				return "", err
			}
			if same {
				independent = false
				break
			}
		}
	}
	if independent {
		return "independent", nil
	}
	if m.DefaultVerifier {
		status, err := k.BootstrapState(height)
		if err != nil {
			return "", err
		}
		if status.Ready && status.Active {
			return "bootstrap", nil
		}
	}
	return "", errors.New("arbiter needs current T2/T3 and independence, exact trusted appointment, or a fresh active bootstrap census")
}

func (k Keeper) arbitrate(c Command, height int64, now time.Time) (string, error) {
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
	v, err := k.contributionState(p.Contribution)
	if err != nil {
		return "", err
	}
	if v.ArbitrationPolicy != ArbitrationPolicy || v.StoragePolicy != CompactStatePolicy || v.State != "contested" || k.Store.Get([]byte("arbitration/"+v.ID)) != nil {
		return "", errors.New("arbitration needs unresolved contested work under the active prospective policy")
	}
	t, err := k.taskState(v.Task)
	if err != nil {
		return "", err
	}
	project, err := k.projectState(t.Project)
	if err != nil {
		return "", err
	}
	if project.State != "active" || (t.State != "open" && t.State != "kpi_met") || t.Winner != "" || (t.Kind == "future" && t.State == "open" && kpiExpired(t.KPI, now)) {
		return "", errors.New("closed project, task or KPI cannot be arbitrated")
	}
	if err = k.requireParticipation(project, c); err != nil {
		return "", err
	}
	m, err := k.Member(c.Member)
	if err != nil {
		return "", err
	}
	if !m.DefaultVerifier && m.Karma < 100 {
		return "", errors.New("arbitration needs verifier standing")
	}
	if (p.Verdict != "confirm" && p.Verdict != "dispute") || (p.Novelty != "new" && p.Novelty != "known") || !digestPattern.MatchString(p.EvidenceDigest) || !basis(PriorArt{Basis: "arbitration checks independent public prior art", Searches: p.Searches}) || (p.Novelty == "known" && !kpiSource(p.KnownSource)) || (p.NoEffort && p.Verdict != "dispute") {
		return "", errors.New("invalid arbitration verdict, novelty, searches, evidence or no-effort finding")
	}
	if p.RevisedClaim != "" && (v.ResearchPolicy != ResearchProceedingsPolicy || p.Verdict != "confirm" || !validRevisedClaim(p.RevisedClaim)) {
		return "", errors.New("claim correction requires prospective proceedings and a bounded confirmed claim")
	}
	if len(v.Verifications) > 20 {
		return "", errors.New("original verification bound exceeded")
	}
	eligibility, err := k.arbitrationEligibility(c, v, m, height)
	if err != nil {
		return "", err
	}
	check := Verification{Member: c.Member, Instance: c.Instance, Verdict: p.Verdict, Novelty: p.Novelty, Searches: p.Searches, EvidenceDigest: p.EvidenceDigest, KnownSource: p.KnownSource, Bootstrap: eligibility == "bootstrap"}
	check, err = k.storeVerification(v.ID, check)
	if err != nil {
		return "", err
	}
	decision := ArbitrationDecision{Contribution: v.ID, Member: c.Member, Instance: c.Instance, Verdict: p.Verdict, Basis: eligibility, Bootstrap: check.Bootstrap, NoEffort: p.NoEffort, RecordDigest: check.RecordDigest, EvidenceDigest: p.EvidenceDigest, Height: height, RevisedClaim: p.RevisedClaim}
	if err = put(k.Store, "arbitration/"+v.ID, decision); err != nil {
		return "", err
	}
	decisionBytes, err := json.Marshal(decision)
	if err != nil {
		return "", err
	}
	if v.ResearchPolicy == ResearchProceedingsPolicy {
		stored, err := encodeEvidence(decisionBytes)
		if err != nil {
			return "", err
		}
		k.Store.Set([]byte("arbitration/"+v.ID), stored)
	}
	v.ArbitrationDigest = recordDigest(decisionBytes)
	v.Verifications = append(v.Verifications, check)
	if v.ResearchPolicy == ResearchProceedingsPolicy {
		if height > math.MaxInt64-v.AppealWindowBlocks {
			return "", errors.New("appeal deadline overflow")
		}
		v.State = "appeal_wait"
		v.AppealUntil = height + v.AppealWindowBlocks
	} else if p.Verdict == "dispute" {
		v.State = "rejected"
		if p.NoEffort {
			if err = k.recordKarma(v.Author, v.AuthorInstance, -DisputePenalty, "no_effort", v.ID, now); err != nil {
				return "", err
			}
		}
	} else {
		v.State = "held"
	}
	if err = put(k.Store, "contribution/"+v.ID, v); err != nil {
		return "", err
	}
	return v.ID, k.settlePending(t, now)
}

// A default verifier may reconsider exactly its original disputed actor once.
// The old immutable check remains in place, and the new check names it.
func (k Keeper) reconsideredDispute(v Contribution, m Member, instance, verdict string) (string, error) {
	if v.ArbitrationPolicy == "" {
		return "", nil
	}
	if v.ArbitrationPolicy != ArbitrationPolicy {
		return "", errors.New("unsupported arbitration policy")
	}
	if k.Store.Get([]byte("arbitration/"+v.ID)) == nil {
		return "", nil
	}
	d, err := k.effectiveArbitration(v)
	if err != nil {
		return "", err
	}
	if d.Contribution != v.ID || d.Verdict != "confirm" || verdict != "confirm" {
		return "", errors.New("a final ruling cannot be overwritten by another ordinary dispute")
	}
	if !m.DefaultVerifier {
		return "", nil
	}
	for _, check := range v.Verifications {
		if check.Member == m.ID && check.Instance == instance && check.Verdict == "dispute" {
			return check.RecordDigest, nil
		}
	}
	return "", nil
}

// Penalties are charged once when sufficient confirmations/default oversight
// first freeze an award, including a future award still waiting on its KPI.
func (k Keeper) finalizeArbitration(v Contribution, checks []Verification, now time.Time) error {
	if v.ArbitrationPolicy == "" {
		return nil
	}
	if v.ArbitrationPolicy != ArbitrationPolicy {
		return errors.New("unsupported arbitration policy")
	}
	raw := k.Store.Get([]byte("arbitration/" + v.ID))
	if raw == nil {
		return nil
	}
	d, err := k.effectiveArbitration(v)
	if err != nil {
		return err
	}
	if d.Contribution != v.ID || d.Verdict != "confirm" {
		return errors.New("invalid confirmed arbitration")
	}
	key := "arbitration_finalization/" + v.ID
	if k.Store.Get([]byte(key)) != nil {
		return nil
	}
	finalized := ArbitrationFinalization{Contribution: v.ID, Penalized: []CensusActor{}, Reconsidered: []CensusActor{}}
	for _, old := range v.Verifications {
		if old.Verdict != "dispute" {
			continue
		}
		exempt := false
		for _, check := range checks {
			if check.Member == old.Member && check.Instance == old.Instance && check.Reconsiders == old.RecordDigest {
				exempt = true
				break
			}
		}
		actor := CensusActor{Member: old.Member, Instance: old.Instance}
		if d.RevisedClaim != "" && !exempt {
			finalized.CorrectionExempt = append(finalized.CorrectionExempt, actor)
			continue
		}
		if exempt {
			finalized.Reconsidered = append(finalized.Reconsidered, actor)
			continue
		}
		if err := k.recordKarma(old.Member, old.Instance, -DisputePenalty, "dispute_overturned", v.ID, now); err != nil {
			return err
		}
		finalized.Penalized = append(finalized.Penalized, actor)
	}
	return put(k.Store, key, finalized)
}

// Arbitration reconstructs the ruling from its digest committed in the answer
// and its immutable verification evidence. Historical eligibility is a claim
// about execution height; current roles/licences do not rewrite that record.
func (k Keeper) Arbitration(id string) (ArbitrationDecision, error) {
	var d ArbitrationDecision
	v, err := k.contributionState(id)
	if err != nil {
		return d, err
	}
	raw := k.Store.Get([]byte("arbitration/" + id))
	if raw != nil && v.ResearchPolicy == ResearchProceedingsPolicy {
		raw, err = decodeEvidence(raw)
		if err != nil {
			return d, err
		}
	}
	if v.ArbitrationPolicy != ArbitrationPolicy || !digestPattern.MatchString(v.ArbitrationDigest) || raw == nil || recordDigest(raw) != v.ArbitrationDigest {
		return d, errors.New("missing or mismatched committed arbitration")
	}
	if err = Decode(raw, &d); err != nil {
		return d, err
	}
	if d.Contribution != id || d.Member == v.Author || d.Height < 1 || (d.Basis != "trusted" && d.Basis != "independent" && d.Basis != "bootstrap") || d.Bootstrap != (d.Basis == "bootstrap") || (d.NoEffort && d.Verdict != "dispute") {
		return d, errors.New("invalid arbitration binding")
	}
	for _, summary := range v.Verifications {
		if summary.RecordDigest != d.RecordDigest {
			continue
		}
		check, err := k.fullVerification(id, summary)
		if err != nil {
			return d, err
		}
		if check.Member != d.Member || check.Instance != d.Instance || check.Verdict != d.Verdict || check.Bootstrap != d.Bootstrap || check.EvidenceDigest != d.EvidenceDigest {
			return d, errors.New("arbitration verification differs")
		}
		return d, nil
	}
	return d, errors.New("arbitration check is absent")
}
