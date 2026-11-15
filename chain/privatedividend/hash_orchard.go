//go:build orchard && cgo

package privatedividend

/*
#cgo LDFLAGS: -L${SRCDIR}/../private-dividend/target/release -luain_private_dividend -ldl -lpthread -lm
#include <stdint.h>
#include <stddef.h>
int uain_dividend_smt_leaf(const uint8_t*,uint8_t*);
int uain_dividend_smt_node(uint16_t,const uint8_t*,const uint8_t*,uint8_t*);
int uain_dividend_smt_empty(uint16_t,uint8_t*);
int uain_dividend_owner_leaf(const uint8_t*,const uint8_t*,uint8_t,uint8_t*);
int uain_dividend_owner_node(uint8_t,const uint8_t*,const uint8_t*,uint8_t*);
int uain_dividend_owner_empty(uint8_t,uint8_t*);
int uain_dividend_registration_verify(const uint8_t*,const uint8_t*,size_t,const uint8_t*);
*/
import "C"
import "unsafe"

func hashPtr(v *[32]byte) *C.uint8_t { return (*C.uint8_t)(unsafe.Pointer(&v[0])) }
func HashAvailable() bool            { return true }
func (Poseidon) Empty(h uint16) ([32]byte, error) {
	var out [32]byte
	if h > 256 || C.uain_dividend_smt_empty(C.uint16_t(h), hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func (Poseidon) Leaf(k [32]byte) ([32]byte, error) {
	var out [32]byte
	if C.uain_dividend_smt_leaf(hashPtr(&k), hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func (Poseidon) Node(h uint16, l, r [32]byte) ([32]byte, error) {
	var out [32]byte
	if h >= 256 || C.uain_dividend_smt_node(C.uint16_t(h), hashPtr(&l), hashPtr(&r), hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}

func (Poseidon) OwnerLeaf(member, control [32]byte, active bool) ([32]byte, error) {
	var out [32]byte
	var a C.uint8_t
	if active {
		a = 1
	}
	if C.uain_dividend_owner_leaf(hashPtr(&member), hashPtr(&control), a, hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func (Poseidon) OwnerNode(level uint8, l, r [32]byte) ([32]byte, error) {
	var out [32]byte
	if level >= 32 || C.uain_dividend_owner_node(C.uint8_t(level), hashPtr(&l), hashPtr(&r), hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}
func (Poseidon) OwnerEmpty(height uint8) ([32]byte, error) {
	var out [32]byte
	if height > 32 || C.uain_dividend_owner_empty(C.uint8_t(height), hashPtr(&out)) != 0 {
		return out, ErrInvalid
	}
	return out, nil
}

func (Poseidon) VerifyRegistration(public [RegistrationPublicSize]byte, proof []byte, signature [64]byte) error {
	if len(proof) == 0 || len(proof) > 64*1024 {
		return ErrInvalid
	}
	if C.uain_dividend_registration_verify((*C.uint8_t)(unsafe.Pointer(&public[0])), (*C.uint8_t)(unsafe.Pointer(&proof[0])), C.size_t(len(proof)), (*C.uint8_t)(unsafe.Pointer(&signature[0]))) != 0 {
		return ErrInvalid
	}
	return nil
}
