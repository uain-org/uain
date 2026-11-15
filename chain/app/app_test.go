package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"

	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func testMember(name string) (federation.Member, ed25519.PrivateKey) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	return federation.Member{ID: federation.Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: name, Operator: name, Family: name, Licence: "active", Credits: "0"}, key
}
func testEnvelope(t *testing.T, m federation.Member, key ed25519.PrivateKey, seq uint64, op string, p any, instance ...string) []byte {
	t.Helper()
	payload, e := json.Marshal(p)
	if e != nil {
		t.Fatal(e)
	}
	c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: m.ID, Sequence: seq, ExpiresHeight: 100, Operation: op, Payload: payload}
	if len(instance) > 0 {
		c.Instance = instance[0]
	}
	b, e := federation.SigningBytes(c)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal(federation.Envelope{Command: c, PublicKey: m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, b))})
	if e != nil {
		t.Fatal(e)
	}
	return raw
}
func initApp(t *testing.T, db dbm.DB, g federation.Genesis) *App {
	t.Helper()
	a, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	raw, e := json.Marshal(g)
	if e != nil {
		t.Fatal(e)
	}
	cp := cmttypes.DefaultConsensusParams().ToProto()
	cp.Block.MaxGas = 60000000
	if _, e = a.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), AppStateBytes: raw, ConsensusParams: &cp}); e != nil {
		t.Fatal(e)
	}
	return a
}
func block(t *testing.T, a *App, h int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
	t.Helper()
	r, e := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: h, Time: time.Unix(1000+h, 0).UTC(), Txs: txs})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Commit(); e != nil {
		t.Fatal(e)
	}
	return r
}
func TestSDKPersistentStateReplayAndProof(t *testing.T) {
	guardian, key := testMember("guardian")
	backup, _ := testMember("continuing guardian")
	g := federation.Genesis{Version: 1, Guardians: []string{guardian.ID, backup.ID}, Members: []federation.Member{guardian, backup}}
	db := dbm.NewMemDB()
	a := initApp(t, db, g)
	tx := testEnvelope(t, guardian, key, 0, "withdraw", map[string]any{})
	r := block(t, a, 1, tx)
	if len(r.TxResults) != 1 || r.TxResults[0].Code != 0 {
		t.Fatalf("native transition rejected: %+v", r.TxResults)
	}
	r = block(t, a, 2, tx)
	if r.TxResults[0].Code == 0 {
		t.Fatal("replayed transaction committed")
	}
	q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("member/" + guardian.ID), Height: 2, Prove: true})
	if e != nil || q.Code != 0 || q.ProofOps == nil {
		t.Fatalf("missing SDK state proof: %+v %v", q, e)
	}
	if e = proof.VerifyQuery(*q, "member/"+guardian.ID, r.AppHash, 2); e != nil {
		t.Fatalf("SDK proof did not verify: %v", e)
	}
	corrupt := *q
	corrupt.Value = append(bytes.Clone(q.Value), ' ')
	if e = proof.VerifyQuery(corrupt, "member/"+guardian.ID, r.AppHash, 2); e == nil {
		t.Fatal("tampered state passed proof verification")
	}
	validatorKey := cmted.GenPrivKey()
	validator := cmttypes.NewValidator(validatorKey.PubKey(), 10)
	set := cmttypes.NewValidatorSet([]*cmttypes.Validator{validator})
	now := time.Unix(1003, 0).UTC()
	trust := &cmttypes.GenesisDoc{ChainID: "sdk-test-1", GenesisTime: time.Unix(1000, 0).UTC(), Validators: []cmttypes.GenesisValidator{{PubKey: validatorKey.PubKey(), Power: 10}}}
	header := &cmttypes.Header{Version: cmtversion.Consensus{Block: 11}, ChainID: trust.ChainID, Height: 3, Time: now, ValidatorsHash: set.Hash(), NextValidatorsHash: set.Hash(), AppHash: r.AppHash, ProposerAddress: validator.Address}
	commit := &cmttypes.Commit{Height: 3, Round: 0, BlockID: cmttypes.BlockID{Hash: header.Hash(), PartSetHeader: cmttypes.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{1}, 32)}}, Signatures: []cmttypes.CommitSig{{BlockIDFlag: cmttypes.BlockIDFlagCommit, ValidatorAddress: validator.Address, Timestamp: now}}}
	commit.Signatures[0].Signature, e = validatorKey.Sign(commit.VoteSignBytes(trust.ChainID, 0))
	if e != nil {
		t.Fatal(e)
	}
	bundle := proof.Bundle{SignedHeader: cmttypes.SignedHeader{Header: header, Commit: commit}, Query: *q}
	if e = proof.Verify(trust, bundle, "member/"+guardian.ID, now, time.Minute); e != nil {
		t.Fatalf("signed proof failed: %v", e)
	}
	if e = proof.Verify(trust, bundle, "member/"+guardian.ID, now.Add(2*time.Minute), time.Minute); e == nil {
		t.Fatal("stale header accepted")
	}
	commit.Signatures[0].Signature[0] ^= 1
	if e = proof.Verify(trust, bundle, "member/"+guardian.ID, now, time.Minute); e == nil {
		t.Fatal("invalid block signature accepted")
	}
	var actual federation.Member
	if e = json.Unmarshal(q.Value, &actual); e != nil {
		t.Fatal(e)
	}
	if actual.Sequence != 1 || actual.Licence != "withdrawn" {
		t.Fatalf("wrong committed record: %+v", actual)
	}
	restarted, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	info, e := restarted.Info(&abci.RequestInfo{})
	if e != nil {
		t.Fatal(e)
	}
	if info.LastBlockHeight != 2 || !bytes.Equal(info.LastBlockAppHash, r.AppHash) {
		t.Fatal("state did not survive application restart")
	}
	b := initApp(t, dbm.NewMemDB(), g)
	block(t, b, 1, tx)
	again := block(t, b, 2, tx)
	if !bytes.Equal(r.AppHash, again.AppHash) {
		t.Fatal("identical execution produced different application hashes")
	}
}

func TestSDKAutomaticExpiryPersistsAcrossRestart(t *testing.T) {
	m, key := testMember("creator")
	m.Creator = true
	g := federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	db := dbm.NewMemDB()
	a := initApp(t, db, g)
	prior := federation.PriorArt{Basis: "No discoverable solution exists for this fictional isolated test question.", Searches: []string{"first fictional prior-art search", "second fictional prior-art search"}}
	r := block(t, a, 1, testEnvelope(t, m, key, 0, "open_project", map[string]any{"id": "P-1", "title": "Isolated fixture project", "class": "benevolent", "prior_art": prior}))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	due := time.Unix(2000, 0).UTC()
	task := federation.Task{ID: "T-1", Project: "P-1", Title: "Isolated future task", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 40), Kind: "future", CreditReward: "0", KPI: &federation.KPI{Statement: "The fictional milestone occurs and is published.", Metric: "milestone", Source: "NCT12345678", Comparator: "occurs", ResolvesBy: due.Format(time.RFC3339)}}
	r = block(t, a, 2, testEnvelope(t, m, key, 1, "open_task", task))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	a, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	r, e = a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 3, Time: due.Add(federation.KPIGrace)})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Commit(); e != nil {
		t.Fatal(e)
	}
	q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("task/T-1"), Height: 3, Prove: true})
	if e != nil || q.Code != 0 {
		t.Fatal(e)
	}
	var actual federation.Task
	if e = json.Unmarshal(q.Value, &actual); e != nil {
		t.Fatal(e)
	}
	if actual.State != "kpi_expired" {
		t.Fatal("restart lost automatic expiry schedule")
	}
	if e = proof.VerifyQuery(*q, "task/T-1", r.AppHash, 3); e != nil {
		t.Fatal(e)
	}
}

func TestSDKCreditCapJournalProofAndAtomicReleaseAcrossRestart(t *testing.T) {
	lead, leadKey := testMember("accounting author")
	lead.Karma = 1000
	peer, peerKey := testMember("accounting peer")
	peer.Karma = 100
	guardian, guardianKey := testMember("accounting default")
	guardian.Karma = 100
	guardian.DefaultVerifier = true
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{lead, peer, guardian}})
	// Use a real-world epoch so the rolling-window predecessor lookup runs
	// through SDK ReverseIterator rather than the pre-epoch shortcut.
	offset := int64(0)
	block := func(t *testing.T, a *App, h int64, txs ...[]byte) *abci.ResponseFinalizeBlock {
		t.Helper()
		r, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: h, Time: time.Unix(1000000000+h+offset, 0).UTC(), Txs: txs})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = a.Commit(); err != nil {
			t.Fatal(err)
		}
		return r
	}
	seq := map[string]uint64{}
	h := int64(0)
	send := func(m federation.Member, key ed25519.PrivateKey, op string, p any) {
		t.Helper()
		h++
		r := block(t, a, h, testEnvelope(t, m, key, seq[m.ID], op, p))
		if r.TxResults[0].Code != 0 {
			t.Fatalf("%s: %s", op, r.TxResults[0].Log)
		}
		seq[m.ID]++
	}
	prior := federation.PriorArt{Basis: "No discoverable solution exists for this fictional isolated SDK question.", Searches: []string{"first fictional prior-art search", "second fictional prior-art search"}}
	digest := strings.Repeat("a", 64)
	send(lead, leadKey, "open_project", map[string]any{"id": "P-1", "title": "SDK accounting fixture", "class": "benevolent", "prior_art": prior})
	send(guardian, guardianKey, "allocate_budget", map[string]any{"project": "P-1", "credits": "20000", "evidence_digest": digest})
	for i := 0; i < 3; i++ {
		send(guardian, guardianKey, "unlock_budget", map[string]any{"project": "P-1", "evidence_digest": digest})
	}
	task := federation.Task{ID: "T-1", Project: "P-1", Title: "SDK accounting work fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 10001, CreditReward: "10001"}
	send(lead, leadKey, "open_task", task)
	send(lead, leadKey, "submit", map[string]any{"id": "RC-1", "task": "T-1", "evidence_digest": digest})
	check := map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	send(peer, peerKey, "verify", check)
	send(guardian, guardianKey, "verify", check)
	a, err := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	query := func(key string, height int64, hash []byte) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: height, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(q, err)
		}
		if err = proof.VerifyQuery(*q, key, hash, height); err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	h++
	r := block(t, a, h)
	raw := query("credit_owed/00000000000000000001", h, r.AppHash)
	var owed federation.CreditOwed
	if err = json.Unmarshal(raw, &owed); err != nil || owed.Remaining != "1" {
		t.Fatal(owed, err)
	}
	// Exercise a predecessor lookup in a persisted SDK cache after restart.
	task.ID = "T-2"
	task.KarmaReward = 100
	task.CreditReward = "100"
	send(lead, leadKey, "open_task", task)
	send(lead, leadKey, "submit", map[string]any{"id": "RC-2", "task": "T-2", "evidence_digest": digest})
	check["contribution"] = "RC-2"
	send(peer, peerKey, "verify", check)
	send(guardian, guardianKey, "verify", check)
	h++
	r = block(t, a, h)
	var entry federation.CreditEntry
	if err = json.Unmarshal(query("credit/00000000000000000004", h, r.AppHash), &entry); err != nil || entry.Minted != "0" || entry.Deferred != "100" {
		t.Fatal(entry, err)
	}
	// A duplicate release list must roll back its first attempted release.
	bad := map[string]any{"entries": []string{"00000000000000000001", "00000000000000000001"}, "evidence_digest": digest}
	h++
	r = block(t, a, h, testEnvelope(t, guardian, guardianKey, seq[guardian.ID], "release_deferred", bad))
	if r.TxResults[0].Code == 0 {
		t.Fatal("duplicate release committed")
	}
	if got := query("credit_owed/00000000000000000001", h, r.AppHash); !bytes.Equal(got, raw) {
		t.Fatal("failed release mutated deferral")
	}
	send(guardian, guardianKey, "release_deferred", map[string]any{"entries": []string{"00000000000000000001"}, "evidence_digest": digest})
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	if err = json.Unmarshal(query("credit_owed/00000000000000000001", h, r.AppHash), &owed); err != nil || owed.Remaining != "0" {
		t.Fatal("restart lost release", owed, err)
	}
	var m federation.Member
	if err = json.Unmarshal(query("member/"+lead.ID, h, r.AppHash), &m); err != nil || m.Credits != "10001" || m.Karma != 11101 {
		t.Fatal(m, err)
	}
	// Advance past the entire prior issuance window. The predecessor now
	// exists, so this checks reverse seek and subtraction through persisted KV.
	offset = 86400
	task.ID = "T-3"
	send(lead, leadKey, "open_task", task)
	send(lead, leadKey, "submit", map[string]any{"id": "RC-3", "task": "T-3", "evidence_digest": digest})
	check["contribution"] = "RC-3"
	send(peer, peerKey, "verify", check)
	send(guardian, guardianKey, "verify", check)
	h++
	r = block(t, a, h)
	if err = json.Unmarshal(query("member/"+lead.ID, h, r.AppHash), &m); err != nil || m.Credits != "10101" {
		t.Fatal("persisted window did not expire", m, err)
	}
}
