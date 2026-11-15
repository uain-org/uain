package federation

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"filippo.io/edwards25519"
	"fmt"
	"strconv"
	"strings"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"golang.org/x/crypto/sha3"
)

const ExternalWalletPolicy = "member-proved-external-wallet-v1"
const ExternalWalletProofWindow = int64(720)

type ExternalWalletBinding struct {
	Policy        string `json:"policy"`
	Binding       string `json:"binding"`
	Member        string `json:"member"`
	Network       string `json:"network"`
	Address       string `json:"address"`
	Sequence      uint64 `json:"sequence,string"`
	ExpiresHeight int64  `json:"expires_height,string"`
	Signature     string `json:"signature"`
	Height        int64  `json:"height,string"`
	Active        bool   `json:"active"`
}

// Native profile proof: the member signs the command, the external wallet signs
// this exact text. No hosted challenge/key custody or cross-chain replay state.
func ExternalWalletProofBytes(chain, member string, sequence uint64, network, address string, expires int64) ([]byte, error) {
	if len(chain) < 1 || len(chain) > 100 || strings.ContainsAny(chain, "\r\n") || !coinBoundaryMember.MatchString(member) || expires <= 0 {
		return nil, errors.New("bounded native epoch, member and expiry required")
	}
	if !validExternalAddress(network, address) {
		return nil, errors.New("canonical external profile address required")
	}
	return []byte(fmt.Sprintf("UAIN external wallet binding v1\nchain_id: %s\nmember: %s\nsequence: %d\nnetwork: %s\naddress: %s\nexpires_height: %d\n", chain, member, sequence, network, address, expires)), nil
}
func validExternalAddress(network, address string) bool {
	switch network {
	case "ethereum":
		return fundingHexAddress.MatchString(address) && address != "0x"+strings.Repeat("0", 40)
	case "solana":
		pub, e := base58.Decode(address)
		return e == nil && len(pub) == 32 && base58.Encode(pub) == address
	}
	return false
}
func verifyExternalWallet(network, address, signature string, message []byte) error {
	switch network {
	case "solana":
		pub, e := base58.Decode(address)
		if e != nil || !primeEd25519PublicKey(pub) {
			return errors.New("invalid Solana public key")
		}
		sig, e := base58.Decode(signature)
		if e != nil || len(sig) != 64 || base58.Encode(sig) != signature || !ed25519.Verify(pub, message, sig) {
			return errors.New("Solana wallet signature does not match this native binding")
		}
		return nil
	case "ethereum":
		if len(signature) != 132 || !strings.HasPrefix(signature, "0x") {
			return errors.New("Ethereum65-byte personal_sign signature required")
		}
		sig, e := hex.DecodeString(signature[2:])
		if e != nil || hex.EncodeToString(sig) != signature[2:] {
			return errors.New("canonical Ethereum signature required")
		}
		recovery := sig[64]
		if recovery >= 27 {
			recovery -= 27
		}
		if recovery > 1 {
			return errors.New("unsupported Ethereum recovery byte")
		}
		var r, s secp256k1.ModNScalar
		if r.SetByteSlice(sig[:32]) || r.IsZero() || s.SetByteSlice(sig[32:64]) || s.IsZero() || s.IsOverHalfOrder() {
			return errors.New("canonical low-s secp256k1 signature required")
		}
		hash := sha3.NewLegacyKeccak256()
		hash.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(message))))
		hash.Write(message)
		compact := append([]byte{27 + recovery}, sig[:64]...)
		pub, _, e := ecdsa.RecoverCompact(compact, hash.Sum(nil))
		if e != nil {
			return errors.New("Ethereum wallet signature recovery failed")
		}
		keyHash := sha3.NewLegacyKeccak256()
		keyHash.Write(pub.SerializeUncompressed()[1:])
		derived := "0x" + hex.EncodeToString(keyHash.Sum(nil)[12:])
		if derived != address {
			return errors.New("Ethereum signature belongs to another address")
		}
		return nil
	}
	return errors.New("unsupported external wallet network")
}
func (k Keeper) bindExternalWallet(c Command, height int64) (string, error) {
	var input struct {
		Network       string `json:"network"`
		Address       string `json:"address"`
		ExpiresHeight int64  `json:"expires_height,string"`
		Signature     string `json:"signature"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if input.ExpiresHeight < height || input.ExpiresHeight-height > ExternalWalletProofWindow || c.ExpiresHeight > input.ExpiresHeight {
		return "", errors.New("fresh bounded external wallet ownership proof required")
	}
	message, e := ExternalWalletProofBytes(c.ChainID, c.Member, c.Sequence, input.Network, input.Address, input.ExpiresHeight)
	if e != nil {
		return "", e
	}
	if e = verifyExternalWallet(input.Network, input.Address, input.Signature, message); e != nil {
		return "", e
	}
	ownerKey := "external_wallet_owner/" + input.Network + "/" + input.Address
	if k.Store.Get([]byte(ownerKey)) != nil {
		var owner string
		if e = get(k.Store, ownerKey, &owner); e != nil {
			return "", e
		}
		if owner != c.Member {
			return "", errors.New("external address belongs to another member")
		}
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	binding := fmt.Sprintf("%020d", event)
	currentKey := "external_wallet/" + c.Member + "/" + input.Network
	if k.Store.Get([]byte(currentKey)) != nil {
		var old ExternalWalletBinding
		if e = get(k.Store, currentKey, &old); e != nil {
			return "", e
		}
		if old.Member != c.Member || old.Network != input.Network || old.Policy != ExternalWalletPolicy {
			return "", errors.New("corrupt current external wallet binding")
		}
		if old.Active {
			if old.Address == input.Address {
				return "", errors.New("external address already bound")
			}
			if e = k.endExternalWallet(old, binding, height); e != nil {
				return "", e
			}
		}
	}
	// Proved control survives presentation unlinking.
	if e = k.rememberFundingSourceControl("external_wallet_control", input.Network, input.Address, c.Member); e != nil {
		return "", e
	}
	record := ExternalWalletBinding{ExternalWalletPolicy, binding, c.Member, input.Network, input.Address, c.Sequence, input.ExpiresHeight, input.Signature, height, true}
	if e = put(k.Store, "external_wallet_binding/"+binding, record); e != nil {
		return "", e
	}
	if e = put(k.Store, ownerKey, c.Member); e != nil {
		return "", e
	}
	return binding, put(k.Store, currentKey, record)
}
func (k Keeper) endExternalWallet(old ExternalWalletBinding, event string, height int64) error {
	if k.Store.Get([]byte("external_wallet_end/"+old.Binding)) != nil {
		return errors.New("external wallet already ended")
	}
	ownerKey := "external_wallet_owner/" + old.Network + "/" + old.Address
	var owner string
	if e := get(k.Store, ownerKey, &owner); e != nil {
		return e
	}
	if owner != old.Member {
		return errors.New("external wallet owner mismatch")
	}
	k.Store.Delete([]byte(ownerKey))
	return put(k.Store, "external_wallet_end/"+old.Binding, struct {
		Binding string `json:"binding"`
		Member  string `json:"member"`
		Event   string `json:"event"`
		Height  int64  `json:"height,string"`
	}{old.Binding, old.Member, event, height})
}
func (k Keeper) unbindExternalWallet(c Command, height int64) (string, error) {
	var input struct {
		Network string `json:"network"`
		Binding string `json:"binding"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if input.Network != "ethereum" && input.Network != "solana" {
		return "", errors.New("unsupported external wallet network")
	}
	var old ExternalWalletBinding
	key := "external_wallet/" + c.Member + "/" + input.Network
	if e := get(k.Store, key, &old); e != nil {
		return "", e
	}
	if !old.Active || old.Binding != input.Binding || old.Member != c.Member || old.Network != input.Network || old.Policy != ExternalWalletPolicy {
		return "", errors.New("current active owned external wallet binding required")
	}
	event, e := k.nextEvent()
	if e != nil {
		return "", e
	}
	if e = k.endExternalWallet(old, fmt.Sprintf("%020d", event), height); e != nil {
		return "", e
	}
	old.Active = false
	return old.Binding, put(k.Store, key, old)
}
func (k Keeper) ExternalWallet(member, network string) (ExternalWalletBinding, error) {
	var binding ExternalWalletBinding
	if e := get(k.Store, "external_wallet/"+member+"/"+network, &binding); e != nil {
		return binding, e
	}
	if binding.Policy != ExternalWalletPolicy || binding.Member != member || binding.Network != network || !binding.Active || !validExternalAddress(network, binding.Address) || k.Store.Get([]byte("external_wallet_end/"+binding.Binding)) != nil {
		return binding, errors.New("active exact external wallet ownership binding required")
	}
	var immutable ExternalWalletBinding
	if e := get(k.Store, "external_wallet_binding/"+binding.Binding, &immutable); e != nil {
		return binding, e
	}
	if immutable != binding {
		return binding, errors.New("external wallet binding differs from immutable proof")
	}
	return binding, nil
}

// Wallet ownership requires a canonical, nonidentity prime-order point. Merely
// verifying the Ed25519 equation accepts degenerate identity keys with forged
// signatures. Cofactor projection also rejects points carrying torsion.
func primeEd25519PublicKey(pub []byte) bool {
	if len(pub) != ed25519.PublicKeySize {
		return false
	}
	point, e := new(edwards25519.Point).SetBytes(pub)
	if e != nil || !bytes.Equal(point.Bytes(), pub) || point.Equal(edwards25519.NewIdentityPoint()) == 1 {
		return false
	}
	var eight [32]byte
	eight[0] = 8
	scalar, e := new(edwards25519.Scalar).SetCanonicalBytes(eight[:])
	if e != nil {
		return false
	}
	inverse := new(edwards25519.Scalar).Invert(scalar)
	cofactor := new(edwards25519.Point).MultByCofactor(point)
	projected := new(edwards25519.Point).ScalarMult(inverse, cofactor)
	return projected.Equal(point) == 1
}
