#!/usr/bin/env bash
# Native financial fixture on the pinned daemon (apps/baink/test/native-financial-e2e.test.mjs):
# two real nodes on a fictional genesis, signed BAINK HTTP earning, prospective pricing, frozen
# novelty, restart receipts and the earning-recovery stage. The fixture checks the daemon and
# reader against its own TOOL_PINS; this runner copies them read-only from the host's reviewed
# release paths. One throwaway, resource-limited container with no network on the test host;
# fictional identities only; no running service, production key or chain is touched.
# Trade payments qualify separately (services/project-organizations/ops/qualify-native-trade.sh).
#
# Usage: apps/baink/ops/qualify-native-financial.sh [checkout]
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
IMAGE=${UAIN_ORGS_E2E_IMAGE:-baink-financial-qualification:20261104}
DAEMON_PIN=${UAIN_FINANCIAL_DAEMON_PIN:-b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024}
READER_PIN=136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$DAEMON_PIN" =~ ^[a-f0-9]{64}$ ]] || { echo "bad daemon pin"; exit 2; }
DEST=$(ssh "$HOST" "mkdir -p /opt/uain-test && mktemp -d /opt/uain-test/baink-financial-$STAMP-XXXX")
[[ "$DEST" =~ ^/opt/uain-test/baink-financial-[0-9TZ]+-[A-Za-z0-9]+$ ]] || { echo "unexpected destination $DEST"; exit 2; }
echo "destination: $HOST:$DEST"
ssh "$HOST" "mkdir -p '$DEST/source/apps' '$DEST/source/chain' '$DEST/source/ops' '$DEST/tools' '$DEST/evidence'"
rsync -a --exclude node_modules --exclude '.env*' "$SRC/apps/baink/" "$HOST:$DEST/source/apps/baink/"
rsync -a --exclude node_modules --exclude '.env*' "$SRC/chain/client/" "$HOST:$DEST/source/chain/client/"
rsync -a "$SRC/ops/ci/" "$HOST:$DEST/source/ops/ci/"
ssh "$HOST" bash -s -- "$DEST" "$IMAGE" "$DAEMON_PIN" "$READER_PIN" <<'REMOTE'
set -euo pipefail
DEST=$1 IMAGE=$2 DAEMON_PIN=$3 READER_PIN=$4
cp "/opt/uain-chain/releases/$DAEMON_PIN/uaind" "$DEST/tools/uaind"
cp "/opt/uain-chain/tools/state/$READER_PIN/uain-state" "$DEST/tools/uain-state"
chmod 555 "$DEST"/tools/*
printf '%s  %s\n%s  %s\n' "$DAEMON_PIN" "$DEST/tools/uaind" "$READER_PIN" "$DEST/tools/uain-state" | sha256sum --check | tee "$DEST/evidence/tool-pins.txt"
"$DEST/tools/uaind" version > "$DEST/evidence/uaind-version.txt" 2>&1 || true
NAME="baink-financial-$(basename "$DEST")"
docker run -d --init --name "$NAME" --label uain.fixture=baink-native-financial \
  --network none --read-only --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  --security-opt no-new-privileges --tmpfs /tmp:rw,exec,nosuid,size=1g,mode=1777 \
  -v "$DEST/source:/source:ro" -v "$DEST/tools:/tools:ro" \
  -e UAIN_FINANCIAL_E2E=1 -e UAIN_FINANCIAL_EARNING_RECOVERY_E2E=1 -e UAIN_REQUIRE_E2E=1 -e HOME=/tmp -w /source/apps/baink "$IMAGE" \
  timeout 1500 node --test --test-reporter=tap test/native-financial-e2e.test.mjs > /dev/null
code=$(docker wait "$NAME")
docker logs "$NAME" > "$DEST/evidence/stage.tap" 2>&1 || true
docker rm "$NAME" > /dev/null
rm -rf "$DEST/source" "$DEST/tools"
echo "$code" > "$DEST/evidence/exit-code"
echo "exit code: $code"
grep -E '^(not )?ok |^# (pass|fail|skipped|duration_ms)' "$DEST/evidence/stage.tap" || true
grep -m1 -A30 'not ok' "$DEST/evidence/stage.tap" | head -40 || true
printf 'evidence: %s/evidence\n' "$DEST"
exit "$code"
REMOTE
