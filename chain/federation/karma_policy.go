package federation

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"time"
)

// KarmaPolicyV2 implements Rahul's decisions of 9 November 2026:
//
//  1. Karma never falls. A rule violation adds penalty points (strikes) instead,
//     and a licence is revoked when a member's strikes reach StrikeRevocationLimit.
//  2. Every accepted AI$ award also gives 1 Karma per whole AI$ to its recipient
//     (solver and reviewer alike). Past awards and past penalties are converted by
//     bounded, idempotent guardian commands.
//
// Nothing changes until a guardian records karma_policy_activation. Its marker is
// read through the unmetered policy store, so every replayed pre-activation command
// keeps its exact bytes, gas and app hash.
const KarmaPolicyV2 = "uain-karma-v2"

// StrikeRevocationLimit is the strike count at which a licence ends under KarmaPolicyV2.
const StrikeRevocationLimit int64 = 10

// AIDollarAtoms is the number of atomic Coin units in one AI$.
const AIDollarAtoms = 1_000_000

const karmaPolicyKey = "karma_policy_activation"

var karmaEntryID = regexp.MustCompile(`^[0-9]{20}$`)

type KarmaPolicyActivation struct {
	Policy         string `json:"policy"`
	Height         int64  `json:"height,string"`
	ApprovedBy     string `json:"approved_by"`
	EvidenceDigest string `json:"evidence_digest"`
}

// StrikeEntry is the journal row for penalty points under KarmaPolicyV2.
type StrikeEntry struct {
	ID       string `json:"id"`
	EventID  uint64 `json:"event_id,string"`
	Member   string `json:"member"`
	Instance string `json:"instance,omitempty"`
	Points   int64  `json:"points"`
	Kind     string `json:"kind"`
	Ref      string `json:"ref"`
	At       string `json:"at"`
}

// KarmaBackfill records that one past award or penalty was converted.
type KarmaBackfill struct {
	Kind       string `json:"kind"`
	Ref        string `json:"ref"`
	Member     string `json:"member"`
	Karma      int64  `json:"karma"`
	Strikes    int64  `json:"strikes"`
	Height     int64  `json:"height,string"`
	ApprovedBy string `json:"approved_by"`
}

func (k Keeper) karmaPolicyMarker() []byte {
	if reader, ok := k.Store.(interface{ KarmaPolicyMarker() []byte }); ok {
		return reader.KarmaPolicyMarker()
	}
	return k.Store.Get([]byte(karmaPolicyKey))
}

// karmaPolicy reports whether KarmaPolicyV2 applies to the command executing now.
// Before activation it performs one unmetered read and nothing else. A keeper used
// outside Execute and ExpireKPIs carries no height; it applies a recorded policy.
func (k Keeper) karmaPolicy() (KarmaPolicyActivation, bool, error) {
	var a KarmaPolicyActivation
	raw := k.karmaPolicyMarker()
	if raw == nil {
		return a, false, nil
	}
	if e := Decode(raw, &a); e != nil {
		return a, false, e
	}
	if a.Policy != KarmaPolicyV2 || a.Height < 2 || !digestPattern.MatchString(a.EvidenceDigest) {
		return a, false, errors.New("invalid Karma policy activation")
	}
	return a, k.height == 0 || k.height >= a.Height, nil
}

func (k Keeper) karmaPolicyActivate(c Command, height int64) (string, error) {
	bad := errors.New("invalid Karma policy activation")
	var in struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || in.Policy != KarmaPolicyV2 || !digestPattern.MatchString(in.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte(karmaPolicyKey)) != nil {
		return "", bad
	}
	a := KarmaPolicyActivation{Policy: in.Policy, Height: height + 1, ApprovedBy: c.Member, EvidenceDigest: in.EvidenceDigest}
	return in.Policy, put(k.Store, karmaPolicyKey, a)
}

// recordStrike adds penalty points. Karma is not touched; the licence ends at the limit.
func (k Keeper) recordStrike(member, instance string, points int64, kind, ref string, now time.Time) error {
	if points <= 0 {
		return errors.New("invalid strike points")
	}
	m, err := k.Member(member)
	if err != nil {
		return err
	}
	if err = k.opening(m, instance, now); err != nil {
		return err
	}
	if m.Strikes < 0 || m.Strikes > math.MaxInt64-points {
		return errors.New("strike overflow")
	}
	m.Strikes += points
	if m.Strikes >= StrikeRevocationLimit {
		m.Licence = "revoked"
	}
	if err = put(k.Store, "member/"+member, m); err != nil {
		return err
	}
	id, err := k.nextID("strike_count")
	if err != nil {
		return err
	}
	ev, err := k.nextEvent()
	if err != nil {
		return err
	}
	entry := StrikeEntry{ID: fmt.Sprintf("%020d", id), EventID: ev, Member: member, Instance: instance, Points: points, Kind: kind, Ref: ref, At: now.UTC().Format(time.RFC3339Nano)}
	return put(k.Store, "strike/"+entry.ID, entry)
}

// centralAwardKarma is 1 Karma per whole AI$ of an award amount.
func centralAwardKarma(amount string) (int64, error) {
	n, ok := new(big.Int).SetString(amount, 10)
	if !ok || n.Sign() < 0 {
		return 0, errors.New("invalid central award amount")
	}
	n.Quo(n, big.NewInt(AIDollarAtoms))
	if !n.IsInt64() {
		return 0, errors.New("central award Karma overflow")
	}
	return n.Int64(), nil
}

func (k Keeper) recordCentralAwardKarma(a CentralAward, kind string, now time.Time) (int64, error) {
	delta, err := centralAwardKarma(a.Amount)
	if err != nil || delta == 0 {
		return 0, err
	}
	return delta, k.recordKarma(a.Member, "", delta, kind, a.Role+"/"+a.Submission, now)
}

// karmaCentralBackfill gives the Karma of one central award paid before activation.
func (k Keeper) karmaCentralBackfill(c Command, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid central award Karma backfill")
	policy, on, err := k.karmaPolicy()
	if err != nil {
		return "", err
	}
	if !on {
		return "", bad
	}
	var in struct {
		Submission string `json:"submission"`
		Role       string `json:"role"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || !validID(in.Submission) || (in.Role != "solver" && in.Role != "reviewer") {
		return "", bad
	}
	ref := in.Role + "/" + in.Submission
	marker := "karma_backfill/central/" + ref
	if k.Store.Get([]byte(marker)) != nil || k.Store.Get([]byte("central_award/"+ref)) == nil {
		return "", bad
	}
	var a CentralAward
	if e := get(k.Store, "central_award/"+ref, &a); e != nil {
		return "", e
	}
	if a.Submission != in.Submission || a.Role != in.Role || a.Height >= policy.Height {
		return "", bad
	}
	delta, err := k.recordCentralAwardKarma(a, "central_award_backfill", now)
	if err != nil {
		return "", err
	}
	return in.Submission, put(k.Store, marker, KarmaBackfill{Kind: "central_award", Ref: ref, Member: a.Member, Karma: delta, Height: height, ApprovedBy: c.Member})
}

// karmaPenaltyConvert turns one pre-activation Karma penalty into strikes: the
// Karma is restored (journalled) and the same number of strikes is added.
func (k Keeper) karmaPenaltyConvert(c Command, height int64, now time.Time) (string, error) {
	bad := errors.New("invalid Karma penalty conversion")
	_, on, err := k.karmaPolicy()
	if err != nil {
		return "", err
	}
	if !on {
		return "", bad
	}
	var in struct {
		Entry string `json:"entry"`
	}
	if e := Decode(c.Payload, &in); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || !karmaEntryID.MatchString(in.Entry) {
		return "", bad
	}
	marker := "karma_backfill/penalty/" + in.Entry
	if k.Store.Get([]byte(marker)) != nil || k.Store.Get([]byte("karma/"+in.Entry)) == nil {
		return "", bad
	}
	var entry KarmaEntry
	if e := get(k.Store, "karma/"+in.Entry, &entry); e != nil {
		return "", e
	}
	// After activation recordKarma writes no negative rows, so every negative row predates it.
	if entry.ID != in.Entry || entry.Delta >= 0 || entry.Delta == math.MinInt64 {
		return "", bad
	}
	points := -entry.Delta
	if err = k.recordKarma(entry.Member, entry.Instance, points, "penalty_converted", entry.ID, now); err != nil {
		return "", err
	}
	if err = k.recordStrike(entry.Member, entry.Instance, points, "converted_penalty", entry.ID, now); err != nil {
		return "", err
	}
	return in.Entry, put(k.Store, marker, KarmaBackfill{Kind: "penalty", Ref: entry.ID, Member: entry.Member, Karma: points, Strikes: points, Height: height, ApprovedBy: c.Member})
}
