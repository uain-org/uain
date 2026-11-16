#!/usr/bin/env bash
# FIXTURE QUALIFICATION ONLY. Runs services/project-organizations/test/native-daemon-e2e-stage.mjs
# on the test host in one throwaway, resource-limited container with no network: two real
# pinned native daemons on a unique fictional genesis, fictional identities, fixture custody
# (the adapter stage) and the Python fleet custody with fixture keys (the custody stage).
# It never touches a running service, production key, chain state or database. The pinned
# daemon and reader are copied read-only from the host's reviewed release paths and their
# hashes checked before use. Evidence stays under /opt/uain-test/orgs-native-*/evidence.
#
# Usage: services/project-organizations/ops/qualify-native.sh [checkout]
#        UAIN_ORGS_E2E_ONLY=adapter|python|fund to run one stage only (all three by default; `fund`:
#        a later funding round applied, decided and unlocked from evidence, and a refused one).
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
IMAGE=${UAIN_ORGS_E2E_IMAGE:-baink-financial-qualification:20261104}
# Reviewed daemons only: 0.3.9 (default) or the replay-checked 0.4.1 now on production
# (UAIN_ORGS_E2E_DAEMON=0.4.1). Each is hash-checked before use, as the stage checks it again.
case "${UAIN_ORGS_E2E_DAEMON:-0.3.9}" in
  0.3.9) DAEMON_PIN=1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6 ;;
  0.4.1) DAEMON_PIN=b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024 ;;
  *) echo "UAIN_ORGS_E2E_DAEMON must be 0.3.9 or 0.4.1"; exit 2 ;;
esac
READER_PIN=136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ONLY=${UAIN_ORGS_E2E_ONLY:-}
case "$ONLY" in ''|adapter|python|fund) ;; *) echo "UAIN_ORGS_E2E_ONLY must be adapter, python or fund"; exit 2 ;; esac

# Resource guard: refuse below 30 GiB free disk or 8 GiB available memory.
ssh "$HOST" bash -s <<'GUARD'
set -euo pipefail
disk=$(df -B1 --output=avail /opt | tail -1)
mem=$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)
echo "free disk ${disk} bytes, available memory ${mem} bytes"
[ "$disk" -ge $((30 * 1024 * 1024 * 1024)) ] || { echo 'refused: under 30 GiB free disk'; exit 3; }
[ "$mem" -ge $((8 * 1024 * 1024 * 1024)) ] || { echo 'refused: under 8 GiB available memory'; exit 3; }
GUARD

DEST=$(ssh "$HOST" "mkdir -p /opt/uain-test && mktemp -d /opt/uain-test/orgs-native-$STAMP-XXXX")
[[ "$DEST" =~ ^/opt/uain-test/orgs-native-[0-9TZ]+-[A-Za-z0-9]+$ ]] || { echo "unexpected destination $DEST"; exit 2; }
echo "destination: $HOST:$DEST"
ssh "$HOST" "mkdir -p '$DEST/source' '$DEST/tools' '$DEST/evidence'"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude '.env*' --exclude /public --exclude /output \
  --exclude /chain/bin --exclude target --exclude '*.sqlite' --exclude '.next' --exclude dist \
  "$SRC/" "$HOST:$DEST/source/"

ssh "$HOST" bash -s -- "$DEST" "$IMAGE" "$DAEMON_PIN" "$READER_PIN" "$STAMP" "$ONLY" <<'REMOTE'
set -euo pipefail
DEST=$1 IMAGE=$2 DAEMON_PIN=$3 READER_PIN=$4 STAMP=$5 ONLY=${6:-}
cp /opt/uain-chain/releases/$DAEMON_PIN/uaind "$DEST/tools/uaind"
cp /opt/uain-chain/tools/state/$READER_PIN/uain-state "$DEST/tools/uain-state"
chmod 555 "$DEST/tools/uaind" "$DEST/tools/uain-state"
printf '%s  %s\n%s  %s\n' "$DAEMON_PIN" "$DEST/tools/uaind" "$READER_PIN" "$DEST/tools/uain-state" | sha256sum --check
( cd "$DEST/source" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > "$DEST/evidence/source-sha256.txt"
sha256sum "$DEST/evidence/source-sha256.txt" | cut -d' ' -f1 > "$DEST/evidence/source-inventory.sha256"
NAME="uain-orgs-native-qual-$STAMP"
docker run -d --init --name "$NAME" --label uain.fixture=project-organizations-native \
  --network none --read-only --cpus 2 --memory 4g --memory-swap 4g --pids-limit 256 \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,exec,nosuid,size=1g,mode=1777 \
  -v "$DEST/source:/source:ro" -v "$DEST/tools:/tools:ro" -v "$DEST/evidence:/evidence" \
  -e UAIN_ORGS_NATIVE_E2E=1 -e UAIN_ORGS_E2E_EVIDENCE=/evidence -e UAIN_ORGS_E2E_ONLY="$ONLY" -e UAIN_ORGS_E2E_DAEMON_PIN="$DAEMON_PIN" -w /source "$IMAGE" \
  timeout 1800 node --test --test-reporter=tap services/project-organizations/test/native-daemon-e2e-stage.mjs > /dev/null
docker inspect "$NAME" --format 'limits: cpus={{.HostConfig.NanoCpus}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} network={{.HostConfig.NetworkMode}} readonly={{.HostConfig.ReadonlyRootfs}}' | tee "$DEST/evidence/container.txt"
code=$(docker wait "$NAME")
docker logs "$NAME" > "$DEST/evidence/stage.tap" 2>&1 || true
docker rm "$NAME" > /dev/null
echo "$code" > "$DEST/evidence/exit-code"
echo "exit code: $code"
tail -n 25 "$DEST/evidence/stage.tap"
printf 'evidence: %s/evidence\n' "$DEST"
exit "$code"
REMOTE
