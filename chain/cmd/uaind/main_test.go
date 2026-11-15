package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cosmossdk.io/log/v2"
	dbm "github.com/cosmos/cosmos-db"

	"github.com/uain-org/uain/chain/app"
	"github.com/uain-org/uain/chain/privateexchange"
)

func TestInitializationCannotReusePartialSignerHome(t *testing.T) {
	home := t.TempDir()
	marker := filepath.Join(home, "existing-signing-state.fixture")
	if e := os.WriteFile(marker, []byte("fictional previous signing state"), 0600); e != nil {
		t.Fatal(e)
	}
	previous := os.Args
	defer func() { os.Args = previous }()
	os.Args = []string{"uaind", "init", "--home", home, "--app-genesis", filepath.Join(t.TempDir(), "missing-public-genesis.json")}
	if e := run(); e == nil || !strings.Contains(e.Error(), "nonempty node home") {
		t.Fatalf("partial signer initialization was not fenced: %v", e)
	}
	data, e := os.ReadFile(marker)
	if e != nil || string(data) != "fictional previous signing state" {
		t.Fatal("old signing state changed")
	}
}

func TestStartRefusesNonOrchardBuild(t *testing.T) {
	if privateexchange.Available() {
		t.Skip("orchard build")
	}
	a, err := app.New(log.NewLogger(io.Discard), dbm.NewMemDB(), "uain-test-1")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("UAIN_ALLOW_NON_ORCHARD", "")
	if requireOrchard(a) == nil {
		t.Fatal("non-orchard binary allowed to start")
	}
	t.Setenv("UAIN_ALLOW_NON_ORCHARD", "1")
	if err = requireOrchard(a); err != nil {
		t.Fatal("test fixture override refused on an empty store", err)
	}
	a.CommitMultiStore().GetKVStore(a.Key).Set([]byte("private_activation"), []byte(`{}`))
	if requireOrchard(a) == nil {
		t.Fatal("non-orchard binary started on a store with private payments")
	}
	if buildFlavour() != "non-orchard" {
		t.Fatal("version does not name the build")
	}
}
