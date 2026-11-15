package privatedividend

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestRegistrationContextPinsExactOriginalMemberChainGenesisAndControl(t *testing.T) {
	genesis := [32]byte{1}
	member := [32]byte{33}
	control := [32]byte{11}
	ctx, e := RegistrationContext("uain-test-1", genesis, member, control)
	if e != nil {
		t.Fatal(e)
	}
	raw := make([]byte, RegistrationPublicSize)
	copy(raw, control[:])
	copy(raw[32:], ctx[0][:])
	copy(raw[64:], ctx[1][:])
	if _, e = MatchRegistration(raw, "uain-test-1", genesis, member, control); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 96; i++ {
		bad := bytes.Clone(raw)
		bad[i] ^= 1
		if _, e = MatchRegistration(bad, "uain-test-1", genesis, member, control); e == nil {
			t.Fatalf("changed byte%d", i)
		}
	}
	for _, chain := range []string{"uain-test-2", "", "wrong chain"} {
		if _, e = MatchRegistration(raw, chain, genesis, member, control); e == nil {
			t.Fatal("wrong chain")
		}
	}
	if _, e = MatchRegistration(raw, "uain-test-1", [32]byte{2}, member, control); e == nil {
		t.Fatal("wrong genesis")
	}
	if _, e = MatchRegistration(raw, "uain-test-1", genesis, [32]byte{34}, control); e == nil {
		t.Fatal("wrong member")
	}
	if _, e = MatchRegistration(raw, "uain-test-1", genesis, member, [32]byte{12}); e == nil {
		t.Fatal("wrong control")
	}
	if _, e = MatchRegistration(append(raw, 0), "uain-test-1", genesis, member, control); e == nil {
		t.Fatal("trailing public bytes")
	}
	bad := bytes.Clone(raw)
	copy(bad[96:], bytes.Repeat([]byte{255}, 32))
	if _, e = MatchRegistration(bad, "uain-test-1", genesis, member, control); e == nil {
		t.Fatal("field alias")
	}
	if _, e = RegistrationContext("uain-test-1", [32]byte{}, member, control); e == nil {
		t.Fatal("unbound genesis")
	}
	// This vector is also checked by the Rust client helper.
	got := hex.EncodeToString(append(ctx[0][:16], ctx[1][:16]...))
	if got != "8351d8e93b2b5f6163456c92ecca7183f007f4e0a9c7b00b550cb31539728872" {
		t.Fatal("Rust/native context vector", got)
	}
}
