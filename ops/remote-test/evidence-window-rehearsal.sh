#!/usr/bin/env bash
# S6 evidence-window rehearsal on real pinned daemons (chain/scripts/central-evidence-window-rehearsal.mjs):
# two disposable nodes on a fictional genesis, guardian activation, the pre-activation request and its
# fresh re-request, revision and reassessment through BAINK's real service and pinned reader, expiry.
# One throwaway, resource-limited container with no network on the test host; fictional identities only;
# no running service, production key or chain is touched. Evidence stays under the destination folder;
# the copied source and tools are removed afterwards.
#
# Usage: ops/remote-test/evidence-window-rehearsal.sh [checkout]
#   UAIN_EVIDENCE_PRIMARY_PIN   daemon of the first node (default: production 0.4.1 b525c808…)
#   UAIN_EVIDENCE_SECOND_PIN    daemon of the second node (default: the same)
#   UAIN_EVIDENCE_SECOND_PATH   where the second daemon is on the host, if not under /opt/uain-chain/releases/<pin>/
#   UAIN_EVIDENCE_WINDOW        window_blocks for the fixture (default 20)
set -euo pipefail
HOST=${UAIN_TEST_HOST:-uain-app-1}
IMAGE=${UAIN_ORGS_E2E_IMAGE:-baink-financial-qualification:20261104}
PRIMARY_PIN=${UAIN_EVIDENCE_PRIMARY_PIN:-b525c808aa017865ec798869f2d72f5ba5ce0e6fb432cb7700bb8a2a29260024}
SECOND_PIN=${UAIN_EVIDENCE_SECOND_PIN:-$PRIMARY_PIN}
SECOND_PATH=${UAIN_EVIDENCE_SECOND_PATH:-/opt/uain-chain/releases/$SECOND_PIN/uaind}
WINDOW=${UAIN_EVIDENCE_WINDOW:-20}
READER_PIN=136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
[[ "$PRIMARY_PIN" =~ ^[a-f0-9]{64}$ && "$SECOND_PIN" =~ ^[a-f0-9]{64}$ && "$WINDOW" =~ ^[1-9][0-9]{0,5}$ ]] || { echo "bad pin or window"; exit 2; }
[[ "$SECOND_PATH" =~ ^/opt/(uain-chain/releases|uain-test)/[A-Za-z0-9._/-]+/uaind$ ]] || { echo "bad second daemon path"; exit 2; }
ssh "$HOST" 'df -P / | awk "NR==2 {gsub(\"%\",\"\",\$5); if (\$5 >= 85) {print \"refused: disk at \" \$5 \"%\"; exit 3}}"'
DEST=$(ssh "$HOST" "mkdir -p /opt/uain-test && mktemp -d /opt/uain-test/evidence-window-$STAMP-XXXX")
[[ "$DEST" =~ ^/opt/uain-test/evidence-window-[0-9TZ]+-[A-Za-z0-9]+$ ]] || { echo "unexpected destination $DEST"; exit 2; }
echo "destination: $HOST:$DEST"
ssh "$HOST" "mkdir -p '$DEST/source/apps' '$DEST/source/chain' '$DEST/tools' '$DEST/evidence'"
rsync -a --exclude node_modules --exclude '.env*' --exclude agent-kit --exclude web --exclude review-broker "$SRC/apps/baink/" "$HOST:$DEST/source/apps/baink/"
rsync -a "$SRC/chain/client/" "$HOST:$DEST/source/chain/client/"
rsync -a "$SRC/chain/scripts/central-evidence-window-rehearsal.mjs" "$HOST:$DEST/source/chain/scripts/"
ssh "$HOST" bash -s -- "$DEST" "$IMAGE" "$PRIMARY_PIN" "$SECOND_PIN" "$SECOND_PATH" "$READER_PIN" "$WINDOW" <<'REMOTE'
set -euo pipefail
DEST=$1 IMAGE=$2 PRIMARY_PIN=$3 SECOND_PIN=$4 SECOND_PATH=$5 READER_PIN=$6 WINDOW=$7
cp "/opt/uain-chain/releases/$PRIMARY_PIN/uaind" "$DEST/tools/uaind-primary"
cp "$SECOND_PATH" "$DEST/tools/uaind-second"
cp "/opt/uain-chain/tools/state/$READER_PIN/uain-state" "$DEST/tools/uain-state"
chmod 555 "$DEST"/tools/*
printf '%s  %s\n%s  %s\n%s  %s\n' "$PRIMARY_PIN" "$DEST/tools/uaind-primary" "$SECOND_PIN" "$DEST/tools/uaind-second" "$READER_PIN" "$DEST/tools/uain-state" | sha256sum --check | tee "$DEST/evidence/tool-pins.txt"
for d in primary second; do "$DEST/tools/uaind-$d" version 2>/dev/null | tail -1 | sed "s/^/$d: /"; done | tee "$DEST/evidence/uaind-versions.txt"
NAME="evidence-window-$(basename "$DEST")"
docker run -d --init --name "$NAME" --label uain.fixture=evidence-window \
  --network none --read-only --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 \
  --security-opt no-new-privileges --tmpfs /tmp:rw,exec,nosuid,size=1g,mode=1777 \
  -v "$DEST/source:/source:ro" -v "$DEST/tools:/tools:ro" -e HOME=/tmp -w /source "$IMAGE" \
  timeout 1500 node chain/scripts/central-evidence-window-rehearsal.mjs /tools/uaind-primary /tools/uaind-second /tools/uain-state "$WINDOW" > /dev/null
code=$(docker wait "$NAME")
docker logs "$NAME" > "$DEST/evidence/rehearsal.log" 2>&1 || true
docker rm "$NAME" > /dev/null
rm -rf "$DEST/source" "$DEST/tools"
echo "$code" > "$DEST/evidence/exit-code"
echo "exit code: $code"
tail -n 30 "$DEST/evidence/rehearsal.log" | cut -c1-2000
printf 'evidence: %s/evidence\n' "$DEST"
exit "$code"
REMOTE
