package federation

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strings"
)

// Store is backed by a Cosmos SDK cached KVStore. Callers commit the cached
// store only after Execute succeeds, making all transitions atomic.
type Store interface {
	Get([]byte) []byte
	Set([]byte, []byte)
	Delete([]byte)
	Range(start, end []byte, limit int) ([]Entry, error)
	Last(start, end []byte) (*Entry, error)
}
type Entry struct{ Key, Value []byte }
type Keeper struct {
	Store Store
	// quorum holds the active guardians whose recorded approvals authorize the
	// operation executing now. It is never persisted or decoded from input.
	quorum []string
	// height is the block height of the command or block hook executing now. It
	// selects prospective policies read from unmetered markers; never persisted.
	height int64
}

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func validID(s string) bool { return idPattern.MatchString(s) }
func put(s Store, key string, v any) error {
	if err := legacyPolicyAccountChange(s, key, v); err != nil {
		return err
	}
	if err := privateLicenceChange(s, key, v); err != nil {
		return err
	}
	if err := censusAccountChange(s, key, v); err != nil {
		return err
	}
	var err error
	switch value := v.(type) {
	case Member:
		v, err = compactMember(s, value)
	case Instance:
		v, err = compactInstance(s, value)
	}
	if err != nil {
		return err
	}
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	s.Set([]byte(key), b)
	switch work := v.(type) {
	case LegacyTask:
		if key == "legacy_task/"+work.ID {
			return legacyWriteTaskBudget(s, work)
		}
	case *LegacyTask:
		if work != nil && key == "legacy_task/"+work.ID {
			return legacyWriteTaskBudget(s, *work)
		}
	case LegacyWork:
		if key == "legacy_work/"+work.ID {
			return legacyWriteWorkStatus(s, work)
		}
	case *LegacyWork:
		if work != nil && key == "legacy_work/"+work.ID {
			return legacyWriteWorkStatus(s, *work)
		}
	}
	return nil
}
func get(s Store, key string, v any) error {
	b := s.Get([]byte(key))
	if b == nil {
		return errors.New("record not found: " + key)
	}
	return json.Unmarshal(b, v)
}
func (k Keeper) Member(id string) (Member, error) {
	var m Member
	e := get(k.Store, "member/"+id, &m)
	if e == nil && m.AccountPolicy != "" {
		m, e = k.fullMember(m)
	}
	return m, e
}
func (k Keeper) projectState(id string) (Project, error) {
	var v Project
	e := get(k.Store, "project/"+id, &v)
	return v, e
}
func (k Keeper) taskState(id string) (Task, error) {
	var v Task
	e := get(k.Store, "task/"+id, &v)
	return v, e
}
func (k Keeper) contributionState(id string) (Contribution, error) {
	var v Contribution
	e := get(k.Store, "contribution/"+id, &v)
	if e == nil && (v.MembershipPolicy == MembershipPolicy || v.StoragePolicy == CompactStatePolicy) && v.State != "settled" && v.State != "rejected" && v.State != "withheld" {
		// Closure is one task record, not a rewrite of every potentially large
		// answer. A consumer must prove both the answer and its task to derive
		// this status; the original evidence and frozen award remain intact.
		t, err := k.taskState(v.Task)
		if err != nil {
			return v, err
		}
		if t.PriorArtDecision != "" {
			v.State, v.AwardWithheld = "withheld", "known"
		} else if v.StoragePolicy == CompactStatePolicy && (t.State == "kpi_unmet" || t.State == "kpi_expired") {
			v.State, v.AwardWithheld = "withheld", t.State
		}
	}
	return v, e
}

func money(s string) (*big.Int, error) {
	if s == "" || len(s) > 78 || (len(s) > 1 && s[0] == '0') {
		return nil, errors.New("invalid integer amount")
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return nil, errors.New("amount must be an unsigned decimal integer")
		}
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil, errors.New("invalid amount")
	}
	return n, nil
}
func basis(p PriorArt) bool {
	if len(strings.TrimSpace(p.Basis)) < 40 || len(p.Basis) > 4000 || len(p.Searches) < 2 || len(p.Searches) > 20 {
		return false
	}
	seen := map[string]bool{}
	for _, q := range p.Searches {
		q = strings.TrimSpace(q)
		if len(q) < 5 || len(q) > 1000 || seen[q] {
			return false
		}
		seen[q] = true
	}
	return true
}
func allowedClass(s string) bool { return s == "benevolent" || s == "neutral" }
func (k Keeper) Init(g Genesis) error {
	if g.Version != ProtocolVersion || len(g.Guardians) == 0 || len(g.Guardians) > 20 || len(g.Members) > 10000 {
		return errors.New("genesis needs version and bounded guardians")
	}
	if k.Store.Get([]byte("guardians")) != nil {
		return errors.New("already initialized")
	}
	seen := map[string]bool{}
	for _, m := range g.Members {
		if seen[m.ID] {
			return errors.New("duplicate genesis member")
		}
		seen[m.ID] = true
		if e := validateMember(m); e != nil {
			return e
		}
		if e := put(k.Store, "member/"+m.ID, m); e != nil {
			return e
		}
	}
	guardianSeen := map[string]bool{}
	for _, id := range g.Guardians {
		m, e := k.Member(id)
		if e != nil || m.Licence != "active" || guardianSeen[id] {
			return errors.New("guardian must be a unique active genesis member")
		}
		guardianSeen[id] = true
	}
	if g.Legacy != nil {
		if !digestPattern.MatchString(g.Legacy.ManifestDigest) || !digestPattern.MatchString(g.Legacy.LedgerHead) || g.Legacy.LastEventID < 0 || g.Legacy.PinnedPublicKey == "" {
			return errors.New("invalid legacy commitment")
		}
		if e := put(k.Store, "legacy", g.Legacy); e != nil {
			return e
		}
	}
	if g.GuardianThreshold != 0 {
		if !validGuardianThreshold(g.GuardianThreshold, len(g.Guardians)) {
			return errors.New("guardian threshold must be a strict majority of the guardians")
		}
		if e := put(k.Store, "guardian_threshold", g.GuardianThreshold); e != nil {
			return e
		}
	}
	if e := k.initValidators(g.Validators); e != nil {
		return e
	}
	// Generation 2 chains (9 November 2026 reset) index v1 Coin finance per
	// project from their first block.
	if g.Generation < 0 || g.Generation > CurrentGenesisGeneration {
		return errors.New("unsupported genesis generation")
	}
	if g.Generation >= 2 {
		if e := put(k.Store, "consensus_v2_activation", ConsensusV2Activation{Policy: ConsensusV2Policy, Height: 0, ApprovedBy: "genesis", EvidenceDigest: GenesisV2Evidence}); e != nil {
			return e
		}
		if g.GuardianThreshold < 2 && len(g.Guardians) > 1 {
			return errors.New("generation 2 genesis needs a guardian threshold")
		}
	}
	return put(k.Store, "guardians", g.Guardians)
}
