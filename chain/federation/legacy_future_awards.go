package federation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// The immutable prospective hold preserves eligibility and amounts before any
// later KPI decision. Original imported hold/check bytes remain authoritative.
type LegacyFutureFrozen struct {
	Contribution string        `json:"contribution"`
	Task         string        `json:"task"`
	Project      string        `json:"project"`
	Author       string        `json:"author"`
	Member       string        `json:"member"`
	Held         LegacyHeld    `json:"held"`
	Checks       []LegacyCheck `json:"checks"`
}

func legacyFrozenSnapshot(w LegacyWork) (LegacyFutureFrozen, error) {
	f := LegacyFutureFrozen{Contribution: w.ID, Task: w.Task, Project: w.Project, Author: w.Author, Member: w.Member, Checks: []LegacyCheck{}}
	if w.Held == nil {
		return f, errors.New("immutable verified hold required")
	}
	f.Held = *w.Held
	refs := append([]string{}, w.Held.CheckRefs...)
	if len(refs) == 0 {
		for _, id := range w.Held.Verifications {
			refs = append(refs, fmt.Sprint(id))
		}
	}
	if len(refs) > 32 || w.Held.Credibility < 0 || w.Held.Credibility > MaxReward || w.Held.Credits < 0 || w.Held.Credits > MaxReward {
		return f, errors.New("bounded frozen original award required")
	}
	seen := map[string]bool{}
	for _, id := range refs {
		if seen[id] {
			return f, errors.New("duplicate frozen verifier reference")
		}
		seen[id] = true
		found := false
		for _, c := range w.Checks {
			if c.ID == id && c.Verdict != "disputed" {
				if c.Member == w.Member {
					return f, errors.New("frozen verifier cannot be author member")
				}
				f.Checks = append(f.Checks, c)
				found = true
				break
			}
		}
		if !found {
			return f, errors.New("original frozen verifier reference missing")
		}
	}
	return f, nil
}
func legacyFreezeAward(s Store, w LegacyWork) error {
	if w.Pending != "kpi" || w.Held == nil {
		return nil
	}
	f, e := legacyFrozenSnapshot(w)
	if e != nil {
		return e
	}
	raw, e := json.Marshal(f)
	if e != nil {
		return e
	}
	key := []byte("legacy_future_hold/" + w.ID)
	if old := s.Get(key); old != nil {
		if !bytes.Equal(old, raw) {
			return errors.New("immutable future hold changed")
		}
		return nil
	}
	s.Set(key, raw)
	return nil
}

type LegacyFutureAwardSlot struct {
	Member   string `json:"member"`
	Instance string `json:"instance"`
	Credits  int64  `json:"credits"`
	Karma    int64  `json:"karma"`
	Kind     string `json:"kind"`
}
type LegacyFutureAward struct {
	Contribution string                  `json:"contribution"`
	Task         string                  `json:"task"`
	Project      string                  `json:"project"`
	HoldDigest   string                  `json:"hold_digest"`
	Outcome      string                  `json:"outcome"`
	Slots        []LegacyFutureAwardSlot `json:"slots"`
}
type LegacyFutureAwardProgress struct {
	Applied int `json:"applied"`
	Total   int `json:"total"`
}

func (k Keeper) legacyStageAward(w *LegacyWork, karma, credits int64, checks []LegacyCheck) error {
	key := "legacy_future_award/" + w.ID
	if k.Store.Get([]byte(key)) != nil {
		return errors.New("immutable future award already staged")
	}
	frozen, e := legacyFrozenSnapshot(*w)
	if e != nil {
		return e
	}
	raw, e := json.Marshal(frozen)
	if e != nil {
		return e
	}
	if old := k.Store.Get([]byte("legacy_future_hold/" + w.ID)); old != nil && !bytes.Equal(old, raw) {
		return errors.New("future hold differs from pre-decision eligibility snapshot")
	}
	sum := sha256.Sum256(raw)
	task, e := k.legacyTask(w.Task)
	if e != nil {
		return e
	}
	plan := LegacyFutureAward{Contribution: w.ID, Task: w.Task, Project: w.Project, HoldDigest: hex.EncodeToString(sum[:]), Outcome: task.Outcome, Slots: []LegacyFutureAwardSlot{{w.Member, w.Author, credits, karma, "legacy_verified"}}}
	pool := credits / 5
	for i, c := range checks {
		n := pool / int64(len(checks))
		if int64(i) < pool%int64(len(checks)) {
			n++
		}
		plan.Slots = append(plan.Slots, LegacyFutureAwardSlot{c.Member, c.Verifier, n, 0, "legacy_verifier_share"})
	}
	if len(plan.Slots) > 33 {
		return errors.New("future recipient bound")
	}
	if e = put(k.Store, key, plan); e != nil {
		return e
	}
	if e = put(k.Store, "legacy_future_award_progress/"+w.ID, LegacyFutureAwardProgress{Total: len(plan.Slots)}); e != nil {
		return e
	}
	w.Pending = "kpi_award"
	return put(k.Store, "legacy_work/"+w.ID, *w)
}
func (k Keeper) legacyApplyAwardSlot(w *LegacyWork, task LegacyTask, recipient *int, member, evidence string, now time.Time) error {
	var plan LegacyFutureAward
	if e := get(k.Store, "legacy_future_award/"+w.ID, &plan); e != nil {
		return e
	}
	if plan.Contribution != w.ID || plan.Task != task.ID || plan.Project != task.Project || plan.Outcome != task.Outcome || task.Outcome != "met" || len(plan.Slots) < 1 || len(plan.Slots) > 33 || w.Pending != "kpi_award" || w.Paid {
		return errors.New("immutable pending future award plan required")
	}
	var progress LegacyFutureAwardProgress
	if e := get(k.Store, "legacy_future_award_progress/"+w.ID, &progress); e != nil {
		return e
	}
	if progress.Total != len(plan.Slots) || progress.Applied < 0 || progress.Applied >= progress.Total {
		return errors.New("invalid future award progress")
	}
	index := -1
	if recipient != nil {
		index = *recipient
	} else {
		for i := range plan.Slots {
			if k.Store.Get([]byte(fmt.Sprintf("legacy_future_award_slot/%s/%02d", w.ID, i))) == nil {
				index = i
				break
			}
		}
	}
	if index < 0 || index >= len(plan.Slots) {
		return errors.New("future recipient index outside immutable plan")
	}
	key := fmt.Sprintf("legacy_future_award_slot/%s/%02d", w.ID, index)
	if k.Store.Get([]byte(key)) != nil {
		return errors.New("future recipient slot already applied")
	}
	slot := plan.Slots[index]
	withheld := ""
	if k.Store.Get([]byte("legacy_malevolent/"+task.Project+"/"+task.ID)) != nil {
		withheld = "malevolent"
	} else if task.Known {
		withheld = "known"
	} else if task.Outcome == "expired" {
		withheld = "kpi_expired"
	}
	project, e := k.legacyProject(task.Project)
	if e != nil {
		return e
	}
	if withheld == "" && project.State == "halted" {
		return errors.New("original project halted before award materialization")
	}
	if withheld == "" {
		why, e := k.recipientReason(slot.Member, slot.Instance)
		if e != nil {
			return e
		}
		if why != "" {
			return errors.New("future recipient slot currently ineligible; retry after eligibility recovery")
		}
		policy, e := k.legacyPublicPolicy()
		if e != nil {
			return e
		}
		cap := big.NewInt(DailyCreditCap)
		if policy != nil {
			cap, e = money(policy.DailyCreditCap)
			if e != nil {
				return e
			}
		}
		issued, e := k.IssuedLast24h(now)
		if e != nil {
			return e
		}
		if new(big.Int).Sub(cap, issued).Cmp(big.NewInt(slot.Credits)) < 0 {
			return errors.New("future recipient slot paused by original rolling issuance cap")
		}
	}
	counter := func(key string) (uint64, error) {
		var n uint64
		if k.Store.Get([]byte(key)) != nil {
			if e := get(k.Store, key, &n); e != nil {
				return 0, e
			}
		}
		return n, nil
	}
	beforeCredit, e := counter("credit_count")
	if e != nil {
		return e
	}
	beforeKarma, e := counter("karma_count")
	if e != nil {
		return e
	}
	if withheld == "" && slot.Karma != 0 {
		if e = k.recordKarma(slot.Member, slot.Instance, slot.Karma, slot.Kind, w.ID, now); e != nil {
			return e
		}
	}
	if withheld == "" {
		if e = k.legacyCredit(slot.Member, slot.Instance, w.ID, slot.Kind, big.NewInt(slot.Credits), now); e != nil {
			return e
		}
	}
	afterCredit, e := counter("credit_count")
	if e != nil {
		return e
	}
	afterKarma, e := counter("karma_count")
	if e != nil {
		return e
	}
	journal := ""
	karmaJournal := ""
	if afterCredit != beforeCredit {
		journal = fmt.Sprintf("%020d", afterCredit)
	}
	if afterKarma != beforeKarma {
		karmaJournal = fmt.Sprintf("%020d", afterKarma)
	}
	if e = put(k.Store, key, map[string]any{"contribution": w.ID, "recipient": index, "slot": slot, "withheld": withheld, "credit_journal": journal, "karma_journal": karmaJournal, "member": member, "evidence_digest": evidence, "at": now.UTC().Format(time.RFC3339Nano)}); e != nil {
		return e
	}
	progress.Applied++
	if e = put(k.Store, "legacy_future_award_progress/"+w.ID, progress); e != nil {
		return e
	}
	if progress.Applied == progress.Total {
		w.Pending = ""
		w.Withheld = withheld
		w.Paid = true
		return put(k.Store, "legacy_work/"+w.ID, *w)
	}
	return nil
}
