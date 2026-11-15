package federation

import (
	"bytes"
	"testing"
)

func TestVoluntarySkillResultsRequireAppointedManagerOutsideMemberAndNeverReward(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	command(t, k, guardian, "skill_manager_appoint", map[string]any{"member": peer.m.ID, "active": true, "evidence_digest": digest}, 1)
	command(t, k, peer, "skill_test_define", map[string]any{"id": "ST-1", "title": "A voluntary bounded reasoning test", "rubric_digest": digest, "max_score": 100}, 2)
	command(t, k, lead, "skill_attempt", map[string]any{"id": "SA-1", "test": "ST-1", "evidence_digest": digest}, 3)
	rejectCommand(t, k, lead, "", "skill_grade", map[string]any{"attempt": "SA-1", "score": 75, "evidence_digest": digest}, 4)
	command(t, k, peer, "skill_grade", map[string]any{"attempt": "SA-1", "score": 75, "evidence_digest": digest}, 4)
	var result struct {
		Score  int64  `json:"score"`
		Member string `json:"member"`
	}
	if e := get(k.Store, "skill_result/SA-1", &result); e != nil || result.Score != 75 || result.Member != lead.m.ID {
		t.Fatal(result, e)
	}
	if k.Store.Get([]byte("skill_result_actor/"+operatorActorKey(lead.m.ID, "")+"/SA-1")) == nil {
		t.Fatal("profile cannot discover its skill result")
	}
	m, _ := k.Member(lead.m.ID)
	p, _ := k.Member(peer.m.ID)
	if m.Karma != lead.m.Karma || p.Karma != peer.m.Karma || m.Credits != "0" || p.Credits != "0" || len(allCredits(t, k)) != 0 {
		t.Fatal("voluntary skill tests changed rewards", m, p)
	}
	before := bytes.Clone(k.Store.Get([]byte("skill_result/SA-1")))
	rejectCommand(t, k, peer, "", "skill_grade", map[string]any{"attempt": "SA-1", "score": 100, "evidence_digest": digest}, 5)
	if !bytes.Equal(before, k.Store.Get([]byte("skill_result/SA-1"))) {
		t.Fatal("skill result overwritten")
	}
}
func TestResourceAgreementConservesCapacityAndBindsBothMembersReceipt(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	offer := map[string]any{"id": "RO-1", "capability": "bounded CPU execution", "class": "neutral", "capacity": "10", "unit": "cpu_seconds", "terms_digest": digest, "expires_height": "100"}
	command(t, k, lead, "resource_offer", offer, 1)
	if k.Store.Get([]byte("resource_offer_provider/"+operatorActorKey(lead.m.ID, "")+"/RO-1")) == nil {
		t.Fatal("supplier cannot discover its resource offer")
	}
	command(t, k, peer, "resource_accept", map[string]any{"id": "RA-1", "offer": "RO-1", "units": "7", "purpose_digest": digest}, 2)
	rejectCommand(t, k, guardian, "", "resource_accept", map[string]any{"id": "RA-2", "offer": "RO-1", "units": "4", "purpose_digest": digest}, 3)
	rejectCommand(t, k, peer, "", "resource_receipt", map[string]any{"agreement": "RA-1", "used": "7", "evidence_digest": digest, "result_digest": digest}, 3)
	command(t, k, lead, "resource_receipt", map[string]any{"agreement": "RA-1", "used": "6", "evidence_digest": digest, "result_digest": digest}, 3)
	rejectCommand(t, k, guardian, "", "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "accepted", "evidence_digest": digest}, 4)
	command(t, k, peer, "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "accepted", "evidence_digest": digest}, 4)
	var a struct {
		State     string `json:"state"`
		Remaining string `json:"remaining"`
	}
	if e := get(k.Store, "resource_offer/RO-1", &a); e != nil || a.Remaining != "3" {
		t.Fatal(a, e)
	}
	var ack struct {
		Verdict string `json:"verdict"`
	}
	if e := get(k.Store, "resource_ack/RA-1", &ack); e != nil || ack.Verdict != "accepted" {
		t.Fatal(ack, e)
	}
	rejectCommand(t, k, peer, "", "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "disputed", "evidence_digest": digest}, 5)
	if len(allCredits(t, k)) != 0 {
		t.Fatal("a resource assertion minted a reward")
	}
}

func TestSkillManagerRevocationBoundsAndEvidenceProofDependencies(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	command(t, k, guardian, "skill_manager_appoint", map[string]any{"member": peer.m.ID, "active": true, "evidence_digest": digest}, 1)
	command(t, k, peer, "skill_test_define", map[string]any{"id": "ST-1", "title": "Voluntary score bounds fixture", "rubric_digest": digest, "max_score": 10}, 2)
	rejectCommand(t, k, peer, "", "skill_attempt", map[string]any{"id": "SA-self", "test": "ST-1", "evidence_digest": digest}, 3)
	command(t, k, lead, "skill_attempt", map[string]any{"id": "SA-1", "test": "ST-1", "evidence_digest": digest}, 3)
	for _, score := range []int64{-1, 11} {
		rejectCommand(t, k, peer, "", "skill_grade", map[string]any{"attempt": "SA-1", "score": score, "evidence_digest": digest}, 4)
	}
	command(t, k, guardian, "skill_manager_appoint", map[string]any{"member": peer.m.ID, "active": false, "evidence_digest": digest}, 4)
	rejectCommand(t, k, peer, "", "skill_grade", map[string]any{"attempt": "SA-1", "score": 10, "evidence_digest": digest}, 5)
	command(t, k, guardian, "skill_manager_appoint", map[string]any{"member": peer.m.ID, "active": true, "evidence_digest": digest}, 6)
	command(t, k, peer, "skill_grade", map[string]any{"attempt": "SA-1", "score": 10, "evidence_digest": digest}, 7)
	command(t, k, guardian, "skill_manager_appoint", map[string]any{"member": peer.m.ID, "active": false, "evidence_digest": digest}, 8)
	if _, e := k.SkillResult("SA-1"); e != nil {
		t.Fatal("later role change erased historical result", e)
	}
	k.Store.Delete([]byte("skill_attempt/SA-1"))
	if _, e := k.SkillResult("SA-1"); e == nil {
		t.Fatal("unbound skill result accepted")
	}
}
func TestResourceExpiryWithdrawalSelfDealingAndReceiptBounds(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	command(t, k, lead, "resource_offer", map[string]any{"id": "RO-1", "capability": "bounded execution fixture", "class": "neutral", "capacity": "10", "unit": "executions", "terms_digest": digest, "expires_height": "20"}, 1)
	rejectCommand(t, k, lead, "", "resource_accept", map[string]any{"id": "RA-self", "offer": "RO-1", "units": "1", "purpose_digest": digest}, 2)
	command(t, k, peer, "resource_accept", map[string]any{"id": "RA-1", "offer": "RO-1", "units": "7", "purpose_digest": digest}, 2)
	rejectCommand(t, k, lead, "", "resource_receipt", map[string]any{"agreement": "RA-1", "used": "8", "evidence_digest": digest, "result_digest": digest}, 3)
	rejectCommand(t, k, guardian, "", "resource_withdraw", map[string]any{"offer": "RO-1"}, 3)
	command(t, k, lead, "resource_withdraw", map[string]any{"offer": "RO-1"}, 3)
	rejectCommand(t, k, guardian, "", "resource_accept", map[string]any{"id": "RA-2", "offer": "RO-1", "units": "1", "purpose_digest": digest}, 4)
	// Withdrawal stops new allocations but preserves the bilateral acceptance.
	command(t, k, lead, "resource_receipt", map[string]any{"agreement": "RA-1", "used": "7", "evidence_digest": digest, "result_digest": digest}, 4)
	command(t, k, peer, "resource_acknowledge", map[string]any{"agreement": "RA-1", "verdict": "disputed", "evidence_digest": digest}, 5)
	out, e := k.ResourceCollaboration("RA-1")
	if e != nil || out.State.State != "disputed" {
		t.Fatal(out, e)
	}
	k.Store.Delete([]byte("resource_receipt/RA-1"))
	if _, e = k.ResourceCollaboration("RA-1"); e == nil {
		t.Fatal("missing provider receipt accepted")
	}
	command(t, k, lead, "resource_offer", map[string]any{"id": "RO-2", "capability": "bounded execution fixture", "class": "neutral", "capacity": "1", "unit": "executions", "terms_digest": digest, "expires_height": "10"}, 6)
	rejectCommand(t, k, peer, "", "resource_accept", map[string]any{"id": "RA-expired", "offer": "RO-2", "units": "1", "purpose_digest": digest}, 10)
}
