package federation

import (
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/uain-org/uain/chain/economy"
)

// OperationsIntent authorizes only a disclosed exact external operating cost.
// It is not Coin issuance, proof that an invoice is honest, or bank custody.
type OperationsIntent struct {
	ID             string `json:"id"`
	Receipt        string `json:"receipt"`
	Guardian       string `json:"guardian"`
	Network        string `json:"network"`
	Asset          string `json:"asset"`
	Escrow         string `json:"escrow"`
	Amount         string `json:"amount"`
	Target         string `json:"target"`
	Payee          string `json:"payee"`
	InvoiceDigest  string `json:"invoice_digest"`
	EvidenceDigest string `json:"evidence_digest"`
	Member         string `json:"member,omitempty"`
	WalletBinding  string `json:"wallet_binding,omitempty"`
	Height         int64  `json:"height,string"`
	State          string `json:"state"`
}

func (k Keeper) operationsIntent(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" {
		return "", errors.New("current guardian's exact operating-cost authorization required")
	}
	var p struct {
		ID             string `json:"id"`
		Receipt        string `json:"receipt"`
		Network        string `json:"network"`
		Asset          string `json:"asset"`
		Escrow         string `json:"escrow"`
		Amount         string `json:"amount"`
		Target         string `json:"target"`
		Payee          string `json:"payee"`
		InvoiceDigest  string `json:"invoice_digest"`
		EvidenceDigest string `json:"evidence_digest"`
		Member         string `json:"member,omitempty"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	p.Payee = strings.TrimSpace(p.Payee)
	if !validID(p.ID) || !validID(p.Receipt) || p.Asset != "native" || !fundingAddress(p.Network, p.Target) || p.Target == p.Escrow || len(p.Payee) < 1 || len(p.Payee) > 500 || !digestPattern.MatchString(p.InvoiceDigest) || !digestPattern.MatchString(p.EvidenceDigest) || k.Store.Get([]byte("operations_intent/"+p.ID)) != nil || k.Store.Get([]byte("operations_filing/"+p.ID)) != nil {
		return "", errors.New("new exact bounded operating-cost intent and public invoice evidence required")
	}
	if e := fundingAssetAmount(p.Network, p.Amount); e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e := get(k.Store, "funding_receipt/"+p.Receipt, &receipt); e != nil {
		return "", e
	}
	if receipt.State != "confirmed" {
		return "", errors.New("confirmed original funding receipt required")
	}
	var campaign FundingCampaign
	if e := get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	if campaign.Network != p.Network || campaign.Asset != p.Asset || campaign.Escrow != p.Escrow {
		return "", errors.New("operations cost differs from original funded network/asset/escrow")
	}
	if _, e := k.TreasuryEscrow(campaign.Network, campaign.Escrow); e != nil {
		return "", e
	}
	binding := ""
	if p.Member != "" {
		member, e := k.Member(p.Member)
		if e != nil || member.Licence != "active" {
			return "", errors.New("optional member payee must be licensed")
		}
		if strings.HasPrefix(p.Network, "fiat:") {
			bank, e := k.FiatBeneficiary(p.Member, p.Network)
			if e != nil {
				return "", e
			}
			if bank.AccountDigest != p.Target {
				return "", errors.New("member cost recipient differs from current bank proof")
			}
			binding = "fiat/" + bank.ID
		} else {
			network := "ethereum"
			if p.Network == "solana:mainnet" {
				network = "solana"
			}
			wallet, e := k.ExternalWallet(p.Member, network)
			if e != nil {
				return "", e
			}
			if wallet.Address != p.Target {
				return "", errors.New("member cost recipient differs from current wallet proof")
			}
			binding = wallet.Binding
		}
	}
	var pool economy.Pool
	if e := get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
		return "", e
	}
	var e error
	pool, e = pool.Reserve("operations", p.Amount)
	if e != nil {
		return "", e
	}
	intent := OperationsIntent{p.ID, receipt.ID, c.Member, p.Network, p.Asset, p.Escrow, p.Amount, p.Target, p.Payee, p.InvoiceDigest, p.EvidenceDigest, p.Member, binding, height, "pending"}
	if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
		return "", e
	}
	if e = put(k.Store, "operations_filing/"+p.ID, intent); e != nil {
		return "", e
	}
	return p.ID, put(k.Store, "operations_intent/"+p.ID, intent)
}
func (k Keeper) operationsContext(intent OperationsIntent) (FundingReceipt, FundingCampaign, error) {
	var receipt FundingReceipt
	var campaign FundingCampaign
	if e := get(k.Store, "funding_receipt/"+intent.Receipt, &receipt); e != nil {
		return receipt, campaign, e
	}
	if e := get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return receipt, campaign, e
	}
	if intent.State != "pending" || receipt.State != "confirmed" || campaign.Network != intent.Network || campaign.Asset != intent.Asset || campaign.Escrow != intent.Escrow {
		return receipt, campaign, errors.New("exact pending operations obligation from confirmed funds required")
	}
	if intent.Member != "" {
		if e := verifyFrozenPayoutBinding(k, ExternalPayoutIntent{Member: intent.Member, Network: intent.Network, Address: intent.Target, WalletBinding: intent.WalletBinding}); e != nil {
			return receipt, campaign, e
		}
	}
	return receipt, campaign, nil
}
func (k Keeper) operationsObserver(c Command, a FundingActivation, intent OperationsIntent, receipt FundingReceipt, campaign FundingCampaign, old []FundingObservation) error {
	excluded := append([]FundingObservation{}, old...)
	excluded = append(excluded, FundingObservation{Member: intent.Guardian})
	if intent.Member != "" {
		excluded = append(excluded, FundingObservation{Member: intent.Member})
	}
	if e := k.fundingObserver(c, a, receipt, campaign, excluded); e != nil {
		return e
	}
	for _, address := range []string{receipt.Source, intent.Escrow, intent.Target} {
		if e := k.independentFundingAddress(intent.Network, address, c.Member); e != nil {
			return e
		}
	}

	return k.independentFundingSource("treasury_escrow_control", intent.Network, intent.Target, c.Member)
}
func (k Keeper) operationsAttest(c Command, height int64) (string, error) {
	a, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var p FundingAttestation
	if e = Decode(c.Payload, &p); e != nil {
		return "", e
	}
	var intent OperationsIntent
	if e = get(k.Store, "operations_intent/"+p.Receipt, &intent); e != nil {
		return "", e
	}
	receipt, campaign, e := k.operationsContext(intent)
	if e != nil {
		return "", e
	}
	if p.Kind != "operations" || p.Amount != intent.Amount || p.Target != intent.Target || p.Source != intent.Escrow || !digestPattern.MatchString(p.EvidenceDigest) || !fundingIndex.MatchString(p.Block) || p.Block == "0" {
		return "", errors.New("exact operating-cost transfer and finalized checkpoint required")
	}
	block, _ := new(big.Int).SetString(p.Block, 10)
	included, ok := new(big.Int).SetString(receipt.Block, 10)
	if !ok || block.Cmp(included) < 0 {
		return "", errors.New("operations finality predates original funding inclusion")
	}
	if intent.Network == "solana:mainnet" {
		if !validExternalAddress("solana", p.BlockHash) {
			return "", errors.New("canonical Solana finalized checkpoint required")
		}
	} else {
		if _, e = fundingReference(intent.Network, p.BlockHash, "0"); e != nil {
			return "", e
		}
	}
	ref, e := fundingReference(intent.Network, p.Transaction, p.Index)
	if e != nil {
		return "", e
	}
	if raw := k.Store.Get([]byte("external_transfer/" + ref)); raw != nil {
		var bind struct{ Kind, ID string }
		if e = Decode(raw, &bind); e != nil || bind.Kind != "operations" || bind.ID != intent.ID {
			return "", errors.New("operations transfer already consumed by another effect")
		}
	}
	key := "operations_quorum/" + intent.ID
	var q FundingQuorum
	if k.Store.Get([]byte(key)) != nil {
		if e = get(k.Store, key, &q); e != nil {
			return "", e
		}
	}
	effects := fundingEffects(p)
	if len(q.Observations) >= 2 || q.EffectsDigest != "" && q.EffectsDigest != effects {
		return "", errors.New("duplicate or conflicting operations finality")
	}
	if e = k.operationsObserver(c, a, intent, receipt, campaign, q.Observations); e != nil {
		return "", e
	}
	for _, old := range q.Observations {
		if e = k.operationsObserver(Command{Member: old.Member}, a, intent, receipt, campaign, nil); e != nil {
			return "", e
		}
		proof, e := k.OperatorProof(old.Member, "")
		if e != nil || proof == nil || proof.Domain != old.OperatorDomain {
			return "", errors.New("operations first observer proof changed")
		}
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil || proof == nil {
		return "", errors.New("proved operations observer required")
	}
	q.EffectsDigest = effects
	q.Observations = append(q.Observations, FundingObservation{c.Member, proof.Domain, height, p})
	if e = put(k.Store, "external_transfer/"+ref, struct{ Kind, ID string }{"operations", intent.ID}); e != nil {
		return "", e
	}
	if len(q.Observations) == 2 {
		var pool economy.Pool
		if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
			return "", e
		}
		pool, e = pool.Pay("operations", intent.Amount)
		if e != nil {
			return "", e
		}
		if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
			return "", e
		}
		if e = k.debitTreasuryLiability(intent.Network, intent.Escrow, intent.Amount, "operations", intent.ID); e != nil {
			return "", e
		}
		intent.State = "paid"
		if e = put(k.Store, "operations_intent/"+intent.ID, intent); e != nil {
			return "", e
		}
	}
	return intent.ID, put(k.Store, key, q)
}

// Review recovery never releases a reserve or forgets the consumed transaction.
func (k Keeper) operationsReviewRestart(c Command, height int64) (string, error) {
	a, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var p struct {
		ID       string `json:"id"`
		Effects  string `json:"expected_effects_digest"`
		Evidence string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || !validID(p.ID) || !digestPattern.MatchString(p.Effects) || !digestPattern.MatchString(p.Evidence) {
		return "", errors.New("guardian exact pending operations review evidence required")
	}
	var intent OperationsIntent
	if e = get(k.Store, "operations_intent/"+p.ID, &intent); e != nil {
		return "", e
	}
	receipt, campaign, e := k.operationsContext(intent)
	if e != nil {
		return "", e
	}
	key := "operations_quorum/" + p.ID
	var q FundingQuorum
	if e = get(k.Store, key, &q); e != nil {
		return "", e
	}
	if len(q.Observations) != 1 || q.EffectsDigest != p.Effects {
		return "", errors.New("one exact retained operations observation required")
	}
	old := q.Observations[0]
	if old.Height < 1 || old.Height > height || old.Attestation.Receipt != p.ID || old.Attestation.Kind != "operations" || fundingEffects(old.Attestation) != q.EffectsDigest {
		return "", errors.New("malformed retained operations review")
	}
	invalid := k.operationsObserver(Command{Member: old.Member}, a, intent, receipt, campaign, nil) != nil
	proof, err := k.OperatorProof(old.Member, "")
	invalid = invalid || err != nil || proof == nil || proof.Domain != old.OperatorDomain
	reason := "observer_ineligible"
	if !invalid {
		if height-old.Height < FundingReviewTimeout {
			return "", errors.New("active operations review has not timed out")
		}
		reason = "timeout"
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	id := fmt.Sprintf("%020d", event)
	archiveKey := "operations_review_archive/" + id
	if k.Store.Get([]byte(archiveKey)) != nil {
		return "", errors.New("operations review archive already exists")
	}
	if e = put(k.Store, archiveKey, FundingReviewArchive{id, "operations", p.ID, height, c.Member, p.Evidence, reason, q}); e != nil {
		return "", e
	}
	q.Observations = nil
	return p.ID, put(k.Store, key, q)
}
