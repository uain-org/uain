package federation

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func recoveryCommand(t *testing.T, member string, payload any) Command {
	t.Helper()
	b, e := json.Marshal(payload)
	if e != nil {
		t.Fatal(e)
	}
	return Command{Member: member, Payload: b}
}
func recoveryFixture(t *testing.T) (Keeper, actor, actor, actor, FundingQuorum) {
	t.Helper()
	k, payer, observer, guardian := fundingFixture(t)
	command(t, k, payer, "funding_file", fundingDeposit("FR-1"), 7)
	command(t, k, observer, "funding_attest", fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111"), 8)
	var q FundingQuorum
	if e := get(k.Store, "funding_quorum/FR-1/deposit", &q); e != nil {
		t.Fatal(e)
	}
	return k, payer, observer, guardian, q
}
func restartPayload(q FundingQuorum, kind, id string) map[string]any {
	return map[string]any{"kind": kind, "id": id, "expected_effects_digest": q.EffectsDigest, "evidence_digest": digest}
}

func TestFundingReviewRestartRequiresGuardianAndExactStaleQuorum(t *testing.T) {
	k, payer, observer, guardian, q := recoveryFixture(t)
	p := restartPayload(q, "deposit", "FR-1")
	for _, c := range []Command{recoveryCommand(t, payer.m.ID, p), recoveryCommand(t, guardian.m.ID, p), recoveryCommand(t, guardian.m.ID, map[string]any{"kind": "deposit", "id": "FR-1", "expected_effects_digest": strings.Repeat("b", 64), "evidence_digest": digest})} {
		before, _ := json.Marshal(k.Store)
		if _, e := k.restartFundingReview(c, 9); e == nil {
			t.Fatal("unauthorized, premature, or conflicting restart accepted")
		}
		after, _ := json.Marshal(k.Store)
		if !bytes.Equal(before, after) {
			t.Fatal("rejected restart mutated store")
		}
	}
	member, _ := k.Member(observer.m.ID)
	member.Licence = "suspended"
	_ = put(k.Store, "member/"+member.ID, member)
	beforeReceipt := bytes.Clone(k.Store.Get([]byte("funding_receipt/FR-1")))
	if _, e := k.restartFundingReview(recoveryCommand(t, guardian.m.ID, p), 9); e != nil {
		t.Fatal(e)
	}
	var fresh FundingQuorum
	_ = get(k.Store, "funding_quorum/FR-1/deposit", &fresh)
	if fresh.EffectsDigest != q.EffectsDigest || len(fresh.Observations) != 0 {
		t.Fatal("restart forgot transfer commitment", fresh)
	}
	if !bytes.Equal(beforeReceipt, k.Store.Get([]byte("funding_receipt/FR-1"))) || k.Store.Get([]byte("funding_pool/FR-1")) != nil {
		t.Fatal("restart moved funds or receipt")
	}
	rows, e := k.Store.Range([]byte("funding_review_archive/"), []byte("funding_review_archive0"), 10)
	if e != nil || len(rows) != 1 {
		t.Fatal("missing immutable archive", rows, e)
	}
	var archive FundingReviewArchive
	if e = json.Unmarshal(rows[0].Value, &archive); e != nil || archive.Quorum.EffectsDigest != q.EffectsDigest || len(archive.Quorum.Observations) != 1 || archive.Reason != "observer_ineligible" {
		t.Fatal(archive, e)
	}
	if _, e = k.restartFundingReview(recoveryCommand(t, guardian.m.ID, p), 10); e == nil {
		t.Fatal("empty quorum restarted")
	}
}

func TestFundingReviewRestartTimeoutBoundaryAndDomainChange(t *testing.T) {
	for _, mode := range []string{"timeout", "proof"} {
		t.Run(mode, func(t *testing.T) {
			k, _, observer, guardian, q := recoveryFixture(t)
			h := int64(728)
			if mode == "timeout" {
				if _, e := k.restartFundingReview(recoveryCommand(t, guardian.m.ID, restartPayload(q, "deposit", "FR-1")), 727); e == nil {
					t.Fatal("early timeout accepted")
				}
			} else {
				h = 9
				var proof OperatorProof
				_ = get(k.Store, "operator_proof/"+operatorActorKey(observer.m.ID, ""), &proof)
				proof.Domain = "replacement.example"
				_ = put(k.Store, "operator_proof/"+operatorActorKey(observer.m.ID, ""), proof)
			}
			if _, e := k.restartFundingReview(recoveryCommand(t, guardian.m.ID, restartPayload(q, "deposit", "FR-1")), h); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestFundingReviewRestartPreservesAllPendingFinancialBindings(t *testing.T) {
	for _, kind := range []string{"refund", "payout", "bank"} {
		t.Run(kind, func(t *testing.T) {
			k, payer, observer, guardian, q := recoveryFixture(t)
			id := "FR-1"
			key := "funding_quorum/FR-1/refund"
			q.Observations[0].Attestation.Kind = kind
			switch kind {
			case "refund":
				var r FundingReceipt
				_ = get(k.Store, "funding_receipt/FR-1", &r)
				r.State = "refund_pending"
				_ = put(k.Store, "funding_receipt/FR-1", r)
			case "payout":
				id = "PI-1"
				key = "external_payout_quorum/" + id
				_ = put(k.Store, "external_payout/"+id, ExternalPayoutIntent{ID: id, Receipt: "FR-1", Member: payer.m.ID, State: "pending"})
				var r FundingReceipt
				_ = get(k.Store, "funding_receipt/FR-1", &r)
				r.State = "confirmed"
				_ = put(k.Store, "funding_receipt/FR-1", r)
			case "bank":
				id = "BANK-1"
				key = "fiat_beneficiary_quorum/" + id
				q.Observations[0].Attestation.Kind = "bank_ownership"
				_ = put(k.Store, "fiat_beneficiary_request/"+id, FiatBeneficiary{ID: id, Member: payer.m.ID, Network: "fiat:USD", AccountDigest: digest})
			}
			q.Observations[0].Attestation.Receipt = id
			q.EffectsDigest = fundingEffects(q.Observations[0].Attestation)
			_ = put(k.Store, key, q)
			_ = put(k.Store, "external_transfer/permanent", map[string]string{"kind": kind, "id": id})
			_ = put(k.Store, "funding_pool/FR-1", map[string]string{"reserved": "101"})
			before := map[string][]byte{}
			for key, value := range k.Store.(memory) {
				if key != "event_count" {
					before[key] = bytes.Clone(value)
				}
			}
			m, _ := k.Member(observer.m.ID)
			m.Karma = 99
			_ = put(k.Store, "member/"+m.ID, m)
			before["member/"+m.ID] = bytes.Clone(k.Store.Get([]byte("member/" + m.ID)))
			if _, e := k.restartFundingReview(recoveryCommand(t, guardian.m.ID, restartPayload(q, kind, id)), 9); e != nil {
				t.Fatal(e)
			}
			for old, value := range before {
				if old != key && !bytes.Equal(value, k.Store.Get([]byte(old))) {
					t.Fatalf("binding/pool mutated: %s", old)
				}
			}
			var fresh FundingQuorum
			_ = get(k.Store, key, &fresh)
			if fresh.EffectsDigest != q.EffectsDigest || len(fresh.Observations) != 0 {
				t.Fatal(fresh)
			}
		})
	}
}

func TestFundingObserverEpochProspectiveBoundedAndIndependent(t *testing.T) {
	k, payer, observer, guardian, _ := recoveryFixture(t)
	var base FundingActivation
	_ = get(k.Store, "funding_activation", &base)
	p := map[string]any{"observers": []string{payer.m.ID, guardian.m.ID}, "evidence_digest": digest}
	if _, e := k.rotateFundingObservers(recoveryCommand(t, observer.m.ID, p), 9); e == nil {
		t.Fatal("nonguardian rotation")
	}
	if _, e := k.rotateFundingObservers(recoveryCommand(t, guardian.m.ID, p), 9); e != nil {
		t.Fatal(e)
	}
	// Direct helper calls do not append Execute's signed event. Advance its
	// event counter to model the successfully committed first rotation.
	event, _ := k.nextEvent()
	_ = put(k.Store, "event_count", event)
	old, e := k.EffectiveFundingObservers(base, 9)
	if e != nil || old.Observers[0] != observer.m.ID {
		t.Fatal("rotation retroactive", old, e)
	}
	next, e := k.EffectiveFundingObservers(base, 10)
	if e != nil || next.Observers[0] != payer.m.ID {
		t.Fatal(next, e)
	}
	if _, e = k.rotateFundingObservers(recoveryCommand(t, guardian.m.ID, p), 9); e == nil {
		t.Fatal("overlapping pending epoch accepted")
	}
	p["observers"] = []string{observer.m.ID, guardian.m.ID}
	if _, e = k.rotateFundingObservers(recoveryCommand(t, guardian.m.ID, p), 10); e != nil {
		t.Fatal(e)
	}
	old, e = k.EffectiveFundingObservers(base, 10)
	if e != nil || old.Observers[0] != payer.m.ID {
		t.Fatal("previous epoch lookup failed", old, e)
	}
	next, e = k.EffectiveFundingObservers(base, 11)
	if e != nil || next.Observers[0] != observer.m.ID {
		t.Fatal(next, e)
	}
	if _, e = k.EffectiveFundingObservers(base, 9); e == nil {
		t.Fatal("unbounded historical lookup silently returned base")
	}
	var proof OperatorProof
	_ = get(k.Store, "operator_proof/"+operatorActorKey(guardian.m.ID, ""), &proof)
	proof.Domain = "funding-1.example"
	_ = put(k.Store, "operator_proof/"+operatorActorKey(guardian.m.ID, ""), proof)
	if _, e = k.rotateFundingObservers(recoveryCommand(t, guardian.m.ID, p), 11); e == nil {
		t.Fatal("same proved operator rotation accepted")
	}
}

// This regression requires signed dispatch and nonempty EffectsDigest checks
// in each original attestation path, in addition to the new recovery helpers.
func TestFundingReviewSignedRestartCannotReplaceEffectsOrArchive(t *testing.T) {
	k, _, observer, guardian, q := recoveryFixture(t)
	suspend := func(active bool) {
		m, _ := k.Member(observer.m.ID)
		m.Licence = "suspended"
		if active {
			m.Licence = "active"
		}
		_ = put(k.Store, "member/"+m.ID, m)
	}
	suspend(false)
	command(t, k, guardian, "funding_review_restart", restartPayload(q, "deposit", "FR-1"), 9)
	rows, _ := k.Store.Range([]byte("funding_review_archive/"), []byte("funding_review_archive0"), 10)
	if len(rows) != 1 {
		t.Fatal("missing signed restart archive")
	}
	firstKey := string(rows[0].Key)
	firstBytes := bytes.Clone(rows[0].Value)
	suspend(true)
	p := fundingCheck("FR-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	p["block_hash"] = "0x" + strings.Repeat("9", 64)
	rejectCommand(t, k, observer, "", "funding_attest", p, 10)
	p["block_hash"] = "0x" + strings.Repeat("4", 64)
	command(t, k, observer, "funding_attest", p, 11)
	suspend(false)
	command(t, k, guardian, "funding_review_restart", restartPayload(q, "deposit", "FR-1"), 12)
	rows, _ = k.Store.Range([]byte("funding_review_archive/"), []byte("funding_review_archive0"), 10)
	if len(rows) != 2 || !bytes.Equal(firstBytes, k.Store.Get([]byte(firstKey))) {
		t.Fatal("later restart overwrote original archive")
	}
	suspend(true)
	command(t, k, observer, "funding_attest", p, 13)
	command(t, k, guardian, "funding_attest", p, 14)
	rejectCommand(t, k, guardian, "", "funding_review_restart", restartPayload(q, "deposit", "FR-1"), 15)
}

func TestFundingReviewSignedRefundPayoutAndBankContinuity(t *testing.T) {
	for _, kind := range []string{"refund", "payout", "bank"} {
		t.Run(kind, func(t *testing.T) {
			var k Keeper
			var member, peer, guardian actor
			var id, key, op string
			var p map[string]any
			var h int64
			if kind == "payout" {
				k, member, peer, guardian = externalBountyFixture(t)
				finishExternalWork(t, k, member, peer, guardian, 14)
				command(t, k, member, "external_bounty_intent", map[string]any{"id": "EP-1", "contribution": "FW-1", "evidence_digest": digest}, 17)
				id = "EP-1"
				key = "external_payout_quorum/EP-1"
				op = "external_bounty_attest"
				p = externalPayoutCheck()
				h = 18
			} else {
				k, member, peer, guardian = fundingFixture(t)
				h = 10
				if kind == "bank" {
					id = "FB-1"
					key = "fiat_beneficiary_quorum/FB-1"
					op = "fiat_beneficiary_attest"
					command(t, k, member, "fiat_beneficiary_bind", map[string]any{"id": id, "network": "fiat:USD", "account_digest": digest, "evidence_digest": digest}, 7)
					p = map[string]any{"beneficiary": id, "account_digest": digest, "evidence_digest": digest}
				} else {
					id = "FR-1"
					key = "funding_quorum/FR-1/refund"
					op = "funding_attest"
					command(t, k, member, "funding_file", fundingDeposit(id), 7)
					d := fundingCheck(id, "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
					command(t, k, peer, "funding_attest", d, 8)
					command(t, k, guardian, "funding_attest", d, 9)
					command(t, k, member, "funding_refund", map[string]any{"receipt": id, "evidence_digest": digest}, 10)
					p = fundingCheck(id, "refund", "0x"+strings.Repeat("6", 64), "101", "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")
					h = 11
				}
			}
			command(t, k, peer, op, p, h)
			var q FundingQuorum
			_ = get(k.Store, key, &q)
			m, _ := k.Member(peer.m.ID)
			m.Licence = "suspended"
			_ = put(k.Store, "member/"+m.ID, m)
			pool := bytes.Clone(k.Store.Get([]byte("funding_pool/FR-1")))
			command(t, k, guardian, "funding_review_restart", restartPayload(q, kind, id), h+1)
			if !bytes.Equal(pool, k.Store.Get([]byte("funding_pool/FR-1"))) {
				t.Fatal("restart changed pool")
			}
			m.Licence = "active"
			_ = put(k.Store, "member/"+m.ID, m)
			if kind != "bank" {
				old := p["block_hash"]
				p["block_hash"] = "0x" + strings.Repeat("8", 64)
				rejectCommand(t, k, peer, "", op, p, h+2)
				p["block_hash"] = old
			} else {
				p["account_digest"] = strings.Repeat("b", 64)
				rejectCommand(t, k, peer, "", op, p, h+2)
				p["account_digest"] = digest
			}
			command(t, k, peer, op, p, h+3)
			command(t, k, guardian, op, p, h+4)
			rejectCommand(t, k, guardian, "", "funding_review_restart", restartPayload(q, kind, id), h+5)
		})
	}
}
