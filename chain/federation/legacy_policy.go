package federation

import (
	"errors"
	"fmt"
	"math/big"
	"time"
)

type LegacyPublicPolicy struct {
	Version            int    `json:"version"`
	DailyCreditCap     string `json:"daily_credit_cap"`
	BootstrapOperators int    `json:"bootstrap_operators"`
	IssuanceTotal      string `json:"issuance_total"`
}

func (k Keeper) legacyPublicPolicy() (*LegacyPublicPolicy, error) {
	if k.Store.Get([]byte("legacy/policy")) == nil {
		return nil, nil
	}
	var p LegacyPublicPolicy
	if err := get(k.Store, "legacy/policy", &p); err != nil {
		return nil, err
	}
	cap, err := money(p.DailyCreditCap)
	if err != nil || cap.Sign() <= 0 || p.Version != 1 || p.BootstrapOperators < 0 || p.BootstrapOperators > MaxBootstrapOperators {
		return nil, errors.New("invalid pinned original public policy")
	}
	if _, err = money(p.IssuanceTotal); err != nil {
		return nil, err
	}
	return &p, nil
}

// Historical positive non-transfer journal entries already explain imported
// balances. They reduce the rolling room, but never mint or enter native
// issuance_total. The strict SQL boundary is at > now - 24 hours.
func (k Keeper) withLegacySourceIssuance(native *big.Int, now time.Time) (*big.Int, error) {
	p, err := k.legacyPublicPolicy()
	if err != nil || p == nil {
		return native, err
	}
	source, err := money(p.IssuanceTotal)
	if err != nil {
		return nil, err
	}
	stamp, err := issuanceTime(now)
	if err != nil {
		return nil, err
	}
	cutoff := stamp - int64(24*time.Hour)
	if cutoff >= 0 {
		row, err := k.Store.Last([]byte("legacy/issuance_time/"), []byte(fmt.Sprintf("legacy/issuance_time/%020d", cutoff+1)))
		if err != nil {
			return nil, err
		}
		if row != nil {
			var before string
			if err = Decode(row.Value, &before); err != nil {
				return nil, err
			}
			n, err := money(before)
			if err != nil {
				return nil, err
			}
			source.Sub(source, n)
		}
	}
	if source.Sign() < 0 {
		return nil, errors.New("original issuance prefix inconsistent")
	}
	return new(big.Int).Add(native, source), nil
}
func (k Keeper) legacyCredit(member, instance, ref, kind string, amount *big.Int, now time.Time) error {
	p, err := k.legacyPublicPolicy()
	if err != nil {
		return err
	}
	cap := big.NewInt(DailyCreditCap)
	if p != nil {
		cap, err = money(p.DailyCreditCap)
		if err != nil {
			return err
		}
	}
	return k.creditWithCap(member, instance, ref, kind, amount, now, false, "", cap)
}
