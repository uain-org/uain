package federation

import "errors"

// Bank evidence is verified off chain by the appointed independent observers.
// Consensus stores only member-approved commitments, never bank details. This
// is an explicit trusted statement-verification model, not a bank signature.
type FiatBeneficiary struct {
	ID             string `json:"id"`
	Member         string `json:"member"`
	Network        string `json:"network"`
	AccountDigest  string `json:"account_digest"`
	EvidenceDigest string `json:"evidence_digest"`
	Height         int64  `json:"height,string"`
}

func (k Keeper) bindFiatBeneficiary(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		ID             string `json:"id"`
		Network        string `json:"network"`
		AccountDigest  string `json:"account_digest"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if c.Instance != "" || !validID(input.ID) || (input.Network != "fiat:USD" && input.Network != "fiat:EUR") || !digestPattern.MatchString(input.AccountDigest) || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("fiat_beneficiary_request/"+input.ID)) != nil {
		return "", errors.New("new privately documented member-approved bank beneficiary required")
	}
	if k.Store.Get([]byte("fiat_beneficiary_current/"+c.Member+"/"+input.Network)) != nil {
		return "", errors.New("unbind existing bank beneficiary before replacement")
	}
	record := FiatBeneficiary{input.ID, c.Member, input.Network, input.AccountDigest, input.EvidenceDigest, height}
	return input.ID, put(k.Store, "fiat_beneficiary_request/"+input.ID, record)
}
func (k Keeper) attestFiatBeneficiary(c Command, height int64) (string, error) {
	activation, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var input struct {
		Beneficiary    string `json:"beneficiary"`
		AccountDigest  string `json:"account_digest"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var record FiatBeneficiary
	if e = get(k.Store, "fiat_beneficiary_request/"+input.Beneficiary, &record); e != nil {
		return "", e
	}
	currentKey := "fiat_beneficiary_current/" + record.Member + "/" + record.Network
	if input.AccountDigest != record.AccountDigest || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("fiat_beneficiary_proof/"+record.ID)) != nil || k.Store.Get([]byte("fiat_beneficiary_end/"+record.ID)) != nil || k.Store.Get([]byte(currentKey)) != nil {
		return "", errors.New("exact unapproved unbound bank ownership commitment required")
	}
	member, e := k.Member(record.Member)
	if e != nil || member.Licence != "active" {
		return "", errors.New("bank beneficiary no longer licensed")
	}
	key := "fiat_beneficiary_quorum/" + record.ID
	var quorum FundingQuorum
	if k.Store.Get([]byte(key)) != nil {
		if e = get(k.Store, key, &quorum); e != nil {
			return "", e
		}
	}
	receipt := FundingReceipt{Payer: record.Member}
	campaign := FundingCampaign{Lead: record.Member}
	observation := FundingAttestation{Receipt: record.ID, Kind: "bank_ownership", Target: record.AccountDigest, EvidenceDigest: input.EvidenceDigest}
	effects := fundingEffects(observation)
	if len(quorum.Observations) >= 2 || quorum.EffectsDigest != "" && quorum.EffectsDigest != effects {
		return "", errors.New("bank ownership quorum already complete or effects changed")
	}
	if e = k.fundingObserver(c, activation, receipt, campaign, quorum.Observations); e != nil {
		return "", e
	}
	for _, old := range quorum.Observations {
		if e = k.fundingObserver(Command{Member: old.Member}, activation, receipt, campaign, nil); e != nil {
			return "", e
		}
		proof, e := k.OperatorProof(old.Member, "")
		if e != nil || proof == nil || proof.Domain != old.OperatorDomain {
			return "", errors.New("bank observer proof changed")
		}
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil {
		return "", e
	}
	quorum.EffectsDigest = effects
	quorum.Observations = append(quorum.Observations, FundingObservation{c.Member, proof.Domain, height, observation})
	if len(quorum.Observations) == 2 {
		if e = k.rememberFundingSourceControl("fiat_bank_control", record.Network, record.AccountDigest, record.Member); e != nil {
			return "", e
		}
		if e = put(k.Store, "fiat_beneficiary_proof/"+record.ID, record); e != nil {
			return "", e
		}
		if e = put(k.Store, currentKey, record.ID); e != nil {
			return "", e
		}
	}
	return record.ID, put(k.Store, key, quorum)
}
func (k Keeper) unbindFiatBeneficiary(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Beneficiary string `json:"beneficiary"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var record FiatBeneficiary
	if e := get(k.Store, "fiat_beneficiary_proof/"+input.Beneficiary, &record); e != nil {
		return "", e
	}
	if record.Member != c.Member || c.Instance != "" || k.Store.Get([]byte("fiat_beneficiary_end/"+record.ID)) != nil {
		return "", errors.New("active owned bank beneficiary required")
	}
	key := "fiat_beneficiary_current/" + record.Member + "/" + record.Network
	var id string
	if e := get(k.Store, key, &id); e != nil {
		return "", e
	}
	if id != record.ID {
		return "", errors.New("bank beneficiary no longer current")
	}
	if e := put(k.Store, "fiat_beneficiary_end/"+record.ID, struct {
		Member string `json:"member"`
		Height int64  `json:"height,string"`
	}{c.Member, height}); e != nil {
		return "", e
	}
	k.Store.Delete([]byte(key))
	return record.ID, nil
}
func (k Keeper) FiatBeneficiary(member, network string) (FiatBeneficiary, error) {
	var record FiatBeneficiary
	var id string
	if e := get(k.Store, "fiat_beneficiary_current/"+member+"/"+network, &id); e != nil {
		return record, e
	}
	if e := get(k.Store, "fiat_beneficiary_proof/"+id, &record); e != nil {
		return record, e
	}
	if record.Member != member || record.Network != network || record.ID != id || !digestPattern.MatchString(record.AccountDigest) || k.Store.Get([]byte("fiat_beneficiary_end/"+id)) != nil {
		return record, errors.New("active verified bank beneficiary required")
	}
	return record, nil
}
