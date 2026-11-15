package federation

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"github.com/uain-org/uain/chain/coin"
	"github.com/uain-org/uain/chain/economy"
	pd "github.com/uain-org/uain/chain/privatedividend"
	"testing"
)

// Hash model qualifies state transitions only; linked FFI tests qualify Poseidon.
type dividendModelHash struct{}

func (dividendModelHash) Empty(h uint16) ([32]byte, error) {
	v := sha256.Sum256([]byte("empty"))
	for i := uint16(0); i < h; i++ {
		v, _ = dividendModelHash{}.Node(i, v, v)
	}
	return v, nil
}
func (dividendModelHash) Leaf(k [32]byte) ([32]byte, error) {
	v := sha256.Sum256(append([]byte("leaf"), k[:]...))
	v[31] &= 0x3f
	return v, nil
}
func (dividendModelHash) Node(h uint16, l, r [32]byte) ([32]byte, error) {
	b := make([]byte, 66)
	binary.LittleEndian.PutUint16(b, h)
	copy(b[2:], l[:])
	copy(b[34:], r[:])
	v := sha256.Sum256(b)
	v[31] &= 0x3f
	return v, nil
}
func dividendSeed(t *testing.T, amount string, ledger coin.Ledger) (Keeper, FundingReceipt) {
	t.Helper()
	k := Keeper{Store: memory{}}
	receipt := FundingReceipt{ID: "DR-1", Campaign: "DC-1", Amount: amount, State: "confirmed"}
	pool, e := economy.Empty().Fund(amount)
	if e != nil {
		t.Fatal(e)
	}
	for key, v := range map[string]any{"dividend_activation": DividendActivation{Policy: DividendPolicy, Height: 1}, "dividend_spent_state": dividendSpentState{Version: DividendPolicy}, "coin_supply": ledger, "private_frontier": PrivateFrontier{Root: fmt.Sprintf("%064x", 0)}, "funding_receipt/DR-1": receipt, "funding_campaign/DC-1": FundingCampaign{ID: "DC-1", Network: "ethereum:1", Asset: "native"}, "funding_pool/DR-1": pool} {
		if e := put(k.Store, key, v); e != nil {
			t.Fatal(e)
		}
	}
	return k, receipt
}
func TestDividendCaptureUsesEndHWholeMintedAndReservesWholePoolOnce(t *testing.T) {
	k, r := dividendSeed(t, "101", coin.Ledger{Minted: "1", Reserved: "3", Transparent: "1", Shielded: "0"})
	if e := k.queueDividendSnapshot(r, 10); e != nil {
		t.Fatal(e)
	}
	// A later Coin transaction in H changes the supply before canonical capture.
	end := coin.Ledger{Minted: "36893488147419103232", Reserved: "3", Transparent: "18446744073709551616", Shielded: "18446744073709551616"}
	if e := put(k.Store, "coin_supply", end); e != nil {
		t.Fatal(e)
	}
	hash := make([]byte, 32)
	hash[0] = 7
	if e := k.captureDividendSnapshotsWithHash("chain-1", 11, hash, dividendModelHash{}); e != nil {
		t.Fatal(e)
	}
	var record DividendSnapshot
	if e := get(k.Store, "dividend_snapshot/DR-1", &record); e != nil {
		t.Fatal(e)
	}
	if record.Snapshot.Height != 10 || record.Snapshot.RecordedAt != 11 || record.Snapshot.Minted != end.Minted || record.Snapshot.Pool != "15" || record.Status != "active" {
		t.Fatalf("wrong snapshot %+v", record)
	}
	var pool economy.Pool
	get(k.Store, "funding_pool/DR-1", &pool)
	if pool.Dividend.Available != "0" || pool.Dividend.Reserved != "15" || pool.Dividend.Paid != "0" {
		t.Fatalf("disclosed or missing private liability %+v", pool)
	}
	before, _ := json.Marshal(record)
	if e := k.captureDividendSnapshotsWithHash("chain-1", 12, hash, dividendModelHash{}); e != nil {
		t.Fatal(e)
	}
	after := k.Store.Get([]byte("dividend_snapshot/DR-1"))
	if string(before) != string(after) {
		t.Fatal("snapshot rewritten")
	}
	if e := k.queueDividendSnapshot(r, 12); e == nil {
		t.Fatal("duplicate snapshot queued")
	}
}
func TestDividendZeroSupplyOrPoolDoesNotHaltOrReweight(t *testing.T) {
	for _, amount := range []string{"101", "1"} {
		k, r := dividendSeed(t, amount, coin.Empty())
		if e := k.queueDividendSnapshot(r, 10); e != nil {
			t.Fatal(e)
		}
		if e := k.captureDividendSnapshotsWithHash("chain-1", 11, make([]byte, 32), dividendModelHash{}); e != nil {
			t.Fatal(e)
		}
		var record DividendSnapshot
		get(k.Store, "dividend_snapshot/DR-1", &record)
		if record.Status == "active" || record.Snapshot.Minted != "0" {
			t.Fatal("empty denominator accepted")
		}
		var pool economy.Pool
		get(k.Store, "funding_pool/DR-1", &pool)
		if pool.Dividend.Reserved != "0" {
			t.Fatal("zero supply reserved funds")
		}
		if _, e := pool.Refund(amount); e != nil {
			t.Fatal("nonclaimable funding no longer refundable", e)
		}
	}
}
func TestDividendPolicyOffHistoricalFundingAndQueueBound(t *testing.T) {
	k := Keeper{Store: memory{}}
	if e := k.queueDividendSnapshot(FundingReceipt{ID: "old"}, 10); e != nil {
		t.Fatal(e)
	}
	if e := k.CaptureDividendSnapshots("c", 11, make([]byte, 32)); e != nil {
		t.Fatal(e)
	}
	if len(k.Store.(memory)) != 0 {
		t.Fatal("policy-off state changed")
	}
	put(k.Store, "dividend_activation", DividendActivation{Policy: DividendPolicy, Height: 1})
	put(k.Store, "dividend_spent_state", dividendSpentState{Version: DividendPolicy})
	for i := 0; i < DividendPendingLimit; i++ {
		if e := k.queueDividendSnapshot(FundingReceipt{ID: fmt.Sprintf("r%d", i), State: "confirmed"}, 10); e != nil {
			t.Fatal(e)
		}
	}
	if e := k.queueDividendSnapshot(FundingReceipt{ID: "overflow", State: "confirmed"}, 10); e == nil {
		t.Fatal("unbounded queue")
	}
}

var _ pd.Hasher = dividendModelHash{}
