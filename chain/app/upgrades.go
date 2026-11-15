package app

import (
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"github.com/uain-org/uain/chain/federation"
)

// UpgradeHandler migrates state when a guardian-quorum upgrade_schedule plan
// reaches its height. It runs once, in BeginBlock, on the new binary.
type UpgradeHandler func(ctx sdk.Context, k federation.Keeper, plan federation.UpgradePlan) error

// RegisteredUpgrades lists the handlers this binary carries. A release that
// changes consensus rules adds its named handler here, ships the binary, and
// the guardians schedule the same name at a height every operator can meet.
// Old handlers stay registered so a node replaying history can pass them.
func RegisteredUpgrades() map[string]UpgradeHandler {
	return map[string]UpgradeHandler{
		CentralTaskStatesUpgrade: centralTaskStatesUpgrade,
	}
}

// CentralTaskStatesUpgrade names the uaind 0.4.2 plan (docs/chain/task-states-upgrade-2026-11-10.md).
// It is used only once consensus v2 is active, when upgrade_schedule exists; before
// that the release follows the stopped-node path and no plan is scheduled.
const CentralTaskStatesUpgrade = "uaind-0-4-2-central-task-states"

// centralTaskStatesUpgrade migrates nothing: every central-task-states-v1 rule stays
// inert until a guardian records its activation, so the new binary executes the
// plan height and every later block exactly as 0.4.1 would until then. It only
// refuses a store whose policy marker already exists, which would mean a binary
// carrying the rules ran before the plan height.
func centralTaskStatesUpgrade(ctx sdk.Context, k federation.Keeper, plan federation.UpgradePlan) error {
	if k.CentralTaskStatesRecorded() {
		return fmt.Errorf("central task states recorded before upgrade %q", plan.Name)
	}
	return nil
}

// applyUpgrade halts a binary that lacks the scheduled handler at the plan
// height (the operator swaps binaries and restarts), and refuses to run a
// binary that carries the pending handler before its height, which would
// otherwise diverge from nodes still on the old binary.
func (a *App) applyUpgrade(ctx sdk.Context) error {
	k := a.Keeper(ctx)
	plan, err := k.PendingUpgrade()
	if err != nil || plan == nil {
		return err
	}
	handler, ok := a.upgrades[plan.Name]
	switch {
	case ctx.BlockHeight() < plan.Height:
		if ok {
			panic(fmt.Sprintf("BINARY UPDATED BEFORE TRIGGER: upgrade %q is scheduled at height %d", plan.Name, plan.Height))
		}
		return nil
	case ctx.BlockHeight() > plan.Height:
		return fmt.Errorf("upgrade %q missed its height %d", plan.Name, plan.Height)
	case !ok:
		panic(fmt.Sprintf("UPGRADE %q NEEDED at height %d: install the release carrying it and restart", plan.Name, plan.Height))
	}
	if err = handler(ctx, k, *plan); err != nil {
		return fmt.Errorf("upgrade %q failed: %w", plan.Name, err)
	}
	ctx.EventManager().EmitEvent(sdk.NewEvent("uain.upgrade", sdk.NewAttribute("name", plan.Name)))
	return k.CompleteUpgrade(*plan, ctx.BlockHeight())
}
