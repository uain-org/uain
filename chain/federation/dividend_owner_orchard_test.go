//go:build orchard && cgo

package federation

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"os"
	"path/filepath"
	"testing"
)

func TestDividendOwnerRegistrationActualPinnedProofAndOriginalConsent(t *testing.T) {
	dir := os.Getenv("UAIN_DIVIDEND_REGISTRATION_RECEIPT")
	if dir == "" {
		t.Skip("explicit fictional public registration proof receipt required")
	}
	read := func(name string) []byte {
		v, e := os.ReadFile(filepath.Join(dir, name))
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	public, proof, signature := read("registration.public"), read("registration.proof"), read("registration.signature")
	if len(public) != pd.RegistrationPublicSize || len(signature) != 64 {
		t.Fatal("invalid receipt")
	}
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{44}, 32))
	pub := key.Public().(ed25519.PublicKey)
	a := actor{Member{ID: Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Name: "fictional owner", Operator: "disposable test", Licence: "active", Credits: "0"}, key}
	k := Keeper{Store: memory{}}
	put(k.Store, "member/"+a.m.ID, a.m)
	put(k.Store, "dividend_activation", DividendActivation{Policy: DividendPolicy, Height: 1})
	var genesis [32]byte
	copy(genesis[:], bytes.Repeat([]byte{1}, 32))
	p := DividendOwnerRegistration{Control: hex.EncodeToString(public[:32]), Public: hex.EncodeToString(public), Proof: hex.EncodeToString(proof), Signature: hex.EncodeToString(signature)}
	raw := signed(t, k, a, "dividend_register", p, 2)
	env, e := Authenticate(raw, "uain-test-1", 2)
	if e != nil {
		t.Fatal(e)
	}
	if e = k.Validate(env); e != nil {
		t.Fatal(e)
	}
	changedControl := bytes.Clone(public[:32])
	changedControl[0] ^= 1
	changed := bytes.Replace(raw, []byte(p.Control), []byte(hex.EncodeToString(changedControl)), 1)
	if _, e = Authenticate(changed, "uain-test-1", 2); e == nil {
		t.Fatal("altered original member consent")
	}
	if _, e = k.registerDividendOwner(env.Command, genesis, 2); e != nil {
		t.Fatal(e)
	}
	before, e := (pd.OwnerTree{Store: k.Store, Hash: pd.Poseidon{}}).Root()
	if e != nil {
		t.Fatal(e)
	}
	a.m.Licence = "revoked"
	if e = put(k.Store, "member/"+a.m.ID, a.m); e != nil {
		t.Fatal(e)
	}
	after, e := (pd.OwnerTree{Store: k.Store, Hash: pd.Poseidon{}}).Root()
	if e != nil || after == before {
		t.Fatal("actual licence root did not revoke", e)
	}
	owner, e := k.DividendOwner(a.m.ID)
	if e != nil || owner.Active {
		t.Fatal(owner, e)
	}
}
