package proof

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"

	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/federation"
)

// VerifyRecipientHistory requires explicit inclusion or absence proofs for
// every dependency against one trusted app hash. An omitted counter is not a
// proven zero. Authenticate the signed header before invoking this function.
func VerifyRecipientHistory(queries []abci.ResponseQuery, kind, member, instance string, page uint64, appHash []byte, height int64) (federation.RecipientHistory, error) {
	out := federation.RecipientHistory{}
	keys, err := federation.HistoryKeys(kind, member, instance, page)
	if err != nil {
		return out, err
	}
	if len(queries) < len(keys) || len(queries) > len(keys)+federation.HistoryPageSize {
		return out, errors.New("bounded complete history proof required")
	}
	seen := map[string]bool{}
	for _, q := range queries {
		if seen[string(q.Key)] {
			return out, errors.New("duplicate history proof")
		}
		seen[string(q.Key)] = true
	}
	for _, key := range keys {
		if !seen[key] {
			return out, errors.New("missing history dependency proof: " + key)
		}
	}
	if len(appHash) != 32 || height < 1 {
		return out, errors.New("trusted history application hash and height required")
	}
	records := verifiedRecords{}
	for _, q := range queries {
		if q.Code != 0 || q.Height != height || len(q.Key) > 512 || len(q.Value) > federation.MaxEnvelopeBytes || q.ProofOps == nil || len(q.ProofOps.Ops) > 4 {
			return out, errors.New("invalid history proof bounds or height")
		}
		for _, op := range q.ProofOps.Ops {
			if len(op.Data) > 256*1024 {
				return out, errors.New("oversized history proof operation")
			}
		}
		if len(q.Value) == 0 {
			err = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, appHash, "/federation/"+url.PathEscape(string(q.Key)))
		} else {
			err = VerifyQuery(q, string(q.Key), appHash, height)
		}
		if err != nil {
			return out, err
		}
		records[string(q.Key)] = bytes.Clone(q.Value)
	}
	k := federation.Keeper{Store: records}
	ids := federation.HistoryIDs{}
	if raw := k.Store.Get([]byte(keys[4])); len(raw) != 0 {
		if err = json.Unmarshal(raw, &ids); err != nil {
			return out, err
		}
	}
	if len(ids.IDs) > federation.HistoryPageSize || len(queries) != len(keys)+len(ids.IDs) {
		return out, errors.New("history proof includes missing or unrelated records")
	}
	for _, id := range ids.IDs {
		if !seen[kind+"/"+id] {
			return out, errors.New("missing original journal proof")
		}
	}
	return k.RecipientHistoryPage(kind, member, instance, page, height)
}
