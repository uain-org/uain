// Package privateexchange adapts pinned Orchard without handling wallet secrets.
package privateexchange

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

var ErrUnavailable = errors.New("native Orchard verifier unavailable; build with orchard tag and pinned Rust library")
var ErrInvalid = errors.New("invalid private exchange encoding, proof or authorization")

type Result struct {
	ValueBalance int64
	Anchor       [32]byte
	Effects      [32]byte
	Nullifiers   [2][32]byte
	Commitments  [2][32]byte
}

func SignatureHash(chain string, expires uint64, approval, effects [32]byte) [32]byte {
	chainHash := sha256.Sum256([]byte(chain))
	h := sha256.New()
	h.Write([]byte("UAIN/private-exchange/sighash/v1\x00"))
	h.Write(chainHash[:])
	var height [8]byte
	binary.BigEndian.PutUint64(height[:], expires)
	h.Write(height[:])
	h.Write(approval[:])
	h.Write(effects[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
