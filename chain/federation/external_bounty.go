package federation

import (
	"errors"
	"math/big"
	"strings"

	"github.com/uain-org/uain/chain/economy"
)

type ExternalBountyQuote struct {
	Task           string `json:"task"`
	Receipt        string `json:"receipt"`
	Amount         string `json:"amount"`
	Manager        string `json:"manager"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
	State          string `json:"state"`
}
type ExternalPayoutIntent struct {
	ID             string `json:"id"`
	Contribution   string `json:"contribution"`
	Task           string `json:"task"`
	Receipt        string `json:"receipt"`
	Member         string `json:"member"`
	Amount         string `json:"amount"`
	Network        string `json:"network"`
	Asset          string `json:"asset"`
	Escrow         string `json:"escrow"`
	Address        string `json:"address"`
	WalletBinding  string `json:"wallet_binding"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
	State          string `json:"state"`
}

func (k Keeper) quoteExternalBounty(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Task           string `json:"task"`
		Receipt        string `json:"receipt"`
		Amount         string `json:"amount"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	t, e := k.taskState(input.Task)
	if e != nil {
		return "", e
	}
	project, e := k.Project(t.Project)
	if e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e = get(k.Store, "funding_receipt/"+input.Receipt, &receipt); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e = get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	if c.Member != project.Lead || c.Instance != "" || project.State != "active" || project.SafetyHalted || project.OperatorPolicy != OperatorRewardPolicy || project.MembershipPolicy != MembershipPolicy || !allowedClass(project.Class) || campaign.Project != project.ID || receipt.State != "confirmed" || t.State != "open" || t.StoragePolicy != CompactStatePolicy || t.RewardPolicy != CreditRewardPolicy || t.VerifiersRequired < 2 || t.Winner != "" || len(t.Submissions) != 0 || len(t.OpenChallenges) != 0 || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("external_bounty/"+t.ID)) != nil {
		return "", errors.New("external bounty requires independent policy, confirmed funds and an unstarted safe task")
	}
	var pool economy.Pool
	if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
		return "", e
	}
	pool, e = pool.Reserve("bounty", input.Amount)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "external_bounty/"+t.ID, ExternalBountyQuote{t.ID, receipt.ID, input.Amount, c.Member, height, input.EvidenceDigest, "reserved"})
}
func (k Keeper) intentExternalBounty(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		ID             string `json:"id"`
		Contribution   string `json:"contribution"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if !validID(input.ID) || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("external_payout/"+input.ID)) != nil {
		return "", errors.New("new external payout intent and evidence required")
	}
	v, e := k.contributionState(input.Contribution)
	if e != nil {
		return "", e
	}
	t, e := k.Task(v.Task)
	if e != nil {
		return "", e
	}
	project, e := k.Project(t.Project)
	if e != nil {
		return "", e
	}
	var quote ExternalBountyQuote
	if e = get(k.Store, "external_bounty/"+t.ID, &quote); e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e = get(k.Store, "funding_receipt/"+quote.Receipt, &receipt); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e = get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	if v.Author != c.Member || v.State != "settled" || v.AwardWithheld != "" || t.State != "settled" || t.PriorArtDecision != "" || t.Winner != v.ID || len(t.OpenChallenges) != 0 || project.OperatorPolicy != OperatorRewardPolicy || project.MembershipPolicy != MembershipPolicy || project.SafetyHalted || !allowedClass(project.Class) || !allowedClass(t.Class) || quote.Task != t.ID || quote.State != "reserved" || receipt.State != "confirmed" || campaign.Project != project.ID || v.Settlement == nil || !v.Settlement.Paid || v.Settlement.Policy != CreditRewardPolicy || v.Settlement.FactorNumerator != 1 || v.Settlement.FactorDenominator != 1 || v.Settlement.IndependentOperators < 2 || !v.Settlement.OtherFamily || t.VerifiersRequired < 2 || k.Store.Get([]byte("external_paid_work/"+v.ID)) != nil {
		return "", errors.New("external payout requires the licensed winner of fully verified new reserved work")
	}
	checks, e := k.frozenChecks(v)
	if e != nil {
		return "", e
	}
	if len(checks) < t.VerifiersRequired {
		return "", errors.New("missing frozen novelty checks")
	}
	for _, check := range checks {
		if check.Member == v.Author || check.Verdict != "confirm" || check.Novelty != "new" {
			return "", errors.New("external bounty requires independently confirmed new work")
		}
	}
	address, binding := "", ""
	if strings.HasPrefix(campaign.Network, "fiat:") {
		bank, err := k.FiatBeneficiary(c.Member, campaign.Network)
		if err != nil {
			return "", err
		}
		address, binding = bank.AccountDigest, "fiat/"+bank.ID
	} else {
		network := "ethereum"
		if campaign.Network == "solana:mainnet" {
			network = "solana"
		}
		wallet, err := k.ExternalWallet(c.Member, network)
		if err != nil {
			return "", err
		}
		address, binding = wallet.Address, wallet.Binding
	}
	var pool economy.Pool
	if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
		return "", e
	}
	if e = pool.Validate(); e != nil {
		return "", e
	}
	reserved, _ := new(big.Int).SetString(pool.Bounty.Reserved, 10)
	amount, _ := new(big.Int).SetString(quote.Amount, 10)
	if amount == nil || reserved.Cmp(amount) < 0 {
		return "", errors.New("external bounty reservation lost")
	}
	intent := ExternalPayoutIntent{input.ID, v.ID, t.ID, receipt.ID, c.Member, quote.Amount, campaign.Network, campaign.Asset, campaign.Escrow, address, binding, height, input.EvidenceDigest, "pending"}
	quote.State = "payout_pending"
	if e = put(k.Store, "external_bounty/"+t.ID, quote); e != nil {
		return "", e
	}
	if e = put(k.Store, "external_paid_work/"+v.ID, input.ID); e != nil {
		return "", e
	}
	return input.ID, put(k.Store, "external_payout/"+input.ID, intent)
}
func (k Keeper) attestExternalBounty(c Command, height int64) (string, error) {
	a, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var input struct {
		Intent         string `json:"intent"`
		Transaction    string `json:"transaction"`
		Index          string `json:"index"`
		Amount         string `json:"amount"`
		Target         string `json:"target"`
		Source         string `json:"source"`
		Block          string `json:"block"`
		BlockHash      string `json:"block_hash"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var intent ExternalPayoutIntent
	if e = get(k.Store, "external_payout/"+input.Intent, &intent); e != nil {
		return "", e
	}
	if intent.State != "pending" || input.Amount != intent.Amount || input.Target != intent.Address || input.Source != intent.Escrow || !digestPattern.MatchString(input.EvidenceDigest) || !fundingIndex.MatchString(input.Block) || input.Block == "0" {
		return "", errors.New("exact pending authorized payout transfer and finality required")
	}
	if e = verifyFrozenPayoutBinding(k, intent); e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e = get(k.Store, "funding_receipt/"+intent.Receipt, &receipt); e != nil {
		return "", e
	}
	if receipt.State != "confirmed" {
		return "", errors.New("payout funding receipt is not confirmed")
	}
	var campaign FundingCampaign
	if e = get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	if campaign.Network != intent.Network || campaign.Asset != intent.Asset || campaign.Escrow != intent.Escrow {
		return "", errors.New("payout escrow/asset changed")
	}
	if intent.Network == "solana:mainnet" {
		if !validExternalAddress("solana", input.BlockHash) {
			return "", errors.New("invalid Solana finalized checkpoint")
		}
	} else {
		if _, e = fundingReference(intent.Network, input.BlockHash, "0"); e != nil {
			return "", e
		}
	}
	block, _ := new(big.Int).SetString(input.Block, 10)
	included, _ := new(big.Int).SetString(receipt.Block, 10)
	if block.Cmp(included) < 0 {
		return "", errors.New("payout finality predates funding inclusion")
	}
	ref, e := fundingReference(intent.Network, input.Transaction, input.Index)
	if e != nil {
		return "", e
	}
	if k.Store.Get([]byte("external_transfer/"+ref)) != nil {
		var bind struct{ Kind, ID string }
		if e = get(k.Store, "external_transfer/"+ref, &bind); e != nil || bind.Kind != "payout" || bind.ID != intent.ID {
			return "", errors.New("external payout transfer already consumed")
		}
	}
	var quorum FundingQuorum
	key := "external_payout_quorum/" + intent.ID
	if k.Store.Get([]byte(key)) != nil {
		if e = get(k.Store, key, &quorum); e != nil {
			return "", e
		}
	}
	attestation := FundingAttestation{Receipt: intent.ID, Kind: "payout", Transaction: input.Transaction, Index: input.Index, Amount: input.Amount, Target: input.Target, Source: input.Source, Block: input.Block, BlockHash: input.BlockHash, EvidenceDigest: input.EvidenceDigest}
	effects := fundingEffects(attestation)
	if len(quorum.Observations) >= 2 || quorum.EffectsDigest != "" && quorum.EffectsDigest != effects {
		return "", errors.New("duplicate/conflicting payout finality observation")
	}
	// Recipient is additionally excluded even when different from payer or lead.
	exclude := append([]FundingObservation{}, quorum.Observations...)
	exclude = append(exclude, FundingObservation{Member: intent.Member})
	if e = k.fundingObserver(c, a, receipt, campaign, exclude); e != nil {
		return "", e
	}
	for _, old := range quorum.Observations {
		if e = k.fundingObserver(Command{Member: old.Member}, a, receipt, campaign, []FundingObservation{{Member: intent.Member}}); e != nil {
			return "", e
		}
		proof, e := k.OperatorProof(old.Member, "")
		if e != nil || proof == nil || proof.Domain != old.OperatorDomain {
			return "", errors.New("payout observer operator changed")
		}
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil {
		return "", e
	}
	quorum.EffectsDigest = effects
	quorum.Observations = append(quorum.Observations, FundingObservation{c.Member, proof.Domain, height, attestation})
	if e = put(k.Store, "external_transfer/"+ref, struct{ Kind, ID string }{"payout", intent.ID}); e != nil {
		return "", e
	}
	if len(quorum.Observations) == 2 {
		var pool economy.Pool
		if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
			return "", e
		}
		pool, e = pool.Pay("bounty", intent.Amount)
		if e != nil {
			return "", e
		}
		if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
			return "", e
		}
		var quote ExternalBountyQuote
		if e = get(k.Store, "external_bounty/"+intent.Task, &quote); e != nil {
			return "", e
		}
		if quote.State != "payout_pending" || quote.Receipt != intent.Receipt || quote.Amount != intent.Amount {
			return "", errors.New("payout quote mismatch")
		}
		quote.State = "paid"
		if e = put(k.Store, "external_bounty/"+intent.Task, quote); e != nil {
			return "", e
		}
		if e = k.debitTreasuryLiability(intent.Network, intent.Escrow, intent.Amount, "payout", intent.ID); e != nil {
			return "", e
		}
		intent.State = "paid"
		if e = put(k.Store, "external_payout/"+intent.ID, intent); e != nil {
			return "", e
		}
	}
	return intent.ID, put(k.Store, key, quorum)
}
func (k Keeper) releaseExternalBounty(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Task           string `json:"task"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	t, e := k.taskState(input.Task)
	if e != nil {
		return "", e
	}
	project, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	var quote ExternalBountyQuote
	if e = get(k.Store, "external_bounty/"+t.ID, &quote); e != nil {
		return "", e
	}
	unstarted := c.Member == project.Lead && c.Instance == "" && t.State == "open" && len(t.Submissions) == 0 && len(t.OpenChallenges) == 0
	terminal := k.guardian(c.Member) && c.Instance == "" && t.Winner == "" && (t.State == "kpi_unmet" || t.State == "kpi_expired" || t.PriorArtDecision != "")
	if k.guardian(c.Member) && c.Instance == "" && t.State == "settled" && t.Winner != "" && len(t.OpenChallenges) == 0 && k.Store.Get([]byte("external_paid_work/"+t.Winner)) == nil {
		winner, err := k.contributionState(t.Winner)
		if err != nil {
			return "", err
		}
		if winner.Task == t.ID && winner.State == "settled" && winner.Settlement != nil && winner.Settlement.Paid && winner.Settlement.Policy == CreditRewardPolicy {
			s := winner.Settlement
			terminal = s.FactorNumerator != 1 || s.FactorDenominator != 1 || s.IndependentOperators < 2 || !s.OtherFamily
		}
	}
	if quote.Task != t.ID || quote.State != "reserved" || (!unstarted && !terminal) || !digestPattern.MatchString(input.EvidenceDigest) {
		return "", errors.New("only unstarted or terminal unawarded external reservation may release")
	}
	var receipt FundingReceipt
	if e = get(k.Store, "funding_receipt/"+quote.Receipt, &receipt); e != nil {
		return "", e
	}
	if receipt.State != "confirmed" {
		return "", errors.New("funding is not confirmed")
	}
	var pool economy.Pool
	if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
		return "", e
	}
	pool, e = pool.Release("bounty", quote.Amount)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
		return "", e
	}
	quote.State = "released"
	return t.ID, put(k.Store, "external_bounty/"+t.ID, quote)
}

// Enforce that immutable payout bindings still carry the original verified
// wallet proof. A later profile unbind does not redirect an authorized intent.
func verifyFrozenPayoutBinding(k Keeper, intent ExternalPayoutIntent) error {
	if strings.HasPrefix(intent.Network, "fiat:") {
		if !strings.HasPrefix(intent.WalletBinding, "fiat/") {
			return errors.New("missing frozen bank beneficiary proof")
		}
		var bank FiatBeneficiary
		if err := get(k.Store, "fiat_beneficiary_proof/"+strings.TrimPrefix(intent.WalletBinding, "fiat/"), &bank); err != nil {
			return err
		}
		if bank.Member != intent.Member || bank.Network != intent.Network || bank.AccountDigest != intent.Address || "fiat/"+bank.ID != intent.WalletBinding {
			return errors.New("payout differs from immutable bank ownership proof")
		}
		return nil
	}
	var binding ExternalWalletBinding
	if e := get(k.Store, "external_wallet_binding/"+intent.WalletBinding, &binding); e != nil {
		return e
	}
	network := "ethereum"
	if intent.Network == "solana:mainnet" {
		network = "solana"
	}
	if binding.Policy != ExternalWalletPolicy || binding.Member != intent.Member || binding.Network != network || binding.Address != intent.Address || !binding.Active {
		return errors.New("payout binding differs from immutable ownership proof")
	}
	return nil
}
