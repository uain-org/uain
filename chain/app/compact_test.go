package app

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKCompactFundedEscapedEvidenceMaximumScansAndRestart(t *testing.T) {
	for _, met := range []bool{true, false} {
		t.Run(fmt.Sprint(met), func(t *testing.T) { compactBoundCase(t, met, false, false) })
	}
}

func TestSDKCompactMaximumActors(t *testing.T) { compactBoundCase(t, true, true, true) }

func TestSDKOperatorRewardMaximumActors(t *testing.T) {
	compactBoundPolicyCase(t, true, true, true, true)
}

func compactBoundCase(t *testing.T, met, maxActors, highEntropy bool) {
	compactBoundPolicyCase(t, met, maxActors, highEntropy, false)
}

func TestSDKArbitrationMaximumActorsProofsAndRestart(t *testing.T) {
	compactBoundArbitrationCase(t, true, true, true, true, true)
}

func compactBoundPolicyCase(t *testing.T, met, maxActors, highEntropy, operatorRewards bool) {
	compactBoundArbitrationCase(t, met, maxActors, highEntropy, operatorRewards, false)
}

func TestSDKResearchProceedingsMaximumActorsProofsAndRestart(t *testing.T) {
	compactBoundArbitrationCase(t, true, true, true, true, true, true)
}

func compactBoundArbitrationCase(t *testing.T, met, maxActors, highEntropy, operatorRewards, arbitration bool, proceeding ...bool) {
	proceedings := len(proceeding) > 0 && proceeding[0]
	expectedChecks := 20
	if arbitration {
		expectedChecks = federation.MaxArbitrationChecks
		if proceedings {
			expectedChecks = federation.MaxProceedingChecks
		}
	}
	newMember := func(name string) (federation.Member, ed25519.PrivateKey) {
		m, key := testMember(name)
		if maxActors {
			m.Name = name + strings.Repeat("<", 120-len(name))
			m.Operator = name + strings.Repeat("<", 200-len(name))
			m.Family = name + strings.Repeat("<", 100-len(name))
			m.Credits = strings.Repeat("6", 78)
		}
		return m, key
	}
	lead, leadKey := newMember("lead")
	lead.Karma, lead.Creator = 1000, true
	guardian, guardianKey := newMember("guardian")
	guardian.DefaultVerifier = true
	members := []federation.Member{lead, guardian}
	keys := map[string]ed25519.PrivateKey{lead.ID: leadKey, guardian.ID: guardianKey}
	authors, checkers := []federation.Member{}, []federation.Member{}
	for i := 0; i < 20; i++ {
		m, key := newMember(fmt.Sprintf("author-%02d", i))
		authors = append(authors, m)
		members = append(members, m)
		keys[m.ID] = key
	}
	for i := 0; i < 19; i++ {
		m, key := newMember(fmt.Sprintf("checker-%02d", i))
		m.Karma = 100
		checkers = append(checkers, m)
		members = append(members, m)
		keys[m.ID] = key
	}
	checkers = append(checkers, guardian)
	db := dbm.NewMemDB()
	var arbiter, appealArbiter federation.Member
	if arbitration {
		var key ed25519.PrivateKey
		arbiter, key = newMember("arbiter")
		arbiter.Karma = 100
		members = append(members, arbiter)
		keys[arbiter.ID] = key
	}
	if proceedings {
		var key ed25519.PrivateKey
		appealArbiter, key = newMember("appeal-arbiter")
		appealArbiter.Karma = 100
		members = append(members, appealArbiter)
		keys[appealArbiter.ID] = key
	}
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	h := int64(0)
	seq := map[string]uint64{}
	var r *abci.ResponseFinalizeBlock
	queries := map[string]abci.ResponseQuery{}
	maxGas := map[string]int64{}
	instances := map[string]string{}
	verificationCounts := map[string]int{}
	send := func(m federation.Member, op string, p any, want bool) {
		t.Helper()
		h++
		payload, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: m.ID, Sequence: seq[m.ID], ExpiresHeight: h + 10, Operation: op, Payload: payload, Instance: instances[m.ID]}
		signing, err := federation.SigningBytes(c)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(federation.Envelope{Command: c, PublicKey: m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(keys[m.ID], signing))})
		if err != nil {
			t.Fatal(err)
		}
		if !want {
			checked, err := a.CheckTx(&abci.RequestCheckTx{Tx: raw})
			if err != nil || checked.Code == 0 {
				t.Fatalf("prospective CheckTx accepted refused %s: %+v %v", op, checked, err)
			}
		}
		proposalCheck := maxActors && (op == "resolve_kpi" || op == "decide_prior_art" || op == "arbitrate" || op == "resolve_appeal" || op == "appeal_arbitration")
		if maxActors && op == "verify" {
			var v struct {
				Contribution string `json:"contribution"`
			}
			if err := json.Unmarshal(payload, &v); err != nil {
				t.Fatal(err)
			}
			if want {
				verificationCounts[v.Contribution]++
			}
			proposalCheck = verificationCounts[v.Contribution] >= 20
		}
		if proposalCheck {
			now := time.Unix(1000+h, 0).UTC()
			prepared, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: h, Time: now, MaxTxBytes: int64(ProposalBytes), Txs: [][]byte{raw}})
			if err != nil || (len(prepared.Txs) == 1) != want {
				if want {
					result := block(t, a, h, raw).TxResults[0]
					t.Fatalf("maximum %s prepare refusal; execution code=%d gas=%d log=%s", op, result.Code, result.GasUsed, result.Log)
				}
				t.Fatalf("maximum %s proposal preparation disagrees with execution: %v %v", op, prepared, err)
			}
			processed, err := a.ProcessProposal(&abci.RequestProcessProposal{Height: h, Time: now, Txs: [][]byte{raw}})
			if err != nil || (processed.Status == abci.ResponseProcessProposal_ACCEPT) != want {
				t.Fatalf("maximum %s proposal validation disagrees with execution: %v %v", op, processed, err)
			}
		}
		r = block(t, a, h, raw)
		result := r.TxResults[0]
		if (result.Code == 0) != want {
			t.Fatalf("%s height=%d gas=%d code=%d: %s", op, h, result.GasUsed, result.Code, result.Log)
		}
		if want {
			seq[m.ID]++
			if result.GasUsed > maxGas[op] {
				maxGas[op] = result.GasUsed
			}
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
		queries[key] = *q
		return q.Value
	}
	if maxActors {
		for i, m := range members {
			id := fmt.Sprintf("I-%02d%s", i, strings.Repeat("i", 92))
			send(m, "instance_create", map[string]any{"id": id, "name": m.Name, "family": m.Family}, true)
			instances[m.ID] = id
		}
	}
	digest := strings.Repeat("a", 64)
	projectID := "P-" + strings.Repeat("p", 94)
	taskID := "T-" + strings.Repeat("t", 94)
	answerID := func(i int) string { return fmt.Sprintf("R-%02d%s", i, strings.Repeat("r", 92)) }
	challengeID := func(i int) string { return fmt.Sprintf("C-%02d%s", i, strings.Repeat("c", 92)) }
	prior := federation.PriorArt{Basis: "b" + strings.Repeat(`"`, 3999)}
	for i := 0; i < 20; i++ {
		prior.Searches = append(prior.Searches, fmt.Sprintf("%02d%s", i, strings.Repeat(`"`, 998)))
	}
	if highEntropy {
		randomText := func(seed string, size int) string {
			var b strings.Builder
			for i := 0; b.Len() < size; i++ {
				sum := sha256.Sum256([]byte(fmt.Sprintf("%s/%d", seed, i)))
				for _, v := range sum {
					if b.Len() == size {
						break
					}
					b.WriteByte(32 + v%95)
				}
			}
			return b.String()
		}
		prior.Basis = "b" + randomText("basis", 3999)
		for i := range prior.Searches {
			prior.Searches[i] = fmt.Sprintf("%02d", i) + randomText(fmt.Sprint(i), 998)
		}
	}
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_membership", map[string]any{"policy": federation.MembershipPolicy, "evidence_digest": digest}, true)
	if operatorRewards {
		send(guardian, "activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest}, true)
	}
	if arbitration {
		send(guardian, "activate_arbitration", map[string]any{"policy": federation.ArbitrationPolicy, "evidence_digest": digest}, true)
		send(guardian, "arbiter_appoint", map[string]any{"member": arbiter.ID, "instance": instances[arbiter.ID], "active": true, "evidence_digest": digest}, true)
	}
	if proceedings {
		send(guardian, "activate_research_proceedings", map[string]any{"policy": federation.ResearchProceedingsPolicy, "evidence_digest": digest, "appeal_window_blocks": "50"}, true)
		send(guardian, "arbiter_appoint", map[string]any{"member": appealArbiter.ID, "instance": instances[appealArbiter.ID], "active": true, "evidence_digest": digest}, true)
	}
	send(lead, "open_project", map[string]any{"id": projectID, "title": "p" + strings.Repeat(`"`, 249), "class": "benevolent", "prior_art": prior}, true)
	projectMetadata := query("project_metadata/" + projectID)
	send(guardian, "allocate_budget", map[string]any{"project": projectID, "credits": "1000", "evidence_digest": digest}, true)
	send(lead, "open_task", federation.Task{ID: taskID, Project: projectID, Title: "t" + strings.Repeat(`"`, 249), Class: "benevolent", PriorArt: prior, Criteria: "c" + strings.Repeat(`"`, 3999), Kind: "future", KPI: &federation.KPI{Statement: strings.Repeat("K", 2000), Metric: "event", Source: "https://example.invalid/event", Comparator: "occurs", ResolvesBy: "2000-01-01"}, KarmaReward: 100, CreditReward: "100", VerifiersRequired: 20}, true)
	taskMetadata := query("task_metadata/" + taskID)
	for _, m := range append(append([]federation.Member{}, authors...), checkers...) {
		send(m, "project_join", map[string]any{"project": projectID}, true)
	}
	if arbitration {
		send(arbiter, "project_join", map[string]any{"project": projectID}, true)
	}
	if proceedings {
		send(appealArbiter, "project_join", map[string]any{"project": projectID}, true)
	}
	for i, m := range authors {
		send(m, "submit", map[string]any{"id": answerID(i), "task": taskID, "evidence_digest": digest}, true)
	}
	// Every future answer can freeze, but no payout occurs before the KPI. All
	// twenty summaries are scanned repeatedly as their large evidence accumulates.
	for i := range authors {
		for _, m := range checkers {
			verdict := "confirm"
			if arbitration && m.ID == guardian.ID {
				verdict = "dispute"
			}
			send(m, "verify", map[string]any{"contribution": answerID(i), "verdict": verdict, "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, true)
		}
		if arbitration {
			send(arbiter, "arbitrate", map[string]any{"contribution": answerID(i), "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest, "known_source": "", "no_effort": false}, true)
			if proceedings {
				send(guardian, "appeal_arbitration", map[string]any{"contribution": answerID(i), "evidence_digest": digest, "reason": "The default verifier requests an independent second ruling on this result."}, true)
				send(arbiter, "resolve_appeal", map[string]any{"contribution": answerID(i), "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, false)
				send(appealArbiter, "resolve_appeal", map[string]any{"contribution": answerID(i), "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest, "revised_claim": "The independently checked narrower claim: " + strings.Repeat("<", 3900)}, true)
			}
			send(guardian, "verify", map[string]any{"contribution": answerID(i), "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, true)
		}
	}
	var answer federation.Contribution
	if err := json.Unmarshal(query("contribution/"+answerID(19)), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Settlement == nil || answer.Settlement.Paid || answer.State != "verified" || len(answer.Verifications) != expectedChecks || len(answer.Verifications[0].Searches) != 0 {
		t.Fatal("compact future settlement missing", answer)
	}
	check := answer.Verifications[0]
	var evidence federation.VerificationEvidence
	evidenceKey := "verification_evidence/" + answer.ID + "/" + check.RecordDigest
	evidenceRaw := query(evidenceKey)
	reader, decodeErr := zlib.NewReader(bytes.NewReader(evidenceRaw))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	rawEvidence, decodeErr := io.ReadAll(io.LimitReader(reader, federation.MaxEnvelopeBytes+1))
	reader.Close()
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if err := json.Unmarshal(rawEvidence, &evidence); err != nil || !reflect.DeepEqual(evidence.Check.Searches, prior.Searches) {
		t.Fatal("committed searches lost", err)
	}
	// Close a separately funded task with the full challenge bound and escaped
	// notes, proving reserve release cannot rewrite project/task research.
	closureTask := "T-close"
	send(lead, "open_task", federation.Task{ID: closureTask, Project: projectID, Title: "t" + strings.Repeat(`"`, 249), Class: "benevolent", PriorArt: prior, Criteria: "c" + strings.Repeat(`"`, 3999), Kind: "instant", KarmaReward: 100, CreditReward: "100"}, true)
	closureMetadata := query("task_metadata/" + closureTask)
	for i, m := range authors {
		send(m, "challenge_prior_art", map[string]any{"id": challengeID(i), "task": closureTask, "source": "https://example.invalid/" + strings.Repeat("s", 476), "note": "n" + strings.Repeat(`<`, 3999)}, true)
	}
	before := query("task/" + closureTask)
	send(authors[0], "decide_prior_art", map[string]any{"challenge": challengeID(0), "decision": "upheld", "note": "d" + strings.Repeat(`<`, 3999)}, false)
	if !bytes.Equal(before, query("task/"+closureTask)) {
		t.Fatal("unauthorized closure changed state")
	}
	send(guardian, "decide_prior_art", map[string]any{"challenge": challengeID(0), "decision": "upheld", "note": "d" + strings.Repeat(`<`, 3999)}, true)
	if !bytes.Equal(closureMetadata, query("task_metadata/"+closureTask)) || !bytes.Equal(projectMetadata, query("project_metadata/"+projectID)) {
		t.Fatal("closure rewrote evidence")
	}
	// Resolve the first task and pay its first answer. The twenty-check share
	// journal and remaining reserve have to fit the same SDK gas budget.
	send(guardian, "resolve_kpi", map[string]any{"task": taskID, "observed": met, "source": "https://example.invalid/result", "note": "The observed public source confirms the required event.", "evidence_digest": digest}, true)
	var settledTask federation.Task
	if err := json.Unmarshal(query("task/"+taskID), &settledTask); err != nil || (met && settledTask.Winner != answerID(0)) || (!met && (settledTask.Winner != "" || settledTask.State != "kpi_unmet")) {
		t.Fatal("submission order or settlement failed", settledTask, err)
	}
	var p federation.Project
	if err := json.Unmarshal(query("project/"+projectID), &p); err != nil || p.Accounting.Reserved != "0" || ((met && p.Accounting.Spent != "100") || (!met && p.Accounting.Spent != "0")) {
		t.Fatal("budget accounting failed", p, err)
	}
	if !bytes.Equal(taskMetadata, query("task_metadata/"+taskID)) || !bytes.Equal(evidenceRaw, query(evidenceKey)) {
		t.Fatal("settlement rewrote immutable evidence")
	}
	paidAnswer := query("contribution/" + answerID(0))
	closed := query("task/" + closureTask)
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	if !bytes.Equal(paidAnswer, query("contribution/"+answerID(0))) || !bytes.Equal(closed, query("task/"+closureTask)) || !bytes.Equal(taskMetadata, query("task_metadata/"+taskID)) || !bytes.Equal(evidenceRaw, query(evidenceKey)) {
		t.Fatal("restart lost compound evidence")
	}
	// All evidence in this compound answer is fetched and proved at the same
	// post-restart height. No unrelated or stale RPC value may fill a gap.
	var complete federation.Contribution
	json.Unmarshal(query("contribution/"+answerID(0)), &complete)
	proofKeys := []string{"contribution/" + answerID(0), "task/" + taskID, "task_metadata/" + taskID, "project/" + projectID, "project_metadata/" + projectID}
	for _, check := range complete.Verifications {
		proofKeys = append(proofKeys, "verification_evidence/"+complete.ID+"/"+check.RecordDigest, "verification_summary/"+complete.ID+"/"+check.RecordDigest)
	}
	if arbitration {
		proofKeys = append(proofKeys, "arbitration/"+complete.ID)
	}
	if proceedings {
		proofKeys = append(proofKeys, "research_appeal/"+complete.ID, "research_appeal_decision/"+complete.ID)
	}
	compound := []abci.ResponseQuery{}
	for _, key := range proofKeys {
		query(key)
		compound = append(compound, queries[key])
	}
	reconstructed, err := proof.VerifyContribution(compound, complete.ID, r.AppHash, h)
	if err != nil || len(reconstructed.Verifications) != expectedChecks || !reflect.DeepEqual(reconstructed.Verifications[0].Searches, prior.Searches) || (met && reconstructed.State != "settled") || (!met && (reconstructed.State != "withheld" || reconstructed.AwardWithheld != "kpi_unmet")) {
		t.Fatal("compound answer proof failed", reconstructed, err)
	}
	if proceedings {
		if _, err = proof.VerifyContribution(append(append([]abci.ResponseQuery{}, compound[:len(compound)-2]...), compound[len(compound)-1]), complete.ID, r.AppHash, h); err == nil {
			t.Fatal("missing appeal request accepted")
		}
	}
	if arbitration {
		if _, err = proof.VerifyContribution(compound[:len(compound)-1], complete.ID, r.AppHash, h); err == nil {
			t.Fatal("missing arbitration ruling accepted")
		}
	}
	if _, err = proof.VerifyContribution(compound[:5], complete.ID, r.AppHash, h); err == nil {
		t.Fatal("missing evidence accepted")
	}
	bad := append([]abci.ResponseQuery{}, compound...)
	bad[5].Height--
	if _, err = proof.VerifyContribution(bad, complete.ID, r.AppHash, h); err == nil {
		t.Fatal("mixed heights accepted")
	}
	bad = append([]abci.ResponseQuery{}, compound...)
	bad[5].Value = []byte("tampered")
	if _, err = proof.VerifyContribution(bad, complete.ID, r.AppHash, h); err == nil {
		t.Fatal("tampered evidence accepted")
	}
	if maxActors {
		winner := authors[0]
		memberKeys := []string{"member/" + winner.ID, "member_metadata/" + winner.ID}
		memberProof := []abci.ResponseQuery{}
		for _, key := range memberKeys {
			query(key)
			memberProof = append(memberProof, queries[key])
		}
		m, err := proof.VerifyMember(memberProof, winner.ID, r.AppHash, h)
		if err != nil || m.Name != winner.Name || m.Operator != winner.Operator || m.Family != winner.Family || m.Karma != 100 {
			t.Fatal("account metadata/standing reconstruction failed", m, err)
		}
		id := instances[winner.ID]
		instanceProof := append([]abci.ResponseQuery{}, memberProof...)
		for _, key := range []string{"instance/" + id, "instance_metadata/" + id} {
			query(key)
			instanceProof = append(instanceProof, queries[key])
		}
		v, err := proof.VerifyInstance(instanceProof, id, r.AppHash, h)
		if err != nil || v.Name != winner.Name || v.Family != winner.Family || v.Karma != 100 || v.Credits != "100" {
			t.Fatal("instance attribution proof failed", v, err)
		}
		if _, err = proof.VerifyInstance(instanceProof[:3], id, r.AppHash, h); err == nil {
			t.Fatal("missing instance metadata accepted")
		}
	}
	for op, gas := range maxGas {
		t.Logf("compact bound %s: %d / %d", op, gas, TransactionGas)
	}
}
