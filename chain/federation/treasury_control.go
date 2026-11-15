package federation

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const TreasuryEscrowPolicy = "proved-native-treasury-escrow-v1"

type TreasuryEscrowControl struct {
	Policy           string `json:"policy"`
	Network          string `json:"network"`
	Address          string `json:"address"`
	Controller       string `json:"controller"`
	Sequence         uint64 `json:"sequence,string"`
	ExpiresHeight    int64  `json:"expires_height,string"`
	Signature        string `json:"signature,omitempty"`
	Bank             string `json:"bank,omitempty"`
	EvidenceDigest   string `json:"evidence_digest"`
	Height           int64  `json:"height,string"`
	Guardian         string `json:"guardian"`
	ApprovedHeight   int64  `json:"approved_height,string"`
	ApprovalEvidence string `json:"approval_evidence"`
}

func TreasuryEscrowProofBytes(chain, controller string, sequence uint64, network, address string, expires int64, evidence string) ([]byte, error) {
	if len(chain) < 1 || len(chain) > 100 || strings.ContainsAny(chain, "\r\n") || !coinBoundaryMember.MatchString(controller) || !fundingNetwork(network) || strings.HasPrefix(network, "fiat:") || !fundingAddress(network, address) || expires < 1 || !digestPattern.MatchString(evidence) {
		return nil, errors.New("bounded exact native treasury control proof required")
	}
	return []byte(fmt.Sprintf("UAIN treasury escrow control v1\nchain_id: %s\ncontroller: %s\nsequence: %d\nnetwork: %s\naddress: %s\nexpires_height: %d\nevidence_digest: %s\n", chain, controller, sequence, network, address, expires, evidence)), nil
}
func treasuryEscrowKey(prefix, network, address string) string {
	return prefix + "/" + network + "/" + address
}
func (k Keeper) TreasuryEscrow(network, address string) (TreasuryEscrowControl, error) {
	var proof TreasuryEscrowControl
	if !fundingNetwork(network) || !fundingAddress(network, address) {
		return proof, errors.New("canonical supported escrow required")
	}
	if e := get(k.Store, treasuryEscrowKey("treasury_escrow", network, address), &proof); e != nil {
		return proof, e
	}
	if proof.Policy != TreasuryEscrowPolicy || proof.Network != network || proof.Address != address || !coinBoundaryMember.MatchString(proof.Controller) || !coinBoundaryMember.MatchString(proof.Guardian) || proof.Height < 1 || proof.ApprovedHeight < proof.Height || proof.ApprovedHeight > proof.ExpiresHeight || !digestPattern.MatchString(proof.EvidenceDigest) || !digestPattern.MatchString(proof.ApprovalEvidence) {
		return proof, errors.New("approved immutable treasury control proof required")
	}
	return proof, nil
}
func (k Keeper) bindTreasuryEscrow(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Network        string `json:"network"`
		Address        string `json:"address"`
		ExpiresHeight  int64  `json:"expires_height,string"`
		Signature      string `json:"signature"`
		Bank           string `json:"bank,omitempty"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	requestKey := treasuryEscrowKey("treasury_escrow_request", input.Network, input.Address)
	if c.Instance != "" || !fundingNetwork(input.Network) || !fundingAddress(input.Network, input.Address) || !digestPattern.MatchString(input.EvidenceDigest) || input.ExpiresHeight < height || input.ExpiresHeight-height > ExternalWalletProofWindow || c.ExpiresHeight > input.ExpiresHeight || k.Store.Get([]byte(treasuryEscrowKey("treasury_escrow", input.Network, input.Address))) != nil {
		return "", errors.New("fresh immutable treasury control registration required")
	}
	if k.Store.Get([]byte(requestKey)) != nil {
		var old TreasuryEscrowControl
		if e := get(k.Store, requestKey, &old); e != nil {
			return "", e
		}
		if height <= old.ExpiresHeight {
			return "", errors.New("existing unexpired treasury control request")
		}
	}
	bindingKey := "treasury_escrow_binding/" + input.Network + "/" + input.Address + "/" + c.Member + "/" + strconv.FormatUint(c.Sequence, 10)
	if k.Store.Get([]byte(bindingKey)) != nil {
		return "", errors.New("treasury control binding already recorded")
	}
	if strings.HasPrefix(input.Network, "fiat:") {
		bank, e := k.FiatBeneficiary(c.Member, input.Network)
		if e != nil || input.Signature != "" || bank.ID != input.Bank || bank.AccountDigest != input.Address {
			return "", errors.New("treasury bank needs current independently verified controller ownership")
		}
	} else {
		if input.Bank != "" {
			return "", errors.New("crypto escrow cannot substitute a bank record")
		}
		text, e := TreasuryEscrowProofBytes(c.ChainID, c.Member, c.Sequence, input.Network, input.Address, input.ExpiresHeight, input.EvidenceDigest)
		if e != nil {
			return "", e
		}
		walletNetwork := "ethereum"
		if input.Network == "solana:mainnet" {
			walletNetwork = "solana"
		}
		if e = verifyExternalWallet(walletNetwork, input.Address, input.Signature, text); e != nil {
			return "", e
		}
	}
	proof := TreasuryEscrowControl{Policy: TreasuryEscrowPolicy, Network: input.Network, Address: input.Address, Controller: c.Member, Sequence: c.Sequence, ExpiresHeight: input.ExpiresHeight, Signature: input.Signature, Bank: input.Bank, EvidenceDigest: input.EvidenceDigest, Height: height}
	if e := k.rememberFundingSourceControl("treasury_escrow_control", input.Network, input.Address, c.Member); e != nil {
		return "", e
	}
	if e := put(k.Store, bindingKey, proof); e != nil {
		return "", e
	}
	return input.Address, put(k.Store, requestKey, proof)
}
func (k Keeper) approveTreasuryEscrow(c Command, height int64) (string, error) {
	if _, e := k.activeFunding(height); e != nil {
		return "", e
	}
	var input struct {
		Network        string `json:"network"`
		Address        string `json:"address"`
		Controller     string `json:"controller"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	if !k.guardian(c.Member) || c.Instance != "" || !fundingNetwork(input.Network) || !fundingAddress(input.Network, input.Address) || !digestPattern.MatchString(input.EvidenceDigest) {
		return "", errors.New("current guardian's exact reviewed treasury approval required")
	}
	var proof TreasuryEscrowControl
	if e := get(k.Store, treasuryEscrowKey("treasury_escrow_request", input.Network, input.Address), &proof); e != nil {
		return "", e
	}
	key := treasuryEscrowKey("treasury_escrow", input.Network, input.Address)
	controller, e := k.Member(proof.Controller)
	if e != nil || controller.Licence != "active" || proof.Controller != input.Controller || height > proof.ExpiresHeight || k.Store.Get([]byte(key)) != nil {
		return "", errors.New("fresh unapproved licensed escrow control required")
	}
	if strings.HasPrefix(proof.Network, "fiat:") {
		bank, e := k.FiatBeneficiary(proof.Controller, proof.Network)
		if e != nil || bank.ID != proof.Bank || bank.AccountDigest != proof.Address {
			return "", errors.New("treasury bank ownership changed before approval")
		}
	}
	proof.Guardian, proof.ApprovedHeight, proof.ApprovalEvidence = c.Member, height, input.EvidenceDigest
	return input.Address, put(k.Store, key, proof)
}
