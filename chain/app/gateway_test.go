package app

import (
	"bytes"
	"context"
	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/gateway"
	"testing"
	"time"
)

type gatewaySource struct {
	app   *App
	fault string
}

func (s gatewaySource) Query(ctx context.Context, path string, key []byte, height int64, prove bool) (abci.ResponseQuery, error) {
	q, e := s.app.Query(ctx, &abci.RequestQuery{Path: path, Data: key, Height: height, Prove: prove})
	if e != nil {
		return abci.ResponseQuery{}, e
	}
	out := *q
	out.Value = bytes.Clone(out.Value)
	if s.fault == string(key) {
		out.Value = []byte(`{"sequence":"0","licence":"active"}`)
	}
	return out, nil
}
func gatewayHeader(t *testing.T, hash []byte) (*cmttypes.GenesisDoc, cmttypes.SignedHeader, time.Time) {
	t.Helper()
	key := cmted.GenPrivKey()
	v := cmttypes.NewValidator(key.PubKey(), 10)
	set := cmttypes.NewValidatorSet([]*cmttypes.Validator{v})
	now := time.Unix(1003, 0).UTC()
	g := &cmttypes.GenesisDoc{ChainID: "sdk-test-1", GenesisTime: time.Unix(1000, 0).UTC(), Validators: []cmttypes.GenesisValidator{{PubKey: key.PubKey(), Power: 10}}}
	h := &cmttypes.Header{Version: cmtversion.Consensus{Block: 11}, ChainID: g.ChainID, Height: 3, Time: now, ValidatorsHash: set.Hash(), NextValidatorsHash: set.Hash(), AppHash: hash, ProposerAddress: v.Address}
	c := &cmttypes.Commit{Height: 3, Round: 0, BlockID: cmttypes.BlockID{Hash: h.Hash(), PartSetHeader: cmttypes.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{1}, 32)}}, Signatures: []cmttypes.CommitSig{{BlockIDFlag: cmttypes.BlockIDFlagCommit, ValidatorAddress: v.Address, Timestamp: now}}}
	var e error
	c.Signatures[0].Signature, e = key.Sign(c.VoteSignBytes(g.ChainID, 0))
	if e != nil {
		t.Fatal(e)
	}
	return g, cmttypes.SignedHeader{Header: h, Commit: c}, now
}
func TestSDKGatewayReadsAuthoritativeFinalizedOwnershipAndProvenAbsence(t *testing.T) {
	m, key := testMember("Gateway guardian")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Members: []federation.Member{m}, Guardians: []string{m.ID}})
	block(t, a, 1, testEnvelope(t, m, key, 0, "instance_create", map[string]any{"id": "gateway-instance", "name": "Gateway instance", "family": "Fixture"}))
	b := block(t, a, 2)
	g, h, now := gatewayHeader(t, b.AppHash)
	r := gateway.Request{Member: m.ID, Instance: "gateway-instance", Keys: []string{"legacy"}}
	out, e := gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, r)
	if e != nil {
		t.Fatal(e)
	}
	if out.Height != 2 || out.ChainID != g.ChainID || out.Member == nil || out.Member.Sequence != 1 || out.Instance == nil || out.Instance.Member != m.ID {
		t.Fatal("wrong finalized account", out)
	}
	if value, ok := out.Records["legacy"]; !ok || value != nil {
		t.Fatal("absence was not proved")
	}
	for _, fault := range []string{"member/" + m.ID, "instance/gateway-instance", "guardians"} {
		if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a, fault: fault}, now, time.Minute, r); e == nil {
			t.Fatal("corrupt proof accepted", fault)
		}
	}
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now.Add(2*time.Minute), time.Minute, r); e == nil {
		t.Fatal("stale state accepted")
	}
	other := r
	other.Member = "uain1" + string(bytes.Repeat([]byte{'a'}, 40))
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, other); e == nil {
		t.Fatal("wrong ownership accepted")
	}
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, gateway.Request{Keys: []string{"legacy", "legacy"}}); e == nil {
		t.Fatal("duplicate request accepted")
	}
}
func TestSDKGatewayReceiptRequiresExactSuccessfulCommandEvent(t *testing.T) {
	m, key := testMember("Receipt owner")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Members: []federation.Member{m}, Guardians: []string{m.ID}})
	tx := testEnvelope(t, m, key, 0, "instance_create", map[string]any{"id": "receipt-instance", "name": "Receipt instance", "family": "Fixture"})
	block(t, a, 1, tx)
	b := block(t, a, 2)
	g, h, now := gatewayHeader(t, b.AppHash)
	var envelope federation.Envelope
	if e := federation.Decode(tx, &envelope); e != nil {
		t.Fatal(e)
	}
	r := gateway.Request{Receipt: &gateway.ReceiptRequest{Envelope: envelope, EventID: 1}}
	out, e := gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, r)
	if e != nil || out.Receipt == nil || !out.Receipt.Finalized || out.Receipt.Event.Subject != "receipt-instance" {
		t.Fatal("missing exact finalized receipt", out.Receipt, e)
	}
	r.Receipt.EventID = 2
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, r); e == nil {
		t.Fatal("absent event became finality")
	}
	r.Receipt.EventID = 1
	r.Receipt.Envelope.Command.Operation = "withdraw"
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, r); e == nil {
		t.Fatal("different command received success")
	}
	r.Receipt.Envelope = envelope
	r.Receipt.Envelope.Signature = "forged"
	if _, e = gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, r); e == nil {
		t.Fatal("forged envelope received success")
	}
}

func TestSDKGatewayReadsCompactAccountEvidence(t *testing.T) {
	m, key := testMember("Compact gateway owner")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Members: []federation.Member{m}, Guardians: []string{m.ID}})
	block(t, a, 1, testEnvelope(t, m, key, 0, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": string(bytes.Repeat([]byte{'a'}, 64))}))
	b := block(t, a, 2, testEnvelope(t, m, key, 1, "identity_claim", map[string]any{}))
	g, h, now := gatewayHeader(t, b.AppHash)
	out, e := gateway.Read(context.Background(), g, h, gatewaySource{app: a}, now, time.Minute, gateway.Request{Member: m.ID})
	if e != nil || out.Member == nil || out.Member.Name != m.Name {
		t.Fatal("compact account proof could not compose", out.Member, e)
	}
}
