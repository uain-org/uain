package federation

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/uain-org/uain/chain/coin"
)

// Test block time equals the height in Unix seconds (keeper_test.go apply), so the
// contest and condition times below are heights.

const statesWeek = 7 * 24 * 3600

func statesOn(t *testing.T, k Keeper, g actor, height int64) {
	t.Helper()
	command(t, k, g, "central_task_states_activate", map[string]any{"policy": CentralTaskStatesPolicy, "evidence_digest": digest}, height)
}

func statesTerms(id string, extra map[string]any) map[string]any {
	terms := map[string]any{"id": id, "project": "P-central", "title": "Check bounded result", "criteria": "result equals 42", "acceptance_digest": centralDigest("result equals 42"), "eligibility": "hard", "eligibility_digest": digest, "solver_amount": "100000000", "reviewer_amount": "20000000", "evidence_digest": digest}
	for key, v := range extra {
		terms[key] = v
	}
	return terms
}

func statesEntry(id, task, evidence string) map[string]any {
	return map[string]any{"id": id, "task": task, "evidence": evidence, "evidence_digest": centralDigest(evidence)}
}

func statesReview(sub, verdict, execution, evidence string) map[string]any {
	in := centralReviewInput(sub, verdict, execution)
	in["evidence_digest"] = centralDigest(evidence)
	return in
}

func statesLedger(t *testing.T, k Keeper) coin.Ledger {
	t.Helper()
	var l coin.Ledger
	if e := get(k.Store, "coin_supply", &l); e != nil {
		t.Fatal(e)
	}
	return l
}

func statesBalance(k Keeper, member string) string {
	balance := "0"
	if k.Store.Get([]byte("coin_balance/"+member)) != nil {
		_ = get(k.Store, "coin_balance/"+member, &balance)
	}
	return balance
}

func statesBudget(t *testing.T, k Keeper) CentralBudget {
	t.Helper()
	var b CentralBudget
	if e := get(k.Store, "central_project_budget/P-central", &b); e != nil {
		t.Fatal(e)
	}
	return b
}

// statesActors adds licensed members who may enter contests.
func statesActors(t *testing.T, k Keeper, names ...string) []actor {
	t.Helper()
	out := []actor{}
	for _, name := range names {
		a := newActor(name, "operator "+name, 10, false, false)
		if e := put(k.Store, "member/"+a.m.ID, a.m); e != nil {
			t.Fatal(e)
		}
		out = append(out, a)
	}
	return out
}

func TestCentralTaskStatesInertUntilActivated(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	for _, op := range []string{"central_task_states_configure", "central_contest_select", "central_contest_settle", "central_condition_resolve", "central_condition_expire"} {
		before, _ := json.Marshal(k.Store)
		_, err := apply(k, signed(t, k, g, op, map[string]any{"task": "CT-1"}, 5), 5)
		after, _ := json.Marshal(k.Store)
		if err == nil || err.Error() != "unsupported federation operation" || !bytes.Equal(before, after) {
			t.Fatalf("%s before activation: %v", op, err)
		}
	}
	// The new central_task_open fields are unknown fields before activation.
	rejectCommand(t, k, lead, "", "central_task_open", statesTerms("CT-c", map[string]any{"mode": "contest"}), 5)
	rejectCommand(t, k, lead, "", "central_task_open", statesTerms("CT-c", map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"}), 5)
	// Only a guardian activates, with the exact policy, once.
	rejectCommand(t, k, lead, "", "central_task_states_activate", map[string]any{"policy": CentralTaskStatesPolicy, "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "central_task_states_activate", map[string]any{"policy": "other", "evidence_digest": digest}, 5)
	rejectCommand(t, k, g, "", "central_task_states_activate", map[string]any{"policy": CentralTaskStatesPolicy, "evidence_digest": "x"}, 5)
	statesOn(t, k, g, 5)
	rejectCommand(t, k, g, "", "central_task_states_activate", map[string]any{"policy": CentralTaskStatesPolicy, "evidence_digest": digest}, 6)
	var a CentralTaskStatesActivation
	if e := get(k.Store, centralTaskStatesKey, &a); e != nil {
		t.Fatal(e)
	}
	if a.Height != 6 || a.ApprovedBy != g.m.ID || a.Params != DefaultCentralTaskStatesParams() {
		t.Fatal(a)
	}
	// The activation block itself still refuses the new operations and fields.
	_, err := apply(k, signed(t, k, g, "central_contest_settle", map[string]any{"task": "CT-1"}, 5), 5)
	if err == nil || err.Error() != "unsupported federation operation" {
		t.Fatal("new operation ran in the activation block", err)
	}
	_ = peer
}

// After activation an ordinary task (no mode, no payout) writes exactly the bytes it
// would have written before: same task, submission, review and award records.
func TestCentralTaskStatesOrdinaryTaskBytesUnchanged(t *testing.T) {
	base, lead, peer, g := centralFixture(t)
	clone := func() Keeper {
		next := memory{}
		for key, v := range base.Store.(memory) {
			next[key] = bytes.Clone(v)
		}
		return Keeper{Store: next}
	}
	run := func(k Keeper, activate bool) map[string][]byte {
		if activate {
			statesOn(t, k, g, 4)
		}
		centralOpen(t, k, lead, "CT-1", "100", "20")
		centralSubmit(t, k, peer, "CS-1", "CT-1")
		command(t, k, g, "central_review", centralReviewInput("CS-1", "reject", "exec-1"), 7)
		command(t, k, lead, "central_task_fund", map[string]any{"task": "CT-1", "evidence_digest": digest}, 8)
		centralSubmit(t, k, peer, "CS-2", "CT-1")
		command(t, k, g, "central_review", centralReviewInput("CS-2", "accept", "exec-2"), 9)
		out := map[string][]byte{}
		for _, key := range []string{"central_task/CT-1", "central_submission/CS-1", "central_submission/CS-2", "central_award/solver/CS-2", "central_award/reviewer/CS-1", "central_award/reviewer/CS-2", "coin_supply", "central_project_budget/P-central", "coin_balance/" + peer.m.ID, "central_earnings/" + peer.m.ID} {
			out[key] = append([]byte(nil), k.Store.Get([]byte(key))...)
		}
		return out
	}
	before, after := run(clone(), false), run(clone(), true)
	for key, value := range before {
		if len(value) == 0 || !bytes.Equal(value, after[key]) {
			t.Fatalf("%s changed: %s vs %s", key, value, after[key])
		}
	}
	if bytes.Contains(after["central_task/CT-1"], []byte("hash_version")) {
		t.Fatal("ordinary task gained a hash version")
	}
}

func TestCentralTaskStatesConfigureIsGuardianOnlyAndAppliesToNewTasks(t *testing.T) {
	k, lead, _, g := centralFixture(t)
	params := DefaultCentralTaskStatesParams()
	params.ContestMinSeconds = 100
	params.ContestDefaultSeconds = 1000
	params.MaxEntriesDefault = 3
	in := map[string]any{"params": params, "evidence_digest": digest}
	rejectCommand(t, k, g, "", "central_task_states_configure", in, 4)
	statesOn(t, k, g, 4)
	rejectCommand(t, k, lead, "", "central_task_states_configure", in, 5)
	invalid := params
	invalid.ContestMinSeconds = invalid.ContestMaxSeconds + 1
	rejectCommand(t, k, g, "", "central_task_states_configure", map[string]any{"params": invalid, "evidence_digest": digest}, 5)
	invalid = params
	invalid.MaxEntriesLimit = 2
	rejectCommand(t, k, g, "", "central_task_states_configure", map[string]any{"params": invalid, "evidence_digest": digest}, 5)
	command(t, k, lead, "central_task_open", statesTerms("CT-before", map[string]any{"mode": "contest"}), 5)
	command(t, k, g, "central_task_states_configure", in, 5)
	command(t, k, lead, "central_task_open", statesTerms("CT-after", map[string]any{"mode": "contest"}), 6)
	if x := centralTaskRecord(t, k, "CT-before"); x.ClosesAt != 5+statesWeek || x.MaxEntries != 20 {
		t.Fatal("configuration changed an open task", x)
	}
	if x := centralTaskRecord(t, k, "CT-after"); x.ClosesAt != 6+1000 || x.MaxEntries != 3 || x.SelectBy != 6+1000+72*3600 {
		t.Fatal(x)
	}
}

func TestCentralTaskStatesOpenValidation(t *testing.T) {
	k, lead, _, g := centralFixture(t)
	statesOn(t, k, g, 4)
	h := int64(5)
	for name, extra := range map[string]map[string]any{
		"unknown mode":                       {"mode": "auction"},
		"unknown payout":                     {"payout": "later"},
		"closes too soon":                    {"mode": "contest", "closes_at": "100"},
		"closes too late":                    {"mode": "contest", "closes_at": "99999999"},
		"closes not canonical":               {"mode": "contest", "closes_at": "0200000"},
		"entries over limit":                 {"mode": "contest", "max_entries": "101"},
		"zero entries":                       {"mode": "contest", "max_entries": "0"},
		"single with close":                  {"mode": "single", "closes_at": "200000"},
		"immediate with condition":           {"condition": "The named bill passes into law."},
		"condition without date":             {"payout": "conditional", "condition": "The named bill passes into law."},
		"condition too short":                {"payout": "conditional", "condition": "soon", "resolves_by": "100000"},
		"condition in the past":              {"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "5"},
		"condition beyond two years":         {"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "70000000"},
		"condition before contest selection": {"mode": "contest", "payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"},
		"other unknown field":                {"mode": "contest", "prize": "1"},
	} {
		if _, err := apply(k, signed(t, k, lead, "central_task_open", statesTerms("CT-bad", extra), h), h); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	// Explicit defaults are today's task.
	command(t, k, lead, "central_task_open", statesTerms("CT-plain", map[string]any{"mode": "single", "payout": "immediate"}), h)
	if raw := k.Store.Get([]byte("central_task/CT-plain")); bytes.Contains(raw, []byte("mode")) || bytes.Contains(raw, []byte("hash_version")) {
		t.Fatal(string(raw))
	}
	command(t, k, lead, "central_task_open", statesTerms("CT-c", map[string]any{"mode": "contest", "closes_at": "86405", "max_entries": "2"}), h)
	x := centralTaskRecord(t, k, "CT-c")
	if x.HashVersion != CentralTaskStatesHashVersion || x.State != "contest_open" || x.ClosesAt != 86405 || x.MaxEntries != 2 || x.Reserved != "120000000" {
		t.Fatal(x)
	}
	command(t, k, lead, "central_task_open", statesTerms("CT-k", map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"}), h)
	x = centralTaskRecord(t, k, "CT-k")
	if x.HashVersion != CentralTaskStatesHashVersion || x.State != "open" || x.Payout != "conditional" || x.ResolvesBy != 100000 || x.ExpiresAt != 100000+30*24*3600 || x.ConditionDigest != CentralConditionDigest("The named bill passes into law.", 100000) {
		t.Fatal(x)
	}
}

func conditionalFixture(t *testing.T) (Keeper, actor, actor, actor) {
	t.Helper()
	k, lead, peer, g := centralFixture(t)
	statesOn(t, k, g, 4)
	command(t, k, lead, "central_task_open", statesTerms("CT-1", map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"}), 5)
	command(t, k, peer, "central_submit", statesEntry("CS-1", "CT-1", "42"), 6)
	return k, lead, peer, g
}

func TestConditionalApprovedReservesThenPaysWhenMet(t *testing.T) {
	k, lead, peer, g := conditionalFixture(t)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	x := centralTaskRecord(t, k, "CT-1")
	v := centralSubmission(t, k, "CS-1")
	if x.State != "conditional_approved" || x.Winner != "CS-1" || x.Pending != "" || x.Reserved != "100000000" || x.Paid != "20000000" || v.State != "conditional" {
		t.Fatal(x, v)
	}
	if l := statesLedger(t, k); l.Minted != "20000000" || l.Reserved != "100000000" {
		t.Fatal("solver amount minted before the condition", l)
	}
	if b := statesBudget(t, k); b.Reserved != "100000000" || b.Paid != "20000000" {
		t.Fatal(b)
	}
	if statesBalance(k, peer.m.ID) != "0" || statesBalance(k, g.m.ID) != "20000000" || k.Store.Get([]byte("central_award/solver/CS-1")) != nil {
		t.Fatal("winner paid before the condition")
	}
	// Others are locked out; the condition cannot be called unmet before its date.
	rejectCommand(t, k, lead, "", "central_submit", statesEntry("CS-2", "CT-1", "42"), 8)
	rejectCommand(t, k, g, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "unmet", "source_digest": digest, "evidence_digest": digest}, 8)
	rejectCommand(t, k, lead, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 8)
	rejectCommand(t, k, peer, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 8)
	rejectCommand(t, k, g, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": "nope", "evidence_digest": digest}, 8)
	rejectCommand(t, k, peer, "", "central_condition_expire", map[string]any{"task": "CT-1"}, 8)
	command(t, k, g, "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 9)
	x = centralTaskRecord(t, k, "CT-1")
	if x.State != "accepted" || x.Reserved != "0" || x.Paid != "120000000" || centralSubmission(t, k, "CS-1").State != "accepted" {
		t.Fatal(x)
	}
	if l := statesLedger(t, k); l.Minted != "120000000" || l.Reserved != "0" {
		t.Fatal(l)
	}
	if statesBalance(k, peer.m.ID) != "100000000" || k.Store.Get([]byte("central_award/solver/CS-1")) == nil {
		t.Fatal("winner not paid")
	}
	var r CentralConditionResolution
	if e := get(k.Store, "central_condition_resolution/CT-1", &r); e != nil || r.HashVersion != 2 || r.Outcome != "met" || r.Member != peer.m.ID || r.AttestedBy != g.m.ID || r.ConditionDigest != x.ConditionDigest {
		t.Fatal(r, e)
	}
	rejectCommand(t, k, g, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 10)
	rejectCommand(t, k, peer, "", "central_condition_expire", map[string]any{"task": "CT-1"}, 99999999)
}

func TestConditionalApprovedUnmetAfterDateReleasesWithoutMint(t *testing.T) {
	k, _, peer, g := conditionalFixture(t)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	command(t, k, g, "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "unmet", "source_digest": digest, "evidence_digest": digest}, 100000)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "conditional_expired" || x.Reserved != "0" || x.Paid != "20000000" || centralSubmission(t, k, "CS-1").State != "condition_unmet" {
		t.Fatal(x)
	}
	if l := statesLedger(t, k); l.Minted != "20000000" || l.Reserved != "0" {
		t.Fatal(l)
	}
	if b := statesBudget(t, k); b.Reserved != "0" || b.Paid != "20000000" {
		t.Fatal(b)
	}
	if statesBalance(k, peer.m.ID) != "0" {
		t.Fatal("unmet condition paid the winner")
	}
	// Terminal: no refund, no new submission.
	rejectCommand(t, k, peer, "", "central_submit", statesEntry("CS-2", "CT-1", "42"), 100001)
	rejectCommand(t, k, g, "", "central_task_fund", map[string]any{"task": "CT-1", "evidence_digest": digest}, 100001)
}

func TestConditionalApprovedExpiresForAnyoneAfterGrace(t *testing.T) {
	k, lead, peer, g := conditionalFixture(t)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	expires := centralTaskRecord(t, k, "CT-1").ExpiresAt
	rejectCommand(t, k, lead, "", "central_condition_expire", map[string]any{"task": "CT-1"}, expires-1)
	// The attestor may still confirm late inside the grace period, but not after it.
	rejectCommand(t, k, g, "", "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, expires)
	command(t, k, lead, "central_condition_expire", map[string]any{"task": "CT-1"}, expires)
	if x := centralTaskRecord(t, k, "CT-1"); x.State != "conditional_expired" || x.Reserved != "0" {
		t.Fatal(x)
	}
	var r CentralConditionResolution
	if e := get(k.Store, "central_condition_resolution/CT-1", &r); e != nil || r.Outcome != "expired" || r.AttestedBy != lead.m.ID {
		t.Fatal(r)
	}
	if l := statesLedger(t, k); l.Minted != "20000000" || l.Reserved != "0" || statesBalance(k, peer.m.ID) != "0" {
		t.Fatal(l)
	}
}

// A 0 on a conditional task behaves as today (reviewer paid, solver amount released,
// task unfunded until refunded) and the condition stays fixed.
func TestConditionalTaskRejectAndRefundCompose(t *testing.T) {
	k, lead, peer, g := conditionalFixture(t)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "reject", "exec-1"), 7)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "open_unfunded" || x.Reserved != "0" || x.Payout != "conditional" {
		t.Fatal(x)
	}
	command(t, k, lead, "central_task_fund", map[string]any{"task": "CT-1", "evidence_digest": digest}, 8)
	command(t, k, peer, "central_submit", statesEntry("CS-2", "CT-1", "42"), 9)
	command(t, k, g, "central_review", centralReviewInput("CS-2", "accept", "exec-2"), 10)
	if x = centralTaskRecord(t, k, "CT-1"); x.State != "conditional_approved" || x.Winner != "CS-2" {
		t.Fatal(x)
	}
}

// The S6 evidence journey runs unchanged before a conditional accept.
func TestConditionalTaskNeedsEvidenceThenRevisionThenConditional(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	statesOn(t, k, g, 4)
	centralEvidenceOn(t, k, g, "100", 4)
	command(t, k, lead, "central_task_open", statesTerms("CT-1", map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"}), 5)
	command(t, k, peer, "central_submit", statesEntry("CS-1", "CT-1", "42"), 6)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "needs_evidence", "exec-1"), 7)
	command(t, k, peer, "central_submit", revisionInput("CS-2", "CS-1", "43"), 8)
	command(t, k, g, "central_review", revisionReview("CS-2", "accept", "exec-2", "43"), 9)
	if x := centralTaskRecord(t, k, "CT-1"); x.State != "conditional_approved" || x.Winner != "CS-2" {
		t.Fatal(x)
	}
}

func contestFixture(t *testing.T, extra map[string]any) (Keeper, actor, actor, actor, []actor) {
	t.Helper()
	k, lead, peer, g := centralFixture(t)
	statesOn(t, k, g, 4)
	terms := map[string]any{"mode": "contest", "closes_at": "100000"}
	for key, v := range extra {
		terms[key] = v
	}
	command(t, k, lead, "central_task_open", statesTerms("CT-1", terms), 5)
	return k, lead, peer, g, statesActors(t, k, "entrant-a", "entrant-b", "entrant-c")
}

func TestBeautyContestEntriesScoresAndSelection(t *testing.T) {
	k, lead, peer, g, e := contestFixture(t, map[string]any{"max_entries": "4"})
	command(t, k, peer, "central_submit", statesEntry("CE-1", "CT-1", "41"), 6)
	command(t, k, e[0], "central_submit", statesEntry("CE-2", "CT-1", "42"), 7)
	command(t, k, e[1], "central_submit", statesEntry("CE-3", "CT-1", "42 with a proof"), 8)
	// One entry per member; the reviewer may not enter; a revision is not an entry.
	rejectCommand(t, k, peer, "", "central_submit", statesEntry("CE-4", "CT-1", "42"), 9)
	rejectCommand(t, k, g, "", "central_submit", statesEntry("CE-4", "CT-1", "42"), 9)
	rejectCommand(t, k, lead, "", "central_submit", revisionInput("CE-4", "CE-1", "42"), 9)
	x := centralTaskRecord(t, k, "CT-1")
	if x.Entries != 3 || x.Pending != "" || x.State != "contest_open" || centralSubmission(t, k, "CE-3").Entry != 3 {
		t.Fatal(x)
	}
	var indexed string
	if err := get(k.Store, "central_contest_entries/CT-1/00000000000000000002", &indexed); err != nil || indexed != "CE-2" {
		t.Fatal(indexed, err)
	}
	// Scores: only the reviewer, only accept or reject, no AI$ moves.
	rejectCommand(t, k, lead, "", "central_review", statesReview("CE-1", "reject", "exec-1", "41"), 10)
	rejectCommand(t, k, g, "", "central_review", statesReview("CE-1", "needs_evidence", "exec-1", "41"), 10)
	command(t, k, g, "central_review", statesReview("CE-1", "reject", "exec-1", "41"), 10)
	command(t, k, g, "central_review", statesReview("CE-3", "accept", "exec-3", "42 with a proof"), 11)
	rejectCommand(t, k, g, "", "central_review", statesReview("CE-3", "reject", "exec-3b", "42 with a proof"), 12)
	if l := statesLedger(t, k); l.Minted != "0" || l.Reserved != "120000000" {
		t.Fatal("scoring moved AI$", l)
	}
	// Selection waits for the close and for every entry to be scored.
	rejectCommand(t, k, g, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-3", "evidence_digest": digest}, 12)
	command(t, k, e[2], "central_submit", statesEntry("CE-5", "CT-1", "forty-two"), 13)
	rejectCommand(t, k, lead, "", "central_submit", statesEntry("CE-6", "CT-1", "42"), 100000)
	rejectCommand(t, k, g, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-3", "evidence_digest": digest}, 100000)
	command(t, k, g, "central_review", statesReview("CE-2", "accept", "exec-2", "42"), 100000)
	command(t, k, g, "central_review", statesReview("CE-5", "reject", "exec-5", "forty-two"), 100001)
	rejectCommand(t, k, lead, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-3", "evidence_digest": digest}, 100002)
	rejectCommand(t, k, g, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-1", "evidence_digest": digest}, 100002)
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 100002)
	// The reviewer picks the best scored entry, not necessarily the first.
	command(t, k, g, "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-3", "evidence_digest": digest}, 100002)
	x = centralTaskRecord(t, k, "CT-1")
	if x.State != "accepted" || x.Winner != "CE-3" || x.Reserved != "0" || x.Paid != "120000000" || centralSubmission(t, k, "CE-3").State != "accepted" {
		t.Fatal(x)
	}
	if statesBalance(k, e[1].m.ID) != "100000000" || statesBalance(k, g.m.ID) != "20000000" {
		t.Fatal("winner or reviewer not paid")
	}
	// Losing entries earn nothing, cost nothing and stay public.
	for _, loser := range []actor{peer, e[0], e[2]} {
		if statesBalance(k, loser.m.ID) != "0" {
			t.Fatal("losing entry paid")
		}
	}
	if v := centralSubmission(t, k, "CE-2"); v.State != "shortlisted" || v.Evidence != "42" {
		t.Fatal(v)
	}
	var sel CentralContestSelection
	if err := get(k.Store, "central_contest_selection/CT-1", &sel); err != nil || sel.HashVersion != 2 || sel.Outcome != "selected" || sel.Submission != "CE-3" || sel.Entries != 4 || sel.Shortlisted != 2 || !sel.ReviewerPaid {
		t.Fatal(sel)
	}
	if l := statesLedger(t, k); l.Minted != "120000000" || l.Reserved != "0" {
		t.Fatal(l)
	}
	rejectCommand(t, k, g, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-2", "evidence_digest": digest}, 100003)
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 9999999)
}

func TestBeautyContestFullAndClosed(t *testing.T) {
	k, lead, peer, _, e := contestFixture(t, map[string]any{"max_entries": "2"})
	command(t, k, peer, "central_submit", statesEntry("CE-1", "CT-1", "42"), 6)
	command(t, k, e[0], "central_submit", statesEntry("CE-2", "CT-1", "42"), 7)
	rejectCommand(t, k, e[1], "", "central_submit", statesEntry("CE-3", "CT-1", "42"), 8)
	_ = lead
}

// If the reviewer has not selected by select_by, anyone may settle: the earliest
// entry scored 1 wins, whatever order the scores came in.
func TestBeautyContestFallbackPicksEarliestShortlisted(t *testing.T) {
	k, lead, peer, g, e := contestFixture(t, nil)
	command(t, k, peer, "central_submit", statesEntry("CE-1", "CT-1", "42"), 6)
	command(t, k, e[0], "central_submit", statesEntry("CE-2", "CT-1", "42"), 7)
	command(t, k, e[1], "central_submit", statesEntry("CE-3", "CT-1", "42"), 8)
	command(t, k, g, "central_review", statesReview("CE-3", "accept", "exec-3", "42"), 9)
	command(t, k, g, "central_review", statesReview("CE-2", "accept", "exec-2", "42"), 10)
	if x := centralTaskRecord(t, k, "CT-1"); x.Leading != "CE-2" {
		t.Fatal(x)
	}
	selectBy := centralTaskRecord(t, k, "CT-1").SelectBy
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 100000)
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, selectBy-1)
	// After select_by neither a late score nor a late selection is possible.
	rejectCommand(t, k, g, "", "central_review", statesReview("CE-1", "accept", "exec-1", "42"), selectBy)
	rejectCommand(t, k, g, "", "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-3", "evidence_digest": digest}, selectBy)
	command(t, k, lead, "central_contest_settle", map[string]any{"task": "CT-1"}, selectBy)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "accepted" || x.Winner != "CE-2" || statesBalance(k, e[0].m.ID) != "100000000" || statesBalance(k, g.m.ID) != "20000000" {
		t.Fatal(x)
	}
	var sel CentralContestSelection
	if err := get(k.Store, "central_contest_selection/CT-1", &sel); err != nil || sel.Outcome != "fallback" || sel.DecidedBy != lead.m.ID {
		t.Fatal(sel)
	}
	if v := centralSubmission(t, k, "CE-1"); v.State != "under_review" || statesBalance(k, peer.m.ID) != "0" {
		t.Fatal(v)
	}
}

func TestBeautyContestNoEntriesReleasesEverything(t *testing.T) {
	k, lead, _, _, _ := contestFixture(t, nil)
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 99999)
	command(t, k, lead, "central_contest_settle", map[string]any{"task": "CT-1"}, 100000)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "no_winner" || x.Reserved != "0" || x.Paid != "0" {
		t.Fatal(x)
	}
	if l := statesLedger(t, k); l.Minted != "0" || l.Reserved != "0" {
		t.Fatal(l)
	}
	if b := statesBudget(t, k); b.Reserved != "0" || b.Paid != "0" {
		t.Fatal(b)
	}
	var sel CentralContestSelection
	if err := get(k.Store, "central_contest_selection/CT-1", &sel); err != nil || sel.Outcome != "no_winner" || sel.ReviewerPaid {
		t.Fatal(sel)
	}
}

func TestBeautyContestAllRejectedPaysReviewerOnlyAfterClose(t *testing.T) {
	k, lead, peer, g, e := contestFixture(t, nil)
	command(t, k, peer, "central_submit", statesEntry("CE-1", "CT-1", "41"), 6)
	command(t, k, e[0], "central_submit", statesEntry("CE-2", "CT-1", "40"), 7)
	command(t, k, g, "central_review", statesReview("CE-1", "reject", "exec-1", "41"), 8)
	command(t, k, g, "central_review", statesReview("CE-2", "reject", "exec-2", "40"), 9)
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 99999)
	command(t, k, e[1], "central_submit", statesEntry("CE-3", "CT-1", "39"), 99999)
	// An unscored entry blocks the early settle until select_by.
	rejectCommand(t, k, lead, "", "central_contest_settle", map[string]any{"task": "CT-1"}, 100000)
	command(t, k, g, "central_review", statesReview("CE-3", "reject", "exec-3", "39"), 100000)
	command(t, k, lead, "central_contest_settle", map[string]any{"task": "CT-1"}, 100001)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "no_winner" || x.Reserved != "0" || x.Paid != "20000000" || x.Winner != "" {
		t.Fatal(x)
	}
	if l := statesLedger(t, k); l.Minted != "20000000" || l.Reserved != "0" || statesBalance(k, g.m.ID) != "20000000" {
		t.Fatal(l)
	}
	if k.Store.Get([]byte("central_award/reviewer/CE-3")) == nil {
		t.Fatal("reviewer award not keyed to the last scored entry")
	}
}

// A contest may pay its winner conditionally: selection binds the winner, the condition pays.
func TestBeautyContestWithConditionalPayout(t *testing.T) {
	resolves := "2000000"
	k, _, peer, g, _ := contestFixture(t, map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": resolves})
	command(t, k, peer, "central_submit", statesEntry("CE-1", "CT-1", "42"), 6)
	command(t, k, g, "central_review", statesReview("CE-1", "accept", "exec-1", "42"), 7)
	command(t, k, g, "central_contest_select", map[string]any{"task": "CT-1", "submission": "CE-1", "evidence_digest": digest}, 100000)
	x := centralTaskRecord(t, k, "CT-1")
	if x.State != "conditional_approved" || x.Winner != "CE-1" || x.Reserved != "100000000" || statesBalance(k, peer.m.ID) != "0" || statesBalance(k, g.m.ID) != "20000000" {
		t.Fatal(x)
	}
	command(t, k, g, "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 200000)
	if x = centralTaskRecord(t, k, "CT-1"); x.State != "accepted" || statesBalance(k, peer.m.ID) != "100000000" {
		t.Fatal(x)
	}
	if l := statesLedger(t, k); l.Minted != "120000000" || l.Reserved != "0" {
		t.Fatal(l)
	}
}

// Under KarmaPolicyV2 every paid award also gives Karma, at the time it is paid.
func TestCentralTaskStatesAwardsGiveKarma(t *testing.T) {
	k, lead, peer, g := centralFixture(t)
	karmaV2On(t, k, g, 4)
	statesOn(t, k, g, 4)
	command(t, k, lead, "central_task_open", statesTerms("CT-1", map[string]any{"payout": "conditional", "condition": "The named bill passes into law.", "resolves_by": "100000"}), 5)
	command(t, k, peer, "central_submit", statesEntry("CS-1", "CT-1", "42"), 6)
	peerBefore := karmaMember(t, k, peer.m.ID).Karma
	reviewerBefore := karmaMember(t, k, g.m.ID).Karma
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	if karmaMember(t, k, g.m.ID).Karma != reviewerBefore+20 || karmaMember(t, k, peer.m.ID).Karma != peerBefore {
		t.Fatal("conditional accept Karma")
	}
	command(t, k, g, "central_condition_resolve", map[string]any{"task": "CT-1", "outcome": "met", "source_digest": digest, "evidence_digest": digest}, 8)
	if karmaMember(t, k, peer.m.ID).Karma != peerBefore+100 {
		t.Fatal("met condition gave no solver Karma")
	}
}

// Project closure must wait while a conditional reservation is outstanding:
// central_fund_close refuses while the project budget has anything reserved.
func TestConditionalReservationCountsAgainstProject(t *testing.T) {
	k, _, _, g := conditionalFixture(t)
	command(t, k, g, "central_review", centralReviewInput("CS-1", "accept", "exec-1"), 7)
	if b := statesBudget(t, k); b.Reserved != "100000000" {
		t.Fatal("conditional reservation not counted against the project", b)
	}
}
