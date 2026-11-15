package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

func arbitrationFixture(t *testing.T, bootstrap ...bool) (Keeper, actor, actor, actor, actor) {
	t.Helper()
	k, lead, peer, guardian := fixture(t)
	arb := newActor("independent arbiter", "operator D", 100, false, false)
	if len(bootstrap) != 0 && bootstrap[0] {
		for _, a := range []*actor{&lead, &peer, &guardian, &arb} {
			a.m.Operator = "single operator"
		}
		for _, a := range []actor{lead, peer, guardian} {
			if err := put(k.Store, "member/"+a.m.ID, a.m); err != nil {
				t.Fatal(err)
			}
		}
	}
	operatorProject(t, k, lead, guardian)
	if err := put(k.Store, "member/"+arb.m.ID, arb.m); err != nil {
		t.Fatal(err)
	}
	command(t, k, guardian, "activate_arbitration", map[string]any{"policy": ArbitrationPolicy, "evidence_digest": digest}, 5)
	creditTask(t, k, lead, "T-1", 100, 2, false, 9)
	return k, lead, peer, guardian, arb
}
func arbitrationPayload(verdict string) map[string]any {
	return map[string]any{"contribution": "RC-T-1", "verdict": verdict, "novelty": "new", "searches": prior.Searches, "evidence_digest": digest, "known_source": "", "no_effort": false}
}
func trustArbitration(t *testing.T, k Keeper, guardian, arb actor) {
	t.Helper()
	command(t, k, guardian, "arbiter_appoint", map[string]any{"member": arb.m.ID, "active": true, "evidence_digest": digest}, 11)
}
func verificationArbitrationPayload(verdict string) map[string]any {
	p := arbitrationPayload(verdict)
	delete(p, "no_effort")
	return p
}
func contestArbitration(t *testing.T, k Keeper, peer actor) {
	t.Helper()
	command(t, k, peer, "verify", verificationArbitrationPayload("dispute"), 12)
}

func TestArbitrationActivationIsProspectiveAndPreservesOldRecords(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	payload := map[string]any{"policy": ArbitrationPolicy, "evidence_digest": digest}
	rejectCommand(t, k, guardian, "", "activate_arbitration", payload, 1)
	operatorProject(t, k, lead, guardian)
	rejectCommand(t, k, peer, "", "activate_arbitration", payload, 5)
	command(t, k, guardian, "activate_arbitration", payload, 5)
	creditTask(t, k, lead, "old", 100, 2, false, 4)
	old := bytes.Clone(k.Store.Get([]byte("contribution/RC-old")))
	creditTask(t, k, lead, "new", 100, 2, false, 6)
	before, _ := k.Contribution("RC-old")
	after, _ := k.Contribution("RC-new")
	if before.ArbitrationPolicy != "" || after.ArbitrationPolicy != ArbitrationPolicy {
		t.Fatal(before, after)
	}
	rejectCommand(t, k, guardian, "", "activate_arbitration", payload, 9)
	if !bytes.Equal(old, k.Store.Get([]byte("contribution/RC-old"))) {
		t.Fatal("activation rewrote old research")
	}
}

func TestArbitrationTrustedRulingDefaultReconsiderationAndImmutableDispute(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, guardian)
	v, _ := k.Contribution("RC-T-1")
	original := v.Verifications[0]
	key := "verification_evidence/" + v.ID + "/" + original.RecordDigest
	raw := bytes.Clone(k.Store.Get([]byte(key)))
	rejectCommand(t, k, guardian, "", "arbitrate", arbitrationPayload("confirm"), 13)
	command(t, k, arb, "arbitrate", arbitrationPayload("confirm"), 13)
	v, _ = k.Contribution(v.ID)
	if v.State != "held" || v.Settlement != nil {
		t.Fatal("ruling bypassed default check", v)
	}
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("dispute"), 14)
	rejectCommand(t, k, peer, "", "verify", verificationArbitrationPayload("dispute"), 14)
	checkWork(t, k, guardian, "T-1", 15)
	v, _ = k.Contribution(v.ID)
	if v.State != "settled" || len(v.Verifications) != 3 || v.Verifications[2].Reconsiders != original.RecordDigest {
		t.Fatal(v)
	}
	g, _ := k.Member(guardian.m.ID)
	if g.Karma != guardian.m.Karma {
		t.Fatal("reconsidering default verifier penalized", g)
	}
	if !bytes.Equal(raw, k.Store.Get([]byte(key))) {
		t.Fatal("original dispute evidence changed")
	}
	var result ArbitrationFinalization
	if err := get(k.Store, "arbitration_finalization/"+v.ID, &result); err != nil || len(result.Reconsidered) != 1 || len(result.Penalized) != 0 {
		t.Fatal(result, err)
	}
}

func TestArbitrationOverturnedPenaltyAndExactOnce(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, peer)
	command(t, k, arb, "arbitrate", arbitrationPayload("confirm"), 13)
	p, _ := k.Member(peer.m.ID)
	if p.Karma != peer.m.Karma {
		t.Fatal("penalty before default oversight")
	}
	checkWork(t, k, guardian, "T-1", 14)
	p, _ = k.Member(peer.m.ID)
	if p.Karma != peer.m.Karma-DisputePenalty {
		t.Fatal(p)
	}
	original := bytes.Clone(k.Store.Get([]byte("arbitration_finalization/RC-T-1")))
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 15)
	rejectCommand(t, k, guardian, "", "verify", verificationArbitrationPayload("confirm"), 15)
	if !bytes.Equal(original, k.Store.Get([]byte("arbitration_finalization/RC-T-1"))) {
		t.Fatal("finalization repeated")
	}
}

func TestArbitrationRejectionHonestEffortAndNoEffortRevocation(t *testing.T) {
	for _, noEffort := range []bool{false, true} {
		t.Run(fmt.Sprint(noEffort), func(t *testing.T) {
			k, lead, peer, guardian, arb := arbitrationFixture(t)
			trustArbitration(t, k, guardian, arb)
			contestArbitration(t, k, peer)
			m, _ := k.Member(lead.m.ID)
			m.Karma = -8
			if err := put(k.Store, "member/"+m.ID, m); err != nil {
				t.Fatal(err)
			}
			payload := arbitrationPayload("dispute")
			payload["no_effort"] = noEffort
			command(t, k, arb, "arbitrate", payload, 13)
			v, _ := k.Contribution("RC-T-1")
			m, _ = k.Member(m.ID)
			if v.State != "rejected" || v.Settlement != nil || len(allCredits(t, k)) != 0 {
				t.Fatal(v)
			}
			if noEffort {
				if m.Karma != -10 || m.Licence != "revoked" {
					t.Fatal(m)
				}
			} else if m.Karma != -8 || m.Licence != "active" {
				t.Fatal("honest attempt penalized", m)
			}
		})
	}
}

func TestArbitrationEligibilitySidesStandingAndExactAppointment(t *testing.T) {
	k, lead, peer, guardian, arb := arbitrationFixture(t)
	contestArbitration(t, k, peer)
	rejectCommand(t, k, lead, "", "arbitrate", arbitrationPayload("confirm"), 13)
	rejectCommand(t, k, peer, "", "arbitrate", arbitrationPayload("confirm"), 13)
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 13)
	// Existing standing tests acquire T2 through actual paid work. This witness
	// tests current dependency revalidation and both sides of this arbitration.
	checks := []Verification{{Member: peer.m.ID, Verdict: "confirm"}, {Member: guardian.m.ID, Verdict: "confirm"}}
	for _, id := range []string{"qualified-one", "qualified-two"} {
		if err := put(k.Store, "contribution/"+id, Contribution{ID: id, Author: arb.m.ID, State: "settled", Verifications: checks}); err != nil {
			t.Fatal(err)
		}
	}
	if err := put(k.Store, "operator_proof/"+operatorActorKey(arb.m.ID, ""), OperatorProof{Member: arb.m.ID, Domain: "arbiter.example"}); err != nil {
		t.Fatal(err)
	}
	if err := put(k.Store, "research_standing/"+operatorActorKey(arb.m.ID, ""), ResearchStanding{Member: arb.m.ID, Contributions: []string{"qualified-one", "qualified-two"}}); err != nil {
		t.Fatal(err)
	}
	tier, err := k.ResearchTier(arb.m.ID, "")
	if err != nil || tier != "T2" {
		t.Fatal(tier, err)
	}
	// Same declared operator as the disputer disqualifies an otherwise T2 actor.
	m, _ := k.Member(arb.m.ID)
	m.Operator = peer.m.Operator
	if err = put(k.Store, "member/"+m.ID, m); err != nil {
		t.Fatal(err)
	}
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 14)
	m.Operator = arb.m.Operator
	if err = put(k.Store, "member/"+m.ID, m); err != nil {
		t.Fatal(err)
	}
	command(t, k, arb, "arbitrate", arbitrationPayload("confirm"), 15)
	var d ArbitrationDecision
	if err = get(k.Store, "arbitration/RC-T-1", &d); err != nil || d.Basis != "independent" {
		t.Fatal(d, err)
	}
}

func TestArbitrationBootstrapRequiresFreshCensusAndExcludesOperatorReward(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t, true)
	// One declared operator among four members. Only a fresh complete census
	// grants the bootstrap exception; an appointed arbiter is a separate basis.
	command(t, k, guardian, "activate_operator_census", map[string]any{"policy": OperatorCensusPolicy, "threshold": 3, "evidence_digest": digest}, 10)
	contestArbitration(t, k, peer)
	rejectCommand(t, k, guardian, "", "arbitrate", arbitrationPayload("confirm"), 13)
	command(t, k, guardian, "operator_census_page", map[string]any{}, 13)
	// An active new member invalidates the completed count.
	fresh := newActor("new actor", "single operator", 100, false, false)
	if err := put(k.Store, "member/"+fresh.m.ID, fresh.m); err != nil {
		t.Fatal(err)
	}
	rejectCommand(t, k, guardian, "", "arbitrate", arbitrationPayload("confirm"), 14)
	command(t, k, guardian, "operator_census_page", map[string]any{}, 14)
	command(t, k, guardian, "arbitrate", arbitrationPayload("confirm"), 15)
	v, _ := k.Contribution("RC-T-1")
	if len(v.Verifications) != 2 || !v.Verifications[1].Bootstrap {
		t.Fatal(v)
	}
	checkWork(t, k, arb, "T-1", 16)
	v, _ = k.Contribution(v.ID)
	if v.State != "settled" || v.Settlement.IndependentOperators != 0 || v.Settlement.FactorNumerator != 3 {
		t.Fatal(v)
	}
}

func TestArbitrationMalformedOrNoEffortConfirmAtomicRefusal(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, peer)
	for _, field := range []string{"no_effort", "novelty", "searches", "evidence_digest"} {
		p := arbitrationPayload("confirm")
		switch field {
		case "no_effort":
			p[field] = true
		case "novelty":
			p[field] = "known"
		case "searches":
			p[field] = []string{"only one"}
		case "evidence_digest":
			p[field] = "bad"
		}
		rejectCommand(t, k, arb, "", "arbitrate", p, 13)
	}
	before := bytes.Clone(k.Store.Get([]byte("contribution/RC-T-1")))
	raw, _ := json.Marshal(ArbitrationDecision{})
	if bytes.Equal(raw, k.Store.Get([]byte("arbitration/RC-T-1"))) || k.Store.Get([]byte("arbitration/RC-T-1")) != nil {
		t.Fatal("failed ruling persisted")
	}
	if !bytes.Equal(before, k.Store.Get([]byte("contribution/RC-T-1"))) {
		t.Fatal("failed ruling altered answer")
	}
}

func TestArbitrationTrustedAppointmentAndReconsiderationAreExactActorScoped(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	createInstance(t, k, arb, "appointed", "Claude")
	createInstance(t, k, arb, "sibling", "Claude")
	command(t, k, guardian, "arbiter_appoint", map[string]any{"member": arb.m.ID, "instance": "appointed", "active": true, "evidence_digest": digest}, 11)
	contestArbitration(t, k, peer)
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 13)
	rejectCommand(t, k, arb, "sibling", "arbitrate", arbitrationPayload("confirm"), 13)
	instanceCommand(t, k, arb, "appointed", "arbitrate", arbitrationPayload("confirm"), 13)
	d, err := k.Arbitration("RC-T-1")
	if err != nil || d.Instance != "appointed" {
		t.Fatal(d, err)
	}
}

func TestArbitrationHaltedProjectAndRemovedAppointmentRefused(t *testing.T) {
	k, lead, peer, guardian, arb := arbitrationFixture(t)
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, peer)
	command(t, k, lead, "project_state", map[string]any{"project": "P-1", "state": "halted"}, 13)
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 14)
	command(t, k, lead, "project_state", map[string]any{"project": "P-1", "state": "active"}, 15)
	command(t, k, guardian, "arbiter_appoint", map[string]any{"member": arb.m.ID, "active": false, "evidence_digest": digest}, 16)
	rejectCommand(t, k, arb, "", "arbitrate", arbitrationPayload("confirm"), 17)
}

func TestArbitrationKnownRulingWithholdsRewardAndBindsProofEvidence(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, peer)
	p := arbitrationPayload("confirm")
	p["novelty"] = "known"
	p["known_source"] = "https://example.invalid/discovered-prior-art"
	command(t, k, arb, "arbitrate", p, 13)
	v, err := k.Contribution("RC-T-1")
	if err != nil || v.State != "withheld" || v.AwardWithheld != "known" || len(allCredits(t, k)) != 0 {
		t.Fatal(v, err)
	}
	raw := bytes.Clone(k.Store.Get([]byte("arbitration/" + v.ID)))
	k.Store.Delete([]byte("arbitration/" + v.ID))
	if _, err = k.Contribution(v.ID); err == nil {
		t.Fatal("complete answer accepted without ruling")
	}
	k.Store.Set([]byte("arbitration/"+v.ID), append(raw, ' '))
	if _, err = k.Contribution(v.ID); err == nil {
		t.Fatal("changed ruling bytes accepted")
	}
	k.Store.Set([]byte("arbitration/"+v.ID), raw)
	if _, err = k.Contribution(v.ID); err != nil {
		t.Fatal(err)
	}
}
