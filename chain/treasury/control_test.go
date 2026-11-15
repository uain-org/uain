package treasury

import (
	"crypto/ed25519"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"github.com/uain-org/uain/chain/federation"
)

func TestTreasuryControlSignatureBoundToExactNativeContext(t *testing.T) {
	seed := make([]byte, 32)
	seed[31] = 2
	owner := "uain1" + strings.Repeat("a", 40)
	for _, network := range []string{"ethereum:1", "ethereum:8453", "solana:mainnet"} {
		address, e := Address(network, seed)
		if e != nil {
			t.Fatal(e)
		}
		if strings.HasPrefix(network, "ethereum:") && address != "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf" {
			t.Fatal(address)
		}
		plan := ControlPlan{Schema: "uain-treasury-escrow-control-v1", ChainID: "fixture-native-1", Controller: owner, Sequence: 7, ExpiresHeight: 700, Network: network, Address: address, EvidenceDigest: strings.Repeat("b", 64)}
		result, e := SignControl(plan, seed)
		if e != nil {
			t.Fatal(e)
		}
		text, e := federation.TreasuryEscrowProofBytes(plan.ChainID, owner, 7, network, address, 700, plan.EvidenceDigest)
		if e != nil {
			t.Fatal(e)
		}
		if network == "solana:mainnet" {
			pub, _ := base58.Decode(address)
			sig, _ := base58.Decode(result.Signature)
			if !ed25519.Verify(pub, text, sig) {
				t.Fatal("invalid control consent")
			}
		} else {
			sig, e := hex.DecodeString(strings.TrimPrefix(result.Signature, "0x"))
			if e != nil || len(sig) != 65 {
				t.Fatal(e)
			}
			compact := append([]byte{sig[64]}, sig[:64]...)
			hash := keccak(append([]byte("\x19Ethereum Signed Message:\n"+strconv.Itoa(len(text))), text...))
			pub, _, e := ecdsa.RecoverCompact(compact, hash)
			if e != nil || "0x"+hex.EncodeToString(keccak(pub.SerializeUncompressed()[1:])[12:]) != address {
				t.Fatal("wrong external control signer", e)
			}
		}
		tampered := plan
		tampered.Address = "0x" + strings.Repeat("3", 40)
		if _, e = SignControl(tampered, seed); e == nil {
			t.Fatal("wrong control address signed")
		}
		tampered = plan
		tampered.Schema = "unknown"
		if _, e = SignControl(tampered, seed); e == nil {
			t.Fatal("unknown control schema signed")
		}
	}
	if _, e := Address("fiat:USD", seed); e == nil {
		t.Fatal("bank account invented from a key")
	}
	if _, e := Address("ethereum:1", make([]byte, 32)); e == nil {
		t.Fatal("zero EVM key accepted")
	}
}
