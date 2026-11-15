//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"cosmossdk.io/log/v2"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSDKCentralTaskStatesContestAndConditionalThroughABCI(t *testing.T) {
	lead, leadKey := privateStateFixtureMember("fictional Coin lead", 5)
	peer, peerKey := privateStateFixtureMember("fictional Coin peer", 6)
	guardian, guardianKey := testMember("fictional Coin guardian")
	reviewer, reviewerKey := privateStateFixtureMember("fictional boundary reviewer", 42)
	reviewer.Karma = 100
	relay, relayKey := privateStateFixtureMember("fictional separate relay", 7)
	lead.Karma, lead.Creator = 1000, true
	peer.Karma, guardian.DefaultVerifier = 100, true
	members := []federation.Member{lead, peer, guardian, reviewer, relay}
	keys := map[string]ed25519.PrivateKey{lead.ID: leadKey, peer.ID: peerKey, guardian.ID: guardianKey, reviewer.ID: reviewerKey, relay.ID: relayKey}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	h := int64(0)
	sequences := map[string]uint64{}
	var r *abci.ResponseFinalizeBlock
	digest := strings.Repeat("a", 64)
	query := func(record string) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatalf("query %s: %+v %v", record, q, err)
		}
		if len(q.Value) == 0 {
			if q.Height != h || !bytes.Equal(q.Key, []byte(record)) || q.ProofOps == nil {
				t.Fatal("invalid absence proof context")
			}
			err = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, r.AppHash, "/federation/"+url.PathEscape(record))
		} else {
			err = proof.VerifyQuery(*q, record, r.AppHash, h)
		}
		if err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	send := func(m federation.Member, op string, p any, want bool) {
		t.Helper()
		h++
		payload, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: m.ID, Sequence: sequences[m.ID], ExpiresHeight: h + 10, Operation: op, Payload: payload}
		signed, err := federation.SigningBytes(c)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(federation.Envelope{Command: c, PublicKey: m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(keys[m.ID], signed))})
		if err != nil {
			t.Fatal(err)
		}
		r = block(t, a, h, raw)
		if (r.TxResults[0].Code == 0) != want {
			t.Fatalf("%s h=%d gas=%d: %+v", op, h, r.TxResults[0].GasUsed, r.TxResults[0])
		}
		if want {
			sequences[m.ID]++
			if strings.HasPrefix(op, "coin_") || op == "activate_coin" {
				t.Logf("%s gas %d", op, r.TxResults[0].GasUsed)
			}
		}
	}
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_private_exchange", map[string]any{"policy": federation.PrivateExchangePolicy, "relayer": relay.ID, "evidence_digest": digest}, true)
	send(guardian, "activate_membership", map[string]any{"policy": federation.MembershipPolicy, "evidence_digest": digest}, true)
	for i, m := range members {
		send(m, "identity_claim", map[string]any{}, true)
		send(m, "operator_claim", map[string]any{"domain": fmt.Sprintf("coin-%d.example", i)}, true)
		var claim federation.OperatorClaim
		if err := json.Unmarshal(query("operator_claim/"+m.ID+"/"), &claim); err != nil {
			t.Fatal(err)
		}
		send(guardian, "operator_attest", map[string]any{"member": m.ID, "domain": claim.Domain, "claim_event_id": fmt.Sprint(claim.EventID), "txt": "uain-operator=" + claim.DID, "checked_at": time.Unix(1001+h, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": digest}, true)
	}
	prior := federation.PriorArt{Basis: "No discoverable solution exists for this fictional isolated test question.", Searches: []string{"first fictional prior-art search", "second fictional prior-art search"}}
	send(lead, "open_project", map[string]any{"id": "P-central", "title": "Fictional Coin qualification", "class": "benevolent", "prior_art": prior}, true)
	for _, m := range []federation.Member{peer, guardian, reviewer, relay} {
		send(m, "project_join", map[string]any{"project": "P-central"}, true)
	}
	send(guardian, "activate_coin", map[string]any{"policy": federation.CoinPolicy, "evidence_digest": digest}, true)

	hash := func(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
	send(guardian, "central_earning_activate", map[string]any{"policy": federation.CentralEarningPolicy, "reviewer": guardian.ID, "evidence_digest": digest}, true)
	send(lead, "central_project_start", map[string]any{"project": "P-central", "manager": lead.ID, "evidence_digest": digest}, true)
	send(guardian, "central_fund_configure", map[string]any{"project": "P-central", "evaluator": guardian.ID, "expected_evaluator": "", "evidence_digest": digest}, true)
	stages := []map[string]any{}
	for i := 1; i <= 5; i++ {
		stages = append(stages, map[string]any{"round": i, "criteria": fmt.Sprintf("Fictional measurable acceptance criterion number %d", i)})
	}
	send(guardian, "central_fund_plan", map[string]any{"project": "P-central", "revision": 1, "main_kpi": "Fictional main project result with exact measurable target", "stages": stages, "reason": "Define exact initial measurable milestones", "evidence_digest": digest}, true)
	send(guardian, "central_fund_plan_review", map[string]any{"project": "P-central", "revision": 1, "verdict": "accept", "evidence_digest": digest}, true)
	// central-task-states-v1 through the real ABCI path: gated, then a contest and a
	// conditional payout, each record proved against the committed app hash.
	terms := func(id string, extra map[string]any) map[string]any {
		m := map[string]any{"id": id, "project": "P-central", "title": "Fictional central fixture", "criteria": "result equals 42", "acceptance_digest": hash("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "100000000", "reviewer_amount": "20000000", "evidence_digest": digest}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	entry := func(id, task, evidence string) map[string]any {
		return map[string]any{"id": id, "task": task, "evidence": evidence, "evidence_digest": hash(evidence)}
	}
	review := func(id, verdict, execution, evidence string) map[string]any {
		return map[string]any{"submission": id, "verdict": verdict, "criteria_digest": hash("result equals 42"), "verification_digest": digest, "execution_id": execution, "evidence_digest": hash(evidence)}
	}
	record := func(key string, out any) {
		t.Helper()
		if err := json.Unmarshal(query(key), out); err != nil {
			t.Fatal(key, err)
		}
	}
	send(lead, "central_task_open", terms("CT-gated", map[string]any{"mode": "contest"}), false)
	send(guardian, "central_contest_settle", map[string]any{"task": "CT-gated"}, false)
	send(guardian, "central_task_states_activate", map[string]any{"policy": federation.CentralTaskStatesPolicy, "evidence_digest": digest}, true)
	// Short limits so block time (one second per block here) can pass them.
	params := federation.CentralTaskStatesParams{ContestDefaultSeconds: 10, ContestMinSeconds: 5, ContestMaxSeconds: 1000, SelectionWindowSeconds: 20, MaxEntriesDefault: 20, MaxEntriesLimit: 100, ConditionMaxSeconds: 10000, ConditionGraceSeconds: 10}
	send(guardian, "central_task_states_configure", map[string]any{"params": params, "evidence_digest": digest}, true)

	send(lead, "central_task_open", terms("CT-contest", map[string]any{"mode": "contest", "max_entries": "3"}), true)
	var task federation.CentralTask
	record("central_task/CT-contest", &task)
	if task.State != "contest_open" || task.HashVersion != federation.CentralTaskStatesHashVersion || task.MaxEntries != 3 {
		t.Fatal(task)
	}
	send(peer, "central_submit", entry("CE-1", "CT-contest", "41"), true)
	send(relay, "central_submit", entry("CE-2", "CT-contest", "42"), true)
	send(relay, "central_submit", entry("CE-3", "CT-contest", "42"), false)
	send(guardian, "central_review", review("CE-1", "reject", "x-1", "41"), true)
	send(guardian, "central_review", review("CE-2", "accept", "x-2", "42"), true)
	send(guardian, "central_contest_select", map[string]any{"task": "CT-contest", "submission": "CE-2", "evidence_digest": digest}, false)
	// Block time is 1000+height; the selection's block must reach closes_at.
	for 1000+h+1 < task.ClosesAt {
		h++
		r = block(t, a, h)
	}
	send(guardian, "central_contest_select", map[string]any{"task": "CT-contest", "submission": "CE-2", "evidence_digest": digest}, true)
	record("central_task/CT-contest", &task)
	if task.State != "accepted" || task.Winner != "CE-2" || task.Reserved != "0" || string(query("coin_balance/"+relay.ID)) != "\"100000000\"" || len(query("coin_balance/"+peer.ID)) != 0 {
		t.Fatal("contest payout", task)
	}
	var selection federation.CentralContestSelection
	record("central_contest_selection/CT-contest", &selection)
	if selection.Outcome != "selected" || selection.HashVersion != 2 {
		t.Fatal(selection)
	}

	resolves := 1000 + h + 100
	send(lead, "central_task_open", terms("CT-cond", map[string]any{"payout": "conditional", "condition": "The fictional named event happens.", "resolves_by": fmt.Sprint(resolves)}), true)
	send(peer, "central_submit", entry("CC-1", "CT-cond", "42"), true)
	send(guardian, "central_review", review("CC-1", "accept", "c-1", "42"), true)
	record("central_task/CT-cond", &task)
	var ledger coin.Ledger
	record("coin_supply", &ledger)
	if task.State != "conditional_approved" || task.Reserved != "100000000" || ledger.Reserved != "100000000" || len(query("coin_balance/"+peer.ID)) != 0 {
		t.Fatal("conditional accept", task, ledger)
	}
	send(peer, "central_condition_expire", map[string]any{"task": "CT-cond"}, false)
	send(guardian, "central_condition_resolve", map[string]any{"task": "CT-cond", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, true)
	record("central_task/CT-cond", &task)
	record("coin_supply", &ledger)
	if task.State != "accepted" || task.Reserved != "0" || ledger.Reserved != "0" || ledger.Validate() != nil || string(query("coin_balance/"+peer.ID)) != "\"100000000\"" {
		t.Fatal("condition met", task, ledger)
	}
	// A restart keeps every record.
	saved := bytes.Clone(query("central_condition_resolution/CT-cond"))
	var err error
	if a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1"); err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	if !bytes.Equal(saved, query("central_condition_resolution/CT-cond")) {
		t.Fatal("restart changed the resolution")
	}
}
