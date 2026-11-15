package proof

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
)

// Validator-set transitions (9 November 2026). The chain changes validators
// only through a guardian-quorum validator_set_update; EndBlock H returns the
// change and header H+1 commits it as NextValidatorsHash, signed by the
// outgoing set. A Transition carries that header and the incoming set.
// Advance starts from the independently pinned genesis set and accepts each
// transition only when more than two thirds of the currently trusted set
// signed it and the incoming set hashes to its NextValidatorsHash. The result
// is a trust anchor naming the latest verified set; headers signed only by a
// retired set are then rejected by Verify.

const MaxTransitions = 64

type TransitionValidator struct {
	PubKey []byte `json:"pub_key"`
	Power  int64  `json:"power"`
}

type Transition struct {
	SignedHeader   cmttypes.SignedHeader `json:"signed_header"`
	NextValidators []TransitionValidator `json:"next_validators"`
}

func transitionSet(vs []TransitionValidator) (*cmttypes.ValidatorSet, error) {
	if len(vs) == 0 || len(vs) > 50 {
		return nil, errors.New("transition validator set must hold 1 to 50 validators")
	}
	validators := make([]*cmttypes.Validator, len(vs))
	for i, v := range vs {
		if len(v.PubKey) != cmted.PubKeySize || v.Power <= 0 {
			return nil, errors.New("invalid transition validator")
		}
		validators[i] = cmttypes.NewValidator(cmted.PubKey(v.PubKey), v.Power)
	}
	set := cmttypes.NewValidatorSet(validators)
	if err := set.ValidateBasic(); err != nil {
		return nil, err
	}
	return set, nil
}

func genesisSet(genesis *cmttypes.GenesisDoc) *cmttypes.ValidatorSet {
	validators := make([]*cmttypes.Validator, len(genesis.Validators))
	for i, v := range genesis.Validators {
		validators[i] = cmttypes.NewValidator(v.PubKey, v.Power)
	}
	return cmttypes.NewValidatorSet(validators)
}

// Advance returns a copy of genesis whose Validators are the set reached by
// verifying every transition in order. The genesis document itself is never
// taken from the RPC that supplied the transitions.
func Advance(genesis *cmttypes.GenesisDoc, transitions []Transition) (*cmttypes.GenesisDoc, error) {
	if genesis == nil || len(genesis.Validators) == 0 {
		return nil, errors.New("independent genesis required")
	}
	if len(transitions) > MaxTransitions {
		return nil, errors.New("too many validator transitions")
	}
	set := genesisSet(genesis)
	var last int64
	for i, tr := range transitions {
		sh := tr.SignedHeader
		if err := sh.ValidateBasic(genesis.ChainID); err != nil {
			return nil, fmt.Errorf("transition %d: %w", i, err)
		}
		if sh.Height <= last || sh.Time.Before(genesis.GenesisTime) {
			return nil, fmt.Errorf("transition %d out of order", i)
		}
		if !bytes.Equal(set.Hash(), sh.ValidatorsHash) {
			return nil, fmt.Errorf("transition %d is not signed by the trusted set", i)
		}
		if err := set.VerifyCommitLightAllSignatures(genesis.ChainID, sh.Commit.BlockID, sh.Height, sh.Commit); err != nil {
			return nil, fmt.Errorf("transition %d signatures: %w", i, err)
		}
		next, err := transitionSet(tr.NextValidators)
		if err != nil {
			return nil, fmt.Errorf("transition %d: %w", i, err)
		}
		if !bytes.Equal(next.Hash(), sh.NextValidatorsHash) {
			return nil, fmt.Errorf("transition %d incoming set does not match the signed header", i)
		}
		set, last = next, sh.Height
	}
	out := *genesis
	out.Validators = make([]cmttypes.GenesisValidator, len(set.Validators))
	for i, v := range set.Validators {
		out.Validators[i] = cmttypes.GenesisValidator{Address: v.Address, PubKey: v.PubKey, Power: v.VotingPower}
	}
	return &out, nil
}

// TransitionSource is the untrusted RPC used to collect transitions. Every
// value it returns is checked by Advance.
type TransitionSource interface {
	Query(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error)
	Commit(context.Context, *int64) (*coretypes.ResultCommit, error)
	Validators(context.Context, *int64, *int, *int) (*coretypes.ResultValidators, error)
}

// FetchTransitions lists the validator epochs recorded in state at height and
// collects each committing header and incoming set.
func FetchTransitions(ctx context.Context, src TransitionSource, height int64) ([]Transition, error) {
	raw := func(key string) ([]byte, error) {
		q, err := src.Query(ctx, "/store/federation/key", []byte(key), height, false)
		if err != nil {
			return nil, err
		}
		if q.Code != 0 {
			return nil, fmt.Errorf("query %s failed", key)
		}
		return q.Value, nil
	}
	value, err := raw("validator_epoch_count")
	if err != nil || len(value) == 0 {
		return nil, err
	}
	var count uint64
	if err = json.Unmarshal(value, &count); err != nil || count > MaxTransitions {
		return nil, errors.New("invalid or excessive validator epoch count")
	}
	out := []Transition{}
	for n := uint64(1); n <= count; n++ {
		value, err = raw(fmt.Sprintf("validator_epoch/%020d", n))
		if err != nil {
			return nil, err
		}
		var epoch struct {
			HeaderHeight int64 `json:"header_height,string"`
		}
		if err = json.Unmarshal(value, &epoch); err != nil || epoch.HeaderHeight < 2 {
			return nil, errors.New("invalid validator epoch record")
		}
		h := epoch.HeaderHeight
		if h > height+1 {
			break
		}
		commit, err := src.Commit(ctx, &h)
		if err != nil {
			return nil, err
		}
		nextHeight := h + 1
		page, perPage := 1, 100
		vs, err := src.Validators(ctx, &nextHeight, &page, &perPage)
		if err != nil {
			return nil, err
		}
		tr := Transition{SignedHeader: commit.SignedHeader}
		for _, v := range vs.Validators {
			tr.NextValidators = append(tr.NextValidators, TransitionValidator{PubKey: v.PubKey.Bytes(), Power: v.VotingPower})
		}
		out = append(out, tr)
	}
	return out, nil
}
