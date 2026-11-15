package privatewallet

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

// readRecord authenticates persisted ciphertext, not a payment authorization or
// exact transaction inclusion. It deliberately needs no current reviewer,
// licence, Coin policy, frontier, note witness or spending key. Revoking a
// checker cannot erase a historical finalized record's proof.
func readRecord(ctx context.Context, genesis *cmttypes.GenesisDoc, header cmttypes.SignedHeader, source Source, now time.Time, maxAge time.Duration, request Request) (Snapshot, error) {
	out := Snapshot{}
	if !request.RecordOnly || request.PolicyOnly || request.SkipWitness || request.CompactWitness || request.WitnessCache != nil || len(request.WitnessPositions) != 0 || request.Reviewer != "" || len(request.Parties) != 0 || request.BoundaryMember != "" || len(request.SourcePayments)+len(request.SourceBoundaries) != 1 || source == nil || genesis == nil || header.Header == nil || header.Height < 2 || maxAge <= 0 || maxAge > 10*time.Minute {
		return out, errors.New("record-only proof requires exactly one ciphertext ID and no approval/witness scope")
	}
	prefix := "private_payment/"
	ids := request.SourcePayments
	if len(request.SourceBoundaries) == 1 {
		prefix = "private_boundary/"
		ids = request.SourceBoundaries
	}
	id := ids[0]
	if !digestID.MatchString(id) {
		return out, errors.New("canonical ciphertext ID required")
	}
	key := prefix + id
	height := header.Height - 1
	query, err := source.Query(ctx, "/store/federation/key", []byte(key), height, true)
	if err != nil {
		return out, err
	}
	if len(query.Value) > federation.MaxEnvelopeBytes || query.ProofOps == nil || len(query.ProofOps.Ops) > 4 {
		return out, errors.New("oversized or missing ciphertext state proof")
	}
	for _, op := range query.ProofOps.Ops {
		if len(op.Data) > 256*1024 {
			return out, errors.New("oversized ciphertext proof operation")
		}
	}
	if err = proof.Verify(genesis, proof.Bundle{SignedHeader: header, Query: query}, key, now, maxAge); err != nil {
		return out, err
	}
	var payment struct {
		Bundle string `json:"bundle"`
		Height int64  `json:"height,string"`
	}
	if err = json.Unmarshal(query.Value, &payment); err != nil {
		return out, err
	}
	wire, err := base64.RawURLEncoding.DecodeString(payment.Bundle)
	if err != nil || len(wire) < 1 || len(wire) > 16384 || base64.RawURLEncoding.EncodeToString(wire) != payment.Bundle || payment.Height < 1 || payment.Height > height || !bytes.Equal(query.Key, []byte(key)) {
		return out, errors.New("invalid proven ciphertext record")
	}
	// The authenticated consensus key binds the ID. This path does not inspect
	// or authorize Orchard effects; the caller must compare exact saved bytes.
	out.RecordOnly = true
	out.ChainID = genesis.ChainID
	out.Height = height
	out.HeaderTime = header.Time
	out.AppHash = hex.EncodeToString(header.AppHash)
	out.Parties = []Identity{}
	out.Commitments = []string{}
	out.Payments = []Payment{}
	out.Boundaries = []Payment{}
	record := Payment{ID: id, Bundle: payment.Bundle, Height: payment.Height}
	if prefix == "private_payment/" {
		out.Payments = append(out.Payments, record)
	} else {
		out.Boundaries = append(out.Boundaries, record)
	}
	return out, nil
}
