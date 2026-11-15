package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestInstanceProofRestartAndSharedLicence(t *testing.T) {
	m, key := testMember("guardian")
	other, otherKey := testMember("other")
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{m.ID, other.ID}, Members: []federation.Member{m, other}})
	create := testEnvelope(t, m, key, 0, "instance_create", map[string]any{"id": "fixture-1", "name": "Fixture instance", "family": "fixture-family"})
	r := block(t, a, 1, create)
	if r.TxResults[0].Code != 0 {
		t.Fatalf("create failed: %+v", r.TxResults)
	}
	// A different signed member cannot use a profile it does not own.
	imposter := testEnvelope(t, other, otherKey, 0, "withdraw", map[string]any{}, "fixture-1")
	withdraw := testEnvelope(t, m, key, 1, "withdraw", map[string]any{}, "fixture-1")
	r = block(t, a, 2, imposter, withdraw)
	if r.TxResults[0].Code == 0 || r.TxResults[1].Code != 0 {
		t.Fatalf("bad attribution validation: %+v", r.TxResults)
	}
	q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("instance/fixture-1"), Height: 2, Prove: true})
	if err != nil || q.Code != 0 {
		t.Fatalf("instance query: %+v %v", q, err)
	}
	if err = proof.VerifyQuery(*q, "instance/fixture-1", r.AppHash, 2); err != nil {
		t.Fatal(err)
	}
	var instance federation.Instance
	if err = json.Unmarshal(q.Value, &instance); err != nil {
		t.Fatal(err)
	}
	if instance.Member != m.ID || instance.Credits != "0" || instance.Karma != 0 {
		t.Fatalf("instance injected standing: %+v", instance)
	}
	event, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("event/00000000000000000002"), Height: 2, Prove: true})
	if err != nil || event.Code != 0 {
		t.Fatal("event missing")
	}
	if err = proof.VerifyQuery(*event, "event/00000000000000000002", r.AppHash, 2); err != nil {
		t.Fatal(err)
	}
	var attribution federation.Event
	_ = json.Unmarshal(event.Value, &attribution)
	if attribution.Instance != "fixture-1" || attribution.Member != m.ID {
		t.Fatal("event lost attribution")
	}
	restarted, err := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	after, err := restarted.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("instance/fixture-1"), Height: 2, Prove: true})
	if err != nil || !bytes.Equal(after.Value, q.Value) {
		t.Fatal("restart changed instance")
	}
	if err = proof.VerifyQuery(*after, "instance/fixture-1", r.AppHash, 2); err != nil {
		t.Fatal(err)
	}
	r = block(t, restarted, 3, testEnvelope(t, m, key, 2, "instance_create", map[string]any{"id": "bypass", "name": "Bypass licence"}))
	if r.TxResults[0].Code == 0 {
		t.Fatal("member withdrawal did not gate instances")
	}
}
