// Package treasury signs only exact native-currency transfers. It performs no
// RPC, broadcast, custody, native authorization or filesystem access.
package treasury

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"regexp"
	"strings"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"github.com/uain-org/uain/chain/federation"
	"golang.org/x/crypto/sha3"
)

type Plan struct {
	Schema               string `json:"schema"`
	Intent               string `json:"intent"`
	Network              string `json:"network"`
	Source               string `json:"source"`
	Target               string `json:"target"`
	Amount               string `json:"amount"`
	Nonce                string `json:"nonce,omitempty"`
	GasLimit             string `json:"gas_limit,omitempty"`
	MaxPriorityFeePerGas string `json:"max_priority_fee_per_gas,omitempty"`
	MaxFeePerGas         string `json:"max_fee_per_gas,omitempty"`
	RecentBlockhash      string `json:"recent_blockhash,omitempty"`
}
type Signed struct {
	ID          string `json:"id"`
	Transaction string `json:"transaction"`
}

var decimalPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
var intentPattern = regexp.MustCompile(`^(payout|refund|dividend|operations)/[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$`)
var addressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)

func number(s string, bits int, positive bool) (*big.Int, error) {
	if !decimalPattern.MatchString(s) {
		return nil, errors.New("canonical treasury amount required")
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.BitLen() > bits || positive && n.Sign() == 0 {
		return nil, errors.New("treasury integer out of range")
	}
	return n, nil
}
func DecodePlan(raw []byte) (Plan, error) {
	var p Plan
	if len(raw) > 65536 {
		return p, errors.New("bounded public treasury plan required")
	}
	if e := federation.Decode(raw, &p); e != nil {
		return p, e
	}
	return p, nil
}
func keccak(raw []byte) []byte { h := sha3.NewLegacyKeccak256(); h.Write(raw); return h.Sum(nil) }
func evmAddress(s string) ([]byte, error) {
	if !addressPattern.MatchString(s) || s == "0x"+strings.Repeat("0", 40) {
		return nil, errors.New("canonical nonzero treasury address required")
	}
	return hex.DecodeString(s[2:])
}
func solana32(s string) ([]byte, error) {
	b, e := base58.Decode(s)
	if e != nil || len(b) != 32 || base58.Encode(b) != s || bytes.Equal(b, make([]byte, 32)) {
		return nil, errors.New("canonical nonzero Solana value required")
	}
	return b, nil
}

// RLP lengths are bounded by the exact eleven fields of one native transfer.
func rlpBytes(b []byte) []byte {
	if len(b) == 1 && b[0] < 128 {
		return append([]byte{}, b...)
	}
	if len(b) <= 55 {
		return append([]byte{byte(128 + len(b))}, b...)
	}
	n := new(big.Int).SetUint64(uint64(len(b))).Bytes()
	out := append([]byte{byte(183 + len(n))}, n...)
	return append(out, b...)
}
func rlpList(items ...[]byte) []byte {
	body := bytes.Join(items, nil)
	if len(body) <= 55 {
		return append([]byte{byte(192 + len(body))}, body...)
	}
	n := new(big.Int).SetUint64(uint64(len(body))).Bytes()
	out := append([]byte{byte(247 + len(n))}, n...)
	return append(out, body...)
}
func Sign(p Plan, secret []byte) (Signed, error) {
	if p.Schema != "uain-treasury-native-transfer-v1" || !intentPattern.MatchString(p.Intent) || len(secret) != 32 || p.Source == p.Target {
		return Signed{}, errors.New("exact bounded treasury transfer plan required")
	}
	switch p.Network {
	case "ethereum:1", "ethereum:8453":
		return signEthereum(p, secret)
	case "solana:mainnet":
		return signSolana(p, secret)
	}
	return Signed{}, errors.New("unsupported treasury transfer network")
}
func signEthereum(p Plan, secret []byte) (Signed, error) {
	if p.RecentBlockhash != "" || p.GasLimit != "21000" {
		return Signed{}, errors.New("native EVM transfer requires exactly21000 gas and no Solana fields")
	}
	source, e := evmAddress(p.Source)
	if e != nil {
		return Signed{}, e
	}
	target, e := evmAddress(p.Target)
	if e != nil {
		return Signed{}, e
	}
	nonce, e := number(p.Nonce, 64, false)
	if e != nil {
		return Signed{}, e
	}
	amount, e := number(p.Amount, 256, true)
	if e != nil {
		return Signed{}, e
	}
	priority, e := number(p.MaxPriorityFeePerGas, 256, false)
	if e != nil {
		return Signed{}, e
	}
	maxFee, e := number(p.MaxFeePerGas, 256, true)
	if e != nil || priority.Cmp(maxFee) > 0 {
		return Signed{}, errors.New("bounded approved EVM fees required")
	}
	maximum := new(big.Int).Mul(maxFee, big.NewInt(21000))
	maximum.Add(maximum, amount)
	if maximum.BitLen() > 256 {
		return Signed{}, errors.New("EVM transfer and maximum fees overflow balance")
	}
	var scalar secp.ModNScalar
	if scalar.SetByteSlice(secret) || scalar.IsZero() {
		return Signed{}, errors.New("valid dedicated EVM key required")
	}
	key := secp.NewPrivateKey(&scalar)
	scalar.Zero()
	defer key.Zero()
	derived := keccak(key.PubKey().SerializeUncompressed()[1:])[12:]
	if !bytes.Equal(derived, source) {
		return Signed{}, errors.New("dedicated EVM key does not control approved source")
	}
	chain := big.NewInt(1)
	if p.Network == "ethereum:8453" {
		chain.SetInt64(8453)
	}
	fields := [][]byte{rlpBytes(chain.Bytes()), rlpBytes(nonce.Bytes()), rlpBytes(priority.Bytes()), rlpBytes(maxFee.Bytes()), rlpBytes(big.NewInt(21000).Bytes()), rlpBytes(target), rlpBytes(amount.Bytes()), rlpBytes(nil), rlpList()}
	hash := keccak(append([]byte{2}, rlpList(fields...)...))
	sig := ecdsa.SignCompact(key, hash, false)
	parity := sig[0] - 27
	if parity > 1 {
		return Signed{}, errors.New("unsupported EVM recovery parity")
	}
	fields = append(fields, rlpBytes(new(big.Int).SetUint64(uint64(parity)).Bytes()), rlpBytes(new(big.Int).SetBytes(sig[1:33]).Bytes()), rlpBytes(new(big.Int).SetBytes(sig[33:65]).Bytes()))
	raw := append([]byte{2}, rlpList(fields...)...)
	return Signed{"0x" + hex.EncodeToString(keccak(raw)), "0x" + hex.EncodeToString(raw)}, nil
}
func signSolana(p Plan, secret []byte) (Signed, error) {
	if p.Nonce != "" || p.GasLimit != "" || p.MaxPriorityFeePerGas != "" || p.MaxFeePerGas != "" {
		return Signed{}, errors.New("Solana native transfer refuses EVM fields")
	}
	source, e := solana32(p.Source)
	if e != nil {
		return Signed{}, e
	}
	target, e := solana32(p.Target)
	if e != nil {
		return Signed{}, e
	}
	block, e := solana32(p.RecentBlockhash)
	if e != nil {
		return Signed{}, e
	}
	amount, e := number(p.Amount, 64, true)
	if e != nil {
		return Signed{}, e
	}
	key := ed25519.NewKeyFromSeed(secret)
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	if !bytes.Equal(key[32:], source) {
		return Signed{}, errors.New("dedicated Solana key does not control approved source")
	}
	message := []byte{1, 0, 1, 3}
	message = append(message, source...)
	message = append(message, target...)
	message = append(message, make([]byte, 32)...)
	message = append(message, block...)
	message = append(message, 1, 2, 2, 0, 1, 12, 2, 0, 0, 0)
	value := make([]byte, 8)
	binary.LittleEndian.PutUint64(value, amount.Uint64())
	message = append(message, value...)
	signature := ed25519.Sign(key, message)
	raw := append([]byte{1}, signature...)
	raw = append(raw, message...)
	return Signed{base58.Encode(signature), base64.StdEncoding.EncodeToString(raw)}, nil
}
