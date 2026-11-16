#!/usr/bin/env bash
# Run as root on an authorized UAIN host. Installs only a new, private shadow
# node; refuses to overwrite an existing chain home or service. No member keys.
set -euo pipefail
ROLE=${1:?validator or fullnode}
BINARY=${2:?verified Linux binary}
APP_GENESIS=${3:?public federation genesis}
CANONICAL=${4:-}
PEER=${5:-}
CHAIN_ID=uain-shadow-20261008-1
NODE_HOME=/var/lib/uain-chain/shadow-20261008-1
UNIT=/etc/systemd/system/uain-chain-shadow.service
case "$ROLE" in
 validator) TUNNEL=10.98.0.1 ;;
 fullnode) TUNNEL=10.98.0.2; test -f "$CANONICAL"; [[ "$PEER" =~ ^[0-9a-f]{40}@10\.98\.0\.1:26666$ ]] ;;
 *) exit 2 ;;
esac
if [ -e "$NODE_HOME" ] || [ -e "$UNIT" ]; then
  echo 'Refusing to overwrite an existing shadow node or service.' >&2; exit 2
fi
if ss -lntH | awk '{print $4}' | grep -Eq ':(26666|26667)$'; then
  echo 'Shadow ports are already in use.' >&2; exit 2
fi
if ! id uain-chain >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/uain-chain --create-home --shell /usr/sbin/nologin uain-chain
fi
install -d -o uain-chain -g uain-chain -m 750 /var/lib/uain-chain
DIGEST=$(sha256sum "$BINARY" | awk '{print $1}')
RELEASE=/opt/uain-chain/releases/$DIGEST
install -d -m 755 "$RELEASE"
install -m 755 "$BINARY" "$RELEASE/uaind"
install -m 644 "$APP_GENESIS" "$RELEASE/app-genesis.json"
umask 0077
runuser -u uain-chain -- "$RELEASE/uaind" init --home "$NODE_HOME" \
  --chain-id "$CHAIN_ID" --app-genesis "$RELEASE/app-genesis.json" \
  --rpc tcp://127.0.0.1:26667 --p2p "tcp://$TUNNEL:26666"
if [ "$ROLE" = fullnode ]; then
  install -o uain-chain -g uain-chain -m 600 "$CANONICAL" "$NODE_HOME/config/genesis.json"
  python3 - "$NODE_HOME/config/config.toml" "$PEER" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); s=p.read_text()
s=re.sub(r'^persistent_peers = .*$', 'persistent_peers = "'+sys.argv[2]+'"', s, flags=re.M)
s=re.sub(r'^addr_book_strict = .*$', 'addr_book_strict = false', s, flags=re.M)
p.write_text(s)
PY
fi
cat > "$UNIT" <<UNIT
[Unit]
Description=UAIN private Cosmos shadow chain ($ROLE)
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Service]
Type=simple
User=uain-chain
Group=uain-chain
WorkingDirectory=$NODE_HOME
ExecStart=$RELEASE/uaind start --home $NODE_HOME
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$NODE_HOME
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
CPUQuota=200%
MemoryMax=4G
TasksMax=256
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemd-analyze verify "$UNIT"
systemctl daemon-reload
systemctl enable --now uain-chain-shadow.service
systemctl is-active uain-chain-shadow.service
# Only public identities and artifact hashes are returned.
"$RELEASE/uaind" node-id --home "$NODE_HOME" | grep -E '^[0-9a-f]{40}$'
sha256sum "$NODE_HOME/config/genesis.json"
