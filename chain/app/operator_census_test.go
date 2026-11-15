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

func TestSDKOperatorCensusBoundedPagesProofRollbackAndRestart(t *testing.T) {
	guardian, key := testMember("operator census guardian")
	guardian.Operator = "shared operator"
	members := []federation.Member{guardian}
	for i := 0; i < 69; i++ {
		m, _ := testMember(fmt.Sprintf("census actor %d", i))
		m.Operator = guardian.Operator
		members = append(members, m)
	}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	var seq uint64
	var h int64
	var result *abci.ResponseFinalizeBlock
	send := func(op string, p any, ok bool) {
		t.Helper()
		h++
		result = block(t, a, h, testEnvelope(t, guardian, key, seq, op, p))
		if (result.TxResults[0].Code == 0) != ok {
			t.Fatal(op, result.TxResults[0].Log)
		}
		if ok {
			seq++
		}
	}
	query := func(record string) abci.ResponseQuery {
		t.Helper()
		q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if err != nil || q.Code != 0 {
			t.Fatal(record, q, err)
		}
		if err = proof.VerifyQuery(*q, record, result.AppHash, h); err != nil {
			t.Fatal(err)
		}
		return *q
	}
	bundle := func() []abci.ResponseQuery {
		return []abci.ResponseQuery{query("operator_census_activation"), query("operator_census_revision"), query("operator_census")}
	}
	digest := strings.Repeat("a", 64)
	send("activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send("activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest}, true)
	send("activate_operator_census", map[string]any{"policy": federation.OperatorCensusPolicy, "threshold": 3, "evidence_digest": digest}, true)
	for i := 0; i < 3; i++ {
		send("operator_census_page", map[string]any{}, true)
		status, err := proof.VerifyBootstrapState(bundle(), result.AppHash, h)
		if err != nil || status.Ready != (i == 2) || status.Active != (i == 2) || status.Operators != 1 {
			t.Fatal(status, err)
		}
		if result.TxResults[0].GasUsed >= 3000000 {
			t.Fatal("census page exceeds transaction budget", result.TxResults[0].GasUsed)
		}
		t.Logf("census page %d gas %d", i+1, result.TxResults[0].GasUsed)
	}
	member, progress := query("member/"+guardian.ID), query("operator_census")
	send("operator_census_page", map[string]any{"cursor": "skip"}, false)
	if !bytes.Equal(member.Value, query("member/"+guardian.ID).Value) || !bytes.Equal(progress.Value, query("operator_census").Value) {
		t.Fatal("invalid page changed progress or sequence")
	}
	var err error
	a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	h++
	result = block(t, a, h)
	status, err := proof.VerifyBootstrapState(bundle(), result.AppHash, h)
	if err != nil || !status.Ready || !status.Active {
		t.Fatal("restart lost completed census", status, err)
	}
	if _, err = proof.VerifyBootstrapState(bundle()[:2], result.AppHash, h); err == nil {
		t.Fatal("omitted census dependency accepted")
	}
	corrupt := bundle()
	corrupt[2].Value = append(bytes.Clone(corrupt[2].Value), ' ')
	if _, err = proof.VerifyBootstrapState(corrupt, result.AppHash, h); err == nil {
		t.Fatal("forged census proof accepted")
	}
	send("licence", map[string]any{"member": members[1].ID, "status": "revoked", "evidence_digest": digest}, true)
	status, err = proof.VerifyBootstrapState(bundle(), result.AppHash, h)
	if err != nil || status.Ready || status.Active {
		t.Fatal("current revision accepted stale census", status, err)
	}
	var stored federation.OperatorCensus
	if err = json.Unmarshal(query("operator_census").Value, &stored); err != nil || !stored.Complete {
		t.Fatal("invalidating revision erased previous evidence", stored, err)
	}
}
