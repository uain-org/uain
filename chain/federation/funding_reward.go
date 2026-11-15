package federation

import (
	"errors"
	"math/big"
	"time"

	"github.com/uain-org/uain/chain/coin"
)

const FundingRewardPolicy = "verified-funding-bounties-v1"

// No exchange rate or Karma rate is invented by consensus. The guardian's
// prospective, evidence-bound bounty schedule supplies exact prices and cap.
type FundingRewardSchedule struct {
	Policy             string `json:"policy"`
	Campaign           string `json:"campaign"`
	FundingAmount      string `json:"funding_amount"`
	CoinUnits          string `json:"coin_units"`
	Karma              int64  `json:"karma,string"`
	MaxClaims          uint32 `json:"max_claims"`
	Allocated          uint32 `json:"allocated"`
	Claimed            uint32 `json:"claimed"`
	FirstExternalBlock string `json:"first_external_block"`
	EvidenceDigest     string `json:"evidence_digest"`
	Height             int64  `json:"height,string"`
	State              string `json:"state"`
}
type FundingRewardSlot struct {
	Receipt   string `json:"receipt"`
	Campaign  string `json:"campaign"`
	Member    string `json:"member"`
	CoinUnits string `json:"coin_units"`
	Karma     int64  `json:"karma,string"`
	Height    int64  `json:"height,string"`
	State     string `json:"state"`
}

func (k Keeper) scheduleFundingReward(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	if _, e := k.activeCoin(height); e != nil {
		return "", e
	}
	var input struct {
		Policy             string `json:"policy"`
		Campaign           string `json:"campaign"`
		FundingAmount      string `json:"funding_amount"`
		CoinUnits          string `json:"coin_units"`
		Karma              int64  `json:"karma,string"`
		MaxClaims          uint32 `json:"max_claims"`
		FirstExternalBlock string `json:"first_external_block"`
		EvidenceDigest     string `json:"evidence_digest"`
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
	if e = k.centralQuoteGuard(project.ID, height); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || input.Policy != FundingRewardPolicy || !digestPattern.MatchString(input.EvidenceDigest) || input.Karma < 1 || input.Karma > 100 || input.MaxClaims < 1 || input.MaxClaims > 1024 || !fundingIndex.MatchString(input.FirstExternalBlock) || input.FirstExternalBlock == "0" || project.State != "active" || project.SafetyHalted || !allowedClass(project.Class) || k.Store.Get([]byte("funding_reward_schedule/"+campaign.ID)) != nil || k.Store.Get([]byte("funding_campaign_filed/"+campaign.ID)) != nil {
		return "", errors.New("prospective reviewed guardian funding bounty schedule required before all receipts")
	}
	if _, e := coin.Empty().Reserve(input.CoinUnits); e != nil {
		return "", e
	}
	if _, e := economyPositive(input.FundingAmount); e != nil {
		return "", e
	}
	units, _ := new(big.Int).SetString(input.CoinUnits, 10)
	total := new(big.Int).Mul(units, new(big.Int).SetUint64(uint64(input.MaxClaims)))
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	ledger, e = ledger.Reserve(total.String())
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_supply", ledger); e != nil {
		return "", e
	}
	schedule := FundingRewardSchedule{Policy: FundingRewardPolicy, Campaign: campaign.ID, FundingAmount: input.FundingAmount, CoinUnits: input.CoinUnits, Karma: input.Karma, MaxClaims: input.MaxClaims, FirstExternalBlock: input.FirstExternalBlock, EvidenceDigest: input.EvidenceDigest, Height: height, State: "active"}
	if e = put(k.Store, "funding_reward_terms/"+campaign.ID, schedule); e != nil {
		return "", e
	}
	if e = k.indexProjectFinance(campaign.Project); e != nil {
		return "", e
	}
	return campaign.ID, put(k.Store, "funding_reward_schedule/"+campaign.ID, schedule)
}
func economyPositive(s string) (*big.Int, error) {
	n, e := money(s)
	if e != nil {
		return nil, e
	}
	if n.Sign() <= 0 {
		return nil, errors.New("positive funding amount required")
	}
	return n, nil
}

// Filing reserves one slot but never creates Coin. False/unconfirmed transfers
// cannot receive money or Karma; refund/forfeit releases only their own slot.
func (k Keeper) allocateFundingReward(receipt FundingReceipt, height int64) error {
	key := "funding_reward_schedule/" + receipt.Campaign
	if k.Store.Get([]byte(key)) == nil {
		return nil
	}
	var schedule FundingRewardSchedule
	if e := get(k.Store, key, &schedule); e != nil {
		return e
	}
	if schedule.State != "active" || schedule.Policy != FundingRewardPolicy || schedule.Campaign != receipt.Campaign || schedule.Allocated >= schedule.MaxClaims || height <= schedule.Height || receipt.Amount != schedule.FundingAmount {
		return errors.New("funding receipt does not meet prospective priced bounty capacity")
	}
	included, _ := new(big.Int).SetString(receipt.Block, 10)
	first, _ := new(big.Int).SetString(schedule.FirstExternalBlock, 10)
	if included == nil || first == nil || included.Cmp(first) < 0 {
		return errors.New("funding predates prospective external funding checkpoint")
	}
	schedule.Allocated++
	if e := put(k.Store, key, schedule); e != nil {
		return e
	}
	return put(k.Store, "funding_reward_slot/"+receipt.ID, FundingRewardSlot{receipt.ID, receipt.Campaign, receipt.Payer, schedule.CoinUnits, schedule.Karma, height, "reserved"})
}
func (k Keeper) claimFundingReward(c Command, height int64, now time.Time) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	if _, e := k.activeCoin(height); e != nil {
		return "", e
	}
	var input struct {
		Receipt string `json:"receipt"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var receipt FundingReceipt
	if e := get(k.Store, "funding_receipt/"+input.Receipt, &receipt); e != nil {
		return "", e
	}
	var slot FundingRewardSlot
	if e := get(k.Store, "funding_reward_slot/"+receipt.ID, &slot); e != nil {
		return "", e
	}
	var schedule FundingRewardSchedule
	if e := get(k.Store, "funding_reward_schedule/"+receipt.Campaign, &schedule); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e := get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	project, e := k.Project(campaign.Project)
	if e != nil {
		return "", e
	}
	if c.Instance != "" || receipt.Payer != c.Member || receipt.State != "confirmed" || slot.Receipt != receipt.ID || slot.Campaign != receipt.Campaign || slot.Member != c.Member || slot.State != "reserved" || slot.CoinUnits != schedule.CoinUnits || slot.Karma != schedule.Karma || schedule.Policy != FundingRewardPolicy || schedule.Claimed >= schedule.Allocated || schedule.Allocated > schedule.MaxClaims || project.SafetyHalted || !allowedClass(project.Class) || k.Store.Get([]byte("funding_reward/"+receipt.ID)) != nil {
		return "", errors.New("only original licensed payer of independently confirmed reserved funding may claim")
	}
	var quorum FundingQuorum
	if e = get(k.Store, "funding_quorum/"+receipt.ID+"/deposit", &quorum); e != nil {
		return "", e
	}
	if len(quorum.Observations) != 2 {
		return "", errors.New("funding finality quorum absent")
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	ledger, e = ledger.Mint(slot.CoinUnits)
	if e != nil {
		return "", e
	}
	balance := "0"
	if k.Store.Get([]byte("coin_balance/"+c.Member)) != nil {
		if e = get(k.Store, "coin_balance/"+c.Member, &balance); e != nil {
			return "", e
		}
	}
	if e = (coin.Ledger{Minted: balance, Reserved: "0", Transparent: balance, Shielded: "0"}).Validate(); e != nil {
		return "", e
	}
	old, _ := new(big.Int).SetString(balance, 10)
	award, _ := new(big.Int).SetString(slot.CoinUnits, 10)
	balance = old.Add(old, award).String()
	if e = k.recordKarma(c.Member, "", slot.Karma, "funding_bounty", receipt.ID, now); e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_supply", ledger); e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_balance/"+c.Member, balance); e != nil {
		return "", e
	}
	slot.State = "paid"
	schedule.Claimed++
	if e = put(k.Store, "funding_reward_slot/"+receipt.ID, slot); e != nil {
		return "", e
	}
	if e = put(k.Store, "funding_reward_schedule/"+receipt.Campaign, schedule); e != nil {
		return "", e
	}
	return receipt.ID, put(k.Store, "funding_reward/"+receipt.ID, struct {
		FundingRewardSlot
		Height int64 `json:"claimed_height,string"`
	}{slot, height})
}
func (k Keeper) forfeitFundingReward(c Command, height int64) (string, error) {
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
	if c.Member != receipt.Payer || c.Instance != "" || !digestPattern.MatchString(input.EvidenceDigest) {
		return "", errors.New("only original payer may surrender unearned funding reward")
	}
	var slot FundingRewardSlot
	if e := get(k.Store, "funding_reward_slot/"+receipt.ID, &slot); e != nil {
		return "", e
	}
	if slot.State != "reserved" {
		return "", errors.New("funding reward is not an unearned reservation")
	}
	if e := k.releaseFundingRewardSlot(receipt); e != nil {
		return "", e
	}
	return receipt.ID, put(k.Store, "funding_reward_forfeit/"+receipt.ID, struct {
		Height         int64  `json:"height,string"`
		EvidenceDigest string `json:"evidence_digest"`
	}{height, input.EvidenceDigest})
}
func (k Keeper) releaseFundingRewardSlot(receipt FundingReceipt) error {
	key := "funding_reward_slot/" + receipt.ID
	if k.Store.Get([]byte(key)) == nil {
		return nil
	}
	var slot FundingRewardSlot
	if e := get(k.Store, key, &slot); e != nil {
		return e
	}
	if slot.Receipt != receipt.ID || slot.Member != receipt.Payer || slot.Campaign != receipt.Campaign {
		return errors.New("funding reward original reservation mismatch")
	}
	if slot.State == "forfeited" {
		return nil
	}
	if slot.State != "reserved" {
		return errors.New("funding reward already earned")
	}

	ledger, e := k.coinLedger()
	if e != nil {
		return e
	}
	ledger, e = ledger.Release(slot.CoinUnits)
	if e != nil {
		return e
	}
	slot.State = "forfeited"
	if e = put(k.Store, "coin_supply", ledger); e != nil {
		return e
	}
	return put(k.Store, key, slot)
}

// Closing a schedule releases only slots never assigned to a payer. Existing
// unearned or earned claimant reservations survive unchanged.
func (k Keeper) releaseFundingReward(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Campaign       string `json:"campaign"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var schedule FundingRewardSchedule
	key := "funding_reward_schedule/" + input.Campaign
	if e := get(k.Store, key, &schedule); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || schedule.Campaign != input.Campaign || schedule.Policy != FundingRewardPolicy || schedule.State != "active" || schedule.Allocated > schedule.MaxClaims || !digestPattern.MatchString(input.EvidenceDigest) {
		return "", errors.New("guardian may close only an active funding reward schedule")
	}
	remaining := schedule.MaxClaims - schedule.Allocated
	if remaining > 0 {
		units, _ := new(big.Int).SetString(schedule.CoinUnits, 10)
		if units == nil {
			return "", errors.New("invalid funding reward units")
		}
		units.Mul(units, new(big.Int).SetUint64(uint64(remaining)))
		ledger, e := k.coinLedger()
		if e != nil {
			return "", e
		}
		ledger, e = ledger.Release(units.String())
		if e != nil {
			return "", e
		}
		if e = put(k.Store, "coin_supply", ledger); e != nil {
			return "", e
		}
	}
	schedule.State = "closed"
	if e := put(k.Store, key, schedule); e != nil {
		return "", e
	}
	return input.Campaign, put(k.Store, "funding_reward_closed/"+input.Campaign, struct {
		Height         int64  `json:"height,string"`
		EvidenceDigest string `json:"evidence_digest"`
	}{height, input.EvidenceDigest})
}
