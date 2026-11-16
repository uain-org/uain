#!/usr/bin/env bash
# Install the reviewed onion read gateway and public peer sync. It has no signing key; broadcasts
# are off. Never reuse the disposable acceptance service's onion identity.
set -euo pipefail
STAGE=${1:?trusted checkout}
test "$(id -u)" = 0
exec 9>/run/uain-private-rpc-install.lock
flock -n 9
HOME_DIR=/var/lib/uain-chain/shadow-20261008-1
test "$(sha256sum "$HOME_DIR/config/genesis.json" | cut -d' ' -f1)" = 54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff
test "$(/opt/uain-chain/releases/17c306b983d076e44d7ec63b9ce3b439ccf17e82a10937c3d1d3d42e1f28a13a/uaind node-id --home "$HOME_DIR")" = 6f019abdf01b330533178b3d10a587cdaf26c5b2
test "$(sha256sum /opt/uain-chain/releases/17c306b983d076e44d7ec63b9ce3b439ccf17e82a10937c3d1d3d42e1f28a13a/uaind | cut -d' ' -f1)" = 17c306b983d076e44d7ec63b9ce3b439ccf17e82a10937c3d1d3d42e1f28a13a
GATEWAY=30c2338e67348e74cb77f8247c2c544f7999cbf47f2c8805d5055a77f2467b47
SIGNING=16a79b453e42e18cdc4afddd19d9dc8ed1295e482cb742bee0b9a881c8df78dc
test "$(sha256sum "$STAGE/ops/chain/private-rpc-gateway.mjs" | cut -d' ' -f1)" = "$GATEWAY"
test "$(sha256sum "$STAGE/chain/client/signing.mjs" | cut -d' ' -f1)" = "$SIGNING"
NODE=/opt/uain-review-runtime/node-v22.22.0-linux-x64/bin/node
test -x "$NODE"
command -v tor >/dev/null
getent passwd uain-private-rpc >/dev/null || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin uain-private-rpc
ROOT=/opt/uain-chain/private-rpc/$GATEWAY
install -d -o root -g root -m 755 "$ROOT/ops/chain" "$ROOT/chain/client"
for FILE in ops/chain/private-rpc-gateway.mjs chain/client/signing.mjs; do
 if [ -e "$ROOT/$FILE" ]; then
  cmp "$ROOT/$FILE" "$STAGE/$FILE"
 else
  install -o root -g root -m 555 "$STAGE/$FILE" "$ROOT/$FILE"
 fi
done
install -d -o root -g debian-tor -m 750 /etc/uain-private-tor
install -d -o debian-tor -g debian-tor -m 700 /var/lib/uain-private-tor
cat > /etc/uain-private-tor/torrc <<'CONF'
DataDirectory /var/lib/uain-private-tor
SocksPort 127.0.0.1:19051
ClientOnly 1
SafeLogging 1
Log notice syslog
HiddenServiceDir /var/lib/uain-private-tor/rpc
HiddenServiceVersion 3
HiddenServicePort 80 unix:/run/uain-private-rpc/gateway.sock
# Public block/peer sync. Wallet selectors never traverse this stream.
HiddenServicePort 26656 10.98.0.1:26666
CONF
chown root:debian-tor /etc/uain-private-tor/torrc
chmod 640 /etc/uain-private-tor/torrc
cat > /etc/systemd/system/uain-private-rpc.service <<UNIT
[Unit]
Description=UAIN onion wallet state gateway (broadcasts disabled)
After=uain-chain-shadow.service
[Service]
User=uain-private-rpc
Group=debian-tor
RuntimeDirectory=uain-private-rpc
RuntimeDirectoryMode=0750
Environment=UAIN_PRIVATE_SOCKET=/run/uain-private-rpc/gateway.sock
Environment=UAIN_PRIVATE_RPC=http://127.0.0.1:26667
Environment=UAIN_PRIVATE_BROADCAST=0
ExecStart=$NODE $ROOT/ops/chain/private-rpc-gateway.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX AF_INET
IPAddressDeny=any
IPAddressAllow=localhost
MemoryMax=256M
CPUQuota=50%
TasksMax=64
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/uain-private-tor.service <<'UNIT'
[Unit]
Description=UAIN onion wallet transport
After=network-online.target uain-private-rpc.service
Wants=network-online.target
[Service]
User=debian-tor
Group=debian-tor
ExecStart=/usr/bin/tor -f /etc/uain-private-tor/torrc
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/uain-private-tor
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=512M
CPUQuota=50%
TasksMax=128
[Install]
WantedBy=multi-user.target
UNIT
# The canonical bootstrap stays on its private tunnel address. Tor peers share
# one local source IP, so allow duplicate IPs with a finite inbound budget.
# Disable address gossip; never change genesis, voting keys or validator power.
python3 - "$HOME_DIR/config/config.toml" <<'PYPEER'
import os,pathlib,re,shutil,sys,time
p=pathlib.Path(sys.argv[1]);original=p.read_text();s=original
assert re.search(r'^laddr = "tcp://10\.98\.0\.1:26666"$',s,re.M), 'wrong bootstrap P2P address'
for k,v in {'allow_duplicate_ip':'true','max_num_inbound_peers':'16','pex':'false'}.items():
 s,n=re.subn(r'^'+k+r' = .*$',k+' = '+v,s,flags=re.M);assert n==1,k
if s!=original:
 backup=p.with_name('config.before-wallet-peer-'+str(time.time_ns())+'.toml');shutil.copy2(p,backup)
 with p.open('w') as f:f.write(s);f.flush();os.fsync(f.fileno())
 pathlib.Path('/run/uain-wallet-peer-bootstrap-restart').touch(mode=0o600)
PYPEER
systemctl daemon-reload
if [ -f /run/uain-wallet-peer-bootstrap-restart ]; then
 systemctl restart uain-chain-shadow
 rm /run/uain-wallet-peer-bootstrap-restart
fi
systemctl enable --now uain-private-rpc uain-private-tor
systemctl restart uain-private-tor
systemctl is-active uain-chain-shadow uain-private-rpc uain-private-tor
echo 'Read only gateway and public peer sync installed; economy policies and keys unchanged.'
