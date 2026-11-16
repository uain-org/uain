#!/usr/bin/env bash
set -euo pipefail
STAGE=${1:?public executable staging directory}
test "$(id -u)" = 0
for row in \
 'private-state uain-private-state 45ffaaf1e85cb3d30e01f8ef8c38b75fa6ecb0169f9ecda9a3b22b7ae6286ddb' \
 'peer-tunnel uain-peer-tunnel 8f7d10bc016cccadb5df4a3a0e5945e7158232d6c9eb63fa5cb5e3b2f5768242' \
 'coin-wallet uain-coin-wallet f3fd242f79c44b06b431a57ed94005e80a55f372d92c0c93d7a4bef9601db986' \
 'private-wallet uain-private-wallet b0a3b9ebc22ae09d99a770c4f070b114d4c4fa6730c7b99e4ba3dccce8fc3584'
do
 read -r KIND NAME PIN <<< "$row"
 test "$(sha256sum "$STAGE/$NAME" | awk '{print $1}')" = "$PIN"
 DEST=/opt/uain-chain/tools/$KIND/$PIN
 install -d -o root -g root -m 755 "$DEST"
 if [ -e "$DEST/$NAME" ]; then
  test "$(sha256sum "$DEST/$NAME" | awk '{print $1}')" = "$PIN"
 else
  install -o root -g root -m 555 "$STAGE/$NAME" "$DEST/$NAME"
 fi
 sha256sum "$DEST/$NAME"
done
