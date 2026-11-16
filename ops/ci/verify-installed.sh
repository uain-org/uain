#!/usr/bin/env bash
# Read-only comparison of the root-installed CI programs with
# ops/ci/installed-digests.json and with the tracked sources in this checkout.
# It reads hashes, owners and modes only; it never changes the host.
#
#   ops/ci/verify-installed.sh                 # over ssh to uain-app-1
#   ops/ci/verify-installed.sh --host HOST     # over ssh to another host
#   ops/ci/verify-installed.sh --local         # on the host itself, as root
#
# Per file it prints one of:
#   in-sync          installed bytes equal the tracked source
#   recorded         installed bytes equal the record (no tracked source)
#   pending-install  installed bytes equal the record; the tracked source has
#                    reviewed changes not yet installed
#   DRIFT            installed bytes match neither: someone changed the host.
#                    Do not install over it; reconcile through a reviewed diff.
#   UNSAFE           owner or mode differs from the record
#   MISSING          the installed file does not exist
# Exit status: 0 all in-sync or recorded, 3 pending installs only, 1 otherwise.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/../.." && pwd -P)
record=$here/installed-digests.json
host=uain-app-1 local=0 observed_file=
while (($#)); do
  case $1 in
    --local) local=1; shift ;;
    --host) host=${2:?host required}; shift 2 ;;
    # Tests: classify saved probe output against another record.
    --record) record=${2:?record required}; shift 2 ;;
    --observed) observed_file=${2:?file required}; shift 2 ;;
    *) echo 'usage: verify-installed.sh [--local | --host HOST]' >&2; exit 2 ;;
  esac
done
paths=$(python3 -I -c '
import json, re, sys
for row in json.load(open(sys.argv[1]))["files"]:
    path = row["installed"]
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", path) or ".." in path: raise SystemExit("unsafe recorded path")
    print(path)' "$record")
probe='for f in "$@"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    printf "%s %s %s\n" "$(sha256sum < "$f" | cut -d" " -f1)" "$(stat -c "%U:%G %a" "$f")" "$f"
  else printf "missing - - %s\n" "$f"; fi
done'
# shellcheck disable=SC2086 # recorded paths are validated above and contain no spaces
if [[ -n $observed_file ]]; then observed=$(cat "$observed_file")
elif ((local)); then observed=$(bash -c "$probe" probe $paths)
else observed=$(ssh -o BatchMode=yes "$host" bash -c "'$probe'" probe $paths); fi
OBSERVED=$observed python3 -I - "$record" "$root" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
record, root = json.load(open(sys.argv[1])), Path(sys.argv[2])
observed = {}
for line in os.environ['OBSERVED'].splitlines():
    digest, owner, mode, path = line.split(' ', 3)
    observed[path] = (digest, owner, mode)
worst = 0
for row in record['files']:
    path = row['installed']
    digest, owner, mode = observed.get(path, ('missing', '-', '-'))
    tracked = hashlib.sha256((root/row['source']).read_bytes()).hexdigest() if row.get('source') else None
    if digest == 'missing': status, level = 'MISSING', 1
    elif (owner, mode) != (row['owner'], row['mode']): status, level = 'UNSAFE', 1
    elif tracked is not None and digest == tracked: status, level = 'in-sync', 0
    elif digest == row['sha256']: status, level = ('recorded', 0) if tracked is None else ('pending-install', 3)
    else: status, level = 'DRIFT', 1
    worst = 1 if 1 in (worst, level) else max(worst, level)
    print('%-15s %s installed=%s recorded=%s%s' % (status, path, digest[:12], row['sha256'][:12],
          '' if tracked is None else ' tracked=%s (%s)' % (tracked[:12], row['source'])))
sys.exit(worst)
PY
