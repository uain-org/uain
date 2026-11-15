package privatewallet

import (
	"context"
	"strings"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
)

type recordSource func(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error)

func (f recordSource) Query(c context.Context, p string, k []byte, h int64, b bool) (abci.ResponseQuery, error) {
	return f(c, p, k, h, b)
}
func TestRecordProofRefusesApprovalScopeBeforeAnyQuery(t *testing.T) {
	base := Request{RecordOnly: true, SourcePayments: []string{strings.Repeat("a", 64)}}
	variants := []Request{base, base, base, base, base, base, base, base, base, base}
	variants[0].Reviewer = "uain1" + strings.Repeat("b", 40)
	variants[1].PolicyOnly = true
	variants[2].SkipWitness = true
	variants[3].CompactWitness = true
	variants[4].BoundaryMember = "uain1" + strings.Repeat("b", 40)
	variants[5].Parties = []string{"member"}
	variants[6].WitnessCache = &WitnessCache{}
	variants[7].WitnessPositions = []uint32{0}
	variants[8].SourceBoundaries = []string{strings.Repeat("c", 64)}
	variants[9].SourcePayments = nil
	source := recordSource(func(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error) {
		t.Fatal("mixed scope made a query")
		return abci.ResponseQuery{}, nil
	})
	for _, request := range variants {
		if _, err := Read(context.Background(), &cmttypes.GenesisDoc{}, cmttypes.SignedHeader{Header: &cmttypes.Header{Height: 3}}, source, time.Now(), time.Minute, request); err == nil {
			t.Fatal("approval scope accepted", request)
		}
	}
}
func TestRecordProofSelectsOnlyOneFinalizedKeyAndRequiresAProof(t *testing.T) {
	for _, boundary := range []bool{false, true} {
		id := strings.Repeat("a", 64)
		request := Request{RecordOnly: true, SourcePayments: []string{id}}
		key := "private_payment/" + id
		if boundary {
			request.SourcePayments = nil
			request.SourceBoundaries = []string{id}
			key = "private_boundary/" + id
		}
		calls := 0
		source := recordSource(func(_ context.Context, path string, data []byte, height int64, prove bool) (abci.ResponseQuery, error) {
			calls++
			if path != "/store/federation/key" || string(data) != key || height != 2 || !prove {
				t.Fatal("record scope escaped", path, string(data), height, prove)
			}
			return abci.ResponseQuery{}, nil
		})
		_, err := Read(context.Background(), &cmttypes.GenesisDoc{}, cmttypes.SignedHeader{Header: &cmttypes.Header{Height: 3}}, source, time.Now(), time.Minute, request)
		if err == nil || !strings.Contains(err.Error(), "missing ciphertext state proof") || calls != 1 {
			t.Fatal("unauthenticated ciphertext accepted", err, calls)
		}
	}
}
