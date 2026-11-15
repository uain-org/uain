// Command uain-rollback recovers a stopped node that persisted a wrong
// application state for its latest height, for example a node still running
// an older uaind when a new consensus operation was executed. It rolls the
// CometBFT state and the application store back by exactly one height. No
// block is removed, so when the node restarts with the current uaind it
// re-executes that block against the correct rules.
//
//	uain-rollback --home /path/to/node/home
//
// Run it only while the node is stopped, and only with the current uaind
// release installed for the restart. It never touches keys or signing state.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"cosmossdk.io/log/v2"
	cmtcmd "github.com/cometbft/cometbft/cmd/cometbft/commands"
	cfg "github.com/cometbft/cometbft/config"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/spf13/viper"

	"github.com/uain-org/uain/chain/app"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ROLLBACK_REFUSED:", err)
		os.Exit(1)
	}
}

func run() error {
	home := flag.String("home", "", "stopped node home")
	flag.Parse()
	if *home == "" {
		return errors.New("--home is required")
	}
	abs, err := filepath.Abs(*home)
	if err != nil {
		return err
	}
	config := cfg.DefaultConfig().SetRoot(abs)
	v := viper.New()
	v.SetConfigFile(filepath.Join(abs, "config/config.toml"))
	if err = v.ReadInConfig(); err != nil {
		return err
	}
	if err = v.Unmarshal(config); err != nil {
		return err
	}
	config.SetRoot(abs)
	doc, err := cmttypes.GenesisDocFromFile(config.GenesisFile())
	if err != nil {
		return err
	}
	db, err := dbm.NewDB("application", dbm.GoLevelDBBackend, filepath.Join(abs, "data"))
	if err != nil {
		return err
	}
	defer db.Close()
	application, err := app.New(log.NewLogger(io.Discard), db, doc.ChainID)
	if err != nil {
		return err
	}
	before := application.LastBlockHeight()
	height, hash, err := cmtcmd.RollbackState(config, false)
	if err != nil {
		return fmt.Errorf("CometBFT state rollback: %w", err)
	}
	if err = application.CommitMultiStore().RollbackToVersion(height); err != nil {
		return fmt.Errorf("application store rollback: %w", err)
	}
	fmt.Printf("ROLLED_BACK chain=%s from=%d to=%d app_hash=%X\n", doc.ChainID, before, height, hash)
	return nil
}
