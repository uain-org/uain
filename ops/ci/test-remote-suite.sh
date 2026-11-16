#!/usr/bin/env bash
# Exercise the actual remote runner without SSH, Docker or a DB: failure
# propagation, corrupted-cache rebuild, cleanup of only this run's labelled
# containers on interruption, and refusal to remove an unlabelled cache.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/source"
cat > "$work/bin/rsync" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$work/bin/ssh" <<'MOCK'
#!/bin/bash
# run.sh passes ssh options (BatchMode, ConnectTimeout) before the host.
while [[ "${1:-}" == -o ]]; do shift 2; done
shift
if [[ "$1" == bash ]]; then
  shift 3
  bash -s -- "$TEST_DEST" "$2" "$3"
else
  mkdir -p "$TEST_DEST/logs"
fi
MOCK
cat > "$work/bin/du" <<'MOCK'
#!/bin/sh
printf '%s\t%s\n' "${MOCK_CACHE_BYTES:-1024}" "$2"
MOCK
cat > "$work/bin/docker" <<'MOCK'
#!/bin/bash
# Fake daemon state lives in $MOCK_STATE; every call is logged.
echo "$*" >> "$MOCK_STATE/docker.log"
case "$1 $2" in
  "volume inspect")
    name=${*: -1}
    [[ -e "$MOCK_STATE/volume-$name" ]] || exit 1
    case "$*" in
      *Labels*) cat "$MOCK_STATE/volume-$name" ;;
      *Mountpoint*) echo "$MOCK_STATE/mount-$name" ;;
    esac
    exit 0 ;;
  "volume create") [[ "$*" == *uain.purpose=tests* ]] && echo tests > "$MOCK_STATE/volume-${*: -1}"; exit 0 ;;
  "volume rm") rm -f "$MOCK_STATE/volume-$3"; exit 0 ;;
esac
case "$1" in
  run)
    runs=$(grep -c '^run ' "$MOCK_STATE/docker.log")
    case "$MOCK_MODE" in
      fail) echo '# tests 1'; echo '# pass 0'; echo '# fail 1'; exit 23 ;;
      corrupt)
        if [[ $runs == 1 ]]; then echo 'npm error code EINTEGRITY'; exit 1; fi
        echo '# tests 1'; echo '# pass 1'; echo '# fail 0'; exit 0 ;;
      interrupt) kill -TERM "$PPID"; sleep 1; exit 143 ;;
    esac ;;
  ps) [[ "$*" == *label=uain.run=run-* && $MOCK_MODE == interrupt ]] && echo own-run-container; exit 0 ;;
  *) exit 0 ;;
esac
MOCK
chmod +x "$work/bin/"*

attempt() { # mode expected-exit [setup]
  local mode=$1 expected=$2 code=0
  export TEST_DEST="$work/$mode${3:-}/destination" MOCK_STATE="$work/$mode${3:-}" MOCK_MODE=$mode
  mkdir -p "$MOCK_STATE"
  if [[ ${3:-} == unlabelled ]]; then : > "$MOCK_STATE/volume-uain-test-npm-cache-v2"; fi
  if [[ ${3:-} == oversize ]]; then echo tests > "$MOCK_STATE/volume-uain-test-npm-cache-v2"; fi
  export MOCK_CACHE_BYTES=$([[ ${3:-} == oversize ]] && echo 5000000000 || echo 1024)
  PATH="$work/bin:$PATH" bash "$root/ops/remote-test/run.sh" --suite pilot "$work/source" > "$MOCK_STATE/output" 2>&1 || code=$?
  [[ $code == "$expected" ]] || { cat "$MOCK_STATE/output"; echo "$mode: expected exit $expected, got $code" >&2; exit 1; }
}
log() { cat "$MOCK_STATE/docker.log"; }
refuse() { if log | grep -qE "$1"; then log; echo "$MOCK_MODE: unexpected docker call matching $1" >&2; exit 1; fi; }
need() { log | grep -qE "$1" || { log; echo "$MOCK_MODE: missing docker call matching $1" >&2; exit 1; }; }

attempt fail 23
echo 'Remote test failure propagated'

attempt corrupt 0
need '^volume rm uain-test-npm-cache-v2$'
[[ $(log | grep -c '^run ') == 2 ]] || { log; echo 'corrupt: expected one retry' >&2; exit 1; }
grep -q 'retrying once' "$MOCK_STATE/output"
echo 'Corrupted npm cache rebuilt and the run retried once'

attempt interrupt 130
need '^ps -aq --filter label=uain.run=run-[0-9]+-[0-9]+-[0-9]+$'
need '^rm -f own-run-container$'
[[ $(log | grep -c '^rm ') == 1 ]] || { log; echo 'interrupt: removed more than its own container' >&2; exit 1; }
refuse 'prune|volume rm|^rm .*uain-test-pg|^stop '
echo 'Interrupted run removed only its own labelled container'

attempt corrupt 1 unlabelled
refuse '^volume rm'
grep -q 'refusing to remove unlabelled volume' "$MOCK_STATE/output"
echo 'Unlabelled cache volume was not removed'

attempt fail 23 oversize
need '^volume rm uain-test-npm-cache-v2$'
need '^volume create --label uain.purpose=tests --label uain.cache=npm uain-test-npm-cache-v2$'
echo 'Oversized npm cache was rebuilt within its cap'
