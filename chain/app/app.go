// Package app wires UAIN's native federation state machine into Cosmos SDK
// BaseApp. CometBFT commits the SDK's IAVL application hash at every height.
package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/x/tx/signing"
	gogoproto "github.com/cosmos/gogoproto/proto"
	protov2 "google.golang.org/protobuf/proto"

	"github.com/uain-org/uain/chain/federation"
	"github.com/uain-org/uain/chain/types"
)

const Version = "0.4.2"
const TransactionGas = uint64(3000000)

type memberAddressCodec struct{}

func (memberAddressCodec) StringToBytes(s string) ([]byte, error) {
	if len(s) != 45 || s[:5] != "uain1" {
		return nil, errors.New("invalid member address")
	}
	return hex.DecodeString(s[5:])
}
func (memberAddressCodec) BytesToString(b []byte) (string, error) {
	if len(b) != 20 {
		return "", errors.New("invalid member address bytes")
	}
	return "uain1" + hex.EncodeToString(b), nil
}

type envelopeTx struct{ message *types.MsgExecute }

func (t envelopeTx) GetMsgs() []sdk.Msg                    { return []sdk.Msg{t.message} }
func (t envelopeTx) GetMsgsV2() ([]protov2.Message, error) { return []protov2.Message{t.message}, nil }
func (t envelopeTx) GetGas() uint64                        { return TransactionGas }
func decodeTx(raw []byte) (sdk.Tx, error) {
	var e federation.Envelope
	if err := federation.Decode(raw, &e); err != nil {
		return nil, err
	}
	return envelopeTx{&types.MsgExecute{Envelope: raw}}, nil
}

type App struct {
	*baseapp.BaseApp
	Key      *storetypes.KVStoreKey
	upgrades map[string]UpgradeHandler
}

// MaxPendingPerSender bounds one member's unconfirmed commands in the check
// state, so no member can fill the mempool or the proposal window.
const MaxPendingPerSender = 16

type Option func(*App)

// WithUpgradeHandlers replaces the binary's registered upgrade handlers
// (tests and rehearsals).
func WithUpgradeHandlers(h map[string]UpgradeHandler) Option {
	return func(a *App) { a.upgrades = h }
}

func New(logger log.Logger, db dbm.DB, chainID string, options ...Option) (*App, error) {
	opts := signing.Options{AddressCodec: memberAddressCodec{}, ValidatorAddressCodec: memberAddressCodec{}}
	opts.DefineCustomGetSigners("uain.federation.v1.MsgExecute", func(msg protov2.Message) ([][]byte, error) {
		var e federation.Envelope
		if err := federation.Decode(msg.(*types.MsgExecute).Envelope, &e); err != nil {
			return nil, err
		}
		b, err := (memberAddressCodec{}).StringToBytes(e.Command.Member)
		return [][]byte{b}, err
	})
	registry, err := codectypes.NewInterfaceRegistryWithOptions(codectypes.InterfaceRegistryOptions{ProtoFiles: gogoproto.HybridResolver, SigningOptions: opts})
	if err != nil {
		return nil, err
	}
	registry.RegisterImplementations((*sdk.Msg)(nil), &types.MsgExecute{})
	base := baseapp.NewBaseApp("uain", logger, db, decodeTx, baseapp.SetChainID(chainID), baseapp.EnableBlockGasMeter())
	base.SetVersion(Version)
	base.SetInterfaceRegistry(registry)
	base.SetTxEncoder(func(tx sdk.Tx) ([]byte, error) { return tx.(envelopeTx).message.Envelope, nil })
	key := storetypes.NewKVStoreKey("federation")
	params := storetypes.NewKVStoreKey("consensus")
	base.MountStores(key, params)
	base.SetParamStore(parameterStore{params})
	app := &App{BaseApp: base, Key: key, upgrades: RegisteredUpgrades()}
	for _, option := range options {
		option(app)
	}
	app.installProposalHandlers()
	types.RegisterMsgServer(base.MsgServiceRouter(), messageServer{app: app})
	base.SetInitChainer(func(ctx sdk.Context, req *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
		var g federation.Genesis
		if err := federation.DecodeGenesis(req.AppStateBytes, &g); err != nil {
			return nil, err
		}
		if err := app.Keeper(ctx).Init(g); err != nil {
			return nil, err
		}
		// Record CometBFT's genesis set in state; it must equal any set the
		// application genesis pinned. Light clients follow changes from here.
		// Only generation-2 chains record the consensus set; replaying an
		// existing genesis must reproduce its original application hash.
		if g.Generation >= 2 && len(req.Validators) > 0 {
			vs, err := genesisValidators(req.Validators)
			if err != nil {
				return nil, err
			}
			if err = app.Keeper(ctx).RecordGenesisValidators(vs); err != nil {
				return nil, err
			}
		}
		return &abci.ResponseInitChain{Validators: req.Validators}, nil
	})
	base.SetAnteHandler(func(ctx sdk.Context, tx sdk.Tx, simulate bool) (sdk.Context, error) {
		ctx = ctx.WithGasMeter(storetypes.NewGasMeter(TransactionGas))
		raw := tx.(envelopeTx).message.Envelope
		ctx.GasMeter().ConsumeGas(uint64(len(raw))*20, "signed envelope")
		// The raw store lookup reads only the fixed activation marker. Before
		// activation, the previous gas/validation path is retained. Afterwards,
		// FinalizeBlock executes the operation once in the message cache; CheckTx
		// still fully executes it in an isolated cache.
		// Charging a complete transition twice prevented otherwise bounded
		// twenty-check settlements from fitting the transaction gas limit.
		active, err := (federation.Keeper{Store: nativeStore{KVStore: ctx.MultiStore().GetKVStore(app.Key)}}).CompactStorageActive(ctx.BlockHeight())
		if err != nil {
			return ctx, err
		}
		if active && ctx.ExecMode() == sdk.ExecModeFinalize {
			return ctx, nil
		}
		// Validate the full operation on an isolated cache during CheckTx.
		// Active proposal handlers execute ordered transitions on their own cache.
		// The message handler performs the only
		// committed transition, so a failed command cannot consume a member sequence.
		cache, write := ctx.CacheContext()
		_, err = app.Keeper(cache).Execute(raw, ctx.ChainID(), ctx.BlockHeight(), ctx.BlockTime())
		if err != nil {
			return ctx, err
		}
		// CheckTx and ReCheck keep the effect in the check state, so a second
		// command with the same sequence is refused before it reaches the
		// mempool, and one member's pending commands stay bounded.
		if ctx.ExecMode() == sdk.ExecModeCheck || ctx.ExecMode() == sdk.ExecModeReCheck {
			member, err := envelopeMember(raw)
			if err != nil {
				return ctx, err
			}
			if app.Keeper(cache).QuotaCount(member, ctx.BlockHeight()) > MaxPendingPerSender {
				return ctx, errors.New("sender has too many pending commands")
			}
			write()
		}
		return ctx, nil
	})
	base.SetBeginBlocker(func(ctx sdk.Context) (sdk.BeginBlock, error) {
		// A scheduled upgrade runs (or halts an unprepared binary) first.
		if err := app.applyUpgrade(ctx); err != nil {
			return sdk.BeginBlock{}, err
		}
		// Capture end-H state before any H+1 mutation. Header AppHash authenticates H.
		if err := app.Keeper(ctx).CaptureDividendSnapshots(ctx.ChainID(), ctx.BlockHeight(), ctx.BlockHeader().AppHash); err != nil {
			return sdk.BeginBlock{}, err
		}
		ids, err := app.Keeper(ctx).ExpireKPIs(ctx.BlockHeight(), ctx.BlockTime())
		if err != nil {
			return sdk.BeginBlock{}, err
		}
		for _, id := range ids {
			ctx.EventManager().EmitEvent(sdk.NewEvent("uain.kpi_expiry", sdk.NewAttribute("task", id)))
		}
		return sdk.BeginBlock{Events: ctx.EventManager().ABCIEvents()}, nil
	})
	base.SetEndBlocker(func(ctx sdk.Context) (sdk.EndBlock, error) {
		changes, err := app.Keeper(ctx).ApplyValidatorUpdates(ctx.BlockHeight())
		if err != nil {
			return sdk.EndBlock{}, err
		}
		updates := make([]abci.ValidatorUpdate, 0, len(changes))
		for _, v := range changes {
			key, err := federation.ValidatorPubKey(v)
			if err != nil {
				return sdk.EndBlock{}, err
			}
			updates = append(updates, abci.Ed25519ValidatorUpdate(key, v.Power))
			ctx.EventManager().EmitEvent(sdk.NewEvent("uain.validator_update", sdk.NewAttribute("address", v.Address), sdk.NewAttribute("power", fmt.Sprint(v.Power))))
		}
		return sdk.EndBlock{ValidatorUpdates: updates, Events: ctx.EventManager().ABCIEvents()}, nil
	})
	if err := app.LoadLatestVersion(); err != nil {
		return nil, err
	}
	return app, nil
}
func envelopeMember(raw []byte) (string, error) {
	var e federation.Envelope
	if err := federation.Decode(raw, &e); err != nil {
		return "", err
	}
	return e.Command.Member, nil
}

func genesisValidators(in []abci.ValidatorUpdate) ([]federation.GenesisValidator, error) {
	out := make([]federation.GenesisValidator, 0, len(in))
	for _, v := range in {
		if v.PubKey.GetEd25519() == nil {
			return nil, errors.New("only Ed25519 validators are supported")
		}
		out = append(out, federation.GenesisValidator{PubKey: base64.StdEncoding.EncodeToString(v.PubKey.GetEd25519()), Power: v.Power})
	}
	return out, nil
}

func (a *App) Keeper(ctx sdk.Context) federation.Keeper {
	return federation.Keeper{Store: nativeStore{KVStore: ctx.KVStore(a.Key), policyStore: ctx.MultiStore().GetKVStore(a.Key), privateProofMeter: ctx.GasMeter()}}
}

type nativeStore struct {
	storetypes.KVStore
	policyStore       storetypes.KVStore
	privateProofMeter storetypes.GasMeter
}

// Dividend gates use unmetered prospective markers so historical transactions
// do not acquire a new gas charge while this policy/tracking remains absent.
func (s nativeStore) DividendPolicyMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("dividend_activation"))
	}
	return s.Get([]byte("dividend_activation"))
}

// The absent registry marker must not charge historical licence transitions.
func (s nativeStore) DividendOwnerTracking() bool {
	store := s.KVStore
	if s.policyStore != nil {
		store = s.policyStore
	}
	return store.Get([]byte("dividend_owner1/count")) != nil
}

func (s nativeStore) DividendSpentTracking() bool {
	store := s.KVStore
	if s.policyStore != nil {
		store = s.policyStore
	}
	return store.Get([]byte("dividend_spent_state")) != nil || store.Get([]byte("dividend_spent_rebuild")) != nil
}

func (s nativeStore) PrivatePolicyMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("private_activation"))
	}
	return s.Get([]byte("private_activation"))
}

func (s nativeStore) PrivateProofGas(amount uint64) {
	if s.privateProofMeter == nil {
		panic("missing private proof gas meter")
	}
	s.privateProofMeter.ConsumeGas(amount, "Orchard proof and bounded tree hashing")
}

// Only the fixed prospective marker is available without transaction gas.
// Adding a feature must not add gas to replayed pre-activation operations.
func (s nativeStore) StoragePolicyMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("storage_activation"))
	}
	return s.Get([]byte("storage_activation"))
}

func (s nativeStore) OperatorRewardMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("operator_reward_activation"))
	}
	return s.Get([]byte("operator_reward_activation"))
}

// Central earning must add no gas to replayed pre-activation Coin quotes.
func (s nativeStore) CentralEarningMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("central_earning_activation"))
	}
	return s.Get([]byte("central_earning_activation"))
}

// The S6 evidence window must add no gas to replayed pre-activation central commands.
func (s nativeStore) CentralEvidenceMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("central_evidence_activation"))
	}
	return s.Get([]byte("central_evidence_activation"))
}

// Central hardening must add no gas to replayed pre-activation central commands.
func (s nativeStore) CentralHardeningMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("central_hardening_activation"))
	}
	return s.Get([]byte("central_hardening_activation"))
}

// Consensus v2 must add no gas to replayed pre-activation transactions.
func (s nativeStore) ConsensusV2Marker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("consensus_v2_activation"))
	}
	return s.Get([]byte("consensus_v2_activation"))
}

// KarmaPolicyV2 must add no gas to replayed pre-activation Karma and award commands.
func (s nativeStore) KarmaPolicyMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("karma_policy_activation"))
	}
	return s.Get([]byte("karma_policy_activation"))
}

// Central task states must add no gas to replayed pre-activation central commands.
func (s nativeStore) CentralTaskStatesMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("central_task_states_activation"))
	}
	return s.Get([]byte("central_task_states_activation"))
}

func (s nativeStore) ArbitrationMarker() []byte {
	if s.policyStore != nil {
		return s.policyStore.Get([]byte("arbitration_activation"))
	}
	return s.Get([]byte("arbitration_activation"))
}

func (s nativeStore) Last(start, end []byte) (out *federation.Entry, err error) {
	iterator := s.ReverseIterator(start, end)
	defer func() {
		if e := iterator.Close(); err == nil {
			err = e
		}
	}()
	if iterator.Valid() {
		out = &federation.Entry{Key: bytes.Clone(iterator.Key()), Value: bytes.Clone(iterator.Value())}
	}
	return out, nil
}

func (s nativeStore) Range(start, end []byte, limit int) (out []federation.Entry, err error) {
	iterator := s.Iterator(start, end)
	defer func() {
		if closeErr := iterator.Close(); err == nil {
			err = closeErr
		}
	}()
	out = []federation.Entry{}
	for ; iterator.Valid() && len(out) < limit; iterator.Next() {
		out = append(out, federation.Entry{Key: bytes.Clone(iterator.Key()), Value: bytes.Clone(iterator.Value())})
	}
	// SDK cache iterators use Error() as assertValid: normal exhaustion returns
	// "invalid cacheMergeIterator". Valid() controls traversal; Close() reports
	// resource-release errors. Calling Error() after exhaustion halts every block.
	return out, nil
}

type messageServer struct {
	types.UnimplementedMsgServer
	app *App
}

func (s messageServer) Execute(goCtx context.Context, msg *types.MsgExecute) (*types.MsgExecuteResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	subject, err := s.app.Keeper(ctx).Execute(msg.Envelope, ctx.ChainID(), ctx.BlockHeight(), ctx.BlockTime())
	if err != nil {
		return nil, err
	}
	ctx.EventManager().EmitEvent(sdk.NewEvent("uain.federation", sdk.NewAttribute("subject", subject)))
	return &types.MsgExecuteResponse{Subject: subject}, nil
}

type parameterStore struct{ key *storetypes.KVStoreKey }

func (p parameterStore) Get(goCtx context.Context) (cmtproto.ConsensusParams, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)
	var v cmtproto.ConsensusParams
	b := ctx.KVStore(p.key).Get([]byte("params"))
	if b == nil {
		return v, errors.New("consensus parameters not initialized")
	}
	return v, gogoproto.Unmarshal(b, &v)
}
func (p parameterStore) Has(goCtx context.Context) (bool, error) {
	return sdk.UnwrapSDKContext(goCtx).KVStore(p.key).Has([]byte("params")), nil
}
func (p parameterStore) Set(goCtx context.Context, v cmtproto.ConsensusParams) error {
	b, err := gogoproto.Marshal(&v)
	if err != nil {
		return err
	}
	sdk.UnwrapSDKContext(goCtx).KVStore(p.key).Set([]byte("params"), b)
	return nil
}
