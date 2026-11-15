package federation

import (
	shield "github.com/uain-org/uain/chain/privateexchange"
	"testing"
)

func TestCoinInactiveAndUnlinkedPoliciesRefuseEveryMintPath(t *testing.T) {
	k, lead, _, guardian := fixture(t)
	for op, p := range map[string]any{
		"coin_quote":   map[string]any{"task": "T-1", "open_event": "00000000000000000001", "amount": "1", "evidence_digest": digest},
		"coin_reserve": map[string]any{"task": "T-1", "evidence_digest": digest},
		"coin_release": map[string]any{"task": "T-1", "evidence_digest": digest},
		"coin_claim":   map[string]any{"contribution": "RC-1"},
		"coin_shield":  map[string]any{},
		"coin_exit":    map[string]any{},
	} {
		rejectCommand(t, k, lead, "", op, p, 1)
	}
	if !shield.Available() {
		rejectCommand(t, k, guardian, "", "activate_coin", map[string]any{"policy": CoinPolicy, "evidence_digest": digest}, 1)
	}
	if k.Store.Get([]byte("coin_supply")) != nil || k.Store.Get([]byte("coin_activation")) != nil {
		t.Fatal("inactive policies created Coin")
	}
}
