package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"syscall"
	"time"

	cfg "github.com/cometbft/cometbft/config"
	cmtflags "github.com/cometbft/cometbft/libs/cli/flags"
	cmtlog "github.com/cometbft/cometbft/libs/log"
	"github.com/cometbft/cometbft/node"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	"github.com/cometbft/cometbft/proxy"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/server"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	"github.com/spf13/viper"

	"github.com/uain-org/uain/chain/app"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/privateexchange"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: uaind init|start|version")
	}
	if os.Args[1] == "version" {
		fmt.Println("uaind", app.Version, buildFlavour())
		return nil
	}
	if os.Args[1] == "genesis" {
		return writeGenesis(os.Args[2:])
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	home := fs.String("home", ".data", "node data directory")
	chainID := fs.String("chain-id", "uain-dev-1", "unique chain ID")
	genesisFile := fs.String("app-genesis", "", "federation genesis JSON (public state only)")
	rpc := fs.String("rpc", "tcp://127.0.0.1:26657", "RPC listen address")
	p2pAddr := fs.String("p2p", "tcp://127.0.0.1:26656", "P2P listen address")
	consensusGenesis := fs.String("genesis", "", "join: complete consensus genesis written by uaind genesis")
	peers := fs.String("peers", "", "join: persistent peers id@host:port,...")
	moniker := fs.String("moniker", "uain", "keys/join: node name")
	if err := fs.Parse(os.Args[2:]); err != nil {
		return err
	}
	abs, err := filepath.Abs(*home)
	if err != nil {
		return err
	}
	config := cfg.DefaultConfig().SetRoot(abs)
	switch os.Args[1] {
	case "node-id":
		k, err := p2p.LoadNodeKey(config.NodeKeyFile())
		if err != nil {
			return err
		}
		fmt.Println(k.ID())
		return nil
	case "keys":
		// Generate one validator's node and signing keys into an empty home and
		// print only the public identity for the genesis ceremony.
		if entries, err := os.ReadDir(abs); err == nil && len(entries) > 0 {
			return errors.New("refusing to generate keys in a nonempty node home")
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		cfg.EnsureRoot(abs)
		pv := privval.LoadOrGenFilePV(config.PrivValidatorKeyFile(), config.PrivValidatorStateFile())
		pub, err := pv.GetPubKey()
		if err != nil {
			return err
		}
		nk, err := p2p.LoadOrGenNodeKey(config.NodeKeyFile())
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"name": *moniker, "pub_key": pub.Bytes(), "address": pub.Address().String(), "node_id": string(nk.ID())})
	case "join":
		// Install a ceremony genesis next to keys made by "uaind keys".
		if *consensusGenesis == "" {
			return errors.New("--genesis is required")
		}
		if _, err := os.Stat(config.GenesisFile()); !os.IsNotExist(err) {
			return errors.New("refusing to overwrite an existing node genesis")
		}
		doc, err := cmttypes.GenesisDocFromFile(*consensusGenesis)
		if err != nil {
			return err
		}
		var state federation.Genesis
		if err = federation.DecodeGenesis(doc.AppState, &state); err != nil {
			return err
		}
		if err = (federation.Keeper{Store: memoryStore{}}).Init(state); err != nil {
			return err
		}
		pv := privval.LoadFilePV(config.PrivValidatorKeyFile(), config.PrivValidatorStateFile())
		pub, err := pv.GetPubKey()
		if err != nil {
			return err
		}
		member := false
		for _, v := range doc.Validators {
			member = member || bytes.Equal(v.PubKey.Bytes(), pub.Bytes())
		}
		config.Moniker = *moniker
		config.RPC.ListenAddress = *rpc
		config.P2P.ListenAddress = *p2pAddr
		config.P2P.PersistentPeers = *peers
		config.P2P.AddrBookStrict = false
		config.P2P.AllowDuplicateIP = true
		config.RPC.MaxBodyBytes = federation.MaxEnvelopeBytes * 2
		config.Mempool.MaxTxBytes = federation.MaxEnvelopeBytes
		config.Consensus.TimeoutCommit = 2 * time.Second
		cfg.WriteConfigFile(filepath.Join(abs, "config/config.toml"), config)
		if err = doc.SaveAs(config.GenesisFile()); err != nil {
			return err
		}
		fmt.Printf("joined %s as %s validator=%t\n", doc.ChainID, *moniker, member)
		return nil
	case "init":
		if *genesisFile == "" {
			return errors.New("--app-genesis is required; no generated member or research fixtures")
		}
		if _, err := os.Stat(config.GenesisFile()); !os.IsNotExist(err) {
			return errors.New("refusing to overwrite an existing node")
		}
		if entries, err := os.ReadDir(abs); err == nil && len(entries) > 0 {
			return errors.New("refusing to initialize a nonempty node home")
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		raw, err := os.ReadFile(*genesisFile)
		if err != nil {
			return err
		}
		var state federation.Genesis
		if err = federation.DecodeGenesis(raw, &state); err != nil {
			return err
		}
		// Validate before generating or writing any signing key.
		if err = (federation.Keeper{Store: memoryStore{}}).Init(state); err != nil {
			return err
		}
		cfg.EnsureRoot(abs)
		config.Moniker = "uain"
		config.RPC.ListenAddress = *rpc
		config.P2P.ListenAddress = *p2pAddr
		config.RPC.MaxBodyBytes = federation.MaxEnvelopeBytes * 2
		config.Mempool.MaxTxBytes = federation.MaxEnvelopeBytes
		config.Consensus.TimeoutCommit = 2 * time.Second
		cfg.WriteConfigFile(filepath.Join(abs, "config/config.toml"), config)
		pv := privval.LoadOrGenFilePV(config.PrivValidatorKeyFile(), config.PrivValidatorStateFile())
		pub, err := pv.GetPubKey()
		if err != nil {
			return err
		}
		if _, err = p2p.LoadOrGenNodeKey(config.NodeKeyFile()); err != nil {
			return err
		}
		params := cmttypes.DefaultConsensusParams()
		params.Block.MaxBytes = 1024 * 1024
		params.Block.MaxGas = 60000000
		doc := cmttypes.GenesisDoc{GenesisTime: time.Now().UTC(), ChainID: *chainID, InitialHeight: 1, ConsensusParams: params, Validators: []cmttypes.GenesisValidator{{Address: pub.Address(), PubKey: pub, Power: 10, Name: "uain-bootstrap"}}, AppState: json.RawMessage(raw)}
		if err = doc.ValidateAndComplete(); err != nil {
			return err
		}
		return doc.SaveAs(config.GenesisFile())
	case "start":
		v := viper.New()
		v.SetConfigFile(filepath.Join(abs, "config/config.toml"))
		if err = v.ReadInConfig(); err != nil {
			return err
		}
		if err = v.Unmarshal(config); err != nil {
			return err
		}
		config.SetRoot(abs)
		if err = config.ValidateBasic(); err != nil {
			return err
		}
		doc, err := cmttypes.GenesisDocFromFile(config.GenesisFile())
		if err != nil {
			return err
		}
		db, err := dbm.NewDB("application", dbm.GoLevelDBBackend, filepath.Join(abs, "data"))
		if err != nil {
			return err
		}
		defer db.Close()
		appLog, err := applicationLogger(os.Stdout, config.LogLevel)
		if err != nil {
			return err
		}
		application, err := app.New(appLog, db, doc.ChainID)
		if err != nil {
			return err
		}
		if err = requireOrchard(application); err != nil {
			return err
		}
		// Start never generates replacement keys: a missing key/state is an operator
		// recovery event, and cannot silently create a different validator identity.
		for _, p := range []string{config.PrivValidatorKeyFile(), config.PrivValidatorStateFile(), config.NodeKeyFile()} {
			if _, err = os.Stat(p); err != nil {
				return err
			}
		}
		pv := privval.LoadFilePV(config.PrivValidatorKeyFile(), config.PrivValidatorStateFile())
		nk, err := p2p.LoadNodeKey(config.NodeKeyFile())
		if err != nil {
			return err
		}
		logger, err := nodeLogger(os.Stdout, config.LogLevel)
		if err != nil {
			return err
		}
		n, err := node.NewNode(config, pv, nk, proxy.NewLocalClientCreator(server.NewCometABCIWrapper(application)), node.DefaultGenesisDocProviderFunc(config), cfg.DefaultDBProvider, node.DefaultMetricsProvider(config.Instrumentation), logger)
		if err != nil {
			return err
		}
		if err = n.Start(); err != nil {
			return err
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		<-ctx.Done()
		if err = n.Stop(); err != nil {
			return err
		}
		n.Wait()
		return nil
	default:
		return errors.New("unknown command")
	}
}

// buildFlavour names the Orchard verifier build. A node built without it
// cannot verify private payments or Coin activation and would diverge.
func buildFlavour() string {
	if privateexchange.Available() {
		return "orchard"
	}
	return "non-orchard"
}

// requireOrchard refuses to start a node that cannot execute every
// transaction the network accepts. UAIN_ALLOW_NON_ORCHARD=1 admits a test
// fixture only while its store holds no private, Coin or central policy.
func requireOrchard(a *app.App) error {
	if privateexchange.Available() {
		return nil
	}
	if os.Getenv("UAIN_ALLOW_NON_ORCHARD") != "1" {
		return errors.New("refusing to start: this uaind was built without the orchard tag and would diverge on private payments; rebuild with -tags orchard")
	}
	store := a.CommitMultiStore().GetKVStore(a.Key)
	for _, marker := range []string{"private_activation", "coin_activation", "central_earning_activation"} {
		if store.Get([]byte(marker)) != nil {
			return fmt.Errorf("refusing to start: store holds %s and this uaind lacks the Orchard verifier", marker)
		}
	}
	return nil
}

type memoryStore map[string][]byte

func (s memoryStore) Get(k []byte) []byte { return s[string(k)] }
func (s memoryStore) Set(k, v []byte)     { s[string(k)] = v }
func (s memoryStore) Delete(k []byte)     { delete(s, string(k)) }
func (s memoryStore) Last(start, end []byte) (*federation.Entry, error) {
	rows, err := s.Range(start, end, len(s))
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[len(rows)-1]
	return &row, nil
}
func (s memoryStore) Range(start, end []byte, limit int) ([]federation.Entry, error) {
	keys := []string{}
	for key := range s {
		if bytes.Compare([]byte(key), start) >= 0 && bytes.Compare([]byte(key), end) < 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	out := []federation.Entry{}
	for _, key := range keys {
		if len(out) == limit {
			break
		}
		out = append(out, federation.Entry{Key: []byte(key), Value: bytes.Clone(s[key])})
	}
	return out, nil
}

var _ servertypes.ABCI = (*app.App)(nil)

// nodeLogger centralizes the configured consensus logging boundary.
func nodeLogger(output io.Writer, level string) (cmtlog.Logger, error) {
	filtered, err := cmtflags.ParseLogLevel(level, cmtlog.NewTMLogger(output), "info")
	if err != nil {
		return nil, err
	}
	return privateNodeLogger{next: filtered}, nil
}
