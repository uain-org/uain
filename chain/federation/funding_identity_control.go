package federation

import (
	"errors"
	"github.com/mr-tron/base58"
)

// A verified Ed25519 payment/consent key also proves control of its derived
// native address. Recording that address never creates a member or a licence.
func (k Keeper) rememberFundingEd25519Control(prefix, network, address, public string) error {
	key, err := base58.Decode(public)
	if err != nil || len(key) != 32 {
		return errors.New("canonical proved Ed25519 source required")
	}
	return k.rememberFundingSourceControl(prefix, network, address, Address(key))
}

// Review independence includes current native key/operator control even when no
// profile wallet was linked. Permanent markers additionally survive unlinking.
func (k Keeper) independentFundingAddress(network, address, member string) error {
	if address == "" {
		return nil
	}
	prefix, walletNetwork := "external_wallet_control", "ethereum"
	switch network {
	case "ethereum:1", "ethereum:8453":
	case "solana:mainnet":
		walletNetwork = "solana"
	case "fiat:USD", "fiat:EUR":
		prefix, walletNetwork = "fiat_bank_control", network
	default:
		return errors.New("supported funding source network required")
	}
	if err := k.independentFundingSource(prefix, walletNetwork, address, member); err != nil {
		return err
	}
	if prefix == "fiat_bank_control" {
		if bank, err := k.FiatBeneficiary(member, network); err == nil && bank.AccountDigest == address {
			return errors.New("observer controls bank account")
		}
		return nil
	}
	if wallet, err := k.ExternalWallet(member, walletNetwork); err == nil && wallet.Address == address {
		return errors.New("observer controls external wallet")
	}
	if walletNetwork == "solana" {
		key, err := base58.Decode(address)
		if err != nil || len(key) != 32 {
			return errors.New("canonical Solana source required")
		}
		owner := Address(key)
		if owner == member {
			return errors.New("observer native key controls Solana address")
		}
		sourceProof, err := k.OperatorProof(owner, "")
		if err != nil {
			return err
		}
		observerProof, err := k.OperatorProof(member, "")
		if err != nil {
			return err
		}
		if sourceProof != nil && observerProof != nil && sourceProof.Domain == observerProof.Domain {
			return errors.New("observer shares current proved Solana source operator")
		}
	}
	return nil
}
