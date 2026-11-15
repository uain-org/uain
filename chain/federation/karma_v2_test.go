package federation

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func karmaV2On(t *testing.T, k Keeper, g actor, height int64) {
	t.Helper()
	command(t, k, g, "karma_policy_activate", map[string]any{"policy": KarmaPolicyV2, "evidence_digest": digest}, height)
}
func karmaMember(t *testing.T, k Keeper, id string) Member {
	t.Helper()
	m, e := k.Member(id)
	if e != nil {
		t.Fatal(e)
	}
	return m
}
func karmaRows(t *testing.T, k Keeper, prefix string) []Entry {
	t.Helper()
	rows, e := k.Store.Range([]byte(prefix+"/"), []byte(prefix+"0"), 1000)
	if e != nil {
		t.Fatal(e)
	}
	return rows
}
func karmaCentralTask(t *testing.T, k Keeper, lead actor, id, solver, reviewer string, h int64) {
	t.Helper()
	command(t, k, lead, "central_task_open", map[string]any{"id": id, "project": "P-central", "title": "Check bounded result", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": solver, "reviewer_amount": reviewer, "evidence_digest": digest}, h)
}
func karmaCentralDecide(t *testing.T, k Keeper, lead, solver, g actor, task, sub, verdict string, h int64) {
	t.Helper()
	command(t, k, solver, "central_submit", map[string]any{"id": sub, "task": task, "evidence": "42", "evidence_digest": centralDigest("42")}, h)
	command(t, k, g, "central_review", centralReviewInput(sub, verdict, "exec-"+sub), h+1)
}

// A safety flag upheld against the project lead is the simplest real penalty path (-2).
func karmaFlagPenalty(t *testing.T, k Keeper, lead, peer, g actor, project, flag string, h int64) {
	t.Helper()
	command(t, k, lead, "open_project", map[string]any{"id": project, "title": "Research project", "class": "benevolent", "prior_art": prior}, h)
	command(t, k, peer, "flag", map[string]any{"id": flag, "project": project, "evidence_digest": digest}, h+1)
	command(t, k, g, "decide_flag", map[string]any{"flag": flag, "decision": "upheld", "evidence_digest": digest}, h+2)
}

func TestKarmaV2InactiveKeepsPenaltyRevocationAndAwardsWithoutKarma(t *testing.T) {
	k, lead, peer, g := fixture(t)
	lead.m.Karma, lead.m.Creator = -8, true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	karmaFlagPenalty(t, k, lead, peer, g, "P-1", "F-1", 1)
	m := karmaMember(t, k, lead.m.ID)
	if m.Karma != -10 || m.Strikes != 0 || m.Licence != "revoked" {
		t.Fatalf("pre-activation penalty changed: %+v", m)
	}
	if bytes.Contains(k.Store.Get([]byte("member/"+lead.m.ID)), []byte("strikes")) || k.Store.Get([]byte("strike_count")) != nil {
		t.Fatal("pre-activation penalty wrote strikes")
	}
	rows := karmaRows(t, k, "karma")
	var entry KarmaEntry
	if len(rows) != 1 || json.Unmarshal(rows[0].Value, &entry) != nil || entry.Delta != -2 {
		t.Fatal("pre-activation penalty journal changed", rows)
	}

	k, lead, peer, g = centralFixture(t)
	karmaCentralTask(t, k, lead, "CT-1", "100000000", "20000000", 5)
	karmaCentralDecide(t, k, lead, peer, g, "CT-1", "CS-1", "accept", 6)
	if len(karmaRows(t, k, "karma")) != 0 || karmaMember(t, k, peer.m.ID).Karma != 100 || karmaMember(t, k, g.m.ID).Karma != 100 {
		t.Fatal("pre-activation central award wrote Karma")
	}
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 8)
}

func TestKarmaV2ActivationIsGuardianOnlyAndOnce(t *testing.T) {
	k, lead, _, g := fixture(t)
	rejectCommand(t, k, lead, "", "karma_policy_activate", map[string]any{"policy": KarmaPolicyV2, "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "karma_policy_activate", map[string]any{"policy": "uain-karma-v1", "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "karma_policy_activate", map[string]any{"policy": KarmaPolicyV2, "evidence_digest": "x"}, 5)
	rejectCommand(t, k, g, "", "karma_policy_activate", map[string]any{"policy": KarmaPolicyV2, "evidence_digest": digest, "height": "1"}, 5)
	karmaV2On(t, k, g, 5)
	rejectCommand(t, k, g, "", "karma_policy_activate", map[string]any{"policy": KarmaPolicyV2, "evidence_digest": digest}, 6)
	var a KarmaPolicyActivation
	if e := get(k.Store, "karma_policy_activation", &a); e != nil || a.Policy != KarmaPolicyV2 || a.Height != 6 || a.ApprovedBy != g.m.ID || a.EvidenceDigest != digest {
		t.Fatal(a, e)
	}
}

func TestKarmaV2AppliesFromTheNextBlock(t *testing.T) {
	k, lead, peer, g := fixture(t)
	lead.m.Creator = true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Research project", "class": "benevolent", "prior_art": prior}, 1)
	command(t, k, peer, "flag", map[string]any{"id": "F-1", "project": "P-1", "evidence_digest": digest}, 2)
	karmaV2On(t, k, g, 3)
	command(t, k, g, "decide_flag", map[string]any{"flag": "F-1", "decision": "upheld", "evidence_digest": digest}, 3)
	if m := karmaMember(t, k, lead.m.ID); m.Karma != 998 || m.Strikes != 0 {
		t.Fatalf("activation block used the new rule: %+v", m)
	}
}

func TestKarmaV2PenaltyBecomesStrikesAndRevokesAtTen(t *testing.T) {
	k, lead, peer, g := fixture(t)
	karmaV2On(t, k, g, 1)
	lead.m.Creator, lead.m.Strikes = true, 8
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	karmaFlagPenalty(t, k, lead, peer, g, "P-1", "F-1", 2)
	m := karmaMember(t, k, lead.m.ID)
	if m.Karma != 1000 || m.Strikes != 10 || m.Licence != "revoked" || m.ActiveProjects != 0 {
		t.Fatalf("penalty not converted to strikes: %+v", m)
	}
	if len(karmaRows(t, k, "karma")) != 0 {
		t.Fatal("penalty wrote a Karma journal row")
	}
	rows := karmaRows(t, k, "strike")
	var s StrikeEntry
	if len(rows) != 1 || json.Unmarshal(rows[0].Value, &s) != nil || s.ID != "00000000000000000001" || s.Member != lead.m.ID || s.Points != 2 || s.Kind != "malevolent" || s.Ref != "P-1" || s.EventID == 0 {
		t.Fatal("strike journal", rows)
	}
	rejectCommand(t, k, g, "", "licence", map[string]any{"member": lead.m.ID, "status": "active", "evidence_digest": digest}, 5)

	// Several penalties: still active at 8 strikes, revoked at the 10th point.
	k, lead, _, g = fixture(t)
	karmaV2On(t, k, g, 1)
	v2 := Keeper{Store: k.Store, height: 5}
	now := time.Unix(5, 0).UTC()
	for i := 1; i <= 5; i++ {
		if e := v2.recordKarma(lead.m.ID, "", -DisputePenalty, "no_effort", "RC-1", now); e != nil {
			t.Fatal(e)
		}
		m = karmaMember(t, k, lead.m.ID)
		if m.Karma != 1000 || m.Strikes != int64(2*i) || (m.Licence == "revoked") != (i == 5) {
			t.Fatalf("after %d penalties: %+v", i, m)
		}
	}
	// Positive Karma is unchanged and never reinstates a licence.
	if e := v2.recordKarma(lead.m.ID, "", 5, "reward", "RC-2", now); e != nil {
		t.Fatal(e)
	}
	if m = karmaMember(t, k, lead.m.ID); m.Karma != 1005 || m.Strikes != 10 || m.Licence != "revoked" {
		t.Fatalf("positive Karma after revocation: %+v", m)
	}
}

func TestKarmaV2CentralVerdictGivesKarmaPerWholeAIDollar(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	karmaV2On(t, k, g, 4)
	karmaCentralTask(t, k, lead, "CT-1", "100000000", "20500000", 5)
	karmaCentralTask(t, k, lead, "CT-2", "7000000", "999999", 5)
	karmaCentralTask(t, k, lead, "CT-3", "50000000", "3000000", 5)
	karmaCentralDecide(t, k, lead, peer, g, "CT-1", "CS-1", "accept", 6)
	if p, r := karmaMember(t, k, peer.m.ID), karmaMember(t, k, g.m.ID); p.Karma != 200 || r.Karma != 120 {
		t.Fatalf("accept: solver %d reviewer %d", p.Karma, r.Karma)
	}
	// Under one whole AI$ gives no Karma and no journal row.
	karmaCentralDecide(t, k, lead, peer, g, "CT-2", "CS-2", "accept", 8)
	if p, r := karmaMember(t, k, peer.m.ID), karmaMember(t, k, g.m.ID); p.Karma != 207 || r.Karma != 120 {
		t.Fatalf("sub-AI$ reviewer award: solver %d reviewer %d", p.Karma, r.Karma)
	}
	// A rejection pays only the reviewer, so only the reviewer gains Karma.
	karmaCentralDecide(t, k, lead, peer, g, "CT-3", "CS-3", "reject", 10)
	if p, r := karmaMember(t, k, peer.m.ID), karmaMember(t, k, g.m.ID); p.Karma != 207 || r.Karma != 123 {
		t.Fatalf("reject: solver %d reviewer %d", p.Karma, r.Karma)
	}
	want := map[string]int64{"reviewer/CS-1": 20, "solver/CS-1": 100, "solver/CS-2": 7, "reviewer/CS-3": 3}
	rows := karmaRows(t, k, "karma")
	if len(rows) != len(want) {
		t.Fatal("Karma rows", len(rows))
	}
	for _, row := range rows {
		var entry KarmaEntry
		if e := json.Unmarshal(row.Value, &entry); e != nil || entry.Kind != "central_award" || entry.Instance != "" || want[entry.Ref] != entry.Delta {
			t.Fatal(entry, e)
		}
	}
	// Awards paid after activation are not eligible for backfill.
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 12)
}

func TestKarmaV2CentralBackfillOncePerPreActivationAward(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	karmaCentralTask(t, k, lead, "CT-1", "100000000", "20000000", 5)
	karmaCentralDecide(t, k, lead, peer, g, "CT-1", "CS-1", "accept", 6)
	karmaV2On(t, k, g, 8)
	// Not before the policy applies, not by a non-guardian, not for an unknown award.
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 8)
	rejectCommand(t, k, lead, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 9)
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "manager"}, 9)
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-9", "role": "solver"}, 9)
	command(t, k, g, "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 9)
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "solver"}, 10)
	command(t, k, g, "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "reviewer"}, 10)
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-1", "role": "reviewer"}, 11)
	if p, r := karmaMember(t, k, peer.m.ID), karmaMember(t, k, g.m.ID); p.Karma != 200 || r.Karma != 120 {
		t.Fatalf("backfill: solver %d reviewer %d", p.Karma, r.Karma)
	}
	var marker KarmaBackfill
	if e := get(k.Store, "karma_backfill/central/solver/CS-1", &marker); e != nil || marker.Member != peer.m.ID || marker.Karma != 100 || marker.Height != 9 || marker.ApprovedBy != g.m.ID {
		t.Fatal(marker, e)
	}
	for _, row := range karmaRows(t, k, "karma") {
		var entry KarmaEntry
		if e := json.Unmarshal(row.Value, &entry); e != nil || entry.Kind != "central_award_backfill" {
			t.Fatal(entry, e)
		}
	}
	// A later award gets Karma live and cannot be backfilled again.
	karmaCentralTask(t, k, lead, "CT-2", "5000000", "1000000", 12)
	karmaCentralDecide(t, k, lead, peer, g, "CT-2", "CS-2", "accept", 13)
	rejectCommand(t, k, g, "", "karma_central_backfill", map[string]any{"submission": "CS-2", "role": "solver"}, 15)
	if p := karmaMember(t, k, peer.m.ID); p.Karma != 205 {
		t.Fatal(p.Karma)
	}
}

func karmaPenaltyEntry(t *testing.T, k Keeper) KarmaEntry {
	t.Helper()
	for _, row := range karmaRows(t, k, "karma") {
		var entry KarmaEntry
		if e := json.Unmarshal(row.Value, &entry); e != nil {
			t.Fatal(e)
		}
		if entry.Delta < 0 {
			return entry
		}
	}
	t.Fatal("no penalty entry")
	return KarmaEntry{}
}

func TestKarmaV2PenaltyConversionRestoresKarmaAddsStrikesOnce(t *testing.T) {
	k, lead, peer, g := fixture(t)
	createInstance(t, k, lead, "lead-a", "family-a")
	lead.m = karmaMember(t, k, lead.m.ID)
	lead.m.Creator = true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	instanceCommand(t, k, lead, "lead-a", "open_project", map[string]any{"id": "P-1", "title": "Research project", "class": "benevolent", "prior_art": prior}, 2)
	command(t, k, peer, "flag", map[string]any{"id": "F-1", "project": "P-1", "evidence_digest": digest}, 3)
	command(t, k, g, "decide_flag", map[string]any{"flag": "F-1", "decision": "upheld", "evidence_digest": digest}, 4)
	entry := karmaPenaltyEntry(t, k)
	if entry.Instance != "lead-a" || karmaMember(t, k, lead.m.ID).Karma != 998 {
		t.Fatal(entry)
	}
	rejectCommand(t, k, g, "", "karma_penalty_convert", map[string]any{"entry": entry.ID}, 5)
	karmaV2On(t, k, g, 5)
	rejectCommand(t, k, g, "", "karma_penalty_convert", map[string]any{"entry": entry.ID}, 5)
	rejectCommand(t, k, lead, "", "karma_penalty_convert", map[string]any{"entry": entry.ID}, 6)
	rejectCommand(t, k, g, "", "karma_penalty_convert", map[string]any{"entry": "1"}, 6)
	command(t, k, g, "karma_penalty_convert", map[string]any{"entry": entry.ID}, 6)
	rejectCommand(t, k, g, "", "karma_penalty_convert", map[string]any{"entry": entry.ID}, 7)
	m := karmaMember(t, k, lead.m.ID)
	v, _ := k.Instance("lead-a")
	if m.Karma != 1000 || m.Strikes != 2 || m.Licence != "active" || v.Karma != 0 {
		t.Fatalf("conversion: %+v %+v", m, v)
	}
	// The restoring row is positive and cannot itself be converted.
	rows := karmaRows(t, k, "karma")
	var restored KarmaEntry
	if len(rows) != 2 || json.Unmarshal(rows[1].Value, &restored) != nil || restored.Delta != 2 || restored.Kind != "penalty_converted" || restored.Ref != entry.ID {
		t.Fatal(rows)
	}
	rejectCommand(t, k, g, "", "karma_penalty_convert", map[string]any{"entry": restored.ID}, 7)
	var s StrikeEntry
	if e := get(k.Store, "strike/00000000000000000001", &s); e != nil || s.Points != 2 || s.Kind != "converted_penalty" || s.Ref != entry.ID || s.Instance != "lead-a" {
		t.Fatal(s, e)
	}
}

func TestKarmaV2PenaltyConversionRevocationRules(t *testing.T) {
	// A member revoked at -10 before activation gets the Karma back but stays revoked.
	k, lead, peer, g := fixture(t)
	lead.m.Karma, lead.m.Creator = -8, true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	karmaFlagPenalty(t, k, lead, peer, g, "P-1", "F-1", 1)
	karmaV2On(t, k, g, 4)
	command(t, k, g, "karma_penalty_convert", map[string]any{"entry": karmaPenaltyEntry(t, k).ID}, 5)
	if m := karmaMember(t, k, lead.m.ID); m.Karma != -8 || m.Strikes != 2 || m.Licence != "revoked" {
		t.Fatalf("revoked member: %+v", m)
	}

	// An active member whose converted penalty brings strikes to 10 is revoked.
	k, lead, peer, g = fixture(t)
	lead.m.Creator = true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	karmaFlagPenalty(t, k, lead, peer, g, "P-1", "F-1", 1)
	karmaV2On(t, k, g, 4)
	m := karmaMember(t, k, lead.m.ID)
	m.Strikes = 8
	_ = put(k.Store, "member/"+m.ID, m)
	command(t, k, g, "karma_penalty_convert", map[string]any{"entry": karmaPenaltyEntry(t, k).ID}, 5)
	if m = karmaMember(t, k, lead.m.ID); m.Karma != 1000 || m.Strikes != 10 || m.Licence != "revoked" {
		t.Fatalf("active member: %+v", m)
	}
}

func TestKarmaV2ZeroStrikeMemberKeepsExactBytes(t *testing.T) {
	// The Member layout before KarmaPolicyV2.
	type memberV1 struct {
		ID              string `json:"id"`
		PublicKey       string `json:"public_key"`
		Name            string `json:"name"`
		Operator        string `json:"operator"`
		Family          string `json:"family"`
		Licence         string `json:"licence"`
		Karma           int64  `json:"karma"`
		Credits         string `json:"credits"`
		Sequence        uint64 `json:"sequence,string"`
		DefaultVerifier bool   `json:"default_verifier"`
		Creator         bool   `json:"creator"`
		ActiveProjects  int64  `json:"active_projects"`
		AccountPolicy   string `json:"account_policy,omitempty"`
		MetadataDigest  string `json:"metadata_digest,omitempty"`
	}
	a := newActor("author", "operator A", -3, true, true)
	a.m.Sequence, a.m.ActiveProjects, a.m.AccountPolicy, a.m.MetadataDigest = 7, 2, CompactAccountPolicy, digest
	now, e1 := json.Marshal(a.m)
	m := a.m
	old, e2 := json.Marshal(memberV1{m.ID, m.PublicKey, m.Name, m.Operator, m.Family, m.Licence, m.Karma, m.Credits, m.Sequence, m.DefaultVerifier, m.Creator, m.ActiveProjects, m.AccountPolicy, m.MetadataDigest})
	if e1 != nil || e2 != nil || !bytes.Equal(now, old) {
		t.Fatalf("member bytes changed:\n%s\n%s", now, old)
	}
	var back Member
	if e := Decode(old, &back); e != nil || back != a.m {
		t.Fatal(back, e)
	}
	// Strikes are chain-managed: no genesis, enrolment or import member carries any.
	a.m.MetadataDigest, a.m.AccountPolicy = "", ""
	if e := validateMember(a.m); e != nil {
		t.Fatal(e)
	}
	a.m.Strikes = 1
	if validateMember(a.m) == nil {
		t.Fatal("member with strikes accepted")
	}
}
