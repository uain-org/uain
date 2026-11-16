#!/usr/bin/env bash
# Rehearse a server upgrade on uain-app-1 before merging: the old code
# writes a store, then the new code starts on it. Like run.sh, it runs in a
# capped throwaway container against the test-only PostgreSQL, never
# production's.
#
#   ops/remote-test/rehearse.sh <checkout> [old-ref]
#
#   checkout  the branch's working tree; its committed HEAD is used
#   old-ref   what production runs now (default: origin/main)
#
# It checks what the shipping rule asks of every server change:
# - the new code starts on the old store (/api/ready);
# - the ledger key is unchanged;
# - an old session still works (/api/next with the old side's token);
# - old rows read back (the contested contribution, via the API);
# - verify-ledger passes against the new server.
# The log stays in /opt/uain-test/rehearse-<run>.log on the host; it exits 1 if any check fails.
set -euo pipefail

HOST=${UAIN_TEST_HOST:-uain-app-1}
SRC=$(cd "${1:?usage: rehearse.sh <checkout> [old-ref]}" && pwd)
OLD=${2:-origin/main}
# Per-run folder, database and port, so parallel sessions never share or delete
# each other's rehearsal (9 Nov 2026). The log is kept; the trees are removed.
RUN=$(date -u +%Y%m%dT%H%M%S)-$$
DEST=/opt/uain-test/rehearse-$RUN
DB=uain_rehearsal_$(echo "$RUN" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '_')
PORT=$((20000 + RANDOM % 20000))
HERE=$(cd "$(dirname "$0")" && pwd)

git -C "$SRC" fetch -q origin
echo "== old: $(git -C "$SRC" log --oneline -1 "$OLD")"
echo "== new: $(git -C "$SRC" log --oneline -1 HEAD)"
ssh "$HOST" "rm -rf $DEST && mkdir -p $DEST/old $DEST/new"
git -C "$SRC" archive "$OLD" | ssh "$HOST" "tar -x -C $DEST/old"
git -C "$SRC" archive HEAD | ssh "$HOST" "tar -x -C $DEST/new"
scp -q "$HERE/rehearse-driver.mjs" "$HOST:$DEST/old/services/pilot/scripts/rehearse-driver.mjs"

ssh "$HOST" bash -s -- "$DEST" "$DB" "$PORT" <<'REMOTE'
set -euo pipefail
DEST=$1 DB=$2 PORT=$3
# Made by run.sh on first use; made here too, so a rehearsal can come first.
if ! docker inspect uain-test-pg >/dev/null 2>&1; then
  docker run -d --name uain-test-pg --restart unless-stopped \
    --memory 2g --cpus 2 --tmpfs /var/lib/postgresql/data:rw,size=4g \
    -e POSTGRES_USER=uain -e POSTGRES_PASSWORD=uain-test-only \
    -p 127.0.0.1:55433:5432 --label uain.purpose=tests postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 >/dev/null
fi
docker start uain-test-pg >/dev/null
for i in $(seq 1 30); do docker exec uain-test-pg pg_isready -U uain >/dev/null 2>&1 && break; sleep 1; done
set +e
# Branch code on the host network: no privilege gain, no raw sockets
# (security review IN-2). apk keeps the file capabilities it uses and
# SYS_CHROOT (it runs package scripts and triggers in a chroot).
docker run --rm --name "uain-rehearse-$$" --network host \
  --security-opt no-new-privileges --pids-limit 2048 \
  --cap-drop NET_RAW --cap-drop NET_ADMIN --cap-drop MKNOD \
  --cap-drop AUDIT_WRITE --cap-drop SETPCAP \
  --memory 6g --cpus 4 --label uain.purpose=tests \
  -e DB="$DB" -e RPORT="$PORT" \
  -v "$DEST":/w -v uain-test-npm-cache:/root/.npm \
  node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 sh -c '
set -e
apk add --no-cache --quiet curl postgresql17-client >/dev/null
export PGPASSWORD=uain-test-only
psql -h 127.0.0.1 -p 55433 -U uain -d postgres -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
export DATABASE_URL=postgres://uain:uain-test-only@127.0.0.1:55433/$DB
# The driver signs unbound proofs; bound ones are required by default since audit E-8.
export PORT=$RPORT HOST=127.0.0.1 UAIN_DATA_DIR=/w/data UAIN_BASE=http://127.0.0.1:$RPORT UAIN_REQUIRE_BOUND_PROOFS=0
mkdir -p /w/data
for side in old new; do
  (cd /w/$side/services/pilot && npm ci --no-audit --no-fund --silent && npm run --silent build) >/w/build-$side.log 2>&1 \
    || { echo "build $side failed"; tail -20 /w/build-$side.log; exit 1; }
done
up() { for i in $(seq 1 60); do curl -sf $UAIN_BASE/api/ready >/dev/null && return 0; sleep 1; done; return 1; }

cd /w/old/services/pilot
node dist/src/api/server.js >/w/server-old.log 2>&1 &
PID=$!
up || { echo "old server did not start"; tail -20 /w/server-old.log; exit 1; }
RH_OUT=/w/old.json node scripts/rehearse-driver.mjs
kill $PID; wait $PID 2>/dev/null || true
KEY=$(sha256sum /w/data/ledger.key | cut -c1-16)

cd /w/new/services/pilot
node dist/src/api/server.js >/w/server-new.log 2>&1 &
PID=$!
up && echo "new server ready on the old store: yes" || { echo "new server ready: NO"; tail -20 /w/server-new.log; exit 1; }
[ "$KEY" = "$(sha256sum /w/data/ledger.key | cut -c1-16)" ] && echo "ledger key unchanged: yes" || echo "ledger key unchanged: NO"
TOKEN=$(node -p "require(\"/w/old.json\").token")
AUTHOR=$(node -p "require(\"/w/old.json\").author")
CONTESTED=$(node -p "require(\"/w/old.json\").contested")
curl -s -H "Authorization: Bearer $TOKEN" $UAIN_BASE/api/next | grep -q "\"$AUTHOR\"" \
  && echo "old session works: yes" || echo "old session works: NO"
curl -s $UAIN_BASE/api/contributions/$CONTESTED | grep -q "\"contested\"" \
  && echo "old contested row reads back: yes" || echo "old contested row reads back: NO"
UAIN_API=$UAIN_BASE node scripts/verify-ledger.mjs 2>&1 | grep -E "^(PASS|FAIL)" || echo "verify-ledger: no verdict"
grep -iE "error" /w/server-new.log | grep -v ExperimentalWarning | head -3 || true
kill $PID; wait $PID 2>/dev/null || true
psql -h 127.0.0.1 -p 55433 -U uain -d postgres -q -c "DROP DATABASE IF EXISTS $DB" || true
' 2>&1 | tee "$DEST/rehearse.log"
status=${PIPESTATUS[0]}
cp "$DEST/rehearse.log" "/opt/uain-test/rehearse-$(basename "$DEST" | cut -d- -f2-).log" 2>/dev/null || true
rm -rf "$DEST"
# Any failed check fails the rehearsal (audit 13-B.4: it used to exit 0 regardless).
if [ "$status" -ne 0 ] || grep -qE ': NO$|^FAIL|no verdict|ready: NO' "/opt/uain-test/rehearse-$(basename "$DEST" | cut -d- -f2-).log"; then echo "REHEARSAL FAILED"; exit 1; fi
echo "REHEARSAL PASSED"
REMOTE
