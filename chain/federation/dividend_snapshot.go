package federation

import (
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/economy"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"math"
)

const DividendPolicy = pd.SnapshotVersion
const DividendPendingLimit = 64

// No public activation dispatch exists until the complete claim/output circuit
// and native wrapper qualify. Merely implementing snapshots activates no policy.
type DividendActivation struct {
	Policy string `json:"policy"`
	Height int64  `json:"height,string"`
}
type DividendSnapshot struct {
	Snapshot pd.Snapshot `json:"snapshot"`
	Status   string      `json:"status"`
}
type dividendPending struct {
	Receipt     string `json:"receipt"`
	ConfirmedAt int64  `json:"confirmed_at,string"`
}

func (k Keeper) dividendPolicyAt(height int64) (bool, error) {
	marker := k.Store.Get
	if native, ok := k.Store.(interface{ DividendPolicyMarker() []byte }); ok {
		if native.DividendPolicyMarker() == nil {
			return false, nil
		}
	} else if marker([]byte("dividend_activation")) == nil {
		return false, nil
	}
	var a DividendActivation
	if e := get(k.Store, "dividend_activation", &a); e != nil {
		return false, e
	}
	if a.Policy != DividendPolicy || a.Height < 1 {
		return false, errors.New("invalid dividend policy")
	}
	return a.Height <= height, nil
}
func (k Keeper) queueDividendSnapshot(r FundingReceipt, height int64) error {
	active, e := k.dividendPolicyAt(height)
	if e != nil || !active {
		return e
	}
	// Readiness must precede confirmation: otherwise a later private spend in H
	// could leave the first H+1 snapshot unable to authenticate its spent root.
	if k.Store.Get([]byte("dividend_spent_state")) == nil || k.Store.Get([]byte("dividend_spent_rebuild")) != nil {
		return ErrDividendSpentRebuild
	}
	var ready dividendSpentState
	if e = get(k.Store, "dividend_spent_state", &ready); e != nil {
		return e
	}
	if ready.Version != DividendPolicy {
		return errors.New("wrong dividend tracking version")
	}
	if height < 1 || height == math.MaxInt64 || !validID(r.ID) || r.State != "confirmed" || k.Store.Get([]byte("dividend_snapshot/"+r.ID)) != nil || k.Store.Get([]byte("dividend_pending/"+r.ID)) != nil {
		return errors.New("invalid or duplicate dividend snapshot queue")
	}
	entries, e := k.Store.Range([]byte("dividend_pending/"), []byte("dividend_pending0"), DividendPendingLimit+1)
	if e != nil {
		return e
	}
	if len(entries) >= DividendPendingLimit {
		return errors.New("dividend confirmation capacity reached for this block")
	}
	return put(k.Store, "dividend_pending/"+r.ID, dividendPending{r.ID, height})
}

// CaptureDividendSnapshots must be the FIRST BeginBlock mutation. The supplied
// checkpoint comes only from canonical SDK ctx.BlockHeader.AppHash, never a Tx.
func (k Keeper) CaptureDividendSnapshots(chain string, height int64, checkpoint []byte) error {
	return k.captureDividendSnapshotsWithHash(chain, height, checkpoint, k.meterDividendHash())
}
func (k Keeper) captureDividendSnapshotsWithHash(chain string, height int64, checkpoint []byte, hash pd.Hasher) error {
	active, e := k.dividendPolicyAt(height - 1)
	if e != nil || !active {
		return e
	}
	pending, e := k.Store.Range([]byte("dividend_pending/"), []byte("dividend_pending0"), DividendPendingLimit+1)
	if e != nil {
		return e
	}
	if len(pending) == 0 {
		return nil
	}
	if len(pending) > DividendPendingLimit || height < 2 || len(checkpoint) != 32 {
		return errors.New("invalid bounded dividend checkpoint")
	}
	ledger := coin.Empty()
	if k.Store.Get([]byte("coin_supply")) != nil {
		if e = get(k.Store, "coin_supply", &ledger); e != nil {
			return e
		}
	}
	if e = ledger.Validate(); e != nil {
		return e
	}
	var frontier PrivateFrontier
	var noteRoot [32]byte
	if k.Store.Get([]byte("private_frontier")) != nil {
		if e = get(k.Store, "private_frontier", &frontier); e != nil {
			return e
		}
		b, e := hex.DecodeString(frontier.Root)
		if e != nil || len(b) != 32 {
			return errors.New("invalid canonical note frontier")
		}
		copy(noteRoot[:], b)
	} else if ledger.Minted != "0" {
		return errors.New("minted Coin has no authenticated private frontier")
	}
	tree, _, e := k.ensureDividendSpent(hash)
	if e != nil {
		return e
	}
	spentRoot, e := tree.Root()
	if e != nil {
		return e
	}
	var appHash [32]byte
	copy(appHash[:], checkpoint)
	for _, entry := range pending {
		var p dividendPending
		if e = get(k.Store, string(entry.Key), &p); e != nil {
			return e
		}
		if string(entry.Key) != "dividend_pending/"+p.Receipt || p.ConfirmedAt != height-1 {
			return errors.New("dividend checkpoint must capture confirmation block H")
		}
		if k.Store.Get([]byte("dividend_snapshot/"+p.Receipt)) != nil {
			return errors.New("immutable dividend snapshot exists")
		}
		var receipt FundingReceipt
		var campaign FundingCampaign
		var pool economy.Pool
		if e = get(k.Store, "funding_receipt/"+p.Receipt, &receipt); e != nil {
			return e
		}
		if e = get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
			return e
		}
		if e = get(k.Store, "funding_pool/"+p.Receipt, &pool); e != nil {
			return e
		}
		if e = pool.Validate(); e != nil {
			return e
		}
		original, e := economy.Empty().Fund(receipt.Amount)
		if e != nil {
			return e
		}
		originalP := original.Dividend.Available
		snapshot, e := pd.NewSnapshot(chain, p.Receipt, campaign.Network, campaign.Asset, height-1, appHash, ledger, noteRoot, spentRoot, originalP)
		if e != nil {
			return e
		}
		status := "active"
		if receipt.State == "refunded" {
			status = "nonclaimable-refunded"
		} else if receipt.State != "confirmed" {
			return errors.New("unconfirmed dividend funding")
		} else if ledger.Minted == "0" {
			status = "nonclaimable-zero-supply"
		} else if originalP == "0" {
			status = "nonclaimable-zero-pool"
		}
		if status == "active" {
			if pool.Dividend.Available != originalP || pool.Dividend.Reserved != "0" || pool.Dividend.Paid != "0" {
				return errors.New("dividend pool changed before immutable reservation")
			}
			pool, e = pool.Reserve("dividend", originalP)
			if e != nil {
				return e
			}
			if e = put(k.Store, "funding_pool/"+p.Receipt, pool); e != nil {
				return e
			}
		}
		if e = put(k.Store, "dividend_snapshot/"+p.Receipt, DividendSnapshot{snapshot, status}); e != nil {
			return e
		}
		k.Store.Delete(entry.Key)
	}
	return nil
}

var ErrDividendSpentRebuild = errors.New("canonical private nullifier history requires bounded dividend SMT reconstruction")

type dividendSpentState struct {
	Version string `json:"version"`
	Count   uint64 `json:"count,string"`
}

func (k Keeper) ensureDividendSpent(hash pd.Hasher) (pd.Tree, dividendSpentState, error) {
	tree := pd.Tree{Store: k.Store, Hash: hash}
	state := dividendSpentState{Version: DividendPolicy}
	if k.Store.Get([]byte("dividend_spent_state")) == nil {
		old, e := k.Store.Range([]byte("private_nullifier/"), []byte("private_nullifier0"), 1)
		if e != nil {
			return tree, state, e
		}
		if len(old) != 0 {
			return tree, state, ErrDividendSpentRebuild
		}
		if k.Store.Get([]byte("dividend_smt1/root")) != nil {
			return tree, state, errors.New("untracked spent root")
		}
		if e = put(k.Store, "dividend_spent_state", state); e != nil {
			return tree, state, e
		}
	} else {
		if e := get(k.Store, "dividend_spent_state", &state); e != nil {
			return tree, state, e
		}
		if state.Version != DividendPolicy {
			return tree, state, errors.New("wrong spent accumulator version")
		}
	}
	return tree, state, nil
}
func (k Keeper) appendDividendSpent(nullifiers [][32]byte) error {
	// Tracking begins only with a prospective guardian reconstruction. Earlier
	// private-payment replay must retain its original writes and gas behavior.
	if native, ok := k.Store.(interface{ DividendSpentTracking() bool }); ok {
		if !native.DividendSpentTracking() {
			return nil
		}
	} else if k.Store.Get([]byte("dividend_spent_state")) == nil && k.Store.Get([]byte("dividend_spent_rebuild")) == nil {
		return nil
	}
	if !pd.HashAvailable() {
		return pd.ErrUnavailable
	}
	return k.appendDividendSpentWithHash(nullifiers, k.meterDividendHash())
}
func (k Keeper) appendDividendSpentWithHash(nullifiers [][32]byte, hash pd.Hasher) error {
	if len(nullifiers) < 1 || len(nullifiers) > 2 {
		return errors.New("bounded private nullifiers required")
	}
	for _, nf := range nullifiers {
		if !pd.CanonicalField(nf) {
			return errors.New("noncanonical accepted private nullifier")
		}
	}
	tree, state, e := k.ensureDividendSpent(hash)
	if e != nil {
		return e
	}
	if state.Count > math.MaxUint64-uint64(len(nullifiers)) {
		return errors.New("spent count exhausted")
	}
	for _, nf := range nullifiers {
		if e = tree.Insert(nf); e != nil {
			return e
		}
	}
	state.Count += uint64(len(nullifiers))
	return put(k.Store, "dividend_spent_state", state)
}
func dividendNullifierKey(nf [32]byte) string { return fmt.Sprintf("private_nullifier/%x", nf) }
