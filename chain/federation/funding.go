package federation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/mr-tron/base58"
	"math"
	"math/big"
	"regexp"
	"strings"

	"github.com/uain-org/uain/chain/economy"
)

const FundingPolicy = "external-receipts-80-15-5-v1"

type FundingActivation struct {
	Policy         string   `json:"policy"`
	Height         int64    `json:"height,string"`
	Observers      []string `json:"observers"`
	EvidenceDigest string   `json:"evidence_digest"`
}
type FundingCampaign struct {
	ID             string `json:"id"`
	Project        string `json:"project"`
	Network        string `json:"network"`
	Asset          string `json:"asset"`
	Escrow         string `json:"escrow"`
	Decimals       int    `json:"decimals"`
	EvidenceDigest string `json:"evidence_digest"`
	Lead           string `json:"lead"`
	Height         int64  `json:"height,string"`
}
type FundingReceipt struct {
	ID             string `json:"id"`
	Campaign       string `json:"campaign"`
	Amount         string `json:"amount"`
	Transaction    string `json:"transaction"`
	Index          string `json:"index"`
	Source         string `json:"source"`
	Block          string `json:"block"`
	BlockHash      string `json:"block_hash"`
	EvidenceDigest string `json:"evidence_digest"`
	Payer          string `json:"payer"`
	Height         int64  `json:"height,string"`
	State          string `json:"state"`
}
type FundingAttestation struct {
	Receipt        string `json:"receipt"`
	Kind           string `json:"kind"`
	Transaction    string `json:"transaction"`
	Index          string `json:"index"`
	Amount         string `json:"amount"`
	Target         string `json:"target"`
	Source         string `json:"source"`
	Block          string `json:"block"`
	BlockHash      string `json:"block_hash"`
	EvidenceDigest string `json:"evidence_digest"`
}
type FundingObservation struct {
	Member         string             `json:"member"`
	OperatorDomain string             `json:"operator_domain"`
	Height         int64              `json:"height,string"`
	Attestation    FundingAttestation `json:"attestation"`
}
type FundingQuorum struct {
	EffectsDigest string               `json:"effects_digest"`
	Observations  []FundingObservation `json:"observations"`
}

var fundingHexAddress = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
var fundingEVMHash = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
var fundingBase58Address = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,44}$`)
var fundingSolanaTx = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{64,88}$`)
var fundingIndex = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})$`)

func fundingNetwork(s string) bool {
	return s == "ethereum:1" || s == "ethereum:8453" || s == "solana:mainnet" || s == "fiat:USD" || s == "fiat:EUR"
}
func fundingAddress(network, address string) bool {
	switch {
	case strings.HasPrefix(network, "ethereum:"):
		return fundingHexAddress.MatchString(address) && address != "0x"+strings.Repeat("0", 40)
	case network == "solana:mainnet":
		return validExternalAddress("solana", address)
	case strings.HasPrefix(network, "fiat:"):
		return digestPattern.MatchString(address)
	}
	return false
}
func fundingReference(network, transaction, index string) (string, error) {
	if !fundingIndex.MatchString(index) {
		return "", errors.New("canonical external transfer index required")
	}
	valid := false
	switch {
	case strings.HasPrefix(network, "ethereum:"):
		valid = fundingEVMHash.MatchString(transaction) && index == "0"
	case network == "solana:mainnet":
		valid = fundingSolanaTx.MatchString(transaction)
	case strings.HasPrefix(network, "fiat:"):
		valid = digestPattern.MatchString(transaction)
	}
	if !valid {
		return "", errors.New("canonical network transaction reference required")
	}
	b, _ := json.Marshal([]string{"UAIN/external-transfer/v1", network, transaction, index})
	d := sha256.Sum256(b)
	return hex.EncodeToString(d[:]), nil
}
func fundingEffects(a FundingAttestation) string {
	// Evidence documents may differ; both observers must independently confirm
	// the same actual transfer and finalized checkpoint, not one another's note.
	a.EvidenceDigest = ""
	b, _ := json.Marshal(a)
	d := sha256.Sum256(append([]byte("UAIN/funding-finality/v1\x00"), b...))
	return hex.EncodeToString(d[:])
}
func (k Keeper) activeFunding(height int64) (FundingActivation, error) {
	var a FundingActivation
	e := get(k.Store, "funding_activation", &a)
	if e != nil {
		return a, e
	}
	if a.Policy != FundingPolicy || a.Height < 2 || height < a.Height || len(a.Observers) < 2 || len(a.Observers) > 20 {
		return a, errors.New("prospective external funding policy is not active")
	}
	return k.EffectiveFundingObservers(a, height)
}
func (k Keeper) activateFunding(c Command, height int64) (string, error) {
	var a FundingActivation
	var p struct {
		Policy         string   `json:"policy"`
		EvidenceDigest string   `json:"evidence_digest"`
		Observers      []string `json:"observers"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	compact, e := k.CompactStorageActive(height)
	if e != nil {
		return "", e
	}
	operators, e := k.operatorRewardPolicy(height)
	if e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || p.Policy != FundingPolicy || !digestPattern.MatchString(p.EvidenceDigest) || height < 1 || height == math.MaxInt64 || !compact || operators != OperatorRewardPolicy || len(p.Observers) < 2 || len(p.Observers) > 20 || k.Store.Get([]byte("funding_activation")) != nil {
		return "", errors.New("reviewed bounded funding activation and operator policy required")
	}
	seen := map[string]bool{}
	for _, id := range p.Observers {
		m, e := k.Member(id)
		if e != nil || m.Licence != "active" || m.Karma < 100 || seen[id] {
			return "", errors.New("distinct active vetted high-standing observers required")
		}
		proof, e := k.OperatorProof(id, "")
		if e != nil || proof == nil {
			return "", errors.New("observed operator identities required")
		}
		seen[id] = true
	}
	a = FundingActivation{p.Policy, height + 1, p.Observers, p.EvidenceDigest}
	return p.Policy, put(k.Store, "funding_activation", a)
}
func (k Keeper) fundingCampaign(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var p FundingCampaign
	var input struct {
		ID             string `json:"id"`
		Project        string `json:"project"`
		Network        string `json:"network"`
		Asset          string `json:"asset"`
		Escrow         string `json:"escrow"`
		Decimals       int    `json:"decimals"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	project, e := k.Project(input.Project)
	if e != nil {
		return "", e
	}
	if !validID(input.ID) || project.Lead != c.Member || c.Instance != "" || project.State != "active" || project.SafetyHalted || !allowedClass(project.Class) || !fundingNetwork(input.Network) || input.Asset != "native" || !fundingAddress(input.Network, input.Escrow) || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("funding_campaign/"+input.ID)) != nil {
		return "", errors.New("active safe project, exact native asset/escrow and lead authority required")
	}
	decimals := 2
	if strings.HasPrefix(input.Network, "ethereum:") {
		decimals = 18
	}
	if input.Network == "solana:mainnet" {
		decimals = 9
	}
	if input.Decimals != decimals {
		return "", errors.New("native external currency denomination mismatch")
	}
	if _, e = k.TreasuryEscrow(input.Network, input.Escrow); e != nil {
		return "", e
	}
	p = FundingCampaign{input.ID, input.Project, input.Network, input.Asset, input.Escrow, input.Decimals, input.EvidenceDigest, c.Member, height}
	return p.ID, put(k.Store, "funding_campaign/"+p.ID, p)
}
func (k Keeper) fileFunding(c Command, height int64) (string, error) {
	return k.fileFundingSource(c, height, false)
}
func (k Keeper) fileFundingSource(c Command, height int64, human bool) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		ID             string `json:"id"`
		Campaign       string `json:"campaign"`
		Amount         string `json:"amount"`
		Transaction    string `json:"transaction"`
		Index          string `json:"index"`
		Source         string `json:"source"`
		Block          string `json:"block"`
		BlockHash      string `json:"block_hash"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e := get(k.Store, "funding_campaign/"+input.Campaign, &campaign); e != nil {
		return "", e
	}
	project, e := k.Project(campaign.Project)
	if e != nil {
		return "", e
	}
	if !validID(input.ID) || c.Instance != "" || !digestPattern.MatchString(input.EvidenceDigest) || !fundingAddress(campaign.Network, input.Source) || input.Source == campaign.Escrow || project.State != "active" || project.SafetyHalted || k.Store.Get([]byte("funding_receipt/"+input.ID)) != nil {
		return "", errors.New("new safe funding receipt and payer source required")
	}
	if human {
		// The only caller already verified wallet consent or independently
		// attested nonmember bank ownership plus that owner's consent.
	} else if strings.HasPrefix(campaign.Network, "fiat:") {
		bank, err := k.FiatBeneficiary(c.Member, campaign.Network)
		if err != nil || bank.AccountDigest != input.Source {
			return "", errors.New("fiat funding requires payer's independently verified bank source commitment")
		}
	} else {
		network := "ethereum"
		if campaign.Network == "solana:mainnet" {
			network = "solana"
		}
		wallet, err := k.ExternalWallet(c.Member, network)
		if err != nil || wallet.Address != input.Source {
			return "", errors.New("funding source must match payer's proved external wallet")
		}
	}
	if e = fundingAssetAmount(campaign.Network, input.Amount); e != nil {
		return "", e
	}
	if _, e = economy.Empty().Fund(input.Amount); e != nil {
		return "", e
	}
	if !fundingIndex.MatchString(input.Block) || input.Block == "0" {
		return "", errors.New("positive bounded external block required")
	}
	if _, e = fundingReference(campaign.Network, input.BlockHash, "0"); e != nil && !strings.HasPrefix(campaign.Network, "solana:") {
		return "", errors.New("external inclusion block hash required")
	}
	if campaign.Network == "solana:mainnet" && !validExternalAddress("solana", input.BlockHash) {
		return "", errors.New("Solana inclusion block hash required")
	}
	ref, e := fundingReference(campaign.Network, input.Transaction, input.Index)
	if e != nil {
		return "", e
	}
	if k.Store.Get([]byte("external_transfer/"+ref)) != nil {
		return "", errors.New("external transfer already filed")
	}
	receipt := FundingReceipt{input.ID, input.Campaign, input.Amount, input.Transaction, input.Index, input.Source, input.Block, input.BlockHash, input.EvidenceDigest, c.Member, height, "pending"}
	if !human {
		if e = k.allocateFundingReward(receipt, height); e != nil {
			return "", e
		}
	}
	if e = put(k.Store, "funding_campaign_filed/"+campaign.ID, true); e != nil {
		return "", e
	}
	if e = put(k.Store, "external_transfer/"+ref, struct{ Kind, ID string }{"funding", input.ID}); e != nil {
		return "", e
	}
	return input.ID, put(k.Store, "funding_receipt/"+input.ID, receipt)
}
func (k Keeper) fundingObserver(c Command, a FundingActivation, receipt FundingReceipt, campaign FundingCampaign, old []FundingObservation) error {
	allowed := false
	for _, id := range a.Observers {
		if id == c.Member {
			allowed = true
			break
		}
	}
	m, e := k.Member(c.Member)
	if e != nil {
		return e
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil {
		return e
	}
	if !allowed || c.Instance != "" || m.Licence != "active" || m.Karma < 100 || proof == nil {
		return errors.New("currently licensed appointed funding observer required")
	}
	if campaign.Network != "" {
		if e := k.independentFundingAddress(campaign.Network, receipt.Source, c.Member); e != nil {
			return e
		}
		if e := k.independentFundingAddress(campaign.Network, campaign.Escrow, c.Member); e != nil {
			return e
		}
	}
	// A relayed nonmember deposit remains independent of both native operators
	// and any observer who controls the original external payer wallet.
	if k.Store.Get([]byte("human_funding/"+receipt.ID)) != nil {
		var human HumanFundingRecord
		if err := get(k.Store, "human_funding/"+receipt.ID, &human); err != nil {
			return err
		}
		if human.Consent.Bank != "" {
			if e := k.independentFundingSource("fiat_bank_control", campaign.Network, receipt.Source, c.Member); e != nil {
				return e
			}
			bank, err := k.humanBank(human.Consent.Bank, false)
			if err != nil {
				return err
			}
			if e := k.independentFundingAddress("solana:mainnet", bank.OwnerPublicKey, c.Member); e != nil {
				return e
			}
		}

	}
	if campaign.Network != "" && campaign.Escrow != "" {
		escrow, e := k.TreasuryEscrow(campaign.Network, campaign.Escrow)
		if e != nil {
			return e
		}
		if e = k.independentFundingSource("treasury_escrow_control", campaign.Network, campaign.Escrow, c.Member); e != nil {
			return e
		}
		same, e := k.sameOperator(c.Member, "", escrow.Controller, "")
		if e != nil {
			return e
		}
		if same {
			return errors.New("treasury controller cannot confirm its own external effect")
		}
	}
	excluded := []string{receipt.Payer, campaign.Lead}
	if k.Store.Get([]byte("human_funding_refund/"+receipt.ID)) != nil {
		var relay string
		if err := get(k.Store, "human_funding_refund/"+receipt.ID, &relay); err != nil {
			return err
		}
		excluded = append(excluded, relay)
	}
	for _, o := range old {
		excluded = append(excluded, o.Member)
	}
	for _, id := range excluded {
		same, e := k.sameOperator(c.Member, "", id, "")
		if e != nil {
			return e
		}
		if same {
			return errors.New("funding observer must be independent of payer, lead and other observer")
		}
	}
	return nil
}
func (k Keeper) attestFunding(c Command, height int64) (string, error) {
	a, e := k.activeFunding(height)
	if e != nil {
		return "", e
	}
	var input FundingAttestation
	if e = Decode(c.Payload, &input); e != nil {
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
	project, e := k.Project(campaign.Project)
	if e != nil {
		return "", e
	}
	if input.Kind == "deposit" && (project.State != "active" || project.SafetyHalted || !allowedClass(project.Class)) {
		return "", errors.New("funding confirmation requires a currently safe active project")
	}
	if input.Kind != "deposit" && input.Kind != "refund" {
		return "", errors.New("unknown funding attestation kind")
	}
	if input.Amount != receipt.Amount || !digestPattern.MatchString(input.EvidenceDigest) || !fundingIndex.MatchString(input.Block) || input.Block == "0" {
		return "", errors.New("exact transfer amount, finalized checkpoint and evidence required")
	}
	block, _ := new(big.Int).SetString(input.Block, 10)
	included, _ := new(big.Int).SetString(receipt.Block, 10)
	if block.Cmp(included) < 0 {
		return "", errors.New("finality checkpoint predates original inclusion")
	}
	if campaign.Network == "solana:mainnet" {
		if !validExternalAddress("solana", input.BlockHash) {
			return "", errors.New("invalid Solana finalized block hash")
		}
	} else {
		if _, e = fundingReference(campaign.Network, input.BlockHash, "0"); e != nil {
			return "", e
		}
	}
	ref, e := fundingReference(campaign.Network, input.Transaction, input.Index)
	if e != nil {
		return "", e
	}
	expectedState := "pending"
	if input.Kind == "refund" {
		expectedState = "refund_pending"
	}
	if receipt.State != expectedState {
		return "", errors.New("funding receipt is not awaiting this finality action")
	}
	if input.Kind == "deposit" {
		if input.Transaction != receipt.Transaction || input.Index != receipt.Index || input.Target != campaign.Escrow || input.Source != receipt.Source || input.Block != receipt.Block || input.BlockHash != receipt.BlockHash {
			return "", errors.New("deposit attestation differs from filed transfer")
		}
	}
	if input.Kind == "refund" {
		if input.Target != receipt.Source || input.Transaction == receipt.Transaction || input.Source != campaign.Escrow {
			return "", errors.New("refund must return exactly to original payer source using a new transfer")
		}
		if existing := k.Store.Get([]byte("external_transfer/" + ref)); existing != nil {
			var bind struct{ Kind, ID string }
			if e = json.Unmarshal(existing, &bind); e != nil || bind.Kind != "refund" || bind.ID != receipt.ID {
				return "", errors.New("external refund transfer already used")
			}
		}
	}
	key := "funding_quorum/" + receipt.ID + "/" + input.Kind
	quorum := FundingQuorum{}
	if k.Store.Get([]byte(key)) != nil {
		if e = get(k.Store, key, &quorum); e != nil {
			return "", e
		}
	}
	effects := fundingEffects(input)
	if len(quorum.Observations) >= 2 || quorum.EffectsDigest != "" && quorum.EffectsDigest != effects {
		return "", errors.New("duplicate or conflicting finalized transfer observation")
	}
	if e = k.fundingObserver(c, a, receipt, campaign, quorum.Observations); e != nil {
		return "", e
	}
	// Revalidate the first observer at execution of the second signature. Licence,
	// appointment, domain or standing changes cannot preserve a stale quorum.
	for _, old := range quorum.Observations {
		if e = k.fundingObserver(Command{Member: old.Member}, a, receipt, campaign, nil); e != nil {
			return "", e
		}
		proof, e := k.OperatorProof(old.Member, "")
		if e != nil || proof == nil || proof.Domain != old.OperatorDomain {
			return "", errors.New("funding observer domain changed; new receipt review required")
		}
	}
	proof, e := k.OperatorProof(c.Member, "")
	if e != nil {
		return "", e
	}
	quorum.EffectsDigest = effects
	quorum.Observations = append(quorum.Observations, FundingObservation{c.Member, proof.Domain, height, input})
	if input.Kind == "refund" {
		if e = put(k.Store, "external_transfer/"+ref, struct{ Kind, ID string }{"refund", receipt.ID}); e != nil {
			return "", e
		}
	}
	if len(quorum.Observations) == 2 {
		if input.Kind == "deposit" {
			pool, e := economy.Empty().Fund(receipt.Amount)
			if e != nil {
				return "", e
			}
			if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
				return "", e
			}
			if e = k.creditTreasuryLiability(campaign, receipt); e != nil {
				return "", e
			}
			receipt.State = "confirmed"
			if e = k.queueDividendSnapshot(receipt, height); e != nil {
				return "", e
			}
		} else {
			var pool economy.Pool
			if e = get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
				return "", e
			}
			pool, e = pool.Refund(receipt.Amount)
			if e != nil {
				return "", e
			}
			if e = put(k.Store, "funding_pool/"+receipt.ID, pool); e != nil {
				return "", e
			}
			if e = k.debitTreasuryLiability(campaign.Network, campaign.Escrow, receipt.Amount, "refund", receipt.ID); e != nil {
				return "", e
			}
			receipt.State = "refunded"
		}
		if e = put(k.Store, "funding_receipt/"+receipt.ID, receipt); e != nil {
			return "", e
		}
	}
	return receipt.ID, put(k.Store, key, quorum)
}
func (k Keeper) refundFunding(c Command, height int64) (string, error) {
	return k.refundFundingSource(c, height, false)
}
func (k Keeper) refundFundingSource(c Command, height int64, human bool) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Receipt        string `json:"receipt"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e := get(k.Store, "funding_receipt/"+input.Receipt, &receipt); e != nil {
		return "", e
	}
	if human != (k.Store.Get([]byte("human_funding/"+receipt.ID)) != nil) || !human && c.Member != receipt.Payer || c.Instance != "" || receipt.State != "confirmed" || !digestPattern.MatchString(input.EvidenceDigest) || k.Store.Get([]byte("funding_reward/"+receipt.ID)) != nil {
		return "", errors.New("only unconsumed original funding may enter refund review")
	}
	var pool economy.Pool
	if e := get(k.Store, "funding_pool/"+receipt.ID, &pool); e != nil {
		return "", e
	}
	if _, e := pool.Refund(receipt.Amount); e != nil {
		return "", e
	}
	if e := k.releaseFundingRewardSlot(receipt); e != nil {
		return "", e
	}
	receipt.State = "refund_pending"
	if e := put(k.Store, "funding_refund_request/"+receipt.ID, struct {
		Member, EvidenceDigest string
		Height                 int64
	}{c.Member, input.EvidenceDigest, height}); e != nil {
		return "", e
	}
	return receipt.ID, put(k.Store, "funding_receipt/"+receipt.ID, receipt)
}

func base58PublicKey(encoded string) string {
	b, e := base64.RawURLEncoding.DecodeString(encoded)
	if e != nil {
		return ""
	}
	return base58.Encode(b)
}
