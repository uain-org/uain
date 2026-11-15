package federation

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"

	"github.com/uain-org/uain/chain/coin"
	shield "github.com/uain-org/uain/chain/privateexchange"
)

const CoinPolicy = "verified-bounties-108t-micro-v1"

type CoinActivation struct {
	Policy         string `json:"policy"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
}
type CoinQuote struct {
	Task           string `json:"task"`
	OpenEvent      string `json:"open_event"`
	Amount         string `json:"amount"`
	Manager        string `json:"manager"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
}
type CoinReservation struct {
	Task           string `json:"task"`
	Amount         string `json:"amount"`
	Height         int64  `json:"height,string"`
	State          string `json:"state"`
	EvidenceDigest string `json:"evidence_digest"`
}

func (k Keeper) activeCoin(height int64) (CoinActivation, error) {
	var activation CoinActivation
	if e := get(k.Store, "coin_activation", &activation); e != nil {
		return activation, e
	}
	if activation.Policy != CoinPolicy || activation.Height < 2 || height < activation.Height {
		return activation, errors.New("prospective Coin policy is not active")
	}
	return activation, nil
}
func (k Keeper) coinLedger() (coin.Ledger, error) {
	var ledger coin.Ledger
	if e := get(k.Store, "coin_supply", &ledger); e != nil {
		return ledger, e
	}
	return ledger, ledger.Validate()
}
func (k Keeper) activateCoin(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("reviewed guardian Coin activation required")
	}
	if !shield.Available() {
		return "", shield.ErrUnavailable
	}
	var input struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if input.Policy != CoinPolicy || !digestPattern.MatchString(input.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("coin_activation")) != nil || k.Store.Get([]byte("coin_supply")) != nil {
		return "", errors.New("invalid or duplicate Coin activation")
	}
	compact, e := k.CompactStorageActive(height)
	if e != nil || !compact {
		return "", errors.New("Coin requires bounded storage")
	}
	operators, e := k.operatorRewardPolicy(height)
	if e != nil || operators != OperatorRewardPolicy {
		return "", errors.New("Coin requires the prospective operator-independence policy")
	}
	membership, e := k.membershipPolicy(height)
	if e != nil || membership != MembershipPolicy {
		return "", errors.New("Coin requires prospective membership and prior-art challenges")
	}
	var private PrivateActivation
	var frontier PrivateFrontier
	if e = get(k.Store, "private_activation", &private); e != nil {
		return "", e
	}
	if e = get(k.Store, "private_frontier", &frontier); e != nil {
		return "", e
	}
	if private.Policy != PrivateExchangePolicy || private.Height < 2 || private.Height > height+1 || frontier.Count != 0 {
		return "", errors.New("Coin starts only with an empty private pool active by its activation height")
	}
	if e = put(k.Store, "coin_supply", coin.Empty()); e != nil {
		return "", e
	}
	return CoinPolicy, put(k.Store, "coin_activation", CoinActivation{CoinPolicy, height + 1, input.EvidenceDigest})
}

var coinEventID = regexp.MustCompile(`^[0-9]{20}$`)

// A genuine signed task-opening event after activation establishes eligibility
// without adding a read/write or changing serialization of any old operation.
func (k Keeper) quoteCoin(c Command, height int64) (string, error) {
	activation, e := k.activeCoin(height)
	if e != nil {
		return "", e
	}
	var input struct {
		Task           string `json:"task"`
		OpenEvent      string `json:"open_event"`
		Amount         string `json:"amount"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if !coinEventID.MatchString(input.OpenEvent) || !digestPattern.MatchString(input.EvidenceDigest) {
		return "", errors.New("signed opening event and pricing evidence required")
	}
	eventID, e := strconv.ParseUint(input.OpenEvent, 10, 64)
	if e != nil || eventID == 0 || fmt.Sprintf("%020d", eventID) != input.OpenEvent {
		return "", errors.New("invalid task-opening event")
	}
	t, e := k.taskState(input.Task)
	if e != nil {
		return "", e
	}
	p, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if e = k.centralQuoteGuard(p.ID, height); e != nil {
		return "", e
	}
	var opened Event
	if e = get(k.Store, "event/"+input.OpenEvent, &opened); e != nil {
		return "", e
	}
	if p.Lead != c.Member || p.OperatorPolicy != OperatorRewardPolicy || p.MembershipPolicy != MembershipPolicy || p.State != "active" || p.SafetyHalted || t.State != "open" || t.RewardPolicy != CreditRewardPolicy || t.StoragePolicy != CompactStatePolicy || t.Winner != "" || len(t.Submissions) != 0 || len(t.OpenChallenges) != 0 || opened.ID != eventID || opened.Height < activation.Height || opened.Height > height || opened.Operation != "open_task" || opened.Subject != t.ID || opened.Member != p.Lead || opened.Origin != "" || !digestPattern.MatchString(opened.CommandDigest) || k.Store.Get([]byte("coin_quote/"+t.ID)) != nil || (k.consensusV2() && t.VerifiersRequired < 2) {
		return "", errors.New("prospective unstarted task, authorized price and native opening event required")
	}
	if e = k.requireParticipation(p, c); e != nil {
		return "", e
	}
	if _, e = coin.Empty().Reserve(input.Amount); e != nil {
		return "", e
	}
	if e = k.indexProjectFinance(p.ID); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "coin_quote/"+t.ID, CoinQuote{t.ID, input.OpenEvent, input.Amount, c.Member, height, input.EvidenceDigest})
}

func (k Keeper) reserveCoin(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian Coin allocation required")
	}
	if _, e := k.activeCoin(height); e != nil {
		return "", e
	}
	var input struct {
		Task           string `json:"task"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var quote CoinQuote
	if e := get(k.Store, "coin_quote/"+input.Task, &quote); e != nil {
		return "", e
	}
	t, e := k.taskState(input.Task)
	if e != nil {
		return "", e
	}
	p, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	if !digestPattern.MatchString(input.EvidenceDigest) || quote.Task != t.ID || quote.Manager != p.Lead || p.State != "active" || p.SafetyHalted || t.State != "open" || t.Winner != "" || len(t.Submissions) != 0 || len(t.OpenChallenges) != 0 || k.Store.Get([]byte("coin_reservation/"+t.ID)) != nil || (k.consensusV2() && t.VerifiersRequired < 2) {
		return "", errors.New("Coin allocation must precede submissions, cannot repeat and needs two verifiers")
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	next, e := ledger.Reserve(quote.Amount)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_supply", next); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "coin_reservation/"+t.ID, CoinReservation{t.ID, quote.Amount, height, "reserved", input.EvidenceDigest})
}

func (k Keeper) claimCoin(c Command, height int64) (string, error) {
	if _, e := k.activeCoin(height); e != nil {
		return "", e
	}
	var input struct {
		Contribution string `json:"contribution"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	v, e := k.contributionState(input.Contribution)
	if e != nil {
		return "", e
	}
	// Class is in authenticated compact metadata, not the raw execution row.
	t, e := k.Task(v.Task)
	if e != nil {
		return "", e
	}
	p, e := k.Project(t.Project)
	if e != nil {
		return "", e
	}
	var reservation CoinReservation
	if e = get(k.Store, "coin_reservation/"+t.ID, &reservation); e != nil {
		return "", e
	}
	if v.Author != c.Member || v.State != "settled" || v.AwardWithheld != "" || t.State != "settled" || t.PriorArtDecision != "" || t.Winner != v.ID || len(t.OpenChallenges) != 0 || p.OperatorPolicy != OperatorRewardPolicy || p.SafetyHalted || !allowedClass(p.Class) || !allowedClass(t.Class) || reservation.Task != t.ID || reservation.State != "reserved" || v.Settlement == nil || !v.Settlement.Paid || v.Settlement.Policy != CreditRewardPolicy || v.Settlement.FactorNumerator != 1 || v.Settlement.FactorDenominator != 1 || v.Settlement.IndependentOperators < 2 || !v.Settlement.OtherFamily || t.VerifiersRequired < 2 || k.Store.Get([]byte("coin_reward/"+v.ID)) != nil {
		return "", errors.New("only the licensed winner of a fully verified new reserved bounty may claim Coin")
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
			return "", errors.New("Coin requires independently confirmed new work")
		}
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	next, e := ledger.Mint(reservation.Amount)
	if e != nil {
		return "", e
	}
	balance := "0"
	if k.Store.Get([]byte("coin_balance/"+v.Author)) != nil {
		if e = get(k.Store, "coin_balance/"+v.Author, &balance); e != nil {
			return "", e
		}
	}
	if e = (coin.Ledger{Minted: balance, Reserved: "0", Transparent: balance, Shielded: "0"}).Validate(); e != nil {
		return "", e
	}
	old, _ := new(big.Int).SetString(balance, 10)
	award, _ := new(big.Int).SetString(reservation.Amount, 10)
	balance = old.Add(old, award).String()
	if e = put(k.Store, "coin_supply", next); e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_balance/"+v.Author, balance); e != nil {
		return "", e
	}
	reservation.State = "paid"
	if e = put(k.Store, "coin_reservation/"+t.ID, reservation); e != nil {
		return "", e
	}
	return v.ID, put(k.Store, "coin_reward/"+v.ID, struct {
		Contribution string `json:"contribution"`
		Task         string `json:"task"`
		Member       string `json:"member"`
		Instance     string `json:"instance,omitempty"`
		Amount       string `json:"amount"`
		Height       int64  `json:"height,string"`
	}{v.ID, t.ID, v.Author, v.AuthorInstance, reservation.Amount, height})
}

// A project lead may surrender an unstarted allocation. A guardian can reclaim
// only a terminal, unawarded KPI allocation. Neither can remove a pending or
// completed winner's bounty. The immutable quote cannot be allocated again.
func (k Keeper) releaseCoin(c Command, height int64) (string, error) {
	if _, e := k.activeCoin(height); e != nil {
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
	p, e := k.projectState(t.Project)
	if e != nil {
		return "", e
	}
	var reservation CoinReservation
	if e = get(k.Store, "coin_reservation/"+t.ID, &reservation); e != nil {
		return "", e
	}
	unstarted := c.Member == p.Lead && t.State == "open" && t.Winner == "" && len(t.Submissions) == 0
	expired := k.guardian(c.Member) && t.Winner == "" && t.Kind == "future" && (t.State == "kpi_expired" || t.State == "kpi_unmet")
	known := k.guardian(c.Member) && t.State == "known" && t.PriorArtDecision != ""
	// A reservation no claim can ever spend is returned to supply (audit 9 Nov
	// 2026): a winner settled below full verification (the 3/5 factor, one
	// operator or one family) or withheld, a halted or closed project, or a
	// task whose submission limit is exhausted with no live candidate.
	authority := k.consensusV2() && (c.Member == p.Lead || k.guardian(c.Member))
	unclaimable := false
	if authority && t.State == "settled" && t.Winner != "" && k.Store.Get([]byte("coin_reward/"+t.Winner)) == nil {
		winner, err := k.contributionState(t.Winner)
		if err != nil {
			return "", err
		}
		if winner.Task == t.ID {
			s := winner.Settlement
			unclaimable = winner.AwardWithheld != "" || winner.State != "settled" || s == nil || !s.Paid || s.Policy != CreditRewardPolicy || s.FactorNumerator != 1 || s.FactorDenominator != 1 || s.IndependentOperators < 2 || !s.OtherFamily || t.VerifiersRequired < 2
		}
	}
	if authority && t.Winner == "" && (p.SafetyHalted || p.State != "active") {
		unclaimable = true
	}
	if authority && t.Winner == "" && t.State == "open" && len(t.Submissions) >= 20 {
		live := false
		for _, id := range t.Submissions {
			v, err := k.contributionState(id)
			if err != nil {
				return "", err
			}
			if v.State != "rejected" && v.State != "withheld" {
				live = true
			}
		}
		unclaimable = !live
	}
	if !digestPattern.MatchString(input.EvidenceDigest) || reservation.Task != t.ID || reservation.State != "reserved" || len(t.OpenChallenges) != 0 || (!unstarted && !expired && !known && !unclaimable) {
		return "", errors.New("only an unstarted lead allocation or terminal unawarded KPI allocation may be released")
	}
	if unstarted {
		if e = k.requireParticipation(p, c); e != nil {
			return "", e
		}
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	next, e := ledger.Release(reservation.Amount)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_supply", next); e != nil {
		return "", e
	}
	reservation.State = "released"
	if e = put(k.Store, "coin_reservation/"+t.ID, reservation); e != nil {
		return "", e
	}
	return t.ID, put(k.Store, "coin_release/"+t.ID, struct {
		Member         string `json:"member"`
		Height         int64  `json:"height,string"`
		EvidenceDigest string `json:"evidence_digest"`
	}{c.Member, height, input.EvidenceDigest})
}
