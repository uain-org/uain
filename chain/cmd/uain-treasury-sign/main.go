// Offline fixed-purpose child. Custody supplies only a32-byte seed through FD3;
// stdin is the bounded public plan. It never opens a key path or makes a request.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/treasury"
)

func run() error {
	raw, e := io.ReadAll(io.LimitReader(os.Stdin, 65537))
	if e != nil {
		return e
	}
	mode := "transfer"
	if len(os.Args) == 2 {
		mode = os.Args[1]
	} else if len(os.Args) != 1 {
		return fmt.Errorf("unsupported custody mode")
	}
	if len(raw) > 65536 {
		return fmt.Errorf("oversized public custody plan")
	}
	// Parse public input before reading the custody channel. Unknown fields,
	// duplicate keys, malformed schemas and unsupported modes need no key access.
	var transfer treasury.Plan
	var control treasury.ControlPlan
	var addressPlan struct {
		Schema  string `json:"schema"`
		Network string `json:"network"`
	}
	switch mode {
	case "transfer":
		transfer, e = treasury.DecodePlan(raw)
		if e == nil && transfer.Schema != "uain-treasury-native-transfer-v1" {
			e = fmt.Errorf("unsupported transfer schema")
		}
	case "control":
		control, e = treasury.DecodeControlPlan(raw)
		if e == nil && control.Schema != "uain-treasury-escrow-control-v1" {
			e = fmt.Errorf("unsupported control schema")
		}
	case "address":
		e = federation.Decode(raw, &addressPlan)
		if e == nil && addressPlan.Schema != "uain-treasury-address-v1" {
			e = fmt.Errorf("unsupported address schema")
		}
	default:
		return fmt.Errorf("unsupported custody mode")
	}
	if e != nil {
		return e
	}
	keyFD := os.NewFile(3, "custody-seed")
	if keyFD == nil {
		return fmt.Errorf("custody seed channel missing")
	}
	defer keyFD.Close()
	seed, e := io.ReadAll(io.LimitReader(keyFD, 33))
	if e != nil {
		return e
	}
	defer func() {
		for i := range seed {
			seed[i] = 0
		}
	}()
	var out any
	switch mode {
	case "transfer":
		out, e = treasury.Sign(transfer, seed)
	case "control":
		out, e = treasury.SignControl(control, seed)
	case "address":
		var address string
		address, e = treasury.Address(addressPlan.Network, seed)
		out = map[string]string{"network": addressPlan.Network, "address": address}
	}
	if e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, "treasury signing refused")
		os.Exit(1)
	}
}
