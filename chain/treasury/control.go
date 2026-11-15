package treasury

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"github.com/uain-org/uain/chain/federation"
)

type ControlPlan struct {
	Schema         string `json:"schema"`
	ChainID        string `json:"chain_id"`
	Controller     string `json:"controller"`
	Sequence       uint64 `json:"sequence,string"`
	ExpiresHeight  int64  `json:"expires_height,string"`
	Network        string `json:"network"`
	Address        string `json:"address"`
	EvidenceDigest string `json:"evidence_digest"`
}
type ControlSigned struct {
	Network   string `json:"network"`
	Address   string `json:"address"`
	Signature string `json:"signature"`
}

func Address(network string, seed []byte) (string, error) {
	if len(seed) != 32 {
		return "", errors.New("dedicated32-byte treasury seed required")
	}
	switch network {
	case "ethereum:1", "ethereum:8453":
		var scalar secp.ModNScalar
		if scalar.SetByteSlice(seed) || scalar.IsZero() {
			return "", errors.New("valid dedicated EVM key required")
		}
		key := secp.NewPrivateKey(&scalar)
		scalar.Zero()
		defer key.Zero()
		return "0x" + hex.EncodeToString(keccak(key.PubKey().SerializeUncompressed()[1:])[12:]), nil
	case "solana:mainnet":
		key := ed25519.NewKeyFromSeed(seed)
		defer func() {
			for i := range key {
				key[i] = 0
			}
		}()
		return base58.Encode(key[32:]), nil
	}
	return "", errors.New("unsupported dedicated treasury key network")
}
func DecodeControlPlan(raw []byte) (ControlPlan, error) {
	var p ControlPlan
	if len(raw) > 65536 {
		return p, errors.New("bounded public control plan required")
	}
	e := federation.Decode(raw, &p)
	return p, e
}
func SignControl(p ControlPlan, seed []byte) (ControlSigned, error) {
	if p.Schema != "uain-treasury-escrow-control-v1" {
		return ControlSigned{}, errors.New("exact treasury control schema required")
	}
	text, e := federation.TreasuryEscrowProofBytes(p.ChainID, p.Controller, p.Sequence, p.Network, p.Address, p.ExpiresHeight, p.EvidenceDigest)
	if e != nil {
		return ControlSigned{}, e
	}
	address, e := Address(p.Network, seed)
	if e != nil || address != p.Address {
		return ControlSigned{}, errors.New("dedicated key does not control exact approved escrow")
	}
	signature := ""
	if strings.HasPrefix(p.Network, "ethereum:") {
		var scalar secp.ModNScalar
		if scalar.SetByteSlice(seed) || scalar.IsZero() {
			return ControlSigned{}, errors.New("invalid EVM scalar")
		}
		key := secp.NewPrivateKey(&scalar)
		scalar.Zero()
		defer key.Zero()
		hash := keccak(append([]byte("\x19Ethereum Signed Message:\n"+strconv.Itoa(len(text))), text...))
		sig := ecdsa.SignCompact(key, hash, false)
		if sig[0] > 28 {
			return ControlSigned{}, errors.New("unsupported EVM recovery parity")
		}
		signature = "0x" + hex.EncodeToString(append(append([]byte{}, sig[1:]...), sig[0]))
	} else {
		key := ed25519.NewKeyFromSeed(seed)
		defer func() {
			for i := range key {
				key[i] = 0
			}
		}()
		signature = base58.Encode(ed25519.Sign(key, text))
	}
	return ControlSigned{p.Network, p.Address, signature}, nil
}
