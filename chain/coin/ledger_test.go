package coin

import (
	"math/big"
	"math/rand"
	"testing"
)

func TestFullCapBeyondUint64AndUnmintedReservations(t *testing.T) {
	l, err := Empty().Reserve(SupplyCap)
	if err != nil || l.Minted != "0" || l.Transparent != "0" {
		t.Fatal("reservation preminted Coin", l, err)
	}
	if refused, e := l.Reserve("1"); e == nil || refused != l {
		t.Fatal("reserved above cap")
	}
	l, err = l.Mint(SupplyCap)
	if err != nil || l.Minted != SupplyCap || l.Transparent != SupplyCap || l.Reserved != "0" {
		t.Fatal("exact full cap accounting overflowed", l, err)
	}
	if n, _ := new(big.Int).SetString(l.Minted, 10); n.IsUint64() {
		t.Fatal("test did not exercise wide supply arithmetic")
	}
	if _, err = l.Shield("9223372036854775808"); err == nil {
		t.Fatal("accepted unrepresentable Orchard value balance")
	}
	l, err = l.Shield("9223372036854775807")
	if err != nil || l.Shielded != "9223372036854775807" {
		t.Fatal("maximum representable boundary failed", err)
	}
	l, err = l.Exit("9223372036854775807")
	if err != nil || l.Transparent != SupplyCap || l.Shielded != "0" {
		t.Fatal("boundary changed minted supply", l, err)
	}
	if available, err := l.Available(); err != nil || available != "0" {
		t.Fatal(available, err)
	}
}

func TestRejectMalformedAndInconsistentSupply(t *testing.T) {
	for _, s := range []string{"", "00", "01", "-1", "+1", "1.0", "1e6", " 1", "١", "108000000000000000001", "99999999999999999999999999999999999"} {
		if _, err := Empty().Reserve(s); err == nil {
			t.Fatal("accepted noncanonical or oversized Coin amount", s)
		}
	}
	for _, l := range []Ledger{{"1", "0", "0", "0"}, {"0", "1", "1", "0"}, {SupplyCap, "1", SupplyCap, "0"}} {
		if err := l.Validate(); err == nil {
			t.Fatal("accepted inconsistent supply", l)
		}
	}
	if _, err := Empty().Mint("1"); err == nil {
		t.Fatal("unreserved mint accepted")
	}
	if _, err := Empty().Exit("1"); err == nil {
		t.Fatal("unbacked private exit accepted")
	}
}

func TestConservationAcrossRandomizedBountyAndBoundarySchedule(t *testing.T) {
	rng := rand.New(rand.NewSource(108)) // reproducible fictional accounting only
	l := Empty()
	expectedMinted := big.NewInt(0)
	for i := 0; i < 2000; i++ {
		n := big.NewInt(int64(1 + rng.Intn(1000000))).String()
		before := l
		var next Ledger
		var err error
		switch rng.Intn(5) {
		case 0:
			next, err = l.Reserve(n)
		case 1:
			next, err = l.Release(n)
		case 2:
			next, err = l.Mint(n)
			if err == nil {
				x, _ := new(big.Int).SetString(n, 10)
				expectedMinted.Add(expectedMinted, x)
			}
		case 3:
			next, err = l.Shield(n)
		case 4:
			next, err = l.Exit(n)
		}
		if l != before {
			t.Fatal("transition mutated its caller before an atomic commit")
		}
		if err != nil {
			if next != before {
				t.Fatal("refused transition returned changed accounting", i)
			}
			continue
		}
		l = next
		if err := l.Validate(); err != nil || l.Minted != expectedMinted.String() {
			t.Fatal("schedule changed total issuance or backing", i, l, err)
		}
		available, err := l.Available()
		if err != nil {
			t.Fatal(err)
		}
		a, _ := new(big.Int).SetString(available, 10)
		r, _ := new(big.Int).SetString(l.Reserved, 10)
		if a.Add(a, r).Add(a, expectedMinted).String() != SupplyCap {
			t.Fatal("unminted allocation conservation failed")
		}
	}
}
