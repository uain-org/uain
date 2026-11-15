package privatedividend

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

const RegistrationVersion = "uain-dividend-member-carry-v1"
const RegistrationPublicSize = 192

// RegistrationContext requires the immutable genesis pin from the application,
// never a transaction field. The member authorizes this exact control in an
// original Ed25519 native command, as well as the Orchard spend authorization.
func RegistrationContext(chain string, genesis, member, control [32]byte) ([2][32]byte, error) {
	var out [2][32]byte
	if !snapshotID.MatchString(chain) || genesis == [32]byte{} || !CanonicalField(control) {
		return out, ErrInvalid
	}
	b := []byte("UAIN/dividend/member-carry-context/v1\x00")
	for _, v := range []string{RegistrationVersion, chain} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(v)))
		b = append(b, n[:]...)
		b = append(b, v...)
	}
	b = append(b, genesis[:]...)
	b = append(b, member[:]...)
	b = append(b, control[:]...)
	h := sha256.Sum256(b)
	copy(out[0][:16], h[:16])
	copy(out[1][:16], h[16:])
	return out, nil
}

type RegistrationVerifier interface {
	VerifyRegistration(public [RegistrationPublicSize]byte, proof []byte, signature [64]byte) error
}

// MatchRegistration rejects changed member/chain/genesis/control, inexact limb
// encodings, field aliases and wrong statement widths before native verification.
func MatchRegistration(public []byte, chain string, genesis, member, control [32]byte) ([RegistrationPublicSize]byte, error) {
	var out [RegistrationPublicSize]byte
	if len(public) != len(out) {
		return out, ErrInvalid
	}
	copy(out[:], public)
	for i := 0; i < 6; i++ {
		var f [32]byte
		copy(f[:], out[i*32:])
		if !CanonicalField(f) {
			return out, ErrInvalid
		}
	}
	ctx, e := RegistrationContext(chain, genesis, member, control)
	if e != nil {
		return out, e
	}
	var got [32]byte
	copy(got[:], out[:32])
	if got != control {
		return out, errors.New("registration control mismatch")
	}
	for i := 0; i < 2; i++ {
		copy(got[:], out[(i+1)*32:])
		if got != ctx[i] {
			return out, errors.New("registration original-member context mismatch")
		}
	}
	return out, nil
}
