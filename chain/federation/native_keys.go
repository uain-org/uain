package federation

import (
	"bytes"
	"crypto/ed25519"

	"filippo.io/edwards25519"
)

// Go's Ed25519 verifier accepts identity-point public keys with a fixed forged
// signature. Native identities must use canonical nonidentity prime-order keys.
// Projecting [8]P back by 8^-1 removes torsion; equality rejects every nontrivial
// torsion component without changing any signing or ledger hash bytes.
func validNativeEd25519Key(pub []byte) bool {
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
	return new(edwards25519.Point).ScalarMult(inverse, cofactor).Equal(point) == 1
}
