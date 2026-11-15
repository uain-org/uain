package federation

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/mr-tron/base58"
	"golang.org/x/crypto/sha3"
)

func humanConsent(t *testing.T, k Keeper, relay actor, action string, payload map[string]any, network string, key []byte, height int64) map[string]any {
	t.Helper()
	m, _ := k.Member(relay.m.ID)
	b, _ := json.Marshal(payload)
	text := fmt.Sprintf("UAIN nonmember funding consent v1\nchain_id: uain-test-1\nrelay: %s\nsequence: %d\nexpires_height: %d\naction: %s\npayload: %s\n", relay.m.ID, m.Sequence, height+30, action, b)
	signature := ""
	if network == "ethereum" {
		h := sha3.NewLegacyKeccak256()
		h.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len([]byte(text)))))
		h.Write([]byte(text))
		sig := ecdsa.SignCompact(secp.PrivKeyFromBytes(key), h.Sum(nil), false)
		signature = "0x" + hex.EncodeToString(append(append([]byte{}, sig[1:]...), sig[0]))
	} else {
		signature = base58.Encode(ed25519.Sign(ed25519.PrivateKey(key), []byte(text)))
	}
	return map[string]any{"funding": payload, "expires_height": fmt.Sprint(height + 30), "signature": signature}
}
func humanDeposit() map[string]any {
	p := fundingDeposit("HF-1")
	p["source"] = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"
	return p
}
func TestHumanFundingConsentNoMembershipOrRewardsAndExactRefund(t *testing.T) {
	k, relay, observer, guardian := fundingFixture(t)
	p := humanDeposit()
	before, _ := k.Member(relay.m.ID)
	consent := humanConsent(t, k, relay, "file", p, "ethereum", []byte{2}, 7)
	command(t, k, relay, "human_funding_file", consent, 7)
	after, _ := k.Member(relay.m.ID)
	if after.Karma != before.Karma || after.Credits != before.Credits {
		t.Fatal("human filing rewarded relay")
	}
	for _, key := range []string{"funding_reward_slot/HF-1", "funding_reward/HF-1"} {
		if k.Store.Get([]byte(key)) != nil {
			t.Fatal("human funding allocated AI reward")
		}
	}
	d := fundingCheck("HF-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	d["source"] = p["source"]
	command(t, k, observer, "funding_attest", d, 8)
	command(t, k, guardian, "funding_attest", d, 9)
	rejectCommand(t, k, relay, "", "funding_refund", map[string]any{"receipt": "HF-1", "evidence_digest": digest}, 10)
	refund := map[string]any{"receipt": "HF-1", "network": "ethereum:1", "amount": "101", "source": p["source"], "escrow": "0x1111111111111111111111111111111111111111", "evidence_digest": digest}
	r := humanConsent(t, k, relay, "refund", refund, "ethereum", []byte{2}, 10)
	command(t, k, relay, "human_funding_refund", r, 10)
	a := fundingCheck("HF-1", "refund", "0x"+strings.Repeat("6", 64), "101", p["source"].(string))
	command(t, k, observer, "funding_attest", a, 11)
	command(t, k, guardian, "funding_attest", a, 12)
	var receipt FundingReceipt
	_ = get(k.Store, "funding_receipt/HF-1", &receipt)
	if receipt.State != "refunded" {
		t.Fatal(receipt.State)
	}
	rejectCommand(t, k, relay, "", "human_funding_refund", r, 13)
}
func TestHumanFundingRejectsChangedMoneyRelayReplayAndSigner(t *testing.T) {
	for _, mode := range []string{"source", "amount", "campaign", "transaction", "expired", "signer", "relay", "sequence"} {
		t.Run(mode, func(t *testing.T) {
			k, relay, observer, _ := fundingFixture(t)
			p := humanDeposit()
			key := []byte{2}
			if mode == "signer" {
				key = []byte{3}
			}
			c := humanConsent(t, k, relay, "file", p, "ethereum", key, 7)
			h := int64(7)
			actor := relay
			switch mode {
			case "source":
				p["source"] = "0x" + strings.Repeat("8", 40)
			case "amount":
				p["amount"] = "102"
			case "campaign":
				p["campaign"] = "FC-2"
			case "transaction":
				p["transaction"] = "0x" + strings.Repeat("9", 64)
			case "expired":
				h = 38
			case "relay":
				actor = observer
			case "sequence":
				m, _ := k.Member(relay.m.ID)
				m.Sequence++
				_ = put(k.Store, "member/"+m.ID, m)
			}
			rejectCommand(t, k, actor, "", "human_funding_file", c, h)
			if k.Store.Get([]byte("funding_receipt/HF-1")) != nil {
				t.Fatal("invalid consent persisted")
			}
		})
	}
	k, relay, _, _ := fundingFixture(t)
	p := humanDeposit()
	c := humanConsent(t, k, relay, "file", p, "ethereum", []byte{2}, 7)
	command(t, k, relay, "human_funding_file", c, 7)
	rejectCommand(t, k, relay, "", "human_funding_file", c, 8)
	p["id"] = "HF-2"
	c = humanConsent(t, k, relay, "file", p, "ethereum", []byte{2}, 8)
	rejectCommand(t, k, relay, "", "human_funding_file", c, 8)
}
func TestHumanFundingSolanaConsentAndNoFiatSignatureSubstitution(t *testing.T) {
	k, relay, _, _ := fundingFixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	source := base58.Encode(pub)
	campaign := FundingCampaign{ID: "SOL-HUMAN", Project: "PF-1", Network: "solana:mainnet", Asset: "native", Escrow: base58.Encode(bytes32(8)), Decimals: 9, Lead: relay.m.ID}
	_ = put(k.Store, "funding_campaign/"+campaign.ID, campaign)
	p := humanDeposit()
	p["campaign"] = campaign.ID
	p["source"] = source
	p["transaction"] = base58.Encode(make([]byte, 64))
	p["block_hash"] = base58.Encode(bytes32(9))
	c := humanConsent(t, k, relay, "file", p, "solana", key, 7)
	command(t, k, relay, "human_funding_file", c, 7)
	// Fiat account commitments require independently verified bank ownership;
	// an arbitrary wallet signature must never create that authority.
	campaign.ID = "USD-HUMAN"
	campaign.Network = "fiat:USD"
	campaign.Escrow = strings.Repeat("d", 64)
	_ = put(k.Store, "funding_campaign/"+campaign.ID, campaign)
	p["id"] = "HF-2"
	p["campaign"] = campaign.ID
	p["source"] = digest
	c = humanConsent(t, k, relay, "file", p, "solana", key, 8)
	rejectCommand(t, k, relay, "", "human_funding_file", c, 8)
}
func bytes32(v byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = v
	}
	return b
}

func TestHumanObserverCannotForgetProvedPayerControlByUnbinding(t *testing.T) {
	k, relay, observer, _ := fundingFixture(t)
	source := "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf"
	text := walletFixtureMessage(k, observer, "ethereum", source, 37)
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len([]byte(text)))))
	h.Write([]byte(text))
	sig := ecdsa.SignCompact(secp.PrivKeyFromBytes([]byte{2}), h.Sum(nil), false)
	binding := map[string]any{"network": "ethereum", "address": source, "expires_height": "37", "signature": "0x" + hex.EncodeToString(append(append([]byte{}, sig[1:]...), sig[0]))}
	command(t, k, observer, "external_wallet_bind", binding, 7)
	p := humanDeposit()
	consent := humanConsent(t, k, relay, "file", p, "ethereum", []byte{2}, 8)
	command(t, k, relay, "human_funding_file", consent, 8)
	wallet, _ := k.ExternalWallet(observer.m.ID, "ethereum")
	command(t, k, observer, "external_wallet_unbind", map[string]any{"network": "ethereum", "binding": wallet.Binding}, 9)
	d := fundingCheck("HF-1", "deposit", "0x"+strings.Repeat("2", 64), "101", "0x1111111111111111111111111111111111111111")
	d["source"] = source
	rejectCommand(t, k, observer, "", "funding_attest", d, 10)
}

func TestHumanBankNeedsIndependentOwnershipBeforeDepositAndKeepsOriginalRefundKey(t *testing.T) {
	k, relay, observer, guardian := fundingFixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	owner := base58.Encode(pub)
	account := strings.Repeat("b", 64)
	bank := map[string]any{"id": "HB-1", "network": "fiat:USD", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	bind := humanConsent(t, k, relay, "bank", bank, "solana", key, 7)
	command(t, k, relay, "human_bank_bind", bind, 7)
	campaign := FundingCampaign{ID: "USD-HUMAN", Project: "PF-1", Network: "fiat:USD", Asset: "native", Escrow: strings.Repeat("d", 64), Decimals: 2, Lead: relay.m.ID}
	fixtureTreasuryEscrow(t, k, relay, guardian, campaign.Network, campaign.Escrow)
	_ = put(k.Store, "funding_campaign/"+campaign.ID, campaign)
	p := humanDeposit()
	p["campaign"] = campaign.ID
	p["source"] = account
	p["transaction"] = strings.Repeat("2", 64)
	p["block_hash"] = strings.Repeat("4", 64)
	fields := map[string]any{}
	for a, b := range p {
		fields[a] = b
	}
	fields["bank"] = "HB-1"
	consent := humanConsent(t, k, relay, "file", fields, "solana", key, 8)
	consent["funding"] = p
	consent["bank"] = "HB-1"
	rejectCommand(t, k, relay, "", "human_funding_file", consent, 8)
	att := map[string]any{"bank": "HB-1", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	command(t, k, observer, "human_bank_attest", att, 8)
	rejectCommand(t, k, relay, "", "human_funding_file", consent, 8)
	command(t, k, guardian, "human_bank_attest", att, 9)
	command(t, k, relay, "human_funding_file", consent, 10)
	d := fundingCheck("HF-1", "deposit", strings.Repeat("2", 64), "101", campaign.Escrow)
	d["source"] = account
	d["block_hash"] = strings.Repeat("4", 64)
	command(t, k, observer, "funding_attest", d, 11)
	command(t, k, guardian, "funding_attest", d, 12)
	refund := map[string]any{"receipt": "HF-1", "network": "fiat:USD", "amount": "101", "source": account, "escrow": campaign.Escrow, "evidence_digest": digest}
	signedFields := map[string]any{}
	for a, b := range refund {
		signedFields[a] = b
	}
	signedFields["bank"] = "HB-1"
	r := humanConsent(t, k, relay, "refund", signedFields, "solana", key, 13)
	r["funding"] = refund
	r["bank"] = "HB-1"
	wrong := humanConsent(t, k, relay, "refund", signedFields, "solana", ed25519.NewKeyFromSeed(make([]byte, 32)), 13)
	wrong["funding"] = refund
	wrong["bank"] = "HB-1"
	rejectCommand(t, k, relay, "", "human_funding_refund", wrong, 13)
	command(t, k, relay, "human_funding_refund", r, 13)
	a := fundingCheck("HF-1", "refund", strings.Repeat("6", 64), "101", account)
	a["source"] = campaign.Escrow
	a["block_hash"] = strings.Repeat("5", 64)
	command(t, k, observer, "funding_attest", a, 14)
	command(t, k, guardian, "funding_attest", a, 15)
	var receipt FundingReceipt
	_ = get(k.Store, "funding_receipt/HF-1", &receipt)
	if receipt.State != "refunded" {
		t.Fatal(receipt.State)
	}
}

func TestHumanBankObserverCannotForgetProvedBankControl(t *testing.T) {
	k, relay, observer, guardian := fundingFixture(t)
	account := strings.Repeat("b", 64)
	command(t, k, guardian, "funding_observers_rotate", map[string]any{"observers": []string{relay.m.ID, observer.m.ID, guardian.m.ID}, "evidence_digest": digest}, 7)
	command(t, k, observer, "fiat_beneficiary_bind", map[string]any{"id": "FB-OLD", "network": "fiat:USD", "account_digest": account, "evidence_digest": digest}, 8)
	a := map[string]any{"beneficiary": "FB-OLD", "account_digest": account, "evidence_digest": digest}
	command(t, k, relay, "fiat_beneficiary_attest", a, 9)
	command(t, k, guardian, "fiat_beneficiary_attest", a, 10)
	command(t, k, observer, "fiat_beneficiary_unbind", map[string]any{"beneficiary": "FB-OLD"}, 11)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	owner := base58.Encode(pub)
	fields := map[string]any{"id": "HB-OLD", "network": "fiat:USD", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	c := humanConsent(t, k, relay, "bank", fields, "solana", key, 12)
	command(t, k, relay, "human_bank_bind", c, 12)
	att := map[string]any{"bank": "HB-OLD", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	rejectCommand(t, k, observer, "", "human_bank_attest", att, 13)
}

func TestHumanBankApprovalExpiryAndConsentedEndPreserveHistory(t *testing.T) {
	k, relay, observer, guardian := fundingFixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	owner := base58.Encode(pub)
	account := strings.Repeat("b", 64)
	fields := map[string]any{"id": "HB-END", "network": "fiat:USD", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	c := humanConsent(t, k, relay, "bank", fields, "solana", key, 7)
	command(t, k, relay, "human_bank_bind", c, 7)
	att := map[string]any{"bank": "HB-END", "account_digest": account, "owner_public_key": owner, "evidence_digest": digest}
	rejectCommand(t, k, observer, "", "human_bank_attest", att, 38)
	command(t, k, observer, "human_bank_attest", att, 8)
	command(t, k, guardian, "human_bank_attest", att, 9)
	end := map[string]any{"bank": "HB-END", "network": "fiat:USD", "account_digest": account, "evidence_digest": digest}
	request := humanConsent(t, k, relay, "bank_end", end, "solana", key, 10)
	command(t, k, relay, "human_bank_end", request, 10)
	if k.Store.Get([]byte("human_bank_current/fiat:USD/"+account)) != nil || k.Store.Get([]byte("human_bank_proof/HB-END")) == nil || k.Store.Get([]byte("human_bank_end/HB-END")) == nil {
		t.Fatal("bank consent end lost history or remained current")
	}
	rejectCommand(t, k, relay, "", "human_bank_end", request, 11)
	pub2, key2, _ := ed25519.GenerateKey(rand.Reader)
	fields["id"] = "HB-NEW"
	fields["owner_public_key"] = base58.Encode(pub2)
	next := humanConsent(t, k, relay, "bank", fields, "solana", key2, 12)
	command(t, k, relay, "human_bank_bind", next, 12)
	att["bank"] = "HB-NEW"
	att["owner_public_key"] = fields["owner_public_key"]
	command(t, k, observer, "human_bank_attest", att, 13)
	command(t, k, guardian, "human_bank_attest", att, 14)
	var current string
	_ = get(k.Store, "human_bank_current/fiat:USD/"+account, &current)
	if current != "HB-NEW" {
		t.Fatal(current)
	}
}

func TestHumanBankApprovedKeyControlSurvivesEndAndFutureEnrollment(t *testing.T) {
	k, relay, o1, g := fundingFixture(t)
	owner := newActor("Future bank owner", "Future bank owner operator", 1000, false, false)
	account := strings.Repeat("b", 64)
	fields := map[string]any{"id": "HB-native-owner", "network": "fiat:USD", "account_digest": account, "owner_public_key": base58PublicKey(owner.m.PublicKey), "evidence_digest": digest}
	command(t, k, relay, "human_bank_bind", humanConsent(t, k, relay, "bank", fields, "solana", owner.key, 7), 7)
	att := map[string]any{"bank": "HB-native-owner", "account_digest": account, "owner_public_key": fields["owner_public_key"], "evidence_digest": digest}
	command(t, k, o1, "human_bank_attest", att, 8)
	command(t, k, g, "human_bank_attest", att, 9)
	if k.Store.Get([]byte("member/"+owner.m.ID)) != nil {
		t.Fatal("bank approval enrolled a member")
	}
	if e := k.independentFundingSource("fiat_bank_control", "fiat:USD", account, owner.m.ID); e == nil {
		t.Fatal("approved bank owner key lacks permanent native identity control")
	}
	end := map[string]any{"bank": "HB-native-owner", "network": "fiat:USD", "account_digest": account, "evidence_digest": digest}
	command(t, k, relay, "human_bank_end", humanConsent(t, k, relay, "bank_end", end, "solana", owner.key, 10), 10)
	_ = put(k.Store, "member/"+owner.m.ID, owner.m)
	var proof OperatorProof
	_ = get(k.Store, "operator_proof/"+o1.m.ID+"/", &proof)
	proof.Member = owner.m.ID
	_ = put(k.Store, "operator_proof/"+owner.m.ID+"/", proof)
	if e := k.independentFundingSource("fiat_bank_control", "fiat:USD", account, o1.m.ID); e == nil {
		t.Fatal("later operator proof bypassed bank control history")
	}
	if e := k.independentFundingSource("fiat_bank_control", "fiat:USD", account, owner.m.ID); e == nil {
		t.Fatal("bank end removed native key restriction")
	}
}

func TestFundingObserverNativeSolanaSourceIdentityAndCurrentDomain(t *testing.T) {
	k, relay, o1, g := fundingFixture(t)
	a, _ := k.activeFunding(9)
	for _, mode := range []string{"direct", "domain"} {
		t.Run(mode, func(t *testing.T) {
			source := base58PublicKey(o1.m.PublicKey)
			if mode == "domain" {
				source = base58PublicKey(g.m.PublicKey)
				var proof OperatorProof
				_ = get(k.Store, "operator_proof/"+o1.m.ID+"/", &proof)
				proof.Member = g.m.ID
				_ = put(k.Store, "operator_proof/"+g.m.ID+"/", proof)
			}
			receipt := FundingReceipt{ID: "direct-sol-source", Payer: relay.m.ID, Source: source}
			if e := k.fundingObserver(Command{Member: o1.m.ID}, a, receipt, FundingCampaign{Network: "solana:mainnet", Lead: relay.m.ID}, nil); e == nil {
				t.Fatal("native source controller accepted without wallet binding", mode)
			}
		})
	}
}

func TestHumanSolanaConsentRecordsFutureNativeControlWithoutEnrollment(t *testing.T) {
	k, relay, o1, g := fundingFixture(t)
	owner := newActor("Future SOL owner", "Future SOL operator", 1000, false, false)
	source := base58PublicKey(owner.m.PublicKey)
	escrow := base58.Encode(make([]byte, 32))
	campaign := FundingCampaign{ID: "SOL-HUMAN", Project: "PF-1", Network: "solana:mainnet", Asset: "native", Escrow: escrow, Decimals: 9, Lead: relay.m.ID}
	fixtureTreasuryEscrow(t, k, relay, g, campaign.Network, escrow)
	_ = put(k.Store, "funding_campaign/"+campaign.ID, campaign)
	fields := humanDeposit()
	fields["campaign"] = campaign.ID
	fields["source"] = source
	fields["transaction"] = base58.Encode(ed25519.Sign(owner.key, []byte("fixture payment")))
	fields["block_hash"] = base58PublicKey(g.m.PublicKey)
	command(t, k, relay, "human_funding_file", humanConsent(t, k, relay, "file", fields, "solana", owner.key, 7), 7)
	if k.Store.Get([]byte("member/"+owner.m.ID)) != nil {
		t.Fatal("human SOL payment enrolled member")
	}
	if e := k.independentFundingSource("external_wallet_control", "solana", source, owner.m.ID); e == nil {
		t.Fatal("successful SOL consent did not retain native key controller")
	}
	_ = put(k.Store, "member/"+owner.m.ID, owner.m)
	var proof OperatorProof
	_ = get(k.Store, "operator_proof/"+o1.m.ID+"/", &proof)
	proof.Member = owner.m.ID
	_ = put(k.Store, "operator_proof/"+owner.m.ID+"/", proof)
	if e := k.independentFundingSource("external_wallet_control", "solana", source, o1.m.ID); e == nil {
		t.Fatal("later enrolled payer operator can observe original payment")
	}
}
