#!/usr/bin/env bash
# Installs the read-only native proof-age publisher on uain-app-1 (root).
# node-exporter reads its file through --collector.textfile.directory
# (deploy/k8s/production/monitoring.yaml); Grafana alerts on it.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd)
test "$(id -u)" = 0
test "$(hostname -s)" = uain-app-1
install -d -o root -g root -m 0755 /opt/uain-proof-age /var/lib/node_exporter /var/lib/node_exporter/textfile
install -d -o root -g root -m 0700 /var/lib/uain-proof-age
install -o root -g root -m 0644 "$REPO/ops/chain/proof-age.py" /opt/uain-proof-age/proof-age.py
install -o root -g root -m 0644 "$REPO/ops/chain/uain-native-proof-age.service" "$REPO/ops/chain/uain-native-proof-age.timer" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/uain-native-proof-age.service /etc/systemd/system/uain-native-proof-age.timer
systemctl daemon-reload
/usr/bin/python3 -I /opt/uain-proof-age/proof-age.py
systemctl enable --now uain-native-proof-age.timer
