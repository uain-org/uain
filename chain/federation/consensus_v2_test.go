package federation

import (
	"bytes"
	"encoding/json"
	"testing"
)

// Before activation every 0.4 rule is inert: new operations fail exactly as
// unknown ones did, and guardian thresholds are refused.
func TestConsensusV2InertUntilActivated(t *testing.T) {
	k, lead, peer, g := fixture(t)
	for _, op := range []string{"guardian_action_propose", "guardian_action_approve", "validator_set_update", "upgrade_schedule"} {
		before, _ := json.Marshal(k.Store)
		_, err := apply(k, signed(t, k, g, op, map[string]any{}, 1), 1)
		after, _ := json.Marshal(k.Store)
		if err == nil || err.Error() != "unsupported federation operation" || !bytes.Equal(before, after) {
			t.Fatalf("%s before activation: %v", op, err)
		}
	}
	p := guardianProposal("quorum", "", []string{g.m.ID, lead.m.ID, peer.m.ID}, 20)
	p["threshold"] = 2
	guardianReject(t, k, g, "guardian_propose", p, 2)
	// Only a guardian activates, once.
	guardianReject(t, k, lead, "activate_consensus_v2", map[string]any{"policy": ConsensusV2Policy, "evidence_digest": digest}, 2)
	guardianReject(t, k, g, "activate_consensus_v2", map[string]any{"policy": "other", "evidence_digest": digest}, 2)
	command(t, k, g, "activate_consensus_v2", map[string]any{"policy": ConsensusV2Policy, "evidence_digest": digest}, 3)
	guardianReject(t, k, g, "activate_consensus_v2", map[string]any{"policy": ConsensusV2Policy, "evidence_digest": digest}, 4)
	if !k.consensusV2() {
		t.Fatal("activation not recorded")
	}
}

// The in-place path Rahul chose: one chain, the existing single guardian
// hands authority to three guardian keys under a 2-of-3 threshold through
// the existing consented handover, after which one guardian alone is refused.
func TestInPlaceHandoverToTwoOfThree(t *testing.T) {
	k, lead, peer, g := fixture(t)
	g1 := newActor("guardian-one", "app vault", 100, false, false)
	g2 := newActor("guardian-two", "database host", 100, false, false)
	g3 := newActor("guardian-three", "third server", 100, false, false)
	for _, a := range []actor{g1, g2, g3} {
		_ = put(k.Store, "member/"+a.m.ID, a.m)
	}
	command(t, k, g, "activate_consensus_v2", map[string]any{"policy": ConsensusV2Policy, "evidence_digest": digest}, 1)
	p := guardianProposal("quorum", "", []string{g1.m.ID, g2.m.ID, g3.m.ID}, 20)
	p["threshold"] = 2
	command(t, k, g, "guardian_propose", p, 2)
	for _, a := range []actor{g1, g2, g3} {
		command(t, k, a, "guardian_consent", guardianAction("quorum"), 2)
	}
	command(t, k, g, "guardian_vote", guardianAction("quorum"), 2)
	command(t, k, g, "guardian_execute", guardianAction("quorum"), 3)
	if th, err := k.GuardianThreshold(); err != nil || th != 2 || k.guardianMember(g.m.ID) {
		t.Fatal("handover to 2-of-3 failed", th, err)
	}
	// The former guardian (today's reviewer/lead identity) keeps its key and
	// role but is no longer a guardian.
	pending := newActor("pending-member", "operator Z", 0, false, false)
	pending.m.Licence = "pending"
	_ = put(k.Store, "member/"+pending.m.ID, pending.m)
	licence := map[string]any{"member": pending.m.ID, "status": "active", "evidence_digest": digest}
	guardianReject(t, k, g, "licence", licence, 4)
	guardianReject(t, k, g1, "licence", licence, 4)
	command(t, k, g1, "guardian_action_propose", quorumAction("lic", "licence", licence, 30), 4)
	command(t, k, g3, "guardian_action_approve", map[string]any{"id": "lic", "evidence_digest": digest}, 5)
	if m, _ := k.Member(pending.m.ID); m.Licence != "active" {
		t.Fatal("2-of-3 licence did not execute")
	}
	_ = lead
	_ = peer
}
