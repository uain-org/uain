#!/usr/bin/env bash
# Run UAIN's test suites on the app server, uain-app-1, in throwaway
# containers, instead of on a laptop. Everything runs with memory and CPU
# limits, against a test-only PostgreSQL that is not production's (production's
# is on uain-db-1). The host is the ssh alias uain-app-1 (root@66.206.20.78);
# set UAIN_TEST_HOST to use another.
#
#   ops/remote-test/run.sh [--suite pilot|pilot-thread|site|all] [checkout]
#
#   checkout  a working tree to test (default: this repository's root).
#             It is copied with rsync, without node_modules, .git or build
#             output (including native chain binaries), to /opt/uain-test/<name>
#             on the host.
#   --suite   pilot         npm test in services/pilot
#             pilot-thread  the same with UAIN_WRITE_THREAD=1
#             site          npm ci (root and services/pilot, whose build the website
#                           build runs first) and npm run build for the website
#             all           both backend passes and the site (the default)
# Legacy waitlist checks are manual only; see services/pilot/test/legacy/README.md.
#
# The test database is a container named uain-test-pg (postgres:17-alpine),
# bound to 127.0.0.1:55433 on the host only, with its data in memory, capped
# at 2 GB and 2 CPUs. It is made on first use and left running. Each suite
# runs in a new node:22-alpine container (6 GB, 4 CPUs) that is removed after.
# Containers carry uain.purpose=tests and this invocation's uain.run id; an
# interrupted run removes only its own. The npm cache volume
# uain-test-npm-cache-v2 is capped at 4 GiB and rebuilt on corruption (see
# docs/engineering/ci-resources.md).
# Logs stay in /opt/uain-test/<name>/logs on the host; the summary is printed.
set -euo pipefail

HOST=${UAIN_TEST_HOST:-uain-app-1}
SUITE=all
if [ "${1:-}" = --suite ]; then SUITE=$2; shift 2; fi
case $SUITE in
  pilot|pilot-thread|site|all) ;;
  *) echo "unknown suite $SUITE" >&2; exit 2 ;;
esac
SRC=$(cd "${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" && pwd)
# A trailing '-' is literal in both GNU and BSD tr ('_-\n' is a range in GNU tr).
NAME=$(basename "$SRC" | tr -c 'a-zA-Z0-9_\n-' '-')
DEST=/opt/uain-test/$NAME
PG_URL='postgres://uain:uain-test-only@127.0.0.1:55433/postgres'

# Never wait on an interactive prompt (unknown host key, key passphrase): a
# first connection from a terminal could sit there with no visible output.
# BatchMode fails at once with ssh's own reason; ConnectTimeout bounds the dial.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
ssh() { command ssh "${SSH_OPTS[@]}" "$@"; }
echo "== copying $SRC to $HOST:$DEST"
ssh "$HOST" "mkdir -p $DEST/logs"
rsync -a --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .git --exclude dist --exclude .next \
  --exclude 'chain/bin/' \
  --exclude 'work/' --exclude '.claude/' --exclude logs --exclude '.env*' \
  "$SRC"/ "$HOST:$DEST/"

ssh "$HOST" bash -s -- "$DEST" "$SUITE" "$PG_URL" <<'REMOTE'
set -euo pipefail
DEST=$1 SUITE=$2 PG_URL=$3
if ! docker inspect uain-test-pg >/dev/null 2>&1; then
  docker run -d --name uain-test-pg --restart unless-stopped \
    --memory 2g --cpus 2 --tmpfs /var/lib/postgresql/data:rw,size=4g \
    -e POSTGRES_USER=uain -e POSTGRES_PASSWORD=uain-test-only \
    -p 127.0.0.1:55433:5432 --label uain.purpose=tests postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 >/dev/null
fi
docker start uain-test-pg >/dev/null
for i in $(seq 1 30); do docker exec uain-test-pg pg_isready -U uain >/dev/null 2>&1 && break; sleep 1; done

# Every container this invocation starts carries its own run id. On exit,
# interruption or a dropped ssh session, only containers with that id are
# removed; the shared database, other runs and unlabelled resources are kept.
RUN_ID=run-$(date +%s)-$$-$RANDOM
cleanup() {
  local ids
  ids=$(docker ps -aq --filter "label=uain.run=$RUN_ID" || true)
  if [ -n "$ids" ]; then docker rm -f $ids >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# The npm cache is shared between runs, so it is bounded and replaceable: it
# is rebuilt when it outgrows CACHE_CAP or when an install reports a damaged
# cache. Only a volume labelled as a test cache is ever removed.
CACHE=uain-test-npm-cache-v2
CACHE_CAP=$((4 * 1024 * 1024 * 1024))
CORRUPT='EINTEGRITY|ECOMPROMISED|integrity checksum failed|TAR_BAD_ARCHIVE|TAR_ENTRY_INVALID|zlib: (unexpected end|invalid)|Unexpected end of JSON input|ENOENT[^ ]* .*_cacache'
cache_reset() {
  if docker volume inspect "$CACHE" >/dev/null 2>&1; then
    [ "$(docker volume inspect --format '{{index .Labels "uain.purpose"}}' "$CACHE")" = tests ] \
      || { echo "refusing to remove unlabelled volume $CACHE" >&2; return 1; }
    docker volume rm "$CACHE" >/dev/null
  fi
  docker volume create --label uain.purpose=tests --label uain.cache=npm "$CACHE" >/dev/null
}
if ! docker volume inspect "$CACHE" >/dev/null 2>&1; then cache_reset; fi
cache_bytes=$(du -sb "$(docker volume inspect --format '{{.Mountpoint}}' "$CACHE")" 2>/dev/null | cut -f1)
if [ "${cache_bytes:-0}" -gt "$CACHE_CAP" ]; then echo "npm cache ${cache_bytes} bytes exceeds cap; rebuilding"; cache_reset; fi

run_once() { # name workdir env command log
  # Branch code on the host network: no privilege gain, no raw sockets
  # (security review IN-2). apk keeps the file capabilities it uses and
  # SYS_CHROOT (it runs package scripts and triggers in a chroot).
  docker run --rm --name "uain-test-$1-$$" --network host \
    --security-opt no-new-privileges --pids-limit 2048 \
    --cap-drop NET_RAW --cap-drop NET_ADMIN --cap-drop MKNOD \
    --cap-drop AUDIT_WRITE --cap-drop SETPCAP \
    --memory 6g --cpus 4 --label uain.purpose=tests --label "uain.run=$RUN_ID" \
    -v "$DEST":/work -v "$CACHE":/root/.npm -w "/work/$2" \
    -e UAIN_TEST_PG="$PG_URL" -e CI=1 $3 \
    node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 sh -c "apk add --no-cache --quiet curl postgresql17-client >/dev/null && $4" > "$5" 2>&1
}
run() { # name workdir env command
  local name=$1 dir=$2 env=$3 cmd=$4 log=$DEST/logs/$1.log code=0
  run_once "$name" "$dir" "$env" "$cmd" "$log" || code=$?
  if [ "$code" != 0 ] && grep -qE "$CORRUPT" "$log"; then
    echo "$name: npm cache damaged; rebuilding the cache and retrying once"
    cache_reset
    code=0
    run_once "$name" "$dir" "$env" "$cmd" "$log" || code=$?
  fi
  local summary; summary=$(grep -E '^# (tests|pass|fail) ' "$log" | tr '\n' ' ' || true)
  grep -q SITE_BUILD_OK "$log" && summary="site build ok"
  echo "$name: exit $code ${summary:-(no test summary; see $log)}"
  grep -E '^not ok|^    not ok' "$log" | head -5 || true
  return "$code"
}
PILOT='npm ci --no-audit --no-fund --silent && npm test'
case $SUITE in
  pilot) run pilot services/pilot "" "$PILOT" ;;
  pilot-thread) run pilot-thread services/pilot "-e UAIN_WRITE_THREAD=1" "$PILOT" ;;
  site) run site . "" 'npm ci --no-audit --no-fund --silent && npm --prefix services/pilot ci --no-audit --no-fund --silent && npm run build && echo SITE_BUILD_OK' ;;
  all)
    run pilot services/pilot "" "$PILOT"
    run pilot-thread services/pilot "-e UAIN_WRITE_THREAD=1" "npm test"
    run site . "" 'npm ci --no-audit --no-fund --silent && npm --prefix services/pilot ci --no-audit --no-fund --silent && npm run build && echo SITE_BUILD_OK' ;;
  *) echo "unknown suite $SUITE"; exit 2 ;;
esac
echo "logs: $DEST/logs on $(hostname)"
REMOTE
