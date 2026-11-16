#!/usr/bin/env bash
# Capability installation only; the timer is enabled after a verified first run.
set -euo pipefail
umask 077
ROLE=${1:?app or database}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
test "$(id -u)" = 0
case "$ROLE" in
 app) test "$(hostname -s)" = uain-app-1; test -x /opt/uain-custody/venv/bin/python ;;
 database) test "$(hostname -s)" = uain-db-1; PUBLIC=${2:?dedicated app public-key file}; test -f "$PUBLIC" ;;
 *) exit 2 ;;
esac
test ! -e /opt/uain-node-backup
/usr/bin/python3 -c 'import cryptography'
install -d -o root -g root -m 0700 /opt/uain-node-backup /etc/uain-node-backup /var/lib/uain-node-backups
install -o root -g root -m 0600 "$REPO"/ops/node-backup/*.py /opt/uain-node-backup/
install -o root -g root -m 0600 "$REPO/ops/reset/archive.py" /opt/uain-node-backup/archive.py
sha256sum /opt/uain-node-backup/*.py > /opt/uain-node-backup/manifest.sha256
if [ "$ROLE" = app ]; then
 test ! -e /etc/uain-node-backup/db_ed25519
 ssh-keygen -q -t ed25519 -N '' -C uain-node-backup-scoped -f /etc/uain-node-backup/db_ed25519
 install -m 0600 /etc/uain-custody/db_known_hosts /etc/uain-node-backup/db_known_hosts
 install -m 0700 "$REPO/ops/node-backup/uain-node-backup" /usr/local/sbin/uain-node-backup
 install -m 0644 "$REPO"/ops/node-backup/*.service "$REPO"/ops/node-backup/*.timer /etc/systemd/system/
 systemd-analyze verify /etc/systemd/system/uain-node-backup.service /etc/systemd/system/uain-node-backup.timer /etc/systemd/system/uain-node-backup-check.service /etc/systemd/system/uain-node-backup-check.timer
 systemctl daemon-reload
 echo 'Installed capability; provision its public SSH key on the database host, then run and verify before enabling timers.'
else
 python3 - "$PUBLIC" <<'PY'
from pathlib import Path
import re,sys
key=Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?',key):raise ValueError('Invalid public key')
line='from="10.98.0.1",restrict,command="/usr/bin/python3 /opt/uain-node-backup/receive.py" '+key
target=Path('/root/.ssh/authorized_keys');old=target.read_text()
if line not in old.splitlines():
 with target.open('a') as out:out.write('\n'+line+'\n')
target.chmod(0o600)
PY
 echo 'Installed fixed-scope encrypted node backup endpoint; no shell or plaintext key export.'
fi
