package federation

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	shield "github.com/uain-org/uain/chain/privateexchange"
)

const PrivateExchangePolicy = "orchard-v2-reviewed-otc-v1"
const PrivateApprovalWindow = int64(720)
const PrivateReviewerKarma = int64(100)

type PrivateActivation struct {
	Policy         string `json:"policy"`
	Height         int64  `json:"height,string"`
	EvidenceDigest string `json:"evidence_digest"`
	Relayer        string `json:"relayer"`
}
type PrivateFrontier struct {
	Count uint64     `json:"count,string"`
	Root  string     `json:"root"`
	Nodes [32]string `json:"nodes"`
}

// Reviewers inspect the privately supplied agreement and current licences before signing.
// Public receipts reveal the reviewer/class and salted purpose commitment, never terms or parties.
type PrivateApproval struct {
	Reviewer          string `json:"reviewer"`
	Effects           string `json:"effects"`
	PurposeCommitment string `json:"purpose_commitment"`
	Class             string `json:"class"`
	ExpiresHeight     int64  `json:"expires_height,string"`
	LicenceRevision   uint64 `json:"licence_revision,string"`
	Signature         string `json:"signature"`
}
type PrivatePayment struct {
	Bundle   string          `json:"bundle"`
	Approval PrivateApproval `json:"approval"`
}

func PrivateApprovalBytes(chain string, publicKey []byte, p PrivateApproval) ([]byte, error) {
	if len(publicKey) != 32 || !digestPattern.MatchString(p.Effects) || !digestPattern.MatchString(p.PurposeCommitment) || p.ExpiresHeight <= 0 {
		return nil, errors.New("invalid private approval")
	}
	var class byte
	switch p.Class {
	case "benevolent":
		class = 1
	case "neutral":
		class = 2
	default:
		return nil, errors.New("malevolent or missing private classification")
	}
	chainHash := sha256.Sum256([]byte(chain))
	effect, _ := hex.DecodeString(p.Effects)
	purpose, _ := hex.DecodeString(p.PurposeCommitment)
	b := append([]byte("UAIN/private-exchange/approval/v1\x00"), chainHash[:]...)
	var expiry [8]byte
	binary.BigEndian.PutUint64(expiry[:], uint64(p.ExpiresHeight))
	b = append(b, expiry[:]...)
	var revision [8]byte
	binary.BigEndian.PutUint64(revision[:], p.LicenceRevision)
	b = append(b, revision[:]...)
	b = append(b, effect...)
	b = append(b, purpose...)
	b = append(b, class, 1) // reviewer attests both parties currently licensed
	return append(b, publicKey...), nil
}
func (k Keeper) activatePrivateExchange(c Command, height int64) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian approval required")
	}
	if !shield.Available() {
		return "", shield.ErrUnavailable
	}
	active, e := k.CompactStorageActive(height)
	if e != nil || !active {
		return "", errors.New("private exchange requires active bounded storage policy")
	}
	var p struct {
		Policy         string `json:"policy"`
		EvidenceDigest string `json:"evidence_digest"`
		Relayer        string `json:"relayer"`
	}
	if e = Decode(c.Payload, &p); e != nil {
		return "", e
	}
	if p.Policy != PrivateExchangePolicy || !digestPattern.MatchString(p.EvidenceDigest) || height == math.MaxInt64 || k.Store.Get([]byte("private_activation")) != nil {
		return "", errors.New("invalid or duplicate private activation")
	}
	relay, e := k.Member(p.Relayer)
	if e != nil || relay.Licence != "active" {
		return "", errors.New("active separate relay required")
	}
	root, e := shield.Empty(32)
	if e != nil {
		return "", e
	}
	if e = put(k.Store, "private_licence_revision", CensusRevision{Value: 0}); e != nil {
		return "", e
	}
	if e = put(k.Store, "private_frontier", PrivateFrontier{Root: hex.EncodeToString(root[:])}); e != nil {
		return "", e
	}
	if e = put(k.Store, "private_root/"+hex.EncodeToString(root[:]), height); e != nil {
		return "", e
	}
	return p.Policy, put(k.Store, "private_activation", PrivateActivation{p.Policy, height + 1, p.EvidenceDigest, p.Relayer})
}
func (k Keeper) appointPrivateReviewer(c Command) (string, error) {
	if !k.guardian(c.Member) {
		return "", errors.New("guardian appointment required")
	}
	var p struct {
		Member         string `json:"member"`
		EvidenceDigest string `json:"evidence_digest"`
		Active         bool   `json:"active"`
	}
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	m, e := k.Member(p.Member)
	if e != nil || m.Licence != "active" || !digestPattern.MatchString(p.EvidenceDigest) {
		return "", errors.New("active vetted reviewer and appointment evidence required")
	}
	// Appointment does not waive the high-Karma gate when each payment is checked.
	return m.ID, put(k.Store, "private_reviewer/"+m.ID, struct {
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}{p.Active, p.EvidenceDigest})
}
func (k Keeper) privatePayment(c Command, height int64) (string, error) {
	var policy PrivateActivation
	if e := get(k.Store, "private_activation", &policy); e != nil {
		return "", e
	}
	if policy.Policy != PrivateExchangePolicy || height < policy.Height || c.Member != policy.Relayer || c.Instance != "" {
		return "", errors.New("active private policy and separate licensed relay required")
	}
	var p PrivatePayment
	if e := Decode(c.Payload, &p); e != nil {
		return "", e
	}
	var revision CensusRevision
	if e := get(k.Store, "private_licence_revision", &revision); e != nil {
		return "", e
	}
	if p.Approval.LicenceRevision != revision.Value {
		return "", errors.New("private licence snapshot changed; fresh approval required")
	}
	// Bounded fixed bundle before any expensive proof verification.
	if len(p.Bundle) == 0 || len(p.Bundle) > 22000 {
		return "", errors.New("private bundle size exceeded")
	}
	raw, e := base64.RawURLEncoding.DecodeString(p.Bundle)
	if e != nil {
		return "", e
	}
	effect, e := shield.Effects(raw)
	if e != nil {
		return "", e
	}
	if hex.EncodeToString(effect[:]) != p.Approval.Effects {
		return "", errors.New("approval is for different payment")
	}
	reviewer, e := k.Member(p.Approval.Reviewer)
	if e != nil || reviewer.Licence != "active" || reviewer.Karma < PrivateReviewerKarma {
		return "", errors.New("active high-Karma reviewer required")
	}
	var appointment struct {
		Active         bool   `json:"active"`
		EvidenceDigest string `json:"evidence_digest"`
	}
	if e = get(k.Store, "private_reviewer/"+reviewer.ID, &appointment); e != nil || !appointment.Active {
		return "", errors.New("vetted reviewer appointment required")
	}
	if p.Approval.ExpiresHeight < height || p.Approval.ExpiresHeight-height > PrivateApprovalWindow || c.ExpiresHeight > p.Approval.ExpiresHeight {
		return "", errors.New("private approval expired or too distant")
	}
	pub, e := base64.RawURLEncoding.DecodeString(reviewer.PublicKey)
	if e != nil {
		return "", e
	}
	b, e := PrivateApprovalBytes(c.ChainID, pub, p.Approval)
	if e != nil {
		return "", e
	}
	sig, e := base64.RawURLEncoding.DecodeString(p.Approval.Signature)
	if e != nil || len(sig) != 64 || !validNativeEd25519Key(pub) || !ed25519.Verify(pub, b, sig) {
		return "", errors.New("invalid private reviewer signature")
	}
	approvalHash := sha256.Sum256(append(b, sig...))
	// Explicit metering for native cryptography, in addition to bytes and SDK store gas.
	if meter, ok := k.Store.(interface{ PrivateProofGas(uint64) }); ok {
		meter.PrivateProofGas(1500000)
	}
	verified, e := shield.Verify(raw, c.ChainID, uint64(p.Approval.ExpiresHeight), approvalHash)
	if e != nil {
		return "", e
	}
	if verified.ValueBalance != 0 {
		return "", errors.New("OTC conserves shielded value; issuance and exits require separate asset bridge")
	}
	root := hex.EncodeToString(verified.Anchor[:])
	if k.Store.Get([]byte("private_root/"+root)) == nil {
		return "", errors.New("private spend anchor not in this chain epoch")
	}
	for i, nf := range verified.Nullifiers {
		key := "private_nullifier/" + hex.EncodeToString(nf[:])
		if k.Store.Get([]byte(key)) != nil || i == 1 && nf == verified.Nullifiers[0] {
			return "", errors.New("private note already spent or duplicate nullifier")
		}
	}
	var frontier PrivateFrontier
	if e = get(k.Store, "private_frontier", &frontier); e != nil {
		return "", e
	}
	if frontier.Count > (uint64(1)<<32)-2 {
		return "", errors.New("private note tree full")
	}
	paymentID := hex.EncodeToString(effect[:])
	if k.Store.Get([]byte("private_payment/"+paymentID)) != nil {
		return "", errors.New("duplicate private payment")
	}
	if e = k.appendDividendSpent(verified.Nullifiers[:]); e != nil {
		return "", e
	}
	for _, nf := range verified.Nullifiers {
		if e = put(k.Store, "private_nullifier/"+hex.EncodeToString(nf[:]), paymentID); e != nil {
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
	// Only ciphertext/proof and reviewer commitment are retained; no sender/recipient/amount fields.
	return paymentID, put(k.Store, "private_payment/"+paymentID, struct {
		Bundle   string          `json:"bundle"`
		Approval PrivateApproval `json:"approval"`
		Height   int64           `json:"height,string"`
	}{p.Bundle, p.Approval, height})
}

func (k Keeper) appendPrivateNotes(frontier *PrivateFrontier, commitments [2][32]byte) error {
	if frontier.Count > (uint64(1)<<32)-2 {
		return errors.New("private note tree full")
	}
	var e error
	for _, cmx := range commitments {
		position := frontier.Count
		node := cmx
		for level := uint8(0); level < 32; level++ {
			if position&(uint64(1)<<level) == 0 {
				frontier.Nodes[level] = hex.EncodeToString(node[:])
				empty, err := shield.Empty(level)
				if err != nil {
					return err
				}
				node, e = shield.Combine(level, node, empty)
			} else {
				bytes, err := hex.DecodeString(frontier.Nodes[level])
				if err != nil || len(bytes) != 32 {
					return errors.New("invalid private frontier")
				}
				var left [32]byte
				copy(left[:], bytes)
				node, e = shield.Combine(level, left, node)
			}
			if e != nil {
				return e
			}
		}
		if e = put(k.Store, fmt.Sprintf("private_note/%010d", position), hex.EncodeToString(cmx[:])); e != nil {
			return e
		}
		frontier.Count++
		frontier.Root = hex.EncodeToString(node[:])
	}
	return nil
}

// Licence changes invalidate every outstanding receipt without publishing its
// private participants. No additional gas/state is charged before activation.
func privateLicenceChange(s Store, key string, value any) error {
	m, ok := value.(Member)
	if !ok {
		return nil
	}
	if err := updateDividendOwnerLicence(s, m); err != nil {
		return err
	}
	var marker []byte
	if reader, ok := s.(interface{ PrivatePolicyMarker() []byte }); ok {
		marker = reader.PrivatePolicyMarker()
	} else {
		marker = s.Get([]byte("private_activation"))
	}
	if marker == nil {
		return nil
	}
	var old Member
	if b := s.Get([]byte(key)); b != nil {
		if e := json.Unmarshal(b, &old); e != nil {
			return e
		}
	}
	if (old.Licence == "active") == (m.Licence == "active") {
		return nil
	}
	var revision CensusRevision
	if e := get(s, "private_licence_revision", &revision); e != nil {
		return e
	}
	if revision.Value == math.MaxUint64 {
		return errors.New("private licence revision exhausted")
	}
	revision.Value++
	return put(s, "private_licence_revision", revision)
}
