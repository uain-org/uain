// uain-reset-checkpoint reads only public control state from a stopped
// application DB copy. It never opens node/member keys or starts consensus.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"

	"cosmossdk.io/log/v2"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/uain-org/uain/chain/app"
	"github.com/uain-org/uain/chain/federation"
)

type Control struct {
	Guardians  []string            `json:"guardians"`
	Members    []federation.Member `json:"members"`
	Epoch      string              `json:"epoch"`
	EventCount string              `json:"event_count"`
}

func controlState(get func(string) []byte, member func(string) (federation.Member, error)) (Control, error) {
	out := Control{EventCount: "0"}
	raw := get("guardian_epoch_current")
	if len(raw) == 0 {
		if err := json.Unmarshal(get("guardians"), &out.Guardians); err != nil {
			return out, err
		}
	} else {
		if err := json.Unmarshal(raw, &out.Epoch); err != nil || out.Epoch == "" {
			return out, errors.New("invalid current guardian epoch")
		}
		var epoch struct {
			ID        string   `json:"id"`
			Guardians []string `json:"guardians"`
		}
		if err := json.Unmarshal(get("guardian_epoch/"+out.Epoch), &epoch); err != nil || epoch.ID != out.Epoch {
			return out, errors.New("missing exact current guardian epoch")
		}
		out.Guardians = epoch.Guardians
	}
	if len(out.Guardians) < 1 || len(out.Guardians) > 20 {
		return out, errors.New("bounded effective guardians required")
	}
	seen := map[string]bool{}
	for _, id := range out.Guardians {
		m, err := member(id)
		pub, decodeErr := base64.RawURLEncoding.DecodeString(m.PublicKey)
		if err != nil || decodeErr != nil || len(pub) != ed25519.PublicKeySize || federation.Address(pub) != id || m.ID != id || m.Licence != "active" || seen[id] {
			return out, errors.New("exact active guardian public identity required")
		}
		seen[id] = true
		out.Members = append(out.Members, m)
	}
	if raw = get("event_count"); len(raw) > 0 {
		var count uint64
		if err := json.Unmarshal(raw, &count); err != nil {
			return out, err
		}
		out.EventCount = strconv.FormatUint(count, 10)
	}
	return out, nil
}

func run(databaseDir, genesisPath, pin string) error {
	raw, err := os.ReadFile(genesisPath)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(raw)
	if len(raw) > 8*1024*1024 || hex.EncodeToString(hash[:]) != pin {
		return errors.New("exact original public genesis pin required")
	}
	g, err := cmttypes.GenesisDocFromJSON(raw)
	if err != nil {
		return err
	}
	db, err := dbm.NewDB("application", dbm.GoLevelDBBackend, databaseDir)
	if err != nil {
		return errors.New("stopped application DB copy required")
	}
	defer db.Close()
	a, err := app.New(log.NewLogger(io.Discard), db, g.ChainID)
	if err != nil {
		return fmt.Errorf("cannot read stopped application commit: %w", err)
	}
	if a.LastBlockHeight() < 1 {
		return errors.New("committed application state required")
	}
	// A stopped application has no live CheckTx/Finalize context. Branch the
	// exact committed IAVL version directly; never initialize or execute a block.
	store, err := a.CommitMultiStore().CacheMultiStoreWithVersion(a.LastBlockHeight())
	if err != nil {
		return err
	}
	ctx := sdk.NewContext(store, cmtproto.Header{Height: a.LastBlockHeight(), ChainID: g.ChainID}, false, log.NewLogger(io.Discard))
	keeper := a.Keeper(ctx)
	state, err := controlState(func(key string) []byte { return keeper.Store.Get([]byte(key)) }, keeper.Member)
	if err != nil {
		return err
	}
	raw, err = cmtjson.Marshal(struct {
		Guardians  []string            `json:"guardians"`
		Members    []federation.Member `json:"members"`
		Epoch      string              `json:"epoch"`
		EventCount string              `json:"event_count"`
		ChainID    string              `json:"chain_id"`
		GenesisSHA string              `json:"genesis_sha256"`
		Height     string              `json:"height"`
		AppHash    string              `json:"app_hash"`
	}{state.Guardians, state.Members, state.Epoch, state.EventCount, g.ChainID, pin, strconv.FormatInt(a.LastBlockHeight(), 10), hex.EncodeToString(a.LastCommitID().Hash)})
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(raw)
	return err
}

func main() {
	databaseDir := flag.String("database-dir", "", "stopped application DB COPY directory")
	genesis := flag.String("genesis", "", "original public genesis")
	pin := flag.String("genesis-sha256", "", "exact original public genesis SHA")
	flag.Parse()
	if *databaseDir == "" || *genesis == "" || len(*pin) != 64 || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "bounded public stopped-state selection required")
		os.Exit(1)
	}
	if err := run(*databaseDir, *genesis, *pin); err != nil {
		fmt.Fprintln(os.Stderr, "public stopped-state checkpoint refused:", err)
		os.Exit(1)
	}
}
