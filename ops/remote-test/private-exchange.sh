#!/usr/bin/env bash
# Resource-limited private exchange acceptance. Transfers source, never member keys.
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
DEST=$(ssh "$HOST" 'mkdir -p /opt/uain-test; mktemp -d /opt/uain-test/private-exchange-XXXXXXXX')
[[ "$DEST" =~ ^/opt/uain-test/private-exchange-[a-zA-Z0-9]+$ ]] || exit 2
ssh "$HOST" "mkdir -p '$DEST/chain'"
rsync -a --exclude /bin --exclude reports --exclude networks --exclude releases \
 --exclude target --exclude node_modules --exclude '.env*' "$SRC/chain/" "$HOST:$DEST/chain/"
ssh "$HOST" "mkdir -p '$DEST/ops/chain'"
rsync -a "$SRC/ops/chain/private-rpc-gateway.mjs" "$SRC/ops/chain/private-rpc-gateway.test.mjs" "$HOST:$DEST/ops/chain/"
# The pin-aware rustfmt check (byte-pinned holder tool sources stay unformatted).
ssh "$HOST" "mkdir -p '$DEST/ops/ci'"
rsync -a "$SRC/ops/ci/rustfmt-check.py" "$HOST:$DEST/ops/ci/"
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
flock -n 9 || { echo 'A private exchange qualification is already running'; exit 1; }
export GOMAXPROCS=2 GOTOOLCHAIN=local
export GOCACHE=/opt/uain-test/native-go-build-cache GOPATH=/opt/uain-test/native-go-module-cache
export RUSTUP_HOME=/opt/uain-review-runtime/uain-rust/rustup CARGO_HOME=/opt/uain-review-runtime/uain-rust/cargo
export PATH="$CARGO_HOME/bin:/opt/uain-review-runtime/go1.27.1/bin:/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin:/usr/bin:/bin"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
 mkdir -p /opt/uain-review-runtime/uain-rust
 curl --fail --location --retry 3 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init -o rustup-init
 curl --fail --location --retry 3 https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init.sha256 -o rustup-init.sha256
 sha256sum --check rustup-init.sha256
 chmod 700 rustup-init
 ./rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.89.0
fi
rustup toolchain install 1.89.0 --profile minimal
rustup component add rustfmt --toolchain 1.89.0
export UAIN_PUBLIC_FIXTURE_DIR="$ROOT/public-fixtures"
python3 - <<'MANIFEST'
import hashlib,json,pathlib
root=pathlib.Path('chain')
rows=[{'path':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and ('target' not in p.parts) and (p.suffix in ('.go','.rs','.mjs') or p.name in ('go.mod','go.sum','Cargo.toml','Cargo.lock'))]
pathlib.Path('source-manifest.json').write_text(json.dumps(rows,indent=2)+'\n')
MANIFEST
export RUSTUP_TOOLCHAIN=1.89.0
cd chain
# Same order as the private-exchange suite in ops/ci/container-suite.sh.
# Sources pinned byte-for-byte by chain/private-exchange/pins/*.release.json
# are accepted unformatted while they match their pin (rustfmt-check.py);
# reformatting them would break the qualified releases' provenance.
python3 -I -B ../ops/ci/rustfmt-check.py private-exchange/Cargo.toml
cargo build --manifest-path private-exchange/Cargo.toml --release --locked -j 2
cargo test --manifest-path private-exchange/Cargo.toml --release --locked -j 2 -- --nocapture
# The orchard Go build links libuain_private_dividend (chain/privatedividend
# cgo LDFLAGS), so it must exist with public-hash-ffi before any orchard build.
cargo fmt --manifest-path private-dividend/Cargo.toml -- --check
cargo build --manifest-path private-dividend/Cargo.toml --release --locked -j 2 --features public-hash-ffi
cargo test --manifest-path private-dividend/Cargo.toml --release --locked -j 2 -- --test-threads=1
UAIN_DIVIDEND_REGISTRATION_RECEIPT="$ROOT/chain/private-dividend/registration-public-fixtures" \
 cargo test --manifest-path private-dividend/Cargo.toml --release --locked -j 2 --features snapshot-prototype,public-hash-ffi -- --test-threads=1
node --test private-dividend/tests/snapshot-model.test.mjs
export UAIN_PRIVATE_STATE_BIN="$ROOT/chain/bin/uain-private-state" UAIN_PRIVATE_WALLET_BIN="$ROOT/chain/private-exchange/target/release/uain-private-wallet"
node --test client/private-review.test.mjs client/private-state.test.mjs client/coin-boundary.test.mjs client/private-workflow.test.mjs client/private-cli.test.mjs
node --test ../ops/chain/private-rpc-gateway.test.mjs
node scripts/private-exchange-smoke.mjs private-exchange/target/release/uain-private-wallet
go build -tags orchard -p 2 -o bin/uain-private-state ./cmd/uain-private-state
go build -p 2 -o bin/uain-peer-tunnel ./cmd/uain-peer-tunnel
go test -race -timeout 30m -v -p 2 ./...
go test -race -timeout 30m -tags orchard -v -p 2 ./...
go vet -tags orchard -p 2 ./...
go build -tags orchard -p 2 -o bin/uaind ./cmd/uaind
go build -p 2 -o bin/uain-proof ./cmd/uain-proof
node scripts/private-state-network-smoke.mjs bin/uaind bin/uain-private-state
node scripts/coin-network-smoke.mjs bin/uaind bin/uain-proof
node scripts/coin-boundary-network-smoke.mjs bin/uaind bin/uain-proof bin/uain-private-state private-exchange/target/release/uain-coin-wallet private-exchange/target/release/uain-private-wallet
sha256sum bin/uaind private-exchange/target/release/libuain_private_exchange.a private-exchange/target/release/uain-private-wallet
echo PRIVATE_EXCHANGE_CHECKS_OK
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
 --property=PrivateTmp=yes --property=RuntimeMaxSec=6600 --property=KillMode=control-group "$DEST/run.sh"
printf 'unit: %s\nlogs: %s/checks.log\nexit status: %s/exit-code\n' "$UNIT" "$DEST" "$DEST"
REMOTE
