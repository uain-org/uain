// Package gateway serves finalized native state. SQL/indexer responses never
// confer authority: every selected value or absence is checked against one
// signed header rooted in an independently pinned genesis.
package gateway

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
	"net/url"
	"regexp"
	"time"
)

type Source interface {
	Query(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error)
}
type Request struct {
	Member   string          `json:"member,omitempty"`
	Instance string          `json:"instance,omitempty"`
	Keys     []string        `json:"keys,omitempty"`
	Receipt  *ReceiptRequest `json:"receipt,omitempty"`
}
type Snapshot struct {
	ChainID      string                     `json:"chain_id"`
	Height       int64                      `json:"height,string"`
	HeaderTime   time.Time                  `json:"header_time"`
	AppHash      string                     `json:"app_hash"`
	Member       *federation.Member         `json:"member,omitempty"`
	Instance     *federation.Instance       `json:"instance,omitempty"`
	Records      map[string]json.RawMessage `json:"records"`
	SignedHeader cmttypes.SignedHeader      `json:"signed_header"`
	Queries      []abci.ResponseQuery       `json:"queries"`
	Receipt      *Receipt                   `json:"receipt,omitempty"`
	EventCount   uint64                     `json:"event_count,string"`
}

var memberPattern = regexp.MustCompile(`^uain1[0-9a-f]{40}$`)
var instancePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$`)
var keyPattern = regexp.MustCompile(`^[a-zA-Z0-9_./:-]{1,512}$`)

func Read(ctx context.Context, g *cmttypes.GenesisDoc, h cmttypes.SignedHeader, s Source, now time.Time, age time.Duration, r Request) (Snapshot, error) {
	out := Snapshot{}
	if r.Receipt != nil {
		if r.Receipt.EventID == 0 || r.Member != "" && r.Member != r.Receipt.Envelope.Command.Member {
			return out, errors.New("exact receipt event and member required")
		}
		r.Member = r.Receipt.Envelope.Command.Member
		r.Keys = append(append([]string{}, r.Keys...), fmt.Sprintf("event/%020d", r.Receipt.EventID))
	}
	if g == nil || h.Header == nil || s == nil || age <= 0 || age > 10*time.Minute || len(r.Keys) > 32 || r.Member != "" && !memberPattern.MatchString(r.Member) || r.Instance != "" && (!instancePattern.MatchString(r.Instance) || r.Member == "") {
		return out, errors.New("pinned genesis, bounded freshness and exact member/instance selection required")
	}
	seen := map[string]bool{}
	for _, key := range r.Keys {
		if !keyPattern.MatchString(key) || seen[key] {
			return out, errors.New("invalid or duplicate bounded record selection")
		}
		seen[key] = true
	}
	out = Snapshot{ChainID: g.ChainID, Height: h.Height - 1, HeaderTime: h.Time, AppHash: hex.EncodeToString(h.AppHash), SignedHeader: h, Records: map[string]json.RawMessage{}}
	queries := []abci.ResponseQuery{}
	query := func(key string, anchor bool) (json.RawMessage, error) {
		if value, ok := out.Records[key]; ok {
			return value, nil
		}
		if len(queries) >= 96 {
			return nil, errors.New("compound proof selection exceeds bound")
		}
		q, err := s.Query(ctx, "/store/federation/key", []byte(key), out.Height, true)
		if err != nil {
			return nil, err
		}
		if q.Code != 0 || q.Height != out.Height || !bytes.Equal(q.Key, []byte(key)) || len(q.Value) > federation.MaxEnvelopeBytes || q.ProofOps == nil || len(q.ProofOps.Ops) > 4 {
			return nil, fmt.Errorf("invalid finalized query bounds/context for %s: code=%d height=%d expected=%d key_matches=%t proof_present=%t",key,q.Code,q.Height,out.Height,bytes.Equal(q.Key,[]byte(key)),q.ProofOps!=nil)
		}
		for _, op := range q.ProofOps.Ops {
			if len(op.Data) > 256*1024 {
				return nil, errors.New("oversized state proof")
			}
		}
		if anchor {
			err = proof.Verify(g, proof.Bundle{SignedHeader: h, Query: q}, key, now, age)
		} else if len(q.Value) == 0 {
			err = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, h.AppHash, "/federation/"+url.PathEscape(key))
		} else {
			err = proof.VerifyQuery(q, key, h.AppHash, out.Height)
		}
		if err != nil {
			return nil, fmt.Errorf("authenticate %s: %w", key, err)
		}
		value := json.RawMessage(bytes.Clone(q.Value))
		if len(value) != 0 && !json.Valid(value) {
			// The proof authenticates the original compressed bytes. Keep those
			// bytes in Queries for semantic compound verification; expose only
			// bounded decoded JSON to clients and derived projections.
			r,err:=zlib.NewReader(bytes.NewReader(value));if err!=nil{return nil,errors.New("proven record is not JSON or bounded compressed evidence")}
			decoded,err:=io.ReadAll(io.LimitReader(r,federation.MaxEnvelopeBytes+1));r.Close()
			if err!=nil||len(decoded)>federation.MaxEnvelopeBytes||!json.Valid(decoded){return nil,errors.New("invalid or oversized proven evidence")};value=json.RawMessage(decoded)
		}
		if len(value) == 0 {
			value = nil
		}
		queries = append(queries, q)
		out.Records[key] = value
		return value, nil
	}
	// A fixed, mandatory inclusion anchors the header even when every requested
	// record is absent. Missing indexer data can never masquerade as proven zero.
	if _, err := query("guardians", true); err != nil {
		return Snapshot{}, err
	}
	if _, err := query("legacy_import", false); err != nil {
		return Snapshot{}, err
	}
	count, err := query("event_count", false)
	if err != nil {
		return Snapshot{}, err
	}
	if len(count) > 0 {
		if err = json.Unmarshal(count, &out.EventCount); err != nil {
			return Snapshot{}, err
		}
	}
	if r.Member != "" {
		raw, err := query("member/"+r.Member, false)
		if err != nil {
			return Snapshot{}, err
		}
		if len(raw) == 0 {
			return Snapshot{}, errors.New("member has no finalized native identity")
		}
		var partial federation.Member
		if err = json.Unmarshal(raw, &partial); err != nil {
			return Snapshot{}, err
		}
		if partial.AccountPolicy != "" {
			if _, err = query("member_metadata/"+r.Member, false); err != nil {
				return Snapshot{}, err
			}
		}
		included := []abci.ResponseQuery{}
		for _, q := range queries {
			if len(q.Value) > 0 {
				included = append(included, q)
			}
		}
		member, err := proof.VerifyMember(included, r.Member, h.AppHash, out.Height)
		if err != nil {
			return Snapshot{}, err
		}
		if member.ID != r.Member {
			return Snapshot{}, errors.New("proven member identity mismatch")
		}
		out.Member = &member
	}
	if r.Instance != "" {
		raw, err := query("instance/"+r.Instance, false)
		if err != nil {
			return Snapshot{}, err
		}
		if len(raw) == 0 {
			return Snapshot{}, errors.New("instance is absent")
		}
		var partial federation.Instance
		if err = json.Unmarshal(raw, &partial); err != nil {
			return Snapshot{}, err
		}
		if partial.AccountPolicy != "" {
			if _, err = query("instance_metadata/"+r.Instance, false); err != nil {
				return Snapshot{}, err
			}
		}
		included := []abci.ResponseQuery{}
		for _, q := range queries {
			if len(q.Value) > 0 {
				included = append(included, q)
			}
		}
		instance, err := proof.VerifyInstance(included, r.Instance, h.AppHash, out.Height)
		if err != nil {
			return Snapshot{}, err
		}
		if instance.Member != r.Member {
			return Snapshot{}, errors.New("proven instance belongs to another member")
		}
		out.Instance = &instance
	}
	for _, key := range r.Keys {
		if _, err := query(key, false); err != nil {
			return Snapshot{}, err
		}
	}
	out.Queries = queries
	if r.Receipt != nil {
		receipt, err := commandReceipt(out, *r.Receipt)
		if err != nil {
			return Snapshot{}, err
		}
		out.Receipt = &receipt
	}
	return out, nil
}
