package treasury

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/mr-tron/base58"
)

func evmPlan() Plan {
	return Plan{Schema: "uain-treasury-native-transfer-v1", Intent: "payout/fixture-1", Network: "ethereum:1", Source: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", Target: "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf", Amount: "1000000000000000", Nonce: "7", GasLimit: "21000", MaxPriorityFeePerGas: "1000000000", MaxFeePerGas: "30000000000"}
}
func TestEthereumNativeOnlyDeterminismAndApprovedFields(t *testing.T) {
	p := evmPlan()
	key := make([]byte, 32)
	key[31] = 1
	a, e := Sign(p, key)
	if e != nil {
		t.Fatal(e)
	}
	b, e := Sign(p, key)
	if e != nil || a != b {
		t.Fatal("nondeterministic signed wire", e)
	}
	if !strings.HasPrefix(a.Transaction, "0x02") || len(a.ID) != 66 {
		t.Fatal(a)
	}
	if !bytes.Equal(key, append(make([]byte, 31), 1)) {
		t.Fatal("caller key mutated")
	}
	for _, mutate := range []func(*Plan){func(p *Plan) { p.Source = p.Target }, func(p *Plan) { p.Target = "0x" + strings.Repeat("0", 40) }, func(p *Plan) { p.Amount = "0" }, func(p *Plan) { p.Amount = "01" }, func(p *Plan) { p.Amount = strings.Repeat("9", 78) }, func(p *Plan) { p.Network = "ethereum:2" }, func(p *Plan) { p.GasLimit = "22000" }, func(p *Plan) { p.Nonce = "18446744073709551616" }, func(p *Plan) { p.MaxPriorityFeePerGas = "30000000001" }, func(p *Plan) { p.RecentBlockhash = "unexpected" }, func(p *Plan) { p.Intent = "" }, func(p *Plan) { p.Schema = "other" }} {
		changed := p
		mutate(&changed)
		if _, e := Sign(changed, key); e == nil {
			t.Fatalf("accepted unsafe plan %+v", changed)
		}
	}
	wrong := append([]byte{}, key...)
	wrong[31] = 2
	if _, e := Sign(p, wrong); e == nil {
		t.Fatal("wrong source key accepted")
	}
	if _, e := Sign(p, make([]byte, 32)); e == nil {
		t.Fatal("zero secret accepted")
	}
}
func TestSolanaSingleSystemTransferWireAndIndependentSignature(t *testing.T) {
	seed := bytes.Repeat([]byte{3}, 32)
	key := ed25519.NewKeyFromSeed(seed)
	targetKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{4}, 32))
	block := bytes.Repeat([]byte{9}, 32)
	p := Plan{Schema: "uain-treasury-native-transfer-v1", Intent: "refund/fixture-2", Network: "solana:mainnet", Source: base58.Encode(key.Public().(ed25519.PublicKey)), Target: base58.Encode(targetKey.Public().(ed25519.PublicKey)), Amount: "18446744073709551615", RecentBlockhash: base58.Encode(block)}
	out, e := Sign(p, seed)
	if e != nil {
		t.Fatal(e)
	}
	wire, e := base64.StdEncoding.DecodeString(out.Transaction)
	if e != nil || len(wire) != 215 {
		t.Fatal(len(wire), e)
	}
	if wire[0] != 1 || !ed25519.Verify(key.Public().(ed25519.PublicKey), wire[65:], wire[1:65]) || out.ID != base58.Encode(wire[1:65]) {
		t.Fatal("invalid independently verified Ed25519 transaction")
	}
	// Expected legacy message constructed independently from the official format.
	expected := []byte{1, 0, 1, 3}
	expected = append(expected, key[32:]...)
	expected = append(expected, targetKey[32:]...)
	expected = append(expected, make([]byte, 32)...)
	expected = append(expected, block...)
	expected = append(expected, 1, 2, 2, 0, 1, 12, 2, 0, 0, 0)
	expected = append(expected, bytes.Repeat([]byte{255}, 8)...)
	if !bytes.Equal(wire[65:], expected) {
		t.Fatalf("unexpected SystemTransfer wire %s", hex.EncodeToString(wire[65:]))
	}
	for _, mutate := range []func(*Plan){func(p *Plan) { p.Amount = "18446744073709551616" }, func(p *Plan) { p.Nonce = "0" }, func(p *Plan) { p.MaxFeePerGas = "1" }, func(p *Plan) { p.Source = p.Target }, func(p *Plan) { p.RecentBlockhash = "bad" }, func(p *Plan) { p.Target = base58.Encode(make([]byte, 32)) }} {
		changed := p
		mutate(&changed)
		if _, e := Sign(changed, seed); e == nil {
			t.Fatal("unsafe Solana plan accepted")
		}
	}
}
func TestStrictPublicPlanDecoding(t *testing.T) {
	p := evmPlan()
	b, _ := json.Marshal(p)
	got, e := DecodePlan(b)
	if e != nil || got != p {
		t.Fatal(e)
	}
	for _, raw := range [][]byte{append(b, []byte("{}")...), []byte(`{"schema":"one","schema":"two"}`), []byte(`{"amount":1}`), []byte(`{"calldata":"0x"}`), bytes.Repeat([]byte(" "), 65537)} {
		if _, e := DecodePlan(raw); e == nil {
			t.Fatal("ambiguous or unsupported public plan accepted")
		}
	}
}

// Public fixtures generated independently by viem2.56.8, not this Go RLP code.
func TestEthereumWireMatchesIndependentViemSignatures(t *testing.T) {
	vectors := map[string]string{
		"ethereum:1":    "0x02f8720107843b9aca008506fc23ac00825208942b5ad5c4795c026514f8317c7a215e218dccd6cf87038d7ea4c6800080c001a033b95b06091722b0b7f4823dbd1503fa130d334d5e8b0e8832107f2f14ba54eea0138bb6a1cc8a0ab5cff1e83a2d80ec72ba8384ba2c58e687757b0b57ce55a6c8",
		"ethereum:8453": "0x02f87482210507843b9aca008506fc23ac00825208942b5ad5c4795c026514f8317c7a215e218dccd6cf87038d7ea4c6800080c001a08c47e9e8e6f735ae7595ecc909413a982dee6b516938fad008995716b9612001a014dd01a2849150b713da35c4bc9399a992717c55b4574ce395cfee454fa0f96c",
	}
	key := make([]byte, 32)
	key[31] = 1
	for network, want := range vectors {
		p := evmPlan()
		p.Network = network
		got, e := Sign(p, key)
		if e != nil || got.Transaction != want {
			t.Fatalf("%s differs from independent fixture: %v %+v", network, e, got)
		}
	}
}
