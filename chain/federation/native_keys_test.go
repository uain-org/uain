package federation

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"filippo.io/edwards25519"
)

func identityForgery(t *testing.T, op string) []byte {
	t.Helper()
	pub := make([]byte, 32)
	pub[0] = 1
	sig := make([]byte, 64)
	sig[0] = 1
	c := Command{Version: 1, ChainID: "uain-test-1", Member: Address(pub), ExpiresHeight: 20, Operation: op, Payload: json.RawMessage(`{"name":"forged identity","operator":"forged operator","family":"test"}`)}
	b, e := SigningBytes(c)
	if e != nil || !ed25519.Verify(pub, b, sig) {
		t.Fatalf("fixture does not exercise Go identity forgery: %v", e)
	}
	raw, e := json.Marshal(Envelope{Command: c, PublicKey: base64.RawURLEncoding.EncodeToString(pub), Signature: base64.RawURLEncoding.EncodeToString(sig)})
	if e != nil {
		t.Fatal(e)
	}
	return raw
}

func TestNativeIdentityForgeryCannotAuthenticateOrEnrol(t *testing.T) {
	raw := identityForgery(t, "enrol")
	if _, e := Authenticate(raw, "uain-test-1", 10); e == nil {
		t.Fatal("accepted forged identity-point signature")
	}
	k, _, _, _ := fixture(t)
	if _, e := apply(k, raw, 10); e == nil {
		t.Fatal("forged pending member enrolled")
	}
	pub := make([]byte, 32)
	pub[0] = 1
	if k.Store.Get([]byte("member/"+Address(pub))) != nil {
		t.Fatal("forged account persisted")
	}
}

func TestNativeGenesisRefusesIdentityPointWithoutRewritingValidHistory(t *testing.T) {
	pub := make([]byte, 32)
	pub[0] = 1
	m := Member{ID: Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: "forged identity", Operator: "forged operator", Family: "test", Licence: "active", Credits: "0"}
	if e := validateMember(m); e == nil {
		t.Fatal("identity-point genesis accepted")
	}
	k, a, _, _ := fixture(t)
	raw := signed(t, k, a, "withdraw", map[string]any{}, 10)
	original, e := Authenticate(raw, "uain-test-1", 10)
	if e != nil {
		t.Fatal(e)
	}
	message, e := SigningBytes(original.Command)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = k.Execute(raw, "uain-test-1", 10, time.Unix(10, 0)); e != nil {
		t.Fatal(e)
	}
	after, e := SigningBytes(original.Command)
	if e != nil || string(message) != string(after) {
		t.Fatal("genuine historical command bytes changed")
	}
}

func TestNativeKeysRejectTorsionAndNoncanonicalEncodings(t *testing.T) {
	torsion, e := new(edwards25519.Point).SetBytes(make([]byte, 32))
	if e != nil {
		t.Fatal(e)
	}
	mixed := new(edwards25519.Point).Add(edwards25519.NewGeneratorPoint(), torsion)
	noncanonical := edwards25519.NewIdentityPoint().Bytes()
	noncanonical[31] |= 0x80
	for _, pub := range [][]byte{make([]byte, 32), edwards25519.NewIdentityPoint().Bytes(), mixed.Bytes(), noncanonical} {
		if validNativeEd25519Key(pub) {
			t.Fatalf("nonprime key accepted: %x", pub)
		}
	}
	if !validNativeEd25519Key(edwards25519.NewGeneratorPoint().Bytes()) {
		t.Fatal("genuine prime-order key rejected")
	}
}
