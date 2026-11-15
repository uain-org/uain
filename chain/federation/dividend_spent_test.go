package federation

import (
	"encoding/hex"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"testing"
)

func TestDividendHistoricalSpentRebuildIsCompleteBoundedAndCannotSkip(t *testing.T) {
	k := Keeper{Store: memory{}}
	model := dividendModelHash{}
	reference := pd.Tree{Store: memory{}, Hash: model}
	for i := 0; i < 100; i++ {
		nf := [32]byte{byte(i)}
		put(k.Store, dividendNullifierKey(nf), "accepted-payment")
		if e := reference.Insert(nf); e != nil {
			t.Fatal(e)
		}
	}
	if e := k.appendDividendSpentWithHash([][32]byte{{200}}, model); e != ErrDividendSpentRebuild {
		t.Fatal("history silently omitted", e)
	}
	cursor, done, e := k.rebuildDividendSpentWithHash("", model)
	if e != nil || done || cursor == "" {
		t.Fatal("wrong first bounded page", cursor, done, e)
	}
	if _, _, e = k.rebuildDividendSpentWithHash("private_nullifier/ffff", model); e == nil {
		t.Fatal("caller skipped canonical history")
	}
	pages := 1
	for !done {
		k = Keeper{Store: k.Store}
		cursor, done, e = k.rebuildDividendSpentWithHash(cursor, model)
		if e != nil {
			t.Fatal(e)
		}
		pages++
		if pages > 101 {
			t.Fatal("unbounded reconstruction")
		}
	}
	if pages != 100 {
		t.Fatal("wrong bounded page count", pages)
	}
	tree, state, e := k.ensureDividendSpent(model)
	if e != nil || state.Count != 100 {
		t.Fatal("wrong authenticated count", state, e)
	}
	got, _ := tree.Root()
	want, _ := reference.Root()
	if got != want {
		t.Fatal("accepted history root incomplete")
	}
	if e = k.appendDividendSpentWithHash([][32]byte{{200}}, model); e != nil {
		t.Fatal(e)
	}
	put(k.Store, dividendNullifierKey([32]byte{200}), "new-payment")
	tree, state, e = k.ensureDividendSpent(model)
	if e != nil || state.Count != 101 {
		t.Fatal("new spend not appended")
	}
	if _, _, e = k.rebuildDividendSpentWithHash("", model); e == nil {
		t.Fatal("complete tree reset permitted")
	}
}
func TestDividendSpentRebuildRejectsMalformedNativeHistory(t *testing.T) {
	k := Keeper{Store: memory{}}
	bad := [32]byte{31: 255}
	put(k.Store, "private_nullifier/"+hex.EncodeToString(bad[:]), "invalid")
	if _, _, e := k.rebuildDividendSpentWithHash("", dividendModelHash{}); e == nil {
		t.Fatal("field alias accepted")
	}
}

func TestDividendUnstartedTrackingPreservesHistoricalPrivatePaymentWrites(t *testing.T) {
	k := Keeper{Store: memory{}}
	put(k.Store, dividendNullifierKey([32]byte{1}), "old-accepted-payment")
	before := len(k.Store.(memory))
	if e := k.appendDividendSpent([][32]byte{{2}}); e != nil {
		t.Fatal(e)
	}
	if len(k.Store.(memory)) != before || k.Store.Get([]byte("dividend_spent_state")) != nil {
		t.Fatal("pretracking replay acquired state")
	}
	// Beginning a multi-page reconstruction prevents contemporaneous spends.
	for i := 2; i < 70; i++ {
		put(k.Store, dividendNullifierKey([32]byte{byte(i)}), "old")
	}
	if _, done, e := k.rebuildDividendSpentWithHash("", dividendModelHash{}); e != nil || done {
		t.Fatal(e, done)
	}
	if e := k.appendDividendSpentWithHash([][32]byte{{200}}, dividendModelHash{}); e != ErrDividendSpentRebuild {
		t.Fatal("incomplete tracking admitted a spend", e)
	}
}

func TestDividendConfirmationRequiresCompletedTrackingBeforeQueue(t *testing.T) {
	k := Keeper{Store: memory{}}
	put(k.Store, "dividend_activation", DividendActivation{Policy: DividendPolicy, Height: 1})
	if e := k.queueDividendSnapshot(FundingReceipt{ID: "FR-ready", State: "confirmed"}, 10); e != ErrDividendSpentRebuild {
		t.Fatal("confirmation queued without complete historical accumulator", e)
	}
	if k.Store.Get([]byte("dividend_pending/FR-ready")) != nil {
		t.Fatal("unready confirmation mutated queue")
	}
}
