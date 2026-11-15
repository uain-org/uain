package app

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"

	"github.com/uain-org/uain/chain/federation"
)

// Before central-task-states-v1 is activated, each new operation fails through the
// real ABCI path with exactly the gas of an unknown operation of the same length,
// so a replayed history cannot tell this binary from 0.4.1.
func TestCentralTaskStatesOperationsCostExactlyAnUnknownOperationBeforeActivation(t *testing.T) {
	m, key := testMember("states-guardian")
	g := federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	a := initApp(t, dbm.NewMemDB(), g)
	payload := map[string]any{"task": "CT-1"}
	h := int64(0)
	for _, op := range []string{"central_task_states_configure", "central_contest_select", "central_contest_settle", "central_condition_resolve", "central_condition_expire"} {
		unknown := "x" + strings.Repeat("y", len(op)-1)
		h++
		got := block(t, a, h, testEnvelope(t, m, key, 0, op, payload))
		h++
		want := block(t, a, h, testEnvelope(t, m, key, 0, unknown, payload))
		if got.TxResults[0].Code == 0 || want.TxResults[0].Code == 0 {
			t.Fatalf("%s or its unknown twin succeeded", op)
		}
		if got.TxResults[0].GasUsed != want.TxResults[0].GasUsed || got.TxResults[0].Code != want.TxResults[0].Code {
			t.Fatalf("%s gas %d code %d, unknown operation gas %d code %d", op, got.TxResults[0].GasUsed, got.TxResults[0].Code, want.TxResults[0].GasUsed, want.TxResults[0].Code)
		}
	}
}

// The 0.4.2 plan name is registered, runs once at its height on the new binary and
// changes no rule; a 0.4.1 binary (no handler) halts at that height instead.
func TestCentralTaskStatesUpgradeHandlerRunsOnceAndLeavesRulesInert(t *testing.T) {
	if _, ok := RegisteredUpgrades()[CentralTaskStatesUpgrade]; !ok {
		t.Fatal("0.4.2 handler not registered")
	}
	m, key := testMember("upgrade-guardian")
	g := federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	db := dbm.NewMemDB()
	// The 0.4.1 binary carries no handlers.
	old, err := New(log.NewLogger(io.Discard), db, "sdk-test-1", WithUpgradeHandlers(map[string]UpgradeHandler{}))
	if err != nil {
		t.Fatal(err)
	}
	genesis, err := json.Marshal(g)
	if err != nil {
		t.Fatal(err)
	}
	cp := cmttypes.DefaultConsensusParams().ToProto()
	cp.Block.MaxGas = 60000000
	if _, err = old.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), AppStateBytes: genesis, ConsensusParams: &cp}); err != nil {
		t.Fatal(err)
	}
	activate := testEnvelope(t, m, key, 0, "activate_consensus_v2", map[string]any{"policy": federation.ConsensusV2Policy, "evidence_digest": strings.Repeat("a", 64)})
	plan := testEnvelope(t, m, key, 1, "upgrade_schedule", map[string]any{"name": CentralTaskStatesUpgrade, "height": "4", "evidence_digest": strings.Repeat("a", 64)})
	if r := block(t, old, 1, activate, plan); r.TxResults[0].Code != 0 || r.TxResults[1].Code != 0 {
		t.Fatal(r.TxResults)
	}
	block(t, old, 2)
	block(t, old, 3)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("0.4.1 binary did not halt at the 0.4.2 plan height")
			}
		}()
		if _, err := old.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 4, Time: time.Unix(1004, 0).UTC()}); err != nil {
			panic(err)
		}
	}()
	next, err := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	block(t, next, 4)
	r := block(t, next, 5, testEnvelope(t, m, key, 2, "central_contest_settle", map[string]any{"task": "CT-1"}))
	if r.TxResults[0].Code == 0 {
		t.Fatal("new rule active without the guardian activation")
	}
	q, _ := next.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("upgrade_done/" + CentralTaskStatesUpgrade), Height: 5})
	if string(q.Value) != "4" {
		t.Fatal("completion not recorded", string(q.Value))
	}
	q, _ = next.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("central_task_states_activation"), Height: 5})
	if len(q.Value) != 0 {
		t.Fatal("upgrade wrote the activation marker")
	}
}
