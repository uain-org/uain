// Package economy conserves externally funded currency in atomic units. This
// arithmetic does not prove an external transfer, authorize a recipient, mint
// Coin or imply CHF backing. The cached consensus adapter supplies those gates.
package economy

import (
	"errors"
	"math/big"
	"regexp"
)

var integer = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)

type Bucket struct {
	Available string `json:"available"`
	Reserved  string `json:"reserved"`
	Paid      string `json:"paid"`
}
type Pool struct {
	Funded     string `json:"funded"`
	Refunded   string `json:"refunded"`
	Bounty     Bucket `json:"bounty"`
	Dividend   Bucket `json:"dividend"`
	Operations Bucket `json:"operations"`
	Dust       string `json:"dust"`
}

func Empty() Pool {
	return Pool{"0", "0", Bucket{"0", "0", "0"}, Bucket{"0", "0", "0"}, Bucket{"0", "0", "0"}, "0"}
}
func units(s string) (*big.Int, error) {
	if !integer.MatchString(s) {
		return nil, errors.New("canonical nonnegative bounded atomic units required")
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil, errors.New("invalid amount")
	}
	return n, nil
}
func positive(s string) (*big.Int, error) {
	n, e := units(s)
	if e != nil {
		return nil, e
	}
	if n.Sign() == 0 {
		return nil, errors.New("positive atomic units required")
	}
	return n, nil
}
func (p Pool) Validate() error {
	funded, e := units(p.Funded)
	if e != nil {
		return e
	}
	refunded, e := units(p.Refunded)
	if e != nil {
		return e
	}
	dust, e := units(p.Dust)
	if e != nil {
		return e
	}
	total := new(big.Int).Add(refunded, dust)
	for _, b := range []Bucket{p.Bounty, p.Dividend, p.Operations} {
		for _, s := range []string{b.Available, b.Reserved, b.Paid} {
			n, e := units(s)
			if e != nil {
				return e
			}
			total.Add(total, n)
		}
	}
	if total.Cmp(funded) != 0 {
		return errors.New("external currency pool conservation violated")
	}
	return nil
}
func (p Pool) Fund(s string) (Pool, error) {
	if e := p.Validate(); e != nil {
		return p, e
	}
	n, e := positive(s)
	if e != nil {
		return p, e
	}
	before := p
	funded, _ := units(p.Funded)
	funded.Add(funded, n)
	p.Funded = funded.String()
	allocated := new(big.Int)
	for i, b := range []*Bucket{&p.Bounty, &p.Dividend, &p.Operations} {
		share := new(big.Int).Quo(new(big.Int).Mul(n, big.NewInt([]int64{80, 15, 5}[i])), big.NewInt(100))
		allocated.Add(allocated, share)
		old, _ := units(b.Available)
		b.Available = old.Add(old, share).String()
	}
	dust, _ := units(p.Dust)
	p.Dust = dust.Add(dust, new(big.Int).Sub(n, allocated)).String()
	if e = p.Validate(); e != nil {
		return before, e
	}
	return p, nil
}
func (p *Pool) bucket(kind string) (*Bucket, error) {
	switch kind {
	case "bounty":
		return &p.Bounty, nil
	case "dividend":
		return &p.Dividend, nil
	case "operations":
		return &p.Operations, nil
	}
	return nil, errors.New("unknown pool bucket")
}
func (p Pool) move(kind, s, operation string) (Pool, error) {
	before := p
	if e := p.Validate(); e != nil {
		return before, e
	}
	n, e := positive(s)
	if e != nil {
		return before, e
	}
	b, e := p.bucket(kind)
	if e != nil {
		return before, e
	}
	available, _ := units(b.Available)
	reserved, _ := units(b.Reserved)
	paid, _ := units(b.Paid)
	switch operation {
	case "reserve":
		if available.Cmp(n) < 0 {
			return before, errors.New("insufficient available external funds")
		}
		available.Sub(available, n)
		reserved.Add(reserved, n)
	case "release":
		if reserved.Cmp(n) < 0 {
			return before, errors.New("release exceeds reserved external funds")
		}
		reserved.Sub(reserved, n)
		available.Add(available, n)
	case "pay":
		if reserved.Cmp(n) < 0 {
			return before, errors.New("payment exceeds reserved external funds")
		}
		reserved.Sub(reserved, n)
		paid.Add(paid, n)
	default:
		return before, errors.New("unknown pool movement")
	}
	b.Available, b.Reserved, b.Paid = available.String(), reserved.String(), paid.String()
	if e = p.Validate(); e != nil {
		return before, e
	}
	return p, nil
}
func (p Pool) Reserve(kind, s string) (Pool, error) { return p.move(kind, s, "reserve") }
func (p Pool) Release(kind, s string) (Pool, error) { return p.move(kind, s, "release") }
func (p Pool) Pay(kind, s string) (Pool, error)     { return p.move(kind, s, "pay") }

// Refund reverses one original receipt's exact split only while all of that
// split remains available. The adapter locks a receipt before attested return;
// it may not refund a receipt whose funding reward/dividends were consumed.
func (p Pool) Refund(s string) (Pool, error) {
	before := p
	if e := p.Validate(); e != nil {
		return before, e
	}
	n, e := positive(s)
	if e != nil {
		return before, e
	}
	split, e := Empty().Fund(s)
	if e != nil {
		return before, e
	}
	for i, b := range []*Bucket{&p.Bounty, &p.Dividend, &p.Operations} {
		deduction, _ := units([]string{split.Bounty.Available, split.Dividend.Available, split.Operations.Available}[i])
		available, _ := units(b.Available)
		if available.Cmp(deduction) < 0 {
			return before, errors.New("refund split already reserved or paid")
		}
		b.Available = available.Sub(available, deduction).String()
	}
	dust, _ := units(p.Dust)
	refundDust, _ := units(split.Dust)
	if dust.Cmp(refundDust) < 0 {
		return before, errors.New("refund dust unavailable")
	}
	p.Dust = dust.Sub(dust, refundDust).String()
	refunded, _ := units(p.Refunded)
	p.Refunded = refunded.Add(refunded, n).String()
	if e = p.Validate(); e != nil {
		return before, e
	}
	return p, nil
}

// Entitlement floors an eligible, actually minted holding's share. A zero
// eligible snapshot cannot distribute funds; the complete pool carries forward.
// Remaining fractional units stay in the dividend pool, never newly minted.
func Entitlement(pool, holding, eligibleMinted string) (string, error) {
	p, e := units(pool)
	if e != nil {
		return "", e
	}
	h, e := units(holding)
	if e != nil {
		return "", e
	}
	total, e := positive(eligibleMinted)
	if e != nil {
		return "", e
	}
	if h.Cmp(total) > 0 {
		return "", errors.New("holding exceeds eligible minted snapshot")
	}
	return new(big.Int).Quo(new(big.Int).Mul(p, h), total).String(), nil
}
