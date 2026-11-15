package federation

import (
	"bytes"
	"crypto/ed25519"
	"strings"
	"testing"
)

func TestCoinBoundaryApprovalCannotBecomeAnOTCOrAnotherAccountPayment(t *testing.T) {
	// Fictional framing keys only; no genuine member or wallet key is read.
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{41}, 32))
	pub := key.Public().(ed25519.PublicKey)
	owner := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{40}, 32)).Public().(ed25519.PublicKey)
	p := CoinBoundaryApproval{Reviewer: Address(pub), Effects: strings.Repeat("a", 64), PurposeCommitment: strings.Repeat("b", 64), Class: "neutral", ExpiresHeight: 100, LicenceRevision: 7, Direction: "shield", Member: Address(owner), Amount: "9223372036854775807"}
	b, e := CoinBoundaryApprovalBytes("uain-test-1", pub, p)
	if e != nil {
		t.Fatal(e)
	}
	sig := ed25519.Sign(key, b)
	old, e := PrivateApprovalBytes("uain-test-1", pub, p.privateApproval())
	if e != nil || ed25519.Verify(pub, old, sig) {
		t.Fatal("boundary approval reused as confidential OTC")
	}
	for _, change := range []func(*CoinBoundaryApproval){
		func(p *CoinBoundaryApproval) { p.Direction = "exit" }, func(p *CoinBoundaryApproval) { p.Amount = "1" }, func(p *CoinBoundaryApproval) { p.Member = Address(bytes.Repeat([]byte{39}, 32)) }, func(p *CoinBoundaryApproval) { p.ExpiresHeight++ }, func(p *CoinBoundaryApproval) { p.LicenceRevision++ }, func(p *CoinBoundaryApproval) { p.Effects = strings.Repeat("c", 64) }, func(p *CoinBoundaryApproval) { p.PurposeCommitment = strings.Repeat("d", 64) }, func(p *CoinBoundaryApproval) { p.Class = "benevolent" },
	} {
		next := p
		change(&next)
		changed, e := CoinBoundaryApprovalBytes("uain-test-1", pub, next)
		if e != nil || ed25519.Verify(pub, changed, sig) {
			t.Fatal("boundary mutation preserved signature", e)
		}
	}
	other, e := CoinBoundaryApprovalBytes("other-epoch", pub, p)
	if e != nil || ed25519.Verify(pub, other, sig) {
		t.Fatal("cross-epoch approval accepted")
	}
	for _, amount := range []string{"0", "01", "-1", "9223372036854775808", "18446744073709551615", "1e6", "1.0", " 1"} {
		next := p
		next.Amount = amount
		if _, e := CoinBoundaryApprovalBytes("uain-test-1", pub, next); e == nil {
			t.Fatal("invalid or lossy boundary amount", amount)
		}
	}
	for _, direction := range []string{"", "OTC", "mint", "Shield"} {
		next := p
		next.Direction = direction
		if _, e := CoinBoundaryApprovalBytes("uain-test-1", pub, next); e == nil {
			t.Fatal("invalid boundary direction")
		}
	}
	next := p
	next.Member = p.Reviewer
	if _, e := CoinBoundaryApprovalBytes("uain-test-1", pub, next); e == nil {
		t.Fatal("reviewer self-approved public boundary")
	}
}
