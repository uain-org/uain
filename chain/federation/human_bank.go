package federation

import "errors"

// This key authorizes nonmember consent only; it creates no membership or
// licence and is not a bank signature. Appointed independent observers verify bank statements.
type HumanBankRecord struct {
	ID             string              `json:"id"`
	Relay          string              `json:"relay"`
	Network        string              `json:"network"`
	AccountDigest  string              `json:"account_digest"`
	OwnerPublicKey string              `json:"owner_public_key"`
	EvidenceDigest string              `json:"evidence_digest"`
	Consent        HumanFundingConsent `json:"consent"`
	Height         int64               `json:"height,string"`
}

func humanBankConsentFields(fields map[string]string, bank string) map[string]string {
	if bank == "" {
		return fields
	}
	out := map[string]string{}
	for k, v := range fields {
		out[k] = v
	}
	out["bank"] = bank
	return out
}
func (k Keeper) humanBank(id string, active bool) (HumanBankRecord, error) {
	var bank HumanBankRecord
	if !validID(id) {
		return bank, errors.New("verified nonmember bank reference required")
	}
	if e := get(k.Store, "human_bank_proof/"+id, &bank); e != nil {
		return bank, e
	}
	if bank.ID != id || (bank.Network != "fiat:USD" && bank.Network != "fiat:EUR") || !digestPattern.MatchString(bank.AccountDigest) || !validExternalAddress("solana", bank.OwnerPublicKey) {
		return bank, errors.New("invalid nonmember bank ownership proof")
	}
	if active {
		var current string
		if e := get(k.Store, "human_bank_current/"+bank.Network+"/"+bank.AccountDigest, &current); e != nil || current != id {
			return bank, errors.New("nonmember bank ownership no longer current")
		}
	}
	return bank, nil
}
func (k Keeper) humanBankBind(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input HumanFundingConsent
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var fields map[string]string
	if e := Decode(input.Funding, &fields); e != nil {
		return "", e
	}
	if len(fields) != 5 || input.Bank != "" || !validID(fields["id"]) || (fields["network"] != "fiat:USD" && fields["network"] != "fiat:EUR") || !digestPattern.MatchString(fields["account_digest"]) || !digestPattern.MatchString(fields["evidence_digest"]) || c.Instance != "" || input.ExpiresHeight < height || input.ExpiresHeight-height > ExternalWalletProofWindow || c.ExpiresHeight > input.ExpiresHeight || k.Store.Get([]byte("human_bank_request/"+fields["id"])) != nil {
		return "", errors.New("fresh nonmember bank consent and privately documented account commitment required")
	}
	message, e := HumanFundingProofBytes(c.ChainID, c.Member, c.Sequence, input.ExpiresHeight, "bank", fields)
	if e != nil {
		return "", e
	}
	if e = verifyExternalWallet("solana", fields["owner_public_key"], input.Signature, message); e != nil {
		return "", e
	}
	record := HumanBankRecord{fields["id"], c.Member, fields["network"], fields["account_digest"], fields["owner_public_key"], fields["evidence_digest"], input, height}
	return record.ID, put(k.Store, "human_bank_request/"+record.ID, record)
}
func (k Keeper) humanBankAttest(c Command, height int64) (string, error) {
	activation, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var input struct {
		Bank           string `json:"bank"`
		AccountDigest  string `json:"account_digest"`
		OwnerPublicKey string `json:"owner_public_key"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var record HumanBankRecord
	if e = get(k.Store, "human_bank_request/"+input.Bank, &record); e != nil {
		return "", e
	}
	current := "human_bank_current/" + record.Network + "/" + record.AccountDigest
	if height > record.Consent.ExpiresHeight {
		return "", errors.New("nonmember bank approval consent expired; submit a fresh request")
	}
	if e = k.independentFundingSource("fiat_bank_control", record.Network, record.AccountDigest, c.Member); e != nil {
		return "", e
	}
	if input.AccountDigest != record.AccountDigest || input.OwnerPublicKey != record.OwnerPublicKey || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("human_bank_proof/"+record.ID)) != nil || k.Store.Get([]byte(current)) != nil {
		return "", errors.New("exact unapproved nonmember bank ownership required")
	}
	// The native relay also remains licensed while its filed request is reviewed.
	relay, e := k.Member(record.Relay)
	if e != nil || relay.Licence != "active" {
		return "", errors.New("bank consent relay is no longer licensed")
	}
	observer, e := k.Member(c.Member)
	if e != nil {
		return "", e
	}
	if base58PublicKey(observer.PublicKey) == record.OwnerPublicKey {
		return "", errors.New("bank owner cannot attest its own ownership")
	}
	key := "human_bank_quorum/" + record.ID
	var quorum FundingQuorum
	if k.Store.Get([]byte(key)) != nil {
		if e = get(k.Store, key, &quorum); e != nil {
			return "", e
		}
	}
	effect := FundingAttestation{Receipt: record.ID, Kind: "nonmember_bank_ownership", Source: record.OwnerPublicKey, Target: record.AccountDigest, EvidenceDigest: input.EvidenceDigest}
	digest := fundingEffects(effect)
	if len(quorum.Observations) >= 2 || quorum.EffectsDigest != "" && quorum.EffectsDigest != digest {
		return "", errors.New("duplicate or conflicting nonmember bank review")
	}
	receipt := FundingReceipt{Payer: record.Relay, Source: record.OwnerPublicKey}
	campaign := FundingCampaign{Lead: record.Relay, Network: "solana:mainnet"}
	if e = k.fundingObserver(c, activation, receipt, campaign, quorum.Observations); e != nil {
		return "", e
	}
	for _, old := range quorum.Observations {
		if e = k.independentFundingSource("fiat_bank_control", record.Network, record.AccountDigest, old.Member); e != nil {
			return "", e
		}
		if e = k.fundingObserver(Command{Member: old.Member}, activation, receipt, campaign, nil); e != nil {
			return "", e
		}
		proof, e := k.OperatorProof(old.Member, "")
		if e != nil || proof == nil || proof.Domain != old.OperatorDomain {
			return "", errors.New("bank observer authority changed")
		}
		member, e := k.Member(old.Member)
		if e != nil || base58PublicKey(member.PublicKey) == record.OwnerPublicKey {
			return "", errors.New("bank owner cannot retain its own ownership observation")
		}
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil {
		return "", e
	}
	quorum.EffectsDigest = digest
	quorum.Observations = append(quorum.Observations, FundingObservation{c.Member, proof.Domain, height, effect})
	if len(quorum.Observations) == 2 {
		if e = k.rememberFundingEd25519Control("fiat_bank_control", record.Network, record.AccountDigest, record.OwnerPublicKey); e != nil {
			return "", e
		}
		if e = put(k.Store, "human_bank_proof/"+record.ID, record); e != nil {
			return "", e
		}
		if e = put(k.Store, current, record.ID); e != nil {
			return "", e
		}
	}
	return record.ID, put(k.Store, key, quorum)
}

// Ending future bank consent never deletes its proof or redirects old refunds.
func (k Keeper) humanBankEnd(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input HumanFundingConsent
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var fields map[string]string
	if e := Decode(input.Funding, &fields); e != nil {
		return "", e
	}
	if len(fields) != 4 || input.Bank != "" || c.Instance != "" || !digestPattern.MatchString(fields["evidence_digest"]) || input.ExpiresHeight < height || input.ExpiresHeight-height > ExternalWalletProofWindow || c.ExpiresHeight > input.ExpiresHeight {
		return "", errors.New("fresh bounded bank end consent required")
	}
	bank, e := k.humanBank(fields["bank"], true)
	if e != nil {
		return "", e
	}
	if fields["network"] != bank.Network || fields["account_digest"] != bank.AccountDigest {
		return "", errors.New("bank end must name exact current account")
	}
	message, e := HumanFundingProofBytes(c.ChainID, c.Member, c.Sequence, input.ExpiresHeight, "bank_end", fields)
	if e != nil {
		return "", e
	}
	if e = verifyExternalWallet("solana", bank.OwnerPublicKey, input.Signature, message); e != nil {
		return "", e
	}
	if k.Store.Get([]byte("human_bank_end/"+bank.ID)) != nil {
		return "", errors.New("bank consent already ended")
	}
	if e = put(k.Store, "human_bank_end/"+bank.ID, HumanFundingRecord{c.ChainID, c.Member, c.Sequence, bank.Network, bank.AccountDigest, "bank_end", input, height}); e != nil {
		return "", e
	}
	k.Store.Delete([]byte("human_bank_current/" + bank.Network + "/" + bank.AccountDigest))
	return bank.ID, nil
}
