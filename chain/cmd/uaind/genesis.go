package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"time"

	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmttypes "github.com/cometbft/cometbft/types"

	"github.com/uain-org/uain/chain/federation"
)

// writeGenesis assembles a multi-validator consensus genesis from the public
// identities printed by "uaind keys". The application genesis is validated
// first and its pinned validators, if any, must equal the consensus set.
//
//	uaind genesis --chain-id ID --app-genesis app.json --validators v.json --out genesis.json
//
// v.json: [{"name":"uain-val-1","pub_key":"<base64>","power":10}, ...]
func writeGenesis(args []string) error {
	fs := flag.NewFlagSet("genesis", flag.ContinueOnError)
	chainID := fs.String("chain-id", "", "unique chain ID")
	appGenesis := fs.String("app-genesis", "", "federation genesis JSON")
	validatorsFile := fs.String("validators", "", "validator identities JSON")
	out := fs.String("out", "", "consensus genesis to write (must not exist)")
	genesisTime := fs.String("time", "", "RFC 3339 genesis time (default now)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *chainID == "" || *appGenesis == "" || *validatorsFile == "" || *out == "" {
		return errors.New("--chain-id, --app-genesis, --validators and --out are required")
	}
	if _, err := os.Stat(*out); !os.IsNotExist(err) {
		return errors.New("refusing to overwrite an existing genesis")
	}
	raw, err := os.ReadFile(*appGenesis)
	if err != nil {
		return err
	}
	var state federation.Genesis
	if err = federation.DecodeGenesis(raw, &state); err != nil {
		return err
	}
	store := memoryStore{}
	if err = (federation.Keeper{Store: store}).Init(state); err != nil {
		return err
	}
	vraw, err := os.ReadFile(*validatorsFile)
	if err != nil {
		return err
	}
	var identities []struct {
		Name   string `json:"name"`
		PubKey []byte `json:"pub_key"`
		Power  int64  `json:"power"`
	}
	if err = json.Unmarshal(vraw, &identities); err != nil {
		return err
	}
	if len(identities) == 0 || len(identities) > federation.MaxValidators {
		return errors.New("1 to 50 validators required")
	}
	validators := []cmttypes.GenesisValidator{}
	pinned := []federation.GenesisValidator{}
	for _, v := range identities {
		if len(v.PubKey) != cmted.PubKeySize || v.Power <= 0 || v.Power > federation.MaxValidatorPower {
			return errors.New("invalid validator identity")
		}
		pub := cmted.PubKey(v.PubKey)
		validators = append(validators, cmttypes.GenesisValidator{Address: pub.Address(), PubKey: pub, Power: v.Power, Name: v.Name})
		pinned = append(pinned, federation.GenesisValidator{PubKey: base64.StdEncoding.EncodeToString(v.PubKey), Power: v.Power})
	}
	// Equality with any application-pinned set is checked exactly as InitChain will.
	if err = (federation.Keeper{Store: store}).RecordGenesisValidators(pinned); err != nil {
		return err
	}
	at := time.Now().UTC()
	if *genesisTime != "" {
		if at, err = time.Parse(time.RFC3339, *genesisTime); err != nil {
			return err
		}
	}
	params := cmttypes.DefaultConsensusParams()
	params.Block.MaxBytes = 1024 * 1024
	params.Block.MaxGas = 60000000
	doc := cmttypes.GenesisDoc{GenesisTime: at, ChainID: *chainID, InitialHeight: 1, ConsensusParams: params, Validators: validators, AppState: json.RawMessage(raw)}
	if err = doc.ValidateAndComplete(); err != nil {
		return err
	}
	return doc.SaveAs(*out)
}
