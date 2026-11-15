package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmted "github.com/cometbft/cometbft/crypto/ed25519"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/proof"
)

func instance(t *testing.T, m federation.Member, key []byte, seq uint64, id string) []byte {
	t.Helper()
	return testEnvelope(t, m, key, seq, "instance_create", map[string]any{"id": id, "name": "Instance", "family": "fixture"})
}

// Audit 9 Nov 2026: CheckTx ran in a discarded cache, so any number of
// distinct same-sequence commands entered the mempool.
func TestCheckTxRecordsSequenceAndBoundsPendingPerSender(t *testing.T) {
	m, key := testMember("check-sender")
	other, otherKey := testMember("check-other")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m, other}})
	block(t, a, 1)
	check := func(raw []byte) uint32 {
		t.Helper()
		r, err := a.CheckTx(&abci.RequestCheckTx{Tx: raw, Type: abci.CheckTxType_New})
		if err != nil {
			t.Fatal(err)
		}
		return r.Code
	}
	if check(instance(t, m, key, 0, "c-0")) != 0 {
		t.Fatal("first command refused")
	}
	if check(instance(t, m, key, 0, "c-0-other")) == 0 {
		t.Fatal("second command with the same sequence entered the mempool")
	}
	for i := uint64(1); i < MaxPendingPerSender; i++ {
		if check(instance(t, m, key, i, fmt.Sprintf("c-%d", i))) != 0 {
			t.Fatalf("sequential pending command %d refused", i)
		}
	}
	if check(instance(t, m, key, MaxPendingPerSender, "c-over")) == 0 {
		t.Fatal("sender exceeded the pending bound")
	}
	if check(instance(t, other, otherKey, 0, "o-0")) != 0 {
		t.Fatal("another sender was crowded out")
	}
}

// Audit 9 Nov 2026: one member's failing candidates burned the whole proposal
// candidate window.
func TestProposalFairnessAgainstOneSenderCrowdOut(t *testing.T) {
	m, key := testMember("crowd-guardian")
	other, otherKey := testMember("crowd-victim")
	a := initApp(t, dbm.NewMemDB(), federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m, other}})
	block(t, a, 1, testEnvelope(t, m, key, 0, "activate_storage", map[string]any{"policy": federation.CompactStatePolicy, "evidence_digest": strings.Repeat("a", 64)}))
	txs := [][]byte{}
	for i := 0; i < 200; i++ {
		// Same sequence, distinct bodies: at most one can succeed.
		txs = append(txs, instance(t, m, key, 1, fmt.Sprintf("flood-%03d", i)))
	}
	victim := instance(t, other, otherKey, 0, "victim")
	txs = append(txs, victim)
	prepared, err := a.PrepareProposal(&abci.RequestPrepareProposal{Height: 2, Time: time.Unix(1002, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: txs})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tx := range prepared.Txs {
		found = found || bytes.Equal(tx, victim)
	}
	if !found || len(prepared.Txs) != 2 {
		t.Fatalf("victim crowded out: %d included", len(prepared.Txs))
	}
	// Fairness: four per sender first, then leftover capacity in order.
	fair := [][]byte{}
	for i := 0; i < 10; i++ {
		fair = append(fair, instance(t, m, key, uint64(1+i), fmt.Sprintf("busy-%02d", i)))
	}
	fair = append(fair, victim)
	prepared, err = a.PrepareProposal(&abci.RequestPrepareProposal{Height: 2, Time: time.Unix(1002, 0).UTC(), MaxTxBytes: int64(ProposalBytes), Txs: fair})
	if err != nil || len(prepared.Txs) != 11 || !bytes.Equal(prepared.Txs[4], victim) {
		t.Fatalf("deferred pass wrong: %d included", len(prepared.Txs))
	}
	r, err := a.ProcessProposal(&abci.RequestProcessProposal{Height: 2, Time: time.Unix(1002, 0).UTC(), Txs: prepared.Txs})
	if err != nil || r.Status != abci.ResponseProcessProposal_ACCEPT {
		t.Fatal("fair proposal rejected", r, err)
	}
}

func signHeader(t *testing.T, chain string, h int64, at time.Time, set *cmttypes.ValidatorSet, next *cmttypes.ValidatorSet, keys map[string]cmted.PrivKey, appHash []byte) cmttypes.SignedHeader {
	t.Helper()
	header := &cmttypes.Header{Version: cmtversion.Consensus{Block: 11}, ChainID: chain, Height: h, Time: at, ValidatorsHash: set.Hash(), NextValidatorsHash: next.Hash(), AppHash: appHash, ProposerAddress: set.Validators[0].Address}
	commit := &cmttypes.Commit{Height: h, BlockID: cmttypes.BlockID{Hash: header.Hash(), PartSetHeader: cmttypes.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{1}, 32)}}}
	for _, v := range set.Validators {
		sig := cmttypes.CommitSig{BlockIDFlag: cmttypes.BlockIDFlagCommit, ValidatorAddress: v.Address, Timestamp: at}
		commit.Signatures = append(commit.Signatures, sig)
	}
	for i, v := range set.Validators {
		key, ok := keys[v.Address.String()]
		if !ok {
			commit.Signatures[i] = cmttypes.NewCommitSigAbsent()
			continue
		}
		var err error
		if commit.Signatures[i].Signature, err = key.Sign(commit.VoteSignBytes(chain, int32(i))); err != nil {
			t.Fatal(err)
		}
	}
	return cmttypes.SignedHeader{Header: header, Commit: commit}
}

func validatorSet(keys ...cmted.PrivKey) (*cmttypes.ValidatorSet, map[string]cmted.PrivKey, []proof.TransitionValidator) {
	vs := []*cmttypes.Validator{}
	byAddr := map[string]cmted.PrivKey{}
	tv := []proof.TransitionValidator{}
	for _, k := range keys {
		vs = append(vs, cmttypes.NewValidator(k.PubKey(), 10))
		byAddr[k.PubKey().Address().String()] = k
		tv = append(tv, proof.TransitionValidator{PubKey: k.PubKey().Bytes(), Power: 10})
	}
	return cmttypes.NewValidatorSet(vs), byAddr, tv
}

// The verifier follows a signed rotation from the genesis pin and refuses
// headers signed by a retired set, by a minority, or a forged incoming set.
func TestProofAdvanceFollowsSignedValidatorRotation(t *testing.T) {
	chain := "sdk-test-1"
	k1, k2, k3, k4, k5 := cmted.GenPrivKey(), cmted.GenPrivKey(), cmted.GenPrivKey(), cmted.GenPrivKey(), cmted.GenPrivKey()
	oldSet, oldKeys, _ := validatorSet(k1, k2, k3)
	newSet, _, newTV := validatorSet(k2, k3, k4, k5)
	at := time.Unix(1100, 0).UTC()
	genesis := &cmttypes.GenesisDoc{ChainID: chain, GenesisTime: time.Unix(1000, 0).UTC()}
	for _, v := range oldSet.Validators {
		genesis.Validators = append(genesis.Validators, cmttypes.GenesisValidator{PubKey: v.PubKey, Power: v.VotingPower})
	}
	hash := bytes.Repeat([]byte{7}, 32)
	transition := signHeader(t, chain, 10, at, oldSet, newSet, oldKeys, hash)
	trusted, err := proof.Advance(genesis, []proof.Transition{{SignedHeader: transition, NextValidators: newTV}})
	if err != nil || len(trusted.Validators) != 4 {
		t.Fatal("signed rotation refused", err)
	}
	// Two of three equal validators are exactly two thirds, not more: a
	// three-validator chain tolerates no validator down. This is why the
	// network runs four (3f+1 with f=1).
	partial := map[string]cmted.PrivKey{k1.PubKey().Address().String(): k1, k2.PubKey().Address().String(): k2}
	if _, err = proof.Advance(genesis, []proof.Transition{{SignedHeader: signHeader(t, chain, 10, at, oldSet, newSet, partial, hash), NextValidators: newTV}}); err == nil {
		t.Fatal("exactly two thirds accepted")
	}
	minority := map[string]cmted.PrivKey{k1.PubKey().Address().String(): k1}
	if _, err = proof.Advance(genesis, []proof.Transition{{SignedHeader: signHeader(t, chain, 10, at, oldSet, newSet, minority, hash), NextValidators: newTV}}); err == nil {
		t.Fatal("minority-signed rotation accepted")
	}
	_, _, forgedTV := validatorSet(k4, k5)
	if _, err = proof.Advance(genesis, []proof.Transition{{SignedHeader: transition, NextValidators: forgedTV}}); err == nil {
		t.Fatal("incoming set not matching the signed header accepted")
	}
	// After the rotation, a header from the retired set is refused and one
	// from the new set (with one validator down) is accepted.
	later := signHeader(t, chain, 20, at.Add(time.Second), newSet, newSet, map[string]cmted.PrivKey{k2.PubKey().Address().String(): k2, k3.PubKey().Address().String(): k3, k4.PubKey().Address().String(): k4}, hash)
	if err = later.ValidateBasic(chain); err != nil {
		t.Fatal(err)
	}
	trustedValidators := []*cmttypes.Validator{}
	for _, v := range trusted.Validators {
		trustedValidators = append(trustedValidators, cmttypes.NewValidator(v.PubKey, v.Power))
	}
	set := cmttypes.NewValidatorSet(trustedValidators)
	if !bytes.Equal(set.Hash(), later.ValidatorsHash) || set.VerifyCommitLightAllSignatures(chain, later.Commit.BlockID, later.Height, later.Commit) != nil {
		t.Fatal("advanced anchor does not verify the new set with one validator down")
	}
	stale := signHeader(t, chain, 20, at.Add(time.Second), oldSet, oldSet, oldKeys, hash)
	if bytes.Equal(set.Hash(), stale.ValidatorsHash) {
		t.Fatal("retired set still trusted")
	}
	if _, err = proof.Advance(genesis, make([]proof.Transition, proof.MaxTransitions+1)); err == nil {
		t.Fatal("unbounded transitions accepted")
	}
}

// InitChain records the consensus set; a quorum-free legacy guardian (test
// genesis) changes it; EndBlock returns the update and records the epoch.
func TestEndBlockReturnsValidatorUpdatesAndRecordsEpoch(t *testing.T) {
	m, key := testMember("rotation-guardian")
	a, err := New(log.NewLogger(io.Discard), dbm.NewMemDB(), "sdk-test-1")
	if err != nil {
		t.Fatal(err)
	}
	// Rotation needs recorded validators: a generation-2 genesis.
	g := federation.Genesis{Version: 1, Generation: 2, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	raw, _ := json.Marshal(g)
	cp := cmttypes.DefaultConsensusParams().ToProto()
	cp.Block.MaxGas = 60000000
	v1 := cmted.GenPrivKey()
	if _, err = a.InitChain(&abci.RequestInitChain{ChainId: "sdk-test-1", InitialHeight: 1, Time: time.Unix(1000, 0).UTC(), AppStateBytes: raw, ConsensusParams: &cp, Validators: []abci.ValidatorUpdate{abci.Ed25519ValidatorUpdate(v1.PubKey().Bytes(), 10)}}); err != nil {
		t.Fatal(err)
	}
	v2 := cmted.GenPrivKey()
	update := testEnvelope(t, m, key, 0, "validator_set_update", map[string]any{"updates": []map[string]any{{"pub_key": base64.StdEncoding.EncodeToString(v2.PubKey().Bytes()), "power": "10", "name": "val-2"}}, "evidence_digest": strings.Repeat("a", 64)})
	r := block(t, a, 1, update)
	if r.TxResults[0].Code != 0 || len(r.ValidatorUpdates) != 1 || r.ValidatorUpdates[0].Power != 10 || !bytes.Equal(r.ValidatorUpdates[0].PubKey.GetEd25519(), v2.PubKey().Bytes()) {
		t.Fatalf("EndBlock did not return the update: %+v %+v", r.TxResults, r.ValidatorUpdates)
	}
	if r = block(t, a, 2); len(r.ValidatorUpdates) != 0 {
		t.Fatal("update repeated")
	}
	q, err := a.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("validator_epoch/00000000000000000001"), Height: 2})
	if err != nil || !strings.Contains(string(q.Value), `"header_height":"2"`) {
		t.Fatal("validator epoch missing", string(q.Value), err)
	}
}

// A scheduled upgrade halts a binary without its handler at the plan height,
// refuses a binary carrying it early, and runs it exactly once.
func TestUpgradeHandlersHaltRunAndRecord(t *testing.T) {
	m, key := testMember("upgrade-guardian")
	g := federation.Genesis{Version: 1, Guardians: []string{m.ID}, Members: []federation.Member{m}}
	db := dbm.NewMemDB()
	a := initApp(t, db, g)
	// In place: the existing single guardian activates consensus v2 first.
	activate := testEnvelope(t, m, key, 0, "activate_consensus_v2", map[string]any{"policy": federation.ConsensusV2Policy, "evidence_digest": strings.Repeat("a", 64)})
	plan := testEnvelope(t, m, key, 1, "upgrade_schedule", map[string]any{"name": "v0-4-1", "height": "4", "evidence_digest": strings.Repeat("a", 64)})
	if r := block(t, a, 1, activate, plan); r.TxResults[0].Code != 0 || r.TxResults[1].Code != 0 {
		t.Fatal(r.TxResults)
	}
	block(t, a, 2)
	block(t, a, 3)
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("binary without the handler did not halt")
			}
		}()
		if _, err := a.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 4, Time: time.Unix(1004, 0).UTC()}); err != nil {
			panic(err)
		}
	}()
	ran := 0
	handlers := map[string]UpgradeHandler{"v0-4-1": func(ctx sdk.Context, k federation.Keeper, p federation.UpgradePlan) error {
		ran++
		k.Store.Set([]byte("migrated"), []byte(`true`))
		return nil
	}}
	// Restart on the new binary at the stored height.
	b, err := New(log.NewLogger(io.Discard), db, "sdk-test-1", WithUpgradeHandlers(handlers))
	if err != nil {
		t.Fatal(err)
	}
	block(t, b, 4)
	block(t, b, 5)
	if ran != 1 {
		t.Fatal("handler ran", ran)
	}
	q, _ := b.Query(context.Background(), &abci.RequestQuery{Path: "/store/federation/key", Data: []byte("upgrade_done/v0-4-1"), Height: 5})
	if string(q.Value) != "4" {
		t.Fatal("completion not recorded", string(q.Value))
	}
	// An early binary refuses to run before the trigger.
	db2 := dbm.NewMemDB()
	c := initApp(t, db2, g)
	block(t, c, 1, activate, plan)
	early, err := New(log.NewLogger(io.Discard), db2, "sdk-test-1", WithUpgradeHandlers(handlers))
	if err != nil {
		t.Fatal(err)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("binary carrying the pending handler ran before its height")
			}
		}()
		if _, err := early.FinalizeBlock(&abci.RequestFinalizeBlock{Height: 2, Time: time.Unix(1002, 0).UTC()}); err != nil {
			panic(err)
		}
	}()
}
