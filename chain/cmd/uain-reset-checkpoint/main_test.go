package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"github.com/uain-org/uain/chain/federation"
	"testing"
)

func TestCurrentGuardianCheckpointNeverFallsBackAcrossHandover(t *testing.T) {
	pub := ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	member := federation.Member{ID: federation.Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Licence: "active"}
	values := map[string][]byte{}
	put := func(key string, value any) { values[key], _ = json.Marshal(value) }
	put("guardians", []string{"obsolete"})
	put("guardian_epoch_current", "handover")
	put("event_count", uint64(17))
	get := func(key string) []byte { return values[key] }
	members := func(id string) (federation.Member, error) { return member, nil }
	if _, err := controlState(get, members); err == nil {
		t.Fatal("missing current epoch silently fell back to genesis")
	}
	put("guardian_epoch/handover", map[string]any{"id": "handover", "guardians": []string{member.ID}})
	result, err := controlState(get, members)
	if err != nil || result.EventCount != "17" || result.Guardians[0] != member.ID || result.Epoch != "handover" {
		t.Fatal(result, err)
	}
	member.PublicKey = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	if _, err := controlState(get, members); err == nil {
		t.Fatal("spoofed public key accepted")
	}
}

func TestOriginalGuardianCheckpointRequiresExactActiveOwnedPublicIdentity(t *testing.T) {
	pub := ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	member := federation.Member{ID: federation.Address(pub), PublicKey: base64.RawURLEncoding.EncodeToString(pub), Licence: "active"}
	raw, _ := json.Marshal([]string{member.ID})
	get := func(key string) []byte {
		if key == "guardians" {
			return raw
		}
		return nil
	}
	result, err := controlState(get, func(id string) (federation.Member, error) { return member, nil })
	if err != nil || result.Epoch != "" || result.EventCount != "0" {
		t.Fatal(result, err)
	}
	member.Licence = "revoked"
	if _, err := controlState(get, func(id string) (federation.Member, error) { return member, nil }); err == nil {
		t.Fatal("inactive guardian revived")
	}
}
