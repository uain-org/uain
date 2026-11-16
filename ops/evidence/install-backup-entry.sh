#!/usr/bin/env bash
# Install the daily evidence backup's own entry on uain-app-1. Run as root on
# the host, from a root-owned copy of this repository's ops/ tree:
#
#   bash ops/evidence/install-backup-entry.sh
#
# It puts the public source plan at /etc/uain-evidence/plan-20261012.json
# (rebuilt from the evidence store's own copy; it must hash to the pin in
# ops/custody/evidence.py), installs /opt/uain-evidence-backup/{entry,evidence}.py
# and /usr/local/sbin/uain-evidence-backup, and points the unit at them. It
# never touches /opt/uain-custody, the vault, a key or the timer's schedule,
# and it does not start a backup. The replaced unit is kept beside the result.
set -euo pipefail
umask 077
REPO=$(cd "$(dirname "$0")/../.." && pwd)
test "$(id -u)" = 0
test "$(hostname -s)" = uain-app-1
test -x /opt/uain-custody/venv/bin/python
test -d /opt/uain-evidence-operations/src/ops/evidence
UNIT=/etc/systemd/system/uain-evidence-backup.service
KEEP=/var/backups/uain-evidence-backup-entry-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o root -g root -m 0700 /etc/uain-evidence /opt/uain-evidence-backup "$KEEP"
/usr/bin/python3 -I - "$REPO/ops/custody/evidence.py" <<'PY'
import hashlib, json, os, re, sys
from pathlib import Path
source = Path(sys.argv[1]).read_text()
pin = re.search(r"^PLAN_SHA='([0-9a-f]{64})'$", source, re.M)[1]
target = Path(re.search(r"^PLAN='(/etc/uain-evidence/[a-z0-9.-]+)'$", source, re.M)[1])
root = Path(re.search(r"^ROOT='(/var/lib/uain-evidence/[a-z0-9-]+)'$", source, re.M)[1])
# The store keeps the same plan in its own layout; the pinned file is that
# content with sorted keys, compact separators, UTF-8 kept and one newline.
raw = (json.dumps(json.loads((root / 'plan.json').read_text()), sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
if hashlib.sha256(raw).hexdigest() != pin:
    raise SystemExit('rebuilt plan does not match the pinned SHA-256; nothing written')
if target.exists():
    if target.read_bytes() != raw:
        raise SystemExit('a different plan is already installed; nothing written')
else:
    pending = target.with_name(target.name + '.pending')
    with open(pending, 'xb') as out:
        os.chmod(pending, 0o600); out.write(raw); out.flush(); os.fsync(out.fileno())
    os.replace(pending, target)
print('plan', target, len(raw), 'bytes', pin)
PY
install -o root -g root -m 0600 "$REPO/ops/custody/evidence.py" /opt/uain-evidence-backup/evidence.py
install -o root -g root -m 0600 "$REPO/ops/custody/evidence_entry.py" /opt/uain-evidence-backup/entry.py
install -o root -g root -m 0700 "$REPO/ops/custody/uain-evidence-backup" /usr/local/sbin/uain-evidence-backup
if [ -e "$UNIT" ]; then cp -p "$UNIT" "$KEEP/uain-evidence-backup.service"; fi
install -o root -g root -m 0644 "$REPO/ops/evidence/uain-evidence-backup.service" "$UNIT"
systemd-analyze verify "$UNIT"
systemctl daemon-reload
sha256sum /opt/uain-evidence-backup/evidence.py /opt/uain-evidence-backup/entry.py /usr/local/sbin/uain-evidence-backup "$UNIT"
echo "Installed. Previous unit kept in $KEEP. Undo: copy it back to $UNIT and run systemctl daemon-reload."
