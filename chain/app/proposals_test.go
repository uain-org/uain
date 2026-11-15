package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"

	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKProspectiveProposalsSequenceRollbackAndFinalization(t *testing.T) {
	m, key := testMember("proposal-guardian")
	g := federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	a := initApp(t, dbm.NewMemDB(), g)
	activation := testEnvelope(t, m, key, 0, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": strings.Repeat("a", 64)})
	legacy, err := a.ProcessProposal(&abci.RequestProcessProposal{Height: 1, Time: time.Unix(1001, 0).UTC(), Txs: [][]byte{[]byte("malformed")}})
	if err != nil || legacy.Status != abci.ResponseProcessProposal_ACCEPT {
		t.Fatal("pre-activation proposal behavior changed", legacy, err)
	}
	if r := block(t, a, 1, activation); r.TxResults[0].Code != 0 {
		t.Fatal(r.TxResults[0])
	}
	first := testEnvelope(t, m, key, 1, "instance_create", map[string]any{"id": "proposal-one", "name": "One", "family": "fixture"})
	failed := testEnvelope(t, m, key, 2, "instance_create", map[string]any{"id": "proposal-one", "name": "Duplicate", "family": "fixture"})
	second := testEnvelope(t, m, key, 2, "instance_create", map[string]any{"id": "proposal-two", "name": "Two", "family": "fixture"})
	check, err := a.CheckTx(&abci.RequestCheckTx{Tx: first})
	if err != nil || check.Code != 0 {
		t.Fatal(check, err)
	}
	prepared, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: 2, Time: time.Unix(1002, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: [][]byte{first, first, failed, second}})
	if err != nil || len(prepared.Txs) != 2 || !bytes.Equal(prepared.Txs[0], first) || !bytes.Equal(prepared.Txs[1], second) {
		t.Fatal("preparation did not sequence valid commands or discard failed state", prepared, err)
	}
	process := func(txs [][]byte, h int64, want abci.ResponseProcessProposal_ProposalStatus) {
		t.Helper()
		r, e := a.ProcessProposal(&abci.RequestProcessProposal{Height: h, Time: time.Unix(1000+h, 0).UTC(), Txs: txs})
		if e != nil || r.Status != want {
			t.Fatal(r, e)
		}
	}
	process(prepared.Txs, 2, abci.ResponseProcessProposal_ACCEPT)
	process(prepared.Txs, 2, abci.ResponseProcessProposal_ACCEPT)
	process(append(append([][]byte{}, prepared.Txs...), second), 2, abci.ResponseProcessProposal_REJECT)
	process([][]byte{first}, 101, abci.ResponseProcessProposal_REJECT)
	for _, name := range []string{"proposal-one", "proposal-two"} {
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("instance/" + name), Height: 1})
		if e != nil || len(q.Value) != 0 {
			t.Fatal("proposal/check execution escaped to committed state", q, e)
		}
	}
	process(prepared.Txs, 2, abci.ResponseProcessProposal_ACCEPT)
	r := block(t, a, 2, prepared.Txs...)
	for _, tx := range r.TxResults {
		if tx.Code != 0 {
			t.Fatal("accepted proposal failed finalization", tx)
		}
	}
	gold := initApp(t, dbm.NewMemDB(), g)
	block(t, gold, 1, activation)
	block(t, gold, 2, first, second)
	if !bytes.Equal(a.LastCommitID().Hash, gold.LastCommitID().Hash) {
		t.Fatal("proposal simulation changed finalized application hash")
	}
	batch := [][]byte{}
	for i := 0; i < 21; i++ {
		batch = append(batch, testEnvelope(t, m, key, uint64(3+i), "instance_create", map[string]any{"id": fmt.Sprintf("batch-%02d", i), "name": "Batch", "family": "fixture"}))
	}
	prepared, err = a.PrepareProposal(&abci.RequestPrepareProposal{Height: 3, Time: time.Unix(1003, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: batch})
	if err != nil || len(prepared.Txs) != 20 {
		t.Fatal("proposal did not honor fixed transaction gas reservations", prepared, err)
	}
	process(batch, 3, abci.ResponseProcessProposal_REJECT)
	process(prepared.Txs, 3, abci.ResponseProcessProposal_ACCEPT)
	short, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: 3, Time: time.Unix(1003, 0).UTC(), MaxTxBytes: int64(cmttypes.ComputeProtoSizeForTxs([]cmttypes.Tx{batch[0]}) - 1), Txs: batch[:1]})
	if err != nil || len(short.Txs) != 0 {
		t.Fatal("proposal byte reservation ignored protobuf framing", short, err)
	}
	// Undecodable candidates no longer burn the inclusion bound (crowd-out,
	// audit 9 November 2026); only the overall scan bound stops the proposer.
	candidates := make([][]byte, ProposalCandidates+1)
	for i := 0; i < ProposalCandidates; i++ {
		candidates[i] = []byte("malformed")
	}
	candidates[ProposalCandidates] = batch[0]
	bounded, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: 3, Time: time.Unix(1003, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: candidates})
	if err != nil || len(bounded.Txs) != 1 {
		t.Fatal("malformed candidates crowded out a valid command", bounded, err)
	}
	scanned := make([][]byte, ProposalExamined+1)
	for i := 0; i < ProposalExamined; i++ {
		scanned[i] = []byte("malformed")
	}
	scanned[ProposalExamined] = batch[0]
	bounded, err = a.PrepareProposal(&abci.RequestPrepareProposal{Height: 3, Time: time.Unix(1003, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: scanned})
	if err != nil || len(bounded.Txs) != 0 {
		t.Fatal("proposal exceeded its candidate scan bound", bounded, err)
	}
	process([][]byte{[]byte("malformed")}, 3, abci.ResponseProcessProposal_REJECT)
	for _, tx := range block(t, a, 3, prepared.Txs...).TxResults {
		if tx.Code != 0 {
			t.Fatal("sequential batch failed finalization", tx)
		}
	}
}

func TestSDKProposalSeesExpiryReservationBeforeTransactions(t *testing.T) {
	m, key := testMember("expiry-proposal-guardian")
	m.Karma, m.Creator = 1000, true
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}})
	digest := strings.Repeat("a", 64)
	prior := federation.PriorArt{Basis: "No discoverable solution exists for this fictional isolated expiry question.", Searches: []string{"fictional expiry prior-art search", "second fictional expiry prior-art search"}}
	inputs := [][]byte{
		testEnvelope(t, m, key, 0, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}),
		testEnvelope(t, m, key, 1, "open_project", map[string]any{"id": "expiry-project", "title": "Expiry proposal fixture", "class": "benevolent", "prior_art": prior}),
		testEnvelope(t, m, key, 2, "allocate_budget", map[string]any{"project": "expiry-project", "credits": "200", "evidence_digest": digest}),
	}
	due := time.Unix(1010, 0).UTC()
	task := federation.Task{ID: "expiry-old", Project: "expiry-project", Title: "Expiring future fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 40), Kind: "future", KarmaReward: 100, CreditReward: "100", KPI: &federation.KPI{Statement: "The fictional milestone occurs and is published.", Metric: "milestone", Source: "NCT12345678", Comparator: "occurs", ResolvesBy: due.Format(time.RFC3339)}}
	inputs = append(inputs, testEnvelope(t, m, key, 3, "open_task", task))
	for i, tx := range inputs {
		if r := block(t, a, int64(i+1), tx); r.TxResults[0].Code != 0 {
			t.Fatal(r.TxResults[0])
		}
	}
	query := func(k string, h int64) abci.ResponseQuery {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(k), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(q, err)
		}
		return *q
	}
	before := query("project/expiry-project", 4)
	var project federation.Project
	if err := json.Unmarshal(before.Value, &project); err != nil || project.Accounting.Reserved != "100" {
		t.Fatal(project, err)
	}
	task.ID, task.Title, task.Kind, task.KPI = "expiry-new", "Reuse released reservation", "instant", nil
	tx := testEnvelope(t, m, key, 4, "open_task", task)
	now := due.Add(federation.KPIGrace)
	prepared, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: 5, Time: now, MaxTxBytes: int64(ProposalBytes), Txs: [][]byte{tx}})
	if err != nil || len(prepared.Txs) != 1 {
		t.Fatal("proposal did not see BeginBlock's reservation release", prepared, err)
	}
	processed, err := a.ProcessProposal(&abci.RequestProcessProposal{Height: 5, Time: now, Txs: prepared.Txs})
	if err != nil || processed.Status != abci.ResponseProcessProposal_ACCEPT {
		t.Fatal(processed, err)
	}
	if after := query("project/expiry-project", 4); !bytes.Equal(before.Value, after.Value) {
		t.Fatal("proposal committed its expiry/replacement reservation")
	}
	r, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 5, Time: now, Txs: prepared.Txs})
	if err != nil || r.TxResults[0].Code != 0 {
		t.Fatal(r, err)
	}
	if _, err = a.Commit(); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{"task/expiry-old": "kpi_expired", "task/expiry-new": "open"} {
		q := query(k, 5)
		if err = proof.VerifyQuery(q, k, r.AppHash, 5); err != nil {
			t.Fatal(err)
		}
		var state federation.Task
		if err = json.Unmarshal(q.Value, &state); err != nil || state.State != want {
			t.Fatal(state, err)
		}
	}
	q := query("project/expiry-project", 5)
	if err = json.Unmarshal(q.Value, &project); err != nil || project.Accounting.Reserved != "100" {
		t.Fatal("expiry/replacement failed to conserve the reservation", project, err)
	}
}
