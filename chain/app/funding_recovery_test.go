package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
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

// Exercise the full permitted observer census with maximally escaped member
// fields and maximum domain lengths, not the unmetered federation memory store.
func TestSDKFundingObserverRotationMaximum(t *testing.T) {
	guardian, guardianKey := testMember("funding guardian")
	members := []federation.Member{guardian}
	keys := map[string]ed25519.PrivateKey{guardian.ID: guardianKey}
	observers := []string{}
	for i := 0; i < 20; i++ {
		m, key := testMember(fmt.Sprintf("observer-%02d", i))
		m.Name += strings.Repeat("<", 120-len(m.Name))
		m.Operator += strings.Repeat("<", 200-len(m.Operator))
		m.Family += strings.Repeat("<", 100-len(m.Family))
		m.Credits = strings.Repeat("6", 78)
		m.Karma = 100
		members = append(members, m)
		keys[m.ID] = key
		observers = append(observers, m.ID)
	}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	h := int64(0)
	seq := map[string]uint64{}
	digest := strings.Repeat("a", 64)
	var result *abci.ResponseFinalizeBlock
	query := func(record string) []byte {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(record, q, e)
		}
		if e = proof.VerifyQuery(*q, record, result.AppHash, h); e != nil {
			t.Fatal(record, e)
		}
		return bytes.Clone(q.Value)
	}
	send := func(m federation.Member, op string, p any) {
		t.Helper()
		h++
		payload, e := json.Marshal(p)
		if e != nil {
			t.Fatal(e)
		}
		c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: m.ID, Sequence: seq[m.ID], ExpiresHeight: h + 10, Operation: op, Payload: payload}
		message, e := federation.SigningBytes(c)
		if e != nil {
			t.Fatal(e)
		}
		raw, e := json.Marshal(federation.Envelope{Command: c, PublicKey: m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(keys[m.ID], message))})
		if e != nil {
			t.Fatal(e)
		}
		if op == "funding_observers_rotate" {
			now := time.Unix(1000+h, 0).UTC()
			prepared, e := a.PrepareProposal(&abci.RequestPrepareProposal{Height: h, Time: now, MaxTxBytes: int64(ProposalBytes), Txs: [][]byte{raw}})
			if e != nil || len(prepared.Txs) != 1 {
				tx := block(t, a, h, raw).TxResults[0]
				t.Fatalf("maximum rotation prepare refusal: %v code=%d gas=%d log=%s", e, tx.Code, tx.GasUsed, tx.Log)
			}
			processed, e := a.ProcessProposal(&abci.RequestProcessProposal{Height: h, Time: now, Txs: prepared.Txs})
			if e != nil || processed.Status != abci.ResponseProcessProposal_ACCEPT {
				t.Fatal(processed, e)
			}
		}
		result = block(t, a, h, raw)
		tx := result.TxResults[0]
		if tx.Code != 0 || tx.GasUsed >= int64(TransactionGas) {
			t.Fatalf("%s gas=%d code=%d log=%s", op, tx.GasUsed, tx.Code, tx.Log)
		}
		seq[m.ID]++
		if op == "funding_observers_rotate" {
			t.Logf("maximum 20-observer rotation SDK gas=%d", tx.GasUsed)
		}
	}
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest})
	send(guardian, "activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest})
	for i, m := range members[1:] {
		send(m, "identity_claim", map[string]any{})
		domain := fmt.Sprintf("%02d", i) + strings.Repeat("a", 61) + "." + strings.Repeat("b", 63) + "." + strings.Repeat("c", 63) + "." + strings.Repeat("d", 61)
		if len(domain) != 253 {
			t.Fatal("domain fixture not maximal", len(domain))
		}
		send(m, "operator_claim", map[string]any{"domain": domain})
		var claim federation.OperatorClaim
		if e := json.Unmarshal(query("operator_claim/"+m.ID+"/"), &claim); e != nil {
			t.Fatal(e)
		}
		send(guardian, "operator_attest", map[string]any{"member": m.ID, "domain": claim.Domain, "claim_event_id": fmt.Sprint(claim.EventID), "txt": "uain-operator=" + claim.DID, "checked_at": time.Unix(1001+h, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": digest})
	}
	send(guardian, "activate_funding", map[string]any{"policy": federation.FundingPolicy, "observers": observers[:2], "evidence_digest": digest})
	original := query("funding_activation")
	send(guardian, "funding_observers_rotate", map[string]any{"observers": observers, "evidence_digest": digest})
	var id string
	if e := json.Unmarshal(query("funding_observer_epoch_current"), &id); e != nil {
		t.Fatal(e)
	}
	epochBytes := query("funding_observer_epoch/" + id)
	var epoch federation.FundingObserverEpoch
	if e := json.Unmarshal(epochBytes, &epoch); e != nil || len(epoch.Activation.Observers) != 20 || epoch.Activation.Height != h+1 {
		t.Fatal(epoch, e)
	}
	var e error
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(epochBytes, query("funding_observer_epoch/"+id)) || !bytes.Equal(original, query("funding_activation")) {
		t.Fatal("restart changed immutable activation or rotation")
	}
}
