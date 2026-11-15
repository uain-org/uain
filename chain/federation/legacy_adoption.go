package federation

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

type LegacyNativeCheckpoint struct {
	EventCount        uint64 `json:"event_count,string"`
	LastCommandDigest string `json:"last_command_digest"`
	AccountsDigest    string `json:"accounts_digest"`
}
type LegacyAdoption struct {
	ManifestDigest    string                 `json:"manifest_digest"`
	RecordsRoot       string                 `json:"records_root"`
	TotalRecords      uint64                 `json:"total_records,string"`
	Accounts          uint64                 `json:"accounts,string"`
	LedgerHead        string                 `json:"ledger_head"`
	LastEventID       int64                  `json:"last_event_id,string"`
	PinnedPublicKey   string                 `json:"pinned_public_key"`
	NativeCheckpoint  LegacyNativeCheckpoint `json:"native_checkpoint"`
	PriorLegacyDigest string                 `json:"prior_legacy_digest"`
}

func (k Keeper) LegacyNativeCheckpoint() (LegacyNativeCheckpoint, error) {
	out := LegacyNativeCheckpoint{}
	if k.Store.Get([]byte("event_count")) != nil {
		if e := get(k.Store, "event_count", &out.EventCount); e != nil {
			return out, e
		}
		var last Event
		if e := get(k.Store, fmt.Sprintf("event/%020d", out.EventCount), &last); e != nil {
			return out, e
		}
		out.LastCommandDigest = last.CommandDigest
	}
	hash := sha256.New()
	for _, prefix := range []string{"member/", "instance/"} {
		rows, e := k.Store.Range([]byte(prefix), []byte(prefix[:len(prefix)-1]+"0"), 1025)
		if e != nil {
			return out, e
		}
		if len(rows) > 1024 {
			return out, errors.New("native account checkpoint exceeds reviewed adoption bound")
		}
		for _, row := range rows {
			value := sha256.Sum256(row.Value)
			fmt.Fprintf(hash, "%s\n%x\n", row.Key, value)
		}
	}
	out.AccountsDigest = hex.EncodeToString(hash.Sum(nil))
	return out, nil
}
func (k Keeper) legacyAdopt(c Command) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("original chain guardian must approve source adoption")
	}
	if k.Store.Get([]byte("legacy_adoption")) != nil || k.Store.Get([]byte("legacy_import")) != nil {
		return "", errors.New("legacy adoption lineage already exists")
	}
	var p LegacyAdoption
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if !digestPattern.MatchString(p.ManifestDigest) || !digestPattern.MatchString(p.RecordsRoot) || !digestPattern.MatchString(p.LedgerHead) || p.TotalRecords < 1 || p.TotalRecords > 10000000 || p.Accounts < 1 || p.Accounts > 10000 || p.LastEventID < 0 || len(p.PinnedPublicKey) < 20 || len(p.PinnedPublicKey) > 1024 || p.PriorLegacyDigest != "" {
		return "", errors.New("complete bounded source commitment required")
	}
	checkpoint, e := k.LegacyNativeCheckpoint()
	if e != nil {
		return "", e
	}
	if checkpoint != p.NativeCheckpoint {
		return "", errors.New("native checkpoint drifted since guardian review")
	}
	prior := sha256.Sum256(k.Store.Get([]byte("legacy")))
	p.PriorLegacyDigest = hex.EncodeToString(prior[:])
	return p.ManifestDigest, put(k.Store, "legacy_adoption", p)
}
