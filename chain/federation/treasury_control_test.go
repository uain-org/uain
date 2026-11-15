package federation

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"testing"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"golang.org/x/crypto/sha3"
)

func escrowControlPayload(t *testing.T, k Keeper, a actor, network, address string, key []byte, height int64) map[string]any {
	t.Helper()
	m, e := k.Member(a.m.ID)
	if e != nil {
		t.Fatal(e)
	}
	expiry := height + 30
	text := []byte(fmt.Sprintf("UAIN treasury escrow control v1\nchain_id: uain-test-1\ncontroller: %s\nsequence: %d\nnetwork: %s\naddress: %s\nexpires_height: %d\nevidence_digest: %s\n", a.m.ID, m.Sequence, network, address, expiry, digest))
	signature := ""
	if strings.HasPrefix(network, "ethereum:") {
		h := sha3.NewLegacyKeccak256()
		h.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(text))))
		h.Write(text)
		sig := ecdsa.SignCompact(secp.PrivKeyFromBytes(key), h.Sum(nil), false)
		signature = "0x" + hex.EncodeToString(append(append([]byte{}, sig[1:]...), sig[0]))
	} else {
		signature = base58.Encode(ed25519.Sign(ed25519.NewKeyFromSeed(key), text))
	}
	return map[string]any{"network": network, "address": address, "expires_height": fmt.Sprint(expiry), "evidence_digest": digest, "signature": signature}
}
func TestTreasuryEscrowControlAndGuardianApprovalPrecedeCampaign(t *testing.T) {
	k, lead, observer, guardian := fundingFixture(t)
	address := "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"
	campaign := map[string]any{"id": "FC-controlled", "project": "PF-1", "network": "ethereum:1", "asset": "native", "escrow": address, "decimals": 18, "evidence_digest": digest}
	rejectCommand(t, k, lead, "", "funding_campaign", campaign, 7)
	bind := escrowControlPayload(t, k, lead, "ethereum:1", address, []byte{2}, 7)
	command(t, k, lead, "treasury_escrow_bind", bind, 7)
	rejectCommand(t, k, lead, "", "funding_campaign", campaign, 8)
	approval := map[string]any{"network": "ethereum:1", "address": address, "controller": lead.m.ID, "evidence_digest": digest}
	rejectCommand(t, k, observer, "", "treasury_escrow_approve", approval, 8)
	command(t, k, guardian, "treasury_escrow_approve", approval, 8)
	command(t, k, lead, "funding_campaign", campaign, 9)
	proof, e := k.TreasuryEscrow("ethereum:1", address)
	if e != nil || proof.Controller != lead.m.ID || proof.Guardian != guardian.m.ID {
		t.Fatal(proof, e)
	}
	rejectCommand(t, k, lead, "", "treasury_escrow_bind", bind, 10)
	rejectCommand(t, k, guardian, "", "treasury_escrow_approve", approval, 10)
}
func TestTreasuryEscrowRejectsWrongNetworkSignerExpiryAndBankSubstitution(t *testing.T) {
	for _, mode := range []string{"network", "address", "signer", "sequence", "expired", "evidence", "fiat"} {
		t.Run(mode, func(t *testing.T) {
			k, owner, _, _ := fundingFixture(t)
			address := "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"
			payload := escrowControlPayload(t, k, owner, "ethereum:1", address, []byte{2}, 7)
			height := int64(7)
			switch mode {
			case "network":
				payload["network"] = "ethereum:8453"
			case "address":
				payload["address"] = "0x" + strings.Repeat("3", 40)
			case "signer":
				payload = escrowControlPayload(t, k, owner, "ethereum:1", address, []byte{3}, 7)
			case "sequence":
				m, _ := k.Member(owner.m.ID)
				m.Sequence++
				_ = put(k.Store, "member/"+m.ID, m)
			case "expired":
				height = 38
			case "evidence":
				payload["evidence_digest"] = strings.Repeat("f", 64)
			case "fiat":
				payload["network"] = "fiat:USD"
				payload["address"] = digest
				payload["bank"] = "not-proved"
			}
			rejectCommand(t, k, owner, "", "treasury_escrow_bind", payload, height)
		})
	}
	k, owner, _, guardian := fundingFixture(t)
	seed := bytes32(42)
	address := base58.Encode(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	payload := escrowControlPayload(t, k, owner, "solana:mainnet", address, seed, 7)
	command(t, k, owner, "treasury_escrow_bind", payload, 7)
	approval := map[string]any{"network": "solana:mainnet", "address": address, "controller": owner.m.ID, "evidence_digest": digest}
	rejectCommand(t, k, guardian, "", "treasury_escrow_approve", approval, 38)
	if _, e := k.TreasuryEscrow("solana:mainnet", address); e == nil {
		t.Fatal("expired unapproved control was active")
	}
}

func TestTreasuryControllerCannotObserveAnUnrelatedPayerAndExpiredRequestCanRenew(t *testing.T) {
	k, lead, observer, guardian := fundingFixture(t)
	address := "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"
	bind := escrowControlPayload(t, k, observer, "ethereum:1", address, []byte{2}, 7)
	command(t, k, observer, "treasury_escrow_bind", bind, 7)
	command(t, k, guardian, "treasury_escrow_approve", map[string]any{"network": "ethereum:1", "address": address, "controller": observer.m.ID, "evidence_digest": digest}, 8)
	command(t, k, lead, "funding_campaign", map[string]any{"id": "FC-observer", "project": "PF-1", "network": "ethereum:1", "asset": "native", "escrow": address, "decimals": 18, "evidence_digest": digest}, 9)
	deposit := fundingDeposit("FR-controller")
	deposit["campaign"] = "FC-observer"
	command(t, k, lead, "funding_file", deposit, 10)
	att := fundingCheck("FR-controller", "deposit", deposit["transaction"].(string), "101", address)
	rejectCommand(t, k, observer, "", "funding_attest", att, 11)
	command(t, k, guardian, "funding_attest", att, 11)
	if k.Store.Get([]byte("funding_pool/FR-controller")) != nil {
		t.Fatal("self-controlled escrow became funded")
	}
	seed := bytes32(43)
	sol := base58.Encode(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
	first, _ := k.Member(lead.m.ID)
	command(t, k, lead, "treasury_escrow_bind", escrowControlPayload(t, k, lead, "solana:mainnet", sol, seed, 12), 12)
	oldKey := "treasury_escrow_binding/solana:mainnet/" + sol + "/" + lead.m.ID + "/" + fmt.Sprint(first.Sequence)
	old := string(k.Store.Get([]byte(oldKey)))
	if old == "" {
		t.Fatal("immutable control history absent")
	}
	command(t, k, lead, "treasury_escrow_bind", escrowControlPayload(t, k, lead, "solana:mainnet", sol, seed, 43), 43)
	if string(k.Store.Get([]byte(oldKey))) != old {
		t.Fatal("renewal overwrote expired control history")
	}
	command(t, k, guardian, "treasury_escrow_approve", map[string]any{"network": "solana:mainnet", "address": sol, "controller": lead.m.ID, "evidence_digest": digest}, 44)
}

func TestTreasuryBankControlRequiresExistingIndependentOwnership(t *testing.T) {
	k, owner, first, guardian := fundingFixture(t)
	account := strings.Repeat("e", 64)
	payload := map[string]any{"network": "fiat:USD", "address": account, "expires_height": "40", "evidence_digest": digest, "signature": "", "bank": "TB-1"}
	rejectCommand(t, k, owner, "", "treasury_escrow_bind", payload, 7)
	command(t, k, owner, "fiat_beneficiary_bind", map[string]any{"id": "TB-1", "network": "fiat:USD", "account_digest": account, "evidence_digest": digest}, 7)
	att := map[string]any{"beneficiary": "TB-1", "account_digest": account, "evidence_digest": digest}
	command(t, k, first, "fiat_beneficiary_attest", att, 8)
	command(t, k, guardian, "fiat_beneficiary_attest", att, 9)
	command(t, k, owner, "treasury_escrow_bind", payload, 10)
	approval := map[string]any{"network": "fiat:USD", "address": account, "controller": owner.m.ID, "evidence_digest": digest}
	command(t, k, owner, "fiat_beneficiary_unbind", map[string]any{"beneficiary": "TB-1"}, 11)
	rejectCommand(t, k, guardian, "", "treasury_escrow_approve", approval, 12)
	if _, e := k.TreasuryEscrow("fiat:USD", account); e == nil {
		t.Fatal("unbound bank ownership approved")
	}
}
