package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
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

func TestSDKResearchStandingProofRollbackAndRestart(t *testing.T) {
	lead, leadKey := testMember("research author")
	peer, peerKey := testMember("research peer")
	guardian, guardianKey := testMember("research default")
	lead.Karma, lead.Creator = 1000, true
	peer.Karma, guardian.DefaultVerifier = 100, true
	keys := map[string]ed25519.PrivateKey{lead.ID: leadKey, peer.ID: peerKey, guardian.ID: guardianKey}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{lead, peer, guardian}})
	h, seq := int64(0), map[string]uint64{}
	var r *abci.ResponseFinalizeBlock
	send := func(m federation.Member, op string, p any, success bool) {
		t.Helper()
		h++
		r = block(t, a, h, testEnvelope(t, m, keys[m.ID], seq[m.ID], op, p))
		if (r.TxResults[0].Code == 0) != success {
			t.Fatalf("%s gas %d: %s", op, r.TxResults[0].GasUsed, r.TxResults[0].Log)
		}
		if success {
			seq[m.ID]++
		}
		if op == "research_standing" {
			t.Logf("research standing: %d / %d gas", r.TxResults[0].GasUsed, TransactionGas)
		}
	}
	query := func(key string) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(key, q, err)
		}
		if err = proof.VerifyQuery(*q, key, r.AppHash, h); err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	digest := strings.Repeat("a", 64)
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest}, true)
	send(lead, "identity_claim", map[string]any{}, true)
	send(lead, "operator_claim", map[string]any{"domain": "author.example"}, true)
	var claim federation.OperatorClaim
	if err := json.Unmarshal(query("operator_claim/"+lead.ID+"/"), &claim); err != nil {
		t.Fatal(err)
	}
	send(guardian, "operator_attest", map[string]any{"member": lead.ID, "domain": claim.Domain, "claim_event_id": fmt.Sprint(claim.EventID), "txt": "uain-operator=" + claim.DID, "checked_at": time.Unix(1000+h+1, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": digest}, true)
	prior := federation.PriorArt{Basis: strings.Repeat("b", 40), Searches: []string{"search one, no open solution", "search two, no open solution"}}
	send(lead, "open_project", map[string]any{"id": "P-standing", "title": "Bounded standing research fixture", "class": "benevolent", "prior_art": prior}, true)
	send(guardian, "allocate_budget", map[string]any{"project": "P-standing", "credits": "1000", "evidence_digest": digest}, true)
	ids := []string{}
	for i := 0; i < 4; i++ {
		task, answer := fmt.Sprintf("T-standing-%d", i), fmt.Sprintf("RC-standing-%d", i)
		send(lead, "open_task", federation.Task{ID: task, Project: "P-standing", Title: "Bounded novel research fixture", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 40), Kind: "instant", KarmaReward: 100, CreditReward: "100", VerifiersRequired: 2}, true)
		send(lead, "submit", map[string]any{"id": answer, "task": task, "evidence_digest": digest}, true)
		for _, checker := range []federation.Member{peer, guardian} {
			send(checker, "verify", map[string]any{"contribution": answer, "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, true)
		}
		ids = append(ids, answer)
	}
	send(lead, "research_standing", map[string]any{"contributions": ids}, true)
	key := "research_standing/" + lead.ID + "/"
	standing, member := query(key), query("member/"+lead.ID)
	var witness federation.ResearchStanding
	if err := json.Unmarshal(standing, &witness); err != nil || len(witness.Contributions) != 4 || witness.Member != lead.ID {
		t.Fatal(witness, err)
	}
	send(lead, "research_standing", map[string]any{"contributions": []string{ids[0], ids[0]}}, false)
	if !bytes.Equal(member, query("member/"+lead.ID)) || !bytes.Equal(standing, query(key)) {
		t.Fatal("failed qualification mutated sequence/witness")
	}
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	if !bytes.Equal(standing, query(key)) {
		t.Fatal("standing witness lost after restart")
	}
	// The signed witness can be used again after restart; current dependencies
	// are checked anew rather than trusting a frozen T3 string in storage.
	send(lead, "research_standing", map[string]any{"contributions": ids}, true)
}
