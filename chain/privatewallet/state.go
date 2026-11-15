// Package privatewallet authenticates recent finalized private-pool state.
// It holds no spending or member signing keys and performs no consensus writes.
package privatewallet

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/federation"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"github.com/uain-org/uain/chain/proof"
	"google.golang.org/protobuf/encoding/protowire"
)

const MaxNotes = uint64(1048576)
const NotePage = uint64(1000)

var memberID = regexp.MustCompile(`^uain1[0-9a-f]{40}$`)
var digestID = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Source interface {
	Query(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error)
}
type Request struct {
	LightScan        bool          `json:"light_scan,omitempty"`
	RecordOnly       bool          `json:"record_only,omitempty"`
	SkipWitness      bool          `json:"skip_witness,omitempty"`
	CompactWitness   bool          `json:"compact_witness,omitempty"`
	WitnessPositions []uint32      `json:"witness_positions,omitempty"`
	WitnessCache     *WitnessCache `json:"witness_cache,omitempty"`
	PolicyOnly       bool          `json:"policy_only,omitempty"`
	Reviewer         string        `json:"reviewer"`
	Parties          []string      `json:"parties"`
	SourcePayments   []string      `json:"source_payments,omitempty"`
	SourceBoundaries []string      `json:"source_boundaries,omitempty"`
	BoundaryMember   string        `json:"boundary_member,omitempty"`
}
type Identity struct {
	Member    string `json:"member"`
	PublicKey string `json:"public_key"`
	Karma     int64  `json:"karma"`
	Sequence  uint64 `json:"sequence,string"`
}
type Payment struct {
	ID     string `json:"id"`
	Bundle string `json:"bundle"`
	Height int64  `json:"height,string"`
}
type Snapshot struct {
	LightScan       bool             `json:"light_scan,omitempty"`
	Records         []LightRecord    `json:"records,omitempty"`
	Nullifiers      []LightNullifier `json:"nullifiers,omitempty"`
	Light           *LightStats      `json:"light,omitempty"`
	RecordOnly      bool             `json:"record_only"`
	WitnessCache    *WitnessCache    `json:"witness_cache,omitempty"`
	NotesFetched    uint64           `json:"notes_fetched,string"`
	PolicyOnly      bool             `json:"policy_only"`
	WitnessComplete bool             `json:"witness_complete"`
	ChainID         string           `json:"chain_id"`
	Height          int64            `json:"height,string"`
	HeaderTime      time.Time        `json:"header_time"`
	AppHash         string           `json:"app_hash"`
	LicenceRevision uint64           `json:"licence_revision,string"`
	Root            string           `json:"root"`
	Count           uint64           `json:"count,string"`
	Relayer         Identity         `json:"relayer"`
	Reviewer        Identity         `json:"reviewer"`
	Parties         []Identity       `json:"parties"`
	Commitments     []string         `json:"commitments"`
	Payments        []Payment        `json:"payments"`
	Boundaries      []Payment        `json:"boundaries"`
	Coin            *CoinState       `json:"coin,omitempty"`
}
type CoinState struct {
	Policy  string      `json:"policy"`
	Supply  coin.Ledger `json:"supply"`
	Owner   *Identity   `json:"owner,omitempty"`
	Balance string      `json:"balance,omitempty"`
}

// Read verifies the signed header against an independently obtained genesis,
// then every licence/policy input against exactly its app hash and height.
// Note pages are untrusted transport: reconstructing the Orchard tree binds
// their complete count, ordering and bytes to the proven frontier root.
func Read(ctx context.Context, genesis *cmttypes.GenesisDoc, header cmttypes.SignedHeader, source Source, now time.Time, maxAge time.Duration, request Request) (Snapshot, error) {
	if request.LightScan {
		return readLight(ctx, genesis, header, source, now, maxAge, request)
	}
	if request.RecordOnly {
		return readRecord(ctx, genesis, header, source, now, maxAge, request)
	}
	out := Snapshot{}
	if !shield.Available() {
		return out, shield.ErrUnavailable
	}
	boundary := request.BoundaryMember != ""
	validRoles := request.PolicyOnly && !boundary && len(request.Parties) == 0 || !request.PolicyOnly && (boundary && len(request.Parties) == 0 && memberID.MatchString(request.BoundaryMember) && request.BoundaryMember != request.Reviewer || !boundary && len(request.Parties) == 2 && memberID.MatchString(request.Parties[0]) && memberID.MatchString(request.Parties[1]) && request.Parties[0] != request.Parties[1] && request.Reviewer != request.Parties[0] && request.Reviewer != request.Parties[1])
	if request.SkipWitness && (request.PolicyOnly || request.CompactWitness || len(request.WitnessPositions) > 0 || request.WitnessCache != nil) || len(request.WitnessPositions) > 16 || request.PolicyOnly && (request.CompactWitness || len(request.WitnessPositions) > 0 || request.WitnessCache != nil) || !request.CompactWitness && (len(request.WitnessPositions) > 0 || request.WitnessCache != nil) {
		return out, errors.New("bounded compact witnesses require a member snapshot")
	}
	if maxAge <= 0 || maxAge > 10*time.Minute || !validRoles || source == nil || header.Header == nil || !memberID.MatchString(request.Reviewer) || len(request.SourcePayments)+len(request.SourceBoundaries) > 16 {
		return out, errors.New("distinct members for OTC, one boundary owner or public policy only, independent reviewer and bounded sources required")
	}
	height := header.Height - 1
	query := func(key string, target any, authenticateHeader bool) error {
		q, err := source.Query(ctx, "/store/federation/key", []byte(key), height, true)
		if err != nil {
			return err
		}
		if len(q.Value) > federation.MaxEnvelopeBytes || q.ProofOps == nil || len(q.ProofOps.Ops) > 4 {
			return errors.New("oversized or missing state proof")
		}
		for _, op := range q.ProofOps.Ops {
			if len(op.Data) > 256*1024 {
				return errors.New("oversized state proof operation")
			}
		}
		// A never-credited account is zero only with an authenticated absence
		// proof, not a missing indexer response. The header was verified above.
		if strings.HasPrefix(key, "coin_balance/") && !authenticateHeader && len(q.Value) == 0 {
			balance, ok := target.(*string)
			if !ok || q.Code != 0 || q.Height != height || !bytes.Equal(q.Key, []byte(key)) {
				return errors.New("invalid Coin balance absence context")
			}
			if err = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, header.AppHash, "/federation/"+url.PathEscape(key)); err != nil {
				return err
			}
			*balance = "0"
			return nil
		}
		if authenticateHeader {
			err = proof.Verify(genesis, proof.Bundle{SignedHeader: header, Query: q}, key, now, maxAge)
		} else {
			err = proof.VerifyQuery(q, key, header.AppHash, height)
		}
		if err != nil {
			return fmt.Errorf("authenticate %s: %w", key, err)
		}
		return json.Unmarshal(q.Value, target)
	}
	var activation federation.PrivateActivation
	if err := query("private_activation", &activation, true); err != nil {
		return out, err
	}
	if activation.Policy != federation.PrivateExchangePolicy || activation.Height > height || activation.Height < 1 || !memberID.MatchString(activation.Relayer) || !digestID.MatchString(activation.EvidenceDigest) {
		return out, errors.New("private policy is not active at the proven height")
	}
	if boundary && activation.Relayer == request.BoundaryMember || !request.PolicyOnly && !boundary && (activation.Relayer == request.Parties[0] || activation.Relayer == request.Parties[1]) {
		return out, errors.New("relay cannot be a trading party")
	}
	var revision federation.CensusRevision
	if err := query("private_licence_revision", &revision, false); err != nil {
		return out, err
	}
	var frontier federation.PrivateFrontier
	if err := query("private_frontier", &frontier, false); err != nil {
		return out, err
	}
	if frontier.Count > uint64(1)<<32 || !request.PolicyOnly && !request.SkipWitness && !request.CompactWitness && frontier.Count > MaxNotes || !digestID.MatchString(frontier.Root) {
		return out, errors.New("unsupported note count or root; incremental witnesses required above the client limit")
	}
	var rootHeight int64
	if err := query("private_root/"+frontier.Root, &rootHeight, false); err != nil {
		return out, err
	}
	if rootHeight < 1 || rootHeight > height {
		return out, errors.New("invalid accepted-root height")
	}
	identity := func(id string) (Identity, error) {
		var m federation.Member
		if err := query("member/"+id, &m, false); err != nil {
			return Identity{}, err
		}
		raw, err := base64.RawURLEncoding.DecodeString(m.PublicKey)
		if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != m.PublicKey || m.ID != id || federation.Address(raw) != id || m.Licence != "active" {
			return Identity{}, errors.New("active proven member/key binding required")
		}
		return Identity{Member: id, PublicKey: m.PublicKey, Karma: m.Karma, Sequence: m.Sequence}, nil
	}
	var err error
	if out.Relayer, err = identity(activation.Relayer); err != nil {
		return Snapshot{}, err
	}
	if out.Reviewer, err = identity(request.Reviewer); err != nil {
		return Snapshot{}, err
	}
	if out.Reviewer.Karma < federation.PrivateReviewerKarma {
		return Snapshot{}, errors.New("reviewer lacks required Karma")
	}
	var appointment struct {
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err = query("private_reviewer/"+request.Reviewer, &appointment, false); err != nil {
		return Snapshot{}, err
	}
	if !appointment.Active || !digestID.MatchString(appointment.EvidenceDigest) {
		return Snapshot{}, errors.New("active proven reviewer appointment required")
	}
	out.Parties = make([]Identity, len(request.Parties))
	for i, id := range request.Parties {
		if out.Parties[i], err = identity(id); err != nil {
			return Snapshot{}, err
		}
	}
	if boundary || len(request.SourceBoundaries) > 0 {
		var activation federation.CoinActivation
		if err = query("coin_activation", &activation, false); err != nil {
			return Snapshot{}, err
		}
		if activation.Policy != federation.CoinPolicy || activation.Height < 1 || activation.Height > height || !digestID.MatchString(activation.EvidenceDigest) {
			return Snapshot{}, errors.New("prospective Coin policy is not active")
		}
		out.Coin = &CoinState{Policy: activation.Policy}
		if err = query("coin_supply", &out.Coin.Supply, false); err != nil {
			return Snapshot{}, err
		}
		if err = out.Coin.Supply.Validate(); err != nil {
			return Snapshot{}, err
		}
		if boundary {
			owner, e := identity(request.BoundaryMember)
			if e != nil {
				return Snapshot{}, e
			}
			out.Coin.Owner = &owner
			if err = query("coin_balance/"+owner.Member, &out.Coin.Balance, false); err != nil {
				return Snapshot{}, err
			}
			if err = (coin.Ledger{Minted: out.Coin.Balance, Transparent: out.Coin.Balance, Reserved: "0", Shielded: "0"}).Validate(); err != nil {
				return Snapshot{}, err
			}
		}
	}
	out.PolicyOnly = request.PolicyOnly
	out.Commitments = make([]string, 0)
	if request.CompactWitness {
		cache, fetched, err := readCompactWitness(ctx, source, height, genesis.ChainID, frontier, request, query)
		if err != nil {
			return Snapshot{}, err
		}
		out.WitnessCache = cache
		out.NotesFetched = fetched
		out.WitnessComplete = true
	} else if !request.PolicyOnly && !request.SkipWitness {
		out.NotesFetched = frontier.Count
		if out.Commitments, err = readCommitments(ctx, source, height, frontier); err != nil {
			return Snapshot{}, err
		}
		root, e := commitmentRoot(ctx, out.Commitments)
		if e != nil || root != frontier.Root {
			return Snapshot{}, errors.New("note transport does not match the proven Orchard root")
		}
		out.WitnessComplete = true
	}
	seen := map[string]bool{}
	out.Payments = make([]Payment, 0, len(request.SourcePayments))
	out.Boundaries = make([]Payment, 0, len(request.SourceBoundaries))
	for index, id := range append(append([]string{}, request.SourcePayments...), request.SourceBoundaries...) {
		if !digestID.MatchString(id) || seen[id] {
			return Snapshot{}, errors.New("invalid or repeated source payment")
		}
		seen[id] = true
		var payment struct {
			Bundle string `json:"bundle"`
			Height int64  `json:"height,string"`
		}
		prefix := "private_payment/"
		if index >= len(request.SourcePayments) {
			prefix = "private_boundary/"
		}
		if err = query(prefix+id, &payment, false); err != nil {
			return Snapshot{}, err
		}
		wire, e := base64.RawURLEncoding.DecodeString(payment.Bundle)
		if e != nil || len(wire) > 16384 || base64.RawURLEncoding.EncodeToString(wire) != payment.Bundle || payment.Height < 1 || payment.Height > height {
			return Snapshot{}, errors.New("invalid proven source payment")
		}
		effect, e := shield.Effects(wire)
		if e != nil || hex.EncodeToString(effect[:]) != id {
			return Snapshot{}, errors.New("source payment effects do not match its proven ID")
		}
		proven := Payment{ID: id, Bundle: payment.Bundle, Height: payment.Height}
		if prefix == "private_payment/" {
			out.Payments = append(out.Payments, proven)
		} else {
			out.Boundaries = append(out.Boundaries, proven)
		}
	}
	out.ChainID = genesis.ChainID
	out.Height = height
	out.HeaderTime = header.Time
	out.AppHash = hex.EncodeToString(header.AppHash)
	out.LicenceRevision = revision.Value
	out.Root = frontier.Root
	out.Count = frontier.Count
	return out, nil
}

// readCommitments reads every note commitment page. Pages are untrusted
// transport; the caller binds the result to the proven frontier root.
func readCommitments(ctx context.Context, source Source, height int64, frontier federation.PrivateFrontier) ([]string, error) {
	commitments := make([]string, 0, int(frontier.Count))
	var err error
	// SDK subspace transport can read latest data even with a requested old height.
	// Never trust its advertised height. Ignore only append-only positions beyond
	// the authenticated count, and authenticate all earlier data by the root.
	for start := uint64(0); start < frontier.Count; start += NotePage {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		prefix := []byte(fmt.Sprintf("private_note/%010d", start)[:20]) // seven of ten position digits
		q, e := source.Query(ctx, "/store/federation/subspace", prefix, height, false)
		if e != nil {
			return nil, e
		}
		if q.Code != 0 || !bytes.Equal(q.Key, prefix) {
			return nil, errors.New("invalid note page response")
		}
		pairs, e := decodePage(q.Value)
		if e != nil {
			return nil, e
		}
		next := start
		for _, row := range pairs {
			if len(row.Key) != 23 || !bytes.HasPrefix(row.Key, prefix) {
				return nil, errors.New("note page escaped its bounded prefix")
			}
			var position uint64
			if _, e = fmt.Sscanf(string(row.Key), "private_note/%010d", &position); e != nil || string(row.Key) != fmt.Sprintf("private_note/%010d", position) {
				return nil, errors.New("noncanonical note position")
			}
			if position >= frontier.Count {
				continue
			}
			if position != next {
				return nil, errors.New("missing, repeated or reordered note commitment")
			}
			var value string
			if e = json.Unmarshal(row.Value, &value); e != nil || !digestID.MatchString(value) {
				return nil, errors.New("invalid note commitment")
			}
			commitments = append(commitments, value)
			next++
		}
		end := start + NotePage
		if end > frontier.Count {
			end = frontier.Count
		}
		if next != end {
			return nil, errors.New("incomplete authenticated note page")
		}
	}
	return commitments, nil
}

// CommitmentRoot is O(n) work with a bounded vector, using pinned upstream
// Orchard hashing. No hand-written replacement hash or unchecked tree root.
func CommitmentRoot(commitments []string) (string, error) {
	return commitmentRoot(context.Background(), commitments)
}
func commitmentRoot(ctx context.Context, commitments []string) (string, error) {
	if len(commitments) > int(MaxNotes) {
		return "", errors.New("note witness limit exceeded")
	}
	if len(commitments) == 0 {
		root, e := shield.Empty(32)
		return hex.EncodeToString(root[:]), e
	}
	nodes := make([][32]byte, len(commitments))
	for i, value := range commitments {
		if !digestID.MatchString(value) {
			return "", errors.New("invalid commitment encoding")
		}
		raw, _ := hex.DecodeString(value)
		copy(nodes[i][:], raw)
	}
	for level := uint8(0); level < 32; level++ {
		size := (len(nodes) + 1) / 2
		for i, j := 0, 0; i < len(nodes); i, j = i+2, j+1 {
			if j%256 == 0 {
				if err := ctx.Err(); err != nil {
					return "", err
				}
			}
			var right [32]byte
			var err error
			if i+1 < len(nodes) {
				right = nodes[i+1]
			} else {
				right, err = shield.Empty(level)
				if err != nil {
					return "", err
				}
			}
			nodes[j], err = shield.Combine(level, nodes[i], right)
			if err != nil {
				return "", err
			}
		}
		nodes = nodes[:size]
	}
	return hex.EncodeToString(nodes[0][:]), nil
}

type pair struct{ Key, Value []byte }

// Strict bounded parsing of the SDK's public kv.Pairs wire format. Its generated
// Go type is internal to the SDK; no unknown/duplicate fields are accepted here.
func decodePage(raw []byte) ([]pair, error) {
	if len(raw) > 256*1024 {
		return nil, errors.New("note page too large")
	}
	rows := make([]pair, 0, NotePage)
	for len(raw) > 0 {
		number, kind, n := protowire.ConsumeTag(raw)
		if n < 0 || number != 1 || kind != protowire.BytesType || len(rows) >= int(NotePage) {
			return nil, errors.New("invalid note page framing")
		}
		raw = raw[n:]
		item, n := protowire.ConsumeBytes(raw)
		if n < 0 || len(item) > 256 {
			return nil, errors.New("invalid note entry framing")
		}
		raw = raw[n:]
		row := pair{}
		for len(item) > 0 {
			number, kind, n = protowire.ConsumeTag(item)
			if n < 0 || kind != protowire.BytesType || number < 1 || number > 2 {
				return nil, errors.New("invalid note entry field")
			}
			item = item[n:]
			value, n := protowire.ConsumeBytes(item)
			if n < 0 {
				return nil, errors.New("invalid note field length")
			}
			item = item[n:]
			if number == 1 {
				if row.Key != nil {
					return nil, errors.New("duplicate note key")
				}
				row.Key = bytes.Clone(value)
			} else {
				if row.Value != nil {
					return nil, errors.New("duplicate note value")
				}
				row.Value = bytes.Clone(value)
			}
		}
		if len(row.Key) != 23 || len(row.Value) != 66 || len(rows) > 0 && bytes.Compare(rows[len(rows)-1].Key, row.Key) >= 0 {
			return nil, errors.New("invalid or unordered note entries")
		}
		rows = append(rows, row)
	}
	return rows, nil
}
