package federation

import (
	"bytes"
	"crypto/ed25519"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"strings"
	"testing"
)

func TestPrivateApprovalFramingAndBenevolence(t *testing.T) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{42}, 32))
	pub := key.Public().(ed25519.PublicKey)
	p := PrivateApproval{Reviewer: Address(pub), Effects: strings.Repeat("a", 64), PurposeCommitment: strings.Repeat("b", 64), Class: "neutral", ExpiresHeight: 100}
	b, e := PrivateApprovalBytes("uain-test-1", pub, p)
	if e != nil {
		t.Fatal(e)
	}
	sig := ed25519.Sign(key, b)
	if !ed25519.Verify(pub, b, sig) {
		t.Fatal("invalid fixture signature")
	}
	for _, change := range []func(*PrivateApproval){func(p *PrivateApproval) { p.Class = "benevolent" }, func(p *PrivateApproval) { p.ExpiresHeight++ }, func(p *PrivateApproval) { p.LicenceRevision++ }, func(p *PrivateApproval) { p.Effects = strings.Repeat("c", 64) }, func(p *PrivateApproval) { p.PurposeCommitment = strings.Repeat("d", 64) }} {
		next := p
		change(&next)
		modified, e := PrivateApprovalBytes("uain-test-1", pub, next)
		if e != nil || ed25519.Verify(pub, modified, sig) {
			t.Fatal("approval mutation accepted", e)
		}
	}
	wrong, e := PrivateApprovalBytes("other-epoch", pub, p)
	if e != nil || ed25519.Verify(pub, wrong, sig) {
		t.Fatal("cross-epoch approval accepted")
	}
	for _, class := range []string{"malevolent", "", "Neutral"} {
		next := p
		next.Class = class
		if _, e = PrivateApprovalBytes("uain-test-1", pub, next); e == nil {
			t.Fatal("invalid class accepted")
		}
	}
}
func TestPrivateReviewerAppointmentAndMissingVerifierRefusal(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	rejectCommand(t, k, lead, "", "private_reviewer", map[string]any{"member": lead.m.ID, "active": true, "evidence_digest": digest}, 1)
	command(t, k, guardian, "private_reviewer", map[string]any{"member": lead.m.ID, "active": true, "evidence_digest": digest}, 1)
	command(t, k, guardian, "private_reviewer", map[string]any{"member": lead.m.ID, "active": false, "evidence_digest": digest}, 2)
	if !shield.Available() {
		rejectCommand(t, k, guardian, "", "activate_private_exchange", map[string]any{"policy": PrivateExchangePolicy, "evidence_digest": digest, "relayer": lead.m.ID}, 3)
	}
	if k.Store.Get([]byte("private_activation")) != nil {
		t.Fatal("unqualified policy activated")
	}
}
