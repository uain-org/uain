// uain-proof validates a public query/commit bundle against a separately pinned
// genesis. It reads no signing keys and performs no network operations.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func main() {
	genesisPath := flag.String("genesis", "", "independently pinned public genesis")
	bundlePath := flag.String("bundle", "", "public query and signed header JSON")
	key := flag.String("key", "", "expected federation store key")
	maxAge := flag.Duration("max-age", 10*time.Minute, "maximum signed header age")
	historyKind := flag.String("history-kind", "", "verify credit or karma recipient history")
	historyMember := flag.String("history-member", "", "expected public history recipient")
	historyInstance := flag.String("history-instance", "", "optional expected instance attribution")
	historyPage := flag.Uint64("history-page", 0, "expected recipient page number")
	flag.Parse()
	if *historyKind != "" {
		out, err := verifyHistory(*genesisPath, *bundlePath, *key, *historyKind, *historyMember, *historyInstance, *historyPage, *maxAge)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err = json.NewEncoder(os.Stdout).Encode(out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *historyMember != "" || *historyInstance != "" || *historyPage != 0 {
		fmt.Fprintln(os.Stderr, "history flags require --history-kind")
		os.Exit(1)
	}
	if err := verify(*genesisPath, *bundlePath, *key, *maxAge); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("STATE_PROOF_VERIFIED")
}

func verifyHistory(genesisPath, bundlePath, key, kind, member, instance string, page uint64, maxAge time.Duration) (federation.RecipientHistory, error) {
	out := federation.RecipientHistory{}
	if key != "" {
		return out, errors.New("history proof cannot be combined with --key")
	}
	g, err := cmttypes.GenesisDocFromFile(genesisPath)
	if err != nil {
		return out, err
	}
	file, err := os.Open(bundlePath)
	if err != nil {
		return out, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 16*1024*1024+1))
	if err != nil {
		return out, err
	}
	if len(raw) > 16*1024*1024 {
		return out, errors.New("history proof file exceeds 16 MiB")
	}
	var b struct {
		SignedHeader cmttypes.SignedHeader `json:"signed_header"`
		Queries      []abci.ResponseQuery  `json:"queries"`
		Transitions  []proof.Transition    `json:"validator_transitions,omitempty"`
	}
	if err = cmtjson.Unmarshal(raw, &b); err != nil {
		return out, err
	}
	if g, err = proof.Advance(g, b.Transitions); err != nil {
		return out, err
	}
	for _, q := range b.Queries {
		if string(q.Key) == "recipient_history_activation" {
			// This inclusion authenticates the signed header and policy first.
			if err = proof.Verify(g, proof.Bundle{SignedHeader: b.SignedHeader, Query: q}, "recipient_history_activation", time.Now().UTC(), maxAge); err != nil {
				return out, err
			}
			return proof.VerifyRecipientHistory(b.Queries, kind, member, instance, page, b.SignedHeader.AppHash, b.SignedHeader.Height-1)
		}
	}
	return out, errors.New("missing signed history activation proof")
}

func verify(genesisPath, bundlePath, key string, maxAge time.Duration) error {
	g, err := cmttypes.GenesisDocFromFile(genesisPath)
	if err != nil {
		return err
	}
	file, err := os.Open(bundlePath)
	if err != nil {
		return err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 16*1024*1024+1))
	if err != nil {
		return err
	}
	if len(raw) > 16*1024*1024 {
		return errors.New("proof file exceeds 16 MiB")
	}
	var b proof.Bundle
	if err = cmtjson.Unmarshal(raw, &b); err != nil {
		return err
	}
	return proof.Verify(g, b, key, time.Now().UTC(), maxAge)
}
