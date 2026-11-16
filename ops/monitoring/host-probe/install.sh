#!/usr/bin/env bash
# Install the host probe on uain-app-1 (node conditions and front-door 5xx).
# Usage: install.sh [ssh-host]. The front door must already carry the
# uain_edge access log (deploy/k8s/production/front-door.conf).
set -euo pipefail
HOST=${1:-uain-app-1}
HERE=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" 'install -d -m 755 /opt/uain-host-probe'
scp -q "$HERE/host_probe.py" "$HOST:/opt/uain-host-probe/host_probe.py"
scp -q "$HERE/uain-host-probe.service" "$HERE/uain-host-probe.timer" "$HOST:/etc/systemd/system/"
ssh "$HOST" 'chmod 644 /opt/uain-host-probe/host_probe.py && systemctl daemon-reload && systemctl enable --now uain-host-probe.timer && systemctl start uain-host-probe.service && grep -E "DiskPressure|uain.global\",class=\"5xx|timestamp_seconds [0-9]" /var/lib/node_exporter/textfile/uain_host_probe.prom'
