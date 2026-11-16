#!/usr/bin/env bash
# The pre-push check (9 November 2026). It replaces routine GitHub CI.
#
#   npm run check                  # the suites this branch's changes need
#   npm run check -- --all         # every routine suite
#   npm run check -- --suites others,site
#
# It tests the committed HEAD, so commit first. Steps:
#   1. It classifies the paths changed since origin/main (ops/ci-scope/classify.mjs).
#   2. It runs the fast checks on this machine: release-status render and BAINK test globs.
#   3. It copies HEAD to uain-app-1 and runs the suites in parallel through the same
#      reviewed sandbox launcher that CI used (ops/check-remote.sh). There is no GitHub
#      queue, and up to 2 checks from different sessions can run at once. A failed
#      suite is retried once; a pass on retry is reported as a flake with its tests.
#   4. On success it writes .git/uain-checks/<HEAD>.json. The pre-push hook
#      (.githooks/pre-push) refuses to push a commit without a passing record.
# The host is uain-app-1 (ssh alias); set UAIN_TEST_HOST to use another.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
HOST=${UAIN_TEST_HOST:-uain-app-1}
MODE=scope SUITES=
while (($#)); do
  case $1 in
    --all) MODE=all; shift ;;
    --suites) MODE=list SUITES=${2:?suites}; shift 2 ;;
    *) echo "usage: npm run check -- [--all | --suites a,b]" >&2; exit 2 ;;
  esac
done
git config core.hooksPath .githooks
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: uncommitted changes are NOT tested; the check tests the committed HEAD." >&2
fi
HEAD=$(git rev-parse HEAD)
git fetch -q origin main || true
BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo origin/main)

RECORDS=${UAIN_CHECK_RECORDS:-"$(git rev-parse --git-common-dir)/uain-checks"}
mkdir -p "$RECORDS/running"

# Many sessions run checks on this machine at once. On 9 November a pkill by name
# ("ops/check.sh") from one session ended every session's run, three times in an
# hour, and each time left runs waiting on the host for nobody. So SIGTERM is
# ignored here; cancel a run with SIGUSR1 to its own process id (SIGINT is often
# already ignored in a background job, so it cannot be relied on).
echo "== run pid $$. To cancel THIS run only: kill -USR1 $$  (never pkill by name; SIGTERM is ignored)"
trap 'echo "note: SIGTERM ignored at $(date -u +%T) (a pkill by name from another session?). To cancel this run: kill -USR1 $$" >&2' TERM
trap 'echo "CHECK CANCELLED for ${HEAD:0:10}: this process was interrupted. Not a test failure." >&2; exit 130' USR1 HUP

# This commit already passed (for example a run that outlived its caller): say so.
if [ "$MODE" = scope ] && [ -f "$RECORDS/$HEAD.json" ]; then
  echo "CHECK PASSED for ${HEAD:0:10}: already recorded ($(tr -d '\n' < "$RECORDS/$HEAD.json" | cut -c1-200))"
  exit 0
fi
# The same check of this commit is already running (its caller may have been killed
# while it carried on): wait for that run instead of queueing another.
KEY=$RECORDS/running/$HEAD.$MODE.$(printf '%s' "$SUITES" | tr -c 'A-Za-z0-9' '_')
if other=$(cat "$KEY" 2>/dev/null) && [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
  echo "== this commit is already being checked by pid $other; waiting for that run instead of queueing another"
  while kill -0 "$other" 2>/dev/null; do sleep 5; done
  if [ -f "$RECORDS/$HEAD.json" ]; then
    echo "CHECK PASSED for ${HEAD:0:10}: result of the run that was already in progress"; exit 0
  fi
  echo "CHECK FAILED for ${HEAD:0:10}: the run that was already in progress did not pass. Run again." >&2; exit 1
fi
echo $$ > "$KEY"
trap 'rm -f "$KEY"' EXIT
# A commit that only adds documentation, or only merges origin/main forward without
# touching a file this branch changed, reuses the pass of the commit it builds on
# (ops/check-inherit.sh has the exact rule and why). The fast local checks still run.
if [ "$MODE" = scope ] && inherited=$(bash ops/check-inherit.sh "$RECORDS" 2>/dev/null); then
  from=${inherited%% *}; why=${inherited#* }
  node ops/docs/render-status.mjs --check
  node ops/ci/test-globs-check.mjs apps/baink
  mkdir -p "$RECORDS"
  printf '{"commit":"%s","inherited_from":"%s","reason":"%s","passed_at":"%s"}\n' "$HEAD" "$from" "$why" "$(date -u +%FT%TZ)" > "$RECORDS/$HEAD.json"
  echo "CHECK PASSED for ${HEAD:0:10}: inherited from passed ${from:0:10} ($why)"
  exit 0
fi
# The files that make up this check. A change to them is never judged by the
# classifier of the same commit, which that commit could have edited (10 November
# 2026; ops/check-inherit.sh refuses them the same way).
touches_check() { # stdin: paths. Succeeds when one of them is part of this check.
  awk '$0 ~ "^ops/check[^/]*$" || index($0, "ops/ci-scope/") == 1 || index($0, ".githooks/") == 1 { hit = 1 } END { exit !hit }'
}
# The older rule, kept as a fallback: a documentation-only commit on top of a passed
# commit reuses that pass: walk back (at most 20 commits) to the newest passed
# ancestor and classify what changed since.
if [ "$MODE" = scope ]; then
  for c in $(git rev-list --max-count=20 HEAD~1 2>/dev/null); do
    [ -f "$RECORDS/$c.json" ] || continue
    if git diff --no-renames --name-only "$c" HEAD | touches_check; then break; fi
    since=$(git diff --name-only "$c" HEAD | node ops/ci-scope/classify.mjs | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).mode)')
    if [ "$since" = prose ]; then
      node ops/docs/render-status.mjs --check
      mkdir -p "$RECORDS"
      printf '{"commit":"%s","inherited_from":"%s","reason":"documentation-only since","passed_at":"%s"}\n' "$HEAD" "$c" "$(date -u +%FT%TZ)" > "$RECORDS/$HEAD.json"
      echo "CHECK PASSED for ${HEAD:0:10}: documentation-only since passed ${c:0:10}"
      exit 0
    fi
    break
  done
fi

# 1. Which suites.
PILOT="pilot:1:1 pilot:1:2 pilot:1:3"
case $MODE in
  all) specs="$PILOT others site" ;;
  list) specs=; for x in ${SUITES//,/ }; do [ "$x" = pilot ] && specs="$specs $PILOT" || specs="$specs $x"; done ;;
  scope)
    scope=$(git diff --name-only "$BASE" HEAD | node ops/ci-scope/classify.mjs)
    specs=$(node -e '
      const s=JSON.parse(require("fs").readFileSync(0,"utf8")),out=[];
      // A full-scope change runs the routine set; heavy suites run only when their own paths change.
      const c=s.mode==="full"?{pilot:true,others:true,site:true}:(s.checks??{});
      if(c.pilot)out.push("pilot:1:1","pilot:1:2","pilot:1:3");
      if(c.research)out.push("research:1");
      if(c.reset)out.push("reset:1");
      if(c.others||c.baink||c.organizations||c.custody||c.workerSigning)out.push("others");
      if(c.site)out.push("site");
      if(c.nativeChain)out.push("native-chain");
      if(c.privateExchange)out.push("private-exchange");
      console.log([...new Set(out)].join(" "));' <<<"$scope")
    echo "== scope: $(node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(s.mode+(s.reason?" ("+s.reason.slice(0,160)+")":""))' <<<"$scope")"
    if git diff --no-renames --name-only "$BASE" HEAD | touches_check; then
      # shellcheck disable=SC2086
      specs=$(printf '%s\n' $PILOT others site $specs | awk '!seen[$0]++' | paste -sd' ' -)
      echo "== the change touches the check itself: the routine suites run, whatever the classifier in this commit says"
    fi ;;
esac

# 2. Fast local checks.
echo "== local: release status, BAINK test globs"
node ops/docs/render-status.mjs --check
node ops/ci/test-globs-check.mjs apps/baink

# 3. Remote suites.
RUN=$(date -u +%Y%m%dT%H%M%SZ)-${HEAD:0:10}-$$
status=0
if [ -n "${specs// /}" ]; then
  echo "== $HOST: $specs"
  ssh "$HOST" 'install -d -m 0755 /opt/uain-checks/incoming'
  # The upload runs in the background and is waited for. bash runs a trap only
  # between foreground commands, so with the upload in the foreground a cancel
  # (USR1/HUP; SIGTERM stays ignored) waited for the upload to end: on 10 November
  # 2026 an upload that trickled at 2 MB a minute held a session for 40 minutes and
  # could not be cancelled. For the same reason it gives up after
  # UAIN_CHECK_UPLOAD_LIMIT seconds (default 600; a normal upload takes 1 to 3
  # minutes). Cancelled, too slow or failed, the partial snapshot is removed: no
  # remote run exists yet to remove it.
  UPLOAD_LIMIT=${UAIN_CHECK_UPLOAD_LIMIT:-600}
  # One upload at a time from this machine, compressed in transit. On 10 November
  # several sessions uploaded their 130 MB snapshots at once over one uplink of
  # about 1.2 MB a second: the newest connection took nearly all of it and the
  # older ones starved at 20 KB a second for 8 to 40 minutes. Taken in turn, an
  # upload is about a minute. The lock is a directory in the shared records folder.
  # A lock whose holder has gone, or that is older than the upload limit, is taken
  # over; if two waiters take it over at the same instant they both upload, which
  # is only what happened before.
  UPLOCK=$RECORDS/uploading
  unlock_upload() { if [ "$(cat "$UPLOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$UPLOCK"; fi; }
  trap 'rm -f "$KEY"; unlock_upload' EXIT
  told=
  while ! mkdir "$UPLOCK" 2>/dev/null; do
    holder=$(cat "$UPLOCK/pid" 2>/dev/null || true)
    if { [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; } ||
       [ -n "$(find "$UPLOCK" -maxdepth 0 -mmin "+$(( UPLOAD_LIMIT / 60 + 2 ))" 2>/dev/null)" ]; then
      rm -rf "$UPLOCK"; continue
    fi
    [ -n "$told" ] || { echo "== another check on this machine is uploading its snapshot (pid ${holder:-starting}); waiting for the line"; told=1; }
    sleep 2
  done
  echo $$ > "$UPLOCK/pid"
  ( git archive --format=tar HEAD | ssh -o Compression=yes "$HOST" "cat > /opt/uain-checks/incoming/$RUN.tar" ) &
  uppid=$!
  stop_upload() { # ends this upload's own processes (by parent id, never by name) and removes the snapshot
    pkill -P "$uppid" 2>/dev/null || true; kill "$uppid" 2>/dev/null || true
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "rm -f /opt/uain-checks/incoming/$RUN.tar" || true
  }
  trap 'echo "CHECK CANCELLED for ${HEAD:0:10}: interrupted during the upload. Not a test failure." >&2; stop_upload; exit 130' USR1 HUP
  upstart=$(date +%s)
  while kill -0 "$uppid" 2>/dev/null; do
    if [ $(( $(date +%s) - upstart )) -ge "$UPLOAD_LIMIT" ]; then
      echo "CHECK STOPPED for ${HEAD:0:10}: the snapshot upload to $HOST took longer than ${UPLOAD_LIMIT}s (a slow or stalled connection). Not a test failure. Run again." >&2
      stop_upload; exit 1
    fi
    sleep 1
  done
  if ! wait "$uppid"; then
    echo "CHECK STOPPED for ${HEAD:0:10}: the snapshot upload to $HOST failed. Not a test failure. Run again." >&2
    stop_upload; exit 1
  fi
  unlock_upload
  echo "== snapshot uploaded in $(( $(date +%s) - upstart ))s"
  started=$(date +%s)
  ssh "$HOST" bash -s -- "$RUN" $specs < ops/check-remote.sh &
  sshpid=$!
  cancel() {
    echo "CHECK CANCELLED for ${HEAD:0:10} (run $RUN): this process was interrupted. Not a test failure." >&2
    kill "$sshpid" 2>/dev/null || true
    # Drop the queue entry on the host if it is still waiting for a slot. A run that
    # has started is left to finish, because its containers hold the slot's files.
    ssh "$HOST" "RUN='$RUN' bash -s" <<'REMOTE' || true
for p in $(pgrep -f "bash -s -- $RUN"); do
  # Waiting for a slot: its only child is flock or, in the oldest-first queue, sleep.
  case "$(pgrep -P "$p" -l | awk '{print $2}' | sort -u | tr '\n' ',')" in flock,|sleep,) ;; *) continue ;; esac
  f=$(pgrep -P "$p"); kill -KILL "$p"; kill -TERM $f 2>/dev/null
  rm -f "/opt/uain-checks/incoming/$RUN.tar"
done
REMOTE
    exit 130
  }
  trap cancel USR1 INT HUP
  while :; do
    wait "$sshpid" && rc=0 || rc=$?
    [ "$rc" -eq 0 ] && break
    kill -0 "$sshpid" 2>/dev/null && continue   # a trapped signal interrupted the wait; the run goes on
    status=$rc; break
  done
  trap 'exit 130' USR1 INT HUP
  echo "== $(( $(date +%s) - started ))s on $HOST"
else
  echo "== no remote suites needed for these paths"
fi

# 4. Record.
if [ $status -eq 0 ]; then
  mkdir -p "$RECORDS"
  printf '{"commit":"%s","suites":"%s","host":"%s","run":"%s","passed_at":"%s"}\n' \
    "$HEAD" "$specs" "$HOST" "$RUN" "$(date -u +%FT%TZ)" > "$RECORDS/$HEAD.json"
  echo "CHECK PASSED for ${HEAD:0:10}: $specs (run $RUN)"
else
  echo "CHECK FAILED for ${HEAD:0:10} (run $RUN). Fix, commit and run again." >&2
fi
exit $status
