//go:build orchard && cgo

package federation

import (
	pd "github.com/uain-org/uain/chain/privatedividend"
	"strings"
	"testing"
)

func TestDividendActualFundingConfirmationThenCoinClaimSameH(t *testing.T) {
	k, lead, peer, guardian := coinFixture(t)
	command(t, k, guardian, "activate_funding", map[string]any{"policy": FundingPolicy, "evidence_digest": digest, "observers": []string{peer.m.ID, guardian.m.ID}}, 7)
	fixtureTreasuryEscrow(t, k, lead, guardian, "ethereum:1", "0x1111111111111111111111111111111111111111")
	command(t, k, lead, "funding_campaign", map[string]any{"id": "FC-1", "project": "P-1", "network": "ethereum:1", "asset": "native", "escrow": "0x1111111111111111111111111111111111111111", "decimals": 18, "evidence_digest": digest}, 8)
	command(t, k, lead, "external_wallet_bind", evmWalletPayload(k, lead, 8), 8)
	command(t, k, guardian, "dividend_spent_rebuild", map[string]string{"cursor": ""}, 8)
	put(k.Store, "dividend_activation", DividendActivation{Policy: DividendPolicy, Height: 8})
	quote := quoteFixtureTask(t, k, lead, "T-dividend", 2, false, 9)
	command(t, k, lead, "coin_quote", quote, 10)
	command(t, k, guardian, "coin_reserve", map[string]any{"task": "T-dividend", "evidence_digest": digest}, 11)
	command(t, k, lead, "submit", map[string]any{"id": "RC-T-dividend", "task": "T-dividend", "evidence_digest": digest}, 12)
	checkWork(t, k, peer, "T-dividend", 13)
	checkWork(t, k, guardian, "T-dividend", 14)
	command(t, k, lead, "funding_file", fundingDeposit("FR-dividend"), 13)
	att := fundingCheck("FR-dividend", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	command(t, k, peer, "funding_attest", att, 14)
	command(t, k, guardian, "funding_attest", att, 15)
	if k.Store.Get([]byte("dividend_pending/FR-dividend")) == nil {
		t.Fatal("confirmed receipt not queued")
	}
	before, e := k.coinLedger()
	if e != nil || before.Minted != "0" {
		t.Fatal(before, e)
	}
	command(t, k, lead, "coin_claim", map[string]any{"contribution": "RC-T-dividend"}, 15)
	if e = k.CaptureDividendSnapshots("uain-test-1", 16, make([]byte, 32)); e != nil {
		t.Fatal(e)
	}
	var record DividendSnapshot
	if e = get(k.Store, "dividend_snapshot/FR-dividend", &record); e != nil {
		t.Fatal(e)
	}
	if record.Status != "active" || record.Snapshot.Height != 15 || record.Snapshot.Minted != "5000000" || record.Snapshot.Pool != "15" {
		t.Fatalf("snapshot ignored later same-H Coin claim %+v", record)
	}
}

func TestDividendLinkedCanonicalHistoryRootMatchesPoseidon(t *testing.T) {
	k := Keeper{Store: memory{}}
	reference := pd.Tree{Store: memory{}, Hash: pd.Poseidon{}}
	for i := 0; i < 100; i++ {
		nf := [32]byte{byte(i)}
		put(k.Store, dividendNullifierKey(nf), "accepted")
		if e := reference.Insert(nf); e != nil {
			t.Fatal(e)
		}
	}
	cursor, done, e := k.rebuildDividendSpentWithHash("", pd.Poseidon{})
	if e != nil || done {
		t.Fatal(e, done)
	}
	// Reopen on the same persisted store; cursor replay cannot skip or duplicate.
	for !done {
		k = Keeper{Store: k.Store}
		cursor, done, e = k.rebuildDividendSpentWithHash(cursor, pd.Poseidon{})
		if e != nil {
			t.Fatal(e)
		}
	}
	tree, state, e := k.ensureDividendSpent(pd.Poseidon{})
	if e != nil || state.Count != 100 {
		t.Fatal(state, e)
	}
	root, _ := tree.Root()
	want, _ := reference.Root()
	if root != want {
		t.Fatal("historical native root mismatch")
	}
}
