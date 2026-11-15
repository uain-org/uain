//go:build orchard && cgo

package privatedividend

import (
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

func TestPoseidonFFIAndCompressedTreeMatchFullRustVectors(t *testing.T) {
	raw, e := os.ReadFile("testdata/smt-vectors.txt")
	if e != nil {
		t.Fatal(e)
	}
	lines := strings.Fields(string(raw))
	if len(lines) != 7 {
		t.Fatal("invalid vectors")
	}
	var vectors [7][32]byte
	for i, line := range lines {
		v, e := hex.DecodeString(line)
		if e != nil || len(v) != 32 {
			t.Fatal("invalid vector")
		}
		copy(vectors[i][:], v)
	}
	tree := Tree{Store: memory{}, Hash: Poseidon{}}
	root, e := tree.Root()
	if e != nil || root != vectors[3] {
		t.Fatal("wrong empty Poseidon root", e)
	}
	for i := 0; i < 3; i++ {
		path, e := tree.Path(vectors[i])
		if e != nil || !absence(Poseidon{}, root, vectors[i], path) {
			t.Fatal("false exclusion", i, e)
		}
		if e = tree.Insert(vectors[i]); e != nil {
			t.Fatal(e)
		}
		root, e = tree.Root()
		if e != nil || root != vectors[4+i] {
			t.Fatal("Rust/native root mismatch", i, e)
		}
		path, e = tree.Path(vectors[i])
		if e != nil || absence(Poseidon{}, root, vectors[i], path) {
			t.Fatal("occupied accepted", i, e)
		}
	}
	before, _ := tree.Root()
	if e = tree.Insert(fieldModulusLE()); e == nil {
		t.Fatal("noncanonical key accepted")
	}
	after, _ := tree.Root()
	if before != after {
		t.Fatal("rejected key mutated root")
	}
	if _, e = (Poseidon{}).Node(256, [32]byte{}, [32]byte{}); e == nil {
		t.Fatal("invalid level")
	}
	if _, e = (Poseidon{}).Empty(257); e == nil {
		t.Fatal("invalid height")
	}
}

func TestPoseidonOwnerRegistryMatchesRustAndRevocationVectors(t *testing.T) {
	raw, e := os.ReadFile("testdata/owner-vectors.txt")
	if e != nil {
		t.Fatal(e)
	}
	lines := strings.Fields(string(raw))
	if len(lines) != 5 {
		t.Fatal("owner vectors")
	}
	tree := OwnerTree{Store: memory{}, Hash: Poseidon{}}
	check := func(i int) {
		root, e := tree.Root()
		if e != nil || hex.EncodeToString(root[:]) != lines[i] {
			t.Fatal("Rust owner root mismatch", i, e)
		}
	}
	check(0)
	for i := 0; i < 3; i++ {
		if _, e = tree.Append([32]byte{byte(i + 1)}, [32]byte{byte(i + 11)}, true); e != nil {
			t.Fatal(e)
		}
		check(i + 1)
	}
	if e = tree.Update(1, [32]byte{2}, [32]byte{12}, false); e != nil {
		t.Fatal(e)
	}
	check(4)
	path, e := tree.Path(1)
	if e != nil {
		t.Fatal(e)
	}
	revoked, _ := Poseidon{}.OwnerLeaf([32]byte{2}, [32]byte{12}, false)
	root, e := tree.Root()
	if e != nil || ownerRoot(Poseidon{}, 1, revoked, path) != root {
		t.Fatal("actual owner path")
	}
	active, _ := Poseidon{}.OwnerLeaf([32]byte{2}, [32]byte{12}, true)
	if ownerRoot(Poseidon{}, 1, active, path) == root {
		t.Fatal("revoked owner still licensed")
	}
}
