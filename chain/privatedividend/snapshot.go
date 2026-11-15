package privatedividend

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"github.com/uain-org/uain/chain/coin"
	"math"
	"regexp"
)

const SnapshotVersion = "uain-dividend-full-domain-carry-v1"

// Snapshot is created FIRST in BeginBlock(H+1), from unchanged committed H state.
// Its own record proof therefore uses state H+1/header H+2. Checkpoint is AppHashH
// and authenticates historical balance/member proofs at H; it is not its own hash.
type Snapshot struct {
	Version    string   `json:"version"`
	Chain      string   `json:"chain"`
	Receipt    string   `json:"receipt"`
	Network    string   `json:"network"`
	Asset      string   `json:"asset"`
	Height     int64    `json:"height,string"`
	RecordedAt int64    `json:"recorded_at,string"`
	Checkpoint [32]byte `json:"checkpoint_app_hash_H"`
	NoteRoot   [32]byte `json:"note_root_H"`
	SpentRoot  [32]byte `json:"spent_root_H"`
	Minted     string   `json:"minted_microcoin"`
	Pool       string   `json:"pool_atomic"`
}

var snapshotUnits = regexp.MustCompile(`^(0|[1-9][0-9]{0,77})$`)
var snapshotID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func NewSnapshot(chain, receipt, network, asset string, height int64, checkpoint [32]byte, ledger coin.Ledger, noteRoot, spentRoot [32]byte, pool string) (Snapshot, error) {
	var out Snapshot
	if height < 1 || height == math.MaxInt64 || !snapshotID.MatchString(chain) || !snapshotID.MatchString(receipt) || !snapshotID.MatchString(network) || !snapshotID.MatchString(asset) || !snapshotUnits.MatchString(pool) || !CanonicalField(noteRoot) || !CanonicalField(spentRoot) {
		return out, errors.New("invalid canonical dividend snapshot")
	}
	if err := ledger.Validate(); err != nil {
		return out, err
	}
	return Snapshot{SnapshotVersion, chain, receipt, network, asset, height, height + 1, checkpoint, noteRoot, spentRoot, ledger.Minted, pool}, nil
}

// Context is a fixed-version length-framed binding, never a caller-provided digest.
// Circuit inputs use the two little-endian 128-bit halves of this digest.
func (s Snapshot) Context() [32]byte {
	b := []byte("UAIN/dividend/snapshot/context/v1\x00")
	for _, v := range []string{s.Version, s.Chain, s.Receipt, s.Network, s.Asset, s.Minted, s.Pool} {
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(v)))
		b = append(b, n[:]...)
		b = append(b, v...)
	}
	var n [8]byte
	binary.BigEndian.PutUint64(n[:], uint64(s.Height))
	b = append(b, n[:]...)
	binary.BigEndian.PutUint64(n[:], uint64(s.RecordedAt))
	b = append(b, n[:]...)
	b = append(b, s.Checkpoint[:]...)
	b = append(b, s.NoteRoot[:]...)
	b = append(b, s.SpentRoot[:]...)
	return sha256.Sum256(b)
}
func fieldModulusLE() [32]byte {
	v, _ := hex.DecodeString("40000000000000000000000000000000224698fc094cf91b992d30ed00000001")
	var out [32]byte
	for i := range out {
		out[i] = v[31-i]
	}
	return out
}

// CanonicalField covers the entire Pallas base field, including 0 and p-1.
// The constant is pinned to pasta_curves0.6 Fp::MODULUS, not reduced modulo p.
func CanonicalField(v [32]byte) bool {
	p := fieldModulusLE()
	for i := 31; i >= 0; i-- {
		if v[i] < p[i] {
			return true
		}
		if v[i] > p[i] {
			return false
		}
	}
	return false
}
