package app

import (
	"bytes"
	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"io"
	"strconv"
	"testing"
	"time"
)

// Qualify the actual SDK context before trusting it for dividend checkpoints.
func TestDividendBeginBlockContextCommitsPreviousState(t *testing.T) {
	db := dbm.NewMemDB()
	var observed, committed []byte
	open := func(initial bool) *App {
		b := baseapp.NewBaseApp("dividend-checkpoint-probe", log.NewLogger(io.Discard), db, nil, baseapp.SetChainID("sdk-test-1"))
		key := storetypes.NewKVStoreKey("federation")
		params := storetypes.NewKVStoreKey("consensus")
		b.MountStores(key, params)
		b.SetParamStore(parameterStore{params})
		b.SetInitChainer(func(sdk.Context, *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
			return &abci.ResponseInitChain{}, nil
		})
		b.SetBeginBlocker(func(ctx sdk.Context) (sdk.BeginBlock, error) {
			observed = bytes.Clone(ctx.BlockHeader().AppHash)
			committed = bytes.Clone(b.LastCommitID().Hash)
			ctx.KVStore(key).Set([]byte("probe"), []byte(strconv.FormatInt(ctx.BlockHeight(), 10)))
			return sdk.BeginBlock{}, nil
		})
		if err := b.LoadLatestVersion(); err != nil {
			t.Fatal(err)
		}
		if initial {
			cp := cmttypes.DefaultConsensusParams().ToProto()
			if _, err := b.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), ConsensusParams: &cp}); err != nil {
				t.Fatal(err)
			}
		}
		return &App{BaseApp: b, Key: key}
	}
	a := open(true)
	first := block(t, a, 1)
	block(t, a, 2)
	t.Logf("context=%x canonical committed=%x Hstate=%x", observed, committed, first.AppHash)
	if !bytes.Equal(observed, first.AppHash) {
		t.Fatalf("H+1 context AppHash does not authenticate H state")
	}
	third := block(t, a, 3)
	a = open(false)
	block(t, a, 4)
	if !bytes.Equal(observed, third.AppHash) {
		t.Fatal("restart lost H checkpoint")
	}
}
