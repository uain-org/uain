package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKLegacyBudgetMaximumTasksAndCriterionProofRestart(t *testing.T) {
	member, key := testMember("original budget guardian and lead")
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{member.ID}, Members: []federation.Member{member}})
	s := a.NewContext(false).KVStore(a.Key)
	set := func(k string, v any) {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		s.Set([]byte(k), raw)
	}
	evidence := strings.Repeat("a", 64)
	set("storage_activation", federation.MembershipActivation{Policy: federation.CompactStatePolicy, EffectiveHeight: 2, ApprovedBy: member.ID, EvidenceDigest: evidence})
	set("legacy_import", federation.LegacyImportState{Status: "ready"})
	set("legacy/policy", map[string]any{"version": 1, "daily_credit_cap": "10000", "bootstrap_operators": 3, "issuance_total": "0"})
	set("instance/author", federation.Instance{ID: "author", Member: member.ID, State: "active", Credits: "0"})
	set("legacy/actor/author", federation.LegacyActor{ID: "author", Member: member.ID, Projects: []string{"project"}})
	ids := []string{}
	for i := 0; i < 128; i++ {
		id := fmt.Sprintf("budget-task-%080d", i)
		ids = append(ids, id)
		price := int64(20)
		var ptr *int64 = &price
		if i == 127 {
			ptr = nil
		}
		kpi, _ := json.Marshal(map[string]any{"statement": strings.Repeat("<", 2000), "metric": strings.Repeat("<", 100), "source": "https://example.org/" + strings.Repeat("<", 1800), "comparator": "occurs"})
		task := federation.LegacyTask{ID: id, Project: "project", State: "open", Kind: "future", Price: ptr, Creator: "author", KPI: kpi}
		set("legacy_task/"+id, task)
		set("legacy_task_budget/"+id, map[string]any{"id": id, "project": "project", "state": "open", "price": ptr, "winner": ""})
	}
	other := []string{}
	for i := 0; i < 128; i++ {
		other = append(other, fmt.Sprintf("original-census-%080d", i))
	}
	set("legacy/project/project", map[string]any{"id": "project", "state": "active", "lead": "author", "task_ids": ids, "claim_ids": other, "participant_ids": other, "work_ids": other, "budget_status": "allocated", "budget_total": 10000000, "budget_stage": 3, "budget_unlocked": 10000000})
	block(t, a, 1)
	h := int64(1)
	seq := uint64(0)
	var result *abci.ResponseFinalizeBlock
	send := func(op string, p any) {
		t.Helper()
		h++
		result = block(t, a, h, testEnvelope(t, member, key, seq, op, p))
		tx := result.TxResults[0]
		if tx.Code != 0 {
			t.Fatal(op, tx.Log, tx.GasUsed)
		}
		seq++
		t.Logf("max128 original task budget %s gas=%d", op, tx.GasUsed)
	}
	send("legacy_budget_allocate", map[string]any{"project": "project", "amount": 20000000, "basis": strings.Repeat("<", 4000), "evidence_digest": evidence})
	send("legacy_task_price", map[string]any{"task": ids[127], "actor": "author", "karma": 20, "evidence_digest": evidence})
	send("legacy_project_done_when", map[string]any{"project": "project", "actor": "author", "done_when": strings.Repeat("<", 4000), "evidence_digest": evidence})
	query := func(k string) []byte {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(k), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(e, q)
		}
		if e = proof.VerifyQuery(*q, k, result.AppHash, h); e != nil {
			t.Fatal(e)
		}
		return bytes.Clone(q.Value)
	}
	raw := query("legacy_project_criteria/project")
	var criteria struct {
		Event string `json:"event"`
	}
	if e := json.Unmarshal(raw, &criteria); e != nil {
		t.Fatal(e)
	}
	immutable := query("legacy_project_criteria_revision/" + criteria.Event)
	compact := query("legacy_task_budget/" + ids[127])
	var budget struct {
		Price *int64 `json:"price"`
	}
	if e := json.Unmarshal(compact, &budget); e != nil || budget.Price == nil || *budget.Price != 20 {
		t.Fatal(string(compact), e)
	}
	var e error
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(immutable, query("legacy_project_criteria_revision/"+criteria.Event)) {
		t.Fatal("criterion changed after restart")
	}
	send("legacy_budget_allocate", map[string]any{"project": "project", "amount": 2560, "evidence_digest": evidence})
}
