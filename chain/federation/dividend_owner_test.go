package federation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"testing"
)

// These state tests use explicit hash/verifier models. Linked tests exercise
// the actual pinned Halo2 proof and Poseidon implementation separately.
type ownerHashModel struct{}

func (ownerHashModel) OwnerEmpty(h uint8) ([32]byte, error) {
	v := sha256.Sum256([]byte("owner empty"))
	for i := uint8(0); i < h; i++ {
		v, _ = ownerHashModel{}.OwnerNode(i, v, v)
	}
	return v, nil
}
func (ownerHashModel) OwnerLeaf(m, c [32]byte, a bool) ([32]byte, error) {
	b := append(append([]byte("owner"), m[:]...), c[:]...)
	if a {
		b = append(b, 1)
	} else {
		b = append(b, 0)
	}
	return sha256.Sum256(b), nil
}
func (ownerHashModel) OwnerNode(h uint8, l, r [32]byte) ([32]byte, error) {
	b := append(append([]byte{h}, l[:]...), r[:]...)
	return sha256.Sum256(b), nil
}

type ownerVerifierModel struct{ reject bool }

func (v ownerVerifierModel) VerifyRegistration(_ [pd.RegistrationPublicSize]byte, p []byte, s [64]byte) error {
	if v.reject || len(p) != 1 || p[0] != 7 || s[0] != 8 {
		return errors.New("model proof rejected")
	}
	return nil
}
func ownerPayload(t *testing.T, a actor, chain string, genesis, control [32]byte) DividendOwnerRegistration {
	t.Helper()
	pub, _ := base64.RawURLEncoding.DecodeString(a.m.PublicKey)
	var member [32]byte
	copy(member[:], pub)
	ctx, e := pd.RegistrationContext(chain, genesis, member, control)
	if e != nil {
		t.Fatal(e)
	}
	public := make([]byte, 192)
	copy(public, control[:])
	copy(public[32:], ctx[0][:])
	copy(public[64:], ctx[1][:])
	sig := make([]byte, 64)
	sig[0] = 8
	return DividendOwnerRegistration{Control: hex.EncodeToString(control[:]), Public: hex.EncodeToString(public), Proof: "07", Signature: hex.EncodeToString(sig)}
}
func ownerCommand(t *testing.T, a actor, p DividendOwnerRegistration) Command {
	b, e := json.Marshal(p)
	if e != nil {
		t.Fatal(e)
	}
	return Command{ChainID: "uain-test-1", Member: a.m.ID, Operation: "dividend_register", Payload: b}
}
func TestDividendOwnerRegistrationRequiresOriginalMemberUniqueControlPinnedContext(t *testing.T) {
	k := Keeper{Store: memory{}}
	a := newActor("owner", "test", 0, false, false)
	put(k.Store, "member/"+a.m.ID, a.m)
	genesis := [32]byte{1}
	control := [32]byte{11}
	p := ownerPayload(t, a, "uain-test-1", genesis, control)
	c := ownerCommand(t, a, p)
	run := func(c Command, g [32]byte, v ownerVerifierModel) (string, error) {
		return k.registerDividendOwnerWithHash(c, g, 2, v, ownerHashModel{})
	}
	if _, e := run(c, genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("policy off")
	}
	put(k.Store, "dividend_activation", DividendActivation{Policy: DividendPolicy, Height: 1})
	bad := c
	bad.Instance = "delegate"
	if _, e := run(bad, genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("instance substituted original consent")
	}
	if _, e := run(c, [32]byte{2}, ownerVerifierModel{}); e == nil {
		t.Fatal("wrong genesis")
	}
	if _, e := run(c, genesis, ownerVerifierModel{true}); e == nil {
		t.Fatal("invalid spend-control proof")
	}
	badp := p
	badp.Public = p.Public + "00"
	if _, e := run(ownerCommand(t, a, badp), genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("unbounded statement")
	}
	if _, e := run(c, genesis, ownerVerifierModel{}); e != nil {
		t.Fatal(e)
	}
	if _, e := run(c, genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("member reinitialization")
	}
	other := newActor("other", "test", 0, false, false)
	put(k.Store, "member/"+other.m.ID, other.m)
	if _, e := run(ownerCommand(t, other, ownerPayload(t, other, "uain-test-1", genesis, control)), genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("same control registered by two members")
	}
	changed := [32]byte{12}
	if _, e := run(ownerCommand(t, a, ownerPayload(t, a, "uain-test-1", genesis, changed)), genesis, ownerVerifierModel{}); e == nil {
		t.Fatal("carry control reset")
	}
	record, e := k.DividendOwner(a.m.ID)
	if e != nil || record.Index != 0 || record.Control != p.Control {
		t.Fatal(record, e)
	}
	before, _ := (pd.OwnerTree{Store: k.Store, Hash: ownerHashModel{}}).Root()
	a.m.Licence = "revoked"
	if e := updateDividendOwnerLicenceWithHash(k.Store, a.m, ownerHashModel{}); e != nil {
		t.Fatal(e)
	}
	after, _ := (pd.OwnerTree{Store: k.Store, Hash: ownerHashModel{}}).Root()
	if before == after {
		t.Fatal("revocation root unchanged")
	}
	record, _ = k.DividendOwner(a.m.ID)
	if record.Active {
		t.Fatal("revoked still active")
	}
	reopened := Keeper{Store: k.Store}
	record, e = reopened.DividendOwner(a.m.ID)
	if e != nil || record.Active {
		t.Fatal("restart", e)
	}
}
func TestDividendOwnerHookBeforeRegistryDoesNotWriteHistoricalState(t *testing.T) {
	k := Keeper{Store: memory{}}
	a := newActor("old", "test", 0, false, false)
	before := len(k.Store.(memory))
	if e := updateDividendOwnerLicenceWithHash(k.Store, a.m, ownerHashModel{}); e != nil {
		t.Fatal(e)
	}
	if len(k.Store.(memory)) != before {
		t.Fatal("policy-off writes")
	}
}
