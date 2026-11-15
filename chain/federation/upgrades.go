package federation

import (
	"errors"
	"regexp"
)

// Software upgrade plans (9 November 2026). A guardian quorum schedules a
// named upgrade at a future height. At that height every node halts unless
// its binary registers a handler with that name; the new binary runs the
// handler once, in BeginBlock, and records completion. This replaces the
// earlier "keep every old path for replay" rule for consensus changes.

const MaxUpgradeDelay int64 = 1000000

type UpgradePlan struct {
	Name           string `json:"name"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
	Scheduled      int64  `json:"scheduled,string"`
}

var upgradeNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

func (k Keeper) scheduleUpgrade(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian quorum required")
	}
	var p struct {
		Name           string `json:"name"`
		Height         int64  `json:"height,string"`
		Cancel         bool   `json:"cancel,omitempty"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if c.Instance != "" || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("upgrade plan needs evidence")
	}
	if p.Cancel {
		if p.Name != "" || p.Height != 0 || k.Store.Get([]byte("upgrade_plan")) == nil {
			return "", errors.New("no upgrade plan to cancel")
		}
		k.Store.Delete([]byte("upgrade_plan"))
		return "upgrade_cancel", nil
	}
	if !upgradeNamePattern.MatchString(p.Name) || p.Height <= height+1 || p.Height > height+MaxUpgradeDelay {
		return "", errors.New("upgrade plan needs a name and a future height")
	}
	if k.Store.Get([]byte("upgrade_done/"+p.Name)) != nil {
		return "", errors.New("upgrade name already applied")
	}
	return p.Name, put(k.Store, "upgrade_plan", UpgradePlan{p.Name, p.Height, p.EvidenceDigest, height})
}

// PendingUpgrade returns the scheduled plan, if any.
func (k Keeper) PendingUpgrade() (*UpgradePlan, error) {
	if k.Store.Get([]byte("upgrade_plan")) == nil {
		return nil, nil
	}
	var p UpgradePlan
	if err := get(k.Store, "upgrade_plan", &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (k Keeper) UpgradeDone(name string) bool {
	return k.Store.Get([]byte("upgrade_done/"+name)) != nil
}

// CompleteUpgrade records a handler's completion and clears the plan.
func (k Keeper) CompleteUpgrade(p UpgradePlan, height int64) error {
	k.Store.Delete([]byte("upgrade_plan"))
	return put(k.Store, "upgrade_done/"+p.Name, height)
}

// QuotaCount is the number of commands member has had accepted at height in
// this store (the check state counts its unconfirmed commands).
func (k Keeper) QuotaCount(member string, height int64) int {
	var quota struct {
		Height int64 `json:"height"`
		Count  int   `json:"count"`
	}
	if get(k.Store, "quota/"+member, &quota) != nil || quota.Height != height {
		return 0
	}
	return quota.Count
}
