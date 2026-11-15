package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

func operatorProject(t *testing.T, k Keeper, lead, guardian actor) {
	t.Helper()
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, guardian, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	command(t, k, lead, "open_project", map[string]any{"id": "P-1", "title": "Operator independence research fixture", "class": "benevolent", "prior_art": prior}, 3)
	command(t, k, guardian, "allocate_budget", map[string]any{"project": "P-1", "credits": "10000", "evidence_digest": digest}, 4)
}

func proveDomain(t *testing.T, k Keeper, a, guardian actor, instance, domain string, h int64) {
	t.Helper()
	if _, err := k.ActorIdentity(a.m.ID, instance); err != nil {
		instanceCommand(t, k, a, instance, "identity_claim", map[string]any{}, h)
	}
	instanceCommand(t, k, a, instance, "operator_claim", map[string]any{"domain": domain}, h+1)
	command(t, k, guardian, "operator_attest", dnsObservation(t, k, a.m.ID, instance, h+2), h+2)
}

func TestOperatorRewardActivationIsProspectiveAndGuarded(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	lead.m.Creator = true
	_ = put(k.Store, "member/"+lead.m.ID, lead.m)
	payload := map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}
	rejectCommand(t, k, guardian, "", "activate_operator_rewards", payload, 1)
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	rejectCommand(t, k, lead, "", "activate_operator_rewards", payload, 2)
	command(t, k, guardian, "activate_operator_rewards", payload, 2)
	command(t, k, lead, "open_project", map[string]any{"id": "old", "title": "Before effective policy", "class": "benevolent", "prior_art": prior}, 2)
	command(t, k, lead, "open_project", map[string]any{"id": "new", "title": "After effective policy", "class": "benevolent", "prior_art": prior}, 3)
	old, _ := k.Project("old")
	next, _ := k.Project("new")
	if old.OperatorPolicy != "" || next.OperatorPolicy != OperatorRewardPolicy {
		t.Fatal("activation changed same-height project rules", old, next)
	}
	rejectCommand(t, k, guardian, "", "activate_operator_rewards", payload, 4)
}

func TestOperatorRewardsUseProvedDomainsAndModelFamilies(t *testing.T) {
	for _, tc := range []struct {
		name, authorFamily, peerFamily, defaultFamily, peerDomain, defaultDomain string
		sameNames                                                                bool
		factor                                                                   int64
		operators                                                                int
	}{
		{"same_domain", "GPT-6", "Claude Sonnet", "Gemini", "shared.example", "shared.example", false, 3, 1},
		{"different_domains_same_names", "GPT-6", "Claude Sonnet", "Gemini", "peer.example", "default.example", true, 1, 2},
		{"same_model_vendor", "GPT-6", "Codex", "ChatGPT", "peer.example", "default.example", false, 3, 2},
		{"unknown_author", "unknown", "unknown", "unknown", "peer.example", "default.example", false, 1, 2},
		{"unknown_checkers", "GPT-6", "unknown", "unknown", "peer.example", "default.example", false, 3, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			k, lead, peer, guardian := fixture(t)
			lead.m.Family, peer.m.Family, guardian.m.Family = tc.authorFamily, tc.peerFamily, tc.defaultFamily
			if tc.sameNames {
				peer.m.Operator, guardian.m.Operator = lead.m.Operator, lead.m.Operator
			}
			for _, a := range []actor{lead, peer, guardian} {
				_ = put(k.Store, "member/"+a.m.ID, a.m)
			}
			operatorProject(t, k, lead, guardian)
			proveDomain(t, k, lead, guardian, "", "author.example", 10)
			proveDomain(t, k, peer, guardian, "", tc.peerDomain, 20)
			proveDomain(t, k, guardian, guardian, "", tc.defaultDomain, 30)
			creditTask(t, k, lead, "T-1", 100, 2, false, 40)
			checkWork(t, k, peer, "T-1", 42)
			checkWork(t, k, guardian, "T-1", 43)
			v, err := k.Contribution("RC-T-1")
			if err != nil || v.Settlement == nil || !v.Settlement.Paid || v.Settlement.FactorNumerator != tc.factor || v.Settlement.IndependentOperators != tc.operators {
				t.Fatal("wrong prospective award", v, err)
			}
			consistency(t, k)
		})
	}
}

func TestIndependentOperatorsUsesOrderedPairwiseRuleAndExcludesBootstrap(t *testing.T) {
	k, author, a, b := fixture(t)
	c := newActor("third checker", a.m.Operator, 100, false, false)
	_ = put(k.Store, "member/"+c.m.ID, c.m)
	// A and B have distinct names but the same proved domain. C is unproved
	// and shares only A's name: A~B, A~C, while B is independent of C.
	for _, v := range []actor{a, b} {
		_ = put(k.Store, "operator_proof/"+operatorActorKey(v.m.ID, ""), OperatorProof{Member: v.m.ID, Domain: "shared.example"})
	}
	check := func(v actor) Verification { return Verification{Member: v.m.ID, Verdict: "confirm"} }
	for _, tc := range []struct {
		checks []Verification
		count  int
	}{
		{[]Verification{check(a), check(b), check(c)}, 1},
		{[]Verification{check(b), check(c), check(a)}, 2},
		{[]Verification{check(author), {Member: a.m.ID, Verdict: "confirm", Bootstrap: true}, check(b)}, 1},
	} {
		got, err := k.independentOperators(author.m.ID, "", tc.checks)
		if err != nil || got != tc.count {
			t.Fatal("pairwise order/bootstrap mismatch", got, err)
		}
	}
}

func TestResearchStandingIsActorScopedAndRechecksCurrentProofs(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	operatorProject(t, k, lead, guardian)
	proveDomain(t, k, lead, guardian, "", "author.example", 10)
	proveDomain(t, k, peer, guardian, "", "peer.example", 20)
	proveDomain(t, k, guardian, guardian, "", "default.example", 30)
	ids := []string{}
	for i := 0; i < 4; i++ {
		id := fmt.Sprintf("T-%d", i)
		h := int64(40 + i*5)
		creditTask(t, k, lead, id, 100, 2, false, h)
		checkWork(t, k, peer, id, h+2)
		checkWork(t, k, guardian, id, h+3)
		ids = append(ids, "RC-"+id)
	}
	for _, n := range []int{1, 2, 4} {
		command(t, k, lead, "research_standing", map[string]any{"contributions": ids[:n]}, 70)
		tier, err := k.ResearchTier(lead.m.ID, "")
		want := map[int]string{1: "T1", 2: "T2", 4: "T3"}[n]
		if err != nil || tier != want {
			t.Fatal("standing did not reflect paid research", tier, err)
		}
	}
	rejectCommand(t, k, peer, "", "research_standing", map[string]any{"contributions": ids}, 71)
	rejectCommand(t, k, lead, "", "research_standing", map[string]any{"contributions": []string{ids[0], ids[0]}}, 71)
	rejectCommand(t, k, lead, "", "research_standing", map[string]any{"contributions": append(ids, ids[0])}, 71)
	createInstance(t, k, lead, "sibling", "GPT-6")
	rejectCommand(t, k, lead, "sibling", "research_standing", map[string]any{"contributions": ids}, 71)
	before, _ := json.Marshal(k.Store.Get([]byte("contribution/" + ids[0])))
	proveDomain(t, k, peer, guardian, "", "author.example", 80)
	tier, err := k.ResearchTier(lead.m.ID, "")
	if err != nil || tier != "T1" {
		t.Fatal("tier stayed frozen after loss of independence", tier, err)
	}
	after, _ := json.Marshal(k.Store.Get([]byte("contribution/" + ids[0])))
	if !bytes.Equal(before, after) {
		t.Fatal("current qualification rewrote settled reward")
	}
	consistency(t, k)
}

func TestPendingFutureWorkCannotAdvanceResearchStanding(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	operatorProject(t, k, lead, guardian)
	creditTask(t, k, lead, "future", 100, 2, true, 5)
	checkWork(t, k, peer, "future", 7)
	checkWork(t, k, guardian, "future", 8)
	rejectCommand(t, k, lead, "", "research_standing", map[string]any{"contributions": []string{"RC-future"}}, 9)
	if tier, err := k.ResearchTier(lead.m.ID, ""); err != nil || tier != "unrecorded" {
		t.Fatal("failed qualification left standing", tier, err)
	}
}
