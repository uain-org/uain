//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/privatewallet"
	"testing"
	"time"
)

type coinCorruptSource struct {
	privateFixtureSource
	key string
}

func (s coinCorruptSource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	q, e := s.privateFixtureSource.Query(ctx, path, key, height, prove)
	if string(key) == s.key {
		q.Value = bytes.Clone(q.Value)
		if len(q.Value) == 0 {
			q.Value = []byte(`"900"`)
		} else {
			q.Value[0] ^= 1
		}
	}
	return q, e
}
func assertVerifiedCoinState(t *testing.T, a *App, appHash []byte, height int64, reviewer, owner, balance string, payments, boundaries []string) {
	t.Helper()
	key := cmted.GenPrivKey()
	validator := cmttypes.NewValidator(key.PubKey(), 10)
	set := cmttypes.NewValidatorSet([]*cmttypes.Validator{validator})
	now := time.Now().UTC()
	genesis := &cmttypes.GenesisDoc{ChainID: "sdk-test-1", GenesisTime: time.Unix(1000, 0).UTC(), Validators: []cmttypes.GenesisValidator{{PubKey: key.PubKey(), Power: 10}}}
	header := &cmttypes.Header{Version: cmtversion.Consensus{Block: 11}, ChainID: genesis.ChainID, Height: height + 1, Time: now, ValidatorsHash: set.Hash(), NextValidatorsHash: set.Hash(), AppHash: appHash, ProposerAddress: validator.Address}
	commit := &cmttypes.Commit{Height: height + 1, Round: 0, BlockID: cmttypes.BlockID{Hash: header.Hash(), PartSetHeader: cmttypes.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{1}, 32)}}, Signatures: []cmttypes.CommitSig{{BlockIDFlag: cmttypes.BlockIDFlagCommit, ValidatorAddress: validator.Address, Timestamp: now}}}
	var e error
	commit.Signatures[0].Signature, e = key.Sign(commit.VoteSignBytes(genesis.ChainID, 0))
	if e != nil {
		t.Fatal(e)
	}
	signed := cmttypes.SignedHeader{Header: header, Commit: commit}
	request := privatewallet.Request{Reviewer: reviewer, BoundaryMember: owner, SourcePayments: payments, SourceBoundaries: boundaries}
	state, e := privatewallet.Read(context.Background(), genesis, signed, privateFixtureSource{app: a}, now, time.Minute, request)
	if e != nil || state.Coin == nil || state.Coin.Owner.Member != owner || state.Coin.Balance != balance || len(state.Payments) != len(payments) || len(state.Boundaries) != len(boundaries) {
		t.Fatalf("wrong authenticated owner Coin snapshot: %+v %v", state, e)
	}
	assertLightCoinState(t, a, genesis, signed, now, request, state, payments, boundaries)
	records := []string{"coin_activation", "coin_supply", "coin_balance/" + owner, "private_frontier"}
	for _, id := range boundaries {
		records = append(records, "private_boundary/"+id)
	}
	for _, id := range payments {
		records = append(records, "private_payment/"+id)
	}
	for _, record := range records {
		if _, e = privatewallet.Read(context.Background(), genesis, signed, coinCorruptSource{privateFixtureSource{app: a}, record}, now, time.Minute, request); e == nil {
			t.Fatal("unauthenticated Coin state accepted", record)
		}
	}
	wrong := request
	wrong.Parties = []string{owner, reviewer}
	if _, e = privatewallet.Read(context.Background(), genesis, signed, privateFixtureSource{app: a}, now, time.Minute, wrong); e == nil {
		t.Fatal("mixed boundary and OTC authority accepted")
	}
	if _, e = privatewallet.Read(context.Background(), genesis, signed, privateFixtureSource{app: a}, now.Add(2*time.Minute), time.Minute, request); e == nil {
		t.Fatal("stale Coin state accepted")
	}
}
