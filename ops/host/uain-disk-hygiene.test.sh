#!/usr/bin/env bash
# The hygiene tool never removes a test root that production names (FIXTURE:
# stand-ins for systemctl and docker; Linux only, it needs GNU find and df).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); }

ROOT=$T/test
mkdir -p "$T/bin" "$T/units/masked.service.d" "$T/sbin" "$T/custody/venv" "$T/custody/policies" "$ROOT"
for name in by-unit by-dropin by-running-unit by-stopped-unit by-masked-unit by-sbin by-custody by-policy plan plan-b only-in-key only-in-venv plain fresh marked; do
  mkdir -p "$ROOT/$name/logs"; echo data > "$ROOT/$name/file"; echo log > "$ROOT/$name/logs/run.log"
done
touch "$ROOT/marked/.keep"

cat > "$T/units/prod.service" <<EOF
[Service]
ExecStart=/usr/bin/tool --plan $ROOT/by-unit/plan.json
EOF
mkdir -p "$T/units/prod.service.d"
printf '[Service]\nReadWritePaths=%s/by-dropin/state\n' "$ROOT" > "$T/units/prod.service.d/override.conf"
printf '[Service]\nExecStart=/usr/bin/tor -f %s/by-running-unit/torrc\n' "$ROOT" > "$T/units/running.service"
printf '[Service]\nExecStart=/usr/bin/old %s/by-stopped-unit/x\n' "$ROOT" > "$T/units/retired.service"
ln -s /dev/null "$T/units/masked.service"
printf '[Service]\nExecStart=/usr/bin/old %s/by-masked-unit/x\n' "$ROOT" > "$T/units/masked.service.d/x.conf"
printf '#!/bin/sh\nexec /usr/bin/thing %s/by-sbin/input "$@"\n' "$ROOT" > "$T/sbin/uain-thing"
printf "PLAN='%s/by-custody/plan.json'\n" "$ROOT" > "$T/custody/evidence.py"
printf '{"policy_dir": "%s/by-policy/policies"}\n' "$ROOT" > "$T/custody/policies/rule.json"
printf "PLAN='%s/plan-b/plan.json'\n" "$ROOT" > "$T/custody/other.py"
# Never opened: a key file and an installed virtual environment.
printf 'path %s/only-in-key\n' "$ROOT" > "$T/custody/backup_ed25519"
printf 'path %s/only-in-venv\n' "$ROOT" > "$T/custody/venv/lib.py"

cat > "$T/bin/systemctl" <<'EOF'
#!/bin/sh
# is-enabled / is-active --quiet <unit>
case "$1 $3" in
  "is-enabled prod.service") exit 0 ;;
  "is-active running.service") exit 0 ;;
  *) exit 1 ;;
esac
EOF
cat > "$T/bin/docker" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$T/bin/systemctl" "$T/bin/docker"

# Everything but "fresh" last changed two days ago.
find "$ROOT" -mindepth 1 ! -path "$ROOT/fresh*" -exec touch -d '2 days ago' {} +

hygiene() {
  PATH="$T/bin:$PATH" UAIN_TEST_ROOT=$ROOT UAIN_CHECK_INCOMING=$T/incoming UAIN_TEST_LOG_ARCHIVE=$T/logs \
    UAIN_HYGIENE_UNIT_DIR=$T/units UAIN_HYGIENE_REFERENCE_DIRS="$T/sbin $T/custody $T/absent" \
    bash "$here/uain-disk-hygiene.sh" "$@"
}

# A dry run removes nothing and names what it would keep.
out=$(DRY_RUN=1 hygiene)
for name in by-unit by-dropin by-running-unit by-stopped-unit by-masked-unit by-sbin by-custody by-policy plan plan-b only-in-key only-in-venv plain fresh marked; do
  [ -d "$ROOT/$name" ] || fail "dry run removed $name"
done
ok
grep -q "DRY: rm -rf --one-file-system -- $ROOT/plain" <<< "$out" || fail "dry run does not plan to remove the plain stale root"; ok

# --who-names answers for a path inside a root, and says who.
if who=$(hygiene --who-names "$ROOT/by-unit/plan.json"); then fail "--who-names exit 0 for a named root"; fi
who=$(hygiene --who-names "$ROOT/by-unit/plan.json" || true)
grep -q "$T/units/prod.service" <<< "$who" || fail "--who-names does not name the unit: $who"; ok
hygiene --who-names "$ROOT/plain/file" > /dev/null || fail "--who-names refused an unnamed root"; ok
set +e; hygiene --who-names /somewhere/else > /dev/null 2>&1; status=$?; set -e
[ "$status" = 2 ] || fail "--who-names outside the root exits $status, not 2"; ok
[ -d "$ROOT/plain" ] || fail "--who-names removed something"; ok

out=$(hygiene)
# Kept: named by an enabled unit, its drop-in, a running (even disabled) unit,
# a script in sbin, a custody helper and a policy file.
for name in by-unit by-dropin by-running-unit by-sbin by-custody by-policy plan-b; do
  [ -f "$ROOT/$name/file" ] || fail "removed $name, which production names"
  grep -q "keeping $ROOT/$name: named by " <<< "$out" || fail "no reason logged for keeping $name"
  ok
done
grep -q "keeping $ROOT/by-unit: named by $T/units/prod.service " <<< "$out" || fail "the naming unit is not shown"; ok
# Removed: unnamed, named only by a stopped or masked unit, only a shared name
# prefix (plan versus plan-b), or named only in files that are never opened.
for name in plain by-stopped-unit by-masked-unit plan only-in-key only-in-venv; do
  [ ! -e "$ROOT/$name" ] || fail "kept $name, which nothing in production names"; ok
done
# Unchanged rules: a fresh root and a marked root stay.
[ -d "$ROOT/fresh" ] || fail "removed a root changed today"; ok
[ -d "$ROOT/marked" ] || fail "removed a root marked .keep"; ok
[ -f "$T/logs/plain-logs.tar.gz" ] || fail "the removed root's small logs were not kept"; ok

echo "uain-disk-hygiene.test.sh: $pass assertions passed"
