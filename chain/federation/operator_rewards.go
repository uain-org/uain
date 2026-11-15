package federation

import (
	"errors"
	"math"
	"regexp"
	"strings"
)

const OperatorRewardPolicy = "pairwise-operator-rewards-v1"

// Following-height activation affects only projects opened under this policy.
// Compact execution is required so pairwise reads share the bounded cache.
func (k Keeper) activateOperatorRewards(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != OperatorRewardPolicy || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("operator reward activation requires guardian, supported policy and evidence")
	}
	compact, err := k.CompactStorageActive(height)
	if err != nil {
		return "", err
	}
	if !compact || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("operator_reward_activation")) != nil {
		return "", errors.New("operator rewards require active compact storage and an unscheduled policy")
	}
	a := MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest}
	return p.Policy, put(k.Store, "operator_reward_activation", a)
}

func (k Keeper) operatorRewardPolicy(height int64) (string, error) {
	var marker []byte
	if reader, ok := k.Store.(interface{ OperatorRewardMarker() []byte }); ok {
		marker = reader.OperatorRewardMarker()
	} else {
		marker = k.Store.Get([]byte("operator_reward_activation"))
	}
	if marker == nil {
		return "", nil
	}
	var a MembershipActivation
	if err := Decode(marker, &a); err != nil {
		return "", err
	}
	if a.Policy != OperatorRewardPolicy || a.EffectiveHeight < 2 {
		return "", errors.New("invalid operator reward activation state")
	}
	if height < a.EffectiveHeight {
		return "", nil
	}
	return a.Policy, nil
}

// Preserve verification order and the federation's greedy pairwise rule.
// Domain/name comparisons are not an equivalence relation. No map of operator
// names can represent a mixed proved/unproved set faithfully.
func (k Keeper) independentOperators(member, instance string, checks []Verification) (int, error) {
	if len(checks) > MaxArbitrationChecks {
		return 0, errors.New("verification bound exceeded")
	}
	reps := []Verification{}
	for _, check := range checks {
		if check.Verdict != "confirm" || check.Bootstrap {
			continue
		}
		same, err := k.sameOperator(member, instance, check.Member, check.Instance)
		if err != nil {
			return 0, err
		}
		if same {
			continue
		}
		independent := true
		for _, rep := range reps {
			same, err = k.sameOperator(rep.Member, rep.Instance, check.Member, check.Instance)
			if err != nil {
				return 0, err
			}
			if same {
				independent = false
				break
			}
		}
		if independent {
			reps = append(reps, check)
		}
	}
	return len(reps), nil
}

// Matches the current SQL modelFamily declaration rules. Unknown author
// families do not impose a difference gate; unknown checker families do not
// establish a different family for a known author. Earlier policies retain
// their original raw-family comparison.
var modelFamilies = []struct {
	pattern *regexp.Regexp
	family  string
}{
	{regexp.MustCompile(`claude|anthropic|opus|sonnet|haiku`), "anthropic"},
	{regexp.MustCompile(`codex|gpt|openai|\bo[1-9]\b|chatgpt`), "openai"},
	{regexp.MustCompile(`gemini|gemma|google|bard`), "google"},
	{regexp.MustCompile(`llama|meta`), "meta"},
	{regexp.MustCompile(`mistral|mixtral`), "mistral"},
	{regexp.MustCompile(`deepseek`), "deepseek"},
	{regexp.MustCompile(`qwen|alibaba`), "alibaba"},
	{regexp.MustCompile(`grok|xai`), "xai"},
}

func modelFamily(declaration string) string {
	for _, v := range modelFamilies {
		if v.pattern.MatchString(strings.ToLower(declaration)) {
			return v.family
		}
	}
	return ""
}

// A bounded positive witness replaces an unbounded scan of all settled work.
// It is evidence for arbitration eligibility, not a complete history/balance
// API. Dependencies are re-evaluated when used; this never freezes a tier.
type ResearchStanding struct {
	Member        string   `json:"member"`
	Instance      string   `json:"instance,omitempty"`
	Contributions []string `json:"contributions"`
}

func (k Keeper) researchTier(a ResearchStanding) (string, error) {
	if len(a.Contributions) < 1 || len(a.Contributions) > 4 {
		return "", errors.New("standing needs one to four distinct settled work records")
	}
	if _, err := k.Member(a.Member); err != nil {
		return "", err
	}
	if a.Instance != "" {
		v, err := k.Instance(a.Instance)
		if err != nil || v.Member != a.Member {
			return "", errors.New("standing instance owner mismatch")
		}
	}
	seen, qualified := map[string]bool{}, 0
	for _, id := range a.Contributions {
		if !validID(id) || seen[id] {
			return "", errors.New("invalid or duplicate standing work")
		}
		seen[id] = true
		v, err := k.contributionState(id)
		if err != nil {
			return "", err
		}
		if v.Author != a.Member || v.AuthorInstance != a.Instance || v.State != "settled" || v.AwardWithheld != "" {
			return "", errors.New("standing work must be this exact actor's paid research")
		}
		if v.Settlement != nil && !v.Settlement.Paid {
			return "", errors.New("pending work cannot qualify")
		}
		count, err := k.independentOperators(a.Member, a.Instance, v.Verifications)
		if err != nil {
			return "", err
		}
		if count >= 2 {
			qualified++
		}
	}
	p, err := k.OperatorProof(a.Member, a.Instance)
	if err != nil {
		return "", err
	}
	if p != nil && qualified >= 4 {
		return "T3", nil
	}
	if p != nil && qualified >= 2 {
		return "T2", nil
	}
	return "T1", nil
}

func (k Keeper) recordResearchStanding(c Command, height int64) (string, error) {
	policy, err := k.operatorRewardPolicy(height)
	if err != nil {
		return "", err
	}
	if policy == "" {
		return "", errors.New("operator reward policy is inactive")
	}
	var p struct {
		Contributions []string `json:"contributions"`
	}
	if err = Decode(c.Payload, &p); err != nil {
		return "", err
	}
	a := ResearchStanding{c.Member, c.Instance, p.Contributions}
	_, err = k.researchTier(a)
	if err != nil {
		return "", err
	}
	return operatorActorKey(c.Member, c.Instance), put(k.Store, "research_standing/"+operatorActorKey(c.Member, c.Instance), a)
}

func (k Keeper) ResearchTier(member, instance string) (string, error) {
	key := "research_standing/" + operatorActorKey(member, instance)
	if k.Store.Get([]byte(key)) == nil {
		return "unrecorded", nil
	}
	var a ResearchStanding
	if err := get(k.Store, key, &a); err != nil {
		return "", err
	}
	if a.Member != member || a.Instance != instance {
		return "", errors.New("standing record owner mismatch")
	}
	return k.researchTier(a)
}
