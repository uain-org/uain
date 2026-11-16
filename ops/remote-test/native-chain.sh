#!/usr/bin/env bash
# Native chain checks run on the app server, in a separate resource-limited
# systemd service. Only chain source and chain operations are transferred.
# Usage: ops/remote-test/native-chain.sh [--suite all|proposals|operators] [checkout]
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
SUITE=all
if [ "${1:-}" = --suite ]; then SUITE=${2:?missing suite}; shift 2; fi
case "$SUITE" in all|proposals|operators) ;; *) echo 'unknown native suite'; exit 2 ;; esac
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
DEST=$(ssh "$HOST" 'mkdir -p /opt/uain-test; mktemp -d /opt/uain-test/native-chain-XXXXXXXX')
[[ "$DEST" =~ ^/opt/uain-test/native-chain-[a-zA-Z0-9]+$ ]] || exit 2
ssh "$HOST" "mkdir -p '$DEST/chain' '$DEST/ops/chain'"
rsync -a --exclude /bin --exclude reports --exclude networks --exclude releases \
  --exclude target --exclude node_modules --exclude '.env*' "$SRC/chain/" "$HOST:$DEST/chain/"
rsync -a --exclude '__pycache__' "$SRC/ops/chain/" "$HOST:$DEST/ops/chain/"
# ops/chain/test_native_deploy.py drives the production native overlay script,
# which reads its sibling manifests; without them the test exits 127.
ssh "$HOST" "mkdir -p '$DEST/deploy/k8s/production'"
rsync -a "$SRC/deploy/k8s/production/" "$HOST:$DEST/deploy/k8s/production/"
ssh "$HOST" bash -s -- "$DEST" "$SUITE" <<'REMOTE'
set -euo pipefail
DEST=$1
SUITE=$2
cat > "$DEST/run.sh" <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
NATIVE_ROOT=$PWD
exec > "$NATIVE_ROOT/checks.log" 2>&1
trap 'code=$?; printf "%s\n" "$code" > "$NATIVE_ROOT/exit-code"; exit "$code"' EXIT
exec 9>/opt/uain-test/native-chain.lock
flock -n 9 || { echo 'Another native chain rehearsal is running'; exit 1; }
export GOMAXPROCS=4 GOTOOLCHAIN=local
export GOCACHE=/opt/uain-test/native-go-build-cache
export GOPATH=/opt/uain-test/native-go-module-cache
export PATH=/opt/uain-review-runtime/go1.27.1/bin:/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin:/usr/bin:/bin
if [ ! -x /opt/uain-review-runtime/go1.27.1/bin/go ]; then
  curl --fail --location --retry 3 --output go.tar.gz https://go.dev/dl/go1.27.1.linux-amd64.tar.gz
  printf '%s  go.tar.gz\n' 63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445 | sha256sum --check
  mkdir runtime
  tar -xzf go.tar.gz -C runtime
  mv runtime/go /opt/uain-review-runtime/go1.27.1
  rm go.tar.gz
fi
cd chain
go version
node --version
test "$(awk '/^go / {print $2}' go.mod)" = 1.27.1
python3 - <<'MANIFEST'
import hashlib, json
from pathlib import Path
rows = [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in sorted(Path('.').rglob('*')) if p.is_file()
        and (p.suffix in ('.go', '.mjs', '.proto') or p.name in ('go.mod', 'go.sum'))
        and 'bin' not in p.parts]
Path('../source-manifest.json').write_text(json.dumps(rows, indent=2) + '\n')
MANIFEST
if [ "${1:-all}" = proposals ]; then
  go test -race -v -p 4 ./app -run Proposal
  go vet -p 4 ./app
  echo NATIVE_CHAIN_PROPOSALS_OK
  exit 0
fi
if [ "${1:-all}" = operators ]; then
  go test -race -v -p 4 ./federation ./app -run 'Operator|ResearchStanding|IndependentOperators|PendingFutureWork'
  go vet -p 4 ./federation ./app
  echo NATIVE_CHAIN_OPERATORS_OK
  exit 0
fi
npm ci --include=dev --ignore-scripts --no-audit --no-fund
# chain/app alone takes about 602 s under -race, over go test's 600 s default.
go test -race -timeout 30m -v -p 4 ./...
go vet -p 4 ./...
node --test client/*.test.mjs
go build -p 4 -o bin/uaind ./cmd/uaind
export UAIN_ALLOW_NON_ORCHARD=1
go build -p 4 -o bin/uain-proof ./cmd/uain-proof
mkdir -m 700 "$NATIVE_ROOT/fixtures"
TMPDIR="$NATIVE_ROOT/fixtures" UAIN_SMOKE_COMPACT=1 UAIN_SMOKE_CENSUS=1 UAIN_SMOKE_HISTORY=1 UAIN_SMOKE_ARBITRATION=1 node scripts/smoke.mjs bin/uaind
TMPDIR="$NATIVE_ROOT/fixtures" UAIN_SMOKE_COMPACT=1 UAIN_SMOKE_CENSUS=1 UAIN_SMOKE_HISTORY=1 UAIN_SMOKE_ARBITRATION=1 UAIN_SMOKE_PORT=28757 node scripts/smoke.mjs bin/uaind /opt/uain-chain/releases/8d37d5608076296a125fd0606b5863c3b71c72a57f966eaeeeb24647ce73bc5d/uaind
bash -n ../ops/chain/install-shadow-node.sh
bash -n ../ops/chain/upgrade-shadow-node.sh
node --check ../ops/chain/verify-shadow.mjs
python3 -m unittest discover -s ../ops/chain -p 'test_*.py'
sha256sum bin/uaind bin/uain-proof
echo NATIVE_CHAIN_CHECKS_OK
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
  --property=MemoryMax=6G --property=CPUQuota=400% --property=TasksMax=512 \
  --property=PrivateTmp=yes --property=RuntimeMaxSec=3600 \
  --property=KillMode=control-group "$DEST/run.sh" "$SUITE"
printf 'unit: %s\nlogs: %s/checks.log\nexit status: %s/exit-code\n' "$UNIT" "$DEST" "$DEST"
REMOTE
