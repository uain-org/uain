#!/usr/bin/env bash
# Run only through reviewed operator custody. Never print secret environment.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
exec /usr/bin/python3 -I "$here/backup.py" "$@"
