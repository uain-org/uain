package app

import (
	"context"
	"cosmossdk.io/log/v2"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"io"
	"os"
	"strconv"
	"testing"
)

// Opt-in real read-only source qualification. The fixture contains public rows
// only. A fresh synthetic guardian signs import transactions; no member key is
// required or copied. The real source balances are never spent.
func TestSDKCompleteLegacySourceImport(t *testing.T) {
	path := os.Getenv("UAIN_MIGRATION_SNAPSHOT")
	if path == "" {
		t.Skip("set UAIN_MIGRATION_SNAPSHOT to verified public snapshot")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var s struct {
		Manifest       string                          `json:"manifest_digest"`
		Root           string                          `json:"records_root"`
		Pinned         string                          `json:"pinned_public_key"`
		Records        []federation.LegacyImportRecord `json:"records"`
		Proofs         [][]string                      `json:"proofs"`
		Reconciliation struct {
			Ledger struct {
				Head string `json:"head"`
				Last string `json:"last_event_id"`
			}
			Members []struct {
				ID string `json:"id"`
			}
		}
	}
	if e = json.Unmarshal(raw, &s); e != nil {
		t.Fatal(e)
	}
	for _, existing := range []bool{false, true} {
		t.Run(strconv.FormatBool(existing), func(t *testing.T) {
			guardian, key := testMember("Isolated import qualification guardian")
			members := []federation.Member{guardian}
			accounts := []string{}
			for _, r := range s.Records {
				if len(r.Key) > 15 && r.Key[:15] == "legacy/account/" {
					var m federation.Member
					if e = json.Unmarshal([]byte(r.Value), &m); e != nil {
						t.Fatal(e)
					}
					members = append(members, m)
					accounts = append(accounts, m.ID)
				}
			}
			last, e := strconv.ParseInt(s.Reconciliation.Ledger.Last, 10, 64)
			if e != nil {
				t.Fatal(e)
			}
			g := federation.Genesis{Version: 1, Members: members, Guardians: []string{guardian.ID}, Legacy: &federation.LegacyCommitment{ManifestDigest: s.Manifest, LedgerHead: s.Reconciliation.Ledger.Head, LastEventID: last, PinnedPublicKey: s.Pinned}}
			if existing {
				bytes, e := os.ReadFile("../networks/uain-shadow-20261008-1/genesis.json")
				if e != nil {
					t.Fatal(e)
				}
				var prior struct {
					State federation.Genesis `json:"app_state"`
				}
				if e = json.Unmarshal(bytes, &prior); e != nil {
					t.Fatal(e)
				}
				g = prior.State
				g.Members = append(g.Members, guardian)
				g.Guardians = []string{guardian.ID}
			}
			db := dbm.NewMemDB()
			a := initApp(t, db, g)
			sequence := uint64(0)
			maxGas := int64(0)
			submit := func(op string, p any) {
				payload, _ := json.Marshal(p)
				c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: guardian.ID, Sequence: sequence, ExpiresHeight: int64(sequence + 100), Operation: op, Payload: payload}
				bytes, e := federation.SigningBytes(c)
				if e != nil {
					t.Fatal(e)
				}
				tx, _ := json.Marshal(federation.Envelope{Command: c, PublicKey: guardian.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, bytes))})
				r := block(t, a, int64(sequence+1), tx)
				if len(r.TxResults) != 1 || r.TxResults[0].Code != 0 {
					t.Fatalf("%s seq%d: %+v", op, sequence, r.TxResults)
				}
				if r.TxResults[0].GasUsed > maxGas {
					maxGas = r.TxResults[0].GasUsed
				}
				sequence++
			}
			readKeeper := func() federation.Keeper {
				ctx, err := a.CreateQueryContext(0, false)
				if err != nil {
					t.Fatal(err)
				}
				return a.Keeper(ctx)
			}
			oldLegacy := append([]byte{}, a.Keeper(a.NewContext(false)).Store.Get([]byte("legacy"))...)
			if existing {
				submit("instance_create", map[string]any{"id": "existing-native-fixture", "name": "Preserved isolated native instance", "family": "Fixture"})
				checkpoint, e := readKeeper().LegacyNativeCheckpoint()
				if e != nil {
					t.Fatal(e)
				}
				submit("legacy_adopt", map[string]any{"manifest_digest": s.Manifest, "records_root": s.Root, "total_records": strconv.Itoa(len(s.Records)), "accounts": strconv.Itoa(len(accounts)), "ledger_head": s.Reconciliation.Ledger.Head, "last_event_id": s.Reconciliation.Ledger.Last, "pinned_public_key": s.Pinned, "native_checkpoint": checkpoint})
			}
			// Each bounded page commits at its own height, as on a real network.
			submit("legacy_begin", map[string]any{"manifest_digest": s.Manifest, "records_root": s.Root, "total_records": strconv.Itoa(len(s.Records)), "accounts": strconv.Itoa(len(accounts)), "ledger_head": s.Reconciliation.Ledger.Head, "last_event_id": s.Reconciliation.Ledger.Last})
			pages := 0
			for i := 0; i < len(s.Records); {
				end, bytes := i, 0
				for end < len(s.Records) && end-i < federation.MaxLegacyRecordsPerPage {
					if bytes+len(s.Records[end].Value) > federation.MaxLegacyPageValueBytes {
						break
					}
					candidate := append([]federation.LegacyImportRecord{}, s.Records[i:end+1]...)
					for j := range candidate {
						candidate[j].Proof = s.Proofs[i+j]
					}
					encoded, _ := json.Marshal(map[string]any{"start": strconv.Itoa(i), "records": candidate})
					if len(encoded) > 48*1024 {
						break
					}
					bytes += len(s.Records[end].Value)
					end++
				}
				if end == i {
					t.Fatal("record cannot fit bounded page", i)
				}
				rows := append([]federation.LegacyImportRecord{}, s.Records[i:end]...)
				for j := range rows {
					rows[j].Proof = s.Proofs[i+j]
				}
				submit("legacy_page", map[string]any{"start": strconv.Itoa(i), "records": rows})
				if i == 0 {
					var err error
					a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
					if err != nil {
						t.Fatal(err)
					}
				}
				i = end
				pages++
			}
			submit("legacy_finish", map[string]any{})
			for _, id := range accounts {
				submit("legacy_claim_account", map[string]any{"member": id})
			}
			// Query every approved row at the committed SDK version, not a mock store.
			for _, r := range s.Records {
				q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(r.Key)})
				if e != nil || q.Code != 0 || string(q.Value) != r.Value {
					t.Fatal("source byte mismatch", r.Key, e)
				}
			}
			if string(readKeeper().Store.Get([]byte("legacy"))) != string(oldLegacy) {
				t.Fatal("old native legacy commitment replaced")
			}
			for _, id := range accounts {
				m, e := readKeeper().Member(id)
				if e != nil || m.Sequence != 0 {
					t.Fatal("external source member sequence changed", id, e)
				}
				if readKeeper().Store.Get([]byte("legacy_account_delta/"+id)) == nil {
					if existing {
						t.Fatal("missing explicit zero-delta reconciliation", id)
					}
				}
			}
			coin, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("coin_asset")})
			if e != nil || coin.Code != 0 || len(coin.Value) != 0 {
				t.Fatal("legacy import created Coin policy/issuance", e)
			}
			t.Logf("imported %d complete public records in %d pages; %d keyed accounts; maximum transaction gas %d; zero Coin issuance", len(s.Records), pages, len(accounts), maxGas)

		})
	}
}
