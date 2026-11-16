#!/usr/bin/env bash
# The coordinator stops BOTH nodes before invoking this on either host.
# This changes only the installed executable; keys and signing state stay put.
set -euo pipefail
BINARY=${1:?verified Linux binary}
RELEASE_VERSION=${2:-0.1.1}
case "$RELEASE_VERSION" in
  0.1.1)
    EXPECTED=b75a57771feab32ce46ef42624c65af05e1f39c451b3aae46fff24a92d56c7f4
    OLD=7e564fd7570678a74748e84a0cb26e12a523d2ad4f7dab80a2831b0ffc8186b3
    ;;
  0.1.2)
    EXPECTED=9ad065146cc05c4d796d2e2ea77471384260df5705ea48f1b267d7e47a43b528
    OLD=b75a57771feab32ce46ef42624c65af05e1f39c451b3aae46fff24a92d56c7f4
    ;;
  0.2.0)
    EXPECTED=d308570b940689f73d6ce2204a255688dc53c5e018223767150f9bf82d681bf2
    OLD=9ad065146cc05c4d796d2e2ea77471384260df5705ea48f1b267d7e47a43b528
    ;;
  0.2.1)
    EXPECTED=8d37d5608076296a125fd0606b5863c3b71c72a57f966eaeeeb24647ce73bc5d
    OLD=d308570b940689f73d6ce2204a255688dc53c5e018223767150f9bf82d681bf2
    ;;
  0.3.0)
    EXPECTED=c2752b17df20bb1bb726ab7478d20c88dc418023190414da72b1508f154a4d78
    OLD=8d37d5608076296a125fd0606b5863c3b71c72a57f966eaeeeb24647ce73bc5d
    ;;
  0.3.3)
    EXPECTED=46d51026c0d06b6e602114a124b718fecd220e8f10610735003a5d70ecdf2055
    OLD=c2752b17df20bb1bb726ab7478d20c88dc418023190414da72b1508f154a4d78
    ;;
  0.3.5)
    EXPECTED=17c306b983d076e44d7ec63b9ce3b439ccf17e82a10937c3d1d3d42e1f28a13a
    OLD=46d51026c0d06b6e602114a124b718fecd220e8f10610735003a5d70ecdf2055
    ;;
  0.3.6)
    EXPECTED=a92cb71beb69852269daed730472e36f961b4f6e5bb979bcc349c3319b88c028
    OLD=17c306b983d076e44d7ec63b9ce3b439ccf17e82a10937c3d1d3d42e1f28a13a
    ;;
  0.3.7)
    EXPECTED=de321b8e229753aec0257415597789a6eb2254ba3e71e12e9e70f652374b3ea1
    OLD=a92cb71beb69852269daed730472e36f961b4f6e5bb979bcc349c3319b88c028
    ;;
  *) echo 'Unsupported pinned release' >&2; exit 1 ;;
esac
NODE_HOME=/var/lib/uain-chain/shadow-20261008-1
UNIT=/etc/systemd/system/uain-chain-shadow.service
test "$(id -u)" = 0
test "$(systemctl is-active uain-chain-shadow.service || true)" = inactive
test "$(sha256sum "$BINARY" | awk '{print $1}')" = "$EXPECTED"
test "$(sha256sum "$NODE_HOME/config/genesis.json" | awk '{print $1}')" = 54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff
grep -Fqx "ExecStart=/opt/uain-chain/releases/$OLD/uaind start --home $NODE_HOME" "$UNIT"
RELEASE=/opt/uain-chain/releases/$EXPECTED
install -d -m 755 "$RELEASE"
if [ -e "$RELEASE/uaind" ]; then
  test "$(sha256sum "$RELEASE/uaind" | awk '{print $1}')" = "$EXPECTED"
else
  install -o root -g root -m 755 "$BINARY" "$RELEASE/uaind"
fi
"$RELEASE/uaind" version | grep -Fx "uaind $RELEASE_VERSION"
test ! -e "$UNIT.pre-$RELEASE_VERSION"
cp -p "$UNIT" "$UNIT.pre-$RELEASE_VERSION"
python3 - "$UNIT" "$OLD" "$EXPECTED" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); text=p.read_text()
old='/opt/uain-chain/releases/'+sys.argv[2]+'/uaind'
new='/opt/uain-chain/releases/'+sys.argv[3]+'/uaind'
if text.count(old)!=1: raise SystemExit('Expected one previous executable reference')
p.write_text(text.replace(old,new))
PY
systemd-analyze verify "$UNIT"
systemctl daemon-reload
echo 'Executable upgraded; coordinator must start both nodes and verify state.'
