//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"cosmossdk.io/log/v2"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"github.com/uain-org/uain/chain/proof"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSDKPrivateProofGasReplayPersistenceAndCommitment(t *testing.T) {
	dir := os.Getenv("UAIN_PUBLIC_FIXTURE_DIR")
	if dir == "" {
		t.Fatal("real public Orchard fixtures required")
	}
	read := func(name string) []byte {
		b, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	decode := func(name string) []byte {
		b, e := hex.DecodeString(string(read(name)))
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	pub := decode("reviewer-public-key.hex")
	reviewer := federation.Member{ID: federation.Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: "private fixture reviewer", Operator: "private review", Family: "review", Licence: "active", Karma: 100, Credits: "0"}
	guardian, _ := privateStateFixtureMember("private fixture guardian", 5)
	relay, key := privateStateFixtureMember("separate private relay", 7)
	receiverMember, _ := privateStateFixtureMember("private fixture receiver", 6)
	approval := federation.PrivateApproval{Reviewer: reviewer.ID, Effects: string(read("payment-effects.hex")), PurposeCommitment: strings.Repeat("09", 32), Class: "neutral", ExpiresHeight: 400, Signature: base64.RawURLEncoding.EncodeToString(decode("approval-signature.hex"))}
	wire := read("payment.bin")
	deposit := read("deposit.bin")
	var leaves [2][32]byte
	for i := 0; i < 2; i++ {
		copy(leaves[i][:], deposit[45+i*884+96:45+i*884+128])
	}
	frontier := federation.PrivateFrontier{Count: 2}
	frontier.Nodes[0] = hex.EncodeToString(leaves[0][:])
	node, e := shield.Combine(0, leaves[0], leaves[1])
	if e != nil {
		t.Fatal(e)
	}
	for level := uint8(1); level < 32; level++ {
		frontier.Nodes[level] = hex.EncodeToString(node[:])
		empty, err := shield.Empty(level)
		if err != nil {
			t.Fatal(err)
		}
		node, e = shield.Combine(level, node, empty)
		if e != nil {
			t.Fatal(e)
		}
	}
	frontier.Root = hex.EncodeToString(node[:])
	if frontier.Root != string(read("deposit-anchor.hex")) {
		t.Fatal("fixture tree root disagrees with Orchard witness")
	}
	db := dbm.NewMemDB()
	a, e := New(log.NewLogger(io.Discard), db, "uain-test-1")
	if e != nil {
		t.Fatal(e)
	}
	g := federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{guardian, relay, reviewer, receiverMember}}
	// Test-only issuance fixture writes through the SDK's initial finalize context.
	// No live transaction accepts arbitrary roots or invented balances.
	cp := cmttypes.DefaultConsensusParams().ToProto()
	cp.Block.MaxGas = 60000000
	genesis, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	if _, e = a.InitChain(&abci.RequestInitChain{ChainId: "uain-test-1", InitialHeight: 1, Time: time.Unix(1000, 0), AppStateBytes: genesis, ConsensusParams: &cp}); e != nil {
		t.Fatal(e)
	}
	ctx := a.NewContext(false)
	s := ctx.KVStore(a.Key)
	set := func(k string, v any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		s.Set([]byte(k), b)
	}
	set("storage_activation", map[string]any{"policy": federation.CompactStatePolicy, "effective_height": "2", "approved_by": guardian.ID, "evidence_digest": strings.Repeat("a", 64)})
	set("private_activation", federation.PrivateActivation{Policy: federation.PrivateExchangePolicy, Height: 1, EvidenceDigest: strings.Repeat("a", 64), Relayer: relay.ID})
	set("private_reviewer/"+reviewer.ID, map[string]any{"active": true, "evidence_digest": strings.Repeat("a", 64)})
	set("private_licence_revision", map[string]any{"value": "0"})
	for i, leaf := range leaves {
		set(fmt.Sprintf("private_note/%010d", i), hex.EncodeToString(leaf[:]))
	}
	set("private_frontier", frontier)
	set("private_root/"+frontier.Root, 1)
	envelope := func(seq uint64) []byte {
		payload, _ := json.Marshal(federation.PrivatePayment{Bundle: base64.RawURLEncoding.EncodeToString(wire), Approval: approval})
		c := federation.Command{Version: 1, ChainID: "uain-test-1", Member: relay.ID, Sequence: seq, ExpiresHeight: 100, Operation: "private_payment", Payload: payload}
		b, err := federation.SigningBytes(c)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(federation.Envelope{Command: c, PublicKey: relay.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, b))})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	block(t, a, 1)
	r := block(t, a, 2, envelope(0))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	if r.TxResults[0].GasUsed < 1500000 || r.TxResults[0].GasUsed >= 3000000 {
		t.Fatal("missing cryptography metering or gas overflow", r.TxResults[0].GasUsed)
	}
	t.Logf("private payment gas %d", r.TxResults[0].GasUsed)
	record := "private_payment/" + approval.Effects
	query := func(h int64) []byte {
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(q, err)
		}
		if err = proof.VerifyQuery(*q, record, r.AppHash, h); err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	before := query(2)
	r = block(t, a, 3, envelope(1))
	if r.TxResults[0].Code == 0 {
		t.Fatal("same notes spent again with fresh relay sequence")
	}
	if !bytes.Equal(before, query(3)) {
		t.Fatal("rejected spend changed payment")
	}
	a, e = New(log.NewLogger(io.Discard), db, "uain-test-1")
	if e != nil {
		t.Fatal(e)
	}
	r = block(t, a, 4)
	if !bytes.Equal(before, query(4)) {
		t.Fatal("restart lost private payment")
	}
	r = block(t, a, 5, envelope(1))
	if r.TxResults[0].Code == 0 {
		t.Fatal("restart forgot private nullifiers")
	}
	assertVerifiedPrivateState(t, a, r.AppHash, 5, reviewer.ID, relay.ID, guardian.ID, receiverMember.ID, approval.Effects, key)
}
