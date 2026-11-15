package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"testing"
)

type legacyTestRecord struct {
	Key   string   `json:"key"`
	Value string   `json:"value"`
	Proof []string `json:"proof"`
}

func legacyTestTree(rows []legacyTestRecord) (string, []legacyTestRecord) {
	sort.Slice(rows, func(i, j int) bool { return rows[i].Key < rows[j].Key })
	levels := [][]string{{}}
	for i, r := range rows {
		v := sha256.Sum256([]byte(r.Value))
		leaf := sha256.Sum256([]byte(fmt.Sprintf("uain:legacy-record:v1\n%d\n%s\n%x", i, r.Key, v)))
		levels[0] = append(levels[0], hex.EncodeToString(leaf[:]))
	}
	for len(levels[len(levels)-1]) > 1 {
		old := levels[len(levels)-1]
		next := []string{}
		for i := 0; i < len(old); i += 2 {
			j := i + 1
			if j == len(old) {
				j = i
			}
			a, _ := hex.DecodeString(old[i])
			b, _ := hex.DecodeString(old[j])
			h := sha256.Sum256(append(a, b...))
			next = append(next, hex.EncodeToString(h[:]))
		}
		levels = append(levels, next)
	}
	for i := range rows {
		rows[i].Proof = nil
		at := i
		for _, level := range levels[:len(levels)-1] {
			j := at ^ 1
			if j == len(level) {
				j = at
			}
			rows[i].Proof = append(rows[i].Proof, level[j])
			at /= 2
		}
	}
	return levels[len(levels)-1][0], rows
}
func legacyFixture(t *testing.T) (Keeper, actor, []legacyTestRecord, string) {
	t.Helper()
	a := newActor("Legacy source", "Original operator", 7, true, false)
	a.m.Credits = "9"
	k := Keeper{Store: memory{}}
	if err := k.Init(Genesis{Version: 1, Members: []Member{a.m}, Guardians: []string{a.m.ID}, Legacy: &LegacyCommitment{ManifestDigest: strings.Repeat("d", 64), LedgerHead: strings.Repeat("e", 64), LastEventID: 4, PinnedPublicKey: "independently pinned test key"}}); err != nil {
		t.Fatal(err)
	}
	account := map[string]any{"id": a.m.ID, "public_key": a.m.PublicKey, "name": a.m.Name, "operator": a.m.Operator, "family": a.m.Family, "licence": "active", "karma": 7, "credits": "9", "sequence": "0", "default_verifier": true, "creator": false, "active_projects": 0, "instances": []map[string]any{{"id": "AG-old", "member": a.m.ID, "name": "Original instance", "family": "Fixture", "operator": "Original operator", "state": "active", "karma": 7, "credits": "9"}}}
	raw, _ := json.Marshal(account)
	obligation := map[string]any{"id": "credit_deferral:WyIxIl0", "kind": "credit_deferral", "table": "credit_deferrals", "source": "WyIxIl0", "member": a.m.ID, "legacy_member": a.m.ID, "instance": "AG-old", "amount": "4", "record": map[string]any{"id": "1", "contribution_id": "RC-old", "participant": "AG-old", "amount": "4", "released_at": nil, "kind": "contribution"}}
	debt, _ := json.Marshal(obligation)
	rows := []legacyTestRecord{{Key: "legacy/account/" + a.m.ID, Value: string(raw)}, {Key: "legacy/obligation/credit_deferral:WyIxIl0", Value: string(debt)}, {Key: "legacy/reconciliation", Value: `{"manifest_digest":"` + strings.Repeat("d", 64) + `","coin_issued":"0"}`}, {Key: "legacy/reserved/contributions/RC-old", Value: `{"source":"WyJSQy1vbGQiXQ"}`}}
	root, rows := legacyTestTree(rows)
	return k, a, rows, root
}
func legacyImportAll(t *testing.T, k Keeper, a actor, rows []legacyTestRecord, root string) {
	t.Helper()
	command(t, k, a, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": fmt.Sprint(len(rows)), "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 1)
	for i := 0; i < len(rows); i += 2 {
		end := i + 2
		if end > len(rows) {
			end = len(rows)
		}
		command(t, k, a, "legacy_page", map[string]any{"start": fmt.Sprint(i), "records": rows[i:end]}, int64(i+2))
	}
	command(t, k, a, "legacy_finish", map[string]any{}, 8)
	command(t, k, a, "legacy_claim_account", map[string]any{"member": a.m.ID}, 9)
}
func TestLegacyMigrationImportConservesOwnershipAndRejectsReplay(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	legacyImportAll(t, k, a, rows, root)
	m, _ := k.Member(a.m.ID)
	if m.Karma != 7 || m.Credits != "9" {
		t.Fatal("import changed existing aggregate")
	}
	instance, err := k.Instance("AG-old")
	if err != nil || instance.Member != a.m.ID || instance.Karma != 7 || instance.Credits != "9" {
		t.Fatal("instance attribution not imported", instance, err)
	}
	if k.Store.Get([]byte("coin_asset")) != nil {
		t.Fatal("import minted Coin")
	}
	for _, r := range rows {
		if string(k.Store.Get([]byte(r.Key))) != r.Value {
			t.Fatal("source record altered", r.Key)
		}
	}
	for _, op := range []string{"legacy_finish", "legacy_claim_account"} {
		p := map[string]any{}
		if op == "legacy_claim_account" {
			p["member"] = a.m.ID
		}
		if _, err := apply(k, signed(t, k, a, op, p, 10), 10); err == nil {
			t.Fatal("replayed import accepted", op)
		}
	}
}

func TestLegacyMigrationPagePacksSmallRecordsAndBoundsAggregateBytes(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	command(t, k, a, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": fmt.Sprint(len(rows)), "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 1)
	command(t, k, a, "legacy_page", map[string]any{"start": "0", "records": rows}, 2)
	state, e := k.legacyState()
	if e != nil || state.Imported != uint64(len(rows)) {
		t.Fatal("small rows were not packed", state, e)
	}
	k, a, _, _ = legacyFixture(t)
	oversized := []legacyTestRecord{}
	for i := 0; i < 3; i++ {
		oversized = append(oversized, legacyTestRecord{Key: fmt.Sprintf("legacy/large/%d", i), Value: `{"value":"` + strings.Repeat("a", 9000) + `"}`})
	}
	root, oversized = legacyTestTree(oversized)
	command(t, k, a, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": "3", "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 1)
	if _, e := apply(k, signed(t, k, a, "legacy_page", map[string]any{"start": "0", "records": oversized}, 2), 2); e == nil {
		t.Fatal("aggregate page byte bound bypassed")
	}
}
func TestLegacyMigrationBadPageRollsBackAndCannotBypassImport(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	command(t, k, a, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root, "total_records": "4", "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 1)
	bad := append([]legacyTestRecord{}, rows[:2]...)
	bad[1].Value = "tampered"
	if _, err := apply(k, signed(t, k, a, "legacy_page", map[string]any{"start": "0", "records": bad}, 2), 2); err == nil {
		t.Fatal("bad row accepted")
	}
	if k.Store.Get([]byte(rows[0].Key)) != nil {
		t.Fatal("partial failed page persisted")
	}
	if _, err := apply(k, signed(t, k, a, "legacy_finish", map[string]any{}, 2), 2); err == nil {
		t.Fatal("incomplete import finished")
	}
	if _, err := apply(k, signed(t, k, a, "instance_create", map[string]any{"id": "new", "name": "New instance", "family": "Fixture"}, 2), 2); err == nil {
		t.Fatal("normal writes bypass import barrier")
	}
}
func TestLegacyOriginalDeferralReleasesExactlyOnceWithoutCoin(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	legacyImportAll(t, k, a, rows, root)
	p := map[string]any{"obligations": []string{"credit_deferral:WyIxIl0"}, "evidence_digest": digest}
	command(t, k, a, "legacy_release", p, 10)
	m, _ := k.Member(a.m.ID)
	instance, _ := k.Instance("AG-old")
	if m.Credits != "13" || instance.Credits != "13" || m.Karma != 7 {
		t.Fatal("wrong original deferred release", m, instance)
	}
	var credit CreditEntry
	if err := get(k.Store, "credit/00000000000000000001", &credit); err != nil || credit.Amount != "4" || credit.ReleaseOf != "legacy:credit_deferral:WyIxIl0" {
		t.Fatal("release attribution", credit, err)
	}
	if _, err := apply(k, signed(t, k, a, "legacy_release", p, 11), 11); err == nil {
		t.Fatal("deferral paid twice")
	}
	if k.Store.Get([]byte("coin_asset")) != nil {
		t.Fatal("legacy credits became Coin")
	}
}
func TestLegacyIdentityMismatchAndFrozenIDCannotBeReused(t *testing.T) {
	k, a, rows, root := legacyFixture(t)
	legacyImportAll(t, k, a, rows, root)
	if _, err := apply(k, signed(t, k, a, "submit", map[string]any{"id": "RC-old", "task": "T-new", "evidence_digest": digest}, 10), 10); err == nil {
		t.Fatal("legacy identifier reused")
	}
	k2, a2, rows2, _ := legacyFixture(t)
	var account map[string]any
	json.Unmarshal([]byte(rows2[0].Value), &account)
	account["credits"] = "10"
	value, _ := json.Marshal(account)
	rows2[0].Value = string(value)
	root2, rows2 := legacyTestTree(rows2)
	command(t, k2, a2, "legacy_begin", map[string]any{"manifest_digest": strings.Repeat("d", 64), "records_root": root2, "total_records": "4", "accounts": "1", "ledger_head": strings.Repeat("e", 64), "last_event_id": "4"}, 1)
	command(t, k2, a2, "legacy_page", map[string]any{"start": "0", "records": rows2[:2]}, 2)
	command(t, k2, a2, "legacy_page", map[string]any{"start": "2", "records": rows2[2:]}, 3)
	command(t, k2, a2, "legacy_finish", map[string]any{}, 4)
	if _, err := apply(k2, signed(t, k2, a2, "legacy_claim_account", map[string]any{"member": a2.m.ID}, 5), 5); err == nil {
		t.Fatal("reconciled account mismatch accepted")
	}
}
