package federation

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

// Original SQL identities/order remain distinct from prospective DNS-observer
// independence. A signed page examines at most 32 actors and keeps at most the
// reviewed threshold (16) representatives. Every identity/licence change
// invalidates the result; balances, sequence, roles and membership do not.
type LegacyBootstrapCensus struct {
	Revision        uint64        `json:"revision,string"`
	Phase           string        `json:"phase"`
	Cursor          string        `json:"cursor"`
	Representatives []LegacyActor `json:"representatives"`
	Complete        bool          `json:"complete"`
}

func legacyBootstrapRevision(s Store) (uint64, error) {
	if s.Get([]byte("legacy_bootstrap_revision")) == nil {
		return 0, nil
	}
	var value CensusRevision
	err := get(s, "legacy_bootstrap_revision", &value)
	return value.Value, err
}
func legacyPolicyAccountChange(s Store, key string, value any) error {
	if s.Get([]byte("legacy/policy")) == nil {
		return nil
	}
	changed := false
	switch next := value.(type) {
	case Member:
		var old Member
		if raw := s.Get([]byte(key)); raw != nil {
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
		}
		changed = old.Licence != next.Licence && (old.Licence == "active" || next.Licence == "active")
	case Instance:
		var old Instance
		if raw := s.Get([]byte(key)); raw != nil {
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
		}
		changed = old.State != next.State && (old.State == "active" || next.State == "active")
	case ActorIdentity:
		changed = next.Instance != "" && s.Get([]byte("legacy/actor/"+next.Instance)) == nil
	case OperatorProof:
		changed = next.Instance != "" && s.Get([]byte("legacy/actor/"+next.Instance)) == nil
	}
	if !changed {
		return nil
	}
	revision, err := legacyBootstrapRevision(s)
	if err != nil {
		return err
	}
	if revision == math.MaxUint64 {
		return errors.New("original bootstrap census revision exhausted")
	}
	return put(s, "legacy_bootstrap_revision", CensusRevision{Value: revision + 1})
}
func (k Keeper) legacyCensusActor(id string, original bool) (LegacyActor, bool, error) {
	v, err := k.Instance(id)
	if err != nil {
		return LegacyActor{}, false, err
	}
	m, err := k.Member(v.Member)
	if err != nil {
		return LegacyActor{}, false, err
	}
	if v.State != "active" || m.Licence != "active" || m.PublicKey == "" {
		return LegacyActor{}, false, nil
	}
	if original {
		a, err := k.legacyActor(id)
		if err != nil {
			return a, false, err
		}
		if a.Member != v.Member {
			return a, false, errors.New("original bootstrap actor ownership differs")
		}
		return a, true, nil
	}
	a := LegacyActor{ID: id, Member: m.ID, Operator: m.Operator}
	if k.Store.Get([]byte("actor_identity/"+operatorActorKey(m.ID, id))) != nil {
		identity, err := k.ActorIdentity(m.ID, id)
		if err != nil {
			return a, false, err
		}
		a.Operator = identity.Operator
	}
	proof, err := k.OperatorProof(m.ID, id)
	if err != nil {
		return a, false, err
	}
	if proof != nil {
		a.OperatorVerified = true
		a.OperatorDomain = proof.Domain
	}
	return a, true, nil
}
func (k Keeper) legacyBootstrapCensusPage(c Command) (string, error) {
	if err := k.legacyReady(); err != nil {
		return "", err
	}
	var payload struct{}
	if err := Decode(c.Payload, &payload); err != nil {
		return "", err
	}
	policy, err := k.legacyPublicPolicy()
	if err != nil {
		return "", err
	}
	if policy == nil {
		return "", errors.New("explicit original bootstrap policy required")
	}
	revision, err := legacyBootstrapRevision(k.Store)
	if err != nil {
		return "", err
	}
	state := LegacyBootstrapCensus{Revision: revision, Phase: "original", Representatives: []LegacyActor{}}
	if k.Store.Get([]byte("legacy_bootstrap_census")) != nil {
		var stored LegacyBootstrapCensus
		if err = get(k.Store, "legacy_bootstrap_census", &stored); err != nil {
			return "", err
		}
		if stored.Revision == revision {
			state = stored
		}
	}
	if len(state.Representatives) > policy.BootstrapOperators || state.Phase != "original" && state.Phase != "native" && state.Phase != "done" {
		return "", errors.New("invalid original bootstrap census progress")
	}
	if state.Complete {
		return "", errors.New("original bootstrap census already complete")
	}
	if len(state.Representatives) >= policy.BootstrapOperators {
		state.Complete = true
		state.Phase = "done"
	}
	if !state.Complete {
		prefix := "legacy/bootstrap_order/"
		if state.Phase == "native" {
			prefix = "instance/"
		}
		start := prefix
		if state.Cursor != "" {
			if !strings.HasPrefix(state.Cursor, prefix) {
				return "", errors.New("invalid original census cursor")
			}
			start = state.Cursor + "\x00"
		}
		rows, err := k.Store.Range([]byte(start), []byte(prefix+"\xff"), OperatorCensusPage)
		if err != nil {
			return "", err
		}
		for _, row := range rows {
			state.Cursor = string(row.Key)
			id := strings.TrimPrefix(string(row.Key), prefix)
			original := state.Phase == "original"
			if original {
				if err = Decode(row.Value, &id); err != nil {
					return "", err
				}
				// Unkeyed original identities retain their archive but cannot enter the
				// active licensed census before legitimate recovery.
				var raw LegacyActor
				if err = get(k.Store, "legacy/actor/"+id, &raw); err != nil {
					return "", err
				}
				if raw.Member == "" || k.Store.Get([]byte("member/"+raw.Member)) == nil {
					continue
				}
			} else if k.Store.Get([]byte("legacy/actor/"+id)) != nil {
				continue
			}
			a, active, err := k.legacyCensusActor(id, original)
			if err != nil {
				return "", err
			}
			if !active {
				continue
			}
			distinct := true
			for _, rep := range state.Representatives {
				if legacySame(rep, a) {
					distinct = false
					break
				}
			}
			if distinct {
				state.Representatives = append(state.Representatives, a)
			}
			if len(state.Representatives) >= policy.BootstrapOperators {
				state.Complete = true
				state.Phase = "done"
				break
			}
		}
		if !state.Complete && len(rows) < OperatorCensusPage {
			if state.Phase == "original" {
				state.Phase = "native"
				state.Cursor = ""
			} else {
				state.Phase = "done"
				state.Complete = true
			}
		}
	}
	return "original-bootstrap", put(k.Store, "legacy_bootstrap_census", state)
}
func (k Keeper) legacyBootstrapActive() (bool, error) {
	policy, err := k.legacyPublicPolicy()
	if err != nil {
		return false, err
	}
	if policy == nil {
		return false, errors.New("explicit original bootstrap policy required")
	}
	if policy.BootstrapOperators == 0 {
		return false, nil
	}
	revision, err := legacyBootstrapRevision(k.Store)
	if err != nil {
		return false, err
	}
	var state LegacyBootstrapCensus
	if err = get(k.Store, "legacy_bootstrap_census", &state); err != nil {
		return false, errors.New("complete fresh bounded original bootstrap census required")
	}
	if !state.Complete || state.Revision != revision {
		return false, errors.New("complete fresh bounded original bootstrap census required")
	}
	if state.Phase != "done" || len(state.Representatives) > policy.BootstrapOperators {
		return false, errors.New("invalid original bootstrap result")
	}
	return len(state.Representatives) < policy.BootstrapOperators, nil
}
