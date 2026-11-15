package federation

import (
	"testing"
)

func TestLegacySignedJoinEnablesOriginalTrustedArbiterWithoutRoleRegrant(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	put(k.Store, "legacy/actor/old-default", LegacyActor{ID: "old-default", Member: def.m.ID, Operator: def.m.Operator, Family: "google", Default: true, Arbiter: true, Projects: []string{}})
	command(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-peer", "verdict": "disputed", "evidence_digest": digest}, 10)
	if _, e := apply(k, signed(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 11), 11); e == nil {
		t.Fatal("outsider trusted role bypassed original membership")
	}
	command(t, k, def, "legacy_join", map[string]any{"project": "old-project", "actor": "old-default", "evidence_digest": digest}, 11)
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 12)
	m, _ := k.Member(author.m.ID)
	if m.Credits != "12" {
		t.Fatal("joined exact original arbiter could not settle original obligation", m)
	}
	var original LegacyActor
	get(k.Store, "legacy/actor/old-default", &original)
	if len(original.Projects) != 0 || !original.Arbiter {
		t.Fatal("joining overwrote original role/membership evidence")
	}
	if _, e := apply(k, signed(t, k, peer, "legacy_join", map[string]any{"project": "old-project", "actor": "old-default", "evidence_digest": digest}, 13), 13); e == nil {
		t.Fatal("another member joined trusted instance")
	}
}
func TestLegacyNewInstanceJoinDoesNotInheritOriginalMemberRole(t *testing.T) {
	k, _, _, def := legacyResearchFixture(t)
	command(t, k, def, "instance_create", map[string]any{"id": "new-default-member-instance", "name": "A new instance of the same member", "family": "Fixture"}, 10)
	command(t, k, def, "legacy_join", map[string]any{"project": "old-project", "actor": "new-default-member-instance", "evidence_digest": digest}, 11)
	a, e := k.legacyActor("new-default-member-instance")
	if e != nil || a.Default || a.Arbiter || a.Creator {
		t.Fatal("new instance inherited source-only roles", a, e)
	}
}
func TestLegacyUnclaimedInstanceIDCannotBeCreatedByAnotherNativeMember(t *testing.T) {
	k, _, peer, _ := legacyResearchFixture(t)
	put(k.Store, "legacy/actor/unclaimed-kestrel", LegacyActor{ID: "unclaimed-kestrel", Projects: []string{}})
	if _, e := apply(k, signed(t, k, peer, "instance_create", map[string]any{"id": "unclaimed-kestrel", "name": "Spoofed historical identity", "family": "Fixture"}, 10), 10); e == nil {
		t.Fatal("unclaimed historical instance ID was taken by a new native key")
	}
}
