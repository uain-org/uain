// Package proof verifies UAIN chain state. Its trust anchor is an
// independently obtained genesis, never a genesis supplied by the RPC. Since
// 9 November 2026 the anchor may be advanced through signed validator-set
// transitions (transitions.go); a bundle may carry them itself.
package proof

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
)

type Bundle struct {
	SignedHeader cmttypes.SignedHeader `json:"signed_header"`
	Query        abci.ResponseQuery    `json:"query"`
	Transitions  []Transition          `json:"validator_transitions,omitempty"`
}

func VerifyQuery(query abci.ResponseQuery, key string, appHash []byte, height int64) error {
	if query.Code != 0 || query.Height != height || !bytes.Equal(query.Key, []byte(key)) || len(query.Value) == 0 || query.ProofOps == nil || len(appHash) != 32 {
		return errors.New("query code, height, key, value or proof does not match request")
	}
	path := "/federation/" + url.PathEscape(key)
	if err := rootmulti.DefaultProofRuntime().VerifyValue(query.ProofOps, appHash, path, query.Value); err != nil {
		return fmt.Errorf("invalid state proof: %w", err)
	}
	return nil
}

func Verify(genesis *cmttypes.GenesisDoc, bundle Bundle, key string, now time.Time, maxAge time.Duration) error {
	if genesis == nil || len(genesis.Validators) == 0 || maxAge <= 0 {
		return errors.New("independent genesis and positive freshness limit required")
	}
	if len(bundle.Transitions) > 0 {
		advanced, err := Advance(genesis, bundle.Transitions)
		if err != nil {
			return err
		}
		genesis = advanced
	}
	sh := bundle.SignedHeader
	if err := sh.ValidateBasic(genesis.ChainID); err != nil {
		return err
	}
	if sh.Height <= 2 || sh.Time.Before(genesis.GenesisTime) || now.Sub(sh.Time) > maxAge || sh.Time.After(now.Add(time.Minute)) {
		return errors.New("header outside permitted height/time range")
	}
	validators := make([]*cmttypes.Validator, len(genesis.Validators))
	for i, v := range genesis.Validators {
		validators[i] = cmttypes.NewValidator(v.PubKey, v.Power)
	}
	set := cmttypes.NewValidatorSet(validators)
	// The signing set must be the trusted one. NextValidatorsHash may name an
	// incoming set at a transition header; state proofs depend only on signers.
	if !bytes.Equal(set.Hash(), sh.ValidatorsHash) {
		return errors.New("validator set differs from the trusted set; supply validator transitions")
	}
	if err := set.VerifyCommitLightAllSignatures(genesis.ChainID, sh.Commit.BlockID, sh.Height, sh.Commit); err != nil {
		return fmt.Errorf("invalid block signatures: %w", err)
	}
	// Header H+1 commits the application state after execution of block H.
	return VerifyQuery(bundle.Query, key, sh.AppHash, sh.Height-1)
}
