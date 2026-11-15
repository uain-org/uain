//go:build orchard && cgo

package privatewallet

import (
	"encoding/hex"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"testing"
)

func TestIncrementalWitnessMatchesIndependentWholeTree(t *testing.T) {
	for _, count := range []int{1, 2, 3, 17, 32, 33, 65} {
		empty, err := shield.Empty(32)
		if err != nil {
			t.Fatal(err)
		}
		c := &WitnessCache{Root: encoded(empty)}
		selected := map[uint32]bool{0: true, uint32(count - 1): true}
		if count > 1 {
			selected[1] = true
		}
		leaves := []string{}
		for i := 0; i < count; i++ {
			var leaf [32]byte
			leaf[0] = byte(i + 1)
			leaf[1] = byte(i >> 8)
			value := hex.EncodeToString(leaf[:])
			leaves = append(leaves, value)
			if e := appendWitness(c, value, selected); e != nil {
				t.Fatal(e)
			}
		}
		root, e := CommitmentRoot(leaves)
		if e != nil || root != c.Root {
			t.Fatal(count, root, c.Root, e)
		}
		frontier, e := cacheRoot(c)
		if e != nil || frontier != root {
			t.Fatal("frontier", count, e)
		}
		for _, w := range c.Witnesses {
			got, e := witnessRoot(w)
			if e != nil || got != root {
				t.Fatal("path", count, w.Position, e)
			}
		}
	}
}

func TestIncrementalWitnessCrossesLegacyMillionNoteLimit(t *testing.T) {
	// Uniform complete subtree built in twenty upstream hash calls, avoiding a
	// million-leaf fixture. Its leaf path and frontier then cross the old cap.
	var leaf [32]byte
	leaf[0] = 1
	nodes := [21][32]byte{leaf}
	for level := uint8(0); level < 20; level++ {
		var e error
		nodes[level+1], e = shield.Combine(level, nodes[level], nodes[level])
		if e != nil {
			t.Fatal(e)
		}
	}
	w := NoteWitness{Position: 0, Commitment: encoded(leaf)}
	for level := uint8(0); level < 32; level++ {
		if level < 20 {
			w.Path[level] = encoded(nodes[level])
		} else {
			empty, e := shield.Empty(level)
			if e != nil {
				t.Fatal(e)
			}
			w.Path[level] = encoded(empty)
		}
	}
	c := &WitnessCache{Count: 1 << 20, Witnesses: []NoteWitness{w}}
	c.Nodes[20] = encoded(nodes[20])
	root, e := cacheRoot(c)
	if e != nil {
		t.Fatal(e)
	}
	c.Root = root
	if got, e := witnessRoot(w); e != nil || got != root {
		t.Fatal("initial path", e)
	}
	leaf[0] = 2
	if e = appendWitness(c, encoded(leaf), map[uint32]bool{1 << 20: true}); e != nil {
		t.Fatal(e)
	}
	if c.Count != MaxNotes+1 || len(c.Witnesses) != 2 {
		t.Fatal("did not cross legacy cap")
	}
	if got, e := cacheRoot(c); e != nil || got != c.Root {
		t.Fatal("updated frontier", e)
	}
	for _, w := range c.Witnesses {
		if got, e := witnessRoot(w); e != nil || got != c.Root {
			t.Fatal("updated path", w.Position, e)
		}
	}
}
