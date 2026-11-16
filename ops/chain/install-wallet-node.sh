#!/usr/bin/env bash
# Explicit Linux holder action. Only a new nonvalidator node, with locally
# generated peer identity; no member, spending or validator signing key input.
set -euo pipefail
DAEMON=${1:?qualified native daemon}
DAEMON_SHA=${2:?independent daemon SHA256}
TUNNEL=${3:?qualified uain-peer-tunnel}
TUNNEL_SHA=${4:?independent tunnel SHA256}
GENESIS=${5:?independent canonical public genesis}
GENESIS_SHA=${6:?independent genesis SHA256}
PEER_ID=${7:?independent bootstrap node ID}
ONION=${8:?independent v3 onion address}
SOCKS=${9:?own loopback Tor SOCKS IP:port}
test "$(id -u)" = 0
[[ "$DAEMON_SHA" =~ ^[0-9a-f]{64}$ && "$TUNNEL_SHA" =~ ^[0-9a-f]{64}$ && "$GENESIS_SHA" =~ ^[0-9a-f]{64}$ && "$PEER_ID" =~ ^[0-9a-f]{40}$ && "$ONION" =~ ^[a-z2-7]{56}\.onion$ ]]
python3 - "$SOCKS" <<'PY'
import ipaddress,sys
host,port=sys.argv[1].rsplit(':',1)
assert ipaddress.ip_address(host.strip('[]')).is_loopback and 0<int(port)<65536
PY
for row in "$DAEMON:$DAEMON_SHA" "$TUNNEL:$TUNNEL_SHA" "$GENESIS:$GENESIS_SHA"; do
 FILE=${row%:*}; HASH=${row##*:}; test "$(sha256sum "$FILE" | cut -d' ' -f1)" = "$HASH"
done
HOME_DIR=/var/lib/uain-wallet-node
for path in "$HOME_DIR" /etc/systemd/system/uain-wallet-node.service /etc/systemd/system/uain-wallet-peer.service; do
 if [ -e "$path" ]; then echo 'Refusing to overwrite an existing wallet node.' >&2; exit 2; fi
done
if ss -lntH | awk '{print $4}' | grep -Eq ':(27656|27657|27666)$'; then echo 'Wallet node ports occupied.' >&2; exit 2; fi
getent passwd uain-wallet-node >/dev/null || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin uain-wallet-node
ROOT=/opt/uain-chain/wallet-node/$DAEMON_SHA-$TUNNEL_SHA
install -d -o root -g root -m 755 "$ROOT"
install -o root -g root -m 555 "$DAEMON" "$ROOT/uaind"
install -o root -g root -m 555 "$TUNNEL" "$ROOT/uain-peer-tunnel"
install -o root -g root -m 444 "$GENESIS" "$ROOT/genesis.json"
install -d -o uain-wallet-node -g uain-wallet-node -m 700 "$HOME_DIR"
python3 - "$ROOT/genesis.json" "$ROOT/app-genesis.json" <<'PYGEN'
import json,pathlib,sys
value=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert isinstance(value['app_state'],dict) and value['chain_id']
pathlib.Path(sys.argv[2]).write_text(json.dumps(value['app_state']))
PYGEN
chmod 444 "$ROOT/app-genesis.json"
umask 0077
runuser -u uain-wallet-node -- "$ROOT/uaind" init --home "$HOME_DIR" --chain-id wallet-bootstrap --app-genesis "$ROOT/app-genesis.json" --rpc tcp://127.0.0.1:27657 --p2p tcp://127.0.0.1:27656
install -o uain-wallet-node -g uain-wallet-node -m 600 "$GENESIS" "$HOME_DIR/config/genesis.json"
python3 - "$HOME_DIR/config/config.toml" "$PEER_ID" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text()
values={'persistent_peers':'"'+sys.argv[2]+'@127.0.0.1:27666"','seeds':'""','external_address':'""','pex':'false','addr_book_strict':'false','max_num_inbound_peers':'0','max_num_outbound_peers':'1'}
for k,v in values.items():
 s,n=re.subn(r'^'+k+r' = .*$',k+' = '+v,s,flags=re.M);assert n==1,k
p.write_text(s)
PY
for KIND in peer node; do
 if [ "$KIND" = peer ]; then
  EXEC="$ROOT/uain-peer-tunnel --listen 127.0.0.1:27666 --socks-proxy $SOCKS --peer $ONION:26656"
  AFTER=network-online.target
 else
  EXEC="$ROOT/uaind start --home $HOME_DIR"
  AFTER=uain-wallet-peer.service
 fi
 cat > "/etc/systemd/system/uain-wallet-$KIND.service" <<UNIT
[Unit]
Description=UAIN holder owned wallet $KIND
After=$AFTER
[Service]
User=uain-wallet-node
Group=uain-wallet-node
ExecStart=$EXEC
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$HOME_DIR
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=4G
CPUQuota=200%
TasksMax=256
[Install]
WantedBy=multi-user.target
UNIT
done
systemd-analyze verify /etc/systemd/system/uain-wallet-node.service /etc/systemd/system/uain-wallet-peer.service
systemctl daemon-reload
systemctl enable --now uain-wallet-peer uain-wallet-node
systemctl is-active uain-wallet-peer uain-wallet-node
echo 'Wallet node installed. Wait for sync before using http://127.0.0.1:27657; no economy policy changed.'
