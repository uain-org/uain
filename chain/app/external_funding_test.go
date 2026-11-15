package app

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/store/v2/rootmulti"
	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
	"golang.org/x/crypto/sha3"
)

func TestSDKExternalFundingWalletRefundProofAtomicityAndRestart(t *testing.T) {
	lead, leadKey := testMember("funding lead")
	peer, peerKey := testMember("funding observer B")
	guardian, guardianKey := testMember("funding observer C")
	lead.Karma = 1000
	peer.Karma = 100
	guardian.Karma = 100
	guardian.DefaultVerifier = true
	members := []federation.Member{lead, peer, guardian}
	keys := map[string]ed25519.PrivateKey{lead.ID: leadKey, peer.ID: peerKey, guardian.ID: guardianKey}
	db := dbm.NewMemDB()
	a := initApp(t, db, federation.Genesis{Version: 1, Guardians: []string{guardian.ID}, Members: members})
	h := int64(0)
	sequences := map[string]uint64{}
	digest := strings.Repeat("a", 64)
	var result *abci.ResponseFinalizeBlock
	query := func(record string) []byte {
		t.Helper()
		q, e := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte(record), Height: h, Prove: true})
		if e != nil || q.Code != 0 {
			t.Fatal(record, q, e)
		}
		if len(q.Value) == 0 {
			e = rootmulti.DefaultProofRuntime().VerifyAbsence(q.ProofOps, result.AppHash, "/federation/"+url.PathEscape(record))
		} else {
			e = proof.VerifyQuery(*q, record, result.AppHash, h)
		}
		if e != nil {
			t.Fatal(record, e)
		}
		return bytes.Clone(q.Value)
	}
	send := func(m federation.Member, op string, p any, want bool) {
		t.Helper()
		h++
		payload, e := json.Marshal(p)
		if e != nil {
			t.Fatal(e)
		}
		c := federation.Command{Version: 1, ChainID: "sdk-test-1", Member: m.ID, Sequence: sequences[m.ID], ExpiresHeight: h + 10, Operation: op, Payload: payload}
		message, e := federation.SigningBytes(c)
		if e != nil {
			t.Fatal(e)
		}
		raw, e := json.Marshal(federation.Envelope{Command: c, PublicKey: m.PublicKey, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(keys[m.ID], message))})
		if e != nil {
			t.Fatal(e)
		}
		result = block(t, a, h, raw)
		tx := result.TxResults[0]
		if (tx.Code == 0) != want {
			t.Fatalf("%s h%d gas%d: %s", op, h, tx.GasUsed, tx.Log)
		}
		if want {
			sequences[m.ID]++
			if tx.GasUsed >= int64(TransactionGas) {
				t.Fatal("SDK gas exceeded", op, tx.GasUsed)
			}
			t.Logf("%s gas %d", op, tx.GasUsed)
		}
	}
	send(guardian, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_operator_rewards", map[string]any{"policy": federation.OperatorRewardPolicy, "evidence_digest": digest}, true)
	send(guardian, "activate_membership", map[string]any{"policy": federation.MembershipPolicy, "evidence_digest": digest}, true)
	for i, m := range members {
		send(m, "identity_claim", map[string]any{}, true)
		send(m, "operator_claim", map[string]any{"domain": fmt.Sprintf("funding-sdk-%d.example", i)}, true)
		var claim federation.OperatorClaim
		if e := json.Unmarshal(query("operator_claim/"+m.ID+"/"), &claim); e != nil {
			t.Fatal(e)
		}
		send(guardian, "operator_attest", map[string]any{"member": m.ID, "domain": claim.Domain, "claim_event_id": fmt.Sprint(claim.EventID), "txt": "uain-operator=" + claim.DID, "checked_at": time.Unix(1001+h, 0).UTC().Format(time.RFC3339Nano), "evidence_digest": digest}, true)
	}
	send(guardian, "activate_funding", map[string]any{"policy": federation.FundingPolicy, "observers": []string{peer.ID, guardian.ID}, "evidence_digest": digest}, true)
	prior := federation.PriorArt{Basis: "No open solution exists for this fictional bounded question.", Searches: []string{"Search fictional unresolved question in public repositories", "Search fictional unresolved question in publication indexes"}}
	send(lead, "open_project", map[string]any{"id": "PF-SDK", "title": "Unresolved funding SDK question", "class": "benevolent", "prior_art": prior}, true)
	escrow := "0x6813eb9362372eef6200f3b1dbc3f819671cba69"
	source := "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
	escrowExpiry := h + 40
	escrowMessage, e := federation.TreasuryEscrowProofBytes("sdk-test-1", lead.ID, sequences[lead.ID], "ethereum:1", escrow, escrowExpiry, digest)
	if e != nil {
		t.Fatal(e)
	}
	escrowHash := sha3.NewLegacyKeccak256()
	escrowHash.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(escrowMessage))))
	escrowHash.Write(escrowMessage)
	escrowSignature := ecdsa.SignCompact(secp.PrivKeyFromBytes([]byte{3}), escrowHash.Sum(nil), false)
	send(lead, "treasury_escrow_bind", map[string]any{"network": "ethereum:1", "address": escrow, "expires_height": fmt.Sprint(escrowExpiry), "evidence_digest": digest, "signature": "0x" + hex.EncodeToString(append(append([]byte{}, escrowSignature[1:]...), escrowSignature[0]))}, true)
	send(guardian, "treasury_escrow_approve", map[string]any{"network": "ethereum:1", "address": escrow, "controller": lead.ID, "evidence_digest": digest}, true)
	send(lead, "funding_campaign", map[string]any{"id": "FC-SDK", "project": "PF-SDK", "network": "ethereum:1", "asset": "native", "escrow": escrow, "decimals": 18, "evidence_digest": digest}, true)
	expires := h + 40
	message, e := federation.ExternalWalletProofBytes("sdk-test-1", lead.ID, sequences[lead.ID], "ethereum", source, expires)
	if e != nil {
		t.Fatal(e)
	}
	hash := sha3.NewLegacyKeccak256()
	hash.Write([]byte("\x19Ethereum Signed Message:\n" + strconv.Itoa(len(message))))
	hash.Write(message)
	signature := ecdsa.SignCompact(secp.PrivKeyFromBytes([]byte{1}), hash.Sum(nil), false)
	eth := append(append([]byte{}, signature[1:]...), signature[0])
	send(lead, "external_wallet_bind", map[string]any{"network": "ethereum", "address": source, "expires_height": fmt.Sprint(expires), "signature": "0x" + hex.EncodeToString(eth)}, true)
	transaction := "0x" + strings.Repeat("2", 64)
	deposit := map[string]any{"id": "FR-SDK", "campaign": "FC-SDK", "amount": "101", "transaction": transaction, "index": "0", "source": source, "block": "123", "block_hash": "0x" + strings.Repeat("4", 64), "evidence_digest": digest}
	send(lead, "funding_file", deposit, true)
	if len(query("funding_pool/FR-SDK")) != 0 {
		t.Fatal("unverified funds allocated")
	}
	// Duplicate transfer under a new local ID must roll back both sequence and all
	// new row/pool/index writes, including any financial reservation.
	before := query("member/" + lead.ID)
	deposit["id"] = "FR-ALIAS"
	send(lead, "funding_file", deposit, false)
	if !bytes.Equal(before, query("member/"+lead.ID)) || len(query("funding_receipt/FR-ALIAS")) != 0 {
		t.Fatal("failed alias filing mutated state")
	}
	observation := map[string]any{"receipt": "FR-SDK", "kind": "deposit", "transaction": transaction, "index": "0", "source": source, "target": escrow, "amount": "101", "block": "123", "block_hash": "0x" + strings.Repeat("4", 64), "evidence_digest": digest}
	send(peer, "funding_attest", observation, true)
	if len(query("funding_pool/FR-SDK")) != 0 {
		t.Fatal("one observer allocated funds")
	}
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	send(guardian, "funding_attest", observation, true)
	var pool struct {
		Bounty     struct{ Available string }
		Dividend   struct{ Available string }
		Operations struct{ Available string }
		Dust       string
		Refunded   string
	}
	if e = json.Unmarshal(query("funding_pool/FR-SDK"), &pool); e != nil || pool.Bounty.Available != "80" || pool.Dividend.Available != "15" || pool.Operations.Available != "5" || pool.Dust != "1" {
		t.Fatal(pool, e)
	}
	send(lead, "funding_refund", map[string]any{"receipt": "FR-SDK", "evidence_digest": digest}, true)
	observation["kind"] = "refund"
	observation["transaction"] = "0x" + strings.Repeat("6", 64)
	observation["source"] = escrow
	observation["target"] = source
	send(peer, "funding_attest", observation, true)
	send(guardian, "funding_attest", observation, true)
	if e = json.Unmarshal(query("funding_pool/FR-SDK"), &pool); e != nil || pool.Refunded != "101" {
		t.Fatal(pool, e)
	}
	frozen := query("funding_pool/FR-SDK")
	send(guardian, "funding_attest", observation, false)
	if !bytes.Equal(frozen, query("funding_pool/FR-SDK")) {
		t.Fatal("replayed refund mutated money")
	}
	a, e = New(log.NewLogger(io.Discard), db, "sdk-test-1")
	if e != nil {
		t.Fatal(e)
	}
	h++
	result = block(t, a, h)
	if !bytes.Equal(frozen, query("funding_pool/FR-SDK")) {
		t.Fatal("restart changed finalized pool")
	}
	if len(query("coin_supply")) != 0 || len(query("funding_reward/FR-SDK")) != 0 {
		t.Fatal("ordinary funded receipts silently minted Coin")
	}
}
