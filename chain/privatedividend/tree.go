// Package privatedividend implements deterministic historical dividend helpers.
// No policy is activated by this package. Callers must use an atomic native cache.
package privatedividend

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// Hasher implementations must validate canonical field encodings. The native
// implementation uses the same versioned Poseidon as the full-depth circuit.
type Hasher interface {
	Empty(height uint16) ([32]byte, error)
	Leaf(key [32]byte) ([32]byte, error)
	Node(level uint16, left, right [32]byte) ([32]byte, error)
}
type Store interface {
	Get([]byte) []byte
	Set([]byte, []byte)
}
type Tree struct {
	Store Store
	Hash  Hasher
}
type descriptor struct {
	height    uint16
	key, hash [32]byte
}

var errTree = errors.New("invalid dividend sparse tree state")

const rootKey = "dividend_smt1/root"

func bit(k [32]byte, i uint16) byte { return (k[i/8] >> (i % 8)) & 1 }
func shift(k [32]byte, h uint16) [32]byte {
	for j := uint16(0); j < h; j++ {
		for i := 0; i < 32; i++ {
			k[i] = (k[i] >> 1)
			if i < 31 {
				k[i] |= k[i+1] << 7
			}
		}
	}
	return k
}
func nodeKey(d descriptor) []byte {
	b := make([]byte, len("dividend_smt1/n/")+34)
	copy(b, "dividend_smt1/n/")
	binary.BigEndian.PutUint16(b[len(b)-34:], d.height)
	p := shift(d.key, d.height)
	copy(b[len(b)-32:], p[:])
	return b
}
func encode(d descriptor) []byte {
	b := make([]byte, 66)
	binary.LittleEndian.PutUint16(b, d.height)
	copy(b[2:34], d.key[:])
	copy(b[34:], d.hash[:])
	return b
}
func decode(b []byte) (descriptor, error) {
	var d descriptor
	if len(b) != 66 {
		return d, errTree
	}
	d.height = binary.LittleEndian.Uint16(b)
	if d.height > 256 {
		return d, errTree
	}
	copy(d.key[:], b[2:34])
	copy(d.hash[:], b[34:])
	return d, nil
}
func (t Tree) root() (descriptor, bool, error) {
	if t.Store == nil || t.Hash == nil {
		return descriptor{}, false, errTree
	}
	b := t.Store.Get([]byte(rootKey))
	if b == nil {
		return descriptor{}, false, nil
	}
	d, e := decode(b)
	return d, true, e
}
func (t Tree) expand(d descriptor, to uint16) ([32]byte, error) {
	if to > 256 || d.height > to {
		return [32]byte{}, errTree
	}
	x := d.hash
	for level := d.height; level < to; level++ {
		empty, e := t.Hash.Empty(level)
		if e != nil {
			return x, e
		}
		if bit(d.key, level) == 0 {
			x, e = t.Hash.Node(level, x, empty)
		} else {
			x, e = t.Hash.Node(level, empty, x)
		}
		if e != nil {
			return x, e
		}
	}
	return x, nil
}
func (t Tree) Root() ([32]byte, error) {
	d, ok, e := t.root()
	if e != nil {
		return [32]byte{}, e
	}
	if !ok {
		return t.Hash.Empty(256)
	}
	return t.expand(d, 256)
}

// divergence is the branch height needed to distinguish two keys; zero means equal.
func divergence(a, b [32]byte) uint16 {
	for i := 31; i >= 0; i-- {
		x := a[i] ^ b[i]
		if x != 0 {
			for j := 7; j >= 0; j-- {
				if (x>>j)&1 == 1 {
					return uint16(i*8 + j + 1)
				}
			}
		}
	}
	return 0
}

type children struct {
	left, right         descriptor
	leftEdge, rightEdge [32]byte
}

// Branch records are canonical consensus state, created only by branchCached.
// Cached expanded edges are part of that state and checked against the parent
// hash. Rehashing every unchanged compressed edge would be quadratic in depth.
// These helpers do not accept externally asserted branch records as witnesses.
func (t Tree) children(d descriptor) (children, error) {
	var out children
	if d.height == 0 {
		return out, errTree
	}
	b := t.Store.Get(nodeKey(d))
	if len(b) != 196 {
		return out, errTree
	}
	var e error
	out.left, e = decode(b[:66])
	if e != nil {
		return out, e
	}
	out.right, e = decode(b[66:132])
	if e != nil {
		return out, e
	}
	left, right := out.left, out.right
	if left.height >= d.height || right.height >= d.height || bit(left.key, d.height-1) != 0 || bit(right.key, d.height-1) != 1 || divergence(left.key, right.key) != d.height || divergence(left.key, d.key) > d.height {
		return out, errTree
	}
	copy(out.leftEdge[:], b[132:164])
	copy(out.rightEdge[:], b[164:])
	joined, e := t.Hash.Node(d.height-1, out.leftEdge, out.rightEdge)
	if e != nil || joined != d.hash {
		return out, errTree
	}
	return out, nil
}
func (t Tree) branchCached(height uint16, left, right descriptor, l, r [32]byte, write bool) (descriptor, error) {
	d := descriptor{height: height, key: left.key}
	if height == 0 || height > 256 {
		return d, errTree
	}
	var e error
	d.hash, e = t.Hash.Node(height-1, l, r)
	if e != nil {
		return d, e
	}
	if write {
		b := append(encode(left), encode(right)...)
		b = append(b, l[:]...)
		b = append(b, r[:]...)
		t.Store.Set(nodeKey(d), b)
	}
	return d, nil
}
func (t Tree) branch(height uint16, left, right descriptor, write bool) (descriptor, error) {
	if height == 0 || height > 256 {
		return descriptor{}, errTree
	}
	l, e := t.expand(left, height-1)
	if e != nil {
		return descriptor{}, e
	}
	r, e := t.expand(right, height-1)
	if e != nil {
		return descriptor{}, e
	}
	return t.branchCached(height, left, right, l, r, write)
}
func (t Tree) insert(cur, leaf descriptor) (descriptor, error) {
	different := divergence(cur.key, leaf.key)
	if different == 0 {
		return cur, errors.New("duplicate spent nullifier")
	}
	if different > cur.height {
		if bit(leaf.key, different-1) == 0 {
			return t.branch(different, leaf, cur, true)
		}
		return t.branch(different, cur, leaf, true)
	}
	children, e := t.children(cur)
	if e != nil {
		return cur, e
	}
	if bit(leaf.key, cur.height-1) == 0 {
		children.left, e = t.insert(children.left, leaf)
		if e == nil {
			children.leftEdge, e = t.expand(children.left, cur.height-1)
		}
	} else {
		children.right, e = t.insert(children.right, leaf)
		if e == nil {
			children.rightEdge, e = t.expand(children.right, cur.height-1)
		}
	}
	if e != nil {
		return cur, e
	}
	return t.branchCached(cur.height, children.left, children.right, children.leftEdge, children.rightEdge, true)
}

// Insert writes only actual branching nodes. Expanded empty edges are computed,
// avoiding 256 consensus writes per nullifier. Errors require caller cache rollback.
func (t Tree) Insert(key [32]byte) error {
	leafHash, e := t.Hash.Leaf(key)
	if e != nil {
		return e
	}
	leaf := descriptor{key: key, hash: leafHash}
	d, ok, e := t.root()
	if e != nil {
		return e
	}
	if ok {
		d, e = t.insert(d, leaf)
		if e != nil {
			return e
		}
	} else {
		d = leaf
	}
	t.Store.Set([]byte(rootKey), encode(d))
	return nil
}
func (t Tree) pathAt(d descriptor, key [32]byte, p *[256][32]byte) error {
	different := divergence(d.key, key)
	if different > d.height {
		v, e := t.expand(d, different-1)
		if e != nil {
			return e
		}
		p[different-1] = v
		return nil
	}
	if d.height == 0 {
		return nil
	}
	children, e := t.children(d)
	if e != nil {
		return e
	}
	next, opposite := children.left, children.right
	if bit(key, d.height-1) == 1 {
		next, opposite = children.right, children.left
	}
	p[d.height-1], e = t.expand(opposite, d.height-1)
	if e != nil {
		return e
	}
	return t.pathAt(next, key, p)
}
func (t Tree) Path(key [32]byte) ([256][32]byte, error) {
	var p [256][32]byte
	if _, e := t.Hash.Leaf(key); e != nil {
		return p, e
	}
	d, ok, e := t.root()
	if e != nil {
		return p, e
	}
	for i := uint16(0); i < 256; i++ {
		p[i], e = t.Hash.Empty(i)
		if e != nil {
			return p, e
		}
	}
	if ok {
		e = t.pathAt(d, key, &p)
	}
	return p, e
}

// EqualRoot is useful when authenticating a public snapshot proof; it does not
// replace signed-header/IAVL verification of the native root record.
func EqualRoot(a, b [32]byte) bool { return bytes.Equal(a[:], b[:]) }
