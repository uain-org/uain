package federation

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func instanceSigned(t *testing.T, k Keeper, a actor, id, op string, payload any, height int64) []byte {
	t.Helper()
	var env Envelope
	if err := json.Unmarshal(signed(t, k, a, op, payload, height), &env); err != nil {
		t.Fatal(err)
	}
	env.Command.Instance = id
	b, err := SigningBytes(env.Command)
	if err != nil {
		t.Fatal(err)
	}
	env.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(a.key, b))
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func instanceCommand(t *testing.T, k Keeper, a actor, id, op string, payload any, height int64) {
	t.Helper()
	if _, err := apply(k, instanceSigned(t, k, a, id, op, payload, height), height); err != nil {
		t.Fatalf("%s: %v", op, err)
	}
}

func createInstance(t *testing.T, k Keeper, a actor, id, family string) {
	t.Helper()
	command(t, k, a, "instance_create", map[string]any{"id": id, "name": "Fixture " + id, "family": family}, 1)
}

func TestInstanceOwnershipSharedSequenceAndLicence(t *testing.T) {
	k, lead, peer, _ := fixture(t)
	createInstance(t, k, lead, "lead-a", "family-a")
	createInstance(t, k, lead, "lead-b", "family-b")
	createInstance(t, k, peer, "peer-a", "family-c")
	for _, id := range []string{"peer-a", "missing", "../../escape"} {
		before, _ := json.Marshal(k.Store)
		if _, err := apply(k, instanceSigned(t, k, lead, id, "withdraw", map[string]any{}, 2), 2); err == nil {
			t.Fatalf("impersonated %s", id)
		}
		after, _ := json.Marshal(k.Store)
		if !bytes.Equal(before, after) {
			t.Fatal("failed impersonation mutated state")
		}
	}
	stale := instanceSigned(t, k, lead, "lead-b", "instance_state", map[string]any{"id": "lead-a", "state": "paused"}, 2)
	instanceCommand(t, k, lead, "lead-a", "instance_state", map[string]any{"id": "lead-a", "state": "paused"}, 2)
	if _, err := apply(k, stale, 2); err == nil {
		t.Fatal("instances did not share replay sequence")
	}
	if _, err := apply(k, instanceSigned(t, k, lead, "lead-a", "withdraw", map[string]any{}, 3), 3); err == nil {
		t.Fatal("paused instance acted")
	}
	command(t, k, lead, "instance_state", map[string]any{"id": "lead-a", "state": "active"}, 3)
	instanceCommand(t, k, lead, "lead-a", "withdraw", map[string]any{}, 4)
	if _, err := apply(k, instanceSigned(t, k, lead, "lead-b", "instance_create", map[string]any{"id": "bypass", "name": "Bypass"}, 5), 5); err == nil {
		t.Fatal("withdrawn member used sibling instance")
	}
}

func TestInstancesCannotMultiplyReviewersOrRewards(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	createInstance(t, k, lead, "author-a", "family-a")
	createInstance(t, k, lead, "author-b", "family-b")
	createInstance(t, k, peer, "peer-a", "family-c")
	createInstance(t, k, peer, "peer-b", "family-d")
	createInstance(t, k, guardian, "default-a", "family-e")
	instanceCommand(t, k, lead, "author-a", "open_project", map[string]any{"id": "P-1", "title": "Research question", "class": "benevolent", "prior_art": prior}, 2)
	command(t, k, guardian, "allocate_budget", map[string]any{"project": "P-1", "credits": "100", "evidence_digest": digest}, 3)
	instanceCommand(t, k, lead, "author-a", "open_task", Task{ID: "T-1", Project: "P-1", Title: "Bounded research question", Class: "benevolent", PriorArt: prior, Criteria: strings.Repeat("x", 40), Kind: "instant", KarmaReward: 100, CreditReward: "100"}, 4)
	instanceCommand(t, k, lead, "author-a", "submit", map[string]any{"id": "RC-1", "task": "T-1", "evidence_digest": digest}, 5)
	if _, err := apply(k, instanceSigned(t, k, lead, "author-b", "submit", map[string]any{"id": "RC-2", "task": "T-1", "evidence_digest": digest}, 5), 5); err == nil {
		t.Fatal("sibling duplicated member submission")
	}
	check := map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	if _, err := apply(k, instanceSigned(t, k, lead, "author-b", "verify", check, 6), 6); err == nil {
		t.Fatal("sibling self reviewed")
	}
	instanceCommand(t, k, peer, "peer-a", "verify", check, 6)
	if _, err := apply(k, instanceSigned(t, k, peer, "peer-b", "verify", check, 6), 6); err == nil {
		t.Fatal("siblings counted as two reviewers")
	}
	instanceCommand(t, k, guardian, "default-a", "verify", check, 7)
	m, _ := k.Member(lead.m.ID)
	a, _ := k.Instance("author-a")
	b, _ := k.Instance("author-b")
	p, _ := k.Project("P-1")
	task, _ := k.Task("T-1")
	v, _ := k.Contribution("RC-1")
	if m.Karma != 1100 || m.Credits != "100" || a.Karma != 100 || a.Credits != "100" || b.Karma != 0 || b.Credits != "0" || p.Budget != "0" {
		t.Fatalf("duplicate or incorrect attribution: %+v %+v %+v %+v", m, a, b, p)
	}
	if p.LeadInstance != "author-a" || task.OpenedByInstance != "author-a" || v.AuthorInstance != "author-a" || v.Verifications[0].Instance != "peer-a" {
		t.Fatal("lost provenance")
	}
	var count uint64
	_ = get(k.Store, "event_count", &count)
	var event Event
	// Inspect the last event using its actual count rather than assuming fixture size.
	raw, _ := k.JSONRecord("event", fmt.Sprintf("%020d", count))
	_ = json.Unmarshal(raw, &event)
	if event.Instance != "default-a" {
		t.Fatalf("event lost signed instance: %+v", event)
	}
}

func TestInstanceFamilyAndPauseAreCheckedAtSettlement(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	createInstance(t, k, lead, "author-a", "same")
	createInstance(t, k, peer, "peer-a", "same")
	createInstance(t, k, guardian, "default-a", "same")
	open(t, k, lead, guardian, false)
	v, _ := k.Contribution("RC-1")
	v.AuthorInstance = "author-a"
	_ = put(k.Store, "contribution/"+v.ID, v)
	check := map[string]any{"contribution": "RC-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	instanceCommand(t, k, peer, "peer-a", "verify", check, 5)
	instanceCommand(t, k, guardian, "default-a", "verify", check, 6)
	m, _ := k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("member-level family overrode actual instance family")
	}
	// Declared families are fixture inputs, not external model attestations.
	v, _ = k.Contribution("RC-1")
	inst, _ := k.Instance("peer-a")
	inst.Family = "other"
	_ = put(k.Store, "instance/peer-a", inst)
	command(t, k, peer, "instance_state", map[string]any{"id": "peer-a", "state": "paused"}, 7)
	task, _ := k.Task("T-1")
	if err := k.maybeSettle(v, task, time.Unix(10, 0).UTC()); err != nil {
		t.Fatal(err)
	}
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("paused reviewer released reward")
	}
	command(t, k, peer, "instance_state", map[string]any{"id": "peer-a", "state": "active"}, 8)
	command(t, k, lead, "instance_state", map[string]any{"id": "author-a", "state": "paused"}, 9)
	if err := k.maybeSettle(v, task, time.Unix(10, 0).UTC()); err != nil {
		t.Fatal(err)
	}
	m, _ = k.Member(lead.m.ID)
	if m.Credits != "0" {
		t.Fatal("paused author received reward")
	}
}

func TestInstanceCreationIsBoundedAndCannotSupplyStanding(t *testing.T) {
	k, lead, peer, _ := fixture(t)
	createInstance(t, k, lead, "shared-id", "")
	for _, p := range []any{map[string]any{"id": "shared-id", "name": "Duplicate"}, map[string]any{"id": "spoof", "name": "Spoof", "karma": 1000}, map[string]any{"id": "spoof", "name": "Spoof", "member": lead.m.ID}} {
		if _, err := apply(k, signed(t, k, peer, "instance_create", p, 2), 2); err == nil {
			t.Fatal("duplicate or injected instance accepted")
		}
	}
	_ = put(k.Store, "instance_count/"+lead.m.ID, MaxInstancesPerMember)
	if _, err := apply(k, signed(t, k, lead, "instance_create", map[string]any{"id": "overflow", "name": "Overflow"}, 2), 2); err == nil {
		t.Fatal("unbounded instances")
	}
}

func TestOptionalInstanceSigningCompatibilityAndTamper(t *testing.T) {
	c := Command{Version: 1, ChainID: "uain-test-1", Member: "uain1" + strings.Repeat("a", 40), Sequence: 0, ExpiresHeight: 100, Operation: "withdraw", Payload: json.RawMessage(`{}`)}
	want := `uain:chain-command:v1` + "\n" + `{"version":1,"chain_id":"uain-test-1","member":"uain1` + strings.Repeat("a", 40) + `","sequence":"0","expires_height":"100","operation":"withdraw","payload":{}}`
	b, err := SigningBytes(c)
	if err != nil || string(b) != want {
		t.Fatal("old signing bytes changed")
	}
	c.Instance = "fixture-1"
	b, err = SigningBytes(c)
	if err != nil || string(b) != strings.TrimSuffix(want, "}")+`,"instance":"fixture-1"}` {
		t.Fatal("optional instance canonical format differs")
	}
	k, lead, _, _ := fixture(t)
	createInstance(t, k, lead, "fixture-1", "")
	raw := instanceSigned(t, k, lead, "fixture-1", "withdraw", map[string]any{}, 2)
	tampered := bytes.Replace(raw, []byte(`"instance":"fixture-1"`), []byte(`"instance":"fixture-2"`), 1)
	if _, err := Authenticate(tampered, "uain-test-1", 2); err == nil {
		t.Fatal("signature did not bind instance")
	}
}

func TestInstanceProjectAllowanceAndSafetyPenaltyStayShared(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	createInstance(t, k, lead, "lead-a", "family-a")
	createInstance(t, k, lead, "lead-b", "family-b")
	project := map[string]any{"id": "P-1", "title": "Research question", "class": "benevolent", "prior_art": prior}
	instanceCommand(t, k, lead, "lead-a", "open_project", project, 2)
	project["id"] = "P-2"
	if _, err := apply(k, instanceSigned(t, k, lead, "lead-b", "open_project", project, 3), 3); err == nil {
		t.Fatal("sibling multiplied project allowance")
	}
	// An existing member near the licence threshold incurs one member penalty
	// and the matching attribution on the instance which created the project.
	m, _ := k.Member(lead.m.ID)
	m.Karma = -8
	_ = put(k.Store, "member/"+m.ID, m)
	command(t, k, peer, "flag", map[string]any{"id": "F-1", "project": "P-1", "evidence_digest": digest}, 4)
	command(t, k, guardian, "decide_flag", map[string]any{"flag": "F-1", "decision": "upheld", "evidence_digest": digest}, 5)
	m, _ = k.Member(lead.m.ID)
	a, _ := k.Instance("lead-a")
	b, _ := k.Instance("lead-b")
	if m.Karma != -10 || m.Licence != "revoked" || m.ActiveProjects != 0 || a.Karma != -2 || b.Karma != 0 {
		t.Fatalf("incorrect safety attribution: %+v %+v %+v", m, a, b)
	}
	if _, err := apply(k, instanceSigned(t, k, lead, "lead-b", "instance_state", map[string]any{"id": "lead-a", "state": "paused"}, 6), 6); err == nil {
		t.Fatal("revoked member used sibling instance")
	}
}
