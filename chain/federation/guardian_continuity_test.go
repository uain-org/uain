package federation

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func guardianReject(t *testing.T, k Keeper, a actor, op string, p any, h int64) {
	t.Helper()
	before, _ := json.Marshal(k.Store)
	if _, err := apply(k, signed(t, k, a, op, p, h), h); err == nil {
		t.Fatalf("%s unexpectedly accepted", op)
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("rejected transition changed state")
	}
}
func guardianProposal(id, base string, next []string, expires int64) map[string]any {
	return map[string]any{"id": id, "base_epoch": base, "guardians": next, "expires_height": expires, "evidence_digest": digest}
}
func guardianAction(id string) map[string]any {
	return map[string]any{"proposal": id, "evidence_digest": digest}
}
func TestGuardianContinuityLastActiveManualExit(t *testing.T) {
	k, _, _, g := fixture(t)
	guardianReject(t, k, g, "withdraw", map[string]any{}, 1)
	guardianReject(t, k, g, "licence", map[string]any{"member": g.m.ID, "status": "revoked", "evidence_digest": digest}, 1)
	// An inactive listed guardian cannot count as continuity.
	dormant := newActor("dormant", "same operator", 100, false, false)
	dormant.m.Licence = "revoked"
	_ = put(k.Store, "member/"+dormant.m.ID, dormant.m)
	_ = put(k.Store, "guardians", []string{g.m.ID, dormant.m.ID})
	guardianReject(t, k, g, "withdraw", map[string]any{}, 2)
}
func TestGuardianContinuityConsentProspectiveReplayAndRestart(t *testing.T) {
	k, incoming, _, old := fixture(t)
	original := bytes.Clone(k.Store.Get([]byte("guardians")))
	p := guardianProposal("handover", "", []string{incoming.m.ID}, 20)
	command(t, k, old, "guardian_propose", p, 2)
	command(t, k, old, "guardian_vote", guardianAction("handover"), 2)
	guardianReject(t, k, old, "guardian_execute", guardianAction("handover"), 2)
	guardianReject(t, k, old, "guardian_execute", guardianAction("handover"), 3)
	command(t, k, incoming, "guardian_consent", guardianAction("handover"), 3)
	raw := signed(t, k, old, "guardian_execute", guardianAction("handover"), 4)
	if _, err := apply(k, raw, 4); err != nil {
		t.Fatal(err)
	}
	// A new Keeper reconstructs all authority from persisted records.
	k = Keeper{Store: k.Store}
	if k.guardian(old.m.ID) || !k.guardian(incoming.m.ID) {
		t.Fatal("handover authority wrong after reopen")
	}
	if !bytes.Equal(original, k.Store.Get([]byte("guardians"))) {
		t.Fatal("genesis guardians rewritten")
	}
	if _, err := apply(k, raw, 5); err == nil {
		t.Fatal("signed execution replay accepted")
	}
	guardianReject(t, k, incoming, "guardian_execute", guardianAction("handover"), 5)
	command(t, k, old, "withdraw", map[string]any{}, 5)
	guardianReject(t, k, incoming, "withdraw", map[string]any{}, 6)
}
func TestGuardianContinuityExpiryStaleAndRevokedConsent(t *testing.T) {
	k, next, peer, g := fixture(t)
	command(t, k, g, "guardian_propose", guardianProposal("expired", "", []string{next.m.ID}, 3), 2)
	guardianReject(t, k, g, "guardian_vote", guardianAction("expired"), 4)
	guardianReject(t, k, g, "guardian_propose", guardianProposal("expired", "", []string{next.m.ID}, 10), 4)
	guardianReject(t, k, g, "guardian_propose", guardianProposal("too-long", "", []string{next.m.ID}, 1000), 4)
	command(t, k, g, "guardian_propose", guardianProposal("a", "", []string{g.m.ID, next.m.ID}, 20), 5)
	command(t, k, g, "guardian_propose", guardianProposal("b", "", []string{peer.m.ID}, 20), 5)
	command(t, k, next, "guardian_consent", guardianAction("a"), 6)
	command(t, k, g, "guardian_vote", guardianAction("a"), 6)
	command(t, k, g, "guardian_execute", guardianAction("a"), 7)
	guardianReject(t, k, g, "guardian_vote", guardianAction("b"), 8)
	command(t, k, g, "guardian_propose", guardianProposal("c", "a", []string{peer.m.ID}, 20), 8)
	command(t, k, peer, "guardian_consent", guardianAction("c"), 8)
	command(t, k, g, "guardian_vote", guardianAction("c"), 8)
	guardianReject(t, k, g, "guardian_execute", guardianAction("c"), 9) // two guardians require both votes
	command(t, k, next, "guardian_vote", guardianAction("c"), 9)
	command(t, k, g, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 9)
	guardianReject(t, k, g, "guardian_execute", guardianAction("c"), 10)
}
func TestGuardianContinuityFixedMajorityAndMandatoryRevocation(t *testing.T) {
	k, next, peer, g := fixture(t)
	_ = put(k.Store, "guardians", []string{g.m.ID, next.m.ID, peer.m.ID})
	command(t, k, g, "guardian_propose", guardianProposal("quorum", "", []string{g.m.ID}, 20), 2)
	command(t, k, g, "guardian_vote", guardianAction("quorum"), 2)
	command(t, k, g, "licence", map[string]any{"member": next.m.ID, "status": "revoked", "evidence_digest": digest}, 3)
	guardianReject(t, k, g, "guardian_execute", guardianAction("quorum"), 4)
	command(t, k, peer, "guardian_vote", guardianAction("quorum"), 4)
	command(t, k, g, "guardian_execute", guardianAction("quorum"), 5)
	// Required automatic Karma revocation is never blocked by continuity.
	m, _ := k.Member(g.m.ID)
	m.Karma = -9
	_ = put(k.Store, "member/"+m.ID, m)
	if err := k.recordKarma(g.m.ID, "", -1, "guardian-test", "mandatory", time.Unix(6, 0)); err != nil {
		t.Fatal(err)
	}
	m, _ = k.Member(g.m.ID)
	if m.Licence != "revoked" {
		t.Fatal("mandatory revocation suppressed")
	}
	guardianReject(t, k, g, "guardian_propose", guardianProposal("resurrection", "quorum", []string{peer.m.ID}, 20), 7)
}

func TestGuardianContinuityApprovalAuthorityAndLostVote(t *testing.T) {
	k, next, peer, g := fixture(t)
	_ = put(k.Store, "guardians", []string{g.m.ID, peer.m.ID})
	bad := guardianProposal("duplicate", "", []string{next.m.ID, next.m.ID}, 20)
	guardianReject(t, k, g, "guardian_propose", bad, 2)
	guardianReject(t, k, g, "guardian_propose", guardianProposal("wrong-base", "other", []string{next.m.ID}, 20), 2)
	guardianReject(t, k, next, "guardian_propose", guardianProposal("unappointed", "", []string{next.m.ID}, 20), 2)
	command(t, k, g, "guardian_propose", guardianProposal("lost-vote", "", []string{next.m.ID}, 20), 2)
	original := bytes.Clone(k.Store.Get([]byte("guardian_proposal/lost-vote")))
	guardianReject(t, k, g, "guardian_consent", guardianAction("lost-vote"), 3)
	guardianReject(t, k, next, "guardian_vote", guardianAction("lost-vote"), 3)
	command(t, k, next, "guardian_consent", guardianAction("lost-vote"), 3)
	guardianReject(t, k, next, "guardian_consent", guardianAction("lost-vote"), 4)
	command(t, k, g, "guardian_vote", guardianAction("lost-vote"), 4)
	command(t, k, peer, "guardian_vote", guardianAction("lost-vote"), 4)
	guardianReject(t, k, peer, "guardian_vote", guardianAction("lost-vote"), 5)
	command(t, k, g, "licence", map[string]any{"member": peer.m.ID, "status": "revoked", "evidence_digest": digest}, 5)
	guardianReject(t, k, g, "guardian_execute", guardianAction("lost-vote"), 6)
	if !bytes.Equal(original, k.Store.Get([]byte("guardian_proposal/lost-vote"))) {
		t.Fatal("approval rewrote immutable proposal")
	}
	guardianReject(t, k, g, "guardian_execute", guardianAction("lost-vote"), 21)
	// Recovery can use a fresh proposal's actually active census; the old quorum
	// is immutable and cannot be weakened by revoking a voter.
	command(t, k, g, "guardian_propose", guardianProposal("fresh", "", []string{next.m.ID}, 30), 22)
	command(t, k, next, "guardian_consent", guardianAction("fresh"), 22)
	command(t, k, g, "guardian_vote", guardianAction("fresh"), 22)
	command(t, k, g, "guardian_execute", guardianAction("fresh"), 23)
}
