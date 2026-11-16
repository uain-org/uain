#!/usr/bin/env bash
# Explicit qualification; never accepts a skipped reset/database fixture.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${UAIN_TEST_PG:?isolated PostgreSQL qualification required}"
[ "${UAIN_TEST_VECTOR:-}" = 1 ] || { echo 'pgvector qualification required' >&2; exit 2; }
cd "$repo/chain"
mkdir -p bin
go build -p 2 -o bin/uaind ./cmd/uaind
export UAIN_ALLOW_NON_ORCHARD=1
go build -p 2 -o bin/uain-state ./cmd/uain-state
go build -p 2 -o bin/uain-reset-checkpoint ./cmd/uain-reset-checkpoint
export UAIN_NATIVE_CHAIN_BINARY="$PWD/bin/uaind" UAIN_NATIVE_STATE_BINARY="$PWD/bin/uain-state"
export UAIN_RESET_CHECKPOINT_BINARY="$PWD/bin/uain-reset-checkpoint" UAIN_NATIVE_RESET_E2E=1
cd "$repo/services/pilot"
node --test test/native-reset-baseline.test.mjs test/native-replica-recovery.test.mjs test/native-reset-e2e.test.mjs
