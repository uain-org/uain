package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

const OperatorCensusPolicy = "bounded-operator-census-v1"
const OperatorCensusPage = 32
const MaxBootstrapOperators = 16

type CensusActivation struct {
	MembershipActivation
	Threshold int `json:"threshold"`
}
type CensusActor struct {
	Member   string `json:"member"`
	Instance string `json:"instance,omitempty"`
}
type CensusRevision struct {
	Value uint64 `json:"value,string"`
}
type OperatorCensus struct {
	Revision        uint64        `json:"revision,string"`
	Phase           string        `json:"phase"`
	Cursor          string        `json:"cursor"`
	Representatives []CensusActor `json:"representatives"`
	Scanned         uint64        `json:"scanned,string"`
	Complete        bool          `json:"complete"`
}
type BootstrapStatus struct {
	Ready     bool   `json:"ready"`
	Active    bool   `json:"active"`
	Operators int    `json:"operators"`
	Threshold int    `json:"threshold"`
	Revision  uint64 `json:"revision,string"`
}

func (k Keeper) activateOperatorCensus(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		Threshold      int    `json:"threshold"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != OperatorCensusPolicy || !digestPattern.MatchString(p.EvidenceDigest) || p.Threshold < 0 || p.Threshold > MaxBootstrapOperators {
		return "", errors.New("operator census needs guardian, supported policy, bounded threshold and evidence")
	}
	policy, err := k.operatorRewardPolicy(height)
	if err != nil {
		return "", err
	}
	if policy != OperatorRewardPolicy || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("operator_census_activation")) != nil {
		return "", errors.New("operator census needs active pairwise policy and an unscheduled following-height activation")
	}
	a := CensusActivation{MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest}, p.Threshold}
	if err = put(k.Store, "operator_census_revision", CensusRevision{}); err != nil {
		return "", err
	}
	return p.Policy, put(k.Store, "operator_census_activation", a)
}
func (k Keeper) censusActivation(height int64) (*CensusActivation, error) {
	if k.Store.Get([]byte("operator_census_activation")) == nil {
		return nil, nil
	}
	var a CensusActivation
	if err := get(k.Store, "operator_census_activation", &a); err != nil {
		return nil, err
	}
	if a.Policy != OperatorCensusPolicy || a.EffectiveHeight < 2 || a.Threshold < 0 || a.Threshold > MaxBootstrapOperators {
		return nil, errors.New("invalid census activation")
	}
	if height < a.EffectiveHeight {
		return nil, nil
	}
	return &a, nil
}

// No new state is written on old policy chains. Relevant identity/lifecycle
// changes invalidate a paged result; balance, sequence and role writes do not.
func invalidateCensus(s Store) error {
	if s.Get([]byte("operator_census_activation")) == nil {
		return nil
	}
	var revision CensusRevision
	if err := get(s, "operator_census_revision", &revision); err != nil {
		return err
	}
	if revision.Value == math.MaxUint64 {
		return errors.New("operator census revision exhausted")
	}
	revision.Value++
	return put(s, "operator_census_revision", revision)
}
func censusAccountChange(s Store, key string, value any) error {
	switch value.(type) {
	case Member, Instance:
	default:
		return nil
	}
	if s.Get([]byte("operator_census_activation")) == nil {
		return nil
	}
	switch next := value.(type) {
	case Member:
		var old Member
		if raw := s.Get([]byte(key)); raw != nil {
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
			if old.Licence == next.Licence {
				return nil
			}
		}
		if old.Licence == "active" || next.Licence == "active" {
			return invalidateCensus(s)
		}
	case Instance:
		var old Instance
		if raw := s.Get([]byte(key)); raw != nil {
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
			if old.State == next.State {
				return nil
			}
		}
		if old.State == "active" || next.State == "active" {
			return invalidateCensus(s)
		}
	}
	return nil
}

func (k Keeper) censusState(revision uint64, threshold int) (OperatorCensus, error) {
	state := OperatorCensus{Revision: revision, Phase: "member", Representatives: []CensusActor{}}
	if k.Store.Get([]byte("operator_census")) == nil {
		return state, nil
	}
	var stored OperatorCensus
	if err := get(k.Store, "operator_census", &stored); err != nil {
		return state, err
	}
	if stored.Revision != revision {
		return state, nil
	}
	if len(stored.Representatives) > threshold || stored.Phase != "member" && stored.Phase != "instance" && stored.Phase != "done" {
		return state, errors.New("invalid census progress")
	}
	if stored.Cursor != "" && !strings.HasPrefix(stored.Cursor, stored.Phase+"/") {
		return state, errors.New("invalid census cursor")
	}
	if stored.Complete && len(stored.Representatives) < threshold && stored.Phase != "done" {
		return state, errors.New("incomplete census marked ready")
	}
	return stored, nil
}

// Representatives follow native consensus order: member keys, then instance
// keys. Pairwise comparison is intentionally greedy and non-transitive, as in
// the federation. One member's instances never increase its operator count.
func (k Keeper) advanceOperatorCensus(c Command, height int64) (string, error) {
	var p struct{}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	a, err := k.censusActivation(height)
	if err != nil {
		return "", err
	}
	if a == nil {
		return "", errors.New("operator census is inactive")
	}
	var revision CensusRevision
	if err = get(k.Store, "operator_census_revision", &revision); err != nil {
		return "", err
	}
	state, err := k.censusState(revision.Value, a.Threshold)
	if err != nil {
		return "", err
	}
	if a.Threshold == 0 {
		state.Complete = true
		state.Phase = "done"
	}
	if state.Complete {
		return "operator_census", put(k.Store, "operator_census", state)
	}
	remaining := OperatorCensusPage
	for remaining > 0 && !state.Complete {
		prefix := state.Phase + "/"
		start := []byte(prefix)
		if state.Cursor != "" {
			start = []byte(state.Cursor + "\x00")
		}
		requested := remaining
		rows, err := k.Store.Range(start, []byte(state.Phase+"0"), requested)
		if err != nil {
			return "", err
		}
		for _, row := range rows {
			if state.Scanned == math.MaxUint64 {
				return "", errors.New("operator census scan exhausted")
			}
			state.Scanned++
			remaining--
			state.Cursor = string(row.Key)
			var actor CensusActor
			if state.Phase == "member" {
				var member Member
				if err = json.Unmarshal(row.Value, &member); err != nil {
					return "", err
				}
				if string(row.Key) != "member/"+member.ID {
					return "", errors.New("census member owner mismatch")
				}
				if member.Licence != "active" {
					continue
				}
				actor = CensusActor{Member: member.ID}
			} else {
				var instance Instance
				if err = json.Unmarshal(row.Value, &instance); err != nil {
					return "", err
				}
				if string(row.Key) != "instance/"+instance.ID {
					return "", errors.New("census instance owner mismatch")
				}
				if instance.State != "active" {
					continue
				}
				member, err := k.Member(instance.Member)
				if err != nil {
					return "", err
				}
				if member.Licence != "active" {
					continue
				}
				actor = CensusActor{instance.Member, instance.ID}
			}
			independent := true
			for _, rep := range state.Representatives {
				same, err := k.sameOperator(rep.Member, rep.Instance, actor.Member, actor.Instance)
				if err != nil {
					return "", err
				}
				if same {
					independent = false
					break
				}
			}
			if independent {
				state.Representatives = append(state.Representatives, actor)
			}
			if len(state.Representatives) >= a.Threshold {
				state.Complete = true
				break
			}
		}
		if !state.Complete && len(rows) < requested {
			if state.Phase == "member" {
				state.Phase = "instance"
				state.Cursor = ""
			} else {
				state.Phase = "done"
				state.Cursor = ""
				state.Complete = true
			}
		}
	}
	return fmt.Sprint(len(state.Representatives)), put(k.Store, "operator_census", state)
}

// A stale/incomplete count never authorizes the bootstrap exception. Threshold
// witnesses and a completed scan are different valid completion conditions.
func (k Keeper) BootstrapState(height int64) (BootstrapStatus, error) {
	a, err := k.censusActivation(height)
	if err != nil {
		return BootstrapStatus{}, err
	}
	if a == nil {
		return BootstrapStatus{}, nil
	}
	var revision CensusRevision
	if err = get(k.Store, "operator_census_revision", &revision); err != nil {
		return BootstrapStatus{}, err
	}
	state, err := k.censusState(revision.Value, a.Threshold)
	if err != nil {
		return BootstrapStatus{}, err
	}
	ready := state.Complete || a.Threshold == 0
	return BootstrapStatus{ready, ready && len(state.Representatives) < a.Threshold, len(state.Representatives), a.Threshold, revision.Value}, nil
}
