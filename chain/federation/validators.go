package federation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Consensus validator set in application state (9 November 2026). The set is
// recorded at genesis and changes only through a guardian-quorum
// validator_set_update. EndBlock returns the pending changes to CometBFT and
// records each change height, so light clients can follow the signed chain of
// validator sets from the genesis pin instead of rejecting every change.

const (
	MaxValidators        = 50
	MaxValidatorPower    = int64(1000000)
	maxValidatorUpdates  = 20
	validatorRecordLimit = MaxValidators + maxValidatorUpdates + 1
)

type GenesisValidator struct {
	PubKey string `json:"pub_key"`
	Power  int64  `json:"power,string"`
	Name   string `json:"name"`
}

type ValidatorRecord struct {
	Address string `json:"address"`
	PubKey  string `json:"pub_key"`
	Power   int64  `json:"power,string"`
	Name    string `json:"name"`
	Height  int64  `json:"height,string"`
}

// ValidatorEpoch marks the header whose NextValidatorsHash first commits a
// changed set: updates returned by EndBlock H are named by header H+1.
type ValidatorEpoch struct {
	Number         uint64            `json:"number,string"`
	HeaderHeight   int64             `json:"header_height,string"`
	Validators     []ValidatorRecord `json:"validators"`
	EvidenceDigest string            `json:"evidence_digest"`
}

var validatorNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

// ValidatorAddress matches CometBFT's Ed25519 address: SHA-256(pub)[:20].
func ValidatorAddress(pub []byte) string {
	sum := sha256.Sum256(pub)
	return strings.ToUpper(hex.EncodeToString(sum[:20]))
}

func decodeValidatorKey(s string) ([]byte, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || len(b) != 32 || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("validator key must be canonical base64 Ed25519")
	}
	return b, nil
}

func (k Keeper) initValidators(vs []GenesisValidator) error {
	if len(vs) == 0 {
		return nil
	}
	return k.RecordGenesisValidators(vs)
}

// RecordGenesisValidators stores the consensus set once. CometBFT's genesis
// validators must equal any set already pinned in the application genesis.
func (k Keeper) RecordGenesisValidators(vs []GenesisValidator) error {
	if len(vs) == 0 || len(vs) > MaxValidators {
		return errors.New("genesis needs 1 to 50 validators")
	}
	existing, err := k.Validators()
	if err != nil {
		return err
	}
	records := []ValidatorRecord{}
	seen := map[string]bool{}
	for _, v := range vs {
		key, err := decodeValidatorKey(v.PubKey)
		if err != nil {
			return err
		}
		addr := ValidatorAddress(key)
		if seen[addr] || v.Power <= 0 || v.Power > MaxValidatorPower || (v.Name != "" && !validatorNamePattern.MatchString(v.Name)) {
			return errors.New("invalid or duplicate genesis validator")
		}
		seen[addr] = true
		records = append(records, ValidatorRecord{Address: addr, PubKey: v.PubKey, Power: v.Power, Name: v.Name})
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Address < records[j].Address })
	if len(existing) > 0 {
		if len(existing) != len(records) {
			return errors.New("consensus genesis validators differ from application genesis")
		}
		for i := range existing {
			if existing[i].Address != records[i].Address || existing[i].Power != records[i].Power {
				return errors.New("consensus genesis validators differ from application genesis")
			}
		}
		return nil
	}
	for _, r := range records {
		if err := put(k.Store, "validator/"+r.Address, r); err != nil {
			return err
		}
	}
	return nil
}

func (k Keeper) Validators() ([]ValidatorRecord, error) {
	return k.validatorRows("validator/")
}

func (k Keeper) validatorRows(prefix string) ([]ValidatorRecord, error) {
	rows, err := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), validatorRecordLimit)
	if err != nil {
		return nil, err
	}
	if len(rows) >= validatorRecordLimit {
		return nil, errors.New("validator record bound exceeded")
	}
	out := make([]ValidatorRecord, 0, len(rows))
	for _, row := range rows {
		var v ValidatorRecord
		if err := Decode(row.Value, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (k Keeper) updateValidatorSet(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian quorum required")
	}
	var p struct {
		Updates        []GenesisValidator `json:"updates"`
		EvidenceDigest string             `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || len(p.Updates) == 0 || len(p.Updates) > maxValidatorUpdates || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("validator update needs 1 to 20 changes and evidence")
	}
	current, err := k.Validators()
	if err != nil {
		return "", err
	}
	if len(current) == 0 {
		return "", errors.New("validator set is not recorded in application state")
	}
	pending, err := k.validatorRows("validator_pending/")
	if err != nil {
		return "", err
	}
	next := map[string]ValidatorRecord{}
	for _, v := range current {
		next[v.Address] = v
	}
	for _, v := range pending {
		if v.Power == 0 {
			delete(next, v.Address)
		} else {
			next[v.Address] = v
		}
	}
	seen := map[string]bool{}
	writes := []ValidatorRecord{}
	for _, u := range p.Updates {
		key, err := decodeValidatorKey(u.PubKey)
		if err != nil {
			return "", err
		}
		addr := ValidatorAddress(key)
		if seen[addr] || u.Power < 0 || u.Power > MaxValidatorPower || (u.Name != "" && !validatorNamePattern.MatchString(u.Name)) {
			return "", errors.New("invalid or duplicate validator change")
		}
		seen[addr] = true
		if u.Power == 0 {
			// CometBFT halts on removal of an unknown validator.
			if _, ok := next[addr]; !ok {
				return "", errors.New("cannot remove a validator outside the set")
			}
			delete(next, addr)
		} else {
			next[addr] = ValidatorRecord{Address: addr, PubKey: u.PubKey, Power: u.Power, Name: u.Name}
		}
		writes = append(writes, ValidatorRecord{Address: addr, PubKey: u.PubKey, Power: u.Power, Name: u.Name, Height: height})
	}
	if len(next) == 0 || len(next) > MaxValidators {
		return "", errors.New("validator set must keep 1 to 50 validators")
	}
	for _, w := range writes {
		if err := put(k.Store, "validator_pending/"+w.Address, w); err != nil {
			return "", err
		}
	}
	if err := put(k.Store, "validator_pending_evidence", p.EvidenceDigest); err != nil {
		return "", err
	}
	return fmt.Sprintf("validators@%d", height), nil
}

// ApplyValidatorUpdates is called from EndBlock at height. It moves pending
// changes into the recorded set and returns them for CometBFT.
func (k Keeper) ApplyValidatorUpdates(height int64) ([]ValidatorRecord, error) {
	pending, err := k.validatorRows("validator_pending/")
	if err != nil || len(pending) == 0 {
		return nil, err
	}
	for _, v := range pending {
		k.Store.Delete([]byte("validator_pending/" + v.Address))
		if v.Power == 0 {
			k.Store.Delete([]byte("validator/" + v.Address))
			continue
		}
		v.Height = height
		if err := put(k.Store, "validator/"+v.Address, v); err != nil {
			return nil, err
		}
	}
	var evidence string
	_ = get(k.Store, "validator_pending_evidence", &evidence)
	k.Store.Delete([]byte("validator_pending_evidence"))
	set, err := k.Validators()
	if err != nil {
		return nil, err
	}
	if len(set) == 0 {
		return nil, errors.New("validator update would empty the set")
	}
	var count uint64
	if k.Store.Get([]byte("validator_epoch_count")) != nil {
		if err = get(k.Store, "validator_epoch_count", &count); err != nil {
			return nil, err
		}
	}
	count++
	if err = put(k.Store, fmt.Sprintf("validator_epoch/%020d", count), ValidatorEpoch{Number: count, HeaderHeight: height + 1, Validators: set, EvidenceDigest: evidence}); err != nil {
		return nil, err
	}
	if err = put(k.Store, "validator_epoch_count", count); err != nil {
		return nil, err
	}
	return pending, nil
}

// ValidatorPubKey decodes a recorded validator key.
func ValidatorPubKey(v ValidatorRecord) ([]byte, error) { return decodeValidatorKey(v.PubKey) }
