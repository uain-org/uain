#!/usr/bin/env bash
# Runs on uain-app-1 (as root, over ssh from ops/check.sh). Not for direct use.
#
#   check-remote.sh <run-id> <suite spec>...
#
# The committed snapshot was already copied to /opt/uain-checks/incoming/<run-id>.tar.
# It takes a free check slot (flock, up to 2 at once), unpacks the snapshot there
# owned by the runner user, and runs each suite through the installed, reviewed
# sandbox launcher (/usr/local/sbin/uain-ci-run): disposable containers, no
# network to production, resource admission, its own PostgreSQL. Suites run in
# parallel; the launcher's admission queues them when the host is busy.
# A suite spec is "pilot:1:2" (suite:thread:shard), "research:1", "others", ...
set -uo pipefail
RUN=$1; shift
[[ $RUN =~ ^[A-Za-z0-9._-]{1,80}$ ]] || { echo "bad run id" >&2; exit 2; }
BASE=${UAIN_CHECK_BASE:-/opt/uain-checks} TAR=$BASE/incoming/$RUN.tar LOGS=$BASE/logs/$RUN
install -d -o root -g root -m 0755 "$BASE" "$BASE/incoming" "$BASE/logs"
install -d -o root -g root -m 0755 "$LOGS"
trap 'rm -f "$TAR"' EXIT
# A dropped ssh session ends bash with SIGHUP, which skips the EXIT trap
# unless the signal is trapped: exit through it so the snapshot is removed.
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
[ -f "$TAR" ] || { echo "snapshot missing" >&2; exit 2; }

# Two slots, not four (9 Nov 2026): four checks x five suites x 2 CPUs plus their
# PostgreSQL containers oversubscribed the 40-core host next to production and
# made timing-sensitive tests flake. Do not raise it (load 26 of 40 cores, 10 Nov).
#
# Waiting (10 November 2026): runs queue oldest first and the oldest takes
# whichever slot frees first. Before, every waiter blocked on slot 1, so slot 2
# served only new arrivals and the oldest run waited longest (37 minutes once),
# and a killed flock fell through to slot 1 without the lock. A queued run whose
# client is gone (its ssh session's sshd has exited) is dropped and its snapshot
# removed (EXIT trap), instead of later running every suite for nobody.
# A ticket is a file named by its arrival time, locked by its waiter for as long
# as it waits; a ticket nobody holds is a dead waiter's and is removed.
client=$PPID
while [ "$client" -gt 1 ] && [[ $(ps -o comm= -p "$client" 2>/dev/null) != sshd* ]]; do
  client=$(ps -o ppid= -p "$client" 2>/dev/null | tr -d ' '); client=${client:-1}
done
client_gone() { [ "$client" -gt 1 ] && ! kill -0 "$client" 2>/dev/null; }
QUEUE=$BASE/queue
install -d -o root -g root -m 0755 "$QUEUE"
for n in 1 2; do install -d -o root -g root -m 0755 "$BASE/slot-$n"; done
ticket=$QUEUE/$(date +%s%N)-$RUN
exec {tfd}>"$QUEUE/.new-$RUN"
flock -n "$tfd" || { echo "queue ticket lock failed" >&2; exit 2; }
mv "$QUEUE/.new-$RUN" "$ticket"
slot= waited=
while :; do
  if client_gone; then echo "== client gone; queued run $RUN dropped" >&2; rm -f "$ticket"; exit 3; fi
  first=
  for t in "$QUEUE"/[0-9]*; do
    [ -e "$t" ] || continue
    if [ "$t" != "$ticket" ] && flock -n "$t" true 2>/dev/null; then rm -f "$t"; continue; fi
    first=$t; break
  done
  if [ "$first" = "$ticket" ]; then
    for n in 1 2; do
      exec {fd}>"$BASE/slot-$n.lock"
      if flock -n "$fd"; then slot=$n; break 2; fi
      exec {fd}>&-
    done
  fi
  [ -n "$waited" ] || { echo "== both check slots busy; queued, oldest first"; waited=1; }
  sleep 3
done
rm -f "$ticket"; exec {tfd}>&-
[ -n "$slot" ] || { echo "no slot taken" >&2; exit 2; }
SRC=$BASE/slot-$slot/uain-universa
rm -rf "$SRC" && install -d -o runner -g runner -m 0755 "$SRC"
( umask 022; tar -x --no-same-owner --no-same-permissions -C "$SRC" -f "$TAR" ) || { echo "unpack failed"; exit 2; }
chown -R runner:runner "$SRC" && chmod -R go-w "$SRC"
echo "== slot $slot, $(du -sh "$SRC" | cut -f1), suites: $*"

declare -A pid
run_suite() { # spec log
  local spec=$1 log=$2 suite a b args start rc
  IFS=: read -r suite a b <<<"$spec"
  args=("$suite"); [ -n "${a:-}" ] && args+=("$a"); [ -n "${b:-}" ] && args+=("$b")
  start=$(date +%s)
  sudo -n -u runner -- sudo -n /usr/local/sbin/uain-ci-run "$SRC" "${args[@]}" >"$log" 2>&1
  rc=$?; echo "rc=$rc seconds=$(( $(date +%s) - start ))" >>"$log"; return $rc
}
failing() { grep -hE '^not ok [0-9]+ - |^(FAIL|ERROR): ' "$1" | sed 's/^/      /' | head -8; }
for spec in "$@"; do
  log=$LOGS/$(echo "$spec" | tr ':' '-').log
  ( run_suite "$spec" "$log" && exit 0
    # One visible retry: a suite that fails then passes is reported as a flake
    # with its failing tests, and appended to the host flake log for fixing.
    cp "$log" "$log.first"
    { echo "$(date -u +%FT%TZ) $RUN $spec"; failing "$log.first"; } >>"$BASE/flaky.log"
    run_suite "$spec" "$log" && { echo "retried=1" >>"$log"; exit 0; }
    exit 1 ) &
  pid[$spec]=$!
done
fail=0
for spec in "$@"; do
  wait "${pid[$spec]}"; rc=$?
  log=$LOGS/$(echo "$spec" | tr ':' '-').log
  secs=$(grep -o 'seconds=[0-9]*' "$log" | tail -1 | cut -d= -f2)
  if [ $rc -eq 0 ] && grep -q '^retried=1' "$log"; then
    echo "PASS $spec on retry (${secs}s); first attempt failed (flake, logged in $BASE/flaky.log):"; failing "$log.first"
  elif [ $rc -eq 0 ]; then echo "PASS $spec (${secs}s)"
  else fail=1; echo "FAIL $spec twice; last lines of $log:"; grep -v '^\s*$' "$log" | tail -25 | sed 's/^/    /'; fi
  grep -h '^::warning' "$log" | sed "s/^/    [$spec] /" | head -20
done
rm -rf "$SRC"
echo "== logs: $LOGS"
exit $fail
