package privatedividend

import (
	"crypto/sha256"
	"encoding/binary"
	"testing"
)

type memory map[string][]byte

func (m memory) Get(k []byte) []byte { return append([]byte(nil), m[string(k)]...) }
func (m memory) Set(k, v []byte)     { m[string(k)] = append([]byte(nil), v...) }

type modelHasher struct{}

func (modelHasher) Empty(h uint16) ([32]byte, error) {
	x := sha256.Sum256([]byte("empty leaf"))
	for i := uint16(0); i < h; i++ {
		x, _ = modelHasher{}.Node(i, x, x)
	}
	return x, nil
}
func (modelHasher) Leaf(k [32]byte) ([32]byte, error) {
	return sha256.Sum256(append([]byte("occupied"), k[:]...)), nil
}
func (modelHasher) Node(h uint16, l, r [32]byte) ([32]byte, error) {
	b := make([]byte, 66)
	binary.LittleEndian.PutUint16(b, h)
	copy(b[2:], l[:])
	copy(b[34:], r[:])
	return sha256.Sum256(b), nil
}

// SHA model tests persistent tree structure only. Rust/FFI tests qualify Poseidon.
func TestCompressedSparseTreeOrderHistoryAndAbsence(t *testing.T) {
	keys := [][32]byte{{}, {1}, {2}, {17}, {19}, {255}, {0, 1}, {255, 255}, {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128}}
	s := memory{}
	tree := Tree{Store: s, Hash: modelHasher{}}
	old, err := tree.Root()
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		p, err := tree.Path(k)
		if err != nil {
			t.Fatal(err)
		}
		root, _ := tree.Root()
		if !absence(modelHasher{}, root, k, p) {
			t.Fatal("unspent false exclusion")
		}
		if err := tree.Insert(k); err != nil {
			t.Fatal(err)
		}
		p, _ = tree.Path(k)
		root, _ = tree.Root()
		if absence(modelHasher{}, root, k, p) {
			t.Fatal("spent accepted")
		}
	}
	root, _ := tree.Root()
	if root == old {
		t.Fatal("no change")
	}
	if err := tree.Insert(keys[0]); err == nil {
		t.Fatal("duplicate")
	}
	reverse := Tree{Store: memory{}, Hash: modelHasher{}}
	for i := len(keys) - 1; i >= 0; i-- {
		if err := reverse.Insert(keys[i]); err != nil {
			t.Fatal(err)
		}
	}
	r, _ := reverse.Root()
	if r != root {
		t.Fatal("order dependent")
	}
	gap := [32]byte{18}
	p, _ := tree.Path(gap)
	if !absence(modelHasher{}, root, gap, p) {
		t.Fatal("gap excluded")
	}
	reopened := Tree{Store: s, Hash: modelHasher{}}
	r, _ = reopened.Root()
	if r != root {
		t.Fatal("restart")
	}
	if len(s) > 3*len(keys)+2 {
		t.Fatalf("uncompressed storage %d", len(s))
	}
}
func absence(h Hasher, root, key [32]byte, path [256][32]byte) bool {
	x, _ := h.Empty(0)
	for i := uint16(0); i < 256; i++ {
		if bit(key, i) == 0 {
			x, _ = h.Node(i, x, path[i])
		} else {
			x, _ = h.Node(i, path[i], x)
		}
	}
	return x == root
}
func TestCompressedSparseTreeMalformedStateFails(t *testing.T) {
	for _, bad := range [][]byte{{1}, make([]byte, 65), make([]byte, 67)} {
		s := memory{"dividend_smt1/root": bad}
		tree := Tree{Store: s, Hash: modelHasher{}}
		if _, err := tree.Root(); err == nil {
			t.Fatal("invalid root accepted")
		}
	}
}

// A cache is canonical native state, not an external witness. Its parent hash
// must still reject corruption; paths always verify against the full root.
func TestCompressedSparseTreeCachedEdgesRejectCorruption(t *testing.T) {
	for _, offset := range []int{132, 164} {
		store := memory{}
		tree := Tree{Store: store, Hash: modelHasher{}}
		tree.Insert([32]byte{})
		tree.Insert([32]byte{2})
		root, _, _ := tree.root()
		key := nodeKey(root)
		record := store.Get(key)
		record[offset] ^= 1
		store.Set(key, record)
		if _, e := tree.Path([32]byte{1}); e == nil {
			t.Fatal("corrupted edge cache accepted", offset)
		}
		if e := tree.Insert([32]byte{1}); e == nil {
			t.Fatal("corrupted edge cache mutated tree", offset)
		}
	}
}
func TestCompressedSparseTreeDeepBranchesRetainFullDepthPaths(t *testing.T) {
	tree := Tree{Store: memory{}, Hash: modelHasher{}}
	final := [32]byte{}
	for i := range final {
		final[i] = 255
	}
	final[31] = 63
	for i := 0; i < 254; i++ {
		key := final
		key[i/8] ^= 1 << uint(i%8)
		if e := tree.Insert(key); e != nil {
			t.Fatal(e)
		}
	}
	root, _ := tree.Root()
	path, e := tree.Path(final)
	if e != nil || !absence(modelHasher{}, root, final, path) {
		t.Fatal("deep absent path invalid", e)
	}
	if e = tree.Insert(final); e != nil {
		t.Fatal(e)
	}
	root, _ = tree.Root()
	path, e = tree.Path(final)
	if e != nil || absence(modelHasher{}, root, final, path) {
		t.Fatal("deep occupied path invalid", e)
	}
}
