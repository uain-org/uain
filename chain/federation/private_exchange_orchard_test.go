//go:build orchard && cgo

package federation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func publicPrivateFixture(t *testing.T) ([]byte, PrivateApproval, string) {
	t.Helper()
	dir := os.Getenv("UAIN_PUBLIC_FIXTURE_DIR")
	if dir == "" {
		t.Fatal("real public Orchard fixtures required for tagged private suite")
	}
	read := func(name string) []byte {
		b, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	decode := func(name string) []byte {
		b, e := hex.DecodeString(strings.TrimSpace(string(read(name))))
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	pub := decode("reviewer-public-key.hex")
	p := PrivateApproval{Reviewer: Address(pub), Effects: string(read("payment-effects.hex")), PurposeCommitment: strings.Repeat("09", 32), Class: "neutral", ExpiresHeight: 400, Signature: base64.RawURLEncoding.EncodeToString(decode("approval-signature.hex"))}
	return read("payment.bin"), p, string(read("deposit-anchor.hex"))
}
func TestPrivateRealProofReplayApprovalAndRootGuards(t *testing.T) {
	wire, approval, anchor := publicPrivateFixture(t)
	reviewerKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{42}, 32))
	pub := reviewerKey.Public().(ed25519.PublicKey)
	reviewer := actor{Member{ID: Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: "private reviewer fixture", Operator: "review fixture", Family: "review", Licence: "active", Karma: 100, Credits: "0"}, reviewerKey}
	guardian := newActor("private guardian", "guardian fixture", 100, false, false)
	relay := newActor("separate relay", "relay fixture", 0, false, false)
	walletPubHex, e := os.ReadFile(filepath.Join(os.Getenv("UAIN_PUBLIC_FIXTURE_DIR"), "wallet-reviewer-public-key.hex"))
	if e != nil {
		t.Fatal(e)
	}
	walletPub, e := hex.DecodeString(string(walletPubHex))
	if e != nil {
		t.Fatal(e)
	}
	walletReviewer := Member{ID: Address(walletPub), PublicKey: base64.RawURLEncoding.EncodeToString(walletPub), Name: "wallet reviewer fixture", Operator: "wallet review fixture", Family: "review", Licence: "active", Karma: 100, Credits: "0"}
	k := Keeper{Store: memory{}}
	if e := k.Init(Genesis{Version: 1, Guardians: []string{guardian.m.ID}, Members: []Member{guardian.m, relay.m, reviewer.m, walletReviewer}}); e != nil {
		t.Fatal(e)
	}
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, guardian, "activate_private_exchange", map[string]any{"policy": PrivateExchangePolicy, "evidence_digest": digest, "relayer": relay.m.ID}, 2)
	command(t, k, guardian, "private_reviewer", map[string]any{"member": reviewer.m.ID, "active": true, "evidence_digest": digest}, 3)
	command(t, k, guardian, "private_reviewer", map[string]any{"member": walletReviewer.ID, "active": true, "evidence_digest": digest}, 3)
	payment := PrivatePayment{Bundle: base64.RawURLEncoding.EncodeToString(wire), Approval: approval}
	// Disposable issuance fixture ONLY. No live command imports arbitrary roots.
	var frontier PrivateFrontier
	if e := get(k.Store, "private_frontier", &frontier); e != nil {
		t.Fatal(e)
	}
	dir := os.Getenv("UAIN_PUBLIC_FIXTURE_DIR")
	deposit, e := os.ReadFile(filepath.Join(dir, "deposit.bin"))
	if e != nil {
		t.Fatal(e)
	}
	var depositNotes [2][32]byte
	for i := 0; i < 2; i++ {
		copy(depositNotes[i][:], deposit[45+i*884+96:45+i*884+128])
	}
	if e = k.appendPrivateNotes(&frontier, depositNotes); e != nil {
		t.Fatal(e)
	}
	if frontier.Root != anchor || frontier.Count != 2 {
		t.Fatal("Go tree does not match proved Orchard anchor", frontier)
	}
	if e = put(k.Store, "private_frontier", frontier); e != nil {
		t.Fatal(e)
	}
	if e = put(k.Store, "private_root/"+anchor, 1); e != nil {
		t.Fatal(e)
	}
	rejectCommand(t, k, guardian, "", "private_payment", payment, 4)
	wrong := payment
	wrong.Approval.Class = "malevolent"
	rejectCommand(t, k, relay, "", "private_payment", wrong, 4)
	wrong = payment
	wrong.Approval.LicenceRevision = 1
	rejectCommand(t, k, relay, "", "private_payment", wrong, 4)
	wrong = payment
	wrong.Approval.PurposeCommitment = strings.Repeat("08", 32)
	rejectCommand(t, k, relay, "", "private_payment", wrong, 4)
	wrong = payment
	wrong.Approval.Signature = strings.Repeat("a", 86)
	rejectCommand(t, k, relay, "", "private_payment", wrong, 4)
	// The Rust API recomputes effect-bound signatures; no caller-chosen sighash bypass.
	effect, e := shield.Effects(wire)
	if e != nil {
		t.Fatal(e)
	}
	b, e := PrivateApprovalBytes("uain-test-1", pub, approval)
	if e != nil {
		t.Fatal(e)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(approval.Signature)
	h := sha256.Sum256(append(b, sig...))
	if _, e = shield.Verify(wire, "other-epoch", 400, h); e == nil {
		t.Fatal("cross-chain proof accepted")
	}
	if hex.EncodeToString(effect[:]) != approval.Effects {
		t.Fatal("Rust/Go effect mismatch")
	}
	before, _ := json.Marshal(k.Store)
	command(t, k, relay, "private_payment", payment, 4)
	if e = get(k.Store, "private_frontier", &frontier); e != nil || frontier.Count != 4 {
		t.Fatal(frontier, e)
	}
	if !bytes.Equal(k.Store.Get([]byte("private_payment/"+approval.Effects)), nil) {
		var stored map[string]any
		if e = json.Unmarshal(k.Store.Get([]byte("private_payment/"+approval.Effects)), &stored); e != nil {
			t.Fatal(e)
		}
		for _, field := range []string{"sender", "recipient", "amount", "private_key", "terms"} {
			if _, ok := stored[field]; ok {
				t.Fatal("private field exposed", field)
			}
		}
	}
	after, _ := json.Marshal(k.Store)
	if bytes.Equal(before, after) {
		t.Fatal("accepted payment made no state change")
	}
	rejectCommand(t, k, relay, "", "private_payment", payment, 5)
	walletWire, e := os.ReadFile(filepath.Join(dir, "wallet-payment.bin"))
	if e != nil {
		t.Fatal(e)
	}
	walletApprovalBytes, e := os.ReadFile(filepath.Join(dir, "wallet-approval.json"))
	if e != nil {
		t.Fatal(e)
	}
	var walletApproval PrivateApproval
	if e = json.Unmarshal(walletApprovalBytes, &walletApproval); e != nil {
		t.Fatal(e)
	}
	approvalBytes, e := PrivateApprovalBytes("uain-test-1", walletPub, walletApproval)
	if e != nil {
		t.Fatal(e)
	}
	walletSig, e := base64.RawURLEncoding.DecodeString(walletApproval.Signature)
	if e != nil {
		t.Fatal(e)
	}
	walletApprovalHash := sha256.Sum256(append(approvalBytes, walletSig...))
	if _, e = shield.Verify(walletWire, "uain-test-1", uint64(walletApproval.ExpiresHeight), walletApprovalHash); e != nil {
		t.Fatal("wallet/Node/native signature mismatch", e)
	}
	// A fresh encryption/proof/approval still cannot spend the already consumed input.
	rejectCommand(t, k, relay, "", "private_payment", PrivatePayment{Bundle: base64.RawURLEncoding.EncodeToString(walletWire), Approval: walletApproval}, 5)

	// Replay rejection is atomic and leaves sequence, note tree and nullifiers unchanged.
	replayed, _ := json.Marshal(k.Store)
	if !bytes.Equal(after, replayed) {
		t.Fatal("rejected replay changed state")
	}
	var revision CensusRevision
	if e = get(k.Store, "private_licence_revision", &revision); e != nil || revision.Value != 0 {
		t.Fatal("ordinary relay sequence changed licence revision", revision, e)
	}
	command(t, k, guardian, "licence", map[string]any{"member": reviewer.m.ID, "status": "revoked", "evidence_digest": digest}, 6)
	if e = get(k.Store, "private_licence_revision", &revision); e != nil || revision.Value != 1 {
		t.Fatal("revocation did not invalidate private approvals", revision, e)
	}
}
