package federation

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"
)

func activateHistory(t *testing.T, k Keeper, guardian actor, height int64) {
	t.Helper()
	command(t, k, guardian, "activate_recipient_history", map[string]any{"policy": RecipientHistoryPolicy, "evidence_digest": digest}, height)
}

func TestRecipientHistoryBackfillOrderAttributionAndFreshness(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	// Retain exact old bytes, including entries before activation. The new
	// indexes do not reinterpret credits as Coin or manufacture old events.
	old := map[string][]byte{}
	for i := uint64(1); i <= 70; i++ {
		owner, instance := lead.m.ID, "child-A"
		if i%3 == 0 {
			owner, instance = peer.m.ID, ""
		}
		id := fmt.Sprintf("%020d", i)
		row := CreditEntry{ID: id, Member: owner, Instance: instance, Amount: "1", Minted: "1", Deferred: "0"}
		if err := put(k.Store, "credit/"+id, row); err != nil {
			t.Fatal(err)
		}
		old["credit/"+id] = bytes.Clone(k.Store.Get([]byte("credit/" + id)))
	}
	if err := put(k.Store, "credit_count", uint64(70)); err != nil {
		t.Fatal(err)
	}
	activateHistory(t, k, guardian, 1)
	if _, err := apply(k, signed(t, k, peer, "recipient_history_page", map[string]any{"kind": "credit"}, 1), 1); err == nil {
		t.Fatal("following-height gate bypassed")
	}
	pages := (70 + HistoryBackfillLimit - 1) / HistoryBackfillLimit
	for page := 0; page < pages; page++ {
		command(t, k, peer, "recipient_history_page", map[string]any{"kind": "credit"}, int64(page+2))
		view, err := k.RecipientHistoryPage("credit", lead.m.ID, "", 0, 10)
		if err != nil {
			t.Fatal(err)
		}
		if view.IndexedThrough > uint64((page+1)*HistoryBackfillLimit) || view.Complete != (page == pages-1) {
			t.Fatal("backfill bound/freshness", view)
		}
	}
	view, err := k.RecipientHistoryPage("credit", lead.m.ID, "", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if view.Count != 47 || len(view.Entries) != 32 || view.NextPage == nil || *view.NextPage != 1 {
		t.Fatal(view)
	}
	last, err := k.RecipientHistoryPage("credit", lead.m.ID, "child-A", 1, 10)
	if err != nil || last.Count != 47 || len(last.Entries) != 15 || last.NextPage != nil {
		t.Fatal(last, err)
	}
	for key, raw := range old {
		if !bytes.Equal(raw, k.Store.Get([]byte(key))) {
			t.Fatal("rewrote historical journal", key)
		}
	}
	before, _ := json.Marshal(k.Store)
	if _, err = apply(k, signed(t, k, peer, "recipient_history_page", map[string]any{"kind": "credit"}, 10), 10); err == nil {
		t.Fatal("repeated caught-up work accepted")
	}
	after, _ := json.Marshal(k.Store)
	if !bytes.Equal(before, after) {
		t.Fatal("refused page changed state")
	}
	// A new real journal write stays unchanged and immediately makes the
	// materialized view explicitly incomplete until the next bounded command.
	if err = k.credit(lead.m.ID, "", "new-result", "reward", big.NewInt(2), time.Unix(100, 0), false, ""); err != nil {
		t.Fatal(err)
	}
	view, err = k.RecipientHistoryPage("credit", lead.m.ID, "", 1, 10)
	if err != nil || view.Complete || view.JournalHead != 71 || view.IndexedThrough != 70 {
		t.Fatal(view, err)
	}
	command(t, k, peer, "recipient_history_page", map[string]any{"kind": "credit"}, 11)
	view, err = k.RecipientHistoryPage("credit", lead.m.ID, "", 1, 11)
	if err != nil || !view.Complete || view.Count != 48 {
		t.Fatal(view, err)
	}
}

func TestRecipientHistoryRefusesCorruptionAndInvalidScopesAtomically(t *testing.T) {
	for _, kind := range []string{"credit", "karma"} {
		k, lead, peer, guardian := fixture(t)
		activateHistory(t, k, guardian, 1)
		for i := 1; i <= 3; i++ {
			id := fmt.Sprintf("%020d", i)
			if kind == "credit" {
				_ = put(k.Store, kind+"/"+id, CreditEntry{ID: id, Member: lead.m.ID})
			} else {
				_ = put(k.Store, kind+"/"+id, KarmaEntry{ID: id, Member: lead.m.ID})
			}
		}
		_ = put(k.Store, kind+"_count", uint64(3))
		k.Store.Delete([]byte(kind + "/00000000000000000003"))
		before, _ := json.Marshal(k.Store)
		if _, err := apply(k, signed(t, k, peer, "recipient_history_page", map[string]any{"kind": kind}, 2), 2); err == nil {
			t.Fatal("missing original journal accepted")
		}
		after, _ := json.Marshal(k.Store)
		if !bytes.Equal(before, after) {
			t.Fatal("partial backfill committed")
		}
		for _, bad := range []string{"coin", "../credit", strings.Repeat("x", 100)} {
			if _, err := apply(k, signed(t, k, peer, "recipient_history_page", map[string]any{"kind": bad}, 2), 2); err == nil {
				t.Fatal("invalid kind accepted")
			}
		}
	}
}

func TestRecipientHistoryActivationAndEmptyJournal(t *testing.T) {
	k, lead, peer, guardian := fixture(t)
	payload := map[string]any{"policy": RecipientHistoryPolicy, "evidence_digest": digest}
	if _, err := apply(k, signed(t, k, peer, "activate_recipient_history", payload, 1), 1); err == nil {
		t.Fatal("non-guardian activation")
	}
	activateHistory(t, k, guardian, 1)
	if _, err := apply(k, signed(t, k, guardian, "activate_recipient_history", payload, 2), 2); err == nil {
		t.Fatal("repeated activation")
	}
	view, err := k.RecipientHistoryPage("karma", lead.m.ID, "", 0, 2)
	if err != nil || !view.Complete || len(view.Entries) != 0 || view.Count != 0 {
		t.Fatal(view, err)
	}
	if _, err = k.RecipientHistoryPage("karma", lead.m.ID, "", 1, 2); err == nil {
		t.Fatal("empty out-of-range page")
	}
	if _, err = k.RecipientHistoryPage("karma", lead.m.ID, "../child", 0, 2); err == nil {
		t.Fatal("invalid actor scope")
	}
}
