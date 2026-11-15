//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKCoinProspectiveBountyCapProofAtomicityAndRestart(t *testing.T) {
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
	send(lead, "open_project", map[string]any{"id": "P-coin", "title": "Fictional Coin qualification", "class": "benevolent", "prior_art": prior}, true)
	for _, m := range []federation.Member{peer, guardian} {
		send(m, "project_join", map[string]any{"project": "P-coin"}, true)
	}
	send(guardian, "activate_coin", map[string]any{"policy": federation.CoinPolicy, "evidence_digest": digest}, true)
	open := func(id, amount string) {
		t.Helper()
		send(lead, "open_task", federation.Task{ID: id, Project: "P-coin", Title: "Fictional prospective priced bounty", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("c", 40), Kind: "instant", KarmaReward: 13, CreditReward: "13", VerifiersRequired: 2}, true)
		var count uint64
		if err := json.Unmarshal(query("event_count"), &count); err != nil {
			t.Fatal(err)
		}
		send(lead, "coin_quote", map[string]any{"task": id, "open_event": fmt.Sprintf("%020d", count), "amount": amount, "evidence_digest": digest}, true)
	}
	allocate := func(id string, want bool) {
		send(guardian, "coin_reserve", map[string]any{"task": id, "evidence_digest": digest}, want)
	}
	open("T-cap", coin.SupplyCap)
	allocate("T-cap", true)
	capped := query("coin_supply")
	guardianBefore := query("member/" + guardian.ID)
	open("T-award", "5000000")
	allocate("T-award", false)
	if !bytes.Equal(capped, query("coin_supply")) || !bytes.Equal(guardianBefore, query("member/"+guardian.ID)) || len(query("coin_reservation/T-award")) != 0 {
		t.Fatal("failed over-cap allocation changed supply, sequence or reservation")
	}
	send(guardian, "coin_release", map[string]any{"task": "T-cap", "evidence_digest": digest}, false)
	send(lead, "coin_release", map[string]any{"task": "T-cap", "evidence_digest": digest}, true)
	allocate("T-cap", false)
	allocate("T-award", true)
	send(lead, "submit", map[string]any{"id": "RC-coin", "task": "T-award", "evidence_digest": digest}, true)
	claim := map[string]any{"contribution": "RC-coin"}
	send(lead, "coin_release", map[string]any{"task": "T-award", "evidence_digest": digest}, false)
	send(lead, "coin_claim", claim, false)
	verification := map[string]any{"contribution": "RC-coin", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	send(peer, "verify", verification, true)
	send(lead, "coin_claim", claim, false)
	send(guardian, "verify", verification, true)
	pilotBefore := query("member/" + lead.ID)
	send(peer, "coin_claim", claim, false)
	send(lead, "coin_claim", claim, true)
	var ledger coin.Ledger
	if err := json.Unmarshal(query("coin_supply"), &ledger); err != nil || ledger.Validate() != nil || ledger.Minted != "5000000" || ledger.Transparent != "5000000" || ledger.Reserved != "0" || ledger.Shielded != "0" {
		t.Fatal("wrong proven Coin supply", ledger, err)
	}
	if string(query("coin_balance/"+lead.ID)) != "\"5000000\"" {
		t.Fatal("wrong proven Coin balance")
	}
	var before, after federation.Member
	if err := json.Unmarshal(pilotBefore, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(query("member/"+lead.ID), &after); err != nil {
		t.Fatal(err)
	}
	if before.Karma != after.Karma || before.Credits != after.Credits {
		t.Fatal("Coin converted or rewrote pilot standing")
	}
	records := []string{"coin_supply", "coin_balance/" + lead.ID, "coin_reward/RC-coin", "coin_reservation/T-award", "member/" + lead.ID, "event_count"}
	saved := map[string][]byte{}
	for _, record := range records {
		saved[record] = bytes.Clone(query(record))
	}
	send(lead, "coin_claim", claim, false)
	for _, record := range records {
		if !bytes.Equal(saved[record], query(record)) {
			t.Fatal("failed replay changed", record)
		}
	}
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	for _, record := range records {
		if !bytes.Equal(saved[record], query(record)) {
			t.Fatal("restart lost", record)
		}
	}
	send(lead, "coin_claim", claim, false)
	for _, record := range records {
		if !bytes.Equal(saved[record], query(record)) {
			t.Fatal("restarted replay changed", record)
		}
	}
	// Continue from an actually earned SDK bounty, not injected Coin balances.
	// The three wires/signatures are generated by real Orchard proofs using
	// explicitly fictional fixture keys. No production/member key is read.
	directory := os.Getenv("UAIN_PUBLIC_FIXTURE_DIR")
	if directory == "" {
		t.Fatal("real public Coin bridge fixtures required")
	}
	load := func(name string) (string, federation.CoinBoundaryApproval) {
		t.Helper()
		var fixture struct {
			federation.CoinBoundaryApproval
			SignatureHex string `json:"signature_hex"`
		}
		b, err := os.ReadFile(filepath.Join(directory, name+"-approval.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(b, &fixture); err != nil {
			t.Fatal(err)
		}
		signature, err := hex.DecodeString(fixture.SignatureHex)
		if err != nil || len(signature) != 64 {
			t.Fatal("invalid public fixture signature", err)
		}
		fixture.Signature = base64.RawURLEncoding.EncodeToString(signature)
		wire, err := os.ReadFile(filepath.Join(directory, name+".bin"))
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(wire), fixture.CoinBoundaryApproval
	}
	send(guardian, "private_reviewer", map[string]any{"member": reviewer.ID, "active": true, "evidence_digest": digest}, true)
	entryWire, entryApproval := load("coin-entry")
	entry := federation.CoinBoundary{Bundle: entryWire, Approval: entryApproval}
	exitWire, exitApproval := load("coin-exit")
	exit := federation.CoinBoundary{Bundle: exitWire, Approval: exitApproval}
	assertSupply := func(transparent, shielded string) {
		t.Helper()
		var ledger coin.Ledger
		if err := json.Unmarshal(query("coin_supply"), &ledger); err != nil || ledger.Validate() != nil || ledger.Minted != "5000000" || ledger.Reserved != "0" || ledger.Transparent != transparent || ledger.Shielded != shielded {
			t.Fatal("bridge changed or lost issued value", ledger, err)
		}
	}
	badEntry := entry
	badEntry.Approval.Amount = "71"
	send(lead, "coin_shield", badEntry, false)
	send(peer, "coin_shield", entry, false)
	send(lead, "coin_shield", entry, true)
	assertSupply("4999930", "70")
	assertVerifiedCoinState(t, a, r.AppHash, h, reviewer.ID, lead.ID, "4999930", nil, []string{entryApproval.Effects})
	if string(query("coin_balance/"+lead.ID)) != "\"4999930\"" {
		t.Fatal("entry did not debit the earned owner account")
	}
	send(lead, "coin_shield", entry, false)
	// The exit's source note does not exist until its private payment is included.
	send(peer, "coin_exit", exit, false)
	assertSupply("4999930", "70")
	paymentWire, paymentApproval := load("coin-otc")
	send(relay, "private_payment", federation.PrivatePayment{Bundle: paymentWire, Approval: federation.PrivateApproval{Reviewer: paymentApproval.Reviewer, Effects: paymentApproval.Effects, PurposeCommitment: paymentApproval.PurposeCommitment, Class: paymentApproval.Class, ExpiresHeight: paymentApproval.ExpiresHeight, LicenceRevision: paymentApproval.LicenceRevision, Signature: paymentApproval.Signature}}, true)
	assertSupply("4999930", "70")
	assertVerifiedCoinState(t, a, r.AppHash, h, reviewer.ID, peer.ID, "0", []string{paymentApproval.Effects}, []string{entryApproval.Effects})
	send(guardian, "private_reviewer", map[string]any{"member": reviewer.ID, "active": false, "evidence_digest": digest}, true)
	send(peer, "coin_exit", exit, false)
	assertSupply("4999930", "70")
	send(guardian, "private_reviewer", map[string]any{"member": reviewer.ID, "active": true, "evidence_digest": digest}, true)
	send(peer, "coin_exit", exit, true)
	assertSupply("4999956", "44")
	assertVerifiedCoinState(t, a, r.AppHash, h, reviewer.ID, peer.ID, "26", []string{paymentApproval.Effects}, []string{entryApproval.Effects, exitApproval.Effects})
	if string(query("coin_balance/"+peer.ID)) != "\"26\"" {
		t.Fatal("exit credited a wrong public recipient")
	}
	var frontier federation.PrivateFrontier
	if err := json.Unmarshal(query("private_frontier"), &frontier); err != nil || frontier.Count != 6 {
		t.Fatal("entry/payment/exit notes are not one authenticated tree", frontier, err)
	}
	bridgeRecords := []string{"coin_supply", "coin_balance/" + lead.ID, "coin_balance/" + peer.ID, "private_frontier", "private_boundary/" + entryApproval.Effects, "private_payment/" + paymentApproval.Effects, "private_boundary/" + exitApproval.Effects, "member/" + peer.ID}
	bridgeSaved := map[string][]byte{}
	for _, record := range bridgeRecords {
		bridgeSaved[record] = bytes.Clone(query(record))
	}
	send(peer, "coin_exit", exit, false)
	for _, record := range bridgeRecords {
		if !bytes.Equal(bridgeSaved[record], query(record)) {
			t.Fatal("exit replay changed account, supply or private state", record)
		}
	}
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	r = block(t, a, h)
	send(peer, "coin_exit", exit, false)
	for _, record := range bridgeRecords {
		if !bytes.Equal(bridgeSaved[record], query(record)) {
			t.Fatal("restart lost backed private value", record)
		}
	}
}
