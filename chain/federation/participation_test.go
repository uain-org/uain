package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"testing"
)

func rejectCommand(t *testing.T, k Keeper, a actor, instance, op string, p any, h int64) {
	t.Helper()
	before, _ := json.Marshal(k.Store)
	if _, err := apply(k, instanceSigned(t, k, a, instance, op, p, h), h); err == nil {
		t.Fatalf("accepted forbidden %s", op)
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatalf("failed %s mutated cached state", op)
	}
}

func membershipFixture(t *testing.T) (Keeper, actor, actor, actor) {
	t.Helper()
	k, lead, peer, def := fixture(t)
	command(t, k, def, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 1)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Prospective research project", "class": "benevolent", "prior_art": prior}, 2)
	return k, lead, peer, def
}

func join(t *testing.T, k Keeper, a actor, instance string, h int64) {
	t.Helper()
	instanceCommand(t, k, a, instance, "project_join", map[string]any{"project": "P-1"}, h)
}

func challengePayload(id string) map[string]any {
	return map[string]any{"id": id, "task": "T-1", "source": "doi:10.1234/public-answer", "note": "This publication already contains the answer requested in the task."}
}

func challengeDecision(id, decision string) map[string]any {
	return map[string]any{"challenge": id, "decision": decision, "note": "The independently examined source demonstrates the recorded decision."}
}

func TestMembershipActivationProspectiveAndAtomic(t *testing.T) {
	k, lead, peer, def := fixture(t)
	rejectCommand(t, k, peer, "", "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 1)
	rejectCommand(t, k, def, "", "activate_membership", map[string]any{"policy": "invented", "evidence_digest": digest}, 1)
	rejectCommand(t, k, def, "", "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, math.MaxInt64)
	command(t, k, def, "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 1)
	// Even after activation in this block, every project in this height uses
	// the old rules. Its stored bytes remain unchanged at the next height.
	creditProject(t, k, lead, def, "0")
	old := bytes.Clone(k.Store.Get([]byte("project/P-1")))
	p, _ := k.Project("P-1")
	if p.MembershipPolicy != "" || bytes.Contains(old, []byte("membership_policy")) {
		t.Fatal("activation changed same-height policy")
	}
	creditTask(t, k, lead, "T-1", 7, 2, false, 2)
	checkWork(t, k, peer, "T-1", 4)
	checkWork(t, k, def, "T-1", 5)
	p, _ = k.Project("P-1")
	if p.MembershipPolicy != "" {
		t.Fatal("old project silently migrated")
	}
	// Shared project allowance still applies; activation creates no new Karma.
	rejectCommand(t, k, lead, "", "open_project", map[string]any{"id": "P-2", "title": "Another research project", "class": "benevolent", "prior_art": prior}, 6)
	rejectCommand(t, k, def, "", "activate_membership", map[string]any{"policy": MembershipPolicy, "evidence_digest": digest}, 6)
}

func TestProjectParticipationExactInstanceAndAuthorReviewGate(t *testing.T) {
	k, lead, peer, def := membershipFixture(t)
	createInstance(t, k, peer, "peer-a", "peer")
	createInstance(t, k, peer, "peer-b", "peer")
	creditTask(t, k, lead, "T-1", 13, 2, false, 3)
	check := map[string]any{"contribution": "RC-T-1", "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}
	rejectCommand(t, k, peer, "peer-a", "verify", check, 5)
	rejectCommand(t, k, def, "", "verify", check, 5)
	join(t, k, peer, "peer-a", 5)
	rejectCommand(t, k, peer, "peer-b", "verify", check, 6)
	rejectCommand(t, k, peer, "", "verify", check, 6)
	rejectCommand(t, k, peer, "peer-a", "project_join", map[string]any{"project": "P-1"}, 6)
	instanceCommand(t, k, peer, "peer-a", "submit", map[string]any{"id": "other-answer", "task": "T-1", "evidence_digest": digest}, 6)
	rejectCommand(t, k, peer, "peer-a", "verify", check, 7)
	join(t, k, def, "", 7)
	// A default verifier may have another answer, but still cannot check its
	// own member's contribution. The default exception does not permit siblings.
	command(t, k, def, "submit", map[string]any{"id": "default-answer", "task": "T-1", "evidence_digest": digest}, 8)
	checkWork(t, k, def, "T-1", 9)
	check["contribution"] = "default-answer"
	rejectCommand(t, k, def, "", "verify", check, 10)
	command(t, k, peer, "instance_state", map[string]any{"id": "peer-a", "state": "paused"}, 10)
	rejectCommand(t, k, peer, "peer-a", "challenge_prior_art", challengePayload("paused"), 11)
}

func TestPriorArtChallengeRejectRefileUpheldAndMoot(t *testing.T) {
	k, lead, peer, def := membershipFixture(t)
	creditTask(t, k, lead, "T-1", 13, 2, false, 3)
	rejectCommand(t, k, peer, "", "challenge_prior_art", challengePayload("outside"), 5)
	join(t, k, peer, "", 5)
	command(t, k, peer, "challenge_prior_art", challengePayload("C-1"), 6)
	rejectCommand(t, k, peer, "", "challenge_prior_art", challengePayload("duplicate"), 7)
	rejectCommand(t, k, peer, "", "decide_prior_art", challengeDecision("C-1", "upheld"), 7)
	rejectCommand(t, k, def, "", "decide_prior_art", challengeDecision("C-1", "upheld"), 7)
	join(t, k, def, "", 7)
	command(t, k, def, "decide_prior_art", challengeDecision("C-1", "rejected"), 8)
	task, _ := k.Task("T-1")
	if task.State != "open" || len(task.OpenChallenges) != 0 {
		t.Fatal("rejected challenge closed task or blocked refiling")
	}
	command(t, k, peer, "challenge_prior_art", challengePayload("C-2"), 9)
	command(t, k, lead, "challenge_prior_art", challengePayload("C-3"), 9)
	command(t, k, def, "decide_prior_art", challengeDecision("C-2", "upheld"), 10)
	task, _ = k.Task("T-1")
	v, _ := k.Contribution("RC-T-1")
	moot, _ := k.PriorArtChallenge("C-3")
	if task.State != "known" || task.PriorArtDecision != "C-2" || len(task.OpenChallenges) != 0 || v.State != "withheld" || v.AwardWithheld != "known" || moot.State != "moot" {
		t.Fatal("prior-art closure inconsistent", task, v, moot)
	}
	rejectCommand(t, k, def, "", "decide_prior_art", challengeDecision("C-2", "upheld"), 11)
	rejectCommand(t, k, peer, "", "challenge_prior_art", challengePayload("closed"), 11)
	rejectCommand(t, k, peer, "", "submit", map[string]any{"id": "too-late", "task": "T-1", "evidence_digest": digest}, 11)
	consistency(t, k)
}

func TestPriorArtPreservesPaidAwardAndCancelsFutureReservation(t *testing.T) {
	for _, future := range []bool{false, true} {
		t.Run(fmt.Sprint(future), func(t *testing.T) {
			k, lead, peer, def := membershipFixture(t)
			command(t, k, def, "allocate_budget", map[string]any{"project": "P-1", "credits": "100", "evidence_digest": digest}, 3)
			join(t, k, peer, "", 3)
			join(t, k, def, "", 3)
			creditTask(t, k, lead, "T-1", 13, 2, future, 4)
			checkWork(t, k, peer, "T-1", 6)
			checkWork(t, k, def, "T-1", 7)
			before, _ := k.Member(lead.m.ID)
			command(t, k, lead, "challenge_prior_art", challengePayload("C-1"), 8)
			command(t, k, def, "decide_prior_art", challengeDecision("C-1", "upheld"), 9)
			p, _ := k.Project("P-1")
			task, _ := k.Task("T-1")
			v, _ := k.Contribution("RC-T-1")
			after, _ := k.Member(lead.m.ID)
			if p.Accounting.Reserved != "0" || task.BudgetReserved != "0" || before.Credits != after.Credits || before.Karma != after.Karma {
				t.Fatal("award changed or reservation not released", p, task, before, after)
			}
			if future {
				if v.State != "withheld" || v.Settlement == nil || v.Settlement.Paid || p.Accounting.Spent != "0" {
					t.Fatal("future reward was paid or lost its provenance", v, p)
				}
				rejectCommand(t, k, def, "", "resolve_kpi", map[string]any{"task": "T-1", "observed": "6", "source": "https://example.invalid/evidence", "note": "Published evidence confirms this value.", "evidence_digest": digest}, 10)
			} else if v.State != "settled" || !v.Settlement.Paid || p.Accounting.Spent != "13" || after.Credits != "13" {
				t.Fatal("settled reward was reversed", v, p, after)
			}
			consistency(t, k)
		})
	}
}

func TestTrustedArbiterAppointmentIsActorScopedAndCannotSelfJudge(t *testing.T) {
	k, lead, peer, def := membershipFixture(t)
	createInstance(t, k, peer, "arbiter-a", "peer")
	createInstance(t, k, peer, "arbiter-b", "peer")
	creditTask(t, k, lead, "T-1", 13, 2, false, 3)
	join(t, k, peer, "arbiter-a", 5)
	join(t, k, peer, "arbiter-b", 5)
	command(t, k, lead, "challenge_prior_art", challengePayload("C-1"), 6)
	appointment := map[string]any{"member": peer.m.ID, "instance": "arbiter-a", "active": true, "evidence_digest": digest}
	rejectCommand(t, k, peer, "", "arbiter_appoint", appointment, 7)
	command(t, k, def, "arbiter_appoint", appointment, 7)
	rejectCommand(t, k, peer, "arbiter-b", "decide_prior_art", challengeDecision("C-1", "rejected"), 8)
	instanceCommand(t, k, peer, "arbiter-a", "decide_prior_art", challengeDecision("C-1", "rejected"), 8)
	instanceCommand(t, k, peer, "arbiter-b", "challenge_prior_art", challengePayload("C-2"), 9)
	rejectCommand(t, k, peer, "arbiter-a", "decide_prior_art", challengeDecision("C-2", "upheld"), 10)
	appointment["active"] = false
	command(t, k, def, "arbiter_appoint", appointment, 10)
	command(t, k, lead, "challenge_prior_art", challengePayload("C-3"), 11)
	rejectCommand(t, k, peer, "arbiter-a", "decide_prior_art", challengeDecision("C-3", "rejected"), 12)
}

func TestPriorArtSourceAndOpenChallengeBounds(t *testing.T) {
	for _, s := range []string{"http://example.org/source", "https://example.org/source", "10.1234/example", "doi:10.1234/example", "PMID: 1234"} {
		if !publicPriorArtSource(s) {
			t.Fatal("public prior-art source rejected", s)
		}
	}
	for _, s := range []string{"NCT12345678", "file:///private", "https://secret@example.org/source", "free text", "https://", "PMID:1234567890"} {
		if publicPriorArtSource(s) {
			t.Fatal("unsupported source accepted", s)
		}
	}
	k, lead, _, def := membershipFixture(t)
	creditTask(t, k, lead, "T-1", 13, 2, false, 3)
	join(t, k, def, "", 5)
	for i := 0; i < MaxOpenChallengesPerTask; i++ {
		a := newActor(fmt.Sprintf("challenger-%d", i), "fixture operator", 0, false, false)
		if err := put(k.Store, "member/"+a.m.ID, a.m); err != nil {
			t.Fatal(err)
		}
		join(t, k, a, "", 6)
		command(t, k, a, "challenge_prior_art", challengePayload(fmt.Sprintf("C-%d", i)), 7)
	}
	rejectCommand(t, k, lead, "", "challenge_prior_art", challengePayload("overflow"), 8)
	command(t, k, def, "decide_prior_art", challengeDecision("C-0", "rejected"), 9)
	command(t, k, lead, "challenge_prior_art", challengePayload("replacement"), 10)
	command(t, k, def, "decide_prior_art", challengeDecision("replacement", "upheld"), 11)
	for i := 1; i < MaxOpenChallengesPerTask; i++ {
		c, _ := k.PriorArtChallenge(fmt.Sprintf("C-%d", i))
		if c.State != "moot" {
			t.Fatal("open challenge survived known closure", c)
		}
	}
}
