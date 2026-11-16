#!/usr/bin/env bash
# Four-validator devnet acceptance on the app server (9 November 2026).
# Builds the Orchard library and orchard-tagged binaries from the checkout,
# then runs chain/scripts/devnet-e2e.mjs with every validator in its own
# transient systemd scope (separate cgroup, 1 GiB, one CPU). Fixture keys only.
# Usage: ops/remote-test/devnet-e2e.sh [checkout]
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
DEST=$(ssh "$HOST" 'mkdir -p /opt/uain-test; mktemp -d /opt/uain-test/devnet-e2e-XXXXXXXX')
[[ "$DEST" =~ ^/opt/uain-test/devnet-e2e-[a-zA-Z0-9]+$ ]] || exit 2
ssh "$HOST" "mkdir -p '$DEST/chain'"
rsync -a --exclude /bin --exclude reports --exclude networks --exclude releases \
  --exclude target --exclude node_modules --exclude '.env*' "$SRC/chain/" "$HOST:$DEST/chain/"
ssh "$HOST" bash -s -- "$DEST" <<'REMOTE'
set -euo pipefail
DEST=$1
cat > "$DEST/run.sh" <<'RUN'
set -euo pipefail
ROOT=$PWD
exec > "$ROOT/checks.log" 2>&1
trap 'code=$?; printf "%s\n" "$code" > "$ROOT/exit-code"; exit "$code"' EXIT
exec 9>/opt/uain-test/devnet-e2e.lock
flock -n 9 || { echo 'A devnet acceptance is already running'; exit 1; }
export GOMAXPROCS=4 GOTOOLCHAIN=local
export GOCACHE=/opt/uain-test/native-go-build-cache GOPATH=/opt/uain-test/native-go-module-cache
export RUSTUP_HOME=/opt/uain-review-runtime/uain-rust/rustup CARGO_HOME=/opt/uain-review-runtime/uain-rust/cargo
export CARGO_TARGET_DIR=/opt/uain-test/devnet-cargo-target
export PATH="$CARGO_HOME/bin:/opt/uain-review-runtime/go1.27.1/bin:/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin:/usr/bin:/bin"
cd chain/private-exchange
cargo +1.89.0 build --release --locked -j 4
mkdir -p target/release
cp "$CARGO_TARGET_DIR"/release/libuain_private_exchange.* "$CARGO_TARGET_DIR"/release/uain-coin-wallet "$CARGO_TARGET_DIR"/release/uain-private-wallet target/release/
cd ../private-dividend
CARGO_TARGET_DIR=/opt/uain-test/devnet-cargo-target-dividend cargo +1.89.0 build --release --locked -j 4 --features public-hash-ffi
mkdir -p target/release
cp /opt/uain-test/devnet-cargo-target-dividend/release/libuain_private_dividend.* target/release/
cd ..
npm ci --include=dev --ignore-scripts --no-audit --no-fund
go build -tags orchard -p 4 -o bin/uaind ./cmd/uaind
go build -tags orchard -p 4 -o bin/uain-private-state ./cmd/uain-private-state
go build -p 4 -o bin/uain-state ./cmd/uain-state
bin/uaind version
sha256sum bin/uaind bin/uain-state bin/uain-private-state
mkdir -m 700 "$ROOT/fixtures"
TMPDIR="$ROOT/fixtures" UAIN_DEVNET_ISOLATE=systemd node scripts/devnet-e2e.mjs bin/uaind bin/uain-state bin/uain-private-state private-exchange/target/release/uain-coin-wallet private-exchange/target/release/uain-private-wallet
echo DEVNET_E2E_CHECKS_OK
RUN
chmod 700 "$DEST/run.sh"
UNIT=$(basename "$DEST")
# Branch code runs here as root on the production host: the unit cannot gain
# privileges, see the custody, k3s, kubelet, runner or Docker credentials, or
# keep the capabilities that could undo those masks (security review IN-1;
# moving this suite into uain-ci-run is the full fix). The validators'
# `systemd-run --scope` keeps this unit's mounts, bounding set and no_new_privs.
systemd-run --unit="$UNIT" --property=WorkingDirectory="$DEST" \
  --property=NoNewPrivileges=yes \
  --property='InaccessiblePaths=-/etc/uain-custody -/var/lib/uain-custody -/opt/uain-custody -/etc/uain-failover -/etc/rancher -/var/lib/rancher -/var/lib/kubelet -/run/k3s -/run/containerd -/root/.ssh -/root/.kube -/home/runner -/opt/actions-runner -/run/docker.sock' \
  --property='CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_SYS_MODULE CAP_SYS_RAWIO CAP_SYS_BOOT CAP_NET_ADMIN CAP_NET_RAW CAP_MKNOD' \
  --property=MemoryMax=8G --property=CPUQuota=600% --property=TasksMax=2048 \
  --property=RuntimeMaxSec=5400 --property=KillMode=control-group bash "$DEST/run.sh"
printf 'unit: %s\nlogs: %s/checks.log\nexit status: %s/exit-code\n' "$UNIT" "$DEST" "$DEST"
REMOTE
