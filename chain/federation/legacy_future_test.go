package federation

import (
	"encoding/json"
	"fmt"
	"math/big"
	"testing"
	"time"
)

func legacyFutureFixture(t *testing.T) (Keeper, actor, actor, actor) {
	k, a, p, d := legacyResearchFixture(t)
	task, _ := k.legacyTask("old-task")
	task.Kind = "future"
	task.Price = nil
	task.Resolves = "1970-01-02T00:00:00Z"
	task.KPI = json.RawMessage(`{"statement":"The public source records this specific outcome.","metric":"count","comparator":">=","threshold":2,"unit":null,"source":"https://example.org/record","resolves_by":"1970-01-02T00:00:00Z"}`)
	_ = put(k.Store, "legacy_task/old-task", task)
	return k, a, p, d
}
func legacyKPIResolvePayload() map[string]any {
	return map[string]any{"task": "old-task", "resolver": "old-default", "observed": 3, "source": "https://example.org/result", "note": "The public record independently documents the observed result.", "evidence_digest": digest}
}
func TestLegacyFutureKPIAmendmentFreezesAtFirstSubmission(t *testing.T) {
	k, a, p, _ := legacyFutureFixture(t)
	task, _ := k.legacyTask("old-task")
	original := task.KPI
	payload := map[string]any{"task": "old-task", "actor": "old-author", "kpi": json.RawMessage(`{"statement":"A revised measurable future public research outcome.","metric":"count","comparator":">=","threshold":3,"unit":null,"source":"https://example.org/record","resolves_by":"1970-01-03"}`), "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_kpi_set", payload, 10)
	task.Contributions = nil
	_ = put(k.Store, "legacy_task/old-task", task)
	bad := map[string]any{}
	for key, v := range payload {
		bad[key] = v
	}
	bad["actor"] = "old-peer"
	guardianReject(t, k, p, "legacy_kpi_set", bad, 10)
	command(t, k, a, "legacy_kpi_set", payload, 10)
	task, _ = k.legacyTask("old-task")
	if string(task.KPI) == string(original) || task.Resolves != "1970-01-04T00:00:00Z" {
		t.Fatal(task)
	}
	payload["kpi"] = nil
	guardianReject(t, k, a, "legacy_kpi_set", payload, 11)
}
func TestLegacyPriorArtChallengeBlocksKPIAndPreservesPaidHistory(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	file := map[string]any{"id": "known", "kind": "prior_art", "task": "old-task", "actor": "old-peer", "source": "https://example.org/known", "note": "The bounded answer is already openly available at this source.", "evidence_digest": digest}
	command(t, k, p, "legacy_challenge", file, 10)
	guardianReject(t, k, p, "legacy_challenge", file, 11)
	guardianReject(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 12)
	decide := map[string]any{"challenge": "known", "actor": "old-peer", "decision": "upheld", "note": "The cited source supplies the exact answer.", "evidence_digest": digest}
	guardianReject(t, k, p, "legacy_challenge_decide", decide, 12)
	w, _ := k.legacyWork("old-result")
	w.State = "settled"
	w.Pending = "kpi"
	w.Held = &LegacyHeld{Credibility: 7, Credits: 11}
	_ = put(k.Store, "legacy_work/old-result", w)
	paid := w
	paid.ID = "already-paid"
	paid.Pending = ""
	paid.Paid = true
	_ = put(k.Store, "legacy_work/already-paid", paid)
	task, _ := k.legacyTask("old-task")
	task.Contributions = append(task.Contributions, paid.ID)
	_ = put(k.Store, "legacy_task/old-task", task)
	before := append([]byte{}, k.Store.Get([]byte("legacy_work/already-paid"))...)
	decide["actor"] = "old-default"
	command(t, k, d, "legacy_challenge_decide", decide, 13)
	task, _ = k.legacyTask("old-task")
	w, _ = k.legacyWork("old-result")
	if !task.Known || task.State != "closed" || w.Pending != "" || w.Withheld != "known" || !w.Paid {
		t.Fatal(task, w)
	}
	if string(before) != string(k.Store.Get([]byte("legacy_work/already-paid"))) {
		t.Fatal("rewrote paid history")
	}
	m, _ := k.Member(a.m.ID)
	if m.Credits != "0" {
		t.Fatal(m)
	}
	guardianReject(t, k, d, "legacy_challenge_decide", decide, 14)
}
func TestLegacyFutureExpiryAndCompleteProjectResolution(t *testing.T) {
	k, _, _, d := legacyFutureFixture(t)
	guardianReject(t, k, d, "legacy_kpi_expire", map[string]any{"task": "old-task", "evidence_digest": digest}, 10)
	w, _ := k.legacyWork("old-result")
	w.State = "settled"
	w.Pending = "kpi"
	w.Held = &LegacyHeld{Credibility: 7, Credits: 11}
	_ = put(k.Store, "legacy_work/old-result", w)
	expired := int64(86400 + 30*86400)
	command(t, k, d, "legacy_kpi_expire", map[string]any{"task": "old-task", "evidence_digest": digest}, expired)
	task, _ := k.legacyTask("old-task")
	w, _ = k.legacyWork("old-result")
	if task.Outcome != "expired" || task.State != "closed" || w.Withheld != "kpi_expired" || !w.Paid {
		t.Fatal(task, w)
	}
	guardianReject(t, k, d, "legacy_kpi_expire", map[string]any{"task": "old-task", "evidence_digest": digest}, expired+1)
	k, _, _, d = legacyFutureFixture(t)
	project, _ := k.legacyProject("old-project")
	project.State = "complete"
	_ = put(k.Store, "legacy_project/old-project", project)
	w, _ = k.legacyWork("old-result")
	w.State = "rejected"
	_ = put(k.Store, "legacy_work/old-result", w)
	command(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 10)
	task, _ = k.legacyTask("old-task")
	if task.State != "closed" || task.Outcome != "met" {
		t.Fatal(task)
	}
	if _, e := deadline(task.Resolves); e != nil {
		t.Fatal(e)
	}
}
func TestLegacyMalevolenceIndependentDecisionClosesUnpaidAndPenalizesCreator(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	file := map[string]any{"id": "harm", "kind": "benevolence", "task": "old-task", "actor": "old-peer", "source": "https://example.org/harm", "note": "The proposed research causes concrete harm to affected people identified in this public evidence.", "evidence_digest": digest}
	command(t, k, p, "legacy_challenge", file, 10)
	dec := map[string]any{"challenge": "harm", "actor": "old-author", "decision": "upheld", "note": "The evidence identifies this actual harm.", "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_challenge_decide", dec, 11)
	dec["actor"] = "old-default"
	command(t, k, d, "legacy_challenge_decide", dec, 11)
	w, _ := k.legacyWork("old-result")
	m, _ := k.Member(a.m.ID)
	if w.State != "rejected" || w.Withheld != "malevolent" || m.Karma != 998 {
		t.Fatal(w, m)
	}
	guardianReject(t, k, d, "legacy_challenge_decide", dec, 12)
}

func TestLegacyNumbersBoundExponentBeforeAllocation(t *testing.T) {
	for _, raw := range []string{"1e999999999", "1e-999999999", "1e309", "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999e308"} {
		if _, ok := legacyNumber(raw); ok {
			t.Fatal("unbounded/nonfinite original number accepted", raw)
		}
	}
	for _, raw := range []string{"1e308", "5e-324", "0.25", "-3.5"} {
		if _, ok := legacyNumber(raw); !ok {
			t.Fatal("bounded finite number rejected", raw)
		}
	}
	if _, e := legacyObserved(json.RawMessage(`{"comparator":">=","threshold":1}`), json.RawMessage(`"1e999999999"`)); e == nil {
		t.Fatal("KPI exponent allocation unbounded")
	}
}

func TestLegacyFinishedProjectReopenConsumesSharedMemberAllowance(t *testing.T) {
	k, a, _, _ := legacyClaimEditFixture(t)
	p, _ := k.legacyProject("old-project")
	p.TaskIDs = []string{"old-task"}
	p.ClaimIDs = []string{"old-claim"}
	p.ParticipantIDs = []string{"old-author", "old-peer"}
	p.WorkIDs = []string{"old-result", "new-source"}
	_ = put(k.Store, "legacy_project/old-project", p)
	other := p
	other.ID = "other-project"
	other.TaskIDs = []string{"other-task"}
	other.WorkIDs = nil
	other.ClaimIDs = nil
	_ = put(k.Store, "legacy_project/other-project", other)
	_ = put(k.Store, "legacy_task/other-task", LegacyTask{ID: "other-task", Project: other.ID, State: "open", Creator: "old-author"})
	guardianReject(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"new-source"}), 10)
	member, _ := k.Member(a.m.ID)
	member.Karma = 1010
	_ = put(k.Store, "member/"+member.ID, member)
	command(t, k, a, "legacy_claim_edit", legacyEditPayload("edit", []string{"new-source"}), 11)
	member, _ = k.Member(a.m.ID)
	if member.ActiveProjects != 0 || member.Credits != "0" {
		t.Fatal("legacy cap mutated native count/issuance", member)
	}
}
func TestLegacyFutureStopsNewSubmissionAtDeadline(t *testing.T) {
	k, a, _, _ := legacyFutureFixture(t)
	w, _ := k.legacyWork("old-result")
	w.State = "rejected"
	_ = put(k.Store, "legacy_work/old-result", w)
	payload := map[string]any{"id": "late", "task": "old-task", "author": "old-author", "title": "Late research evidence", "detail": "This result was submitted after the future task deadline.", "claim": "The deadline has already passed for this bounded future research.", "evidence_digest": digest}
	guardianReject(t, k, a, "legacy_submit", payload, 86400)
}

func legacyOpenTaskPayload() map[string]any {
	return map[string]any{"author": "old-author", "project": "old-project", "title": "Future bounded research task", "question": "Does the specified independently observable event occur by the due date?", "done_when": "The public record resolves this precisely stated event.", "how_to_check": "Inspect the public source and independently confirm the recorded event.", "prior_art": map[string]any{"statement": "No open discoverable source has solved this precise future research question.", "searched": []string{"Public literature query and dated result.", "Registry query and dated result."}}, "benevolence": map[string]any{"class": "neutral", "statement": "The result records public information without causing harm."}, "verification": map[string]any{"criteria": "Independently inspect the cited public record against the exact research question.", "method": "inspect"}, "kind": "future", "kpi": json.RawMessage(`{"statement":"The specified public event occurs before its deadline.","metric":"event","comparator":"occurs","source":"https://example.org/event","resolves_by":"1970-01-03"}`), "evidence_digest": digest}
}
func TestLegacyNewFutureTaskRequiresOriginalBasisAndFrozenPricing(t *testing.T) {
	k, a, p, _ := legacyResearchFixture(t)
	project, _ := k.legacyProject("old-project")
	project.BudgetStatus = "proposed"
	_ = put(k.Store, "legacy_project/old-project", project)
	payload := legacyOpenTaskPayload()
	bad := map[string]any{}
	for key, v := range payload {
		bad[key] = v
	}
	delete(bad, "prior_art")
	guardianReject(t, k, a, "legacy_task_open", bad, 10)
	bad = map[string]any{}
	for key, v := range payload {
		bad[key] = v
	}
	bad["benevolence"] = map[string]any{"class": "malevolent", "statement": "This declared task causes actual harm to people."}
	guardianReject(t, k, a, "legacy_task_open", bad, 10)
	subject, e := apply(k, signed(t, k, a, "legacy_task_open", payload, 10), 10)
	if e != nil {
		t.Fatal(e)
	}
	task, e := k.legacyTask(subject)
	if e != nil || task.Kind != "future" || len(task.KPI) == 0 || task.Price != nil {
		t.Fatal(task, e)
	}
	price := map[string]any{"task": subject, "actor": "old-peer", "karma": 50, "evidence_digest": digest}
	guardianReject(t, k, p, "legacy_task_price", price, 11)
	price["actor"] = "old-author"
	price["karma"] = 101
	guardianReject(t, k, a, "legacy_task_price", price, 11)
	price["karma"] = 50
	command(t, k, a, "legacy_task_price", price, 11)
	guardianReject(t, k, a, "legacy_task_price", price, 12)
	task, _ = k.legacyTask(subject)
	if task.Price == nil || *task.Price != 50 {
		t.Fatal(task)
	}
}

func TestLegacyAllocatedTaskPricingConservesOriginalUnlockedStage(t *testing.T) {
	k, a, _, _ := legacyResearchFixture(t)
	project, _ := k.legacyProject("old-project")
	project.BudgetStatus = "allocated"
	project.BudgetUnlocked = 100
	project.TaskIDs = []string{"old-task"}
	_ = put(k.Store, "legacy_project/old-project", project)
	payload := legacyOpenTaskPayload()
	payload["karma"] = 81
	guardianReject(t, k, a, "legacy_task_open", payload, 10)
	payload["karma"] = 80
	command(t, k, a, "legacy_task_open", payload, 10)
	guardianReject(t, k, a, "legacy_task_open", payload, 11)
	project, _ = k.legacyProject("old-project")
	task, _ := k.legacyTask("old-task")
	task.State = "closed"
	_ = put(k.Store, "legacy_task/old-task", task)
	payload["karma"] = 20
	command(t, k, a, "legacy_task_open", payload, 12)
	m, _ := k.Member(a.m.ID)
	if m.Credits != "0" {
		t.Fatal("pricing minted money", m)
	}
}

func TestLegacyFuturePerWorkMaterializationIsImmutableAndCallerIndependent(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	task, _ := k.legacyTask("old-task")
	task.Contributions = nil
	template, _ := k.legacyWork("old-result")
	for i := 0; i < 3; i++ {
		w := template
		w.ID = fmt.Sprintf("held-%d", i)
		w.State = "settled"
		w.Pending = "kpi"
		w.Held = &LegacyHeld{Credibility: 7, Credits: 11}
		task.Contributions = append(task.Contributions, w.ID)
		_ = put(k.Store, "legacy_work/"+w.ID, w)
	}
	_ = put(k.Store, "legacy_task/"+task.ID, task)
	payload := map[string]any{"contribution": "held-1", "evidence_digest": digest}
	guardianReject(t, k, p, "legacy_future_apply", payload, 9)
	command(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 10)
	member, _ := k.Member(a.m.ID)
	if member.Credits != "0" {
		t.Fatal("decision issued before individual apply", member)
	}
	command(t, k, p, "legacy_future_apply", payload, 11)
	member, _ = k.Member(a.m.ID)
	if member.Credits != "11" || member.Karma != 1007 {
		t.Fatal(member)
	}
	before := append([]byte{}, k.Store.Get([]byte("legacy_future_application/held-1"))...)
	guardianReject(t, k, a, "legacy_future_apply", payload, 12)
	guardianReject(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 12)
	if string(before) != string(k.Store.Get([]byte("legacy_future_application/held-1"))) {
		t.Fatal("immutable application changed")
	}
	project, _ := k.legacyProject(task.Project)
	project.State = "halted"
	_ = put(k.Store, "legacy_project/"+project.ID, project)
	payload["contribution"] = "held-2"
	guardianReject(t, k, p, "legacy_future_apply", payload, 13)
	project.State = "complete"
	_ = put(k.Store, "legacy_project/"+project.ID, project)
	command(t, k, a, "legacy_future_apply", payload, 14)
	member, _ = k.Member(a.m.ID)
	if member.Credits != "22" || member.Karma != 1014 {
		t.Fatal("changed applier changed frozen award", member)
	}
}
func TestLegacyFinalKnownDecisionStopsChecksBeforePagedWithholding(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	task, _ := k.legacyTask("old-task")
	w, _ := k.legacyWork("old-result")
	task.Contributions = append(task.Contributions, "second-held")
	w.ID = "second-held"
	_ = put(k.Store, "legacy_work/"+w.ID, w)
	_ = put(k.Store, "legacy_task/"+task.ID, task)
	file := map[string]any{"id": "known-final", "kind": "prior_art", "task": task.ID, "actor": "old-peer", "source": "https://example.org/known", "note": "The bounded answer is already openly available at this source.", "evidence_digest": digest}
	command(t, k, p, "legacy_challenge", file, 10)
	command(t, k, d, "legacy_challenge_decide", map[string]any{"challenge": "known-final", "actor": "old-default", "decision": "upheld", "note": "The cited source supplies the exact answer.", "evidence_digest": digest}, 11)
	w, _ = k.legacyWork("old-result")
	if w.Paid {
		t.Fatal("decision unexpectedly materialized multiwork")
	}
	guardianReject(t, k, p, "legacy_check", map[string]any{"contribution": w.ID, "verifier": "old-peer", "verdict": "confirmed", "novelty": "new", "evidence_digest": digest}, 12)
	command(t, k, a, "legacy_future_apply", map[string]any{"contribution": w.ID, "evidence_digest": digest}, 13)
	w, _ = k.legacyWork(w.ID)
	m, _ := k.Member(a.m.ID)
	if !w.Paid || w.Withheld != "known" || w.State != "rejected" || m.Credits != "0" {
		t.Fatal(w, m)
	}
}

func TestLegacyFutureRecipientSlotsPauseAtOriginalCapAndResumeExactlyOnce(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	w, _ := k.legacyWork("old-result")
	w.State = "settled"
	w.Pending = "kpi"
	w.Held = &LegacyHeld{Credibility: 7, Credits: 11}
	w.Checks = nil
	for i := 0; i < 5; i++ {
		id := fmt.Sprintf("original-ref-%d", i)
		w.Held.CheckRefs = append(w.Held.CheckRefs, id)
		w.Checks = append(w.Checks, LegacyCheck{ID: id, Verifier: "old-peer", Member: p.m.ID, Verdict: "confirmed", Novelty: "new"})
	}
	_ = put(k.Store, "legacy_work/"+w.ID, w)
	frozen := append([]byte{}, k.Store.Get([]byte("legacy_future_hold/"+w.ID))...)
	command(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 10)
	w, _ = k.legacyWork(w.ID)
	if w.Pending != "kpi_award" || w.Paid {
		t.Fatal(w)
	}
	if e := k.credit(a.m.ID, "old-author", "cap-test", "test", big.NewInt(DailyCreditCap), time.Unix(10, 0), false, ""); e != nil {
		t.Fatal(e)
	}
	payload := map[string]any{"contribution": w.ID, "recipient": 0, "evidence_digest": digest}
	guardianReject(t, k, p, "legacy_future_apply", payload, 11)
	var progress LegacyFutureAwardProgress
	_ = get(k.Store, "legacy_future_award_progress/"+w.ID, &progress)
	if progress.Applied != 0 {
		t.Fatal("paused slot consumed", progress)
	}
	command(t, k, p, "legacy_future_apply", payload, 86411)
	guardianReject(t, k, a, "legacy_future_apply", payload, 86412)
	for i := 1; i <= 5; i++ {
		payload["recipient"] = i
		command(t, k, a, "legacy_future_apply", payload, 86412+int64(i))
	}
	w, _ = k.legacyWork(w.ID)
	m, _ := k.Member(a.m.ID)
	peer, _ := k.Member(p.m.ID)
	if !w.Paid || w.Pending != "" || m.Credits != "10011" || m.Karma != 1007 || peer.Credits != "2" {
		t.Fatal(w, m, peer)
	}
	if string(frozen) != string(k.Store.Get([]byte("legacy_future_hold/"+w.ID))) {
		t.Fatal("pre-decision frozen eligibility changed")
	}
}

func TestLegacyFuturePricedWinnerAndPartialMalevolencePreservePaidSlots(t *testing.T) {
	k, a, p, d := legacyFutureFixture(t)
	task, _ := k.legacyTask("old-task")
	price := int64(20)
	task.Price = &price
	task.Contributions = []string{"first", "later"}
	_ = put(k.Store, "legacy_task/"+task.ID, task)
	template, _ := k.legacyWork("old-result")
	for _, id := range task.Contributions {
		w := template
		w.ID = id
		w.State = "settled"
		w.Pending = "kpi"
		w.Held = &LegacyHeld{Credibility: 20, Credits: 20}
		for i := 0; i < 5; i++ {
			ref := fmt.Sprintf("ref-%d", i)
			w.Held.CheckRefs = append(w.Held.CheckRefs, ref)
			w.Checks = append(w.Checks, LegacyCheck{ID: ref, Verifier: "old-peer", Member: p.m.ID, Verdict: "confirmed", Novelty: "new"})
		}
		if e := put(k.Store, "legacy_work/"+id, w); e != nil {
			t.Fatal(e)
		}
	}
	command(t, k, d, "legacy_kpi_resolve", legacyKPIResolvePayload(), 10)
	command(t, k, p, "legacy_future_apply", map[string]any{"contribution": "later", "evidence_digest": digest}, 11)
	if k.Store.Get([]byte("legacy_future_award/later")) != nil {
		t.Fatal("later submission took original first winner")
	}
	command(t, k, p, "legacy_future_apply", map[string]any{"contribution": "first", "recipient": 0, "evidence_digest": digest}, 12)
	task, _ = k.legacyTask(task.ID)
	if task.Winner != "first" {
		t.Fatal(task)
	}
	m, _ := k.Member(a.m.ID)
	if m.Credits != "20" {
		t.Fatal(m)
	}
	paidSlot := append([]byte{}, k.Store.Get([]byte("legacy_future_award_slot/first/00"))...)
	command(t, k, p, "legacy_benevolence_flag", map[string]any{"id": "harm-later", "task": task.ID, "actor": "old-peer", "source": "https://example.org/harm", "note": "The completed research has concrete harmful effects described by this independent public evidence.", "evidence_digest": digest}, 13)
	command(t, k, d, "legacy_benevolence_decide", map[string]any{"challenge": "harm-later", "actor": "old-default", "decision": "upheld", "note": "The cited public evidence independently establishes concrete harm.", "evidence_digest": digest}, 14)
	for i := 1; i <= 5; i++ {
		command(t, k, a, "legacy_future_apply", map[string]any{"contribution": "first", "recipient": i, "evidence_digest": digest}, 15+int64(i))
	}
	first, _ := k.legacyWork("first")
	peer, _ := k.Member(p.m.ID)
	m, _ = k.Member(a.m.ID)
	if !first.Paid || first.Withheld != "malevolent" || m.Credits != "20" || peer.Credits != "0" {
		t.Fatal(first, m, peer)
	}
	if string(paidSlot) != string(k.Store.Get([]byte("legacy_future_award_slot/first/00"))) {
		t.Fatal("later harm rewrote already-paid journal receipt")
	}
	var receipt map[string]any
	_ = get(k.Store, "legacy_future_award_slot/first/01", &receipt)
	if receipt["withheld"] != "malevolent" || receipt["credit_journal"] != "" {
		t.Fatal(receipt)
	}
	guardianReject(t, k, a, "legacy_future_apply", map[string]any{"contribution": "first", "recipient": 1, "evidence_digest": digest}, 22)
}
