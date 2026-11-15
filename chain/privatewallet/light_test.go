package privatewallet

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
)

func emptyHeader() cmttypes.SignedHeader {
	return cmttypes.SignedHeader{Header: &cmttypes.Header{Height: 3}}
}
func nowUTC() time.Time { return time.Now().UTC() }

// lightStore is an in-memory untrusted node. It records every request so the
// tests can compare transcripts; values carry no proofs (Read verifies them).
type lightStore struct {
	mu      sync.Mutex
	rows    map[string]string
	refuse  map[string]bool // subspace prefixes that fail as oversized
	queries []string
}

func (s *lightStore) Query(_ context.Context, path string, data []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	key := string(data)
	s.mu.Lock()
	s.queries = append(s.queries, path+" "+key)
	s.mu.Unlock()
	if path == subspacePath {
		if s.refuse[key] {
			return abci.ResponseQuery{}, errors.New("response exceeds transport cap")
		}
		var keys []string
		for k := range s.rows {
			if strings.HasPrefix(k, key) {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		var page []byte
		for _, k := range keys {
			page = append(page, pageRow([]byte(k), []byte(s.rows[k]))...)
		}
		return abci.ResponseQuery{Key: data, Value: page, Height: height}, nil
	}
	value, ok := s.rows[key]
	q := abci.ResponseQuery{Key: data, Height: height}
	if ok {
		q.Value = []byte(value)
	}
	return q, nil
}

func (s *lightStore) transcript() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]string(nil), s.queries...)
	sort.Strings(out)
	return out
}

func member(c byte) string { return "uain1" + strings.Repeat(string(c), 40) }
func digest(c byte) string { return strings.Repeat(string(c), 64) }

func lightFixture() map[string]string {
	return map[string]string{
		"member/" + member('a'):            `{"id":"a"}`,
		"member/" + member('b'):            `{"id":"b"}`,
		"member/" + member('c'):            `{"id":"c"}`,
		"member/not-canonical":             `{}`,
		"private_reviewer/" + member('c'):  `{"active":true}`,
		"private_root/" + digest('1'):      `"7"`,
		"private_payment/" + digest('2'):   `{"bundle":"x"}`,
		"private_boundary/" + digest('3'):  `{"bundle":"y"}`,
		"private_nullifier/" + digest('4'): `"` + digest('2') + `"`,
		"coin_balance/" + member('a'):      `"5"`,
		"operator_claim/" + member('a'):    `{}`,
	}
}

func TestObliviousTranscriptIsIndependentOfTheSelection(t *testing.T) {
	ctx := context.Background()
	var transcripts [][]string
	for _, selection := range [][]string{
		{"member/" + member('a'), "private_payment/" + digest('2')},
		{"member/" + member('b'), "private_boundary/" + digest('3'), "private_reviewer/" + member('c')},
		{"private_root/" + digest('1')},
	} {
		store := &lightStore{rows: lightFixture()}
		o := NewOblivious(store)
		for _, key := range selection {
			q, err := o.Query(ctx, keyPath, []byte(key), 9, true)
			if err != nil || string(q.Value) != store.rows[key] || string(q.Key) != key {
				t.Fatal("light read", key, err)
			}
		}
		for _, q := range store.transcript() {
			for _, key := range selection {
				if strings.HasSuffix(q, " "+key) && !strings.HasPrefix(q, keyPath+" ") {
					t.Fatal("selection reached a listing", q)
				}
			}
		}
		transcripts = append(transcripts, store.transcript())
	}
	for i := 1; i < len(transcripts); i++ {
		if strings.Join(transcripts[i], "\n") != strings.Join(transcripts[0], "\n") {
			t.Fatalf("remote transcript depends on the selection:\n%v\n%v", transcripts[0], transcripts[i])
		}
	}
	for _, q := range transcripts[0] {
		if strings.Contains(q, "not-canonical") && strings.HasPrefix(q, keyPath) || strings.Contains(q, "operator_claim") {
			t.Fatal("light scan fetched a non-canonical or unscanned key", q)
		}
	}
	// Every canonical key under every fixed prefix was fetched with a proof.
	want := 0
	for key := range lightFixture() {
		if p := lightPrefixOf(key); p != "" && LightCanonical(p, key) {
			want++
		}
	}
	keyed := 0
	for _, q := range transcripts[0] {
		if strings.HasPrefix(q, keyPath+" ") {
			keyed++
		}
	}
	if keyed != want {
		t.Fatal("light scan was not complete", keyed, want)
	}
}

func TestObliviousRefusesSelectionDependentRemoteQueries(t *testing.T) {
	ctx := context.Background()
	store := &lightStore{rows: lightFixture()}
	o := NewOblivious(store)
	for _, row := range []struct {
		path, key string
		prove     bool
	}{
		{keyPath, "operator_claim/" + member('a'), true},
		{keyPath, "member/not-canonical", true},
		{keyPath, "member/" + member('a'), false},
		{subspacePath, "member/", false},
		{subspacePath, "private_note/000", true},
		{"/store/federation/other", "private_frontier", true},
	} {
		if _, err := o.Query(ctx, row.path, []byte(row.key), 9, row.prove); err == nil {
			t.Fatal("selection-dependent query accepted", row)
		}
	}
	if len(store.transcript()) != 0 {
		t.Fatal("refused query reached the remote node", store.transcript())
	}
	if _, err := o.Query(ctx, subspacePath, []byte("private_note/000"), 9, false); err != nil {
		t.Fatal("complete note pages must pass through", err)
	}
	if _, err := o.Query(ctx, keyPath, []byte("private_frontier"), 9, true); err != nil {
		t.Fatal("global keys pass through", err)
	}
	// Absent member: refused (denial only). Absent Coin balance of a public
	// boundary owner: one keyed absence-proof query, counted in the stats.
	if _, err := o.Query(ctx, keyPath, []byte("member/"+member('d')), 9, true); err == nil {
		t.Fatal("absent member accepted without a proof")
	}
	before := len(store.transcript())
	if _, err := o.Query(ctx, keyPath, []byte("coin_balance/"+member('d')), 9, true); err != nil || o.Stats.PublicAbsence != 1 || len(store.transcript()) != before+1 {
		t.Fatal("public boundary absence", err, o.Stats)
	}
	if _, err := o.Query(ctx, keyPath, []byte("member/"+member('a')), 10, true); err == nil {
		t.Fatal("one snapshot mixed two heights")
	}
}

func TestObliviousSplitsOversizedPagesAndDropsLaterKeys(t *testing.T) {
	ctx := context.Background()
	rows := lightFixture()
	for _, c := range []byte("0123456789abcdef") {
		rows["private_payment/"+digest(c)] = `{"bundle":"z"}`
	}
	rows["member/"+member('e')] = "" // listed from a later height, absent at the pinned one
	store := &lightStore{rows: rows, refuse: map[string]bool{"private_payment/": true, "member/": true, "member/uain1e": true}}
	o := NewOblivious(store)
	if err := o.Scan(ctx, 9); err != nil {
		t.Fatal(err)
	}
	if got := len(o.Listed("private_payment/")); got != 16 {
		t.Fatal("split listing lost records", got)
	}
	if o.Stats.SplitPrefixPages != 3 {
		t.Fatal("expected three split pages", o.Stats)
	}
	listed := o.Listed("member/")
	if len(listed) != 3 || listed[0] != "member/"+member('a') {
		t.Fatal("member listing", listed)
	}
	if _, ok := o.Proven("member/" + member('e')); ok {
		t.Fatal("absent later key cached")
	}
	deep := &lightStore{rows: rows, refuse: map[string]bool{"coin_balance/": true, "coin_balance/uain1a": true, "coin_balance/uain1aa": true, "coin_balance/uain1aaa": true}}
	if err := NewOblivious(deep).Scan(ctx, 9); err == nil {
		t.Fatal("unbounded split accepted")
	}
}

func TestLightScanRefusesSelectionsBeforeAnyQuery(t *testing.T) {
	source := recordSource(func(context.Context, string, []byte, int64, bool) (abci.ResponseQuery, error) {
		t.Fatal("mixed light scope made a query")
		return abci.ResponseQuery{}, nil
	})
	base := Request{LightScan: true}
	variants := []Request{base, base, base, base, base, base}
	variants[0].Reviewer = member('a')
	variants[1].Parties = []string{member('a'), member('b')}
	variants[2].SourcePayments = []string{digest('2')}
	variants[3].BoundaryMember = member('a')
	variants[4].RecordOnly = true
	variants[5].WitnessPositions = make([]uint32, 17)
	for _, request := range variants {
		if _, err := readLight(context.Background(), nil, emptyHeader(), source, nowUTC(), time.Minute, request); err == nil {
			t.Fatal("light scan accepted a selection", request)
		}
	}
}

func TestDecodePairsBounds(t *testing.T) {
	good := append(pageRow([]byte("member/a"), []byte("1")), pageRow([]byte("member/b"), []byte("2"))...)
	if rows, err := decodePairs(good, 1024, 2, 16, 16); err != nil || len(rows) != 2 {
		t.Fatal(rows, err)
	}
	for _, bad := range [][]byte{
		append(pageRow([]byte("member/b"), []byte("2")), pageRow([]byte("member/a"), []byte("1"))...),
		append(good, pageRow([]byte("member/c"), []byte("3"))...),
		pageRow([]byte("member/abcdefghijklmnopq"), []byte("1")),
		pageRow([]byte(""), []byte("1")),
		good[:len(good)-1],
	} {
		if _, err := decodePairs(bad, 1024, 2, 16, 16); err == nil {
			t.Fatal("malformed prefix page accepted")
		}
	}
}
