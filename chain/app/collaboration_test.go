package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKSkillAndRealExecutionReceiptProofsRollbackAndRestart(t *testing.T) {
	guardian, gkey := testMember("collaboration guardian")
	supplier, skey := testMember("supplier")
	consumer, ckey := testMember("consumer")
	members := []federation.Member{guardian, supplier, consumer}
	keys := map[string]ed25519.PrivateKey{guardian.ID: gkey, supplier.ID: skey, consumer.ID: ckey}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	var h int64
	seq := map[string]uint64{}
	var result *abci.ResponseFinalizeBlock
	send := func(m federation.Member, op string, p any, want bool) {
		t.Helper()
		h++
		raw := testEnvelope(t, m, keys[m.ID], seq[m.ID], op, p)
		result = block(t, a, h, raw)
		if (result.TxResults[0].Code == 0) != want {
			t.Fatal(op, result.TxResults[0].Log)
		}
		if want {
			seq[m.ID]++
		}
		if result.TxResults[0].GasUsed >= 3000000 {
			t.Fatal(op, "exceeded gas bound", result.TxResults[0].GasUsed)
		}
	}
	digest := strings.Repeat("a", 64)
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(guardian, "skill_manager_appoint", map[string]any{"member": supplier.ID, "active": true, "evidence_digest": digest}, true)
	send(supplier, "skill_test_define", map[string]any{"id": "ST-1", "title": "Voluntary bounded skill fixture", "rubric_digest": digest, "max_score": 100}, true)
	send(consumer, "skill_attempt", map[string]any{"id": "SA-1", "test": "ST-1", "evidence_digest": digest}, true)
	send(consumer, "skill_grade", map[string]any{"attempt": "SA-1", "score": 100, "evidence_digest": digest}, false)
	send(supplier, "skill_grade", map[string]any{"attempt": "SA-1", "score": 83, "evidence_digest": digest}, true)
	send(supplier, "resource_offer", map[string]any{"id": "RO-1", "capability": "SHA256 execution on the isolated test server", "class": "neutral", "capacity": "10", "unit": "executions", "terms_digest": digest, "expires_height": "1000"}, true)
	send(consumer, "resource_accept", map[string]any{"id": "RA-1", "offer": "RO-1", "units": "1", "purpose_digest": digest}, true)
	// Execute on this isolated server, then independently compare the published
	// receipt digest with the well-known fixture. No reward or live task is seeded.
	sum := sha256.Sum256([]byte("abc"))
	actual := hex.EncodeToString(sum[:])
	expected := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if actual != expected {
		t.Fatal("resource fixture execution differs", actual)
	}
	send(supplier, "resource_receipt", map[string]any{"agreement": "RA-1", "used": "1", "evidence_digest": digest, "result_digest": actual}, true)
	send(guardian, "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "accepted", "evidence_digest": digest}, false)
	send(consumer, "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "accepted", "evidence_digest": digest}, true)
	query := func(key string) abci.ResponseQuery {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(key, q, e)
		}
		return *q
	}
	before := bytes.Clone(query("resource_agreement/RA-1").Value)
	send(consumer, "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "disputed", "evidence_digest": digest}, false)
	if !bytes.Equal(before, query("resource_agreement/RA-1").Value) {
		t.Fatal("failed acknowledgement changed state")
	}
	var e error
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	h++
	result = block(t, a, h)
	skillBundle := []abci.ResponseQuery{query("skill_result/SA-1"), query("skill_attempt/SA-1"), query("skill_test/ST-1")}
	skill, e := proof.VerifySkillResult(skillBundle, "SA-1", result.AppHash, h)
	if e != nil || skill.Score != 83 || skill.Member != consumer.ID {
		t.Fatal(skill, e)
	}
	if _, e = proof.VerifySkillResult(skillBundle[:2], "SA-1", result.AppHash, h); e == nil {
		t.Fatal("missing rubric definition accepted")
	}
	resourceBundle := []abci.ResponseQuery{query("resource_agreement/RA-1"), query("resource_acceptance/RA-1"), query("resource_terms/RO-1"), query("resource_receipt/RA-1"), query("resource_ack/RA-1")}
	collaboration, e := proof.VerifyResourceCollaboration(resourceBundle, "RA-1", result.AppHash, h)
	if e != nil || collaboration.State.State != "complete" || collaboration.Receipt.ResultDigest != expected {
		t.Fatal(collaboration, e)
	}
	if _, e = proof.VerifyResourceCollaboration(append(append([]abci.ResponseQuery{}, resourceBundle[:3]...), resourceBundle[4]), "RA-1", result.AppHash, h); e == nil {
		t.Fatal("missing execution receipt accepted")
	}
	bad := append([]abci.ResponseQuery{}, resourceBundle...)
	bad[3].Height--
	if _, e = proof.VerifyResourceCollaboration(bad, "RA-1", result.AppHash, h); e == nil {
		t.Fatal("mixed-height receipt accepted")
	}
	for _, m := range []federation.Member{supplier, consumer} {
		var account federation.Member
		if e = json.Unmarshal(query("member/"+m.ID).Value, &account); e != nil || account.Karma != m.Karma || account.Credits != m.Credits {
			t.Fatal("collaboration changed nonmonetary standing", account, e)
		}
	}
}
