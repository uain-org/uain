package federation

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func dnsObservation(t *testing.T, k Keeper, member, instance string, h int64) map[string]any {
	t.Helper()
	var claim OperatorClaim
	if err := get(k.Store, "operator_claim/"+operatorActorKey(member, instance), &claim); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"member": member, "instance": instance, "domain": claim.Domain, "claim_event_id": fmt.Sprint(claim.EventID), "txt": "uain-operator=" + claim.DID, "checked_at": time.Unix(h, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": digest}
}

func TestIdentityBindingsPreserveLegacyDIDAndMemberOwnership(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	createInstance(t, k, peer, "legacy-peer", "family")
	imported := map[string]any{"member": peer.m.ID, "instance": "legacy-peer", "did": "did:uain:123456789abc", "operator": "Legacy operator", "evidence_digest": digest}
	rejectCommand(t, k, peer, "", "identity_import", imported, 2)
	command(t, k, guardian, "identity_import", imported, 2)
	a, err := k.ActorIdentity(peer.m.ID, "legacy-peer")
	if err != nil || a.DID != imported["did"] || a.Origin != "guardian-legacy-import" || a.Operator != "Legacy operator" {
		t.Fatal("legacy DID changed or declaration lost", a, err)
	}
	imported["member"], imported["instance"] = lead.m.ID, ""
	rejectCommand(t, k, guardian, "", "identity_import", imported, 3)
	rejectCommand(t, k, peer, "legacy-peer", "identity_claim", map[string]any{}, 3)
	command(t, k, peer, "identity_claim", map[string]any{}, 3)
	b, err := k.ActorIdentity(peer.m.ID, "")
	if err != nil || b.DID != derivedActorDID(peer.m.ID, "") || b.DID == a.DID || b.Origin != "member-derived" {
		t.Fatal("new and imported identities collapsed", b, err)
	}
	rejectCommand(t, k, peer, "", "identity_claim", map[string]any{"did": "did:uain:123456789abc"}, 4)
	rejectCommand(t, k, peer, "", "identity_claim", map[string]any{}, 4)
	// Historical ended identities may be reconciled; binding never reopens
	// their licence or grants their guardian permission to act as that member.
	command(t, k, lead, "withdraw", map[string]any{}, 4)
	imported["did"] = "did:uain:abcdef123456"
	command(t, k, guardian, "identity_import", imported, 5)
	ended, _ := k.Member(lead.m.ID)
	if ended.Licence != "withdrawn" {
		t.Fatal("identity import reopened licence")
	}
	rejectCommand(t, k, lead, "", "operator_claim", map[string]any{"domain": "example.org"}, 6)
}

func TestOperatorObservationBindsCurrentClaimAndRetainsOldProof(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	rejectCommand(t, k, lead, "", "operator_claim", map[string]any{"domain": "example.org"}, 1)
	command(t, k, lead, "identity_claim", map[string]any{}, 1)
	for _, domain := range []string{"localhost", "127.0.0.1", "https://example.org", "-bad.example", "example..org", strings.Repeat("x", 64) + ".org"} {
		rejectCommand(t, k, lead, "", "operator_claim", map[string]any{"domain": domain}, 2)
	}
	command(t, k, lead, "operator_claim", map[string]any{"domain": "  Example.ORG.  "}, 2)
	p := dnsObservation(t, k, lead.m.ID, "", 3)
	rejectCommand(t, k, peer, "", "operator_attest", p, 3)
	for _, field := range []string{"domain", "claim_event_id", "txt", "checked_at"} {
		copy := map[string]any{}
		for key, value := range p {
			copy[key] = value
		}
		copy[field] = "wrong"
		if field == "claim_event_id" {
			copy[field] = "999"
		}
		rejectCommand(t, k, guardian, "", "operator_attest", copy, 3)
	}
	command(t, k, guardian, "operator_attest", p, 3)
	proof, err := k.OperatorProof(lead.m.ID, "")
	if err != nil || proof == nil || proof.Domain != "example.org" || proof.Trust != "guardian-dns-observation" || proof.Observer != guardian.m.ID {
		t.Fatal("DNS observer provenance missing", proof, err)
	}
	rejectCommand(t, k, guardian, "", "operator_attest", p, 4)
	command(t, k, lead, "operator_claim", map[string]any{"domain": "new.example"}, 4)
	retained, _ := k.OperatorProof(lead.m.ID, "")
	if *retained != *proof {
		t.Fatal("pending claim erased the previous verified domain")
	}
	rejectCommand(t, k, guardian, "", "operator_attest", p, 5)
	newObservation := dnsObservation(t, k, lead.m.ID, "", 3) // Before this new claim.
	rejectCommand(t, k, guardian, "", "operator_attest", newObservation, 5)
	newObservation = dnsObservation(t, k, lead.m.ID, "", 5)
	command(t, k, guardian, "operator_attest", newObservation, 5)
	updated, _ := k.OperatorProof(lead.m.ID, "")
	if updated.Domain != "new.example" || updated.ClaimEventID == proof.ClaimEventID {
		t.Fatal("replacement proof did not bind the new claim", updated)
	}
	command(t, k, lead, "operator_claim", map[string]any{"domain": "third.example"}, 6)
	stale := dnsObservation(t, k, lead.m.ID, "", 6)
	rejectCommand(t, k, guardian, "", "operator_attest", stale, 607)
	future := dnsObservation(t, k, lead.m.ID, "", 38)
	rejectCommand(t, k, guardian, "", "operator_attest", future, 7)
}

func TestOperatorComparisonIsPairwiseAndMemberFloorCannotBeSplit(t *testing.T) {
	k, a, b, c := fixture(t)
	for _, who := range []actor{a, b, c} {
		command(t, k, who, "identity_claim", map[string]any{"operator": "Shared company"}, 1)
	}
	command(t, k, a, "operator_claim", map[string]any{"domain": "a.example"}, 2)
	command(t, k, c, "operator_claim", map[string]any{"domain": "c.example"}, 2)
	command(t, k, c, "operator_attest", dnsObservation(t, k, a.m.ID, "", 3), 3)
	command(t, k, c, "operator_attest", dnsObservation(t, k, c.m.ID, "", 3), 3)
	for _, pair := range []struct {
		left, right actor
		same        bool
	}{{a, b, true}, {b, c, true}, {a, c, false}} {
		same, err := k.sameOperator(pair.left.m.ID, "", pair.right.m.ID, "")
		if err != nil || same != pair.same {
			t.Fatal("mixed proved/unproved relation incorrectly collapsed", pair.same, same, err)
		}
	}
	createInstance(t, k, a, "sibling", "family")
	instanceCommand(t, k, a, "sibling", "identity_claim", map[string]any{"operator": "Different declared company"}, 4)
	instanceCommand(t, k, a, "sibling", "operator_claim", map[string]any{"domain": "sibling.example"}, 5)
	command(t, k, c, "operator_attest", dnsObservation(t, k, a.m.ID, "sibling", 6), 6)
	same, err := k.sameOperator(a.m.ID, "", a.m.ID, "sibling")
	if err != nil || !same {
		t.Fatal("one member split its operator through sibling declarations", err)
	}
}

func TestLegacyAccountCorrelationSurvivesDifferentDomains(t *testing.T) {
	k, a, b, guardian := fixture(t)
	for i, who := range []actor{a, b} {
		command(t, k, guardian, "identity_import", map[string]any{"member": who.m.ID, "did": fmt.Sprintf("did:uain:%012x", i+1), "legacy_account_digest": digest, "evidence_digest": digest}, 1)
		command(t, k, who, "operator_claim", map[string]any{"domain": fmt.Sprintf("operator%d.example", i)}, 2)
		command(t, k, guardian, "operator_attest", dnsObservation(t, k, who.m.ID, "", 3), 3)
	}
	same, err := k.sameOperator(a.m.ID, "", b.m.ID, "")
	if err != nil || !same {
		t.Fatal("legacy shared account was counted as independent", err)
	}
}
