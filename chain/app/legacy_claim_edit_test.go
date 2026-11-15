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

func TestSDKLegacyClaimSynthesisAndEditProofRestart(t *testing.T) {
	member, key := testMember("original claim author")
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{member.ID}, Members: []federation.Member{member}})
	s := a.NewContext(false).KVStore(a.Key)
	set := func(key string, v any) {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		s.Set([]byte(key), raw)
	}
	set("storage_activation", federation.MembershipActivation{Policy: federation.CompactStatePolicy, EffectiveHeight: 2, ApprovedBy: member.ID, EvidenceDigest: strings.Repeat("a", 64)})
	set("legacy_import", federation.LegacyImportState{Status: "ready"})
	set("instance/author", federation.Instance{ID: "author", Member: member.ID, State: "active", Name: "Original author", Credits: "0"})
	set("legacy/actor/author", federation.LegacyActor{ID: "author", Member: member.ID, Projects: []string{"project"}})
	set("legacy/project/project", map[string]any{"id": "project", "state": "active", "lead": "author"})
	sources := []string{}
	for i := 0; i < 32; i++ {
		id := fmt.Sprintf("result-%090d", i)
		sources = append(sources, id)
		checks := []federation.LegacyCheck{}
		for j := 0; j < 32; j++ {
			checks = append(checks, federation.LegacyCheck{ID: fmt.Sprint(j), Verifier: "author", Member: member.ID, Verdict: "confirmed", Evidence: strings.Repeat("a", 64)})
		}
		set("legacy/work/"+id, federation.LegacyWork{ID: id, Project: "project", Task: "task", Author: "author", Member: member.ID, State: "settled", Paid: true, Statement: strings.Repeat("<", 4000), Checks: checks})
		set("legacy_work_status/"+id, federation.LegacyWorkStatus{ID: id, Project: "project", Task: "task", Member: member.ID, State: "settled", Paid: true})
	}
	set("legacy/task/task", federation.LegacyTask{ID: "task", Project: "project", State: "open", Contributions: sources})
	ids := []string{}
	for i := 0; i < 127; i++ {
		ids = append(ids, fmt.Sprintf("CL-native-%020d", 100+i))
	}
	set("legacy_project_claims/project", ids)
	block(t, a, 1)
	p := map[string]any{"project": "project", "author": "author", "statement": strings.Repeat("<", 1998), "sources": sources, "reason": strings.Repeat("<", 2000), "evidence_digest": strings.Repeat("a", 64)}
	result := block(t, a, 2, testEnvelope(t, member, key, 0, "legacy_claim_assert", p))
	tx := result.TxResults[0]
	if tx.Code != 0 {
		t.Fatal(tx.Log, tx.GasUsed)
	}
	t.Logf("max32 sources/full128 project index claim assertion SDK gas=%d", tx.GasUsed)
	query := func(key string) []byte {
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: 2, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(e, q)
		}
		if e = proof.VerifyQuery(*q, key, result.AppHash, 2); e != nil {
			t.Fatal(e)
		}
		return bytes.Clone(q.Value)
	}
	raw := query("legacy_project_claims/project")
	if e := json.Unmarshal(raw, &ids); e != nil || len(ids) != 128 {
		t.Fatal(ids, e)
	}
	var claim federation.LegacyClaim
	if e := json.Unmarshal(query("legacy_claim/"+ids[127]), &claim); e != nil {
		t.Fatal(e)
	}
	evidence := query("legacy_claim_revision/" + claim.Revisions[0].ID)
	a, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(evidence, query("legacy_claim_revision/"+claim.Revisions[0].ID)) {
		t.Fatal("proposal evidence changed after restart")
	}
	result = block(t, a, 3, testEnvelope(t, member, key, 1, "legacy_claim_assert", p))
	if result.TxResults[0].Code == 0 {
		t.Fatal("project claim bound ignored")
	}
}
