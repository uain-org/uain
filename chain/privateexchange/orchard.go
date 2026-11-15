//go:build orchard && cgo

package privateexchange

/*
#cgo LDFLAGS: -L${SRCDIR}/../private-exchange/target/release -luain_private_exchange -ldl -lpthread -lm
#include <stdint.h>
#include <stddef.h>
int uain_orchard_verify(const uint8_t*, size_t, const uint8_t*, uint8_t*);
int uain_orchard_effects(const uint8_t*, size_t, uint8_t*);
int uain_orchard_combine(uint8_t, const uint8_t*, const uint8_t*, uint8_t*);
int uain_orchard_empty(uint8_t, uint8_t*);
*/
import "C"
import (
	"crypto/sha256"
	"encoding/binary"
	"unsafe"
)

func Available() bool         { return true }
func ptr(b []byte) *C.uint8_t { return (*C.uint8_t)(unsafe.Pointer(&b[0])) }
func Effects(b []byte) ([32]byte, error) {
	var out [32]byte
	if len(b) == 0 || len(b) > 16384 {
		return out, ErrInvalid
	}
	if C.uain_orchard_effects(ptr(b), C.size_t(len(b)), ptr(out[:])) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func Verify(b []byte, chain string, expires uint64, approval [32]byte) (Result, error) {
	var out Result
	var raw [200]byte
	if len(b) == 0 || len(b) > 16384 {
		return out, ErrInvalid
	}
	var context [72]byte
	chainHash := sha256.Sum256([]byte(chain))
	copy(context[:32], chainHash[:])
	binary.BigEndian.PutUint64(context[32:40], expires)
	copy(context[40:], approval[:])
	if C.uain_orchard_verify(ptr(b), C.size_t(len(b)), ptr(context[:]), ptr(raw[:])) != 0 {
		return out, ErrInvalid
	}
	out.ValueBalance = int64(binary.LittleEndian.Uint64(raw[:8]))
	copy(out.Anchor[:], raw[8:40])
	copy(out.Effects[:], raw[40:72])
	for i := 0; i < 2; i++ {
		copy(out.Nullifiers[i][:], raw[72+i*64:104+i*64])
		copy(out.Commitments[i][:], raw[104+i*64:136+i*64])
	}
	return out, nil
}
func Combine(level uint8, left, right [32]byte) ([32]byte, error) {
	var out [32]byte
	if C.uain_orchard_combine(C.uint8_t(level), ptr(left[:]), ptr(right[:]), ptr(out[:])) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func Empty(level uint8) ([32]byte, error) {
	var out [32]byte
	if C.uain_orchard_empty(C.uint8_t(level), ptr(out[:])) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
