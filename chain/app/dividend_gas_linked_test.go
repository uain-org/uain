//go:build orchard && cgo

package app

import (
	"bytes"
	"cosmossdk.io/log/v2"
	"encoding/hex"
	"encoding/json"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/uain-org/uain/chain/federation"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"io"
	"sort"
	"testing"
	"time"
)

func TestDividendRebuildMaximumPageFitsNativeTransactionGas(t *testing.T) {
	member, key := testMember("disposable dividend guardian")
	final := [32]byte{}
	for i := range final {
		final[i] = 255
	}
	final[31] = 63
	history := make([][32]byte, 255)
	for i := 0; i < 254; i++ {
		history[i] = final
		history[i][i/8] ^= 1 << uint(i%8)
	}
	max, _ := hex.DecodeString("00000000ed302d991bf94c09fc98462200000000000000000000000000000040")
	copy(history[254][:], max)
	sort.Slice(history, func(i, j int) bool { return bytes.Compare(history[i][:], history[j][:]) < 0 })
	cursor := "private_nullifier/" + hex.EncodeToString(history[len(history)-1][:])
	raw := testEnvelope(t, member, key, 0, "dividend_spent_rebuild", map[string]string{"cursor": cursor})
	b := baseapp.NewBaseApp("uain", log.NewLogger(io.Discard), dbm.NewMemDB(), nil, baseapp.SetChainID("sdk-test-1"))
	storeKey := storetypes.NewKVStoreKey("federation")
	params := storetypes.NewKVStoreKey("consensus")
	b.MountStores(storeKey, params)
	b.SetParamStore(parameterStore{params})
	a := &App{BaseApp: b, Key: storeKey}
	b.SetInitChainer(func(ctx sdk.Context, _ *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
		if e := a.Keeper(ctx).Init(federation.Genesis{Version: 1, Guardians: []string{member.ID}, Members: []federation.Member{member}}); e != nil {
			return nil, e
		}
		// Public fixture has the maximum 255 canonical-field levels of nested canonical-field branches.
		// The final absent key descends through every branch, then rebuilds them.
		tree := pd.Tree{Store: a.Keeper(ctx).Store, Hash: pd.Poseidon{}}
		for _, nf := range history {
			v, _ := json.Marshal("fictional-accepted-payment")
			ctx.KVStore(storeKey).Set([]byte("private_nullifier/"+hex.EncodeToString(nf[:])), v)
			if e := tree.Insert(nf); e != nil {
				return nil, e
			}
		}
		v, _ := json.Marshal("fictional-accepted-payment")
		ctx.KVStore(storeKey).Set([]byte("private_nullifier/"+hex.EncodeToString(final[:])), v)
		progress, _ := json.Marshal(map[string]string{"cursor": cursor, "count": "255"})
		ctx.KVStore(storeKey).Set([]byte("dividend_spent_rebuild"), progress)
		return &abci.ResponseInitChain{}, nil
	})
	b.SetBeginBlocker(func(ctx sdk.Context) (sdk.BeginBlock, error) {
		cache, write := ctx.CacheContext()
		cache = cache.WithGasMeter(storetypes.NewGasMeter(TransactionGas))
		_, e := a.Keeper(cache).Execute(raw, "sdk-test-1", ctx.BlockHeight(), ctx.BlockTime())
		if e != nil {
			return sdk.BeginBlock{}, e
		}
		write()
		t.Logf("maximum page gas=%d/%d", cache.GasMeter().GasConsumed(), TransactionGas)
		return sdk.BeginBlock{}, nil
	})
	if e := b.LoadLatestVersion(); e != nil {
		t.Fatal(e)
	}
	cp := cmttypes.DefaultConsensusParams().ToProto()
	if _, e := b.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), ConsensusParams: &cp}); e != nil {
		t.Fatal(e)
	}
	block(t, a, 1)
}
