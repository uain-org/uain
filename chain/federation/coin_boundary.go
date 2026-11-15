package federation

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"regexp"
	"strconv"

	"github.com/uain-org/uain/chain/coin"
	shield "github.com/uain-org/uain/chain/privateexchange"
)

// Entry/exit amounts and the public account are deliberately public. This
// approval is distinct from confidential, zero-value-balance OTC approval.
type CoinBoundaryApproval struct {
	Reviewer          string `json:"reviewer"`
	Effects           string `json:"effects"`
	PurposeCommitment string `json:"purpose_commitment"`
	Class             string `json:"class"`
	ExpiresHeight     int64  `json:"expires_height,string"`
	LicenceRevision   uint64 `json:"licence_revision,string"`
	Signature         string `json:"signature"`
	Direction         string `json:"direction"`
	Member            string `json:"member"`
	Amount            string `json:"amount"`
}

func (p CoinBoundaryApproval) privateApproval() PrivateApproval {
	return PrivateApproval{Reviewer: p.Reviewer, Effects: p.Effects, PurposeCommitment: p.PurposeCommitment, Class: p.Class, ExpiresHeight: p.ExpiresHeight, LicenceRevision: p.LicenceRevision, Signature: p.Signature}
}

type CoinBoundary struct {
	Bundle   string               `json:"bundle"`
	Approval CoinBoundaryApproval `json:"approval"`
}

var coinBoundaryMember = regexp.MustCompile(`^uain1[0-9a-f]{40}$`)
var coinBoundaryAmount = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

func boundaryUnits(amount string) (int64, error) {
	if !coinBoundaryAmount.MatchString(amount) {
		return 0, errors.New("canonical positive signed-int64 Coin boundary units required")
	}
	return strconv.ParseInt(amount, 10, 64)
}

// Fixed-width framing binds epoch, Coin policy/denomination, direction, public
// account, exact amount, effects, purpose, expiry, licence revision and reviewer.
// No preexisting private approval or signed ledger format changes.
func CoinBoundaryApprovalBytes(chain string, pub []byte, p CoinBoundaryApproval) ([]byte, error) {
	base, e := PrivateApprovalBytes(chain, pub, p.privateApproval())
	if e != nil {
		return nil, e
	}
	amount, e := boundaryUnits(p.Amount)
	if e != nil {
		return nil, e
	}
	if !coinBoundaryMember.MatchString(p.Member) || p.Reviewer != Address(pub) || p.Member == p.Reviewer {
		return nil, errors.New("licensed public boundary member and independent reviewer required")
	}
	var direction byte
	switch p.Direction {
	case "shield":
		direction = 1
	case "exit":
		direction = 2
	default:
		return nil, errors.New("invalid Coin boundary direction")
	}
	policy := sha256.Sum256([]byte(CoinPolicy))
	b := append([]byte("UAIN/coin-boundary/approval/v1\x00"), policy[:]...)
	b = append(b, base[len("UAIN/private-exchange/approval/v1\x00"):]...)
	b = append(b, direction)
	member, _ := hex.DecodeString(p.Member[5:])
	b = append(b, member...)
	var units [8]byte
	binary.BigEndian.PutUint64(units[:], uint64(amount))
	return append(b, units[:]...), nil
}

// Entry/exit execute inside the SDK transaction cache. Supply, the public
// account and private note/nullifier state succeed or roll back together.
func (k Keeper) coinBoundary(c Command, height int64, direction string) (string, error) {
	if _, e := k.activeCoin(height); e != nil {
		return "", e
	}
	var policy PrivateActivation
	if e := get(k.Store, "private_activation", &policy); e != nil {
		return "", e
	}
	if policy.Policy != PrivateExchangePolicy || height < policy.Height {
		return "", errors.New("active prospective Coin private pool required")
	}
	var p CoinBoundary
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if p.Approval.Direction != direction || p.Approval.Member != c.Member {
		return "", errors.New("boundary approval is for a different direction or public account")
	}
	amount, e := boundaryUnits(p.Approval.Amount)
	if e != nil {
		return "", e
	}
	var revision CensusRevision
	if e = get(k.Store, "private_licence_revision", &revision); e != nil {
		return "", e
	}
	if p.Approval.LicenceRevision != revision.Value || p.Approval.ExpiresHeight < height || p.Approval.ExpiresHeight-height > PrivateApprovalWindow || c.ExpiresHeight > p.Approval.ExpiresHeight {
		return "", errors.New("fresh bounded licence/purpose approval required")
	}
	reviewer, e := k.Member(p.Approval.Reviewer)
	if e != nil || reviewer.Licence != "active" || reviewer.Karma < PrivateReviewerKarma {
		return "", errors.New("active high-Karma boundary reviewer required")
	}
	var appointment struct {
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = get(k.Store, "private_reviewer/"+reviewer.ID, &appointment); e != nil || !appointment.Active || !digestPattern.MatchString(appointment.EvidenceDigest) {
		return "", errors.New("vetted boundary reviewer appointment required")
	}
	pub, e := base64.RawURLEncoding.DecodeString(reviewer.PublicKey)
	if e != nil {
		return "", e
	}
	approval, e := CoinBoundaryApprovalBytes(c.ChainID, pub, p.Approval)
	if e != nil {
		return "", e
	}
	sig, e := base64.RawURLEncoding.DecodeString(p.Approval.Signature)
	if e != nil || len(sig) != 64 || !validNativeEd25519Key(pub) || !ed25519.Verify(pub, approval, sig) {
		return "", errors.New("invalid Coin boundary reviewer signature")
	}
	if len(p.Bundle) == 0 || len(p.Bundle) > 22000 {
		return "", errors.New("bounded Coin boundary bundle required")
	}
	raw, e := base64.RawURLEncoding.DecodeString(p.Bundle)
	if e != nil || base64.RawURLEncoding.EncodeToString(raw) != p.Bundle {
		return "", errors.New("canonical Coin boundary bundle required")
	}
	effect, e := shield.Effects(raw)
	if e != nil {
		return "", e
	}
	id := hex.EncodeToString(effect[:])
	if id != p.Approval.Effects || k.Store.Get([]byte("private_boundary/"+id)) != nil || k.Store.Get([]byte("private_payment/"+id)) != nil {
		return "", errors.New("wrong or repeated Coin boundary effects")
	}
	ledger, e := k.coinLedger()
	if e != nil {
		return "", e
	}
	balance := "0"
	if k.Store.Get([]byte("coin_balance/"+c.Member)) != nil {
		if e = get(k.Store, "coin_balance/"+c.Member, &balance); e != nil {
			return "", e
		}
	}
	if e = (coin.Ledger{Minted: balance, Reserved: "0", Transparent: balance, Shielded: "0"}).Validate(); e != nil {
		return "", e
	}
	account, _ := new(big.Int).SetString(balance, 10)
	var next coin.Ledger
	var expected int64
	switch direction {
	case "shield":
		if account.Cmp(big.NewInt(amount)) < 0 {
			return "", errors.New("insufficient already-earned transparent Coin")
		}
		next, e = ledger.Shield(p.Approval.Amount)
		account.Sub(account, big.NewInt(amount))
		expected = -amount
	case "exit":
		next, e = ledger.Exit(p.Approval.Amount)
		account.Add(account, big.NewInt(amount))
		expected = amount
	default:
		return "", errors.New("invalid Coin boundary")
	}
	if e != nil {
		return "", e
	}
	approvalHash := sha256.Sum256(append(approval, sig...))
	if meter, ok := k.Store.(interface{ PrivateProofGas(uint64) }); ok {
		meter.PrivateProofGas(1500000)
	}
	verified, e := shield.Verify(raw, c.ChainID, uint64(p.Approval.ExpiresHeight), approvalHash)
	if e != nil {
		return "", e
	}
	if verified.ValueBalance != expected {
		return "", errors.New("proof value balance differs from the exact public account boundary")
	}
	root := hex.EncodeToString(verified.Anchor[:])
	if k.Store.Get([]byte("private_root/"+root)) == nil {
		return "", errors.New("boundary anchor is outside this chain epoch")
	}
	for i, nf := range verified.Nullifiers {
		if k.Store.Get([]byte("private_nullifier/"+hex.EncodeToString(nf[:]))) != nil || i == 1 && nf == verified.Nullifiers[0] {
			return "", errors.New("boundary note already spent or duplicate nullifier")
		}
	}
	var frontier PrivateFrontier
	if e = get(k.Store, "private_frontier", &frontier); e != nil {
		return "", e
	}
	if frontier.Count > (uint64(1)<<32)-2 {
		return "", errors.New("private Coin tree full")
	}
	if e = k.appendDividendSpent(verified.Nullifiers[:]); e != nil {
		return "", e
	}
	for _, nf := range verified.Nullifiers {
		if e = put(k.Store, "private_nullifier/"+hex.EncodeToString(nf[:]), id); e != nil {
			return "", e
		}
	}
	if e = k.appendPrivateNotes(&frontier, verified.Commitments); e != nil {
		return "", e
	}
	if e = put(k.Store, "private_frontier", frontier); e != nil {
		return "", e
	}
	if e = put(k.Store, "private_root/"+frontier.Root, height); e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_supply", next); e != nil {
		return "", e
	}
	if e = put(k.Store, "coin_balance/"+c.Member, account.String()); e != nil {
		return "", e
	}
	return id, put(k.Store, "private_boundary/"+id, struct {
		Bundle   string               `json:"bundle"`
		Approval CoinBoundaryApproval `json:"approval"`
		Instance string               `json:"instance,omitempty"`
		Height   int64                `json:"height,string"`
	}{p.Bundle, p.Approval, c.Instance, height})
}
