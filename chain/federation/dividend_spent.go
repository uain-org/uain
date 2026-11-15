package federation

import (
	"encoding/hex"
	"errors"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"math"
)

const DividendSpentPageLimit = 1

// The cursor is persisted consensus progress, never an asserted completeness
// witness. New private spends refuse an incomplete reconstruction.
type dividendSpentRebuild struct {
	Cursor string `json:"cursor"`
	Count  uint64 `json:"count,string"`
}

func (k Keeper) rebuildDividendSpent(c Command) (string, error) {
	if !k.guardian(c.Member) || c.Instance != "" {
		return "", errors.New("guardian spent-history reconstruction required")
	}
	if !pd.HashAvailable() {
		return "", pd.ErrUnavailable
	}
	var p struct {
		Cursor string `json:"cursor"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	cursor, _, e := k.rebuildDividendSpentWithHash(p.Cursor, k.meterDividendHash())
	return cursor, e
}
func (k Keeper) rebuildDividendSpentWithHash(cursor string, hash pd.Hasher) (string, bool, error) {
	if k.Store.Get([]byte("dividend_spent_state")) != nil {
		return "", false, errors.New("spent accumulator already complete")
	}
	var state dividendSpentRebuild
	if k.Store.Get([]byte("dividend_spent_rebuild")) == nil {
		if cursor != "" || k.Store.Get([]byte("dividend_smt1/root")) != nil {
			return "", false, errors.New("invalid initial spent reconstruction")
		}
	} else if e := get(k.Store, "dividend_spent_rebuild", &state); e != nil {
		return "", false, e
	}
	if cursor != state.Cursor {
		return "", false, errors.New("spent reconstruction cursor cannot skip history")
	}
	start := []byte("private_nullifier/")
	if cursor != "" {
		start = []byte(cursor + "\x00")
	}
	page, e := k.Store.Range(start, []byte("private_nullifier0"), DividendSpentPageLimit+1)
	if e != nil {
		return "", false, e
	}
	done := len(page) <= DividendSpentPageLimit
	if !done {
		page = page[:DividendSpentPageLimit]
	}
	if state.Count > math.MaxUint64-uint64(len(page)) {
		return "", false, errors.New("spent reconstruction count exhausted")
	}
	tree := pd.Tree{Store: k.Store, Hash: hash}
	for _, entry := range page {
		key := string(entry.Key)
		if len(key) != len("private_nullifier/")+64 {
			return "", false, errors.New("invalid canonical nullifier history key")
		}
		decoded, e := hex.DecodeString(key[len("private_nullifier/"):])
		if e != nil || hex.EncodeToString(decoded) != key[len("private_nullifier/"):] {
			return "", false, errors.New("noncanonical nullifier history encoding")
		}
		var nf [32]byte
		copy(nf[:], decoded)
		if !pd.CanonicalField(nf) {
			return "", false, errors.New("noncanonical historical nullifier")
		}
		if e = tree.Insert(nf); e != nil {
			return "", false, e
		}
		state.Cursor = key
		state.Count++
	}
	if done {
		if e = put(k.Store, "dividend_spent_state", dividendSpentState{Version: DividendPolicy, Count: state.Count}); e != nil {
			return "", false, e
		}
		k.Store.Delete([]byte("dividend_spent_rebuild"))
	} else if e = put(k.Store, "dividend_spent_rebuild", state); e != nil {
		return "", false, e
	}
	return state.Cursor, done, nil
}

// Native hashing has a fixed, explicit charge as well as SDK store gas.
// Empty subtrees are precomputed and do not repeat Poseidon work per lookup.
type dividendMeteredHash struct {
	base   pd.Hasher
	charge func(uint64)
}

func (h dividendMeteredHash) Empty(level uint16) ([32]byte, error) { return h.base.Empty(level) }
func (h dividendMeteredHash) Leaf(key [32]byte) ([32]byte, error) {
	h.charge(100)
	return h.base.Leaf(key)
}
func (h dividendMeteredHash) Node(level uint16, l, r [32]byte) ([32]byte, error) {
	h.charge(100)
	return h.base.Node(level, l, r)
}
func (k Keeper) meterDividendHash() pd.Hasher {
	if meter, ok := k.Store.(interface{ PrivateProofGas(uint64) }); ok {
		return dividendMeteredHash{base: pd.Poseidon{}, charge: meter.PrivateProofGas}
	}
	return pd.Poseidon{}
}
