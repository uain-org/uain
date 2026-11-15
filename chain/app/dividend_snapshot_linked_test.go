//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/economy"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

// This SDK integration probe seeds a prospective policy and a pending H receipt
// directly in InitChain. It does not activate production or claim to exercise
// the external funding observer workflow (qualified by federation tests).
func TestDividendNativeFirstBeginCheckpointProofAndRestart(t *testing.T) {
	db := dbm.NewMemDB()
	b := baseapp.NewBaseApp("uain", log.NewLogger(io.Discard), db, nil, baseapp.SetChainID("sdk-test-1"))
	key := storetypes.NewKVStoreKey("federation")
	params := storetypes.NewKVStoreKey("consensus")
	b.MountStores(key, params)
	b.SetParamStore(parameterStore{params})
	a := &App{BaseApp: b, Key: key}
	a.installProposalHandlers()
	var e error
	a.SetInitChainer(func(ctx sdk.Context, _ *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
		pool, e := economy.Empty().Fund("101")
		if e != nil {
			return nil, e
		}
		seed := map[string]any{
			"dividend_activation":   federation.DividendActivation{Policy: federation.DividendPolicy, Height: 1},
			"dividend_pending/DR-1": map[string]string{"receipt": "DR-1", "confirmed_at": "1"},
			"coin_supply":           coin.Ledger{Minted: "1", Transparent: "1", Shielded: "0", Reserved: "0"},
			"private_frontier":      federation.PrivateFrontier{Root: string(bytes.Repeat([]byte("0"), 64))},
			"funding_receipt/DR-1":  federation.FundingReceipt{ID: "DR-1", Campaign: "DC-1", Amount: "101", State: "confirmed"},
			"funding_campaign/DC-1": federation.FundingCampaign{ID: "DC-1", Network: "ethereum:1", Asset: "native"},
			"funding_pool/DR-1":     pool,
		}
		for key, value := range seed {
			raw, e := json.Marshal(value)
			if e != nil {
				return nil, e
			}
			ctx.KVStore(a.Key).Set([]byte(key), raw)
		}
		return &abci.ResponseInitChain{}, nil
	})
	// A later H transition modifies end-H supply. The first H+1 hook must see it.
	a.SetBeginBlocker(func(ctx sdk.Context) (sdk.BeginBlock, error) {
		return sdk.BeginBlock{}, a.Keeper(ctx).CaptureDividendSnapshots(ctx.ChainID(), ctx.BlockHeight(), ctx.BlockHeader().AppHash)
	})
	a.SetEndBlocker(func(ctx sdk.Context) (sdk.EndBlock, error) {
		if ctx.BlockHeight() == 1 {
			raw, _ := json.Marshal(coin.Ledger{Minted: "3", Transparent: "2", Shielded: "1", Reserved: "7"})
			ctx.KVStore(a.Key).Set([]byte("coin_supply"), raw)
		}
		return sdk.EndBlock{}, nil
	})
	if e = a.LoadLatestVersion(); e != nil {
		t.Fatal(e)
	}
	cp := cmttypes.DefaultConsensusParams().ToProto()
	cp.Block.MaxGas = 60000000
	if _, e = a.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), ConsensusParams: &cp}); e != nil {
		t.Fatal(e)
	}
	h1 := block(t, a, 1)
	if _, e = a.PrepareProposal(&abci.RequestPrepareProposal{Height: 2, Time: time.Unix(1002, 0).UTC(), MaxTxBytes: 100000}); e != nil {
		t.Fatal(e)
	}
	if _, e = a.ProcessProposal(&abci.RequestProcessProposal{Height: 2, Time: time.Unix(1002, 0).UTC()}); e != nil {
		t.Fatal(e)
	}
	h2 := block(t, a, 2)
	q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("dividend_snapshot/DR-1"), Height: 2, Prove: true})
	if e != nil || q.Code != 0 {
		t.Fatal(e, q)
	}
	if e = proof.VerifyQuery(*q, "dividend_snapshot/DR-1", h2.AppHash, 2); e != nil {
		t.Fatal(e)
	}
	var record federation.DividendSnapshot
	if e = json.Unmarshal(q.Value, &record); e != nil {
		t.Fatal(e)
	}
	if record.Snapshot.Height != 1 || record.Snapshot.RecordedAt != 2 || record.Snapshot.Minted != "3" || record.Snapshot.Pool != "15" || !bytes.Equal(record.Snapshot.Checkpoint[:], h1.AppHash) {
		t.Fatalf("wrong canonical snapshot %+v", record)
	}
	if e = proof.VerifyQuery(*q, "dividend_snapshot/DR-1", h1.AppHash, 1); e == nil {
		t.Fatal("record incorrectly authenticated at H")
	}
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	block(t, a, 3)
	again, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("dividend_snapshot/DR-1"), Height: 3})
	if e != nil || !bytes.Equal(again.Value, q.Value) {
		t.Fatal("restart rewrote snapshot", e)
	}
	t.Logf("H=1 checkpoint=%x record proof state=2 and unchanged after restart", h1.AppHash)
}
