package privatedividend

import (
	"crypto/sha256"
	"encoding/binary"
	"testing"
)

type ownerModel struct{}

func (ownerModel) OwnerEmpty(h uint8) ([32]byte, error) {
	x := sha256.Sum256([]byte("owner empty"))
	for i := uint8(0); i < h; i++ {
		x, _ = ownerModel{}.OwnerNode(i, x, x)
	}
	return x, nil
}
func (ownerModel) OwnerLeaf(member, control [32]byte, active bool) ([32]byte, error) {
	b := append([]byte("owner leaf"), member[:]...)
	b = append(b, control[:]...)
	if active {
		b = append(b, 1)
	} else {
		b = append(b, 0)
	}
	return sha256.Sum256(b), nil
}
func (ownerModel) OwnerNode(h uint8, l, r [32]byte) ([32]byte, error) {
	b := make([]byte, 67)
	copy(b, "ow")
	b[2] = h
	copy(b[3:], l[:])
	copy(b[35:], r[:])
	return sha256.Sum256(b), nil
}
func ownerRoot(hash OwnerHasher, index uint32, leaf [32]byte, path [32][32]byte) [32]byte {
	for i := uint8(0); i < 32; i++ {
		var e error
		if (index>>i)&1 == 0 {
			leaf, e = hash.OwnerNode(i, leaf, path[i])
		} else {
			leaf, e = hash.OwnerNode(i, path[i], leaf)
		}
		if e != nil {
			panic(e)
		}
	}
	return leaf
}
func TestOwnerRegistryTreeRevocationRestartAndBounds(t *testing.T) {
	s := memory{}
	tree := OwnerTree{Store: s, Hash: ownerModel{}}
	initial, e := tree.Root()
	if e != nil {
		t.Fatal(e)
	}
	members := [][32]byte{{1}, {2}, {3}}
	controls := [][32]byte{{11}, {12}, {13}}
	for i, m := range members {
		index, e := tree.Append(m, controls[i], true)
		if e != nil || index != uint32(i) {
			t.Fatal(index, e)
		}
	}
	root, e := tree.Root()
	if e != nil || root == initial {
		t.Fatal(e)
	}
	for i, m := range members {
		path, e := tree.Path(uint32(i))
		if e != nil {
			t.Fatal(e)
		}
		leaf, _ := ownerModel{}.OwnerLeaf(m, controls[i], true)
		if ownerRoot(ownerModel{}, uint32(i), leaf, path) != root {
			t.Fatal("inclusion")
		}
	}
	if e := tree.Update(1, members[0], controls[1], false); e == nil {
		t.Fatal("member replacement")
	}
	if e := tree.Update(1, members[1], controls[0], false); e == nil {
		t.Fatal("control replacement")
	}
	before := root
	if e := tree.Update(1, members[1], controls[1], false); e != nil {
		t.Fatal(e)
	}
	root, _ = tree.Root()
	if root == before {
		t.Fatal("revocation did not invalidate old root")
	}
	p, _ := tree.Path(1)
	leaf, _ := ownerModel{}.OwnerLeaf(members[1], controls[1], true)
	if ownerRoot(ownerModel{}, 1, leaf, p) == root {
		t.Fatal("revoked licensed proof")
	}
	if e := tree.Update(3, members[1], controls[1], true); e == nil {
		t.Fatal("unallocated update")
	}
	if _, e := tree.Path(3); e == nil {
		t.Fatal("unallocated path")
	}
	reopened := OwnerTree{Store: s, Hash: ownerModel{}}
	got, _ := reopened.Root()
	if got != root {
		t.Fatal("restart")
	}
	var count [8]byte
	binary.LittleEndian.PutUint64(count[:], 1<<32)
	s.Set([]byte("dividend_owner1/count"), count[:])
	if _, e := tree.Append(members[0], controls[0], true); e == nil {
		t.Fatal("tree overflow")
	}
	s.Set([]byte("dividend_owner1/count"), []byte{1})
	if _, e := tree.Root(); e == nil {
		t.Fatal("corrupt count")
	}
}
