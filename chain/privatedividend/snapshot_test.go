package privatedividend

import (
	"github.com/uain-org/uain/chain/coin"
	"testing"
)

func TestSnapshotFullMintedDenominatorAndCheckpointFraming(t *testing.T) {
	ledger := coin.Ledger{Minted: "36893488147419103232", Reserved: "123", Transparent: "18446744073709551616", Shielded: "18446744073709551616"}
	var hash [32]byte
	hash[0] = 7
	s, err := NewSnapshot("chain-1", "receipt-1", "ethereum-mainnet", "ETH", 10, hash, ledger, [32]byte{}, [32]byte{}, "150")
	if err != nil {
		t.Fatal(err)
	}
	if s.Height != 10 || s.RecordedAt != 11 || s.Minted != ledger.Minted || s.Minted == ledger.Reserved {
		t.Fatal("wrong historical snapshot")
	}
	ctx := s.Context()
	changed := s
	changed.Receipt = "receipt-2"
	if ctx == changed.Context() {
		t.Fatal("receipt context collision")
	}
	changed = s
	changed.Checkpoint[1] = 1
	if ctx == changed.Context() {
		t.Fatal("checkpoint unbound")
	}
	changed = s
	changed.Minted = "36893488147419103231"
	if ctx == changed.Context() {
		t.Fatal("M unbound")
	}
	changed = s
	changed.Pool = "151"
	if ctx == changed.Context() {
		t.Fatal("P unbound")
	}
	ledger.Reserved = "124"
	same, err := NewSnapshot("chain-1", "receipt-1", "ethereum-mainnet", "ETH", 10, hash, ledger, [32]byte{}, [32]byte{}, "150")
	if err != nil || same.Context() != ctx {
		t.Fatal("unminted reservation reweights dividend")
	}
	for _, h := range []int64{0, -1, 9223372036854775807} {
		if _, err := NewSnapshot("c", "r", "n", "ETH", h, hash, ledger, [32]byte{}, [32]byte{}, "150"); err == nil {
			t.Fatal("invalid H")
		}
	}
	if _, err := NewSnapshot("c", "r", "n", "ETH", 10, hash, ledger, [32]byte{}, [32]byte{}, "01"); err == nil {
		t.Fatal("inexact pool")
	}
	ledger.Minted = "36893488147419103233"
	if _, err := NewSnapshot("c", "r", "n", "ETH", 10, hash, ledger, [32]byte{}, [32]byte{}, "150"); err == nil {
		t.Fatal("broken minted conservation")
	}
}
func TestCanonicalFieldRejectsAliasesAndAcceptsFullDomain(t *testing.T) {
	zero := [32]byte{}
	if !CanonicalField(zero) {
		t.Fatal("zero excluded")
	}
	p := fieldModulusLE()
	max := p
	for i := range max {
		if max[i] > 0 {
			max[i]--
			break
		}
		max[i] = 255
	}
	if !CanonicalField(max) || CanonicalField(p) || CanonicalField([32]byte{31: 255}) {
		t.Fatal("canonical bound")
	}
}
