// Command uain-replay re-executes an existing chain's history with this
// binary, read-only, and stops at the first divergence. It starts a fresh
// application from an independently pinned genesis, feeds it every block
// fetched over a node's RPC, and after each block compares the resulting
// application hash and transaction-results hash (which includes gas used)
// with the next signed header. It never signs, broadcasts or writes to the
// source node; it is how a consensus change is shown to be replay-identical
// before a binary swap.
//
//	uain-replay --genesis genesis.json --genesis-sha256 <pin> --rpc http://127.0.0.1:26667 [--to H] [--data DIR]
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	rpchttp "github.com/cometbft/cometbft/rpc/client/http"
	cmtstate "github.com/cometbft/cometbft/state"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"

	"github.com/uain-org/uain/chain/app"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "REPLAY_FAILED:", err)
		os.Exit(1)
	}
}

func run() error {
	genesisPath := flag.String("genesis", "", "independently obtained genesis")
	pin := flag.String("genesis-sha256", "", "exact genesis SHA-256")
	endpoint := flag.String("rpc", "http://127.0.0.1:26667", "source node RPC (read only)")
	to := flag.Int64("to", 0, "last height to replay (default: source height - 1)")
	dataDir := flag.String("data", "", "application database directory (default: in memory)")
	flag.Parse()
	raw, err := os.ReadFile(*genesisPath)
	if err != nil {
		return err
	}
	if sum := sha256.Sum256(raw); hex.EncodeToString(sum[:]) != *pin {
		return errors.New("genesis differs from the pin")
	}
	doc, err := cmttypes.GenesisDocFromJSON(raw)
	if err != nil {
		return err
	}
	var db dbm.DB = dbm.NewMemDB()
	if *dataDir != "" {
		if db, err = dbm.NewDB("application", dbm.GoLevelDBBackend, *dataDir); err != nil {
			return err
		}
	}
	defer db.Close()
	a, err := app.New(log.NewLogger(io.Discard), db, doc.ChainID)
	if err != nil {
		return err
	}
	client, err := rpchttp.New(*endpoint, "/websocket")
	if err != nil {
		return err
	}
	ctx := context.Background()
	status, err := client.Status(ctx)
	if err != nil {
		return err
	}
	if status.NodeInfo.Network != doc.ChainID {
		return errors.New("source node is on another chain")
	}
	last := status.SyncInfo.LatestBlockHeight - 1
	if *to > 0 && *to < last {
		last = *to
	}
	validators := make([]abci.ValidatorUpdate, len(doc.Validators))
	for i, v := range doc.Validators {
		validators[i] = abci.Ed25519ValidatorUpdate(v.PubKey.Bytes(), v.Power)
	}
	params := doc.ConsensusParams.ToProto()
	if _, err = a.InitChain(&abci.RequestInitChain{Time: doc.GenesisTime, ChainId: doc.ChainID, InitialHeight: doc.InitialHeight, ConsensusParams: &params, Validators: validators, AppStateBytes: doc.AppState}); err != nil {
		return err
	}
	start, began := time.Now(), doc.InitialHeight
	txs := 0
	for h := doc.InitialHeight; h <= last; {
		top := h + 19
		if top > last+1 {
			top = last + 1
		}
		info, err := client.BlockchainInfo(ctx, h, top)
		if err != nil {
			return err
		}
		metas := map[int64]*cmttypes.BlockMeta{}
		for _, m := range info.BlockMetas {
			metas[m.Header.Height] = m
		}
		for ; h < top && h <= last; h++ {
			meta, next := metas[h], metas[h+1]
			if meta == nil || next == nil {
				return fmt.Errorf("source omitted header %d or %d", h, h+1)
			}
			var block [][]byte
			if meta.NumTxs > 0 {
				b, err := client.Block(ctx, &h)
				if err != nil {
					return err
				}
				if !bytes.Equal(b.Block.Hash(), meta.BlockID.Hash) {
					return fmt.Errorf("block %d does not match its header", h)
				}
				for _, tx := range b.Block.Txs {
					block = append(block, tx)
				}
				txs += len(block)
			}
			r, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Txs: block, Hash: meta.BlockID.Hash, Height: h, Time: meta.Header.Time, NextValidatorsHash: meta.Header.NextValidatorsHash, ProposerAddress: meta.Header.ProposerAddress})
			if err != nil {
				return fmt.Errorf("height %d: %w", h, err)
			}
			if len(r.ValidatorUpdates) != 0 {
				return fmt.Errorf("height %d: replay produced validator updates", h)
			}
			if _, err = a.Commit(); err != nil {
				return err
			}
			if !bytes.Equal(r.AppHash, next.Header.AppHash) {
				return fmt.Errorf("APP HASH DIVERGES at height %d: replay %X, signed header %d %X", h, r.AppHash, h+1, next.Header.AppHash)
			}
			if got := cmtstate.TxResultsHash(r.TxResults); !bytes.Equal(got, next.Header.LastResultsHash) {
				return fmt.Errorf("RESULTS (gas/code) DIVERGE at height %d with %d txs", h, len(block))
			}
			if h%50000 == 0 {
				fmt.Printf("replayed %d/%d (%d txs, %s)\n", h, last, txs, time.Since(start).Round(time.Second))
			}
		}
	}
	fmt.Printf("REPLAY_IDENTICAL chain=%s heights=%d..%d txs=%d app_hash_at_%d=%X seconds=%d\n", doc.ChainID, began, last, txs, last+1, a.LastCommitID().Hash, int(time.Since(start).Seconds()))
	return nil
}
