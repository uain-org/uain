package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKLegacyFutureTaskHoldResolveAndClaimEvidenceRestart(t *testing.T) {
	members := []federation.Member{}
	keys := []ed25519.PrivateKey{}
	for _, name := range []string{"future author", "future peer", "future default"} {
		m, key := testMember(name)
		m.Karma = 1000
		members = append(members, m)
		keys = append(keys, key)
	}
	members[2].DefaultVerifier = true
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{members[2].ID}, Members: members})
	s := a.NewContext(false).KVStore(a.Key)
	set := func(key string, v any) {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		s.Set([]byte(key), raw)
	}
	evidence := strings.Repeat("a", 64)
	set("storage_activation", federation.MembershipActivation{Policy: federation.CompactStatePolicy, EffectiveHeight: 2, ApprovedBy: members[2].ID, EvidenceDigest: evidence})
	set("legacy_import", federation.LegacyImportState{Status: "ready"})
	actors := []string{"original-author", "original-peer", "original-default"}
	for i, id := range actors {
		set("instance/"+id, federation.Instance{ID: id, Member: members[i].ID, Name: members[i].Name, Family: members[i].Family, State: "active", Credits: "0"})
		set("legacy/actor/"+id, federation.LegacyActor{ID: id, Member: members[i].ID, Operator: members[i].Operator, Family: members[i].Family, Default: i == 2, Arbiter: i == 2, Projects: []string{"project"}})
	}
	set("legacy/project/project", map[string]any{"id": "project", "state": "active", "lead": actors[0], "task_ids": []string{}, "claim_ids": []string{}, "participant_ids": actors, "budget_status": "proposed"})
	h := int64(1)
	block(t, a, h)
	seq := []uint64{0, 0, 0}
	var result *abci.ResponseFinalizeBlock
	send := func(i int, op string, p any, ok bool) {
		t.Helper()
		h++
		raw := testEnvelope(t, members[i], keys[i], seq[i], op, p)
		result = block(t, a, h, raw)
		tx := result.TxResults[0]
		if (tx.Code == 0) != ok {
			t.Fatal(op, tx.Code, tx.Log, tx.GasUsed)
		}
		if ok {
			seq[i]++
			if tx.GasUsed >= int64(TransactionGas) {
				t.Fatal(op, tx.GasUsed)
			}
			t.Logf("legacy future %s gas=%d", op, tx.GasUsed)
		}
	}
	p := map[string]any{"id": "future", "project": "project", "author": actors[0], "title": "Precisely observable future outcome", "question": "Does the future public event meet the exact specified measurable criterion?", "done_when": "The public record documents the measurable event.", "how_to_check": "Independently inspect the public record against the exact specified criterion.", "prior_art": map[string]any{"statement": "No discoverable open source already resolves this specific future event.", "searched": []string{"Dated public literature search.", "Dated public registry search."}}, "benevolence": map[string]any{"class": "neutral", "statement": "The public research result causes no identifiable harm."}, "verification": map[string]any{"criteria": "Independently inspect the exact public record against the specified research question.", "method": "inspect"}, "kind": "future", "kpi": map[string]any{"statement": "The public record documents this future event.", "metric": "event", "comparator": "occurs", "source": "https://example.org/public", "resolves_by": "1970-01-03"}, "evidence_digest": evidence}
	send(0, "legacy_task_open", p, true)
	submit := map[string]any{"id": "result", "task": "future", "author": actors[0], "title": "A novel bounded future finding", "detail": "The independently checkable original research result is documented here.", "claim": "The public event will satisfy the precisely stated future criterion.", "karma_claimed": 20, "evidence_digest": evidence}
	send(0, "legacy_submit", submit, true)
	for _, i := range []int{1, 2} {
		send(i, "legacy_check", map[string]any{"contribution": "result", "verifier": actors[i], "verdict": "confirmed", "novelty": "new", "evidence_digest": evidence}, true)
	}
	query := func(key string) []byte {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(e, q)
		}
		if len(q.Value) == 0 {
			if q.Height != h || !bytes.Equal(q.Key, []byte(key)) || q.ProofOps == nil {
				t.Fatal("missing absence proof", q)
			}
			e = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, result.AppHash, "/federation/"+url.PathEscape(key))
		} else {
			e = proof.VerifyQuery(*q, key, result.AppHash, h)
		}
		if e != nil {
			t.Fatal(e)
		}
		return bytes.Clone(q.Value)
	}
	var work federation.LegacyWork
	if e := json.Unmarshal(query("legacy_work/result"), &work); e != nil || work.Pending != "kpi" || work.Paid {
		t.Fatal(work, e)
	}
	old := query("legacy/work/result") // authenticated absence: new work has no rewritten SQL row.
	if len(old) > 0 {
		t.Fatal("new work fabricated original row")
	}
	send(2, "legacy_kpi_resolve", map[string]any{"task": "future", "resolver": actors[2], "observed": true, "source": "https://example.org/result", "note": "The independently recorded public event occurred as specified.", "evidence_digest": evidence}, true)
	if e := json.Unmarshal(query("legacy_work/result"), &work); e != nil || !work.Paid || work.Pending != "" {
		t.Fatal(work, e)
	}
	state := query("legacy_kpi_resolution/future")
	var member federation.Member
	if e := json.Unmarshal(query("member/"+members[0].ID), &member); e != nil || member.Credits != "20" {
		t.Fatal(member, e)
	}
	a, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(state, query("legacy_kpi_resolution/future")) {
		t.Fatal("resolution changed after persisted restart")
	}
	send(2, "legacy_settle", map[string]any{"contribution": "result", "evidence_digest": evidence}, false)
}

func TestSDKLegacyFutureMaximumHoldsFinalizeAndApplyBelowGas(t *testing.T) {
	members := []federation.Member{}
	keys := []ed25519.PrivateKey{}
	for _, name := range []string{"maximum author", "maximum peer", "maximum default"} {
		m, key := testMember(name)
		m.Karma = 1000
		members = append(members, m)
		keys = append(keys, key)
	}
	members[2].DefaultVerifier = true
	for i := 0; i < 32; i++ {
		m, _ := testMember(fmt.Sprintf("maximum verifier %d", i))
		m.Karma = 1000
		members = append(members, m)
	}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{members[2].ID}, Members: members})
	s := a.NewContext(false).KVStore(a.Key)
	set := func(key string, v any) {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		s.Set([]byte(key), raw)
	}
	evidence := strings.Repeat("a", 64)
	actors := []string{"maximum-author", "maximum-peer", "maximum-default"}
	set("storage_activation", federation.MembershipActivation{Policy: federation.CompactStatePolicy, EffectiveHeight: 2, ApprovedBy: members[2].ID, EvidenceDigest: evidence})
	set("legacy_import", federation.LegacyImportState{Status: "ready"})
	for i, id := range actors {
		set("instance/"+id, federation.Instance{ID: id, Member: members[i].ID, Name: members[i].Name, Family: members[i].Family, State: "active", Credits: "0"})
		set("legacy/actor/"+id, federation.LegacyActor{ID: id, Member: members[i].ID, Operator: members[i].Operator, Family: members[i].Family, Default: i == 2, Arbiter: i == 2, Projects: []string{"project"}})
	}
	set("legacy/project/project", map[string]any{"id": "project", "state": "active", "lead": actors[0], "task_ids": []string{"future"}, "claim_ids": []string{}, "participant_ids": actors})
	ids := []string{}
	checks := []federation.LegacyCheck{}
	refs := []string{}
	for i := 0; i < 32; i++ {
		id := fmt.Sprintf("check-%020d", i)
		refs = append(refs, id)
		verifier := fmt.Sprintf("maximum-verifier-%020d", i)
		set("instance/"+verifier, federation.Instance{ID: verifier, Member: members[i+3].ID, Name: members[i+3].Name, State: "active", Credits: "0"})
		checks = append(checks, federation.LegacyCheck{ID: id, Verifier: verifier, Member: members[i+3].ID, Verdict: "confirmed", Novelty: "new", Evidence: evidence})
	}
	for i := 0; i < 128; i++ {
		id := fmt.Sprintf("maximum-work-%020d", i)
		ids = append(ids, id)
		w := federation.LegacyWork{ID: id, Project: "project", Task: "future", Author: actors[0], Member: members[0].ID, Kind: "work", State: "settled", Claimed: 1000, Required: 2, Pending: "kpi", Held: &federation.LegacyHeld{Credibility: 1000, Credits: 1000, CheckRefs: refs}, Checks: checks}
		set("legacy_work/"+id, w)
		set("legacy_work_status/"+id, map[string]any{"id": id, "project": w.Project, "task": w.Task, "member": w.Member, "kind": "work", "state": w.State, "pending": w.Pending, "paid": false})
	}
	set("legacy_task/future", federation.LegacyTask{ID: "future", Project: "project", State: "open", Kind: "future", Creator: actors[0], Contributions: ids, KPI: json.RawMessage(`{"comparator":"occurs"}`), Resolves: "1970-01-03T00:00:00Z"})
	set("legacy_task/challenge-task", federation.LegacyTask{ID: "challenge-task", Project: "project", State: "open", Kind: "future", Creator: actors[0]})
	challengeIDs := []string{}
	for i := 0; i < 32; i++ {
		id := fmt.Sprintf("challenge-%086d", i)
		challengeIDs = append(challengeIDs, id)
		v := federation.LegacyChallenge{ID: id, Kind: "prior_art", Project: "project", Task: "challenge-task", Actor: fmt.Sprintf("maximum-verifier-%020d", i), Member: members[i+3].ID, Source: "https://example.org/public", Note: strings.Repeat("<", 2000), Evidence: evidence, State: "open"}
		set("legacy_challenge_filing/"+id, v)
		v.Source = ""
		v.Note = ""
		v.Evidence = ""
		v.At = ""
		set("legacy_challenge/"+id, v)
	}
	set("legacy_challenges/project/challenge-task/prior_art", challengeIDs)
	h := int64(1)
	block(t, a, h)
	seq := []uint64{0, 0, 0}
	var result *abci.ResponseFinalizeBlock
	send := func(i int, op string, p any, ok bool) {
		t.Helper()
		h++
		raw := testEnvelope(t, members[i], keys[i], seq[i], op, p)
		result = block(t, a, h, raw)
		tx := result.TxResults[0]
		if (tx.Code == 0) != ok {
			t.Fatal(op, tx.Code, tx.Log, tx.GasUsed)
		}
		if ok {
			seq[i]++
			if tx.GasUsed >= int64(TransactionGas) {
				t.Fatal(op, tx.GasUsed)
			}
			t.Logf("maximum future %s gas=%d", op, tx.GasUsed)
		}
	}
	apply := map[string]any{"contribution": ids[127], "evidence_digest": evidence}
	send(1, "legacy_future_apply", apply, false)
	send(2, "legacy_kpi_resolve", map[string]any{"task": "future", "resolver": actors[2], "observed": true, "source": "https://example.org/result", "note": "The independently recorded public event occurred as specified.", "evidence_digest": evidence}, true)
	query := func(key string) []byte {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(e, q)
		}
		if e = proof.VerifyQuery(*q, key, result.AppHash, h); e != nil {
			t.Fatal(e)
		}
		return bytes.Clone(q.Value)
	}
	var member federation.Member
	if e := json.Unmarshal(query("member/"+members[0].ID), &member); e != nil || member.Credits != "0" {
		t.Fatal("decision paid before per-work apply", member, e)
	}
	send(1, "legacy_future_apply", apply, true)
	var w federation.LegacyWork
	if e := json.Unmarshal(query("legacy_work/"+ids[127]), &w); e != nil || w.Paid || w.Pending != "kpi_award" {
		t.Fatal(w, e)
	}
	if e := json.Unmarshal(query("member/"+members[0].ID), &member); e != nil || member.Credits != "1000" {
		t.Fatal(member, e)
	}
	plan := query("legacy_future_award/" + ids[127])
	a, e := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(plan, query("legacy_future_award/"+ids[127])) {
		t.Fatal("immutable plan changed on mid-plan restart")
	}
	for _, index := range []int{0, -1, 33} {
		send(0, "legacy_future_apply", map[string]any{"contribution": ids[127], "recipient": index, "evidence_digest": evidence}, false)
	}
	send(2, "legacy_kpi_resolve", map[string]any{"task": "future", "resolver": actors[2], "observed": false, "source": "https://example.org/result", "note": "A changed final decision cannot overwrite the existing outcome.", "evidence_digest": evidence}, false)
	for i := 1; i <= 32; i++ {
		send(i%2, "legacy_future_apply", map[string]any{"contribution": ids[127], "recipient": i, "evidence_digest": evidence}, true)
	}
	if e := json.Unmarshal(query("legacy_work/"+ids[127]), &w); e != nil || !w.Paid || w.Pending != "" {
		t.Fatal("all slot receipts required before paid", w, e)
	}
	application := query("legacy_future_application/" + ids[127])
	total := 0
	for i := 0; i < 32; i++ {
		var v federation.Member
		if e := json.Unmarshal(query("member/"+members[i+3].ID), &v); e != nil {
			t.Fatal(e)
		}
		expected := "6"
		if i < 8 {
			expected = "7"
		}
		if v.Credits != expected {
			t.Fatal("original equal pool and earliest-ID remainder changed", i, v.Credits)
		}
		if i < 8 {
			total += 7
		} else {
			total += 6
		}
	}
	if total != 200 {
		t.Fatal("verifier pool conservation", total)
	}
	send(0, "legacy_future_apply", map[string]any{"contribution": ids[127], "evidence_digest": strings.Repeat("b", 64)}, false)
	if !bytes.Equal(application, query("legacy_future_application/"+ids[127])) {
		t.Fatal("final receipt rewritten by changed caller/evidence replay")
	}
	send(2, "legacy_prior_art_decide", map[string]any{"challenge": challengeIDs[0], "actor": actors[2], "decision": "upheld", "note": "The independently cited public source already solves this exact question.", "evidence_digest": evidence}, true)
}
