#!/usr/bin/env bash
# No-install send acceptance on a throwaway devnet (uain-app-1, resource
# limited). Builds the Orchard tools and a private-enabled node from this
# checkout, then runs chain/scripts/server-send-network-smoke.mjs and the
# existing coin-boundary smoke as a regression check of the coin wallet.
# Only fictional keys are created; no production endpoint or key is used.
#
#   ops/remote-test/server-send.sh [checkout]      prints the unit and log paths
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
DEST=$(ssh "$HOST" 'mkdir -p /opt/uain-test; mktemp -d /opt/uain-test/server-send-XXXXXXXX')
[[ "$DEST" =~ ^/opt/uain-test/server-send-[a-zA-Z0-9]+$ ]] || exit 2
ssh "$HOST" "mkdir -p '$DEST/chain' '$DEST/apps/baink'"
rsync -a --exclude /bin --exclude reports --exclude networks --exclude releases \
 --exclude target --exclude node_modules --exclude '.env*' "$SRC/chain/" "$HOST:$DEST/chain/"
for dir in server web shared review-broker; do
 rsync -a --exclude node_modules --exclude '*.test.mjs' --exclude '.env*' "$SRC/apps/baink/$dir/" "$HOST:$DEST/apps/baink/$dir/"
done
rsync -a "$SRC/apps/baink/package.json" "$HOST:$DEST/apps/baink/package.json"
ssh "$HOST" "mkdir -p '$DEST/ops/chain'"
rsync -a "$SRC/ops/chain/private-rpc-gateway.mjs" "$HOST:$DEST/ops/chain/"
ssh "$HOST" bash -s -- "$DEST" <<'REMOTE'
set -euo pipefail
DEST=$1
cat > "$DEST/run.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
ROOT=$PWD
exec > "$ROOT/checks.log" 2>&1
trap 'code=$?; printf "%s\n" "$code" > "$ROOT/exit-code"; exit "$code"' EXIT
exec 9>/opt/uain-test/private-exchange.lock
flock -w 3600 9 || { echo 'A private exchange qualification is still running'; exit 1; }
export GOMAXPROCS=2 GOTOOLCHAIN=local
export GOCACHE=/opt/uain-test/native-go-build-cache GOPATH=/opt/uain-test/native-go-module-cache
export RUSTUP_HOME=/opt/uain-review-runtime/uain-rust/rustup CARGO_HOME=/opt/uain-review-runtime/uain-rust/cargo
export CARGO_TARGET_DIR=/opt/uain-test/server-send-cargo-target
export PATH="$CARGO_HOME/bin:/opt/uain-review-runtime/go1.27.1/bin:/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin:/usr/bin:/bin"
cd chain/private-exchange
# Other files' diffs are release-pinned sources (ops/ci/rustfmt-check.py); only ours must be clean.
if cargo +1.89.0 fmt -- --check 2>&1 | grep -A12 'uain-coin-wallet.rs'; then echo RUSTFMT_FAILED_COIN_WALLET; exit 1; fi
cargo +1.89.0 build --release --locked -j 2
# The Go cgo link expects the static library at the default target path.
rm -rf target && ln -s "$CARGO_TARGET_DIR" target
cd ../private-dividend
CARGO_TARGET_DIR=/opt/uain-test/server-send-dividend-target cargo +1.89.0 build --release --locked -j 2 --features public-hash-ffi
rm -rf target && ln -s /opt/uain-test/server-send-dividend-target target
cd ..
T=$CARGO_TARGET_DIR/release
go build -tags orchard -p 2 -o bin/uain-private-state ./cmd/uain-private-state
go build -tags orchard -p 2 -o bin/uaind ./cmd/uaind
go build -p 2 -o bin/uain-proof ./cmd/uain-proof
node --test client/note-scan.test.mjs client/coin-boundary.test.mjs
echo '== server send smoke'
node scripts/server-send-network-smoke.mjs bin/uaind "$T/uain-coin-wallet" bin/uain-private-state "$T/uain-note-source"
echo '== coin boundary smoke (regression)'
node scripts/coin-boundary-network-smoke.mjs bin/uaind bin/uain-proof bin/uain-private-state "$T/uain-coin-wallet" "$T/uain-private-wallet"
sha256sum bin/uaind "$T/uain-coin-wallet" "$T/uain-note-source"
echo SERVER_SEND_CHECKS_OK
RUN
chmod 700 "$DEST/run.sh"
UNIT=$(basename "$DEST")
# Branch code runs here as root on the production host: the unit cannot gain
# privileges, see the custody, k3s, kubelet, runner or Docker credentials, or
# keep the capabilities that could undo those masks (security review IN-1;
# moving this suite into uain-ci-run is the full fix).
systemd-run --unit="$UNIT" --property=WorkingDirectory="$DEST" \
 --property=NoNewPrivileges=yes \
 --property='InaccessiblePaths=-/etc/uain-custody -/var/lib/uain-custody -/opt/uain-custody -/etc/uain-failover -/etc/rancher -/var/lib/rancher -/var/lib/kubelet -/run/k3s -/run/containerd -/root/.ssh -/root/.kube -/home/runner -/opt/actions-runner -/run/docker.sock' \
 --property='CapabilityBoundingSet=~CAP_SYS_ADMIN CAP_SYS_PTRACE CAP_SYS_MODULE CAP_SYS_RAWIO CAP_SYS_BOOT CAP_NET_ADMIN CAP_NET_RAW CAP_MKNOD' \
 --property=MemoryMax=6G --property=CPUQuota=200% --property=TasksMax=512 \
 --property=PrivateTmp=yes --property=RuntimeMaxSec=5400 --property=KillMode=control-group "$DEST/run.sh"
printf 'unit: %s\nlogs: %s/checks.log\nexit status: %s/exit-code\n' "$UNIT" "$DEST" "$DEST"
REMOTE
