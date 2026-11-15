package economy

import (
	"encoding/json"
	"testing"
)

// Catches allocation drift, accidental floating point arithmetic and value
// creation on tiny or larger-than-uint64 external currency amounts.
func TestPoolSplitConservesExternalUnits(t *testing.T) {
	for _, tc := range []struct{ amount, bounty, dividend, operations, dust string }{
		{"100", "80", "15", "5", "0"}, {"101", "80", "15", "5", "1"},
		{"1", "0", "0", "0", "1"}, {"19", "15", "2", "0", "2"},
		{"100000000000000000000", "80000000000000000000", "15000000000000000000", "5000000000000000000", "0"},
	} {
		p, err := Empty().Fund(tc.amount)
		if err != nil {
			t.Fatal(err)
		}
		if p.Funded != tc.amount || p.Bounty.Available != tc.bounty || p.Dividend.Available != tc.dividend || p.Operations.Available != tc.operations || p.Dust != tc.dust {
			t.Fatalf("%s: %+v", tc.amount, p)
		}
		if err = p.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

// Catches paying a reservation twice, releasing spent funds, and a transition
// mutating its input before validation rejects an underfunded request.
func TestPoolReservationsPaymentReleaseAndRefund(t *testing.T) {
	p, err := Empty().Fund("1000")
	if err != nil {
		t.Fatal(err)
	}
	p, err = p.Reserve("bounty", "700")
	if err != nil {
		t.Fatal(err)
	}
	p, err = p.Pay("bounty", "600")
	if err != nil {
		t.Fatal(err)
	}
	p, err = p.Release("bounty", "100")
	if err != nil {
		t.Fatal(err)
	}
	if p.Bounty.Available != "200" || p.Bounty.Reserved != "0" || p.Bounty.Paid != "600" {
		t.Fatalf("%+v", p)
	}
	before, _ := json.Marshal(p)
	for _, op := range []func() (Pool, error){func() (Pool, error) { return p.Pay("bounty", "1") }, func() (Pool, error) { return p.Reserve("bounty", "201") }, func() (Pool, error) { return p.Release("bounty", "1") }, func() (Pool, error) { return p.Refund("1000") }} {
		if _, err = op(); err == nil {
			t.Fatal("invalid movement accepted")
		}
		after, _ := json.Marshal(p)
		if string(before) != string(after) {
			t.Fatal("failed movement mutated pool")
		}
	}
	q, err := Empty().Fund("101")
	if err != nil {
		t.Fatal(err)
	}
	q, err = q.Refund("101")
	if err != nil {
		t.Fatal(err)
	}
	if q.Refunded != "101" || q.Bounty.Available != "0" || q.Dividend.Available != "0" || q.Operations.Available != "0" || q.Dust != "0" {
		t.Fatalf("%+v", q)
	}
	if _, err = q.Refund("101"); err == nil {
		t.Fatal("refund duplicated")
	}
}

// Catches unminted/reserved supply entering dividend denominators and assigns
// fractional external units to a separately conserved carry, never extra mint.
func TestDividendEntitlementUsesOnlyEligibleMintedHoldings(t *testing.T) {
	for _, tc := range []struct{ pool, holding, total, want string }{
		{"150", "3", "10", "45"}, {"15", "1", "7", "2"}, {"1", "1", "10", "0"},
		{"150000000000000000000", "3", "10", "45000000000000000000"},
	} {
		got, err := Entitlement(tc.pool, tc.holding, tc.total)
		if err != nil || got != tc.want {
			t.Fatalf("%+v: %s %v", tc, got, err)
		}
	}
	for _, in := range [][3]string{{"15", "1", "0"}, {"15", "11", "10"}, {"15", "-1", "10"}, {"01", "1", "10"}} {
		if _, err := Entitlement(in[0], in[1], in[2]); err == nil {
			t.Fatalf("invalid entitlement %+v", in)
		}
	}
}

func TestPoolRejectsMalformedAndCorruptedState(t *testing.T) {
	for _, amount := range []string{"0", "-1", "01", "1.0", "1e3", " 10", "1000000000000000000000000000000000000000000000000000000000000000000000000000000"} {
		if _, err := Empty().Fund(amount); err == nil {
			t.Fatal(amount)
		}
	}
	p, err := Empty().Fund("100")
	if err != nil {
		t.Fatal(err)
	}
	p.Bounty.Available = "81"
	if err = p.Validate(); err == nil {
		t.Fatal("unbacked pool accepted")
	}
	if _, err = p.Reserve("bounty", "1"); err == nil {
		t.Fatal("corrupted state used")
	}
	p = Empty()
	p.Refunded = "1"
	if err = p.Validate(); err == nil {
		t.Fatal("unbacked refund accepted")
	}
	p, err = Empty().Fund("100")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Reserve("unknown", "1"); err == nil {
		t.Fatal("unrecognized pool accepted")
	}
}
