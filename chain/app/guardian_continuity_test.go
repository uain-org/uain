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

func TestSDKGuardianContinuityMaximumAndRestart(t *testing.T) {
	members := []federation.Member{}
	keys := map[string]ed25519.PrivateKey{}
	original, next := []string{}, []string{}
	for i := 0; i < 40; i++ {
		m, key := testMember(fmt.Sprintf("guardian-%02d", i))
		m.Name += strings.Repeat("<", 120-len(m.Name))
		m.Operator += strings.Repeat("<", 200-len(m.Operator))
		m.Family += strings.Repeat("<", 100-len(m.Family))
		m.Credits = strings.Repeat("6", 78)
		members = append(members, m)
		keys[m.ID] = key
		if i < 20 {
			original = append(original, m.ID)
		} else {
			next = append(next, m.ID)
		}
	}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: original, Members: members})
	height := int64(0)
	seq := map[string]uint64{}
	digest := strings.Repeat("a", 64)
	var result *abci.ResponseFinalizeBlock
	send := func(m federation.Member, op string, p any, ok bool) {
		t.Helper()
		height++
		raw := testEnvelope(t, m, keys[m.ID], seq[m.ID], op, p)
		if ok && (op == "guardian_propose" || op == "guardian_execute") {
			now := time.Unix(1000+height, 0).UTC()
			prepared, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: height, Time: now, MaxTxBytes: int64(ProposalBytes), Txs: [][]byte{raw}})
			if err != nil || len(prepared.Txs) != 1 {
				t.Fatal("guardian transaction omitted from proposal", op, prepared, err)
			}
			processed, err := a.ProcessProposal(&abci.RequestProcessProposal{Height: height, Time: now, Txs: prepared.Txs})
			if err != nil || processed.Status != abci.ResponseProcessProposal_ACCEPT {
				t.Fatal("guardian proposal rejected", op, processed, err)
			}
		}
		result = block(t, a, height, raw)
		tx := result.TxResults[0]
		if (tx.Code == 0) != ok {
			t.Fatalf("%s code=%d gas=%d %s", op, tx.Code, tx.GasUsed, tx.Log)
		}
		if ok {
			seq[m.ID]++
			if tx.GasUsed >= int64(TransactionGas) {
				t.Fatal("transaction gas bound exceeded", op, tx.GasUsed)
			}
		}
		if op == "guardian_execute" && ok {
			t.Logf("max20 guardian handover SDK gas=%d", tx.GasUsed)
		}
	}
	query := func(key string) []byte {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: height, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(key, q, err)
		}
		if err := proof.VerifyQuery(*q, key, result.AppHash, height); err != nil {
			t.Fatal(key, err)
		}
		return bytes.Clone(q.Value)
	}
	send(members[0], "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(members[0], "guardian_propose", map[string]any{"id": "full", "base_epoch": "", "guardians": next, "expires_height": 90, "evidence_digest": digest}, true)
	genesisBytes := query("guardians")
	action := map[string]any{"proposal": "full", "evidence_digest": digest}
	for i := 0; i < 11; i++ {
		send(members[i], "guardian_vote", action, true)
	}
	send(members[0], "guardian_execute", action, false)
	for i := 20; i < 40; i++ {
		send(members[i], "guardian_consent", action, true)
	}
	send(members[0], "guardian_execute", action, true)
	epochBytes := query("guardian_epoch/full")
	var epoch federation.GuardianEpoch
	if err := json.Unmarshal(epochBytes, &epoch); err != nil || len(epoch.Guardians) != 20 || epoch.Height != height {
		t.Fatal(epoch, err)
	}
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(epochBytes, query("guardian_epoch/full")) || !bytes.Equal(genesisBytes, query("guardians")) {
		t.Fatal("restart rewrote history")
	}
	role := map[string]any{"member": members[1].ID, "creator": true, "default_verifier": false, "evidence_digest": digest}
	send(members[0], "roles", role, false)
	send(members[20], "roles", role, true)
}

func TestSDKGuardianContinuitySoleGuardianCannotWithdraw(t *testing.T) {
	guardian, key := testMember("sole guardian")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{guardian}})
	for i, op := range []string{"withdraw", "licence"} {
		p := map[string]any{}
		if op == "licence" {
			p = map[string]any{"member": guardian.ID, "status": "revoked", "evidence_digest": strings.Repeat("a", 64)}
		}
		r := block(t, a, int64(i+1), testEnvelope(t, guardian, key, 0, op, p))
		if r.TxResults[0].Code == 0 {
			t.Fatal("sole guardian manual exit committed", op)
		}
	}
}
