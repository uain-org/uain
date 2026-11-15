package privatedividend

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// OwnerHasher is a distinct versioned hash domain, not the spent-NF tree.
// The caller authenticates the current root; accepting a claimant's old root
// would let a revoked member bypass current licensed eligibility.
type OwnerHasher interface {
	OwnerEmpty(height uint8) ([32]byte, error)
	OwnerLeaf(member, control [32]byte, active bool) ([32]byte, error)
	OwnerNode(level uint8, left, right [32]byte) ([32]byte, error)
}

// OwnerTree assigns one immutable member/control pair to a 32-bit index.
// Native registration must additionally enforce unique member and unique
// control and original member consent. This helper cannot authenticate consent.
// Update changes only licensed status. Callers use an atomic native cache.
type OwnerTree struct {
	Store Store
	Hash  OwnerHasher
}

var errOwner = errors.New("invalid dividend licensed owner tree state")

const ownerCount = "dividend_owner1/count"

func ownerNodeKey(level uint8, index uint64) []byte {
	b := make([]byte, len("dividend_owner1/n/")+9)
	copy(b, "dividend_owner1/n/")
	b[len(b)-9] = level
	binary.BigEndian.PutUint64(b[len(b)-8:], index)
	return b
}
func ownerIdentityKey(index uint32) []byte {
	b := make([]byte, len("dividend_owner1/i/")+4)
	copy(b, "dividend_owner1/i/")
	binary.BigEndian.PutUint32(b[len(b)-4:], index)
	return b
}
func (t OwnerTree) Count() (uint64, error) {
	if t.Store == nil || t.Hash == nil {
		return 0, errOwner
	}
	b := t.Store.Get([]byte(ownerCount))
	if b == nil {
		return 0, nil
	}
	if len(b) != 8 {
		return 0, errOwner
	}
	n := binary.LittleEndian.Uint64(b)
	if n > 1<<32 {
		return 0, errOwner
	}
	return n, nil
}
func (t OwnerTree) read(level uint8, index, count uint64) ([32]byte, error) {
	var out [32]byte
	if level > 32 || index >= (uint64(1)<<(32-level)) {
		return out, errOwner
	}
	if index<<level >= count {
		return t.Hash.OwnerEmpty(level)
	}
	b := t.Store.Get(ownerNodeKey(level, index))
	if len(b) != 32 {
		return out, errOwner
	}
	copy(out[:], b)
	return out, nil
}
func (t OwnerTree) Root() ([32]byte, error) {
	n, e := t.Count()
	if e != nil {
		return [32]byte{}, e
	}
	return t.read(32, 0, n)
}
func (t OwnerTree) Path(index uint32) ([32][32]byte, error) {
	var path [32][32]byte
	n, e := t.Count()
	if e != nil {
		return path, e
	}
	if uint64(index) >= n {
		return path, errOwner
	}
	for level := uint8(0); level < 32; level++ {
		path[level], e = t.read(level, (uint64(index)>>level)^1, n)
		if e != nil {
			return path, e
		}
	}
	return path, nil
}
func (t OwnerTree) write(index uint32, member, control [32]byte, active bool, count uint64) error {
	leaf, e := t.Hash.OwnerLeaf(member, control, active)
	if e != nil {
		return e
	}
	type entry struct {
		k []byte
		v [32]byte
	}
	pending := []entry{{ownerNodeKey(0, uint64(index)), leaf}}
	for level := uint8(0); level < 32; level++ {
		sibling, e := t.read(level, (uint64(index)>>level)^1, count)
		if e != nil {
			return e
		}
		if (index>>level)&1 == 0 {
			leaf, e = t.Hash.OwnerNode(level, leaf, sibling)
		} else {
			leaf, e = t.Hash.OwnerNode(level, sibling, leaf)
		}
		if e != nil {
			return e
		}
		pending = append(pending, entry{ownerNodeKey(level+1, uint64(index)>>(level+1)), leaf})
	}
	for _, v := range pending {
		t.Store.Set(v.k, v.v[:])
	}
	return nil
}
func (t OwnerTree) Append(member, control [32]byte, active bool) (uint32, error) {
	n, e := t.Count()
	if e != nil {
		return 0, e
	}
	if n >= 1<<32 {
		return 0, errOwner
	}
	index := uint32(n)
	if t.Store.Get(ownerIdentityKey(index)) != nil {
		return 0, errOwner
	}
	if e = t.write(index, member, control, active, n); e != nil {
		return 0, e
	}
	identity := append(append([]byte{}, member[:]...), control[:]...)
	t.Store.Set(ownerIdentityKey(index), identity)
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], n+1)
	t.Store.Set([]byte(ownerCount), b[:])
	return index, nil
}
func (t OwnerTree) Update(index uint32, member, control [32]byte, active bool) error {
	n, e := t.Count()
	if e != nil {
		return e
	}
	if uint64(index) >= n {
		return errOwner
	}
	identity := append(append([]byte{}, member[:]...), control[:]...)
	if !bytes.Equal(t.Store.Get(ownerIdentityKey(index)), identity) {
		return errors.New("registered member/control is immutable")
	}
	return t.write(index, member, control, active, n)
}
