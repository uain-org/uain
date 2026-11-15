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

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKMembershipChallengeMaximumBoundProofAndRestart(t *testing.T) {
	projectID := "P-" + strings.Repeat("p", 94)
	taskID := "T-" + strings.Repeat("t", 94)
	challengeID := func(i int) string { return fmt.Sprintf("C-%02d%s", i, strings.Repeat("c", 92)) }
	answerID := func(i int) string { return fmt.Sprintf("R-%02d%s", i, strings.Repeat("r", 92)) }
	lead, leadKey := testMember("project lead")
	lead.Karma, lead.Creator = 1000, true
	guardian, guardianKey := testMember("default judge")
	guardian.DefaultVerifier = true
	people := []federation.Member{lead, guardian}
	keys := map[string]ed25519.PrivateKey{lead.ID: leadKey, guardian.ID: guardianKey}
	for i := 0; i < federation.MaxOpenChallengesPerTask; i++ {
		m, key := testMember(fmt.Sprintf("challenger-%d", i))
		people = append(people, m)
		keys[m.ID] = key
	}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: people})
	h := int64(0)
	seq := map[string]uint64{}
	var r *abci.ResponseFinalizeBlock
	send := func(m federation.Member, op string, p any, wantSuccess bool) {
		t.Helper()
		h++
		r = block(t, a, h, testEnvelope(t, m, keys[m.ID], seq[m.ID], op, p))
		result := r.TxResults[0]
		if (result.Code == 0) != wantSuccess {
			t.Fatalf("%s code=%d gas=%d: %s", op, result.Code, result.GasUsed, result.Log)
		}
		if wantSuccess {
			seq[m.ID]++
		}
	}
	query := func(key string) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatalf("query %s: %+v %v", key, q, err)
		}
		if err = proof.VerifyQuery(*q, key, r.AppHash, h); err != nil {
			t.Fatal(err)
		}
		return q.Value
	}
	digest := strings.Repeat("a", 64)
	send(guardian, "activate_membership", map[string]any{"policy": federation.MembershipPolicy, "evidence_digest": digest}, true)
	prior := federation.PriorArt{Basis: strings.Repeat("b", 4000)}
	for i := 0; i < 20; i++ {
		prior.Searches = append(prior.Searches, fmt.Sprintf("%02d%s", i, strings.Repeat("q", 998)))
	}
	send(lead, "open_project", map[string]any{"id": projectID, "title": strings.Repeat("p", 250), "class": "benevolent", "prior_art": prior}, true)
	send(lead, "open_task", federation.Task{ID: taskID, Project: projectID, Title: strings.Repeat("t", 250), Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 4000), Kind: "instant", KarmaReward: 100, CreditReward: "100"}, true)
	// A failed outsider submission must preserve both the sequence and task.
	before := query("task/" + taskID)
	send(people[2], "submit", map[string]any{"id": "not-joined", "task": taskID, "evidence_digest": digest}, false)
	if !bytes.Equal(before, query("task/"+taskID)) {
		t.Fatal("failed outsider submission changed task")
	}
	send(guardian, "project_join", map[string]any{"project": projectID}, true)
	for i, m := range people[2:] {
		send(m, "project_join", map[string]any{"project": projectID}, true)
		send(m, "submit", map[string]any{"id": answerID(i), "task": taskID, "evidence_digest": digest}, true)
		send(m, "challenge_prior_art", map[string]any{"id": challengeID(i), "task": taskID, "source": "https://example.invalid/" + strings.Repeat("s", 476), "note": strings.Repeat("n", 4000)}, true)
	}
	rawAnswer := query("contribution/" + answerID(0))
	send(guardian, "decide_prior_art", map[string]any{"challenge": challengeID(0), "decision": "upheld", "note": strings.Repeat("d", 4000)}, true)
	t.Logf("maximum prior-art decision gas: %d / %d", r.TxResults[0].GasUsed, TransactionGas)
	var task federation.Task
	if err := json.Unmarshal(query("task/"+taskID), &task); err != nil {
		t.Fatal(err)
	}
	if task.State != "known" || task.PriorArtDecision != challengeID(0) || len(task.OpenChallenges) != 0 {
		t.Fatal("known task closure missing", task)
	}
	// Raw proofs retain historical evidence. Effective answer/challenge status
	// requires the task proof too, rather than trusting only the old raw row.
	if !bytes.Equal(rawAnswer, query("contribution/"+answerID(0))) {
		t.Fatal("closure rewrote answer provenance")
	}
	closedTask := query("task/" + taskID)
	decision := query("prior_art_challenge/" + challengeID(0))
	a, err := New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	if !bytes.Equal(closedTask, query("task/"+taskID)) || !bytes.Equal(decision, query("prior_art_challenge/"+challengeID(0))) {
		t.Fatal("restart lost challenge decision")
	}
	send(guardian, "decide_prior_art", map[string]any{"challenge": challengeID(0), "decision": "upheld", "note": "Repeated decision must be refused."}, false)
	if !bytes.Equal(closedTask, query("task/"+taskID)) {
		t.Fatal("failed repeated decision changed closure")
	}
}
