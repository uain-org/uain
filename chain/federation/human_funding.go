package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// The relay is a licensed network member, not the external funder. A wallet
// signature authenticates the payer without enrolling or rewarding that payer.
type HumanFundingConsent struct {
	Funding       json.RawMessage `json:"funding"`
	ExpiresHeight int64           `json:"expires_height,string"`
	Signature     string          `json:"signature"`
	Bank          string          `json:"bank,omitempty"`
}
type HumanFundingRecord struct {
	ChainID  string              `json:"chain_id"`
	Relay    string              `json:"relay"`
	Sequence uint64              `json:"sequence,string"`
	Network  string              `json:"network"`
	Source   string              `json:"source"`
	Action   string              `json:"action"`
	Consent  HumanFundingConsent `json:"consent"`
	Height   int64               `json:"height,string"`
}

func HumanFundingProofBytes(chain, relay string, sequence uint64, expires int64, action string, fields map[string]string) ([]byte, error) {
	if len(chain) < 1 || len(chain) > 100 || strings.ContainsAny(chain, "\r\n") || !coinBoundaryMember.MatchString(relay) || expires < 1 || (action != "file" && action != "refund" && action != "bank" && action != "bank_end") || len(fields) < 1 || len(fields) > 12 {
		return nil, errors.New("bounded nonmember funding consent required")
	}
	body, e := json.Marshal(fields)
	if e != nil || len(body) > 8192 {
		return nil, errors.New("bounded canonical funding details required")
	}
	return []byte(fmt.Sprintf("UAIN nonmember funding consent v1\nchain_id: %s\nrelay: %s\nsequence: %d\nexpires_height: %d\naction: %s\npayload: %s\n", chain, relay, sequence, expires, action, body)), nil
}
func humanFundingNetwork(network string) (string, error) {
	switch network {
	case "ethereum:1", "ethereum:8453":
		return "ethereum", nil
	case "solana:mainnet":
		return "solana", nil
	}
	return "", errors.New("nonmember bank funding requires independently verified bank ownership")
}
func verifyHumanFunding(c Command, height int64, action, network, source string, input HumanFundingConsent, fields map[string]string, ownerPublicKey string) error {
	if c.Instance != "" || input.ExpiresHeight < height || input.ExpiresHeight-height > ExternalWalletProofWindow || c.ExpiresHeight > input.ExpiresHeight {
		return errors.New("fresh member-relayed nonmember consent required")
	}
	if network == "fiat:USD" || network == "fiat:EUR" {
		if ownerPublicKey == "" || input.Bank == "" {
			return errors.New("independently verified nonmember bank ownership required")
		}
		message, e := HumanFundingProofBytes(c.ChainID, c.Member, c.Sequence, input.ExpiresHeight, action, fields)
		if e != nil {
			return e
		}
		return verifyExternalWallet("solana", ownerPublicKey, input.Signature, message)
	}
	if input.Bank != "" {
		return errors.New("crypto consent cannot substitute a bank identity")
	}
	walletNetwork, e := humanFundingNetwork(network)
	if e != nil {
		return e
	}
	if !validExternalAddress(walletNetwork, source) {
		return errors.New("canonical nonmember source required")
	}
	message, e := HumanFundingProofBytes(c.ChainID, c.Member, c.Sequence, input.ExpiresHeight, action, fields)
	if e != nil {
		return e
	}
	return verifyExternalWallet(walletNetwork, source, input.Signature, message)
}
func (k Keeper) humanFundingFile(c Command, height int64) (string, error) {
	var input HumanFundingConsent
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var fields map[string]string
	if e := Decode(input.Funding, &fields); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e := get(k.Store, "funding_campaign/"+fields["campaign"], &campaign); e != nil {
		return "", e
	}
	owner := ""
	if campaign.Network == "fiat:USD" || campaign.Network == "fiat:EUR" {
		bank, e := k.humanBank(input.Bank, true)
		if e != nil {
			return "", e
		}
		if bank.Network != campaign.Network || bank.AccountDigest != fields["source"] {
			return "", errors.New("human bank source differs from verified ownership")
		}
		owner = bank.OwnerPublicKey
	}
	if e := verifyHumanFunding(c, height, "file", campaign.Network, fields["source"], input, humanBankConsentFields(fields, input.Bank), owner); e != nil {
		return "", e
	}
	original := c
	c.Payload = input.Funding
	id, e := k.fileFundingSource(c, height, true)
	if e != nil {
		return "", e
	}
	if campaign.Network == "solana:mainnet" {
		if e = k.rememberFundingEd25519Control("external_wallet_control", "solana", fields["source"], fields["source"]); e != nil {
			return "", e
		}
	}
	record := HumanFundingRecord{original.ChainID, original.Member, original.Sequence, campaign.Network, fields["source"], "file", input, height}
	return id, put(k.Store, "human_funding/"+id, record)
}
func (k Keeper) humanFundingRefund(c Command, height int64) (string, error) {
	var input HumanFundingConsent
	if e := Decode(c.Payload, &input); e != nil {
		return "", e
	}
	var fields map[string]string
	if e := Decode(input.Funding, &fields); e != nil {
		return "", e
	}
	if len(fields) != 6 || !digestPattern.MatchString(fields["evidence_digest"]) {
		return "", errors.New("exact nonmember refund consent fields required")
	}
	var receipt FundingReceipt
	if e := get(k.Store, "funding_receipt/"+fields["receipt"], &receipt); e != nil {
		return "", e
	}
	var human HumanFundingRecord
	if e := get(k.Store, "human_funding/"+receipt.ID, &human); e != nil {
		return "", e
	}
	var campaign FundingCampaign
	if e := get(k.Store, "funding_campaign/"+receipt.Campaign, &campaign); e != nil {
		return "", e
	}
	if human.Source != receipt.Source || human.Network != campaign.Network || fields["network"] != campaign.Network || fields["amount"] != receipt.Amount || fields["source"] != receipt.Source || fields["escrow"] != campaign.Escrow {
		return "", errors.New("refund consent must name exact original source, currency, escrow and amount")
	}
	owner := ""
	if campaign.Network == "fiat:USD" || campaign.Network == "fiat:EUR" {
		if input.Bank != human.Consent.Bank {
			return "", errors.New("original nonmember bank key required")
		}
		bank, e := k.humanBank(input.Bank, false)
		if e != nil {
			return "", e
		}
		if bank.Network != campaign.Network || bank.AccountDigest != receipt.Source {
			return "", errors.New("original nonmember bank source required")
		}
		owner = bank.OwnerPublicKey
	}
	if e := verifyHumanFunding(c, height, "refund", campaign.Network, receipt.Source, input, humanBankConsentFields(fields, input.Bank), owner); e != nil {
		return "", e
	}
	payload, e := json.Marshal(map[string]string{"receipt": receipt.ID, "evidence_digest": fields["evidence_digest"]})
	if e != nil {
		return "", e
	}
	original := c
	c.Payload = payload
	id, e := k.refundFundingSource(c, height, true)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "human_funding_refund_consent/"+id, HumanFundingRecord{original.ChainID, original.Member, original.Sequence, campaign.Network, receipt.Source, "refund", input, height}); e != nil {
		return "", e
	}
	return id, put(k.Store, "human_funding_refund/"+id, original.Member)
}
