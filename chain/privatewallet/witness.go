package privatewallet

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/uain-org/uain/chain/federation"
	shield "github.com/uain-org/uain/chain/privateexchange"
)

// Cache contains public hashes but private note selections. It is untrusted
// input: checkpoint, frontier and every path are verified again before use.
type WitnessCache struct {
	ChainID   string        `json:"chain_id"`
	Count     uint64        `json:"count,string"`
	Root      string        `json:"root"`
	Nodes     [32]string    `json:"nodes"`
	Witnesses []NoteWitness `json:"witnesses"`
}
type NoteWitness struct {
	Position   uint32     `json:"position"`
	Commitment string     `json:"commitment"`
	Path       [32]string `json:"path"`
}

func hashBytes(value string) ([32]byte, error) {
	var out [32]byte
	if !digestID.MatchString(value) {
		return out, errors.New("noncanonical witness hash")
	}
	raw, _ := hex.DecodeString(value)
	copy(out[:], raw)
	return out, nil
}
func encoded(value [32]byte) string { return hex.EncodeToString(value[:]) }
func witnessRoot(w NoteWitness) (string, error) {
	node, err := hashBytes(w.Commitment)
	if err != nil {
		return "", err
	}
	for level := uint8(0); level < 32; level++ {
		sibling, e := hashBytes(w.Path[level])
		if e != nil {
			return "", e
		}
		if uint64(w.Position)&(uint64(1)<<level) == 0 {
			node, err = shield.Combine(level, node, sibling)
		} else {
			node, err = shield.Combine(level, sibling, node)
		}
		if err != nil {
			return "", err
		}
	}
	return encoded(node), nil
}
func cacheRoot(c *WitnessCache) (string, error) {
	// A full tree cannot accept another payment. Still support read/validation
	// of its complete root using at least one authenticated membership path.
	if c.Count == uint64(1)<<32 {
		if len(c.Witnesses) == 0 {
			return "", errors.New("full tree requires a membership path")
		}
		return witnessRoot(c.Witnesses[0])
	}
	node, err := shield.Empty(0)
	if err != nil {
		return "", err
	}
	for level := uint8(0); level < 32; level++ {
		if c.Count&(uint64(1)<<level) != 0 {
			left, e := hashBytes(c.Nodes[level])
			if e != nil {
				return "", e
			}
			node, err = shield.Combine(level, left, node)
		} else {
			empty, e := shield.Empty(level)
			if e != nil {
				return "", e
			}
			node, err = shield.Combine(level, node, empty)
		}
		if err != nil {
			return "", err
		}
	}
	return encoded(node), nil
}
func appendWitness(c *WitnessCache, commitment string, selected map[uint32]bool) error {
	if c.Count >= uint64(1)<<32 {
		return errors.New("note tree full")
	}
	position := c.Count
	node, err := hashBytes(commitment)
	if err != nil {
		return err
	}
	if selected[uint32(position)] {
		w := NoteWitness{Position: uint32(position), Commitment: commitment}
		for level := uint8(0); level < 32; level++ {
			if position&(uint64(1)<<level) != 0 {
				w.Path[level] = c.Nodes[level]
			} else {
				empty, e := shield.Empty(level)
				if e != nil {
					return e
				}
				w.Path[level] = encoded(empty)
			}
		}
		c.Witnesses = append(c.Witnesses, w)
	}
	for level := uint8(0); level < 32; level++ {
		for i := range c.Witnesses {
			if (position>>level)^1 == uint64(c.Witnesses[i].Position)>>level {
				c.Witnesses[i].Path[level] = encoded(node)
			}
		}
		if position&(uint64(1)<<level) == 0 {
			c.Nodes[level] = encoded(node)
			empty, e := shield.Empty(level)
			if e != nil {
				return e
			}
			node, err = shield.Combine(level, node, empty)
		} else {
			left, e := hashBytes(c.Nodes[level])
			if e != nil {
				return e
			}
			node, err = shield.Combine(level, left, node)
		}
		if err != nil {
			return err
		}
	}
	c.Count++
	c.Root = encoded(node)
	return nil
}
func readCompactWitness(ctx context.Context, source Source, height int64, chain string, frontier federation.PrivateFrontier, request Request, query func(string, any, bool) error) (*WitnessCache, uint64, error) {
	selected := map[uint32]bool{}
	for _, position := range request.WitnessPositions {
		if selected[position] || uint64(position) >= frontier.Count {
			return nil, 0, errors.New("duplicate or absent witness position")
		}
		selected[position] = true
	}
	empty, err := shield.Empty(32)
	if err != nil {
		return nil, 0, err
	}
	c := &WitnessCache{ChainID: chain, Root: encoded(empty), Witnesses: []NoteWitness{}}
	if old := request.WitnessCache; old != nil {
		if old.ChainID != chain || old.Count > frontier.Count || len(old.Witnesses) > 16 || !digestID.MatchString(old.Root) {
			return nil, 0, errors.New("invalid witness cache context")
		}
		root, e := cacheRoot(old)
		if e != nil || root != old.Root {
			return nil, 0, errors.New("cached frontier does not match its root")
		}
		var accepted int64
		if e = query("private_root/"+old.Root, &accepted, false); e != nil || accepted < 1 || accepted > height {
			return nil, 0, errors.New("cached root is not finalized on this chain")
		}
		*c = *old
		c.Witnesses = []NoteWitness{}
		seen := map[uint32]bool{}
		for _, w := range old.Witnesses {
			root, e := witnessRoot(w)
			if seen[w.Position] || uint64(w.Position) >= old.Count || e != nil || root != old.Root {
				return nil, 0, errors.New("invalid cached membership path")
			}
			seen[w.Position] = true
			if selected[w.Position] {
				c.Witnesses = append(c.Witnesses, w)
			}
		}
		for position := range selected {
			if uint64(position) < old.Count && !seen[position] {
				return nil, 0, errors.New("new old-note selection requires a cold compact sync")
			}
		}
	}
	initial := c.Count
	// SDK ranges may be latest even at an old requested height. Every byte used
	// below is bound by the final proven count/root, never the range's assertion.
	for c.Count < frontier.Count {
		if err = ctx.Err(); err != nil {
			return nil, 0, err
		}
		start := c.Count
		end := (start/NotePage + 1) * NotePage
		if end > frontier.Count {
			end = frontier.Count
		}
		prefix := []byte(fmt.Sprintf("private_note/%010d", start)[:20])
		q, e := source.Query(ctx, "/store/federation/subspace", prefix, height, false)
		if e != nil {
			return nil, 0, e
		}
		if q.Code != 0 || !bytes.Equal(q.Key, prefix) {
			return nil, 0, errors.New("invalid compact note page")
		}
		pairs, e := decodePage(q.Value)
		if e != nil {
			return nil, 0, e
		}
		for _, row := range pairs {
			var position uint64
			if len(row.Key) != 23 || !bytes.HasPrefix(row.Key, prefix) {
				return nil, 0, errors.New("compact note page escaped prefix")
			}
			if _, e = fmt.Sscanf(string(row.Key), "private_note/%010d", &position); e != nil || string(row.Key) != fmt.Sprintf("private_note/%010d", position) {
				return nil, 0, errors.New("invalid compact note position")
			}
			if position < start || position >= frontier.Count {
				continue
			}
			if position != c.Count {
				return nil, 0, errors.New("incomplete or unordered compact note page")
			}
			var commitment string
			if e = json.Unmarshal(row.Value, &commitment); e != nil {
				return nil, 0, e
			}
			if e = appendWitness(c, commitment, selected); e != nil {
				return nil, 0, e
			}
		}
		if c.Count != end {
			return nil, 0, errors.New("missing compact note page")
		}
	}
	if c.Root != frontier.Root || len(c.Witnesses) != len(selected) {
		return nil, 0, errors.New("compact frontier differs from finalized state")
	}
	for _, w := range c.Witnesses {
		root, e := witnessRoot(w)
		if e != nil || root != frontier.Root {
			return nil, 0, errors.New("compact membership differs from finalized state")
		}
	}
	return c, c.Count - initial, nil
}
