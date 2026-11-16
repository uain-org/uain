#!/usr/bin/env bash
# This entire script and all tested code run inside the disposable sandbox.
set -euo pipefail
# Earlier suites must not manufacture caches rejected by privileged source loaders.
export PYTHONDONTWRITEBYTECODE=1
mkdir -p "$HOME" "$TMPDIR"
# Fixed sandbox path: npm installs rebuild once from a clean cache on corruption.
source /work/ops/ci/npm-cache.sh
suite=${1:?suite}; shard=${2:-0}
# Phase timings (10 November 2026): install (npm ci), build (go/cargo build,
# typecheck, site build) and test (everything else) are timed separately and
# summarised in one "== phases" line at exit, so a slow suite shows which part
# grew. Durations go to a file so commands run in subshells are counted too.
PHASES="$TMPDIR/uain-suite-phases.$$"; : > "$PHASES"; SUITE_STARTED=$SECONDS
timed() { # phase command...
 local phase=$1 start=$SECONDS code=0; shift
 "$@" || code=$?
 echo "$phase $((SECONDS - start))" >> "$PHASES"
 return "$code"
}
eval "untimed_$(declare -f npm_ci_rebuild)"
npm_ci_rebuild() { timed install untimed_npm_ci_rebuild "$@"; }
go() { if [ "${1:-}" = build ]; then timed build command go "$@"; else command go "$@"; fi; }
cargo() { if [ "${1:-}" = build ]; then timed build command cargo "$@"; else command cargo "$@"; fi; }
phase_summary() {
 awk -v total=$((SECONDS - SUITE_STARTED)) -v suite="$suite" '{s[$1]+=$2} END {i=s["install"]+0; b=s["build"]+0;
  printf "== phases (%s): install %ds, build %ds, test %ds, total %ds\n", suite, i, b, total-i-b, total}' "$PHASES" || true
 rm -f "$PHASES"
}
trap phase_summary EXIT
pilot_build() { npm_ci_rebuild --prefix services/pilot; timed build npm --prefix services/pilot run typecheck; timed build npm --prefix services/pilot run build; }
# Runs a node --test command, then lists every skipped test as a workflow
# warning. Real-chain tests skip with a stated reason (ops/ci/e2e-gate.mjs);
# the scheduled e2e workflow sets UAIN_REQUIRE_E2E=1 so they cannot skip there.
tested() { # label command...
 local label=$1 log code=0; shift; log=$(mktemp)
 "$@" 2>&1 | tee "$log" || code=$?
 { grep -E '# SKIP' "$log" || true; } | sed -E "s/^ *ok [0-9]+ - /::warning title=skipped ($label)::/"
 rm -f "$log"
 return "$code"
}
case "$suite" in
 ledger-publication)
  curl --fail --silent --show-error --retry 6 --retry-connrefused --retry-max-time 120 --connect-timeout 5 --max-time 15 --max-filesize 4096 "https://uain.global/api/ledger/roots/$UAIN_LEDGER_PUBLICATION_DATE" --output /cache/ledger-root.json
  python3 -I -B ops/ci/prepare-ledger-publication.py "$UAIN_LEDGER_PUBLICATION_DATE" /cache/ledger-root.json /work/.ci-ledger-publication
  ;;
 pilot)
  pilot_build
  cd services/pilot
  node --test --test-concurrency=1 --test-shard="$shard/3" test/*.test.mjs
  # The waitlist service is still deployed; its retired-from-default tests
  # (test/legacy) run once per pass, in the last shard.
  if [ "$shard" = 3 ]; then node --test --test-concurrency=1 test/legacy/*.test.mjs; fi
  ;;
 research)
  export UAIN_TEST_VECTOR=1
  pilot_build
  (cd services/pilot && node --test test/research.test.mjs)
  (cd services/retrieval && python3 -m unittest test_server.py)
  ;;
 reset)
  export UAIN_TEST_VECTOR=1 UAIN_RESET_LOCAL_PG=1
  pilot_build
  bash ops/reset/rehearse-ci.sh
  bash ops/reset/qualify-native.sh
  ;;
 others)
  # Routine on every PR and deploy since 9 November 2026 (tests.yml): BAINK,
  # the review services, organizations, fund manager and runner, then the
  # operations suites below.
  node ops/ci/test-globs-check.mjs apps/baink
  tested baink npm --prefix apps/baink test
  npm --prefix apps/baink run test:python
  tested central-reviewer node --test services/central-reviewer/test/*.test.mjs
  python3 -I -B services/central-reviewer/test/provider_fence_test.py
  tested organizations node --test services/project-organizations/test/*.test.mjs services/fund-manager/test/*.test.mjs
  # The runner's container tests need Docker, which the sandbox never has; they skip and are listed.
  tested runner node --test runner/test/*.test.mjs
  # Strict canonical signing (D-26): the language-neutral vectors in
  # fixtures/contracts and the fleet-attestation vector are checked here by
  # every JS consumer (BAINK, organizations, central reviewer above, and the
  # chain client) and by Python custody (test_contract_fixtures.py,
  # test_fleet_attestation.py in the custody loop below). Go's consumer
  # (chain/federation) runs in native-chain, nightly in e2e.yml.
  node --test chain/client/contract-fixtures.test.mjs
  node --test scripts/prepare-proposed-project-sites.test.mjs
  node --test press/press.test.mjs
  (cd contracts && npm_ci_rebuild && npm test)
  python3 -m unittest discover -s ops/node-backup -p 'test_*.py' -v
  python3 ops/chain/failover-test.py
  python3 ops/chain/failover-backup-test.py
  python3 -I -B ops/chain/proof-age-test.py
  python3 ops/chain/failover-install-test.py
  python3 -I -B ops/chain/upgrade-failover-profile-test.py
  python3 -I -B ops/chain/upgrade-failover-helper-test.py
  python3 -I -B ops/chain/install-native-runtime-test.py
  python3 -I -B ops/reset/test_upgrade.py
  # Every custody test file runs, each in its own interpreter, so a new one is
  # never missed. Only files needing operator-only modules are listed here.
  custody_outside_sandbox=' test_custody.py test_mainnet_wallets.py '  # pykeepass: KeePass custody host only
  for test in ops/custody/test_*.py; do
    name=${test##*/}
    if [[ $custody_outside_sandbox == *" $name "* ]]; then echo "custody: $name needs pykeepass; run it on the custody host"; continue; fi
    select=()
    # RealTrustedPathTest needs a writable root-owned /root; the sandbox root filesystem is read-only.
    if [[ $name == test_holder_release.py ]]; then select=(-k HolderReleaseTest); fi
    python3 -I -B -m unittest discover -s ops/custody -p "$name" ${select[@]+"${select[@]}"}
  done
  python3 -m unittest discover -s ops/evidence -p 'test_*.py'
  node --test ops/chain/native-rpc-transport.test.mjs
  # Release records, scope classifier, generated status and dev tooling (plans P2, P5, P10).
  python3 -I -B -m unittest discover -s ops/ci-scope -p 'test_*.py'
  # Monitoring probes and alert rules (standard library only; the promtool part
  # skips without PROMTOOL). A directory that is not on this branch yet is skipped.
  for dir in ops/monitoring ops/monitoring/host-probe ops/monitoring/chain-sync; do
    if [ -d "$dir" ]; then python3 -B -m unittest discover -s "$dir" -p 'test_*.py'; fi
  done
  # The pre-push check's pass inheritance (ops/check-inherit.sh; throwaway git repositories).
  bash ops/check-inherit.test.sh
  # Disk hygiene never removes a test root that production names (stand-ins for systemctl and docker).
  bash ops/host/uain-disk-hygiene.test.sh
  # The production deploy's rollout decision (deploy.yml, deploy-staging.yml).
  python3 -B -m unittest discover -s ops/ci -p 'test_rollout_wait.py'
  # The production deploy's "Apply the manifest" step: the manifest rendered
  # whole (render.py) and applied once (apply.sh), against a stand-in kubectl.
  # The sandbox has no kubectl, so the real `kubectl kustomize` cases skip
  # here; every deploy runs that render and its verify before it applies.
  python3 -I -B -m unittest discover -s deploy/k8s/production -p 'test_*.py'
  # Exploratory research code (research/; no image, no network).
  python3 -I -B -m unittest discover -s research/covering-29-7-3 -p 'test_*.py'
  node --test ops/ci-scope/*.test.mjs ops/docs/*.test.mjs ops/dev/*.test.mjs
  node ops/docs/render-status.mjs --check
  bash -n deploy/k8s/production/apply.sh
  bash -n deploy/k8s/production/prune-images.sh
  bash -n ops/node-backup/install.sh
  sh -n ops/node-backup/uain-node-backup
  ;;
 site)
  npm_ci_rebuild
  npm_ci_rebuild --prefix services/pilot
  timed build npx tsc --noEmit -p tsconfig.json
  timed build npm run build
  ;;
 native-chain)
  # Independent client-test oracles belong to chain, not the pilot installation.
  npm_ci_rebuild --prefix chain --include=dev --ignore-scripts --no-audit --no-fund
  python3 -m unittest discover -s ops/ci -p 'test_*.py'
  python3 ops/custody/test_native_migration.py
  python3 ops/custody/test_treasury.py
  cd chain
  go test -race -timeout 30m -p 2 ./...
  go vet -p 2 ./...
  node --test client/*.test.mjs migration/*.test.mjs
  node --test ../ops/chain/verify-wallet-sync.test.mjs ../ops/chain/verify-external-funding.test.mjs
  node --test scripts/private-client-process.test.mjs
  go build -p 2 -o bin/uaind ./cmd/uaind
  # Non-orchard fixture daemon: 0.4.0 refuses to start without this override.
  export UAIN_ALLOW_NON_ORCHARD=1
  go build -p 2 -o bin/uain-proof ./cmd/uain-proof
  go build -p 2 -o bin/uain-state ./cmd/uain-state
  go build -p 2 -o bin/uain-treasury-sign ./cmd/uain-treasury-sign
  UAIN_TEST_TREASURY_SIGNER="$PWD/bin/uain-treasury-sign" python3 ../ops/custody/test_treasury.py
  # client/federation-e2e.test.mjs left with the retired UAIN Client (09e1fe21); the BAINK pilot below runs a real node.
  # BAINK's real-chain project pilot on a throwaway consensus node. Required
  # here: a missing configuration fails instead of skipping (ops/ci/e2e-gate.mjs).
  UAIN_REQUIRE_E2E=1 UAIN_PROJECT_PILOT_E2E=1 UAIN_NATIVE_CHAIN_BINARY="$PWD/bin/uaind" UAIN_NATIVE_STATE_BINARY="$PWD/bin/uain-state" node --test ../apps/baink/test/native-project-pilot-e2e.test.mjs
  UAIN_SMOKE_COMPACT=1 UAIN_SMOKE_CENSUS=1 UAIN_SMOKE_HISTORY=1 UAIN_SMOKE_ARBITRATION=1 node scripts/smoke.mjs bin/uaind
  for script in install-shadow-node upgrade-shadow-node install-history-tools install-private-tools install-private-rpc install-wallet-node; do bash -n "../ops/chain/$script.sh"; done
  bash -n ../ops/remote-test/native-chain.sh
  bash -n ../ops/ci/container-suite.sh
  node --check ../ops/chain/verify-shadow.mjs
  node --test ../ops/chain/private-rpc-gateway.test.mjs
  python3 -m unittest discover -s ../ops/chain -p 'test_*.py'
  python3 ../ops/chain/failover-test.py
  python3 ../ops/chain/failover-backup-test.py
  python3 ../ops/chain/failover-install-test.py
  python3 -I -B ../ops/chain/upgrade-failover-profile-test.py
  python3 -I -B ../ops/chain/upgrade-failover-helper-test.py
  python3 -I -B ../ops/chain/install-native-runtime-test.py
  python3 -I -B ../ops/custody/test_evidence.py
  node --test ../ops/chain/native-rpc-transport.test.mjs
  python3 -m unittest discover -s ../ops/node-backup -p 'test_*.py'
  ;;
 private-exchange)
  cd chain
  export UAIN_PUBLIC_FIXTURE_DIR=/work/chain/private-public-fixtures
  export UAIN_PRIVATE_STATE_BIN=/work/chain/bin/uain-private-state
  export UAIN_PRIVATE_WALLET_BIN=/work/chain/private-exchange/target/release/uain-private-wallet
  rustc --version | grep -F 'rustc 1.89.0 '
  python3 -I -B ../ops/ci/rustfmt-check.py private-exchange/Cargo.toml
  cargo build --manifest-path private-exchange/Cargo.toml --release --locked -j 2
  cargo test --manifest-path private-exchange/Cargo.toml --release --locked -j 2 -- --nocapture
  cargo fmt --manifest-path private-dividend/Cargo.toml -- --check
  cargo build --manifest-path private-dividend/Cargo.toml --release --locked -j 2 --features public-hash-ffi
  cargo test --manifest-path private-dividend/Cargo.toml --release --locked -j 2 -- --test-threads=1
  export UAIN_DIVIDEND_REGISTRATION_RECEIPT=/work/chain/private-dividend/registration-public-fixtures
  cargo test --manifest-path private-dividend/Cargo.toml --release --locked -j 2 --features snapshot-prototype,public-hash-ffi -- --test-threads=1
  node --test private-dividend/tests/snapshot-model.test.mjs
  node --test client/private-review.test.mjs client/private-state.test.mjs client/coin-boundary.test.mjs client/private-workflow.test.mjs client/private-cli.test.mjs
  node scripts/private-exchange-smoke.mjs private-exchange/target/release/uain-private-wallet
  go build -tags orchard -p 2 -o bin/uain-private-state ./cmd/uain-private-state
  go build -p 2 -o bin/uain-peer-tunnel ./cmd/uain-peer-tunnel
  go test -race -timeout 30m -tags orchard -p 2 ./...
  go vet -tags orchard -p 2 ./...
  go build -tags orchard -p 2 -o bin/uaind-private ./cmd/uaind
  go build -p 2 -o bin/uain-proof ./cmd/uain-proof
  node scripts/private-state-network-smoke.mjs bin/uaind-private bin/uain-private-state
  node scripts/coin-network-smoke.mjs bin/uaind-private bin/uain-proof
  node scripts/external-funding-network-smoke.mjs bin/uaind-private bin/uain-proof
  node scripts/coin-boundary-network-smoke.mjs bin/uaind-private bin/uain-proof bin/uain-private-state private-exchange/target/release/uain-coin-wallet private-exchange/target/release/uain-private-wallet
  # The same flow in remote-verified light mode through an untrusted logging proxy. The light wallet
  # launcher was removed (42c8d7e3); this mode (uain-private-state --remote-verified, client/note-scan.mjs) still ships.
  UAIN_COIN_BOUNDARY_SMOKE_PORT=35657 UAIN_LIGHT_WALLET_SMOKE=1 UAIN_NOTE_SOURCE_BIN=private-exchange/target/release/uain-note-source node scripts/coin-boundary-network-smoke.mjs bin/uaind-private bin/uain-proof bin/uain-private-state private-exchange/target/release/uain-coin-wallet private-exchange/target/release/uain-private-wallet
  bash -n ../ops/remote-test/private-exchange.sh
  node --check ../ops/chain/submit-native-migration.mjs
  ;;
 isolation)
  python3 -m unittest discover -s ops/ci -p 'test_*.py'
  test ! -e /var/run/docker.sock
  test ! -e /home/runner/.kube/config
  test ! -e /work/.git
  test ! -e /work/.env
  test ! -e /work/work
  for link in /work/.ci-escape-absolute /work/.ci-escape-relative; do
   if [[ -L $link ]]; then test ! -e "$link"; fi
  done
  test ! -e /runtime/rust/credentials.toml
  if touch /runtime/go/CI-MUST-NOT-WRITE 2>/dev/null; then exit 1; fi
  if touch /runtime/rust/CI-MUST-NOT-WRITE 2>/dev/null; then exit 1; fi
  if touch /etc/CI-MUST-NOT-WRITE 2>/dev/null; then exit 1; fi
  test "$(node --version)" = v22.22.0
  go version
  rustc --version
  pg_dump --version
  python3 -c 'import cryptography'
  ;;
 *) echo 'Unknown test suite' >&2; exit 2 ;;
esac
