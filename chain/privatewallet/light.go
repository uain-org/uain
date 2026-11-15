package privatewallet

// Light (remote-verified) mode. An untrusted remote node serves every read,
// but it never receives a key chosen by the holder's private selection. Keys
// that would name a member, payment, boundary, nullifier or cached root are
// answered from complete prefix scans: every canonical key under a fixed set
// of prefixes is fetched with a state proof, identically for every holder.
// Nothing here is trusted: Read and readLight verify every value against the
// signed header's app hash, so a lying server can deny service but cannot make
// a holder accept a false member, record, balance or note.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/federation"
	shield "github.com/uain-org/uain/chain/privateexchange"
	"github.com/uain-org/uain/chain/proof"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	keyPath      = "/store/federation/key"
	subspacePath = "/store/federation/subspace"
	// Maximum hex nibbles appended when a prefix page is too large to return.
	lightMaxSplit = 3
	lightWorkers  = 8
	// Bound on proven keys in one scan; far above today's young chain.
	LightMaxKeys = 200000
)

// LightScanPrefixes is the fixed, public set of prefixes a light read always
// scans in full, whatever the request. Their order is part of the transcript.
var LightScanPrefixes = []string{"member/", "private_reviewer/", "private_root/", "private_payment/", "private_boundary/", "private_nullifier/", "coin_balance/"}

// Global singleton keys are the same for every holder and pass through.
var lightGlobalKeys = map[string]bool{"private_activation": true, "private_licence_revision": true, "private_frontier": true, "coin_activation": true, "coin_supply": true}

var lightMemberSuffix = regexp.MustCompile(`^uain1[0-9a-f]{40}$`)

func lightMemberPrefix(prefix string) bool {
	return prefix == "member/" || prefix == "private_reviewer/" || prefix == "coin_balance/"
}

// LightCanonical reports whether key is a canonical member- or digest-keyed
// record under prefix. Other rows under a prefix are ignored, never fetched.
func LightCanonical(prefix, key string) bool {
	if !strings.HasPrefix(key, prefix) {
		return false
	}
	suffix := key[len(prefix):]
	if lightMemberPrefix(prefix) {
		return lightMemberSuffix.MatchString(suffix)
	}
	return digestID.MatchString(suffix)
}

func lightPrefixOf(key string) string {
	for _, prefix := range LightScanPrefixes {
		if strings.HasPrefix(key, prefix) {
			return prefix
		}
	}
	return ""
}

// LightStats counts what the remote node was asked. It contains no selection.
type LightStats struct {
	Pages            int `json:"pages"`
	ProvenKeys       int `json:"proven_keys"`
	PublicAbsence    int `json:"public_absence"`
	SplitPrefixPages int `json:"split_prefix_pages"`
}

// Oblivious wraps an untrusted Source for light mode.
type Oblivious struct {
	inner  Source
	mu     sync.Mutex
	height int64
	ready  bool
	cache  map[string]abci.ResponseQuery
	listed map[string][]string
	Stats  LightStats
}

func NewOblivious(inner Source) *Oblivious {
	return &Oblivious{inner: inner}
}

var ErrLightSelection = errors.New("light mode refuses a selection-dependent remote query")

func cloneQuery(q abci.ResponseQuery) abci.ResponseQuery {
	q.Key = bytes.Clone(q.Key)
	q.Value = bytes.Clone(q.Value)
	return q
}

func (o *Oblivious) Query(ctx context.Context, path string, data []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	key := string(data)
	switch path {
	case subspacePath:
		// Note pages are read in full by every client; positions stay local.
		if !strings.HasPrefix(key, "private_note/") || prove {
			return abci.ResponseQuery{}, ErrLightSelection
		}
		return o.inner.Query(ctx, path, data, height, false)
	case keyPath:
	default:
		return abci.ResponseQuery{}, ErrLightSelection
	}
	if !prove {
		return abci.ResponseQuery{}, errors.New("light mode requires a state proof for every key")
	}
	if lightGlobalKeys[key] {
		return o.inner.Query(ctx, path, data, height, true)
	}
	prefix := lightPrefixOf(key)
	if prefix == "" || !LightCanonical(prefix, key) {
		return abci.ResponseQuery{}, ErrLightSelection
	}
	if err := o.Scan(ctx, height); err != nil {
		return abci.ResponseQuery{}, err
	}
	o.mu.Lock()
	q, ok := o.cache[key]
	o.mu.Unlock()
	if ok {
		return cloneQuery(q), nil
	}
	// A never-credited Coin account is proven zero only by a keyed absence
	// proof. Only a boundary owner's balance is read, and coin_shield/coin_exit
	// publish that owner in the transaction itself; no private party is named.
	if prefix == "coin_balance/" {
		o.mu.Lock()
		o.Stats.PublicAbsence++
		o.mu.Unlock()
		return o.inner.Query(ctx, path, data, height, true)
	}
	return abci.ResponseQuery{}, fmt.Errorf("%s is absent from the complete proven scan at height %d", prefix, height)
}

// Listed returns the canonical keys found under prefix in the completed scan.
func (o *Oblivious) Listed(prefix string) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.listed[prefix]...)
}

// Proven returns the cached (still unverified) response for key.
func (o *Oblivious) Proven(key string) (abci.ResponseQuery, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	q, ok := o.cache[key]
	return cloneQuery(q), ok
}

// Scan enumerates every fixed prefix and fetches every canonical key with a
// proof at one height. The request transcript depends only on chain state.
func (o *Oblivious) Scan(ctx context.Context, height int64) error {
	o.mu.Lock()
	if o.ready {
		same := o.height == height
		o.mu.Unlock()
		if !same {
			return errors.New("one light snapshot reads exactly one height")
		}
		return nil
	}
	o.mu.Unlock()
	listed := map[string][]string{}
	var keys []string
	for _, prefix := range LightScanPrefixes {
		found, err := o.list(ctx, prefix, prefix, height, 0)
		if err != nil {
			return fmt.Errorf("list %s: %w", prefix, err)
		}
		sort.Strings(found)
		for i := 1; i < len(found); i++ {
			if found[i] == found[i-1] {
				return errors.New("repeated key in prefix listing")
			}
		}
		listed[prefix] = found
		keys = append(keys, found...)
		if len(keys) > LightMaxKeys {
			return errors.New("light scan exceeds its key bound; an incremental index is required")
		}
	}
	results := make([]abci.ResponseQuery, len(keys))
	errs := make([]error, len(keys))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < lightWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i], errs[i] = o.inner.Query(ctx, keyPath, []byte(keys[i]), height, true)
			}
		}()
	}
	for i := range keys {
		if ctx.Err() != nil {
			break
		}
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	cache := map[string]abci.ResponseQuery{}
	for i, key := range keys {
		if errs[i] != nil {
			return errs[i]
		}
		q := results[i]
		if q.Code != 0 || !bytes.Equal(q.Key, []byte(key)) {
			return errors.New("invalid proven light key response")
		}
		if len(q.Value) == 0 {
			// Listed from a later height than the pinned header; not present yet.
			continue
		}
		cache[key] = cloneQuery(q)
	}
	for prefix, found := range listed {
		present := found[:0]
		for _, key := range found {
			if _, ok := cache[key]; ok {
				present = append(present, key)
			}
		}
		listed[prefix] = present
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.cache, o.listed, o.height, o.ready = cache, listed, height, true
	o.Stats.ProvenKeys += len(keys)
	return nil
}

func lightChildren(prefix, cut string) []string {
	base := cut
	if lightMemberPrefix(prefix) && cut == prefix {
		base = prefix + "uain1"
	}
	out := make([]string, 16)
	for i, c := range "0123456789abcdef" {
		out[i] = base + string(c)
	}
	return out
}

func (o *Oblivious) list(ctx context.Context, prefix, cut string, height int64, depth int) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	o.mu.Lock()
	o.Stats.Pages++
	o.mu.Unlock()
	q, err := o.inner.Query(ctx, subspacePath, []byte(cut), height, false)
	var pairs []pair
	if err == nil {
		if q.Code != 0 || !bytes.Equal(q.Key, []byte(cut)) {
			err = errors.New("invalid prefix page response")
		} else {
			pairs, err = decodePairs(q.Value, 2*1024*1024, LightMaxKeys, 256, 64*1024)
		}
	}
	if err != nil {
		// An oversized page fails transport; split it into fixed hex children.
		if depth >= lightMaxSplit || ctx.Err() != nil {
			return nil, err
		}
		o.mu.Lock()
		o.Stats.SplitPrefixPages++
		o.mu.Unlock()
		var all []string
		for _, child := range lightChildren(prefix, cut) {
			found, e := o.list(ctx, prefix, child, height, depth+1)
			if e != nil {
				return nil, e
			}
			all = append(all, found...)
		}
		return all, nil
	}
	var found []string
	for _, row := range pairs {
		key := string(row.Key)
		if !strings.HasPrefix(key, cut) {
			return nil, errors.New("prefix page escaped its prefix")
		}
		if LightCanonical(prefix, key) {
			found = append(found, key)
		}
	}
	return found, nil
}

// decodePairs is the bounded generic form of decodePage for kv.Pairs pages.
func decodePairs(raw []byte, maxBytes, maxRows, maxKey, maxValue int) ([]pair, error) {
	if len(raw) > maxBytes {
		return nil, errors.New("prefix page too large")
	}
	rows := []pair{}
	for len(raw) > 0 {
		number, kind, n := protowire.ConsumeTag(raw)
		if n < 0 || number != 1 || kind != protowire.BytesType || len(rows) >= maxRows {
			return nil, errors.New("invalid prefix page framing")
		}
		raw = raw[n:]
		item, n := protowire.ConsumeBytes(raw)
		if n < 0 {
			return nil, errors.New("invalid prefix entry framing")
		}
		raw = raw[n:]
		row := pair{}
		for len(item) > 0 {
			number, kind, n = protowire.ConsumeTag(item)
			if n < 0 || kind != protowire.BytesType || number < 1 || number > 2 {
				return nil, errors.New("invalid prefix entry field")
			}
			item = item[n:]
			value, n := protowire.ConsumeBytes(item)
			if n < 0 {
				return nil, errors.New("invalid prefix field length")
			}
			item = item[n:]
			if number == 1 {
				if row.Key != nil {
					return nil, errors.New("duplicate prefix key")
				}
				row.Key = bytes.Clone(value)
			} else {
				if row.Value != nil {
					return nil, errors.New("duplicate prefix value")
				}
				row.Value = bytes.Clone(value)
			}
		}
		if len(row.Key) == 0 || len(row.Key) > maxKey || len(row.Value) > maxValue || len(rows) > 0 && bytes.Compare(rows[len(rows)-1].Key, row.Key) >= 0 {
			return nil, errors.New("invalid or unordered prefix entries")
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// LightRecord is one proven private_payment or private_boundary ciphertext.
// Its bundle holds the encrypted Orchard outputs a wallet trial-decrypts.
type LightRecord struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Bundle string `json:"bundle"`
	Height int64  `json:"height,string"`
}

// LightNullifier is one proven spent nullifier and the record that spent it.
type LightNullifier struct {
	Nullifier string `json:"nullifier"`
	Record    string `json:"record"`
}

// readLight authenticates the complete public private-pool state: every note
// commitment (bound by the Orchard root), every ciphertext record and every
// spent nullifier (each by its own state proof), plus completeness: every
// accepted bundle appends exactly two commitments and two new nullifiers, so
// the proven sets are complete exactly when both equal the proven count.
func readLight(ctx context.Context, genesis *cmttypes.GenesisDoc, header cmttypes.SignedHeader, source Source, now time.Time, maxAge time.Duration, request Request) (Snapshot, error) {
	out := Snapshot{}
	if !request.LightScan || request.RecordOnly || request.SkipWitness || request.CompactWitness || request.WitnessCache != nil || request.PolicyOnly || request.Reviewer != "" || len(request.Parties) != 0 || len(request.SourcePayments)+len(request.SourceBoundaries) != 0 || request.BoundaryMember != "" || len(request.WitnessPositions) > 16 {
		return out, errors.New("a light scan takes only optional local witness positions")
	}
	if genesis == nil || header.Header == nil || header.Height < 2 || source == nil || maxAge <= 0 || maxAge > 10*time.Minute {
		return out, errors.New("pinned genesis, finalized header and bounded freshness required")
	}
	if !shield.Available() {
		return out, shield.ErrUnavailable
	}
	oblivious, ok := source.(*Oblivious)
	if !ok {
		oblivious = NewOblivious(source)
	}
	height := header.Height - 1
	query := func(key string, target any, authenticateHeader bool) error {
		q, err := oblivious.Query(ctx, keyPath, []byte(key), height, true)
		if err != nil {
			return err
		}
		if err = checkProofBounds(q); err != nil {
			return err
		}
		if authenticateHeader {
			err = proof.Verify(genesis, proof.Bundle{SignedHeader: header, Query: q}, key, now, maxAge)
		} else {
			err = proof.VerifyQuery(q, key, header.AppHash, height)
		}
		if err != nil {
			return fmt.Errorf("authenticate %s: %w", key, err)
		}
		return json.Unmarshal(q.Value, target)
	}
	var activation federation.PrivateActivation
	if err := query("private_activation", &activation, true); err != nil {
		return out, err
	}
	if activation.Policy != federation.PrivateExchangePolicy || activation.Height > height || activation.Height < 1 {
		return out, errors.New("private policy is not active at the proven height")
	}
	var revision federation.CensusRevision
	if err := query("private_licence_revision", &revision, false); err != nil {
		return out, err
	}
	var frontier federation.PrivateFrontier
	if err := query("private_frontier", &frontier, false); err != nil {
		return out, err
	}
	if frontier.Count > MaxNotes || frontier.Count%2 != 0 || !digestID.MatchString(frontier.Root) {
		return out, errors.New("unsupported note count or root for a light scan")
	}
	var rootHeight int64
	if err := query("private_root/"+frontier.Root, &rootHeight, false); err != nil {
		return out, err
	}
	if rootHeight < 1 || rootHeight > height {
		return out, errors.New("invalid accepted-root height")
	}
	commitments, err := readCommitments(ctx, oblivious, height, frontier)
	if err != nil {
		return out, err
	}
	root, err := commitmentRoot(ctx, commitments)
	if err != nil || root != frontier.Root {
		return out, errors.New("note transport does not match the proven Orchard root")
	}
	if len(request.WitnessPositions) > 0 {
		if out.WitnessCache, err = localWitnesses(genesis.ChainID, commitments, request.WitnessPositions, frontier.Root); err != nil {
			return out, err
		}
	}
	// Records: every proven ciphertext record, each bound to its effects ID.
	out.Records = []LightRecord{}
	ids := map[string]int{}
	for _, kind := range []string{"payment", "boundary"} {
		prefix := "private_" + kind + "/"
		for _, key := range oblivious.Listed(prefix) {
			var record struct {
				Bundle string `json:"bundle"`
				Height int64  `json:"height,string"`
			}
			if err = query(key, &record, false); err != nil {
				return Snapshot{}, err
			}
			id := key[len(prefix):]
			wire, e := base64.RawURLEncoding.DecodeString(record.Bundle)
			if e != nil || len(wire) < 1 || len(wire) > 16384 || base64.RawURLEncoding.EncodeToString(wire) != record.Bundle || record.Height < 1 || record.Height > height {
				return Snapshot{}, errors.New("invalid proven ciphertext record")
			}
			effect, e := shield.Effects(wire)
			if e != nil || hex.EncodeToString(effect[:]) != id {
				return Snapshot{}, errors.New("ciphertext record differs from its proven effects ID")
			}
			if _, seen := ids[id]; seen {
				return Snapshot{}, errors.New("one effects ID recorded as payment and boundary")
			}
			ids[id] = 0
			out.Records = append(out.Records, LightRecord{Kind: kind, ID: id, Bundle: record.Bundle, Height: record.Height})
		}
	}
	out.Nullifiers = []LightNullifier{}
	for _, key := range oblivious.Listed("private_nullifier/") {
		var record string
		if err = query(key, &record, false); err != nil {
			return Snapshot{}, err
		}
		count, known := ids[record]
		if !known {
			return Snapshot{}, errors.New("proven nullifier names an unknown record")
		}
		ids[record] = count + 1
		out.Nullifiers = append(out.Nullifiers, LightNullifier{Nullifier: key[len("private_nullifier/"):], Record: record})
	}
	// Completeness. Consensus appends exactly two commitments and two fresh,
	// distinct nullifiers per accepted bundle, and nothing else writes them.
	if uint64(len(out.Records))*2 != frontier.Count || uint64(len(out.Nullifiers)) != frontier.Count {
		return Snapshot{}, errors.New("remote node withheld ciphertext records or nullifiers")
	}
	for _, count := range ids {
		if count != 2 {
			return Snapshot{}, errors.New("record lacks exactly two proven nullifiers")
		}
	}
	sort.Slice(out.Records, func(i, j int) bool {
		if out.Records[i].Height != out.Records[j].Height {
			return out.Records[i].Height < out.Records[j].Height
		}
		return out.Records[i].ID < out.Records[j].ID
	})
	out.LightScan = true
	out.WitnessComplete = true
	out.NotesFetched = frontier.Count
	out.Commitments = commitments
	out.Parties = []Identity{}
	out.Payments = []Payment{}
	out.Boundaries = []Payment{}
	out.ChainID = genesis.ChainID
	out.Height = height
	out.HeaderTime = header.Time
	out.AppHash = hex.EncodeToString(header.AppHash)
	out.LicenceRevision = revision.Value
	out.Root = frontier.Root
	out.Count = frontier.Count
	stats := oblivious.Stats
	out.Light = &stats
	return out, nil
}

func checkProofBounds(q abci.ResponseQuery) error {
	if len(q.Value) > federation.MaxEnvelopeBytes || q.ProofOps == nil || len(q.ProofOps.Ops) > 4 {
		return errors.New("oversized or missing state proof")
	}
	for _, op := range q.ProofOps.Ops {
		if len(op.Data) > 256*1024 {
			return errors.New("oversized state proof operation")
		}
	}
	return nil
}

// localWitnesses builds membership paths from already-authenticated
// commitments. Selected positions never leave this process.
func localWitnesses(chain string, commitments []string, positions []uint32, root string) (*WitnessCache, error) {
	selected := map[uint32]bool{}
	for _, position := range positions {
		if selected[position] || uint64(position) >= uint64(len(commitments)) {
			return nil, errors.New("duplicate or absent witness position")
		}
		selected[position] = true
	}
	empty, err := shield.Empty(32)
	if err != nil {
		return nil, err
	}
	c := &WitnessCache{ChainID: chain, Root: encoded(empty), Witnesses: []NoteWitness{}}
	for _, commitment := range commitments {
		if err = appendWitness(c, commitment, selected); err != nil {
			return nil, err
		}
	}
	if c.Root != root || len(c.Witnesses) != len(selected) {
		return nil, errors.New("local witnesses differ from the proven root")
	}
	for _, w := range c.Witnesses {
		if r, e := witnessRoot(w); e != nil || r != root {
			return nil, errors.New("local membership path differs from the proven root")
		}
	}
	return c, nil
}
