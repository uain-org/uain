package federation

import (
	"bytes"
	"fmt"
	"sort"
	"testing"
)

func censusPolicy(t *testing.T, k Keeper, guardian actor, threshold int) {
	t.Helper()
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, guardian, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	command(t, k, guardian, "activate_operator_census", map[string]any{"policy": OperatorCensusPolicy, "threshold": threshold, "evidence_digest": digest}, 3)
}
func censusPage(t *testing.T, k Keeper, who actor, h int64) BootstrapStatus {
	t.Helper()
	command(t, k, who, "operator_census_page", map[string]any{}, h)
	status, err := k.BootstrapState(h)
	if err != nil {
		t.Fatal(err)
	}
	return status
}
func TestOperatorCensusActivationAndFollowingHeight(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	p := map[string]any{"policy": OperatorCensusPolicy, "threshold": 3, "evidence_digest": digest}
	rejectCommand(t, k, guardian, "", "activate_operator_census", p, 1)
	command(t, k, guardian, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	command(t, k, guardian, "activate_operator_rewards", map[string]any{"policy": OperatorRewardPolicy, "evidence_digest": digest}, 2)
	rejectCommand(t, k, lead, "", "activate_operator_census", p, 3)
	for _, threshold := range []int{-1, MaxBootstrapOperators + 1} {
		p["threshold"] = threshold
		rejectCommand(t, k, guardian, "", "activate_operator_census", p, 3)
	}
	p["threshold"] = 3
	command(t, k, guardian, "activate_operator_census", p, 3)
	rejectCommand(t, k, guardian, "", "operator_census_page", map[string]any{}, 3)
	rejectCommand(t, k, guardian, "", "activate_operator_census", p, 4)
	status := censusPage(t, k, lead, 4)
	if !status.Ready || status.Active || status.Operators != 3 {
		t.Fatal(status)
	}
}
func TestOperatorCensusPaginatesWithoutAuthorizingAnIncompleteCount(t *testing.T) {
	guardian := newActor("guardian", "Shared operator", 100, true, false)
	members := []Member{guardian.m}
	for i := 0; i < 65; i++ {
		members = append(members, newActor(fmt.Sprintf("member-%d", i), "Shared operator", 0, false, false).m)
	}
	k := Keeper{Store: memory{}}
	if err := k.Init(Genesis{Version: 1, Guardians: []string{guardian.m.ID}, Members: members}); err != nil {
		t.Fatal(err)
	}
	censusPolicy(t, k, guardian, 3)
	for i := 0; i < 2; i++ {
		s := censusPage(t, k, guardian, int64(4+i))
		if s.Ready || s.Active {
			t.Fatal("partial count authorized bootstrap", s)
		}
		var progress OperatorCensus
		if err := get(k.Store, "operator_census", &progress); err != nil || progress.Scanned != uint64((i+1)*OperatorCensusPage) {
			t.Fatal(progress, err)
		}
	}
	s := censusPage(t, k, guardian, 6)
	if !s.Ready || !s.Active || s.Operators != 1 {
		t.Fatal(s)
	}
	// Ordinary sequence/role writes do not invalidate the completed count.
	command(t, k, guardian, "roles", map[string]any{"member": guardian.m.ID, "default_verifier": true, "creator": true, "evidence_digest": digest}, 7)
	after, err := k.BootstrapState(7)
	if err != nil || after != s {
		t.Fatal(after, err)
	}
}
func TestOperatorCensusInvalidatesLicencesInstancesAndProvedDomains(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	censusPolicy(t, k, guardian, 3)
	before := censusPage(t, k, lead, 4)
	command(t, k, peer, "withdraw", map[string]any{}, 5)
	s, err := k.BootstrapState(5)
	if err != nil || s.Ready || s.Active || s.Revision == before.Revision {
		t.Fatal("stale licence census used", s, err)
	}
	s = censusPage(t, k, lead, 6)
	if !s.Ready || !s.Active || s.Operators != 2 {
		t.Fatal(s)
	}
	command(t, k, lead, "instance_create", map[string]any{"id": "sibling", "name": "same member sibling", "family": "fixture"}, 7)
	s, err = k.BootstrapState(7)
	if err != nil || s.Ready {
		t.Fatal(s, err)
	}
	s = censusPage(t, k, lead, 8)
	if !s.Ready || s.Operators != 2 {
		t.Fatal("sibling inflated operator count", s)
	}
	command(t, k, lead, "instance_state", map[string]any{"id": "sibling", "state": "paused"}, 9)
	s, err = k.BootstrapState(9)
	if err != nil || s.Ready {
		t.Fatal(s, err)
	}
	censusPage(t, k, lead, 10)
	proveDomain(t, k, lead, guardian, "", "same.example", 11)
	s, err = k.BootstrapState(13)
	if err != nil || s.Ready {
		t.Fatal("domain change retained stale count", s, err)
	}
	proveDomain(t, k, guardian, guardian, "", "same.example", 14)
	s = censusPage(t, k, lead, 17)
	if !s.Ready || !s.Active || s.Operators != 1 {
		t.Fatal("proved domains ignored", s)
	}
	before = s
	command(t, k, lead, "operator_claim", map[string]any{"domain": "pending.example"}, 18)
	s, err = k.BootstrapState(18)
	if err != nil || s != before {
		t.Fatal("pending claim erased confirmed operator", s, err)
	}
}
func TestOperatorCensusDisabledAndOldStateUntouched(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	command(t, k, lead, "identity_claim", map[string]any{}, 1)
	if k.Store.Get([]byte("operator_census_revision")) != nil {
		t.Fatal("inactive chain gained census state")
	}
	censusPolicy(t, k, guardian, 0)
	s, err := k.BootstrapState(4)
	if err != nil || !s.Ready || s.Active || s.Threshold != 0 {
		t.Fatal(s, err)
	}
	before := bytes.Clone(k.Store.Get([]byte("operator_census_revision")))
	rejectCommand(t, k, lead, "", "operator_census_page", map[string]any{"cursor": "skip actors"}, 4)
	if !bytes.Equal(before, k.Store.Get([]byte("operator_census_revision"))) {
		t.Fatal("invalid payload advanced revision")
	}
}

func TestOperatorCensusRestartsAfterAnIdentityChangesBehindItsCursor(t *testing.T) {
	guardian := newActor("guardian", "shared operator", 100, true, false)
	members := []Member{guardian.m}
	for i := 0; i < 65; i++ {
		members = append(members, newActor(fmt.Sprintf("paged actor %d", i), guardian.m.Operator, 0, false, false).m)
	}
	sort.Slice(members, func(i, j int) bool { return members[i].ID < members[j].ID })
	k := Keeper{Store: memory{}}
	if err := k.Init(Genesis{Version: 1, Guardians: []string{guardian.m.ID}, Members: members}); err != nil {
		t.Fatal(err)
	}
	censusPolicy(t, k, guardian, 3)
	censusPage(t, k, guardian, 4)
	command(t, k, guardian, "identity_import", map[string]any{"member": members[0].ID, "did": "did:uain:123456789abc", "operator": "independent operator", "evidence_digest": digest}, 5)
	status := censusPage(t, k, guardian, 6)
	var progress OperatorCensus
	if err := get(k.Store, "operator_census", &progress); err != nil || progress.Scanned != OperatorCensusPage || status.Revision == 0 || status.Operators != 2 || status.Ready {
		t.Fatal("a change behind the cursor did not restart counting", status, progress, err)
	}
	censusPage(t, k, guardian, 7)
	status = censusPage(t, k, guardian, 8)
	if !status.Ready || !status.Active || status.Operators != 2 {
		t.Fatal(status)
	}
}

func TestOperatorCensusUsesOrderedPairwiseComparisonsForMixedProofs(t *testing.T) {
	for _, tc := range []struct {
		name     string
		aName    string
		expected int
	}{
		{"both relations share the first representative", "shared operator", 1},
		{"proved equality does not merge declared names", "another operator", 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			actors := []actor{newActor("first", tc.aName, 100, true, false), newActor("second", "shared operator", 100, false, false), newActor("third", "shared operator", 100, false, false)}
			sort.Slice(actors, func(i, j int) bool { return actors[i].m.ID < actors[j].m.ID })
			actors[0].m.Operator = tc.aName
			actors[1].m.Operator = "shared operator"
			actors[2].m.Operator = "shared operator"
			k := Keeper{Store: memory{}}
			if err := k.Init(Genesis{Version: 1, Guardians: []string{actors[0].m.ID}, Members: []Member{actors[0].m, actors[1].m, actors[2].m}}); err != nil {
				t.Fatal(err)
			}
			// Fictional pre-policy state isolates the comparison rule. A and B
			// share a proved domain; C has only its declaration. This relation
			// cannot be represented by equivalence classes or one name map.
			for _, a := range actors[:2] {
				if err := put(k.Store, "operator_proof/"+a.m.ID+"/", OperatorProof{Member: a.m.ID, Domain: "shared.example"}); err != nil {
					t.Fatal(err)
				}
			}
			censusPolicy(t, k, actors[0], 3)
			status := censusPage(t, k, actors[0], 4)
			if !status.Ready || !status.Active || status.Operators != tc.expected {
				t.Fatal(status)
			}
		})
	}
}
