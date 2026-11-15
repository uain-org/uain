package federation

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func legacyResearchFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, author, peer, def := fixture(t)
	put(k.Store, "legacy_import", LegacyImportState{Status: "ready"})
	for _, v := range []struct {
		a          actor
		id, family string
	}{{author, "old-author", "openai"}, {peer, "old-peer", "anthropic"}, {def, "old-default", "google"}} {
		put(k.Store, "instance/"+v.id, Instance{ID: v.id, Member: v.a.m.ID, State: "active", Name: v.id, Credits: "0"})
		put(k.Store, "legacy/actor/"+v.id, map[string]any{"id": v.id, "member": v.a.m.ID, "operator": v.a.m.Operator, "family": v.family, "default_verifier": v.a.m.DefaultVerifier, "trusted_arbiter": v.a.m.DefaultVerifier, "tier": 2, "projects": []string{"old-project"}})
	}
	put(k.Store, "legacy/project/old-project", map[string]any{"id": "old-project", "state": "active", "lead": "old-author"})
	put(k.Store, "legacy/task/old-task", map[string]any{"id": "old-task", "project": "old-project", "state": "open", "kind": "instant", "price": 20, "winner": "", "created_by": "old-author", "contributions": []string{"old-result"}})
	put(k.Store, "legacy/work/old-result", map[string]any{"id": "old-result", "project": "old-project", "task": "old-task", "author": "old-author", "member": author.m.ID, "kind": "work", "state": "held", "claimed": 20, "required": 2, "reconciles": []string{}, "checks": []any{}})
	return k, author, peer, def
}
func TestLegacyResearchUsesOriginalPriceAndExactVerifierPool(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	command(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-peer", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 10)
	m, _ := k.Member(author.m.ID)
	if m.Credits != "0" {
		t.Fatal("paid before original checks")
	}
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 11)
	m, _ = k.Member(author.m.ID)
	p, _ := k.Member(peer.m.ID)
	d, _ := k.Member(def.m.ID)
	if m.Credits != "20" || m.Karma != 1020 || p.Credits != "2" || d.Credits != "2" {
		t.Fatal("original price/pool not conserved", m, p, d)
	}
	if _, e := apply(k, signed(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 12), 12); e == nil {
		t.Fatal("paid legacy work twice")
	}
	var original map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &original)
	if original["state"] != "held" {
		t.Fatal("immutable original overwritten")
	}
}
func TestLegacyResearchPartialAndSingleDiscountRemainPointSixEach(t *testing.T) {
	k, author, _, def := legacyResearchFixture(t)
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["required"] = 1
	work["checks"] = []any{map[string]any{"id": "1", "verifier": "old-default", "member": def.m.ID, "verdict": "partial", "novelty": "new", "original": true}}
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, def, "legacy_settle", map[string]any{"contribution": "old-result", "evidence_digest": digest}, 10)
	m, _ := k.Member(author.m.ID)
	if m.Credits != "7" || m.Karma != 1007 {
		t.Fatal("SQL Math.round(20*.6*.6)=7 must be preserved", m)
	}
}
func TestLegacyResearchCannotSpoofSourceRoleOrRepriceDecidedWinner(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	if _, e := apply(k, signed(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "evidence_digest": digest}, 10), 10); e == nil {
		t.Fatal("spoofed exact source default role")
	}
	command(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-peer", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 10)
	var task map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/task/old-task")), &task)
	task["winner"] = "already-paid-original-winner"
	put(k.Store, "legacy/task/old-task", task)
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 11)
	m, _ := k.Member(author.m.ID)
	if m.Credits != "0" || m.Karma != 1000 {
		t.Fatal("repaid historic task price", m)
	}
}
func TestLegacyClaimReviewKeepsSourceChecksSeparateAndPromotesTwoMembers(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	put(k.Store, "legacy/claim/old-claim", map[string]any{"id": "old-claim", "project": "old-project", "revisions": []any{map[string]any{"id": "73", "base": "", "state": "draft", "author": "old-author", "member": author.m.ID, "action": "assert", "sources": []string{}, "reviews": []any{}}}})
	command(t, k, peer, "legacy_claim_review", map[string]any{"claim": "old-claim", "revision": "73", "reviewer": "old-peer", "verdict": "confirm", "evidence_digest": digest}, 10)
	command(t, k, def, "legacy_claim_review", map[string]any{"claim": "old-claim", "revision": "73", "reviewer": "old-default", "verdict": "confirm", "evidence_digest": digest}, 11)
	var result map[string]any
	if e := get(k.Store, "legacy_claim/old-claim", &result); e != nil {
		t.Fatal(e)
	}
	r := result["revisions"].([]any)[0].(map[string]any)
	if r["state"] != "believed" {
		t.Fatal("original claim not promoted", result)
	}
}
func TestLegacyFrozenKpiUsesOriginalAmountsAndOriginalCheckRecipients(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	var task map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/task/old-task")), &task)
	task["kind"] = "future"
	task["price"] = nil
	task["outcome"] = "met"
	put(k.Store, "legacy_task/old-task", task)
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["state"] = "settled"
	work["pending"] = "kpi"
	work["held"] = map[string]any{"credibility": 7, "credits": 11, "verifications": []int{1, 2}}
	work["checks"] = []any{map[string]any{"id": "1", "verifier": "old-peer", "member": peer.m.ID, "verdict": "confirmed", "novelty": "new", "original": true}, map[string]any{"id": "2", "verifier": "old-default", "member": def.m.ID, "verdict": "confirmed", "novelty": "new", "original": true}}
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, def, "legacy_settle", map[string]any{"contribution": "old-result", "evidence_digest": digest}, 10)
	m, _ := k.Member(author.m.ID)
	if m.Karma != 1007 || m.Credits != "11" {
		t.Fatal("frozen KPI amount was repriced", m)
	}
}
func TestLegacyTaskContinuationKeepsOriginalPriceAndClosesWithoutVoidingClaims(t *testing.T) {
	k, author, _, _ := legacyResearchFixture(t)
	var project map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/project/old-project")), &project)
	project["work_ids"] = []string{"old-result"}
	put(k.Store, "legacy/project/old-project", project)
	if _, e := apply(k, signed(t, k, author, "legacy_submit", map[string]any{"id": "second-result", "task": "old-task", "author": "old-author", "title": "A second bounded answer", "detail": "New independent research evidence for the original unchanged bounded task.", "claim": "The new evidence establishes this carefully bounded result.", "karma_claimed": 99, "verifiers_required": 2, "evidence_digest": digest}, 10), 10); e == nil {
		t.Fatal("one original answer per instance/task must wait until judged")
	}
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["state"] = "rejected"
	put(k.Store, "legacy_work/old-result", work)
	command(t, k, author, "legacy_submit", map[string]any{"id": "second-result", "task": "old-task", "author": "old-author", "title": "A second bounded answer", "detail": "New independent research evidence for the original unchanged bounded task.", "claim": "The new evidence establishes this carefully bounded result.", "karma_claimed": 99, "verifiers_required": 2, "evidence_digest": digest}, 10)
	result, e := k.legacyWork("second-result")
	if e != nil || result.Claimed != 20 {
		t.Fatal("original task repriced", result, e)
	}
	command(t, k, author, "legacy_task_close", map[string]any{"task": "old-task", "actor": "old-author", "reason": "The original creator closes new answers while existing claims remain reviewable.", "evidence_digest": digest}, 11)
	result, e = k.legacyWork("second-result")
	if e != nil || result.State != "held" {
		t.Fatal("closing task voided pending claim", result, e)
	}
}
func TestLegacyDefaultDisputeAfterArbitrationRejectsAndSameMemberCheckGetsNoPool(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["state"] = "contested"
	work["arbitrated"] = true
	work["checks"] = []any{map[string]any{"id": "1", "verifier": "old-peer", "member": peer.m.ID, "verdict": "disputed", "original": true}, map[string]any{"id": "2", "verifier": "old-author", "member": author.m.ID, "verdict": "confirmed", "original": true}, map[string]any{"id": "3", "verifier": "old-peer", "member": peer.m.ID, "verdict": "confirmed", "novelty": "new", "original": true}}
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "disputed", "evidence_digest": digest}, 10)
	result, e := k.legacyWork("old-result")
	if e != nil || result.State != "rejected" {
		t.Fatal("default double-check dispute failed to reject", result, e)
	}
	k, author, peer, def = legacyResearchFixture(t)
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["checks"] = []any{map[string]any{"id": "1", "verifier": "old-author", "member": author.m.ID, "verdict": "confirmed", "original": true}, map[string]any{"id": "2", "verifier": "old-peer", "member": peer.m.ID, "verdict": "confirmed", "novelty": "new", "original": true}}
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 10)
	a, _ := k.Member(author.m.ID)
	if a.Credits != "20" {
		t.Fatal("same-member source check received verifier credits", a)
	}
	if legacyFamily("o3") != "openai" || legacyFamily("o4-mini") != "openai" {
		t.Fatal("legacyOpenAI family declaration lost")
	}
}

func TestLegacyForecastSubmissionRetainsProbabilityAndOriginalPrice(t *testing.T) {
	k, author, _, _ := legacyResearchFixture(t)
	var task map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/task/old-task")), &task)
	task["answer_type"] = "forecast"
	task["contributions"] = []string{}
	put(k.Store, "legacy_task/old-task", task)
	p := map[string]any{"id": "forecast-result", "task": "old-task", "author": "old-author", "title": "Forecast for the original task", "detail": "This bounded probability follows the cited evidence and stated uncertainty.", "claim": "The event has a bounded probability under the stated evidence.", "karma_claimed": 99, "forecast": map[string]any{"statement": "The bounded event occurs by its original horizon.", "probability": "0.25", "horizon": "2027-01-01"}, "evidence_digest": digest}
	command(t, k, author, "legacy_submit", p, 10)
	v, e := k.legacyWork("forecast-result")
	if e != nil || v.Claimed != 20 {
		t.Fatal("forecast lost original price", v, e)
	}
}
func TestLegacyOldCheckMayAttestNoveltyWithoutCreatingAnotherVerifierShare(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["checks"] = []any{map[string]any{"id": "133", "verifier": "old-peer", "member": peer.m.ID, "verdict": "confirmed", "original": true}, map[string]any{"id": "134", "verifier": "old-default", "member": def.m.ID, "verdict": "confirmed", "original": true}}
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-peer", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 10)
	v, e := k.legacyWork("old-result")
	if e != nil || len(v.Checks) != 2 || v.Checks[0].ID != "133" {
		t.Fatal("novelty attestation rewrote original reference or added share", v, e)
	}
	m, _ := k.Member(author.m.ID)
	if m.Credits != "20" {
		t.Fatal("old unbound novelty remained stuck", m)
	}
}
func TestLegacySettledAnswerDerivesBelief(t *testing.T) {
	k, author, peer, def := legacyResearchFixture(t)
	var work map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/work/old-result")), &work)
	work["claim_statement"] = "The bounded original result establishes the source finding."
	put(k.Store, "legacy/work/old-result", work)
	command(t, k, peer, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-peer", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 10)
	command(t, k, def, "legacy_check", map[string]any{"contribution": "old-result", "verifier": "old-default", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 11)
	task, e := k.legacyTask("old-task")
	if e != nil || len(task.ClaimIDs) != 1 {
		t.Fatal("verified claim disappeared instead of deriving source-policy belief", task, e)
	}
	claim, e := k.legacyClaim(task.ClaimIDs[0])
	if e != nil || len(claim.Revisions) != 1 || claim.Revisions[0].State != "believed" || claim.Revisions[0].Statement == "" {
		t.Fatal("original direct-belief semantics lost", claim, e)
	}
	_ = author
}

func TestLegacyIntegerValuesPreserveEveryAllowedSQLRounding(t *testing.T) {
	for claim := int64(0); claim <= MaxReward; claim++ {
		for _, partial := range []bool{false, true} {
			for _, single := range []bool{false, true} {
				factor := 1.0
				if partial {
					factor *= 0.6
				}
				if single {
					factor *= 0.6
				}
				want := int64(math.Floor(float64(claim)*factor + 0.5))
				if got := legacyValue(claim, partial, single); got != want {
					t.Fatal("SQL rounding changed", claim, partial, single, got, want)
				}
			}
		}
	}
}
func TestLegacyCloseAndKPIBindEnvelopeToExactOriginalInstance(t *testing.T) {
	k, author, _, def := legacyResearchFixture(t)
	now := time.Unix(10, 0).UTC()
	payload, _ := json.Marshal(map[string]any{"task": "old-task", "actor": "old-author", "reason": "This closure must retain exact instance attribution.", "evidence_digest": digest})
	if _, e := k.legacyTaskClose(Command{Member: author.m.ID, Instance: "another-owned-instance", Payload: payload}, now); e == nil {
		t.Fatal("task closure accepted differently attributed envelope instance")
	}
	var task map[string]any
	json.Unmarshal(k.Store.Get([]byte("legacy/task/old-task")), &task)
	task["kind"] = "future"
	task["resolves_by"] = "2027-01-01"
	task["kpi"] = map[string]any{"comparator": "occurs"}
	put(k.Store, "legacy_task/old-task", task)
	payload, _ = json.Marshal(map[string]any{"task": "old-task", "resolver": "old-default", "observed": true, "source": "https://example.test/observation", "note": "The original task's observed event is supported by this public source.", "evidence_digest": digest})
	if _, e := k.legacyResolveKPI(Command{Member: def.m.ID, Instance: "another-owned-instance", Payload: payload}, now); e == nil {
		t.Fatal("KPI accepted differently attributed envelope instance")
	}
}
