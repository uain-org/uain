#!/usr/bin/env bash
# Real-daemon qualification of the BAINK Trade deal layer (apps/baink/agents/trade-real-daemon-stage.mjs):
# kit-driven buyer, seller, UAIN trade steward and central reviewer against the real BAINK server,
# which proves state with the pinned reader, builds every no-install send with the pinned coin wallet
# and relays the member-signed coin_shield to a real pinned native daemon on a unique fictional
# genesis. Sign, pay, deliver, linked refund, steward retry after an abandoned attempt, an attempt
# signed after its window, payment-window expiry, dispute and appeal, cancellation, overspend
# (matrix row 30) and the 720-block approval window (matrix row 25).
#
# One throwaway, resource-limited container with no network on the test host; fictional identities
# only; the boundary checker is the devnet rule checker (FIXTURE: production keeps custody). It never
# touches a running service, production key, chain state or database. Every tool comes read-only from
# the host's reviewed release paths and is checked against the pins below before use. Evidence stays
# under /opt/uain-test/orgs-trade-*/evidence (trade-real-daemon.json, stage.tap, daemon.log).
#
# The 6 November stage (native-org-trade-e2e-stage.mjs, holder payments) was removed with the
# Docker holder on 9 November; this stage replaces it for Trade.
#
# Usage: services/project-organizations/ops/qualify-native-trade.sh [checkout]
#   UAIN_TRADE_DAEMON_PIN=<sha256>   another reviewed release under /opt/uain-chain/releases/ (e.g. 0.4.1)
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
IMAGE=${UAIN_ORGS_E2E_IMAGE:-baink-financial-qualification:20261104}
# uaind 0.3.9, the production release (BAINK, custody and the validator run it on 10 November 2026).
DAEMON_PIN=${UAIN_TRADE_DAEMON_PIN:-1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6}
# name:sha256:path, comma-separated (one ssh argument, no whitespace). The reader BAINK runs
# (BAINK_NATIVE_STATE_BINARY), the coin wallet BAINK and custody build sends with, custody's
# private-state reader, and the note-source decoder for the recipient note check (optional).
TOOLS=uain-state:136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860:/opt/uain-chain/tools/state/136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860/uain-state,uain-coin-wallet:cb847c04647292220f90cdd2be31765cdf0e42733682c4f1244f28348dda9859:/opt/uain-custody/tools/coin-wallet/cb847c04647292220f90cdd2be31765cdf0e42733682c4f1244f28348dda9859/uain-coin-wallet,uain-private-state:45ffaaf1e85cb3d30e01f8ef8c38b75fa6ecb0169f9ecda9a3b22b7ae6286ddb:/opt/uain-chain/tools/private-state/45ffaaf1e85cb3d30e01f8ef8c38b75fa6ecb0169f9ecda9a3b22b7ae6286ddb/uain-private-state
# The recipient note count (stage D8) needs a uain-private-state with the light scan
# (-remote-verified); no reviewed release on the host has it yet (10 November 2026: custody's
# 45ffaaf1… refuses the flag), so the decoder is supplied only when UAIN_TRADE_NOTE_SOURCE names one
# and the stage skips D8 otherwise. chain/scripts/server-send-network-smoke.mjs covers it from source.
OPTIONAL=uain-note-source:fe175eeef2b27ce945f2367d67154393ac3559c671089b9cfad2f85d8ac65c78:${UAIN_TRADE_NOTE_SOURCE:-/nonexistent/uain-note-source}
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$DAEMON_PIN" =~ ^[a-f0-9]{64}$ ]] || { echo "bad daemon pin"; exit 2; }

# Resource guard: refuse below 30 GiB free disk or 8 GiB available memory.
ssh "$HOST" bash -s <<'GUARD'
set -euo pipefail
disk=$(df -B1 --output=avail /opt | tail -1)
mem=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
echo "free disk ${disk} bytes, available memory ${mem} bytes"
[ "$disk" -ge $((30 * 1024 * 1024 * 1024)) ] || { echo 'refused: under 30 GiB free disk'; exit 3; }
[ "$mem" -ge $((8 * 1024 * 1024 * 1024)) ] || { echo 'refused: under 8 GiB available memory'; exit 3; }
GUARD

DEST=$(ssh "$HOST" "mkdir -p /opt/uain-test && mktemp -d /opt/uain-test/orgs-trade-$STAMP-XXXX")
[[ "$DEST" =~ ^/opt/uain-test/orgs-trade-[0-9TZ]+-[A-Za-z0-9]+$ ]] || { echo "unexpected destination $DEST"; exit 2; }
echo "destination: $HOST:$DEST"
ssh "$HOST" "mkdir -p '$DEST/source' '$DEST/tools' '$DEST/evidence'"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude '.env*' --exclude /public --exclude /output \
  --exclude /chain/bin --exclude target --exclude '*.sqlite' --exclude '.next' --exclude dist \
  --exclude /docs --exclude /chain/networks --exclude /chain/reports --exclude /chain/releases \
  "$SRC/" "$HOST:$DEST/source/"

ssh "$HOST" bash -s -- "$DEST" "$IMAGE" "$DAEMON_PIN" "$STAMP" "$TOOLS" "$OPTIONAL" <<'REMOTE'
set -euo pipefail
DEST=$1 IMAGE=$2 DAEMON_PIN=$3 STAMP=$4 TOOLS=$5 OPTIONAL=$6
cp "/opt/uain-chain/releases/$DAEMON_PIN/uaind" "$DEST/tools/uaind"
check="$DAEMON_PIN  $DEST/tools/uaind"
add() {
  local name=${1%%:*} rest=${1#*:}; local pin=${rest%%:*} path=${rest#*:}
  [[ "$name" =~ ^uain-[a-z-]+$ && "$pin" =~ ^[a-f0-9]{64}$ && "$path" =~ ^/(opt|var/lib|nonexistent)/[A-Za-z0-9._/-]+$ ]] || { echo "bad tool pin $1"; exit 2; }
  if [ "${2:-}" = optional ] && [ ! -f "$path" ]; then echo "optional tool $name not on this host; the recipient note check is skipped"; return; fi
  cp "$path" "$DEST/tools/$name"
  check="$check
$pin  $DEST/tools/$name"
}
IFS=, read -r -a pairs <<< "$TOOLS"
[ "${#pairs[@]}" -eq 3 ] || { echo "expected three required tool pins"; exit 2; }
for pair in "${pairs[@]}"; do add "$pair"; done
add "$OPTIONAL" optional
chmod 555 "$DEST"/tools/*
printf '%s\n' "$check" | sha256sum --check | tee "$DEST/evidence/tool-pins.txt"
"$DEST/tools/uaind" version > "$DEST/evidence/uaind-version.txt" 2>&1 || true
( cd "$DEST/source" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$DEST/evidence/source-sha256.txt"
sha256sum "$DEST/evidence/source-sha256.txt" | cut -d' ' -f1 > "$DEST/evidence/source-inventory.sha256"
touch "$DEST/.in-use"
NAME="uain-trade-real-daemon-$(basename "$DEST")"
docker run -d --init --name "$NAME" --label uain.fixture=baink-trade-real-daemon \
  --network none --read-only --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,exec,nosuid,size=2g,mode=1777 \
  -v "$DEST/source:/source:ro" -v "$DEST/tools:/tools:ro" -v "$DEST/evidence:/evidence" \
  -e UAIN_TRADE_REAL_DAEMON=1 -e UAIN_TRADE_TOOLS=/tools -e UAIN_TRADE_EVIDENCE=/evidence -e HOME=/tmp -w /source "$IMAGE" \
  timeout 3000 node --test --test-reporter=tap --test-timeout=2900000 apps/baink/agents/trade-real-daemon-stage.mjs > /dev/null
docker inspect "$NAME" --format 'limits: cpus={{.HostConfig.NanoCpus}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}}' | tee "$DEST/evidence/container.txt"
code=$(docker wait "$NAME")
docker logs "$NAME" > "$DEST/evidence/stage.tap" 2>&1 || true
docker rm "$NAME" > /dev/null
rm -f "$DEST/.in-use"
echo "$code" > "$DEST/evidence/exit-code"
echo "exit code: $code"
grep -E '^# (STAGE|row)|^(not )?ok |^# (pass|fail|duration_ms)' "$DEST/evidence/stage.tap" || true
grep -m1 -A40 'not ok' "$DEST/evidence/stage.tap" | head -60 || true
printf 'evidence: %s/evidence\n' "$DEST"
exit "$code"
REMOTE
