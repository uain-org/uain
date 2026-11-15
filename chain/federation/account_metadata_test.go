package federation

import (
	"bytes"
	"strings"
	"testing"
)

func TestCompactAccountIdentityPreservedAcrossLifecycleAndBalance(t *testing.T) {
	k, lead, peer, def := fixture(t)
	createInstance(t, k, peer, "peer-instance", "family")
	old := bytes.Clone(k.Store.Get([]byte("member/" + peer.m.ID)))
	command(t, k, def, "activate_storage", map[string]any{"policy": CompactStatePolicy, "evidence_digest": digest}, 1)
	if !bytes.Equal(old, k.Store.Get([]byte("member/"+peer.m.ID))) {
		t.Fatal("activation rewrote inactive account")
	}
	command(t, k, peer, "identity_claim", map[string]any{}, 2)
	metadata := bytes.Clone(k.Store.Get([]byte("member_metadata/" + peer.m.ID)))
	m, err := k.Member(peer.m.ID)
	if err != nil || m.Name != peer.m.Name || m.Operator != peer.m.Operator || m.AccountPolicy != CompactAccountPolicy {
		t.Fatal(m, err)
	}
	command(t, k, def, "roles", map[string]any{"member": peer.m.ID, "default_verifier": true, "creator": false, "evidence_digest": digest}, 3)
	instanceCommand(t, k, peer, "peer-instance", "instance_state", map[string]any{"id": "peer-instance", "state": "paused"}, 4)
	v, err := k.Instance("peer-instance")
	if err != nil || v.Name != "Fixture peer-instance" || v.Family != "family" || v.State != "paused" || v.AccountPolicy != CompactAccountPolicy {
		t.Fatal(v, err)
	}
	if !bytes.Equal(metadata, k.Store.Get([]byte("member_metadata/"+peer.m.ID))) {
		t.Fatal("role grant changed original identity")
	}
	m, _ = k.Member(peer.m.ID)
	m.Name = "attempted replacement"
	if err = put(k.Store, "member/"+m.ID, m); err == nil {
		t.Fatal("balance writer replaced metadata")
	}
	// Metadata does not rescue an ended licence or allow another actor to act.
	command(t, k, peer, "withdraw", map[string]any{}, 5)
	rejectCommand(t, k, peer, "", "identity_claim", map[string]any{}, 6)
	rejectCommand(t, k, lead, "peer-instance", "identity_claim", map[string]any{}, 6)
	k.Store.Set([]byte("member_metadata/"+peer.m.ID), []byte(strings.Repeat("x", 50)))
	if _, err = k.Member(peer.m.ID); err == nil {
		t.Fatal("corrupt account metadata accepted")
	}
}

func TestBufferedIssuancePreservesIterationAndDailyCap(t *testing.T) {
	base := memory{}
	base.Set([]byte("issuance_time/10"), []byte(`"1"`))
	cache := &transitionReads{Store: base, values: map[string][]byte{}}
	cache.Set([]byte("issuance_time/20"), []byte(`"2"`))
	cache.Set([]byte("issuance_time/10"), []byte(`"3"`))
	rows, err := cache.Range([]byte("issuance_time/"), []byte("issuance_time0"), 1)
	if err != nil || len(rows) != 1 || string(rows[0].Key) != "issuance_time/10" || string(rows[0].Value) != `"3"` {
		t.Fatal(rows, err)
	}
	last, err := cache.Last([]byte("issuance_time/"), []byte("issuance_time/30"))
	if err != nil || string(last.Key) != "issuance_time/20" {
		t.Fatal(last, err)
	}
	cache.Delete([]byte("issuance_time/20"))
	last, err = cache.Last([]byte("issuance_time/"), []byte("issuance_time/30"))
	if err != nil || string(last.Key) != "issuance_time/10" || string(last.Value) != `"3"` {
		t.Fatal(last, err)
	}
	cache.flush()
	if string(base.Get([]byte("issuance_time/10"))) != `"3"` || base.Get([]byte("issuance_time/20")) != nil {
		t.Fatal("buffer flush changed final prefix state")
	}
}
