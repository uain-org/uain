package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func TestSDKRecipientHistoryGasProofAbsenceRollbackAndRestart(t *testing.T) {
	for _, compact := range []bool{false, true} {
		t.Run(fmt.Sprint("compact=", compact), func(t *testing.T) {
			guardian, key := testMember("history guardian")
			db := dbm.NewMemDB()
			a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{guardian}})
			s := a.NewContext(false).KVStore(a.Key)
			set := func(key string, v any) {
				raw, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				s.Set([]byte(key), raw)
			}
			if compact {
				set("storage_activation", federation.MembershipActivation{Policy: federation.CompactStatePolicy, EffectiveHeight: 2, ApprovedBy: guardian.ID, EvidenceDigest: strings.Repeat("a", 64)})
			}
			// Maximum distinct member+instance recipients in one backfill page;
			// the remaining rows exercise a full 32-entry recipient page + tail.
			original := map[string][]byte{}
			for i := 1; i <= 50; i++ {
				id := fmt.Sprintf("%020d", i)
				owner, instance := guardian.ID, "child-guardian"
				if i <= 16 {
					owner = fmt.Sprintf("uain1%040x", i)
					instance = fmt.Sprintf("child-%096d", i)[:96]
				}
				row := federation.CreditEntry{ID: id, Member: owner, Instance: instance, Contribution: strings.Repeat("r", 96), Amount: "1", Minted: "1", Deferred: "0"}
				set("credit/"+id, row)
				original["credit/"+id] = bytes.Clone(s.Get([]byte("credit/" + id)))
			}
			set("credit_count", uint64(50))
			block(t, a, 1)
			var seq uint64
			h := int64(1)
			var result *abci.ResponseFinalizeBlock
			send := func(op string, p any, ok bool) {
				t.Helper()
				h++
				result = block(t, a, h, testEnvelope(t, guardian, key, seq, op, p))
				v := result.TxResults[0]
				if (v.Code == 0) != ok {
					t.Fatal(op, v.Code, v.Log)
				}
				if ok {
					seq++
					if v.GasUsed >= int64(TransactionGas) {
						t.Fatal("history gas bound", v.GasUsed)
					}
					t.Logf("%s gas %d / %d", op, v.GasUsed, TransactionGas)
				}
			}
			query := func(key string) abci.ResponseQuery {
				t.Helper()
				q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(key), Height: h, Prove: true})
				if err != nil || q.Code != 0 {
					t.Fatal(key, q, err)
				}
				return *q
			}
			bundle := func(kind, owner, instance string, page uint64) []abci.ResponseQuery {
				t.Helper()
				keys, err := federation.HistoryKeys(kind, owner, instance, page)
				if err != nil {
					t.Fatal(err)
				}
				out := []abci.ResponseQuery{}
				for _, key := range keys {
					out = append(out, query(key))
				}
				if len(out[4].Value) != 0 {
					var ids federation.HistoryIDs
					if err = json.Unmarshal(out[4].Value, &ids); err != nil {
						t.Fatal(err)
					}
					for _, id := range ids.IDs {
						out = append(out, query(kind+"/"+id))
					}
				}
				return out
			}
			send("activate_recipient_history", map[string]any{"policy": federation.RecipientHistoryPolicy, "evidence_digest": strings.Repeat("a", 64)}, true)
			for i := 0; i < 32/federation.HistoryBackfillLimit; i++ {
				send("recipient_history_page", map[string]any{"kind": "credit"}, true)
			}
			view, err := proof.VerifyRecipientHistory(bundle("credit", guardian.ID, "", 0), "credit", guardian.ID, "", 0, result.AppHash, h)
			if err != nil || view.Complete || view.IndexedThrough != 32 || view.Count != 16 {
				t.Fatal(view, err)
			}
			// A restart while partial must retain the cursor and original rows.
			a, err = New(log.NewLogger(io.Discard), db, "sdk-test-1")
			if err != nil {
				t.Fatal(err)
			}
			h++
			result = block(t, a, h)
			for i := 0; i < (50-32+federation.HistoryBackfillLimit-1)/federation.HistoryBackfillLimit; i++ {
				send("recipient_history_page", map[string]any{"kind": "credit"}, true)
			}
			proofs := bundle("credit", guardian.ID, "child-guardian", 0)
			view, err = proof.VerifyRecipientHistory(proofs, "credit", guardian.ID, "child-guardian", 0, result.AppHash, h)
			if err != nil || !view.Complete || view.Count != 34 || len(view.Entries) != 32 || view.NextPage == nil {
				t.Fatal(view, err)
			}
			tail, err := proof.VerifyRecipientHistory(bundle("credit", guardian.ID, "child-guardian", 1), "credit", guardian.ID, "child-guardian", 1, result.AppHash, h)
			if err != nil || len(tail.Entries) != 2 || tail.NextPage != nil {
				t.Fatal(tail, err)
			}
			empty := bundle("karma", guardian.ID, "", 0)
			view, err = proof.VerifyRecipientHistory(empty, "karma", guardian.ID, "", 0, result.AppHash, h)
			if err != nil || !view.Complete || view.Count != 0 {
				t.Fatal("proven absence", view, err)
			}
			for i := range empty {
				omitted := append([]abci.ResponseQuery{}, empty[:i]...)
				omitted = append(omitted, empty[i+1:]...)
				if _, err = proof.VerifyRecipientHistory(omitted, "karma", guardian.ID, "", 0, result.AppHash, h); err == nil {
					t.Fatal("omitted absence dependency accepted", i)
				}
			}
			if _, err = proof.VerifyRecipientHistory(append(empty, empty[1]), "karma", guardian.ID, "", 0, result.AppHash, h); err == nil {
				t.Fatal("duplicate absence accepted")
			}
			corrupt := append([]abci.ResponseQuery{}, proofs...)
			corrupt[5].Value = append(bytes.Clone(corrupt[5].Value), ' ')
			if _, err = proof.VerifyRecipientHistory(corrupt, "credit", guardian.ID, "child-guardian", 0, result.AppHash, h); err == nil {
				t.Fatal("tampered original journal accepted")
			}
			if _, err = proof.VerifyRecipientHistory(proofs, "credit", guardian.ID, "other-child", 0, result.AppHash, h); err == nil {
				t.Fatal("cross-recipient proof accepted")
			}
			if _, err = proof.VerifyRecipientHistory(proofs, "credit", guardian.ID, "child-guardian", 0, result.AppHash, h-1); err == nil {
				t.Fatal("mixed-height proof accepted")
			}
			before := query("recipient_history_progress/credit").Value
			send("recipient_history_page", map[string]any{"kind": "credit", "cursor": "skip"}, false)
			if !bytes.Equal(before, query("recipient_history_progress/credit").Value) {
				t.Fatal("refused transaction changed cursor")
			}
			for key, raw := range original {
				if !bytes.Equal(raw, query(key).Value) {
					t.Fatal("rewrote original journal", key)
				}
			}
		})
	}
}

func TestSDKRecipientHistoryMaximumDistinctFullTails(t *testing.T) {
	for _, compact := range []bool{false, true} {
		t.Run(fmt.Sprint("compact=", compact), func(t *testing.T) {
			guardian, key := testMember("history tail guardian")
			db := dbm.NewMemDB()
			a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: []federation.Member{guardian}})
			s := a.NewContext(false).KVStore(a.Key)
			set := func(key string, v any) {
				raw, err := json.Marshal(v)
				if err != nil {
					t.Fatal(err)
				}
				s.Set([]byte(key), raw)
			}
			activation := federation.MembershipActivation{Policy: federation.RecipientHistoryPolicy, EffectiveHeight: 2, ApprovedBy: guardian.ID, EvidenceDigest: strings.Repeat("a", 64)}
			set("recipient_history_activation", activation)
			if compact {
				activation.Policy = federation.CompactStatePolicy
				set("storage_activation", activation)
			}
			var cursor uint64
			for i := 0; i < federation.HistoryBackfillLimit; i++ {
				owner, instance := fmt.Sprintf("uain1%040x", i+1), fmt.Sprintf("child-%090d", i)
				ids := federation.HistoryIDs{}
				for j := 0; j < federation.HistoryPageSize-1; j++ {
					cursor++
					id := fmt.Sprintf("%020d", cursor)
					ids.IDs = append(ids.IDs, id)
					set("credit/"+id, federation.CreditEntry{ID: id, Member: owner, Instance: instance, Amount: "1", Minted: "1", Deferred: "0"})
				}
				for _, actor := range []string{"", instance} {
					prefix, err := federation.HistoryPrefix("credit", owner, actor)
					if err != nil {
						t.Fatal(err)
					}
					set(prefix+"/count", uint64(31))
					set(prefix+"/page/00000000000000000000", ids)
				}
			}
			set("recipient_history_progress/credit", federation.HistoryProgress{Policy: federation.RecipientHistoryPolicy, Cursor: cursor})
			for i := 0; i < federation.HistoryBackfillLimit; i++ {
				id := fmt.Sprintf("%020d", cursor+uint64(i)+1)
				set("credit/"+id, federation.CreditEntry{ID: id, Member: fmt.Sprintf("uain1%040x", i+1), Instance: fmt.Sprintf("child-%090d", i), Amount: "1", Minted: "1", Deferred: "0"})
			}
			set("credit_count", cursor+federation.HistoryBackfillLimit)
			block(t, a, 1)
			r := block(t, a, 2, testEnvelope(t, guardian, key, 0, "recipient_history_page", map[string]any{"kind": "credit"}))
			v := r.TxResults[0]
			if v.Code != 0 {
				t.Fatal(v.Code, v.GasUsed, v.Log)
			}
			if v.GasUsed >= int64(TransactionGas) {
				t.Fatal("maximum tail page exceeds budget", v.GasUsed)
			}
			t.Logf("maximum full-tail page gas %d / %d", v.GasUsed, TransactionGas)
		})
	}
}
