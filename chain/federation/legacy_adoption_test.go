package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

func TestLegacyAdoptionPinsExistingCheckpointAndPreservesSequencesAndLineage(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	command(t, k, a, "instance_create", map[string]any{"id": "native-existing", "name": "Existing native instance", "family": "Fixture"}, 1)
	checkpoint, e := k.LegacyNativeCheckpoint()
	if e != nil {
		t.Fatal(e)
	}
	oldLegacy := string(k.Store.Get([]byte("legacy")))
	oldMember, _ := k.Member(a.m.ID)
	before := sha256.Sum256(k.Store.Get([]byte("instance/native-existing")))
	p := map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": fmt.Sprint(len(rows)), "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4", "pinned_public_key": "original public source key", "native_checkpoint": checkpoint}
	command(t, k, a, "legacy_adopt", p, 2)
	command(t, k, a, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": fmt.Sprint(len(rows)), "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 3)
	command(t, k, a, "legacy_page", map[string]any{"start": "0", "records": rows[:2]}, 4)
	command(t, k, a, "legacy_page", map[string]any{"start": "2", "records": rows[2:]}, 5)
	command(t, k, a, "legacy_finish", map[string]any{}, 6)
	// The old native instance remains. Aggregate attribution cannot be replaced
	// with source instances until that overlap is explained by a prior baseline.
	if _, e = apply(k, signed(t, k, a, "legacy_claim_account", map[string]any{"member": a.m.ID}, 7), 7); e == nil {
		t.Fatal("unexplained existing instance overlap adopted")
	}
	after, _ := k.Member(a.m.ID)
	if after.Sequence <= oldMember.Sequence || after.Credits != oldMember.Credits || after.Karma != oldMember.Karma || string(k.Store.Get([]byte("legacy"))) != oldLegacy {
		t.Fatal("old native lineage/balance/sequence changed")
	}
	hash := sha256.Sum256(k.Store.Get([]byte("instance/native-existing")))
	if hex.EncodeToString(hash[:]) != hex.EncodeToString(before[:]) {
		t.Fatal("old native instance overwritten")
	}
}
func TestLegacyAdoptionRejectsCheckpointDriftAndRepeat(t *testing.T) {
	k, a, _, root := legacyFixture(t)
	checkpoint, e := k.LegacyNativeCheckpoint()
	if e != nil {
		t.Fatal(e)
	}
	command(t, k, a, "instance_create", map[string]any{"id": "drift", "name": "Changed native instance", "family": "Fixture"}, 1)
	p := map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": "4", "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4", "pinned_public_key": "original public source key", "native_checkpoint": checkpoint}
	if _, e = apply(k, signed(t, k, a, "legacy_adopt", p, 2), 2); e == nil {
		t.Fatal("stale approved native checkpoint accepted")
	}
	checkpoint, _ = k.LegacyNativeCheckpoint()
	p["native_checkpoint"] = checkpoint
	command(t, k, a, "legacy_adopt", p, 2)
	if _, e = apply(k, signed(t, k, a, "legacy_adopt", p, 3), 3); e == nil {
		t.Fatal("approved adoption replaced")
	}
}
