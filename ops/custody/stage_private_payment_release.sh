#!/usr/bin/env bash
# Stage a private payment service release on uain-app-1 for
# install_private_payment_release.py. Files the release does not change are
# copied byte for byte from the LIVE release; only the files named on the
# command line come from this checkout.
#
#   ops/custody/stage_private_payment_release.sh <checkout> <changed source path>...
#
# Prints the staging directory. Nothing is installed.
set -euo pipefail
HOST=${UAIN_CUSTODY_HOST:-uain-app-1}
SRC=$(cd "$1" && pwd); shift
STAGE=$(ssh "$HOST" 'umask 077; mktemp -d /root/private-payment-stage-XXXXXXXX')
[[ "$STAGE" =~ ^/root/private-payment-stage-[A-Za-z0-9]+$ ]] || exit 2
ssh "$HOST" bash -s -- "$STAGE" <<'REMOTE'
set -euo pipefail
STAGE=$1
LIVE=$(/opt/uain-custody/venv/bin/python -c 'import json;print(json.load(open("/etc/uain-custody/private-payment-service.json"))["source"])')
mkdir -p "$STAGE/source"
cp -a "$LIVE/." "$STAGE/source/"
rm -f "$STAGE/source/adoption.json"
REMOTE
for path in "$@"; do
  ssh "$HOST" "mkdir -p '$STAGE/source/$(dirname "$path")'"
  scp -q "$SRC/$path" "$HOST:$STAGE/source/$path"
done
scp -q "$SRC/ops/custody/private_payment_service.py" "$SRC/ops/custody/public_review_dispatch.py" "$SRC/ops/custody/install_private_payment_release.py" "$HOST:$STAGE/"
ssh "$HOST" "chown -R root:root '$STAGE' && chmod -R go-rwx '$STAGE' && find '$STAGE' -type f -exec sha256sum {} + | sed 's#$STAGE/##' | sort -k2"
# Check the staged release against this checkout: every SOURCE_FILES entry of
# the staged service must be present; each is either this checkout's bytes or
# kept live bytes. A missing entry (10 Nov 2026: native-pilot-sequence.mjs)
# would make the installer refuse, so stop here instead.
missing=0
while read -r name; do
  staged=$(ssh "$HOST" "sha256sum '$STAGE/source/$name' 2>/dev/null | cut -d' ' -f1")
  repo=$( (sha256sum "$SRC/$name" 2>/dev/null || shasum -a 256 "$SRC/$name") | cut -d' ' -f1)
  if [[ -z "$staged" ]]; then echo "MISSING  $name (pass it as a changed path)"; missing=1
  elif [[ "$staged" == "$repo" ]]; then echo "checkout $name"
  else echo "live     $name (staged bytes differ from this checkout)"; fi
done < <(python3 -I -c 'import ast,sys
for n in ast.walk(ast.parse(open(sys.argv[1]).read())):
  if isinstance(n,ast.Assign) and any(getattr(t,"id",None)=="SOURCE_FILES" for t in n.targets): print("\n".join(sorted(ast.literal_eval(n.value))))' "$SRC/ops/custody/private_payment_service.py")
echo "stage: $STAGE"
[[ $missing == 0 ]] || { echo "stage incomplete: a SOURCE_FILES entry is missing" >&2; exit 3; }
