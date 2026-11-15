package federation

// Language-neutral golden contract fixtures (fixtures/contracts). The same JSON
// files are asserted by the JavaScript and Python consumers; this file checks
// the native Go implementation against them without changing protocol code.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/uain-org/uain/chain/coin"
)

const contractFixtureGo = "go-federation"

func readContractFixture(t *testing.T, name string, out any) {
	t.Helper()
	dir, explicit := os.LookupEnv("UAIN_CONTRACT_FIXTURES")
	if !explicit {
		dir = filepath.Join("..", "..", "fixtures", "contracts")
	}
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if errors.Is(err, os.ErrNotExist) && !explicit {
		// A chain-only copy (ops/remote-test/native-chain.sh) has no repository
		// fixtures directory; the full-checkout CI suite always has it.
		t.Skipf("contract fixtures absent at %s; set UAIN_CONTRACT_FIXTURES to require them", dir)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// contractOutcome is the string "refused" or "accepted", or an object naming
// the expected canonical text, signing bytes or refusal message.
type contractOutcome struct {
	Accepted     bool
	Refused      bool
	Message      string
	Canonical    *string
	SigningBytes *string
}

func (o *contractOutcome) UnmarshalJSON(raw []byte) error {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if s != "refused" && s != "accepted" {
			return errors.New("unknown outcome " + s)
		}
		o.Refused, o.Accepted = s == "refused", s == "accepted"
		return nil
	}
	var v struct {
		Refused      *string `json:"refused"`
		Canonical    *string `json:"canonical"`
		SigningBytes *string `json:"signing_bytes"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	if v.Refused != nil {
		o.Refused, o.Message = true, *v.Refused
	}
	o.Canonical, o.SigningBytes = v.Canonical, v.SigningBytes
	return nil
}

func contractDigest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// The chain canonical form is exercised through SigningBytes itself: a fixed
// command around the payload, so the payload normalization is the real one.
func canonicalThroughSigning(payload string) ([]byte, error) {
	c := Command{Version: 1, ChainID: "c", Member: "m", Sequence: 0, ExpiresHeight: 1, Operation: "o", Payload: json.RawMessage(payload)}
	return SigningBytes(c)
}

func signedPayloadText(canonical string) string {
	return "uain:chain-command:v1\n" + `{"version":1,"chain_id":"c","member":"m","sequence":"0","expires_height":"1","operation":"o","payload":` + canonical + "}"
}

func TestContractFixtureCanonicalJSONChainForm(t *testing.T) {
	var f struct {
		Chain struct {
			Vectors []struct {
				Name, JSON, Canonical, Sha256 string
			}
			EdgeInputs []struct {
				Name, JSON string
				Outcomes   map[string]contractOutcome
			} `json:"edge_inputs"`
		}
	}
	readContractFixture(t, "canonical-json.json", &f)
	if len(f.Chain.Vectors) == 0 || len(f.Chain.EdgeInputs) == 0 {
		t.Fatal("empty chain canonical fixture")
	}
	for _, v := range f.Chain.Vectors {
		got, err := canonicalThroughSigning(v.JSON)
		if err != nil || string(got) != signedPayloadText(v.Canonical) {
			t.Fatalf("%s: got %q err %v, want canonical %q", v.Name, got, err, v.Canonical)
		}
		if contractDigest([]byte(v.Canonical)) != v.Sha256 {
			t.Fatalf("%s: fixture digest drift", v.Name)
		}
	}
	for _, v := range f.Chain.EdgeInputs {
		want, ok := v.Outcomes[contractFixtureGo]
		if !ok {
			t.Fatalf("%s: no Go outcome", v.Name)
		}
		got, err := canonicalThroughSigning(v.JSON)
		switch {
		case want.Refused:
			if err == nil {
				t.Fatalf("%s: accepted %q, want refusal", v.Name, got)
			}
		case want.Canonical != nil:
			if err != nil || string(got) != signedPayloadText(*want.Canonical) {
				t.Fatalf("%s: got %q err %v, want %q", v.Name, got, err, *want.Canonical)
			}
		default:
			t.Fatalf("%s: malformed outcome", v.Name)
		}
	}
}

func checkContractSigning(t *testing.T, name string, raw []byte, want contractOutcome) {
	t.Helper()
	var c Command
	err := Decode(raw, &c)
	var got []byte
	if err == nil {
		got, err = SigningBytes(c)
	}
	switch {
	case want.Refused:
		if err == nil {
			t.Fatalf("%s: signed %q, want refusal", name, got)
		}
		if want.Message != "" && err.Error() != want.Message {
			t.Fatalf("%s: refusal %q, want %q", name, err, want.Message)
		}
	case want.SigningBytes != nil:
		if err != nil || string(got) != *want.SigningBytes {
			t.Fatalf("%s: got %q err %v, want %q", name, got, err, *want.SigningBytes)
		}
	default:
		t.Fatalf("%s: malformed outcome", name)
	}
}

func TestContractFixtureCommandSigningBytes(t *testing.T) {
	var f struct {
		Vectors []struct {
			Name         string
			Command      json.RawMessage
			SigningBytes string `json:"signing_bytes"`
			Sha256       string
		}
		EdgeCommands []struct {
			Name     string
			Command  json.RawMessage
			Outcomes map[string]contractOutcome
		} `json:"edge_commands"`
	}
	readContractFixture(t, "command-signing.json", &f)
	if len(f.Vectors) == 0 || len(f.EdgeCommands) == 0 {
		t.Fatal("empty signing fixture")
	}
	for _, v := range f.Vectors {
		want := v.SigningBytes
		checkContractSigning(t, v.Name, v.Command, contractOutcome{SigningBytes: &want})
		if contractDigest([]byte(want)) != v.Sha256 {
			t.Fatalf("%s: fixture digest drift", v.Name)
		}
	}
	for _, v := range f.EdgeCommands {
		want, ok := v.Outcomes[contractFixtureGo]
		if !ok {
			t.Fatalf("%s: no Go outcome", v.Name)
		}
		checkContractSigning(t, v.Name, v.Command, want)
	}
}

func TestContractFixtureCommandFieldRejections(t *testing.T) {
	var f struct {
		Commands []struct {
			Name, JSON string
			Outcomes   map[string]contractOutcome
		}
	}
	readContractFixture(t, "field-rejections.json", &f)
	if len(f.Commands) == 0 {
		t.Fatal("empty field rejection fixture")
	}
	for _, v := range f.Commands {
		want, ok := v.Outcomes["go-federation-decode"]
		if !ok {
			t.Fatalf("%s: no Go outcome", v.Name)
		}
		checkContractSigning(t, v.Name, []byte(v.JSON), want)
	}
}

func TestContractFixtureAmounts(t *testing.T) {
	var f struct {
		Constants struct {
			UnitsPerAID          string `json:"units_per_aid"`
			LifetimeCeilingUnits string `json:"lifetime_ceiling_units"`
			ProjectAllocation    string `json:"project_allocation_units"`
			CoinSupplyCapUnits   string `json:"coin_supply_cap_units"`
		}
		TaskAmounts []struct {
			Value    json.RawMessage
			Positive bool
		} `json:"task_amounts"`
		CoinUnits []struct {
			Value    string
			Positive bool
		} `json:"coin_units"`
	}
	readContractFixture(t, "amounts.json", &f)
	c := f.Constants
	if c.UnitsPerAID != strconv.FormatUint(coin.UnitsPerCoin, 10) || c.LifetimeCeilingUnits != CentralProjectLifetimeCeiling || c.ProjectAllocation != CentralProjectAllocation || c.CoinSupplyCapUnits != coin.SupplyCap {
		t.Fatalf("constant drift: fixture %+v", c)
	}
	if len(f.CoinUnits) == 0 || len(f.TaskAmounts) == 0 {
		t.Fatal("empty amounts fixture")
	}
	for _, v := range f.CoinUnits {
		_, err := coin.Empty().Reserve(v.Value)
		if (err == nil) != v.Positive {
			t.Fatalf("coin units %q: err %v, want positive=%v", v.Value, err, v.Positive)
		}
	}
	// Native central numbers are bounded by the supply cap; the lifetime ceiling
	// is enforced by the project budget. Native is never stricter per number.
	for _, v := range f.TaskAmounts {
		var s string
		if json.Unmarshal(v.Value, &s) != nil || !v.Positive {
			continue
		}
		if _, err := centralNumber(s); err != nil {
			t.Fatalf("task amount %q refused natively: %v", s, err)
		}
	}
}
