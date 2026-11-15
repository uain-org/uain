//go:build orchard && cgo

package app

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/privatewallet"
	"google.golang.org/protobuf/encoding/protowire"
)

// lightRemoteSource is the real finalized SDK store behind an untrusted
// "remote node" that logs every request and can withhold or alter data.
type lightRemoteSource struct {
	privateFixtureSource
	mu     *sync.Mutex
	log    *[]string
	drop   string
	tamper string
}

func filterPairs(raw []byte, drop string) []byte {
	var out []byte
	for len(raw) > 0 {
		_, _, n := protowire.ConsumeTag(raw)
		if n < 0 {
			return raw
		}
		item, m := protowire.ConsumeBytes(raw[n:])
		if m < 0 {
			return raw
		}
		whole := raw[:n+m]
		raw = raw[n+m:]
		inner := item
		_, _, k := protowire.ConsumeTag(inner)
		key, _ := protowire.ConsumeBytes(inner[k:])
		if string(key) != drop {
			out = append(out, whole...)
		}
	}
	return out
}

func (s lightRemoteSource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	s.mu.Lock()
	*s.log = append(*s.log, path+" "+string(key))
	s.mu.Unlock()
	q, err := s.privateFixtureSource.Query(ctx, path, key, height, prove)
	if err != nil {
		return q, err
	}
	if path == "/store/federation/subspace" && s.drop != "" && strings.HasPrefix(s.drop, string(key)) {
		q.Value = filterPairs(q.Value, s.drop)
	}
	if path == "/store/federation/key" && string(key) == s.tamper && len(q.Value) > 0 {
		q.Value = bytes.Clone(q.Value)
		q.Value[len(q.Value)/2] ^= 1
	}
	return q, nil
}

// assertLightCoinState checks light mode against the default loopback reader
// on the same real finalized state: identical verified results, a remote
// transcript that does not depend on the holder's selection, and a complete
// authenticated light scan that refuses withheld or altered records.
func assertLightCoinState(t *testing.T, a *App, genesis *cmttypes.GenesisDoc, signed cmttypes.SignedHeader, now time.Time, request privatewallet.Request, direct privatewallet.Snapshot, payments, boundaries []string) {
	t.Helper()
	remote := func(drop, tamper string) (*privatewallet.Oblivious, *[]string) {
		log := []string{}
		return privatewallet.NewOblivious(lightRemoteSource{privateFixtureSource: privateFixtureSource{app: a}, mu: &sync.Mutex{}, log: &log, drop: drop, tamper: tamper}), &log
	}
	o, log := remote("", "")
	light, err := privatewallet.Read(context.Background(), genesis, signed, o, now, time.Minute, request)
	if err != nil || light.Coin == nil || light.Coin.Balance != direct.Coin.Balance || light.Coin.Owner.Member != direct.Coin.Owner.Member || light.Root != direct.Root || light.Count != direct.Count || len(light.Payments) != len(direct.Payments) || len(light.Boundaries) != len(direct.Boundaries) || strings.Join(light.Commitments, ",") != strings.Join(direct.Commitments, ",") {
		t.Fatalf("light read differs from the loopback read: %v %+v", err, light)
	}
	// Selection-independence: a public policy read and this member read send
	// the same scan transcript. Only the public boundary owner's absent Coin
	// balance may add one keyed absence query.
	scanned := func(o *privatewallet.Oblivious, log []string) (string, []string) {
		listed := map[string]bool{}
		for _, prefix := range privatewallet.LightScanPrefixes {
			for _, key := range o.Listed(prefix) {
				listed[key] = true
			}
		}
		var scan, extra []string
		for _, q := range log {
			path, key, _ := strings.Cut(q, " ")
			switch {
			case path == "/store/federation/subspace" && strings.HasPrefix(key, "private_note/"):
			case path == "/store/federation/subspace", listed[key]:
				scan = append(scan, q)
			case map[string]bool{"private_activation": true, "private_licence_revision": true, "private_frontier": true, "coin_activation": true, "coin_supply": true}[key]:
			default:
				extra = append(extra, key)
			}
		}
		sortStrings(scan)
		return strings.Join(scan, "\n"), extra
	}
	memberScan, extra := scanned(o, *log)
	for _, key := range extra {
		if key != "coin_balance/"+request.BoundaryMember {
			t.Fatal("light read sent a selection-dependent key", key)
		}
	}
	policy, policyLog := remote("", "")
	if _, err = privatewallet.Read(context.Background(), genesis, signed, policy, now, time.Minute, privatewallet.Request{Reviewer: request.Reviewer, PolicyOnly: true}); err != nil {
		t.Fatal("light policy read", err)
	}
	policyScan, policyExtra := scanned(policy, *policyLog)
	if policyScan != memberScan || len(policyExtra) != 0 {
		t.Fatal("remote transcript depends on the holder's selection")
	}
	// Complete light scan with a local witness.
	scan, _ := remote("", "")
	full, err := privatewallet.Read(context.Background(), genesis, signed, scan, now, time.Minute, privatewallet.Request{LightScan: true, WitnessPositions: []uint32{0}})
	if err != nil || !full.LightScan || uint64(len(full.Records))*2 != direct.Count || uint64(len(full.Nullifiers)) != direct.Count || uint64(len(full.Commitments)) != direct.Count || full.Root != direct.Root || full.WitnessCache == nil || full.WitnessCache.Root != direct.Root || len(full.WitnessCache.Witnesses) != 1 || full.Light == nil {
		t.Fatalf("light scan: %v %+v", err, full)
	}
	have := map[string]string{}
	for _, record := range full.Records {
		have[record.ID] = record.Kind
	}
	for _, id := range payments {
		if have[id] != "payment" {
			t.Fatal("light scan lost a payment", id)
		}
	}
	for _, id := range boundaries {
		if have[id] != "boundary" {
			t.Fatal("light scan lost a boundary", id)
		}
	}
	// A lying node can withhold or alter, and is caught; it cannot add.
	faults := [][2]string{{"private_nullifier/" + full.Nullifiers[0].Nullifier, ""}, {"", "private_nullifier/" + full.Nullifiers[0].Nullifier}, {"", "private_frontier"}}
	if len(boundaries) > 0 {
		faults = append(faults, [2]string{"private_boundary/" + boundaries[0], ""}, [2]string{"", "private_boundary/" + boundaries[0]})
	}
	for _, fault := range faults {
		bad, _ := remote(fault[0], fault[1])
		if _, err = privatewallet.Read(context.Background(), genesis, signed, bad, now, time.Minute, privatewallet.Request{LightScan: true}); err == nil {
			t.Fatal("light scan accepted a lying node", fault)
		}
	}
	if len(boundaries) > 0 {
		bad, _ := remote("private_boundary/"+boundaries[0], "")
		if _, err = privatewallet.Read(context.Background(), genesis, signed, bad, now, time.Minute, request); err == nil && len(request.SourceBoundaries) > 0 {
			t.Fatal("withheld source boundary accepted")
		}
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
