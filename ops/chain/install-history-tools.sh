#!/usr/bin/env bash
# Install only the qualified public offline verifier; no signing keys are read.
set -euo pipefail
BINARY=${1:?public uain-proof executable}
PIN=4c7a8068ddf5c89e96b718302f1c7acacf193fc890137ba73891e23058559a58
test "$(id -u)" = 0
test "$(sha256sum "$BINARY" | awk '{print $1}')" = "$PIN"
DEST=/opt/uain-chain/tools/proof/$PIN
install -d -o root -g root -m 755 "$DEST"
if [ -e "$DEST/uain-proof" ]; then
  test "$(sha256sum "$DEST/uain-proof" | awk '{print $1}')" = "$PIN"
else
  install -o root -g root -m 555 "$BINARY" "$DEST/uain-proof"
fi
test "$(stat -c '%u:%g:%a' "$DEST/uain-proof")" = 0:0:555
sha256sum "$DEST/uain-proof"
