#!/usr/bin/env bash
# Install the operator capability only. Never prepares/applies a reset.
# DB role requires the *public* app reset SSH key, never an operator key.
set -euo pipefail
umask 077
role=${1:?app or database}
revision=${5:?reviewed full source revision}
repo=$(cd "$(dirname "$0")/../.." && pwd)
[ "$(id -u)" = 0 ] || exit 1
case "$role" in
 app) [ "$(hostname -s)" = uain-app-1 ]; proof=${2:?verified uain-proof binary}; state=${3:?verified uain-state binary}; offline=${4:?verified stopped checkpoint binary}; test -x "$proof"; test -x "$state"; test -x "$offline" ;;
 database) [ "$(hostname -s)" = uain-db-1 ]; pub=${2:?app reset public-key file}; state=${3:?verified uain-state binary}; offline=${4:?verified stopped checkpoint binary}; test -f "$pub"; test -x "$state"; test -x "$offline" ;;
 *) exit 2 ;;
esac
[ ! -e /opt/uain-reset ] && [ ! -L /opt/uain-reset ] || { echo 'Already installed; use reviewed upgrade.py plan/apply.' >&2; exit 2; }
/usr/bin/python3 -c 'import cryptography'
install -d -m 0700 /etc/uain-reset /var/lib/uain-reset
if [ "$role" = app ]; then
 test -x /opt/uain-custody/venv/bin/python
 [ ! -e /etc/uain-reset/db_ed25519 ] || exit 2
 /usr/bin/python3 -I -B "$repo/ops/reset/upgrade.py" bootstrap app --source "$repo/ops/reset" --state "$state" --checkpoint "$offline" --proof "$proof" --source-revision "$revision"
 ssh-keygen -q -t ed25519 -N '' -C uain-reset-scoped -f /etc/uain-reset/db_ed25519
 install -m 0600 /etc/uain-custody/db_known_hosts /etc/uain-reset/db_known_hosts
 echo 'Installed capability only. Provision its public SSH key on the database host, then qualify plan.'
else
 /usr/bin/python3 -I -B "$repo/ops/reset/upgrade.py" bootstrap database --source "$repo/ops/reset" --state "$state" --checkpoint "$offline" --source-revision "$revision"
 python3 - "$pub" <<'PY'
import pathlib,re,sys
key=pathlib.Path(sys.argv[1]).read_text().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?',key):raise SystemExit('Invalid public key')
path=pathlib.Path('/root/.ssh/authorized_keys')
line='from="10.98.0.1",restrict,command="/usr/bin/python3 /opt/uain-reset/node_main.py" '+key
existing=path.read_text()
if line not in existing.splitlines():
    with path.open('a') as out:out.write('\n'+line+'\n')
path.chmod(0o600)
PY
 echo 'Installed a forced UAIN reset endpoint; no general SSH shell.'
fi
