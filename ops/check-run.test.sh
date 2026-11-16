#!/usr/bin/env bash
# Tests the caller side of ops/check.sh with a stand-in for ssh (no host is contacted).
# Run from the repository: bash ops/check-run.test.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/rec"
cat > "$T/bin/ssh" <<'SH'
#!/usr/bin/env bash
shift
case "$*" in
  *"bash -s -- "*) cat >/dev/null; echo run >> "$FAKE_LOG"; sleep "${FAKE_RUN_SECONDS:-2}"; exit "${FAKE_RUN_RC:-0}" ;;
  *"cat > "*) cat >/dev/null; echo upload >> "$FAKE_LOG"; sleep "${FAKE_UPLOAD_SECONDS:-0}"; exit "${FAKE_UPLOAD_RC:-0}" ;;
  *"bash -s"*) cat >/dev/null; echo cleanup >> "$FAKE_LOG" ;;
  *"rm -f /opt/uain-checks/incoming/"*) echo removed >> "$FAKE_LOG" ;;
  *) : ;;
esac
SH
chmod +x "$T/bin/ssh"
export FAKE_LOG=$T/log; : > "$FAKE_LOG"
run() { PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" bash ops/check.sh "$@" >"$T/out" 2>&1; }
HEAD=$(git rev-parse HEAD); REC=$T/rec/$HEAD.json
fail=0
ok() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1 (want $2, got $3)"; sed 's/^/    /' "$T/out" | tail -5; fail=1; fi; }
reset() { rm -f "$REC"; : > "$FAKE_LOG"; }

reset; run --suites site; rc=$?
ok "a passing run exits 0" 0 $rc; ok "and records the pass" yes "$([ -f "$REC" ] && echo yes || echo no)"

reset; FAKE_RUN_RC=1 run --suites site; rc=$?
ok "a failing run exits 1" 1 $rc; ok "and records nothing" no "$([ -f "$REC" ] && echo yes || echo no)"

reset; PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" FAKE_RUN_SECONDS=5 bash ops/check.sh --suites site >"$T/out" 2>&1 & pid=$!
sleep 3; kill -TERM $pid; sleep 1; kill -TERM $pid; wait $pid; rc=$?
ok "SIGTERM does not end a run" 0 $rc; ok "and the pass is still recorded" yes "$([ -f "$REC" ] && echo yes || echo no)"

reset; PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" FAKE_RUN_SECONDS=30 bash ops/check.sh --suites site >"$T/out" 2>&1 & pid=$!
sleep 3; kill -USR1 $pid; wait $pid; rc=$?
ok "SIGUSR1 cancels a run with exit 130" 130 $rc
ok "a cancelled run records nothing" no "$([ -f "$REC" ] && echo yes || echo no)"
ok "a cancelled run drops its queue entry on the host" 1 "$(grep -c cleanup "$FAKE_LOG")"

reset; PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" FAKE_RUN_SECONDS=6 bash ops/check.sh --suites site >"$T/out1" 2>&1 & pid=$!
sleep 3; run --suites site; rc=$?; wait $pid
ok "a second check of the same commit waits for the first" 0 $rc
ok "and says so" 1 "$(grep -c "already being checked" "$T/out")"
ok "and does not queue another run" 1 "$(grep -c run "$FAKE_LOG")"

reset; echo '{"commit":"x"}' > "$REC"; run; rc=$?
ok "a commit already recorded passes at once" 0 $rc
ok "without contacting the host" 0 "$(grep -c run "$FAKE_LOG")"

# The upload: cancellable at once, and it gives up when it is too slow (10 November 2026).
reset; PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" FAKE_UPLOAD_SECONDS=30 bash ops/check.sh --suites site >"$T/out" 2>&1 & pid=$!
sleep 3; t0=$(date +%s); kill -USR1 $pid; wait $pid; rc=$?; took=$(( $(date +%s) - t0 ))
ok "SIGUSR1 during the upload cancels with exit 130" 130 $rc
ok "at once, not when the upload ends" yes "$([ "$took" -le 5 ] && echo yes || echo no)"
ok "removes the partial snapshot" 1 "$(grep -c removed "$FAKE_LOG")"
ok "and starts no run" 0 "$(grep -c run "$FAKE_LOG")"

reset; UAIN_CHECK_UPLOAD_LIMIT=2 FAKE_UPLOAD_SECONDS=30 run --suites site; rc=$?
ok "an upload slower than the limit stops the check with exit 1" 1 $rc
ok "says it was the upload" 1 "$(grep -c "snapshot upload to fake took longer" "$T/out")"
ok "removes the partial snapshot" 1 "$(grep -c removed "$FAKE_LOG")"
ok "and starts no run" 0 "$(grep -c run "$FAKE_LOG")"

reset; FAKE_UPLOAD_RC=1 run --suites site; rc=$?
ok "a failed upload stops the check with exit 1" 1 $rc
ok "says the upload failed" 1 "$(grep -c "snapshot upload to fake failed" "$T/out")"
ok "and starts no run" 0 "$(grep -c run "$FAKE_LOG")"
ok "and gives the upload line back" no "$([ -d "$T/rec/uploading" ] && echo yes || echo no)"

# One upload at a time from this machine.
reset; PATH="$T/bin:$PATH" UAIN_TEST_HOST=fake UAIN_CHECK_RECORDS="$T/rec" FAKE_UPLOAD_SECONDS=5 bash ops/check.sh --suites site >"$T/out1" 2>&1 & pid=$!
sleep 2; run --suites others; rc=$?; wait $pid; rc1=$?
ok "a second check waits while another uploads" 1 "$(grep -c "is uploading its snapshot" "$T/out")"
ok "then uploads and passes" 0 $rc
ok "and the first passes too" 0 $rc1
ok "both uploaded" 2 "$(grep -c upload "$FAKE_LOG")"
ok "and the upload line is free afterwards" no "$([ -d "$T/rec/uploading" ] && echo yes || echo no)"

reset; mkdir -p "$T/rec/uploading"; echo 999999 > "$T/rec/uploading/pid"; run --suites site; rc=$?
ok "a line left by a check that has gone is taken over" 0 $rc
ok "without waiting" 0 "$(grep -c "is uploading its snapshot" "$T/out")"
exit $fail
