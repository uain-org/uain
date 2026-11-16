#!/usr/bin/env bash
# Install the chain sync probe on one host. Usage: install.sh app|db [ssh-host]
# app -> uain-app-1 (validator, relay, server-hosted holders), db -> uain-db-1.
set -euo pipefail
ROLE=${1:?app or db}; HOST=${2:-$([ "$ROLE" = app ] && echo uain-app-1 || echo uain-database)}
HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/config.$ROLE.json" ] || { echo "unknown role $ROLE" >&2; exit 2; }
ssh "$HOST" 'install -d -m 755 /opt/uain-chain-sync /etc/uain-chain-sync'
scp -q "$HERE/chain_sync_probe.py" "$HOST:/opt/uain-chain-sync/chain_sync_probe.py"
scp -q "$HERE/config.$ROLE.json" "$HOST:/etc/uain-chain-sync/config.json"
scp -q "$HERE/uain-chain-sync.service" "$HERE/uain-chain-sync.timer" "$HOST:/etc/systemd/system/"
ssh "$HOST" 'chmod 644 /opt/uain-chain-sync/chain_sync_probe.py /etc/uain-chain-sync/config.json && systemctl daemon-reload && systemctl enable --now uain-chain-sync.timer && systemctl start uain-chain-sync.service && cat "$(python3 -c "import json;print(json.load(open(\"/etc/uain-chain-sync/config.json\"))[\"output\"])")"'
