package federation

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"testing"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"golang.org/x/crypto/sha3"
)

// Independently constructed protocol text catches changes to chain/member,
// shared sequence, address or expiry binding instead of signing with the helper
// under test and mistakenly accepting the same framing bug on both sides.
func walletFixtureMessage(k Keeper, a actor, network, address string, expires int64) string {
	m, _ := k.Member(a.m.ID)
	return fmt.Sprintf("UAIN external wallet binding v1\nchain_id: uain-test-1\nmember: %s\nsequence: %d\nnetwork: %s\naddress: %s\nexpires_height: %d\n", a.m.ID, m.Sequence, network, address, expires)
}
func evmWalletPayload(k Keeper, a actor, height int64) map[string]any {
	key := secp.PrivKeyFromBytes([]byte{1})
	address := "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
	message := walletFixtureMessage(k, a, "ethereum", address, height+30)
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len([]byte(message)))))
	h.Write([]byte(message))
	sig := ecdsa.SignCompact(key, h.Sum(nil), false)
	eth := append(append([]byte{}, sig[1:]...), sig[0])
	return map[string]any{"network": "ethereum", "address": address, "expires_height": fmt.Sprint(height + 30), "signature": "0x" + hex.EncodeToString(eth)}
}

func TestExternalWalletEthereumProofOwnershipAndRebinding(t *testing.T) {
	k, lead, peer, _ := fixture(t)
	payload := evmWalletPayload(k, lead, 1)
	rejectCommand(t, k, peer, "", "external_wallet_bind", payload, 1)
	command(t, k, lead, "external_wallet_bind", payload, 1)
	var current struct {
		Member, Network, Address string
		Active                   bool
		Binding                  string
	}
	if err := get(k.Store, "external_wallet/"+lead.m.ID+"/ethereum", &current); err != nil || current.Address != "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" || !current.Active {
		t.Fatal(current, err)
	}
	rejectCommand(t, k, lead, "", "external_wallet_bind", payload, 2)
	// Even a genuine proof by another licensed member cannot take an address
	// currently held by the first member.
	rejectCommand(t, k, peer, "", "external_wallet_bind", evmWalletPayload(k, peer, 2), 2)
	command(t, k, lead, "external_wallet_unbind", map[string]any{"network": "ethereum", "binding": current.Binding}, 3)
	command(t, k, peer, "external_wallet_bind", evmWalletPayload(k, peer, 4), 4)
	if k.Store.Get([]byte("external_wallet_binding/"+current.Binding)) == nil || k.Store.Get([]byte("external_wallet_end/"+current.Binding)) == nil {
		t.Fatal("prior proof history lost")
	}
	rejectCommand(t, k, lead, "", "external_wallet_unbind", map[string]any{"network": "ethereum", "binding": current.Binding}, 5)
}

func TestExternalWalletSolanaProofAndTampering(t *testing.T) {
	k, lead, peer, _ := fixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	address := base58.Encode(pub)
	message := walletFixtureMessage(k, lead, "solana", address, 31)
	p := map[string]any{"network": "solana", "address": address, "expires_height": "31", "signature": base58.Encode(ed25519.Sign(key, []byte(message)))}
	wrong := map[string]any{}
	for a, b := range p {
		wrong[a] = b
	}
	wrong["expires_height"] = "32"
	rejectCommand(t, k, lead, "", "external_wallet_bind", wrong, 1)
	rejectCommand(t, k, peer, "", "external_wallet_bind", p, 1)
	command(t, k, lead, "external_wallet_bind", p, 1)
	var current struct {
		Address string
		Active  bool
	}
	if err := get(k.Store, "external_wallet/"+lead.m.ID+"/solana", &current); err != nil || current.Address != address || !current.Active {
		t.Fatal(current, err)
	}
}

func TestExternalWalletRejectsIdentityPointWithoutPrivateKey(t *testing.T) {
	k, lead, _, _ := fixture(t)
	pub := make([]byte, 32)
	pub[0] = 1
	signature := make([]byte, 64)
	signature[0] = 1
	// The standard verifier accepts this degenerate identity-point equation.
	// Wallet ownership must reject it even though no private key was used.
	p := map[string]any{"network": "solana", "address": base58.Encode(pub), "expires_height": "31", "signature": base58.Encode(signature)}
	rejectCommand(t, k, lead, "", "external_wallet_bind", p, 1)
}
