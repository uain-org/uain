// Package coin defines exact supply conservation for the prospective native
// Coin asset. It does not authorize a bounty, turn pilot credits into Coin,
// prove an Orchard boundary, or claim CHF reserves. The SDK adapter must verify
// those inputs and commit these transitions atomically with account/note state.
package coin

import (
	"errors"
	"math"
	"math/big"
	"regexp"
)

// Six decimal places are a candidate technical denomination. Total supply is
// the whitepaper's 108 trillion Coin; cap arithmetic must exceed uint64 without
// wrapping. Individual Orchard boundary amounts remain signed-int64 bounded.
const UnitsPerCoin = uint64(1000000)
const SupplyCap = "108000000000000000000"

var canonical = regexp.MustCompile(`^(0|[1-9][0-9]{0,20})$`)

type Ledger struct {
	Minted      string `json:"minted"`
	Reserved    string `json:"reserved"`
	Transparent string `json:"transparent"`
	Shielded    string `json:"shielded"`
}

func Empty() Ledger { return Ledger{"0", "0", "0", "0"} }

func amount(s string) (*big.Int, error) {
	if !canonical.MatchString(s) {
		return nil, errors.New("canonical nonnegative Coin units required")
	}
	n, ok := new(big.Int).SetString(s, 10)
	cap, _ := new(big.Int).SetString(SupplyCap, 10)
	if !ok || n.Cmp(cap) > 0 {
		return nil, errors.New("Coin amount exceeds supply cap")
	}
	return n, nil
}

func positive(s string) (*big.Int, error) {
	n, err := amount(s)
	if err != nil {
		return nil, err
	}
	if n.Sign() == 0 {
		return nil, errors.New("positive Coin amount required")
	}
	return n, nil
}

func (l Ledger) values() ([4]*big.Int, error) {
	v := [4]*big.Int{}
	for i, s := range []string{l.Minted, l.Reserved, l.Transparent, l.Shielded} {
		n, err := amount(s)
		if err != nil {
			return v, err
		}
		v[i] = n
	}
	cap, _ := new(big.Int).SetString(SupplyCap, 10)
	if new(big.Int).Add(v[0], v[1]).Cmp(cap) > 0 || new(big.Int).Add(v[2], v[3]).Cmp(v[0]) != 0 {
		return v, errors.New("Coin supply or pool conservation invariant violated")
	}
	return v, nil
}

func (l Ledger) Validate() error { _, err := l.values(); return err }

// Available excludes both earned/minted Coin and still-unminted reservations.
// Reservations confer no balance and cannot receive a dividend.
func (l Ledger) Available() (string, error) {
	v, err := l.values()
	if err != nil {
		return "", err
	}
	cap, _ := new(big.Int).SetString(SupplyCap, 10)
	return cap.Sub(cap, v[0]).Sub(cap, v[1]).String(), nil
}

func (l Ledger) result(v [4]*big.Int) (Ledger, error) {
	next := Ledger{v[0].String(), v[1].String(), v[2].String(), v[3].String()}
	if err := next.Validate(); err != nil {
		return l, err
	}
	return next, nil
}

// Reserve is called only for a prospective, priced, unstarted bounty by its
// authorized manager. Per-task reservation/eligibility is the adapter's duty.
func (l Ledger) Reserve(units string) (Ledger, error) {
	v, err := l.values()
	if err != nil {
		return l, err
	}
	n, err := positive(units)
	if err != nil {
		return l, err
	}
	v[1].Add(v[1], n)
	return l.result(v)
}

func (l Ledger) Release(units string) (Ledger, error) {
	v, err := l.values()
	if err != nil {
		return l, err
	}
	n, err := positive(units)
	if err != nil || v[1].Cmp(n) < 0 {
		return l, errors.New("invalid Coin reservation release")
	}
	v[1].Sub(v[1], n)
	return l.result(v)
}

// Mint consumes an exact reservation only after the adapter independently
// verifies a completed/new paid bounty and a never-used reward ID. This is
// accounting arithmetic; calling it alone is not evidence of verified work.
func (l Ledger) Mint(units string) (Ledger, error) {
	v, err := l.values()
	if err != nil {
		return l, err
	}
	n, err := positive(units)
	if err != nil || v[1].Cmp(n) < 0 {
		return l, errors.New("mint requires an existing Coin reservation")
	}
	v[1].Sub(v[1], n)
	v[0].Add(v[0], n)
	v[2].Add(v[2], n)
	return l.result(v)
}

func (l Ledger) boundary(units string, from, to int) (Ledger, error) {
	v, err := l.values()
	if err != nil {
		return l, err
	}
	n, err := positive(units)
	if err != nil || n.Cmp(big.NewInt(math.MaxInt64)) > 0 || v[from].Cmp(n) < 0 {
		return l, errors.New("invalid or unbacked Orchard asset boundary")
	}
	v[from].Sub(v[from], n)
	v[to].Add(v[to], n)
	return l.result(v)
}

// Shield/Exit conserve minted supply. The adapter must bind the exact amount
// to a verified negative/positive Orchard value balance respectively, debit
// the owner or pool, and enforce licences, approvals and nullifier uniqueness.
func (l Ledger) Shield(units string) (Ledger, error) { return l.boundary(units, 2, 3) }
func (l Ledger) Exit(units string) (Ledger, error)   { return l.boundary(units, 3, 2) }
