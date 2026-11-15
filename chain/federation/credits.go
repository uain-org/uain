package federation

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"time"
)

// This is a consensus parameter for nonmonetary pilot credits, not Coin supply.
const DailyCreditCap int64 = 10000

func (k Keeper) nextID(key string) (uint64, error) {
	var n uint64
	if k.Store.Get([]byte(key)) != nil {
		if err := get(k.Store, key, &n); err != nil {
			return 0, err
		}
	}
	if n == math.MaxUint64 {
		return 0, errors.New("ledger counter exhausted")
	}
	n++
	return n, put(k.Store, key, n)
}
func (k Keeper) nextEvent() (uint64, error) {
	var n uint64
	if k.Store.Get([]byte("event_count")) != nil {
		if err := get(k.Store, "event_count", &n); err != nil {
			return 0, err
		}
	}
	if n == math.MaxUint64 {
		return 0, errors.New("event counter exhausted")
	}
	return n + 1, nil
}

// Opening balances explain the pre-journal state once. They never increase
// issuance. Instance balances are attribution within the member aggregate.
func (k Keeper) opening(m Member, instance string, now time.Time) error {
	key := "accounting_opening/" + m.ID
	if k.Store.Get([]byte(key)) == nil {
		if err := put(k.Store, key, map[string]any{"member": m.ID, "karma": m.Karma, "credits": m.Credits, "at": now.UTC().Format(time.RFC3339Nano), "basis": "pre-journal balance; legacy commitment remains authoritative for history"}); err != nil {
			return err
		}
	}
	if instance != "" {
		key = "instance_opening/" + instance
		if k.Store.Get([]byte(key)) == nil {
			v, err := k.Instance(instance)
			if err != nil {
				return err
			}
			if v.Member != m.ID {
				return errors.New("instance opening owner mismatch")
			}
			return put(k.Store, key, v)
		}
	}
	return nil
}
func (k Keeper) recordKarma(member, instance string, delta int64, kind, ref string, now time.Time) error {
	// Under KarmaPolicyV2 Karma never falls: a penalty becomes strikes instead.
	_, v2, err := k.karmaPolicy()
	if err != nil {
		return err
	}
	if v2 && delta < 0 {
		if delta == math.MinInt64 {
			return errors.New("Karma overflow")
		}
		return k.recordStrike(member, instance, -delta, kind, ref, now)
	}
	m, err := k.Member(member)
	if err != nil {
		return err
	}
	if err = k.opening(m, instance, now); err != nil {
		return err
	}
	if (delta > 0 && m.Karma > math.MaxInt64-delta) || (delta < 0 && m.Karma < math.MinInt64-delta) {
		return errors.New("Karma overflow")
	}
	if err = k.attribute(member, instance, delta, "0"); err != nil {
		return err
	}
	m.Karma += delta
	// Strikes are zero before KarmaPolicyV2, so this is the pre-activation rule there.
	if m.Karma <= -10 || m.Strikes >= StrikeRevocationLimit {
		m.Licence = "revoked"
	}
	if err = put(k.Store, "member/"+member, m); err != nil {
		return err
	}
	id, err := k.nextID("karma_count")
	if err != nil {
		return err
	}
	ev, err := k.nextEvent()
	if err != nil {
		return err
	}
	entry := KarmaEntry{ID: fmt.Sprintf("%020d", id), EventID: ev, Member: member, Instance: instance, Delta: delta, Kind: kind, Ref: ref, At: now.UTC().Format(time.RFC3339Nano)}
	return put(k.Store, "karma/"+entry.ID, entry)
}
func issuanceTime(now time.Time) (int64, error) {
	n := now.UnixNano()
	if n < 0 || !time.Unix(0, n).Equal(now) {
		return 0, errors.New("issuance time outside supported epoch")
	}
	return n, nil
}
func (k Keeper) issuanceTotal() (*big.Int, error) {
	if k.Store.Get([]byte("issuance_total")) == nil {
		return big.NewInt(0), nil
	}
	var s string
	if err := get(k.Store, "issuance_total", &s); err != nil {
		return nil, err
	}
	return money(s)
}
func (k Keeper) IssuedLast24h(now time.Time) (*big.Int, error) {
	stamp, err := issuanceTime(now)
	if err != nil {
		return nil, err
	}
	var last int64
	if k.Store.Get([]byte("issuance_clock")) != nil {
		if err = get(k.Store, "issuance_clock", &last); err != nil {
			return nil, err
		}
		if stamp < last {
			return nil, errors.New("issuance clock regressed")
		}
	}
	total, err := k.issuanceTotal()
	if err != nil {
		return nil, err
	}
	cutoff := stamp - int64(24*time.Hour)
	if cutoff < 0 {
		return k.withLegacySourceIssuance(total, now)
	}
	row, err := k.Store.Last([]byte("issuance_time/"), []byte(fmt.Sprintf("issuance_time/%020d", cutoff+1)))
	if err != nil {
		return nil, err
	}
	if row != nil {
		var s string
		if err = Decode(row.Value, &s); err != nil {
			return nil, err
		}
		before, err := money(s)
		if err != nil {
			return nil, err
		}
		total.Sub(total, before)
	}
	if total.Sign() < 0 {
		return nil, errors.New("issuance prefix inconsistent")
	}
	return k.withLegacySourceIssuance(total, now)
}
func (k Keeper) noteIssuance(amount *big.Int, now time.Time) error {
	if amount.Sign() == 0 {
		return nil
	}
	if _, err := k.IssuedLast24h(now); err != nil {
		return err
	}
	stamp, err := issuanceTime(now)
	if err != nil {
		return err
	}
	total, err := k.issuanceTotal()
	if err != nil {
		return err
	}
	total.Add(total, amount)
	if len(total.String()) > 78 {
		return errors.New("issuance total overflow")
	}
	if err = put(k.Store, "issuance_total", total.String()); err != nil {
		return err
	}
	if err = put(k.Store, "issuance_clock", stamp); err != nil {
		return err
	}
	return put(k.Store, fmt.Sprintf("issuance_time/%020d", stamp), total.String())
}
func (k Keeper) recipientReason(member, instance string) (string, error) {
	m, err := k.Member(member)
	if err != nil {
		return "", err
	}
	if m.Licence != "active" {
		return "licence_" + m.Licence, nil
	}
	if instance != "" {
		v, err := k.Instance(instance)
		if err != nil {
			return "", err
		}
		if v.Member != member {
			return "", errors.New("recipient instance owner mismatch")
		}
		if v.State != "active" {
			return "instance_" + v.State, nil
		}
	}
	return "", nil
}
func (k Keeper) credit(member, instance, ref, kind string, amount *big.Int, now time.Time, bypass bool, releaseOf string) error {
	return k.creditWithCap(member, instance, ref, kind, amount, now, bypass, releaseOf, big.NewInt(DailyCreditCap))
}
func (k Keeper) creditWithCap(member, instance, ref, kind string, amount *big.Int, now time.Time, bypass bool, releaseOf string, cap *big.Int) error {
	if amount.Sign() < 0 {
		return errors.New("negative credit award")
	}
	if amount.Sign() == 0 {
		return nil
	}
	m, err := k.Member(member)
	if err != nil {
		return err
	}
	if err = k.opening(m, instance, now); err != nil {
		return err
	}
	why, err := k.recipientReason(member, instance)
	if err != nil {
		return err
	}
	minted := new(big.Int).Set(amount)
	if why != "" {
		minted.SetInt64(0)
	} else if !bypass {
		issued, err := k.IssuedLast24h(now)
		if err != nil {
			return err
		}
		room := new(big.Int).Sub(cap, issued)
		if room.Sign() < 0 {
			room.SetInt64(0)
		}
		if minted.Cmp(room) > 0 {
			minted.Set(room)
		}
	}
	deferred := new(big.Int).Sub(amount, minted)
	if releaseOf != "" && deferred.Sign() != 0 {
		return errors.New("release recipient became ineligible")
	}
	if minted.Sign() > 0 {
		balance, err := money(m.Credits)
		if err != nil {
			return err
		}
		balance.Add(balance, minted)
		if len(balance.String()) > 78 {
			return errors.New("credit overflow")
		}
		if err = k.attribute(member, instance, 0, minted.String()); err != nil {
			return err
		}
		m.Credits = balance.String()
		if err = put(k.Store, "member/"+member, m); err != nil {
			return err
		}
		if err = k.noteIssuance(minted, now); err != nil {
			return err
		}
	}
	id, err := k.nextID("credit_count")
	if err != nil {
		return err
	}
	ev, err := k.nextEvent()
	if err != nil {
		return err
	}
	entry := CreditEntry{ID: fmt.Sprintf("%020d", id), EventID: ev, Member: member, Instance: instance, Contribution: ref, Kind: kind, Amount: amount.String(), Minted: minted.String(), Deferred: deferred.String(), Withheld: why, At: now.UTC().Format(time.RFC3339Nano), ReleaseOf: releaseOf}
	if err = put(k.Store, "credit/"+entry.ID, entry); err != nil {
		return err
	}
	if deferred.Sign() > 0 {
		return put(k.Store, "credit_owed/"+entry.ID, CreditOwed{Entry: entry.ID, Member: member, Instance: instance, Contribution: ref, Remaining: deferred.String()})
	}
	return nil
}
func (k Keeper) releaseDeferred(c Command, now time.Time) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian release required")
	}
	var p struct {
		Entries        []string `json:"entries"`
		EvidenceDigest string   `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if len(p.Entries) < 1 || len(p.Entries) > 20 || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("bounded release entries and evidence required")
	}
	seen := map[string]bool{}
	for _, id := range p.Entries {
		if !validID(id) || seen[id] {
			return "", errors.New("invalid or duplicate release entry")
		}
		seen[id] = true
		var owed CreditOwed
		if err := get(k.Store, "credit_owed/"+id, &owed); err != nil {
			return "", err
		}
		amount, err := money(owed.Remaining)
		if err != nil {
			return "", err
		}
		if amount.Sign() == 0 {
			return "", errors.New("credit deferral already released")
		}
		why, err := k.recipientReason(owed.Member, owed.Instance)
		if err != nil {
			return "", err
		}
		if why != "" {
			continue
		}
		// As in the pilot, a signed operator release bypasses the circuit breaker;
		// its positive issuance still reduces the room for subsequent ordinary pay.
		if err = k.credit(owed.Member, owed.Instance, owed.Contribution, "release", amount, now, true, id); err != nil {
			return "", err
		}
		owed.Remaining = "0"
		if err = put(k.Store, "credit_owed/"+id, owed); err != nil {
			return "", err
		}
	}
	return p.Entries[0], nil
}
