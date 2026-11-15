package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKOperatorObservationProofRollbackAndRestart(t *testing.T) {
	member, key := testMember("operator fixture")
	guardian, guardianKey := testMember("DNS observer fixture")
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{member, guardian}})
	r := block(t, a, 1, testEnvelope(t, member, key, 0, "identity_claim", map[string]any{}))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	r = block(t, a, 2, testEnvelope(t, member, key, 1, "operator_claim", map[string]any{"domain": "example.org"}))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	query := func(record string, h int64, hash []byte) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatalf("query %s: %+v %v", record, q, err)
		}
		if err = proof.VerifyQuery(*q, record, hash, h); err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	var claim federation.OperatorClaim
	claimKey := "operator_claim/" + member.ID + "/"
	if err := json.Unmarshal(query(claimKey, 2, r.AppHash), &claim); err != nil {
		t.Fatal(err)
	}
	aliasKey := "actor_identity/" + member.ID + "/"
	alias := query(aliasKey, 2, r.AppHash)
	before := query("member/"+guardian.ID, 2, r.AppHash)
	payload := map[string]any{"member": member.ID, "domain": claim.Domain, "claim_event_id": "2", "txt": "wrong-DID", "checked_at": time.Unix(1003, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": strings.Repeat("a", 64)}
	r = block(t, a, 3, testEnvelope(t, guardian, guardianKey, 0, "operator_attest", payload))
	if r.TxResults[0].Code == 0 {
		t.Fatal("wrong operator DID attestation accepted")
	}
	if !bytes.Equal(before, query("member/"+guardian.ID, 3, r.AppHash)) {
		t.Fatal("failed DNS observation consumed observer sequence")
	}
	payload["txt"] = "uain-operator=" + claim.DID
	r = block(t, a, 4, testEnvelope(t, guardian, guardianKey, 0, "operator_attest", payload))
	if r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0].Log)
	}
	proofKey := "operator_proof/" + member.ID + "/"
	confirmed := query(proofKey, 4, r.AppHash)
	var observation federation.OperatorProof
	if err := json.Unmarshal(confirmed, &observation); err != nil || observation.Observer != guardian.ID || observation.Trust != "guardian-dns-observation" || observation.DID != claim.DID {
		t.Fatal("signed observer provenance lost", observation, err)
	}
	a, err := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	r = block(t, a, 5)
	if !bytes.Equal(confirmed, query(proofKey, 5, r.AppHash)) || !bytes.Equal(alias, query(aliasKey, 5, r.AppHash)) {
		t.Fatal("restart lost bound identity or operator observation")
	}
}
