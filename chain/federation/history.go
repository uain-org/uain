package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

const RecipientHistoryPolicy = "recipient-history-v1"
const HistoryBackfillLimit = 8
const HistoryPageSize = 32

type HistoryProgress struct {
	Policy string `json:"policy"`
	Cursor uint64 `json:"cursor,string"`
}

type HistoryIDs struct {
	IDs []string `json:"ids"`
}

type RecipientHistory struct {
	Policy         string            `json:"policy"`
	Kind           string            `json:"kind"`
	Member         string            `json:"member"`
	Instance       string            `json:"instance,omitempty"`
	Page           uint64            `json:"page,string"`
	Count          uint64            `json:"count,string"`
	IndexedThrough uint64            `json:"indexed_through,string"`
	JournalHead    uint64            `json:"journal_head,string"`
	Complete       bool              `json:"complete"`
	Entries        []json.RawMessage `json:"entries"`
	NextPage       *uint64           `json:"next_page,string,omitempty"`
}

func historyKind(kind string) bool { return kind == "credit" || kind == "karma" }

func HistoryPrefix(kind, member, instance string) (string, error) {
	if !historyKind(kind) || !validID(member) || (instance != "" && !validID(instance)) {
		return "", errors.New("history requires credit or karma and bounded recipient IDs")
	}
	if instance != "" {
		return "recipient_history/" + kind + "/instance/" + member + "/" + instance, nil
	}
	return "recipient_history/" + kind + "/member/" + member, nil
}

func HistoryKeys(kind, member, instance string, page uint64) ([]string, error) {
	prefix, err := HistoryPrefix(kind, member, instance)
	if err != nil {
		return nil, err
	}
	return []string{"recipient_history_activation", kind + "_count", "recipient_history_progress/" + kind, prefix + "/count", fmt.Sprintf("%s/page/%020d", prefix, page)}, nil
}

func (k Keeper) historyActivation(height int64) error {
	var a MembershipActivation
	if err := get(k.Store, "recipient_history_activation", &a); err != nil {
		return err
	}
	if a.Policy != RecipientHistoryPolicy || a.EffectiveHeight < 2 || height < a.EffectiveHeight {
		return errors.New("recipient history is not active at this height")
	}
	return nil
}

func (k Keeper) activateRecipientHistory(c Command, height int64) (string, error) {
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !k.guardian(c.Member) || p.Policy != RecipientHistoryPolicy || !digestPattern.MatchString(p.EvidenceDigest) || height < 1 || height == math.MaxInt64 || k.Store.Get([]byte("recipient_history_activation")) != nil {
		return "", errors.New("history activation requires guardian, evidence and an unscheduled following height")
	}
	a := MembershipActivation{p.Policy, height + 1, c.Member, p.EvidenceDigest}
	return p.Policy, put(k.Store, "recipient_history_activation", a)
}

func historyCounter(s Store, key string) (uint64, error) {
	var n uint64
	if s.Get([]byte(key)) != nil {
		if err := get(s, key, &n); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func (k Keeper) historyProgress(kind string) (HistoryProgress, uint64, error) {
	p := HistoryProgress{Policy: RecipientHistoryPolicy}
	key := "recipient_history_progress/" + kind
	if k.Store.Get([]byte(key)) != nil {
		if err := get(k.Store, key, &p); err != nil {
			return p, 0, err
		}
	}
	head, err := historyCounter(k.Store, kind+"_count")
	if err != nil {
		return p, 0, err
	}
	if p.Policy != RecipientHistoryPolicy || p.Cursor > head {
		return p, 0, errors.New("inconsistent recipient history progress")
	}
	return p, head, nil
}

func historyOwner(kind, id string, raw []byte) (string, string, error) {
	var row struct {
		ID       string `json:"id"`
		Member   string `json:"member"`
		Instance string `json:"instance"`
	}
	if len(raw) == 0 || len(raw) > MaxEnvelopeBytes || json.Unmarshal(raw, &row) != nil || row.ID != id {
		return "", "", errors.New("missing or inconsistent immutable journal row")
	}
	if _, err := HistoryPrefix(kind, row.Member, row.Instance); err != nil {
		return "", "", err
	}
	return row.Member, row.Instance, nil
}

func (k Keeper) appendHistory(kind, member, instance, id string) error {
	prefix, err := HistoryPrefix(kind, member, instance)
	if err != nil {
		return err
	}
	n, err := historyCounter(k.Store, prefix+"/count")
	if err != nil || n == math.MaxUint64 {
		return errors.New("invalid or exhausted recipient history count")
	}
	pageKey := fmt.Sprintf("%s/page/%020d", prefix, n/HistoryPageSize)
	page := HistoryIDs{IDs: []string{}}
	if k.Store.Get([]byte(pageKey)) != nil {
		if err = get(k.Store, pageKey, &page); err != nil {
			return err
		}
	}
	if len(page.IDs) != int(n%HistoryPageSize) || (len(page.IDs) != 0 && page.IDs[len(page.IDs)-1] >= id) {
		return errors.New("inconsistent recipient history page order")
	}
	page.IDs = append(page.IDs, id)
	if err = put(k.Store, pageKey, page); err != nil {
		return err
	}
	return put(k.Store, prefix+"/count", n+1)
}

// Materialization is a separate bounded command. Existing payout paths and
// immutable journals retain their exact writes and gas behavior. New rows are
// indexed on subsequent calls in original global journal order, never ahead
// of historical rows. The cursor proves the complete indexed prefix.
func (k Keeper) advanceRecipientHistory(c Command, height int64) (string, error) {
	var p struct {
		Kind string `json:"kind"`
	}
	if err := Decode(c.Payload, &p); err != nil {
		return "", err
	}
	if !historyKind(p.Kind) {
		return "", errors.New("history kind must be credit or karma")
	}
	if err := k.historyActivation(height); err != nil {
		return "", err
	}
	progress, head, err := k.historyProgress(p.Kind)
	if err != nil {
		return "", err
	}
	if progress.Cursor == head {
		return "", errors.New("recipient history already caught up")
	}
	end := head
	if head-progress.Cursor > HistoryBackfillLimit {
		end = progress.Cursor + HistoryBackfillLimit
	}
	for progress.Cursor < end {
		id := fmt.Sprintf("%020d", progress.Cursor+1)
		raw := k.Store.Get([]byte(p.Kind + "/" + id))
		member, instance, err := historyOwner(p.Kind, id, raw)
		if err != nil {
			return "", err
		}
		if err = k.appendHistory(p.Kind, member, "", id); err != nil {
			return "", err
		}
		if instance != "" {
			if err = k.appendHistory(p.Kind, member, instance, id); err != nil {
				return "", err
			}
		}
		progress.Cursor++
	}
	return p.Kind, put(k.Store, "recipient_history_progress/"+p.Kind, progress)
}

// RecipientHistoryPage reconstructs at most 32 original journal rows. Its
// completion flag covers the native journal only; legacy opening balances and
// pre-migration pilot history require their own separately verified evidence.
func (k Keeper) RecipientHistoryPage(kind, member, instance string, page uint64, height int64) (RecipientHistory, error) {
	out := RecipientHistory{Policy: RecipientHistoryPolicy, Kind: kind, Member: member, Instance: instance, Page: page, Entries: []json.RawMessage{}}
	keys, err := HistoryKeys(kind, member, instance, page)
	if err != nil {
		return out, err
	}
	if err = k.historyActivation(height); err != nil {
		return out, err
	}
	progress, head, err := k.historyProgress(kind)
	if err != nil {
		return out, err
	}
	count, err := historyCounter(k.Store, keys[3])
	if err != nil || count > progress.Cursor || (count == 0 && page != 0) || (count != 0 && page > (count-1)/HistoryPageSize) {
		return out, errors.New("invalid recipient history count or page")
	}
	out.Count, out.IndexedThrough, out.JournalHead, out.Complete = count, progress.Cursor, head, progress.Cursor == head
	ids := HistoryIDs{IDs: []string{}}
	if k.Store.Get([]byte(keys[4])) != nil {
		if err = get(k.Store, keys[4], &ids); err != nil {
			return out, err
		}
	}
	want := count - page*HistoryPageSize
	if want > HistoryPageSize {
		want = HistoryPageSize
	}
	if uint64(len(ids.IDs)) != want {
		return out, errors.New("recipient history page is incomplete")
	}
	previous := ""
	for _, id := range ids.IDs {
		if len(id) != 20 || id <= previous || id > fmt.Sprintf("%020d", progress.Cursor) || id == "00000000000000000000" {
			return out, errors.New("invalid recipient journal order")
		}
		for _, digit := range id {
			if digit < '0' || digit > '9' {
				return out, errors.New("invalid recipient journal ID")
			}
		}
		raw := k.Store.Get([]byte(kind + "/" + id))
		owner, actor, err := historyOwner(kind, id, raw)
		if err != nil || owner != member || (instance != "" && actor != instance) {
			return out, errors.New("recipient journal owner or content mismatch")
		}
		out.Entries = append(out.Entries, json.RawMessage(raw))
		previous = id
	}
	if count-page*HistoryPageSize > HistoryPageSize {
		next := page + 1
		out.NextPage = &next
	}
	return out, nil
}
