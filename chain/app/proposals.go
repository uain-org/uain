package app

import (
	"fmt"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/baseapp"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"github.com/uain-org/uain/chain/federation"
)

// Pinned bootstrap limits bound proposal work even with unlimited consensus
// parameters. Positive, smaller consensus limits still take precedence.
const ProposalGas = uint64(60000000)
const ProposalBytes = uint64(1024 * 1024)
const ProposalCandidates = 128

// Per-signer fairness inside one proposal (9 November 2026). The first pass
// includes at most ProposalTxsPerSigner commands from each member; a second
// pass fills any remaining capacity from the deferred commands in mempool
// order, so an uncontended member still fills a block. A member whose
// candidates fail ProposalFailuresPerSigner times is skipped for the rest of
// the proposal, and undecodable candidates no longer consume the
// ProposalCandidates inclusion bound, only the ProposalExamined scan bound.
const ProposalTxsPerSigner = 4
const ProposalFailuresPerSigner = 4
const ProposalExamined = 512

func proposalLimits(ctx sdk.Context) (uint64, uint64) {
	gas, size := ProposalGas, ProposalBytes
	if b := ctx.ConsensusParams().Block; b != nil {
		if b.MaxGas > 0 && uint64(b.MaxGas) < gas {
			gas = uint64(b.MaxGas)
		}
		if b.MaxBytes > 0 && uint64(b.MaxBytes) < size {
			size = uint64(b.MaxBytes)
		}
	}
	return gas, size
}

func (a *App) proposalActive(ctx sdk.Context) (bool, error) {
	return (federation.Keeper{Store: nativeStore{KVStore: ctx.MultiStore().GetKVStore(a.Key)}}).CompactStorageActive(ctx.BlockHeight())
}

// BeginBlock's expiry changes are part of the state seen by every transaction.
// This cache is never written to committed/finalization state.
func (a *App) proposalState(ctx sdk.Context) (sdk.Context, error) {
	cache, _ := ctx.WithGasMeter(storetypes.NewInfiniteGasMeter()).CacheContext()
	if err := a.applyUpgrade(cache); err != nil {
		return cache, err
	}
	_, err := a.Keeper(cache).ExpireKPIs(ctx.BlockHeight(), ctx.BlockTime())
	return cache, err
}

func (a *App) proposalExecute(ctx sdk.Context, raw []byte, limit uint64) (used uint64, err error) {
	meter := storetypes.NewGasMeter(limit)
	defer func() {
		used = meter.GasConsumedToLimit()
		if failure := recover(); failure != nil {
			err = fmt.Errorf("proposal transition refused: %v", failure)
		}
	}()
	if len(raw) == 0 || len(raw) > federation.MaxEnvelopeBytes {
		return 0, fmt.Errorf("invalid proposal envelope size")
	}
	cache, write := ctx.WithGasMeter(meter).CacheContext()
	meter.ConsumeGas(uint64(len(raw))*20, "signed envelope")
	if _, err = a.Keeper(cache).Execute(raw, ctx.ChainID(), ctx.BlockHeight(), ctx.BlockTime()); err != nil {
		return 0, err
	}
	write()
	return 0, nil
}

func (a *App) installProposalHandlers() {
	legacy := baseapp.NewDefaultProposalHandler(nil, a.BaseApp)
	legacyPrepare := legacy.PrepareProposalHandler()
	a.SetPrepareProposal(func(ctx sdk.Context, req *abci.RequestPrepareProposal) (resp *abci.ResponsePrepareProposal, err error) {
		// Return an empty proposal on refusal, avoiding BaseApp's error fallback
		// to the unchecked input transactions.
		resp = &abci.ResponsePrepareProposal{Txs: [][]byte{}}
		defer func() {
			if recover() != nil {
				resp, err = &abci.ResponsePrepareProposal{Txs: [][]byte{}}, nil
			}
		}()
		active, e := a.proposalActive(ctx)
		if e != nil {
			return resp, nil
		}
		if !active {
			return legacyPrepare(ctx, req)
		}
		cache, e := a.proposalState(ctx)
		if e != nil || req.MaxTxBytes <= 0 {
			return resp, nil
		}
		maxGas, maxBytes := proposalLimits(ctx)
		if uint64(req.MaxTxBytes) < maxBytes {
			maxBytes = uint64(req.MaxTxBytes)
		}
		var reserved, size, work uint64
		failures, included, accepted := map[string]int{}, map[string]int{}, 0
		deferred := [][]byte{}
		full := func() bool {
			return accepted >= ProposalCandidates || reserved+TransactionGas > maxGas || work+TransactionGas > maxGas
		}
		try := func(raw []byte, signer string) {
			n := uint64(cmttypes.ComputeProtoSizeForTxs([]cmttypes.Tx{raw}))
			if size+n > maxBytes {
				return
			}
			used, e := a.proposalExecute(cache, raw, TransactionGas)
			work += used
			if e != nil {
				failures[signer]++
				return
			}
			reserved += TransactionGas
			size += n
			included[signer]++
			accepted++
			resp.Txs = append(resp.Txs, raw)
		}
		for i, raw := range req.Txs {
			if i >= ProposalExamined || full() {
				break
			}
			if len(raw) == 0 || len(raw) > federation.MaxEnvelopeBytes {
				continue
			}
			signer, e := envelopeMember(raw)
			if e != nil || failures[signer] >= ProposalFailuresPerSigner {
				continue
			}
			if included[signer] >= ProposalTxsPerSigner {
				deferred = append(deferred, raw)
				continue
			}
			try(raw, signer)
		}
		for _, raw := range deferred {
			if full() {
				break
			}
			signer, _ := envelopeMember(raw)
			if failures[signer] >= ProposalFailuresPerSigner {
				continue
			}
			try(raw, signer)
		}
		return resp, nil
	})
	a.SetProcessProposal(func(ctx sdk.Context, req *abci.RequestProcessProposal) (resp *abci.ResponseProcessProposal, err error) {
		resp = &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_REJECT}
		defer func() {
			if recover() != nil {
				resp, err = &abci.ResponseProcessProposal{Status: abci.ResponseProcessProposal_REJECT}, nil
			}
		}()
		active, e := a.proposalActive(ctx)
		if e != nil {
			return resp, nil
		}
		if !active {
			resp.Status = abci.ResponseProcessProposal_ACCEPT
			return resp, nil
		}
		maxGas, maxBytes := proposalLimits(ctx)
		if uint64(len(req.Txs)) > maxGas/TransactionGas || uint64(cmttypes.ComputeProtoSizeForTxs(cmttypes.ToTxs(req.Txs))) > maxBytes {
			return resp, nil
		}
		cache, e := a.proposalState(ctx)
		if e != nil {
			return resp, nil
		}
		for _, raw := range req.Txs {
			if _, e = a.proposalExecute(cache, raw, TransactionGas); e != nil {
				return resp, nil
			}
		}
		resp.Status = abci.ResponseProcessProposal_ACCEPT
		return resp, nil
	})
}
