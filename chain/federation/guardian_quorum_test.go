package federation

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
)

// quorumFixture: three guardians under a 2-of-3 threshold (generation 2).
func quorumFixture(t *testing.T) (Keeper, [3]actor, actor, actor) {
	t.Helper()
	var g [3]actor
	for i := range g {
		g[i] = newActor(fmt.Sprintf("guardian-%d", i), fmt.Sprintf("custody %d", i), 100, true, false)
	}
	applicant := newActor("applicant", "operator X", 0, false, false)
	applicant.m.Licence = "pending"
	outsider := newActor("outsider", "operator Y", 100, false, false)
	k := Keeper{Store: memory{}}
	vk := make([]byte, 32)
	vk[0] = 1
	err := k.Init(Genesis{Version: 1, Generation: 2, Guardians: []string{g[0].m.ID, g[1].m.ID, g[2].m.ID}, GuardianThreshold: 2, Members: []Member{g[0].m, g[1].m, g[2].m, applicant.m, outsider.m}, Validators: []GenesisValidator{{PubKey: base64.StdEncoding.EncodeToString(vk), Power: 10, Name: "val-1"}}})
	if err != nil {
		t.Fatal(err)
	}
	return k, g, applicant, outsider
}

func quorumAction(id, op string, payload any, expires int64) map[string]any {
	return map[string]any{"id": id, "operation": op, "payload": payload, "expires_height": expires, "evidence_digest": digest}
}

func TestGuardianQuorumGenesisThresholdValidation(t *testing.T) {
	a, b, c := newActor("alpha", "op alpha", 1, false, false), newActor("beta", "op beta", 1, false, false), newActor("gamma", "op gamma", 1, false, false)
	members := []Member{a.m, b.m, c.m}
	ids := []string{a.m.ID, b.m.ID, c.m.ID}
	for _, bad := range []int{1, 4, -1} {
		if err := (Keeper{Store: memory{}}).Init(Genesis{Version: 1, Generation: 2, Guardians: ids, GuardianThreshold: bad, Members: members}); err == nil {
			t.Fatalf("threshold %d accepted for three guardians", bad)
		}
	}
	if err := (Keeper{Store: memory{}}).Init(Genesis{Version: 1, Generation: 2, Guardians: ids, Members: members}); err == nil {
		t.Fatal("generation 2 accepted several guardians without a threshold")
	}
	if err := (Keeper{Store: memory{}}).Init(Genesis{Version: 1, Generation: 3, Guardians: ids[:1], Members: members}); err == nil {
		t.Fatal("unknown genesis generation accepted")
	}
	if err := (Keeper{Store: memory{}}).Init(Genesis{Version: 1, Generation: 2, Guardians: ids, GuardianThreshold: 2, Members: members}); err != nil {
		t.Fatal(err)
	}
}

func TestGuardianQuorumOneOfThreeRefusedTwoOfThreeExecutes(t *testing.T) {
	k, g, applicant, outsider := quorumFixture(t)
	licence := map[string]any{"member": applicant.m.ID, "status": "active", "evidence_digest": digest}
	// A single guardian signature no longer passes any guardian gate.
	guardianReject(t, k, g[0], "licence", licence, 1)
	guardianReject(t, k, g[0], "upgrade_schedule", map[string]any{"name": "v0-4-1", "height": "50", "evidence_digest": digest}, 1)
	// Outsiders cannot propose or approve; quorum ops cannot be nested.
	guardianReject(t, k, outsider, "guardian_action_propose", quorumAction("lic-1", "licence", licence, 20), 1)
	guardianReject(t, k, g[0], "guardian_action_propose", quorumAction("nest", "guardian_action_approve", map[string]any{"id": "x", "evidence_digest": digest}, 20), 1)
	guardianReject(t, k, g[0], "guardian_action_propose", quorumAction("long", "licence", licence, 1000), 1)
	// One of three: recorded, not executed.
	command(t, k, g[0], "guardian_action_propose", quorumAction("lic-1", "licence", licence, 20), 2)
	if m, _ := k.Member(applicant.m.ID); m.Licence != "pending" {
		t.Fatal("one guardian of three granted a licence")
	}
	guardianReject(t, k, g[0], "guardian_action_approve", map[string]any{"id": "lic-1", "evidence_digest": digest}, 3)
	guardianReject(t, k, outsider, "guardian_action_approve", map[string]any{"id": "lic-1", "evidence_digest": digest}, 3)
	// Two of three: executes once, atomically.
	command(t, k, g[1], "guardian_action_approve", map[string]any{"id": "lic-1", "evidence_digest": digest}, 3)
	if m, _ := k.Member(applicant.m.ID); m.Licence != "active" {
		t.Fatal("two of three guardians did not grant the licence")
	}
	action, err := k.GuardianActionState("lic-1")
	if err != nil || action.Executed != 3 || len(action.Approvals) != 2 || action.Subject != applicant.m.ID {
		t.Fatal("executed action record wrong", action, err)
	}
	guardianReject(t, k, g[2], "guardian_action_approve", map[string]any{"id": "lic-1", "evidence_digest": digest}, 4)
	guardianReject(t, k, g[0], "guardian_action_propose", quorumAction("lic-1", "licence", licence, 20), 4)
	// The quorum authority does not leak into later single-signer commands.
	guardianReject(t, k, g[1], "licence", map[string]any{"member": outsider.m.ID, "status": "revoked", "evidence_digest": digest}, 5)
}

func TestGuardianQuorumFailureExpiryAndRevokedApprover(t *testing.T) {
	k, g, applicant, _ := quorumFixture(t)
	// A failing inner operation fails the approving transaction; the action
	// stays pending and can still execute once its cause is fixed.
	bad := map[string]any{"member": applicant.m.ID, "status": "active", "evidence_digest": "not-a-digest"}
	command(t, k, g[0], "guardian_action_propose", quorumAction("bad", "licence", bad, 20), 2)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "bad", "evidence_digest": digest}, 3)
	if a, _ := k.GuardianActionState("bad"); a.Executed != 0 || len(a.Approvals) != 1 {
		t.Fatal("failed execution changed the action", a)
	}
	// Expiry.
	licence := map[string]any{"member": applicant.m.ID, "status": "active", "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("late", "licence", licence, 5), 3)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "late", "evidence_digest": digest}, 6)
	// An approval stops counting when its guardian loses the licence.
	command(t, k, g[0], "guardian_action_propose", quorumAction("held", "licence", licence, 30), 7)
	m := g[0].m
	m.Licence = "revoked"
	_ = put(k.Store, "member/"+m.ID, m)
	// The revoked guardian's approval no longer counts, and an action whose
	// proposer lost the licence cannot execute even with two other approvals.
	command(t, k, g[1], "guardian_action_approve", map[string]any{"id": "held", "evidence_digest": digest}, 8)
	if a, _ := k.GuardianActionState("held"); a.Executed != 0 {
		t.Fatal("revoked guardian's approval counted")
	}
	guardianReject(t, k, g[2], "guardian_action_approve", map[string]any{"id": "held", "evidence_digest": digest}, 8)
	command(t, k, g[1], "guardian_action_propose", quorumAction("fresh", "licence", licence, 30), 8)
	command(t, k, g[2], "guardian_action_approve", map[string]any{"id": "fresh", "evidence_digest": digest}, 9)
	if m, _ := k.Member(applicant.m.ID); m.Licence != "active" {
		t.Fatal("remaining two guardians could not act")
	}
}

func TestGuardianQuorumHandoverMustKeepThreshold(t *testing.T) {
	k, g, applicant, outsider := quorumFixture(t)
	next := []string{g[1].m.ID, g[2].m.ID, outsider.m.ID}
	p := guardianProposal("rotate", "", next, 20)
	guardianReject(t, k, g[0], "guardian_propose", p, 2)
	p["threshold"] = 1
	guardianReject(t, k, g[0], "guardian_propose", p, 2)
	p["threshold"] = 2
	command(t, k, g[0], "guardian_propose", p, 2)
	command(t, k, g[0], "guardian_vote", guardianAction("rotate"), 2)
	command(t, k, g[1], "guardian_vote", guardianAction("rotate"), 2)
	command(t, k, outsider, "guardian_consent", guardianAction("rotate"), 2)
	command(t, k, g[1], "guardian_execute", guardianAction("rotate"), 3)
	if th, err := k.GuardianThreshold(); err != nil || th != 2 || k.guardianMember(g[0].m.ID) || !k.guardianMember(outsider.m.ID) {
		t.Fatal("handover threshold or set wrong", th, err)
	}
	licence := map[string]any{"member": applicant.m.ID, "status": "active", "evidence_digest": digest}
	guardianReject(t, k, g[0], "guardian_action_propose", quorumAction("old", "licence", licence, 20), 4)
	command(t, k, outsider, "guardian_action_propose", quorumAction("new", "licence", licence, 20), 4)
	command(t, k, g[2], "guardian_action_approve", map[string]any{"id": "new", "evidence_digest": digest}, 5)
	if m, _ := k.Member(applicant.m.ID); m.Licence != "active" {
		t.Fatal("successor quorum could not act")
	}
}

func TestLegacySingleGuardianUnchanged(t *testing.T) {
	k, _, peer, g := fixture(t)
	if th, err := k.GuardianThreshold(); err != nil || th != 1 || !k.guardian(g.m.ID) || k.guardian(peer.m.ID) {
		t.Fatal("legacy chain lost its single-guardian rule", th, err)
	}
	if k.consensusV2() {
		t.Fatal("generation 1 genesis activated consensus v2")
	}
}

func validatorKey(t *testing.T) string {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(pub)
}

func TestValidatorSetUpdateNeedsQuorumAndKeepsCometInvariants(t *testing.T) {
	k, g, _, _ := quorumFixture(t)
	set, _ := k.Validators()
	if len(set) != 1 || set[0].Power != 10 {
		t.Fatal("genesis validators not recorded", set)
	}
	a, b := validatorKey(t), validatorKey(t)
	add := map[string]any{"updates": []map[string]any{{"pub_key": a, "power": "10", "name": "val-2"}, {"pub_key": b, "power": "10", "name": "val-3"}}, "evidence_digest": digest}
	guardianReject(t, k, g[0], "validator_set_update", add, 2)
	command(t, k, g[0], "guardian_action_propose", quorumAction("add", "validator_set_update", add, 20), 2)
	command(t, k, g[2], "guardian_action_approve", map[string]any{"id": "add", "evidence_digest": digest}, 3)
	changes, err := k.ApplyValidatorUpdates(3)
	if err != nil || len(changes) != 2 {
		t.Fatal("pending updates not applied", changes, err)
	}
	if set, _ = k.Validators(); len(set) != 3 {
		t.Fatal("validator set not updated", set)
	}
	var epoch ValidatorEpoch
	if err = get(k.Store, "validator_epoch/00000000000000000001", &epoch); err != nil || epoch.HeaderHeight != 4 || len(epoch.Validators) != 3 || epoch.EvidenceDigest != digest {
		t.Fatal("validator epoch not recorded", epoch, err)
	}
	if again, _ := k.ApplyValidatorUpdates(4); len(again) != 0 {
		t.Fatal("updates applied twice")
	}
	// Removing an unknown validator, or every validator, would halt CometBFT.
	unknown := map[string]any{"updates": []map[string]any{{"pub_key": validatorKey(t), "power": "0"}}, "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("unknown", "validator_set_update", unknown, 20), 5)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "unknown", "evidence_digest": digest}, 5)
	all := []map[string]any{}
	for _, v := range set {
		all = append(all, map[string]any{"pub_key": v.PubKey, "power": "0"})
	}
	empty := map[string]any{"updates": all, "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("empty", "validator_set_update", empty, 20), 6)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "empty", "evidence_digest": digest}, 6)
	dup := map[string]any{"updates": []map[string]any{{"pub_key": a, "power": "5"}, {"pub_key": a, "power": "6"}}, "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("dup", "validator_set_update", dup, 20), 7)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "dup", "evidence_digest": digest}, 7)
	// Rotation: replace one validator in one signed change.
	c := validatorKey(t)
	rotate := map[string]any{"updates": []map[string]any{{"pub_key": a, "power": "0"}, {"pub_key": c, "power": "10", "name": "val-4"}}, "evidence_digest": digest}
	command(t, k, g[1], "guardian_action_propose", quorumAction("rotate", "validator_set_update", rotate, 20), 8)
	command(t, k, g[2], "guardian_action_approve", map[string]any{"id": "rotate", "evidence_digest": digest}, 8)
	if changes, err = k.ApplyValidatorUpdates(8); err != nil || len(changes) != 2 {
		t.Fatal(changes, err)
	}
	set, _ = k.Validators()
	raw, _ := json.Marshal(set)
	if len(set) != 3 || json.Valid(raw) == false || string(raw) == "" {
		t.Fatal("rotation result wrong", set)
	}
	for _, v := range set {
		if v.PubKey == a {
			t.Fatal("rotated-out validator remains")
		}
	}
}

func TestUpgradeScheduleNeedsQuorumAndFutureHeight(t *testing.T) {
	k, g, _, _ := quorumFixture(t)
	plan := map[string]any{"name": "v0-4-1", "height": "40", "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("up", "upgrade_schedule", plan, 20), 2)
	command(t, k, g[1], "guardian_action_approve", map[string]any{"id": "up", "evidence_digest": digest}, 3)
	p, err := k.PendingUpgrade()
	if err != nil || p == nil || p.Name != "v0-4-1" || p.Height != 40 {
		t.Fatal("upgrade plan not recorded", p, err)
	}
	if err = k.CompleteUpgrade(*p, 40); err != nil || !k.UpgradeDone("v0-4-1") {
		t.Fatal(err)
	}
	if p, _ = k.PendingUpgrade(); p != nil {
		t.Fatal("completed plan still pending")
	}
	command(t, k, g[0], "guardian_action_propose", quorumAction("again", "upgrade_schedule", plan, 50), 41)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "again", "evidence_digest": digest}, 41)
	soon := map[string]any{"name": "v0-4-2", "height": "43", "evidence_digest": digest}
	command(t, k, g[0], "guardian_action_propose", quorumAction("soon", "upgrade_schedule", soon, 50), 42)
	guardianReject(t, k, g[1], "guardian_action_approve", map[string]any{"id": "soon", "evidence_digest": digest}, 42)
}

func TestCentralAdoptionUsesPerProjectFinanceIndex(t *testing.T) {
	k, _, _, _ := centralFixture(t)
	_ = put(k.Store, "consensus_v2_activation", ConsensusV2Activation{Policy: ConsensusV2Policy})
	for i := 0; i < 2*CentralLegacyFinancialAuditLimit; i++ {
		id := fmt.Sprintf("T-priced-%03d", i)
		put(k.Store, "task/"+id, Task{ID: id, Project: "P-other"})
		put(k.Store, "coin_quote/"+id, CoinQuote{Task: id, Amount: "1"})
		if err := k.indexProjectFinance("P-other"); err != nil {
			t.Fatal(err)
		}
	}
	if e := k.centralAdoptionFinancialAudit("P-central"); e != nil {
		t.Fatal("unrelated quotes beyond the old 128-row bound blocked adoption", e)
	}
	if e := k.centralAdoptionFinancialAudit("P-other"); e == nil {
		t.Fatal("indexed project with Coin history adopted")
	}
}
