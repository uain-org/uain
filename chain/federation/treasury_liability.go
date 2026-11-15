package federation

import (
	"errors"
	"math/big"
	"regexp"
	"strings"
)

// TreasuryLiability sums all confirmed receipt obligations for one escrow.
// Pool reservations and confidential claims never change this public total.
type TreasuryLiability struct {
	Network     string `json:"network"`
	Escrow      string `json:"escrow"`
	Funded      string `json:"funded"`
	Paid        string `json:"paid"`
	Refunded    string `json:"refunded"`
	Outstanding string `json:"outstanding"`
}

type treasuryEffect struct {
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Network string `json:"network"`
	Escrow  string `json:"escrow"`
	Amount  string `json:"amount"`
}

var treasuryAmountPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)

func treasuryAmount(amount string) (*big.Int, error) {
	if !treasuryAmountPattern.MatchString(amount) {
		return nil, errors.New("canonical bounded atomic units required")
	}
	n, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return nil, errors.New("invalid treasury amount")
	}
	return n, nil
}
func fundingAssetAmount(network, amount string) error {
	if !fundingNetwork(network) {
		return errors.New("unsupported external asset")
	}
	n, e := treasuryAmount(amount)
	if e != nil {
		return e
	}
	switch {
	case strings.HasPrefix(network, "ethereum:"):
		if n.BitLen() > 256 {
			return errors.New("native EVM value exceeds uint256")
		}
	case network == "solana:mainnet":
		if n.BitLen() > 64 {
			return errors.New("native SOL value exceeds uint64")
		}
	}
	return nil
}
func (k Keeper) TreasuryLiability(network, escrow string) (TreasuryLiability, error) {
	var state TreasuryLiability
	if !fundingNetwork(network) || !fundingAddress(network, escrow) {
		return state, errors.New("canonical supported treasury escrow required")
	}
	key := "treasury_liability/" + network + "/" + escrow
	if k.Store.Get([]byte(key)) == nil {
		return TreasuryLiability{network, escrow, "0", "0", "0", "0"}, nil
	}
	if e := get(k.Store, key, &state); e != nil {
		return state, e
	}
	if state.Network != network || state.Escrow != escrow {
		return state, errors.New("treasury liability identity mismatch")
	}
	values := make([]*big.Int, 4)
	for i, s := range []string{state.Funded, state.Paid, state.Refunded, state.Outstanding} {
		var e error
		values[i], e = treasuryAmount(s)
		if e != nil {
			return state, e
		}
	}
	sum := new(big.Int).Add(values[1], values[2])
	sum.Add(sum, values[3])
	if sum.Cmp(values[0]) != 0 {
		return state, errors.New("treasury liability conservation failure")
	}
	if e := fundingAssetAmount(network, state.Outstanding); e != nil {
		return state, e
	}
	return state, nil
}
func (k Keeper) creditTreasuryLiability(campaign FundingCampaign, receipt FundingReceipt) error {
	return k.changeTreasuryLiability(campaign.Network, campaign.Escrow, receipt.Amount, "deposit", receipt.ID)
}
func (k Keeper) debitTreasuryLiability(network, escrow, amount, kind, id string) error {
	if kind != "payout" && kind != "refund" && kind != "dividend" && kind != "operations" {
		return errors.New("finalized outgoing liability kind required")
	}
	return k.changeTreasuryLiability(network, escrow, amount, kind, id)
}
func (k Keeper) changeTreasuryLiability(network, escrow, amount, kind, id string) error {
	if !validID(id) {
		return errors.New("bounded immutable treasury effect identifier required")
	}
	if e := fundingAssetAmount(network, amount); e != nil {
		return e
	}
	n, e := treasuryAmount(amount)
	if e != nil || n.Sign() <= 0 {
		return errors.New("positive canonical treasury effect required")
	}
	effectKey := "treasury_effect/" + kind + "/" + id
	if k.Store.Get([]byte(effectKey)) != nil {
		return errors.New("treasury effect already recorded")
	}
	state, e := k.TreasuryLiability(network, escrow)
	if e != nil {
		return e
	}
	total, _ := treasuryAmount(state.Funded)
	paid, _ := treasuryAmount(state.Paid)
	refunded, _ := treasuryAmount(state.Refunded)
	outstanding, _ := treasuryAmount(state.Outstanding)
	if kind == "deposit" {
		total.Add(total, n)
		outstanding.Add(outstanding, n)
	} else {
		if outstanding.Cmp(n) < 0 {
			return errors.New("outgoing treasury effect exceeds confirmed liabilities")
		}
		outstanding.Sub(outstanding, n)
		if kind == "refund" {
			refunded.Add(refunded, n)
		} else {
			paid.Add(paid, n)
		}
	}
	for _, v := range []*big.Int{total, paid, refunded, outstanding} {
		if _, e = treasuryAmount(v.String()); e != nil {
			return e
		}
	}
	if e = fundingAssetAmount(network, outstanding.String()); e != nil {
		return e
	}
	state.Funded, state.Paid, state.Refunded, state.Outstanding = total.String(), paid.String(), refunded.String(), outstanding.String()
	if e = put(k.Store, "treasury_liability/"+network+"/"+escrow, state); e != nil {
		return e
	}
	return put(k.Store, effectKey, treasuryEffect{kind, id, network, escrow, amount})
}
