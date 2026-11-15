package federation

import (
	"errors"
	"fmt"
	"math"
)

// FundingReviewTimeout is a recovery bound, not a bank or chain finality rule.
const FundingReviewTimeout int64 = 720

type FundingObserverEpoch struct {
	ID         string            `json:"id"`
	Previous   string            `json:"previous"`
	Activation FundingActivation `json:"activation"`
	ChangedAt  int64             `json:"changed_at,string"`
	Guardian   string            `json:"guardian"`
}

type FundingReviewArchive struct {
	Event          string        `json:"event"`
	Kind           string        `json:"kind"`
	ID             string        `json:"id"`
	Height         int64         `json:"height,string"`
	Guardian       string        `json:"guardian"`
	EvidenceDigest string        `json:"evidence_digest"`
	Reason         string        `json:"reason"`
	Quorum         FundingQuorum `json:"quorum"`
}

// EffectiveFundingObservers resolves only the current epoch or its predecessor.
// Consensus calls it at the execution height; historical callers must query a
// historical state proof instead of traversing an unbounded list of epochs.
func (k Keeper) EffectiveFundingObservers(base FundingActivation, height int64) (FundingActivation, error) {
	if base.Policy != FundingPolicy || base.Height < 2 || height < base.Height {
		return base, errors.New("external funding policy is not active")
	}
	if k.Store.Get([]byte("funding_observer_epoch_current")) == nil {
		return base, nil
	}
	var id string
	if e := get(k.Store, "funding_observer_epoch_current", &id); e != nil {
		return base, e
	}
	var epoch FundingObserverEpoch
	if e := get(k.Store, "funding_observer_epoch/"+id, &epoch); e != nil {
		return base, e
	}
	if e := validFundingEpoch(epoch, id); e != nil {
		return base, e
	}
	if epoch.Activation.Height <= height {
		return epoch.Activation, nil
	}
	// Exactly one pending prospective epoch is allowed. A current-state query for
	// an older height cannot silently pretend the original appointment applies.
	if height != epoch.ChangedAt {
		return base, errors.New("historical funding observers require historical state")
	}
	if epoch.Previous == "" {
		return base, nil
	}
	var previous FundingObserverEpoch
	if e := get(k.Store, "funding_observer_epoch/"+epoch.Previous, &previous); e != nil {
		return base, e
	}
	if e := validFundingEpoch(previous, epoch.Previous); e != nil {
		return base, e
	}
	if previous.Activation.Height > height || previous.ChangedAt >= epoch.ChangedAt {
		return base, errors.New("invalid funding observer predecessor")
	}
	return previous.Activation, nil
}

func validFundingEpoch(epoch FundingObserverEpoch, id string) error {
	if epoch.ID != id || epoch.ChangedAt < 1 || epoch.ChangedAt == math.MaxInt64 || epoch.Activation.Height != epoch.ChangedAt+1 || epoch.Activation.Policy != FundingPolicy || len(epoch.Activation.Observers) < 2 || len(epoch.Activation.Observers) > 20 || !digestPattern.MatchString(epoch.Activation.EvidenceDigest) {
		return errors.New("invalid funding observer epoch")
	}
	return nil
}

func (k Keeper) rotateFundingObservers(c Command, height int64) (string, error) {
	var p struct {
		Observers      []string `json:"observers"`
		EvidenceDigest string   `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || height < 1 || height == math.MaxInt64 || len(p.Observers) < 2 || len(p.Observers) > 20 || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("guardian reviewed bounded prospective funding observers required")
	}
	var base FundingActivation
	if e := get(k.Store, "funding_activation", &base); e != nil {
		return "", e
	}
	if _, e := k.EffectiveFundingObservers(base, height); e != nil {
		return "", e
	}
	previous := ""
	if k.Store.Get([]byte("funding_observer_epoch_current")) != nil {
		if e := get(k.Store, "funding_observer_epoch_current", &previous); e != nil {
			return "", e
		}
		var epoch FundingObserverEpoch
		if e := get(k.Store, "funding_observer_epoch/"+previous, &epoch); e != nil {
			return "", e
		}
		if epoch.Activation.Height > height {
			return "", errors.New("pending funding observer rotation must activate first")
		}
	}
	for i, id := range p.Observers {
		m, e := k.Member(id)
		if e != nil || m.Licence != "active" || m.Karma < 100 {
			return "", errors.New("active high-standing funding observer required")
		}
		proof, e := k.OperatorProof(id, "")
		if e != nil || proof == nil {
			return "", errors.New("proved funding operator required")
		}
		for _, other := range p.Observers[:i] {
			same, e := k.sameOperator(id, "", other, "")
			if e != nil {
				return "", e
			}
			if same {
				return "", errors.New("pairwise independent funding operators required")
			}
		}
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	id := fmt.Sprintf("%020d", event)
	key := "funding_observer_epoch/" + id
	if k.Store.Get([]byte(key)) != nil {
		return "", errors.New("funding observer epoch event already recorded")
	}
	epoch := FundingObserverEpoch{id, previous, FundingActivation{FundingPolicy, height + 1, p.Observers, p.EvidenceDigest}, height, c.Member}
	if e = put(k.Store, key, epoch); e != nil {
		return "", e
	}
	return id, put(k.Store, "funding_observer_epoch_current", id)
}

// fundingReviewContext selects existing pending objects only. It never edits
// receipt, transfer-use, beneficiary, intent, reservation, or pool records.
func (k Keeper) fundingReviewContext(kind, id string) (string, FundingReceipt, FundingCampaign, []FundingObservation, error) {
	var receipt FundingReceipt
	var campaign FundingCampaign
	var exclude []FundingObservation
	var key string
	switch kind {
	case "deposit", "refund":
		if e := get(k.Store, "funding_receipt/"+id, &receipt); e != nil {
			return "", receipt, campaign, nil, e
		}
		expected := "pending"
		if kind == "refund" {
			expected = "refund_pending"
		}
		if receipt.State != expected {
			return "", receipt, campaign, nil, errors.New("funding receipt is not pending review")
		}
		key = "funding_quorum/" + id + "/" + kind
	case "payout":
		var intent ExternalPayoutIntent
		if e := get(k.Store, "external_payout/"+id, &intent); e != nil {
			return "", receipt, campaign, nil, e
		}
		if intent.State != "pending" {
			return "", receipt, campaign, nil, errors.New("external payout is not pending review")
		}
		if e := get(k.Store, "funding_receipt/"+intent.Receipt, &receipt); e != nil {
			return "", receipt, campaign, nil, e
		}
		if receipt.State != "confirmed" {
			return "", receipt, campaign, nil, errors.New("payout receipt is not confirmed")
		}
		exclude = []FundingObservation{{Member: intent.Member}}
		key = "external_payout_quorum/" + id
	case "bank":
		var beneficiary FiatBeneficiary
		if e := get(k.Store, "fiat_beneficiary_request/"+id, &beneficiary); e != nil {
			return "", receipt, campaign, nil, e
		}
		if k.Store.Get([]byte("fiat_beneficiary_proof/"+id)) != nil || k.Store.Get([]byte("fiat_beneficiary_end/"+id)) != nil || k.Store.Get([]byte("fiat_beneficiary_current/"+beneficiary.Member+"/"+beneficiary.Network)) != nil {
			return "", receipt, campaign, nil, errors.New("bank beneficiary is no longer pending")
		}
		return "fiat_beneficiary_quorum/" + id, FundingReceipt{Payer: beneficiary.Member}, FundingCampaign{Lead: beneficiary.Member}, nil, nil
	default:
		return "", receipt, campaign, nil, errors.New("unknown funding review kind")
	}
	if e := get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", receipt, campaign, nil, e
	}
	return key, receipt, campaign, exclude, nil
}

func (k Keeper) restartFundingReview(c Command, height int64) (string, error) {
	var p struct {
		Kind                  string `json:"kind"`
		ID                    string `json:"id"`
		ExpectedEffectsDigest string `json:"expected_effects_digest"`
		EvidenceDigest        string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || height < 1 || !validID(p.ID) || !digestPattern.MatchString(p.ExpectedEffectsDigest) || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("guardian evidence and expected funding effects required")
	}
	var base FundingActivation
	if e := get(k.Store, "funding_activation", &base); e != nil {
		return "", e
	}
	activation, e := k.EffectiveFundingObservers(base, height)
	if e != nil {
		return "", e
	}
	key, receipt, campaign, exclude, e := k.fundingReviewContext(p.Kind, p.ID)
	if e != nil {
		return "", e
	}
	var q FundingQuorum
	if e = get(k.Store, key, &q); e != nil {
		return "", e
	}
	if len(q.Observations) != 1 || q.EffectsDigest != p.ExpectedEffectsDigest {
		return "", errors.New("exact single-observer pending funding quorum required")
	}
	old := q.Observations[0]
	kind := p.Kind
	if kind == "bank" {
		kind = "bank_ownership"
	}
	if old.Height < 1 || old.Height > height || old.Attestation.Receipt != p.ID || old.Attestation.Kind != kind || fundingEffects(old.Attestation) != q.EffectsDigest {
		return "", errors.New("inconsistent original funding observation")
	}
	invalid := k.fundingObserver(Command{Member: old.Member}, activation, receipt, campaign, exclude) != nil
	proof, err := k.OperatorProof(old.Member, "")
	invalid = invalid || err != nil || proof == nil || proof.Domain != old.OperatorDomain
	reason := "observer_ineligible"
	if !invalid {
		if height-old.Height < FundingReviewTimeout {
			return "", errors.New("eligible funding quorum has not reached recovery timeout")
		}
		reason = "timeout"
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	eventID := fmt.Sprintf("%020d", event)
	archiveKey := "funding_review_archive/" + p.Kind + "/" + p.ID + "/" + eventID
	if k.Store.Get([]byte(archiveKey)) != nil {
		return "", errors.New("funding restart event already archived")
	}
	archive := FundingReviewArchive{eventID, p.Kind, p.ID, height, c.Member, p.EvidenceDigest, reason, q}
	if e = put(k.Store, archiveKey, archive); e != nil {
		return "", e
	}
	return p.ID, put(k.Store, key, FundingQuorum{EffectsDigest: q.EffectsDigest, Observations: []FundingObservation{}})
}
