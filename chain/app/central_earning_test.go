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

func TestSDKCentralEarningAwardsProofsAtomicityAndRestart(t *testing.T) {
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
	for _, m := range []federation.Member{peer, guardian} {
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
	// A new legacy task in an adopted project may not create a second monetary path.
	send(lead, "open_task", federation.Task{ID: "T-central-bypass", Project: "P-central", Title: "Unpriced old namespace task", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 40), Kind: "instant", KarmaReward: 13, CreditReward: "13", VerifiersRequired: 2}, true)
	var legacyOpenEvent uint64
	if e := json.Unmarshal(query("event_count"), &legacyOpenEvent); e != nil {
		t.Fatal(e)
	}
	send(lead, "coin_quote", map[string]any{"task": "T-central-bypass", "open_event": fmt.Sprintf("%020d", legacyOpenEvent), "amount": "5000000", "evidence_digest": digest}, false)

	terms := map[string]any{"id": "CT-1", "project": "P-central", "title": "Fictional central fixture", "criteria": "result equals 42", "acceptance_digest": hash("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "100000000", "reviewer_amount": "20000000", "evidence_digest": digest}
	send(peer, "central_task_open", terms, false)
	send(lead, "central_task_open", terms, true)
	submission := func(id string) map[string]any {
		return map[string]any{"id": id, "task": "CT-1", "evidence": "42", "evidence_digest": hash("42")}
	}
	review := func(id, verdict, execution string) map[string]any {
		return map[string]any{"submission": id, "verdict": verdict, "criteria_digest": hash("result equals 42"), "verification_digest": digest, "execution_id": execution, "evidence_digest": hash("42")}
	}
	badSubmission := submission("CS-bad")
	badSubmission["evidence"] = "43"
	send(peer, "central_submit", badSubmission, false)
	send(peer, "central_submit", submission("CS-1"), true)
	before := bytes.Clone(query("coin_supply"))
	send(lead, "central_submit", submission("CS-race"), false)
	send(peer, "central_review", review("CS-1", "accept", "self"), false)
	if !bytes.Equal(before, query("coin_supply")) {
		t.Fatal("failed transaction altered supply")
	}
	badReview := review("CS-1", "accept", "bad-evidence")
	badReview["evidence_digest"] = digest
	send(guardian, "central_review", badReview, false)
	send(guardian, "central_review", review("CS-1", "needs_evidence", "needs"), true)
	send(guardian, "central_reviewer_replace", map[string]any{"expected_reviewer": guardian.ID, "new_reviewer": reviewer.ID, "evidence_digest": digest}, true)
	send(reviewer, "central_review", review("CS-1", "needs_evidence", "replacement-needs"), true)
	send(guardian, "licence", map[string]any{"member": reviewer.ID, "status": "revoked", "evidence_digest": digest}, true)
	send(guardian, "central_reviewer_replace", map[string]any{"expected_reviewer": reviewer.ID, "new_reviewer": guardian.ID, "evidence_digest": digest}, true)

	send(guardian, "central_review", review("CS-1", "reject", "reject"), true)
	if string(query("coin_balance/"+guardian.ID)) != "\"20000000\"" || len(query("central_award/solver/CS-1")) != 0 {
		t.Fatal("rejection award mismatch")
	}
	send(lead, "central_task_fund", map[string]any{"task": "CT-1", "evidence_digest": digest}, true)
	send(lead, "central_submit", submission("CS-2"), true)
	send(guardian, "central_review", review("CS-2", "accept", "accept"), true)
	recordKeys := []string{"coin_supply", "coin_balance/" + lead.ID, "coin_balance/" + guardian.ID, "central_project_budget/P-central", "central_task/CT-1", "central_submission/CS-2", "central_award/solver/CS-2", "central_award/reviewer/CS-2"}
	saved := map[string][]byte{}
	for _, key := range recordKeys {
		saved[key] = bytes.Clone(query(key))
	}
	var ledger coin.Ledger
	if e := json.Unmarshal(query("coin_supply"), &ledger); e != nil || ledger.Validate() != nil || ledger.Minted != "140000000" || ledger.Reserved != "0" {
		t.Fatal(ledger, e)
	}
	send(guardian, "central_review", review("CS-2", "accept", "replay"), false)
	terms["id"] = "CT-over"
	terms["solver_amount"] = federation.CentralProjectAllocation
	send(lead, "central_task_open", terms, false)
	for _, key := range recordKeys {
		if !bytes.Equal(saved[key], query(key)) {
			t.Fatal("failed transition modified", key)
		}
	}
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	for _, key := range recordKeys {
		if !bytes.Equal(saved[key], query(key)) {
			t.Fatal("restart modified", key)
		}
	}
	send(lead, "coin_claim", map[string]any{"contribution": "CS-2"}, false)
}
