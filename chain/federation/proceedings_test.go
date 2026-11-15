package federation

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func proceedingsFixture(t *testing.T) (Keeper, actor, actor, actor, actor) {
	t.Helper()
	k, lead, peer, guardian, arb := arbitrationFixture(t)
	command(t, k, guardian, "activate_research_proceedings", map[string]any{"policy": "bounded-research-proceedings-v1", "evidence_digest": digest, "appeal_window_blocks": "20"}, 10)
	creditTask(t, k, lead, "T-2", 100, 2, false, 11)
	trustArbitration(t, k, guardian, arb)
	p := verificationArbitrationPayload("dispute")
	p["contribution"] = "RC-T-2"
	command(t, k, peer, "verify", p, 12)
	return k, lead, peer, guardian, arb
}
func proceedingsPayload(verdict string) map[string]any {
	p := arbitrationPayload(verdict)
	p["contribution"] = "RC-T-2"
	return p
}
func TestResearchProceedingsCorrectionWithholdsUntilAppealWindowAndExemptsDisputer(t *testing.T) {
	k, _, peer, guardian, arb := proceedingsFixture(t)
	original := bytes.Clone(k.Store.Get([]byte("contribution/RC-T-2")))
	p := proceedingsPayload("confirm")
	p["revised_claim"] = "The result establishes the narrower bounded claim."
	command(t, k, arb, "arbitrate", p, 13)
	v, e := k.Contribution("RC-T-2")
	if e != nil || v.State != "appeal_wait" || v.Settlement != nil {
		t.Fatal(v, e)
	}
	rejectCommand(t, k, guardian, "", "verify", map[string]any{"contribution": v.ID, "verdict": "confirm", "novelty": "new", "searches": prior.Searches, "evidence_digest": digest}, 14)
	rejectCommand(t, k, guardian, "", "close_arbitration", map[string]any{"contribution": v.ID}, 32)
	command(t, k, guardian, "close_arbitration", map[string]any{"contribution": v.ID}, 33)
	checkWork(t, k, guardian, "T-2", 34)
	v, e = k.Contribution(v.ID)
	m, _ := k.Member(peer.m.ID)
	if e != nil || v.State != "settled" || m.Karma != peer.m.Karma {
		t.Fatal(v, m, e)
	}
	var final struct {
		CorrectionExempt []CensusActor `json:"correction_exempt"`
		Reconsidered     []CensusActor `json:"reconsidered"`
	}
	if e = json.Unmarshal(k.Store.Get([]byte("arbitration_finalization/"+v.ID)), &final); e != nil || len(final.CorrectionExempt) != 1 || len(final.Reconsidered) != 0 {
		t.Fatal("correction was incorrectly labelled a reconsideration", final, e)
	}
	var d ArbitrationDecision
	if e = committedRecord(k.Store, "arbitration/"+v.ID, v.ArbitrationDigest, &d); e != nil || d.RevisedClaim != p["revised_claim"] {
		t.Fatal(d, e)
	}
	if bytes.Equal(original, k.Store.Get([]byte("contribution/"+v.ID))) {
		t.Fatal("state did not advance")
	}
}
func TestResearchProceedingsAppealExcludesOldArbiterAndKeepsOriginalRuling(t *testing.T) {
	k, lead, _, guardian, arb := proceedingsFixture(t)
	command(t, k, arb, "arbitrate", proceedingsPayload("dispute"), 13)
	original := bytes.Clone(k.Store.Get([]byte("arbitration/RC-T-2")))
	command(t, k, lead, "appeal_arbitration", map[string]any{"contribution": "RC-T-2", "evidence_digest": strings.Repeat("b", 64), "reason": "The original ruling overlooked the exact independently reproduced boundary."}, 14)
	rejectCommand(t, k, arb, "", "resolve_appeal", proceedingsPayload("confirm"), 15)
	fresh := newActor("appeal arbiter", "operator E", 100, false, false)
	if e := put(k.Store, "member/"+fresh.m.ID, fresh.m); e != nil {
		t.Fatal(e)
	}
	trustArbitration(t, k, guardian, fresh)
	command(t, k, fresh, "resolve_appeal", proceedingsPayload("confirm"), 15)
	checkWork(t, k, guardian, "T-2", 16)
	v, e := k.Contribution("RC-T-2")
	if e != nil || v.State != "settled" {
		t.Fatal(v, e)
	}
	if !bytes.Equal(original, k.Store.Get([]byte("arbitration/"+v.ID))) {
		t.Fatal("appeal rewrote original ruling")
	}
	rejectCommand(t, k, lead, "", "appeal_arbitration", map[string]any{"contribution": v.ID, "evidence_digest": digest, "reason": "A second appeal cannot change a paid history."}, 17)
	raw := bytes.Clone(k.Store.Get([]byte("research_appeal/" + v.ID)))
	k.Store.Delete([]byte("research_appeal/" + v.ID))
	if _, e = k.Contribution(v.ID); e == nil {
		t.Fatal("missing appeal proof accepted")
	}
	k.Store.Set([]byte("research_appeal/"+v.ID), raw)
	raw[len(raw)/2] ^= 0xff
	k.Store.Set([]byte("research_appeal/"+v.ID), raw)
	if _, e = k.Contribution(v.ID); e == nil {
		t.Fatal("modified appeal proof accepted")
	}
}
func TestResearchProceedingsNoEffortSanctionWaitsForAppealAndAppliesOnce(t *testing.T) {
	k, lead, _, guardian, arb := proceedingsFixture(t)
	m, _ := k.Member(lead.m.ID)
	m.Karma = -8
	if e := put(k.Store, "member/"+m.ID, m); e != nil {
		t.Fatal(e)
	}
	p := proceedingsPayload("dispute")
	p["no_effort"] = true
	command(t, k, arb, "arbitrate", p, 13)
	m, _ = k.Member(m.ID)
	if m.Karma != -8 || m.Licence != "active" {
		t.Fatal("appeal blocked by premature sanction", m)
	}
	command(t, k, guardian, "close_arbitration", map[string]any{"contribution": "RC-T-2"}, 33)
	m, _ = k.Member(m.ID)
	if m.Karma != -10 || m.Licence != "revoked" {
		t.Fatal(m)
	}
	rejectCommand(t, k, guardian, "", "close_arbitration", map[string]any{"contribution": "RC-T-2"}, 34)
	m, _ = k.Member(m.ID)
	if m.Karma != -10 {
		t.Fatal("sanction repeated", m)
	}
}

func TestResearchProceedingsKPIClosureKeepsAppealProofAndNeverPays(t *testing.T) {
	k, lead, peer, guardian, arb := proceedingsFixture(t)
	creditTask(t, k, lead, "T-3", 100, 2, true, 20)
	p := verificationArbitrationPayload("dispute")
	p["contribution"] = "RC-T-3"
	command(t, k, peer, "verify", p, 22)
	p = arbitrationPayload("confirm")
	p["contribution"] = "RC-T-3"
	command(t, k, arb, "arbitrate", p, 23)
	command(t, k, lead, "appeal_arbitration", map[string]any{"contribution": "RC-T-3", "evidence_digest": digest, "reason": "The bounded future observation must await a second independent ruling."}, 24)
	original := bytes.Clone(k.Store.Get([]byte("research_appeal/RC-T-3")))
	command(t, k, guardian, "resolve_kpi", map[string]any{"task": "T-3", "observed": "4", "source": "https://example.invalid/fixture", "note": "The observed metric is below the required threshold.", "evidence_digest": digest}, 25)
	v, e := k.Contribution("RC-T-3")
	if e != nil || v.State != "withheld" || v.AwardWithheld != "kpi_unmet" || v.Settlement != nil {
		t.Fatal(v, e)
	}
	if !bytes.Equal(original, k.Store.Get([]byte("research_appeal/RC-T-3"))) || len(allCredits(t, k)) != 0 {
		t.Fatal("closure rewrote appeal or paid failed KPI")
	}
	rejectCommand(t, k, guardian, "", "close_arbitration", map[string]any{"contribution": v.ID}, 50)
}
func TestResearchProceedingsActivationBoundsAndLegacyIsolation(t *testing.T) {
	k, _, peer, guardian, arb := arbitrationFixture(t)
	before := bytes.Clone(k.Store.Get([]byte("contribution/RC-T-1")))
	for _, window := range []string{"0", "1000001", "-1"} {
		rejectCommand(t, k, guardian, "", "activate_research_proceedings", map[string]any{"policy": ResearchProceedingsPolicy, "evidence_digest": digest, "appeal_window_blocks": window}, 10)
	}
	rejectCommand(t, k, peer, "", "activate_research_proceedings", map[string]any{"policy": ResearchProceedingsPolicy, "evidence_digest": digest, "appeal_window_blocks": "20"}, 10)
	command(t, k, guardian, "activate_research_proceedings", map[string]any{"policy": ResearchProceedingsPolicy, "evidence_digest": digest, "appeal_window_blocks": "20"}, 10)
	if !bytes.Equal(before, k.Store.Get([]byte("contribution/RC-T-1"))) {
		t.Fatal("activation rewrote old answer")
	}
	trustArbitration(t, k, guardian, arb)
	contestArbitration(t, k, peer)
	p := arbitrationPayload("confirm")
	p["revised_claim"] = "This correction cannot be retroactively applied."
	rejectCommand(t, k, arb, "", "arbitrate", p, 13)
	command(t, k, arb, "arbitrate", arbitrationPayload("confirm"), 13)
	checkWork(t, k, guardian, "T-1", 14)
	v, e := k.Contribution("RC-T-1")
	if e != nil || v.State != "settled" || v.ResearchPolicy != "" {
		t.Fatal(v, e)
	}
}
func TestResearchProceedingsWrongSideLateAppealAndMalformedCorrectionAreAtomic(t *testing.T) {
	k, lead, peer, guardian, arb := proceedingsFixture(t)
	for _, correction := range []string{"short", strings.Repeat("x", 4001), " padded correction is refused "} {
		p := proceedingsPayload("confirm")
		p["revised_claim"] = correction
		rejectCommand(t, k, arb, "", "arbitrate", p, 13)
	}
	p := proceedingsPayload("dispute")
	p["revised_claim"] = "A rejecting ruling cannot silently correct the claim."
	rejectCommand(t, k, arb, "", "arbitrate", p, 13)
	command(t, k, arb, "arbitrate", proceedingsPayload("confirm"), 13)
	appeal := map[string]any{"contribution": "RC-T-2", "evidence_digest": digest, "reason": "The signed evidence requests another independent ruling on this work."}
	rejectCommand(t, k, guardian, "", "appeal_arbitration", appeal, 14)
	rejectCommand(t, k, arb, "", "appeal_arbitration", appeal, 14)
	rejectCommand(t, k, lead, "", "appeal_arbitration", appeal, 33)
	command(t, k, peer, "appeal_arbitration", appeal, 32)
	rejectCommand(t, k, lead, "", "appeal_arbitration", appeal, 32)
	rejectCommand(t, k, guardian, "", "close_arbitration", map[string]any{"contribution": "RC-T-2"}, 33)
}
