#!/usr/bin/env bash
# Install the disk hygiene timer on uain-app-1:  ops/host/install-disk-hygiene.sh [host]
set -euo pipefail
HOST=${1:-uain-app-1}
here=$(cd "$(dirname "$0")" && pwd)
scp -q "$here/uain-disk-hygiene.sh" "$HOST:/usr/local/sbin/uain-disk-hygiene"
scp -q "$here/uain-disk-hygiene.service" "$here/uain-disk-hygiene.timer" "$HOST:/etc/systemd/system/"
ssh "$HOST" 'chmod 0755 /usr/local/sbin/uain-disk-hygiene && systemctl daemon-reload && systemctl enable --now uain-disk-hygiene.timer && systemctl list-timers --no-pager uain-disk-hygiene.timer | head -3'
