//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	rpctypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/privatewallet"
	"github.com/uain-org/uain/chain/proof"
	"google.golang.org/protobuf/encoding/protowire"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type privateFixtureSource struct {
	app   *App
	fault string
}

func (s privateFixtureSource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	response, err := s.app.Query(ctx, &abci.RequestQuery{Path: path, Data: key, Height: height, Prove: prove})
	if err != nil {
		return abci.ResponseQuery{}, err
	}
	if response == nil {
		return abci.ResponseQuery{}, errors.New("missing SDK query")
	}
	q := *response
	q.Value = bytes.Clone(q.Value)
	q.Key = bytes.Clone(q.Key)
	if string(key) == "private_licence_revision" {
		if s.fault == "wrong-key" {
			q.Key = []byte("member/other")
		}
		if s.fault == "wrong-height" {
			q.Height++
		}
		if s.fault == "tampered-licence" {
			q.Value = []byte(`{"value":"999"}`)
		}
	}
	if path == "/store/federation/subspace" {
		switch s.fault {
		case "missing-page":
			q.Value = nil
		case "changed-note":
			i := bytes.Index(q.Value, []byte(`"`))
			if i < 0 {
				return q, errors.New("fixture missing leaf")
			}
			if q.Value[i+1] == '0' {
				q.Value[i+1] = '1'
			} else {
				q.Value[i+1] = '0'
			}
		case "truncated-page":
			q.Value = q.Value[:len(q.Value)-1]
		case "future-append":
			// The current range transport may be newer than the proven snapshot.
			// Only the four commitments authenticated by its root/count may be used.
			row := protowire.AppendTag(nil, 1, protowire.BytesType)
			row = protowire.AppendBytes(row, []byte("private_note/0000000004"))
			value, _ := json.Marshal(strings.Repeat("03", 32))
			row = protowire.AppendTag(row, 2, protowire.BytesType)
			row = protowire.AppendBytes(row, value)
			q.Value = protowire.AppendTag(q.Value, 1, protowire.BytesType)
			q.Value = protowire.AppendBytes(q.Value, row)
			q.Height++ // Deliberately not a trusted assertion about range finality.
		}
	}
	return q, nil
}

// The public policy path must not ask the RPC for trading identities or a note
// page. Keep the actual SDK proof source and fail if that boundary is crossed.
type privatePolicyFixtureSource struct {
	base privateFixtureSource
	keys []string
}

func (s *privatePolicyFixtureSource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	s.keys = append(s.keys, string(key))
	if path != "/store/federation/key" {
		return abci.ResponseQuery{}, errors.New("public policy requested private note transport")
	}
	return s.base.Query(ctx, path, key, height, prove)
}

func assertVerifiedPrivateState(t *testing.T, a *App, appHash []byte, height int64, reviewer, relay, sender, recipient, payment string, relayKey ed25519.PrivateKey) {
	t.Helper()
	validatorKey := cmted.GenPrivKey()
	validator := cmttypes.NewValidator(validatorKey.PubKey(), 10)
	set := cmttypes.NewValidatorSet([]*cmttypes.Validator{validator})
	now := time.Now().UTC()
	trust := &cmttypes.GenesisDoc{ChainID: "uain-test-1", GenesisTime: time.Unix(1000, 0).UTC(), Validators: []cmttypes.GenesisValidator{{PubKey: validatorKey.PubKey(), Power: 10}}}
	header := &cmttypes.Header{Version: cmtversion.Consensus{Block: 11}, ChainID: trust.ChainID, Height: height + 1, Time: now, ValidatorsHash: set.Hash(), NextValidatorsHash: set.Hash(), AppHash: appHash, ProposerAddress: validator.Address}
	commit := &cmttypes.Commit{Height: height + 1, Round: 0, BlockID: cmttypes.BlockID{Hash: header.Hash(), PartSetHeader: cmttypes.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{1}, 32)}}, Signatures: []cmttypes.CommitSig{{BlockIDFlag: cmttypes.BlockIDFlagCommit, ValidatorAddress: validator.Address, Timestamp: now}}}
	var err error
	commit.Signatures[0].Signature, err = validatorKey.Sign(commit.VoteSignBytes(trust.ChainID, 0))
	if err != nil {
		t.Fatal(err)
	}
	signed := cmttypes.SignedHeader{Header: header, Commit: commit}
	request := privatewallet.Request{Reviewer: reviewer, Parties: []string{sender, recipient}, SourcePayments: []string{payment}}
	read := func(fault string, sh cmttypes.SignedHeader, when time.Time, req privatewallet.Request) (privatewallet.Snapshot, error) {
		return privatewallet.Read(context.Background(), trust, sh, privateFixtureSource{app: a, fault: fault}, when, time.Minute, req)
	}
	state, err := read("", signed, now, request)
	if err != nil {
		t.Fatal("real finalized SDK wallet snapshot", err)
	}
	if state.Count != 4 || len(state.Commitments) != 4 || state.Relayer.Member != relay || state.Reviewer.Member != reviewer || state.Height != height || len(state.Payments) != 1 || state.Payments[0].ID != payment {
		t.Fatalf("wrong authenticated snapshot: %+v", state)
	}
	if state.PolicyOnly || !state.WitnessComplete {
		t.Fatal("full member snapshot lacks authenticated witness")
	}
	compactRequest := request
	compactRequest.CompactWitness = true
	compactRequest.WitnessPositions = []uint32{0, 3}
	compact, e := read("", signed, now, compactRequest)
	if e != nil || !compact.WitnessComplete || len(compact.Commitments) != 0 || compact.NotesFetched != 4 || compact.WitnessCache == nil || len(compact.WitnessCache.Witnesses) != 2 || compact.Root != state.Root {
		t.Fatal("compact SDK snapshot", e)
	}
	compactRequest.WitnessCache = compact.WitnessCache
	warm, e := read("missing-page", signed, now, compactRequest)
	if e != nil || warm.NotesFetched != 0 || warm.Root != state.Root {
		t.Fatal("warm cache unexpectedly downloaded notes", e)
	}
	for _, fault := range []string{"changed-note", "missing-page", "truncated-page", "wrong-height", "tampered-licence"} {
		cold := compactRequest
		cold.WitnessCache = nil
		if _, e = read(fault, signed, now, cold); e == nil {
			t.Fatal("compact accepted corrupt transport", fault)
		}
	}
	for _, mutate := range []func(*privatewallet.WitnessCache){
		func(c *privatewallet.WitnessCache) { c.ChainID = "another-chain" },
		func(c *privatewallet.WitnessCache) { c.Count++ },
		func(c *privatewallet.WitnessCache) { c.Nodes[2] = strings.Repeat("00", 32) },
		func(c *privatewallet.WitnessCache) { c.Witnesses[0].Path[0] = strings.Repeat("00", 32) },
		func(c *privatewallet.WitnessCache) { c.Witnesses[0].Commitment = strings.Repeat("00", 32) },
	} {
		encoded, _ := json.Marshal(compact.WitnessCache)
		var bad privatewallet.WitnessCache
		if e = json.Unmarshal(encoded, &bad); e != nil {
			t.Fatal(e)
		}
		mutate(&bad)
		corrupt := compactRequest
		corrupt.WitnessCache = &bad
		if _, e = read("", signed, now, corrupt); e == nil {
			t.Fatal("tampered cache accepted")
		}
	}
	metadata := request
	metadata.SkipWitness = true
	metadataState, e := read("missing-page", signed, now, metadata)
	if e != nil || metadataState.WitnessComplete || len(metadataState.Commitments) != 0 || metadataState.Root != state.Root {
		t.Fatal("metadata state downloaded notes", e)
	}
	policySource := &privatePolicyFixtureSource{base: privateFixtureSource{app: a}}
	policyRequest := privatewallet.Request{Reviewer: reviewer, PolicyOnly: true}
	policy, e := privatewallet.Read(context.Background(), trust, signed, policySource, now, time.Minute, policyRequest)
	if e != nil {
		t.Fatal("real finalized SDK public policy", e)
	}
	if !policy.PolicyOnly || policy.WitnessComplete || len(policy.Parties) != 0 || len(policy.Commitments) != 0 || policy.Count != state.Count || policy.Root != state.Root || policy.Relayer.Sequence != state.Relayer.Sequence || policy.Reviewer.Sequence != state.Reviewer.Sequence {
		t.Fatalf("policy disclosed private witness or changed signed state: %+v", policy)
	}
	for _, key := range policySource.keys {
		if strings.HasPrefix(key, "member/") && key != "member/"+relay && key != "member/"+reviewer {
			t.Fatal("policy queried a trading identity", key)
		}
	}
	for _, fault := range []string{"wrong-key", "wrong-height", "tampered-licence"} {
		if _, e = read(fault, signed, now, policyRequest); e == nil {
			t.Fatal("public policy accepted corrupt state", fault)
		}
	}
	for _, mixed := range []privatewallet.Request{{PolicyOnly: true, Reviewer: reviewer, Parties: request.Parties}, {PolicyOnly: true, Reviewer: reviewer, BoundaryMember: sender}} {
		if _, e = read("", signed, now, mixed); e == nil {
			t.Fatal("public policy accepted trading role selection")
		}
	}
	future, err := read("future-append", signed, now, request)
	if err != nil || future.Root != state.Root || len(future.Commitments) != 4 {
		t.Fatal("future append changed the pinned snapshot", err)
	}
	for _, fault := range []string{"wrong-key", "wrong-height", "tampered-licence", "missing-page", "changed-note", "truncated-page"} {
		if _, err = read(fault, signed, now, request); err == nil {
			t.Fatal("accepted corrupt snapshot", fault)
		}
	}
	if _, err = read("", signed, now.Add(2*time.Minute), request); err == nil {
		t.Fatal("stale finalized header accepted")
	}
	wrong := request
	wrong.Parties = []string{relay, recipient}
	if _, err = read("", signed, now, wrong); err == nil {
		t.Fatal("trading party relay accepted")
	}
	wrong = request
	wrong.Parties = []string{sender, recipient, relay}
	if _, err = read("", signed, now, wrong); err == nil {
		t.Fatal("extra trading identity accepted")
	}
	assertPrivateStateClientPayment(t, a, signed, trust, request, height, relayKey)
	badCommit := *commit
	badCommit.Signatures = append([]cmttypes.CommitSig(nil), commit.Signatures...)
	badCommit.Signatures[0].Signature = bytes.Clone(commit.Signatures[0].Signature)
	badCommit.Signatures[0].Signature[0] ^= 1
	if _, err = read("", cmttypes.SignedHeader{Header: header, Commit: &badCommit}, now, request); err == nil {
		t.Fatal("forged validator signature accepted")
	}
}

func privateStateFixtureMember(name string, seed byte) (federation.Member, ed25519.PrivateKey) {
	// Disposable, deterministic identities only; never enroll on production.
	m, _ := testMember(name)
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32))
	pub := key.Public().(ed25519.PublicKey)
	m.PublicKey = base64.RawURLEncoding.EncodeToString(pub)
	m.ID = federation.Address(pub)
	return m, key
}
func assertPrivateStateClientPayment(t *testing.T, a *App, signed cmttypes.SignedHeader, genesis *cmttypes.GenesisDoc, request privatewallet.Request, height int64, relayKey ed25519.PrivateKey) {
	t.Helper()
	reader, wallet := os.Getenv("UAIN_PRIVATE_STATE_BIN"), os.Getenv("UAIN_PRIVATE_WALLET_BIN")
	if reader == "" || wallet == "" {
		t.Fatal("pinned real private-state reader and wallet binaries required")
	}
	node := os.Getenv("UAIN_PRIVATE_NODE_BIN")
	if node == "" {
		node = "node"
	}
	root := t.TempDir()
	raw, err := cmtjson.Marshal(genesis)
	if err != nil {
		t.Fatal(err)
	}
	genesisPath := filepath.Join(root, "public-genesis.json")
	if err = os.WriteFile(genesisPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	pin := sha256.Sum256(raw)
	// A loopback read-only RPC fixture serves genuine SDK IAVL proofs and a
	// genuinely signed fixed-validator header. No private key is returned.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var call struct {
			ID     json.RawMessage            `json:"id"`
			Method string                     `json:"method"`
			Params map[string]json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536)).Decode(&call); err != nil {
			http.Error(w, "invalid fixture RPC", 400)
			return
		}
		var result []byte
		var encodeErr error
		switch call.Method {
		case "commit":
			result, encodeErr = cmtjson.Marshal(rpctypes.ResultCommit{SignedHeader: signed, CanonicalCommit: true})
		case "abci_query":
			var path, data string
			var prove bool
			json.Unmarshal(call.Params["path"], &path)
			json.Unmarshal(call.Params["data"], &data)
			json.Unmarshal(call.Params["prove"], &prove)
			h, e := strconv.ParseInt(strings.Trim(string(call.Params["height"]), "\""), 10, 64)
			if e != nil {
				http.Error(w, "invalid fixture height", 400)
				return
			}
			key, e := hex.DecodeString(data)
			if e != nil {
				http.Error(w, "invalid fixture key", 400)
				return
			}
			q, e := (privateFixtureSource{app: a}).Query(r.Context(), path, key, h, prove)
			if e != nil {
				http.Error(w, "fixture query failed", 400)
				return
			}
			result, encodeErr = cmtjson.Marshal(rpctypes.ResultABCIQuery{Response: q})
		default:
			http.Error(w, "read-only fixture RPC", 400)
			return
		}
		if encodeErr != nil {
			t.Logf("typed fixture encoding failed: %v", encodeErr)
			http.Error(w, "fixture encoding failed", 500)
			return
		}
		body, e := json.Marshal(struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Result  json.RawMessage `json:"result"`
		}{JSONRPC: "2.0", ID: call.ID, Result: result})
		if e != nil {
			http.Error(w, "fixture encoding failed", 500)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.Write(body)
	}))
	defer server.Close()
	input, _ := json.Marshal(map[string]any{"rpc": server.URL, "genesis": genesisPath, "genesisSha256": hex.EncodeToString(pin[:]), "request": request})
	command := exec.Command(node, "../scripts/private-state-smoke.mjs", reader, wallet)
	command.Stdin = bytes.NewReader(input)
	result, e := command.CombinedOutput()
	if e != nil {
		t.Fatalf("finalized state → checker → wallet flow: %v\n%s", e, result)
	}
	var payment federation.PrivatePayment
	if e = json.Unmarshal(result, &payment); e != nil {
		t.Fatal("public fixture payment result", e, string(result))
	}
	payload, _ := json.Marshal(payment)
	c := federation.Command{Version: 1, ChainID: genesis.ChainID, Member: federation.Address(relayKey.Public().(ed25519.PublicKey)), Sequence: 1, ExpiresHeight: height + 50, Operation: "private_payment", Payload: payload}
	signing, e := federation.SigningBytes(c)
	if e != nil {
		t.Fatal(e)
	}
	envelope, _ := json.Marshal(federation.Envelope{Command: c, PublicKey: base64.RawURLEncoding.EncodeToString(relayKey.Public().(ed25519.PublicKey)), Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(relayKey, signing))})
	included := block(t, a, height+1, envelope)
	if included.TxResults[0].Code != 0 {
		t.Fatal("verified-state client payment was refused", included.TxResults[0].Log)
	}
	t.Logf("verified-state client payment gas %d", included.TxResults[0].GasUsed)
	q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("private_frontier"), Height: height + 1, Prove: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = proof.VerifyQuery(*q, "private_frontier", included.AppHash, height+1); e != nil {
		t.Fatal("client frontier proof failed", e)
	}
	var frontier federation.PrivateFrontier
	if e = json.Unmarshal(q.Value, &frontier); e != nil || frontier.Count != 6 {
		t.Fatal("client payment did not advance authenticated note tree", e, frontier)
	}
	replay := block(t, a, height+2, envelope)
	if replay.TxResults[0].Code == 0 {
		t.Fatal("client payment replay accepted")
	}
	fmt.Fprintln(os.Stderr, "PRIVATE_STATE_CLIENT_FLOW_OK")
}
