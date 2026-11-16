#!/usr/bin/env bash
# A backup and restore drill on this machine's Docker, through the same
# backup.sh and restore.sh production runs. Local only; CI does not run it.
#
#   npm --prefix services/pilot run build
#   ops/backup/drill.sh            against a disposable PostgreSQL 17 container
#   ops/backup/drill.sh compose    through Docker Compose, as on the server
#
# The default drill:
# 1. Makes a database of its own (uain_backupdrill_src_…), boots the
#    connection server on it and gives it a small network, then keeps
#    writing to it (services/pilot/scripts/backup-drill-traffic.mjs).
# 2. Backs it up four times while the writes go on: twice on disk only, then
#    with an off-host copy to a stand-in S3 server (the pinned rclone image
#    serving a local folder over the S3 API), then with a wrong S3 secret,
#    which must fail the run. Keeps two, so pruning is exercised.
# 3. check passes, and fails on a backup too old or changed on disk.
# 4. Restores the off-host copy into new databases (uain_backupdrill_…):
#    a wrong backup key, an existing database and a wrong pinned ledger key
#    must each fail; then every table must match the snapshot sealed in the
#    backup, and verify-ledger.mjs must pass against the key pinned before
#    the backup.
# Every database it made is dropped at the end, pass or fail.
#
# The compose drill builds the pilot image as uain-pilot:backupdrill, runs
# Compose projects uain-backupdrill-live (db and two pilots) and
# uain-backupdrill-restore, neither with a published port, backs the first
# up through docker compose exec while it is written to, restores into the
# second, and removes both projects and the image at the end.
#
# Settings: UAIN_DRILL_CONTAINER (default uain-demo-pg); UAIN_DRILL_PG, a URL
# to that server's maintenance database from this host (default
# postgres://uain:uain-demo-local@127.0.0.1:55433/postgres); UAIN_DRILL_S3=0
# leaves out the off-host copy.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cd "$repo"

mode=${1:-container}
container=${UAIN_DRILL_CONTAINER:-uain-demo-pg}
admin_url=${UAIN_DRILL_PG:-postgres://uain:uain-demo-local@127.0.0.1:55433/postgres}
with_s3=${UAIN_DRILL_S3:-1}
user=$(printf '%s' "$admin_url" | sed -E 's|^postgres://([^:@/]+).*|\1|')
stamp=$(date -u +%Y%m%d%H%M%S)_$$
databases=''
live=uain-backupdrill-live
restored=uain-backupdrill-restore
rclone_image=$(sed -nE "s/^RCLONE_IMAGE='([^']+)'$/\1/p" ops/backup/backup.sh)

say() { echo "drill: $*"; }
die() {
  echo "drill: FAIL: $*" >&2
  exit 1
}

sql() {
  docker exec -i "$container" psql --username "$user" --dbname postgres -v ON_ERROR_STOP=1 -Atqc "$1" < /dev/null
}
drop() {
  case $1 in
    uain_backupdrill_*) sql "DROP DATABASE IF EXISTS $1 WITH (FORCE)" ;;
    *) die "refusing to drop $1" ;;
  esac
}

[ -f services/pilot/dist/src/operations/backup-cli.js ] ||
  die 'build the server first: npm --prefix services/pilot run build'
work=$(mktemp -d "${TMPDIR:-/tmp}/uain-drill.XXXXXX")
traffic='' s3_server='' compose_up=''
cleanup() {
  local status=$? d
  if [ -n "$traffic" ]; then
    kill -TERM "$traffic" 2> /dev/null || true
    wait "$traffic" 2> /dev/null || true
  fi
  [ -z "$s3_server" ] || docker stop "$s3_server" > /dev/null 2>&1 || true
  for d in $databases; do drop "$d" || true; done
  if [ -n "$compose_up" ]; then
    docker compose -p "$live" down -v > /dev/null 2>&1 || true
    docker compose -p "$restored" down -v > /dev/null 2>&1 || true
    docker image rm uain-pilot:backupdrill > /dev/null 2>&1 || true
  fi
  rm -rf "$work"
  if [ "$status" -eq 0 ]; then say 'PASS; everything it made is removed'; else say 'failed; everything it made is removed'; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

key=$(openssl rand -hex 32)
mkdir -m 700 "$work/backups"

# The settings production gets. Anything the caller's shell has set for real
# backups is left out.
clean_env() {
  env -u GITHUB_ACTIONS -u UAIN_BACKUP_S3_ENDPOINT -u UAIN_BACKUP_S3_BUCKET -u UAIN_BACKUP_S3_PREFIX \
    -u UAIN_BACKUP_S3_REGION -u UAIN_BACKUP_S3_ACCESS_KEY_ID -u UAIN_BACKUP_S3_SECRET_ACCESS_KEY \
    -u UAIN_BACKUP_DB_CONTAINER -u UAIN_RESTORE_PROJECT -u UAIN_BACKUP_KEEP -u UAIN_BACKUP_MAX_AGE_HOURS \
    UAIN_BACKUP_KEY="$key" UAIN_BACKUP_DIR="$work/backups" "$@"
}
count() { find "$work/backups" -name "$1" | wc -l | tr -d ' '; }
newest() { find "$work/backups" -name '*.uainbk' | sort | tail -n 1 | xargs basename; }

check_checks() {
  clean_env bash ops/backup/backup.sh check
  if clean_env UAIN_BACKUP_MAX_AGE_HOURS=0 bash ops/backup/backup.sh check > /dev/null 2>&1; then
    die 'check passed a backup older than its limit'
  fi
  mkdir -m 700 "$work/changed"
  cp -p "$work/backups/"* "$work/changed/"
  printf 'x' | dd of="$work/changed/$(newest)" bs=1 seek=100 conv=notrunc 2> /dev/null
  if clean_env UAIN_BACKUP_DIR="$work/changed" bash ops/backup/backup.sh check > /dev/null 2>&1; then
    die 'check passed a backup changed on disk'
  fi
  say 'check fails on a backup too old, and on one changed on disk'
}

drill_container() {
  local src dst pin src_url restore_from restore_file uploaded s3_ip kept live_events
  case $admin_url in
    postgres://*@127.0.0.1:*/* | postgres://*@localhost:*/*) ;;
    *) die 'UAIN_DRILL_PG must name a PostgreSQL on this machine' ;;
  esac
  local version
  version=$(sql 'SHOW server_version_num') || die "cannot reach PostgreSQL in container $container"
  case $version in 17*) ;; *) die "expects PostgreSQL 17 in $container, found $version" ;; esac
  src=uain_backupdrill_src_$stamp
  dst=uain_backupdrill_restore_$stamp
  pin=uain_backupdrill_wrongpin_$stamp
  # Dropped at the end, pass or fail.
  databases="$src $dst $pin"

  # 1. The source network, written to throughout the backups.
  sql "CREATE DATABASE $src TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
  mkdir -m 700 "$work/data"
  src_url=${admin_url%/*}/$src
  (
    cd services/pilot
    DATABASE_URL=$src_url UAIN_DATA_DIR=$work/data UAIN_WRITE_THREAD=1 \
      exec node scripts/backup-drill-traffic.mjs "$work/pinned.pem"
  ) > "$work/traffic.log" 2>&1 &
  traffic=$!
  for _ in $(seq 1 240); do
    [ -s "$work/pinned.pem" ] && break
    kill -0 "$traffic" 2> /dev/null || {
      cat "$work/traffic.log" >&2
      die 'the source server did not start'
    }
    sleep 0.5
  done
  [ -s "$work/pinned.pem" ] || die 'the source network was not ready in two minutes'
  say "source $src is up and being written to; ledger key pinned from it before any backup"

  # 2. Backups, pointed at the container instead of the Compose project.
  backup() {
    clean_env UAIN_BACKUP_KEEP=2 UAIN_BACKUP_DB_CONTAINER="$container" UAIN_BACKUP_DB_NAME="$src" \
      UAIN_BACKUP_DB_USER="$user" DATABASE_URL="$src_url" UAIN_DATA_DIR="$work/data" "$@" \
      bash ops/backup/backup.sh run
  }
  backup
  sleep 1
  backup
  restore_from=$work/backups
  if [ "$with_s3" = 1 ]; then
    # A stand-in for the S3-compatible store: rclone serving a local folder
    # over the S3 API, on Docker's own network, with no port published.
    mkdir -p "$work/offsite/uain-drill"
    s3_server=$(docker run -d --rm --user "$(id -u):$(id -g)" -v "$work/offsite:/data" "$rclone_image" \
      serve s3 /data --addr :8080 --auth-key drillaccess,drillsecret)
    s3_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$s3_server")
    sleep 2
    local s3=(UAIN_BACKUP_S3_ENDPOINT="http://$s3_ip:8080" UAIN_BACKUP_S3_BUCKET=uain-drill
      UAIN_BACKUP_S3_PREFIX=/nightly/ UAIN_BACKUP_S3_ACCESS_KEY_ID=drillaccess)
    backup "${s3[@]}" UAIN_BACKUP_S3_SECRET_ACCESS_KEY=drillsecret
    uploaded=$(newest)
    cmp "$work/backups/$uploaded" "$work/offsite/uain-drill/nightly/$uploaded" ||
      die 'the off-host copy differs from the backup'
    cmp "$work/backups/${uploaded%.uainbk}.json" "$work/offsite/uain-drill/nightly/${uploaded%.uainbk}.json" ||
      die 'the off-host manifest differs'
    say "off-host copy of $uploaded is byte for byte the same"
    sleep 1
    if backup "${s3[@]}" UAIN_BACKUP_S3_SECRET_ACCESS_KEY=wrong-secret > "$work/bad-upload.log" 2>&1; then
      die 'a run whose upload failed reported success'
    fi
    grep -q 'the off-host copy of .* failed' "$work/bad-upload.log" || die 'the failed upload was not reported'
    say "a wrong S3 secret fails the run, and the backup it made is kept: $(newest)"
    restore_from=$work/offsite/uain-drill/nightly
    restore_file=$uploaded
  else
    sleep 1
    backup
    sleep 1
    backup
    restore_file=$(newest)
  fi
  kept=$(count '*.uainbk')
  [ "$kept" = 2 ] || die "expected 2 backups kept, found $kept"
  [ "$(count '*.json')" = 2 ] || die 'expected one manifest per backup'
  [ "$(count '*partial*')" = 0 ] || die 'a partial file was left behind'
  case $(ls -ld "$work/backups/$(newest)") in -rw-------*) ;; *) die 'a backup is readable by others' ;; esac
  say 'pruned to the newest 2 of 4, each with its manifest, all mode 0600'

  # 3. The freshness check, and its two failures.
  check_checks

  kill -TERM "$traffic"
  wait "$traffic" || die 'the source server did not stop cleanly'
  traffic=''
  say "source traffic stopped after enrolling $(sed -n 's/^wrote //p' "$work/traffic.log") members during the backups"

  # 4. Restore: refused three ways, then done.
  restore() {
    clean_env UAIN_BACKUP_DB_CONTAINER="$container" UAIN_BACKUP_DB_USER="$user" \
      UAIN_RESTORE_PG_URL="$admin_url" LEDGER_PUBLIC_KEY_FILE="$work/pinned.pem" "$@" \
      bash ops/backup/restore.sh "$restore_from/$restore_file"
  }
  if restore UAIN_BACKUP_KEY="$(openssl rand -hex 32)" UAIN_RESTORE_DB="$dst" \
    UAIN_RESTORE_DATA_DIR="$work/restored" > "$work/wrong-key.log" 2>&1; then
    die 'a restore with the wrong key succeeded'
  fi
  [ -z "$(sql "SELECT 1 FROM pg_database WHERE datname = '$dst'")" ] || die 'a refused restore created its database'
  if restore UAIN_RESTORE_DB="$src" UAIN_RESTORE_DATA_DIR="$work/restored" > "$work/existing.log" 2>&1; then
    die 'a restore over an existing database was allowed'
  fi
  grep -q 'exists already' "$work/existing.log" || die 'the existing database was not the reason for refusing'
  node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }))' \
    > "$work/other.pem"
  if restore UAIN_RESTORE_DB="$pin" UAIN_RESTORE_DATA_DIR="$work/restored-wrongpin" \
    LEDGER_PUBLIC_KEY_FILE="$work/other.pem" > "$work/wrong-pin.log" 2>&1; then
    die 'a restore passed against a ledger key other than the pinned one'
  fi
  grep -q 'signs with a key other than the pinned one' "$work/wrong-pin.log" || die 'the wrong pin was not the reason for failing'
  say 'refused: a wrong backup key (before anything is created), an existing database, and a ledger key other than the pinned one'

  restore UAIN_RESTORE_DB="$dst" UAIN_RESTORE_DATA_DIR="$work/restored"
  cmp "$work/data/ledger.key" "$work/restored/ledger.key" || die 'the restored ledger.key differs'
  cmp "$work/data/log.salt" "$work/restored/log.salt" || die 'the restored log.salt differs'

  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`drill: restored ${m.file}: ${m.sealed_bytes} bytes sealed, ${m.dump_bytes} bytes of dump, ` +
      `${m.tables} tables, ${m.rows} rows (${m.snapshot.tables.events.count} ledger entries); signing key and salt identical\n`);
  ' "$restore_from/${restore_file%.uainbk}.json"
  live_events=$(docker exec -i "$container" psql --username "$user" --dbname "$src" -Atqc 'SELECT count(*) FROM events' < /dev/null)
  say "the source had $live_events ledger entries when its writes stopped: they went on through the backups"
}

# Enrols members straight through the server's own code: DRILL_COUNT of
# them, or as many as fit in DRILL_SECONDS. Run inside a pilot container.
ENROL='
// The drill signs unbound proofs; bound ones are required by default since audit E-8.
process.env.UAIN_REQUIRE_BOUND_PROOFS ??= "0";
const { newKey, proveWith } = await import("/tmp/uain-key.mjs");
const db = await import("/app/dist/src/application/db.js");
const count = Number(process.env.DRILL_COUNT ?? Infinity);
const end = Date.now() + 1000 * Number(process.env.DRILL_SECONDS ?? Infinity);
let n = 0;
while (n < count && Date.now() < end) {
  const r = await db.enrol({ name: `Drill member ${n}`, operator: `Drill operator ${n}`,
    principles: ["voluntary", "verifiable", "authority", "benevolent"], proof: proveWith(newKey(), "enrol") });
  if (r.error) throw new Error(JSON.stringify(r));
  n += 1;
}
console.log(`wrote ${n}`);
process.exit(0);
'

drill_compose() {
  local p v
  for p in "$live" "$restored"; do
    for v in pg-data pilot-data; do
      ! docker volume inspect "${p}_$v" > /dev/null 2>&1 ||
        die "$p is left from an earlier run; remove it with: docker compose -p $p down -v"
    done
  done
  export UAIN_IMAGE_TAG=backupdrill
  UAIN_PG_PASSWORD=$(openssl rand -hex 16)
  export UAIN_PG_PASSWORD
  compose_up=yes
  docker compose -p "$live" build pilot > "$work/build.log" 2>&1 || {
    tail -n 20 "$work/build.log" >&2
    die 'the pilot image did not build'
  }
  docker compose -p "$live" up -d --wait --scale pilot=2 db pilot > /dev/null 2>&1 || die "$live did not start"
  docker compose -p "$live" exec -T pilot sh -c 'cat > /tmp/uain-key.mjs' < public/worker/uain-key.mjs
  docker compose -p "$live" exec -T -e DRILL_COUNT=200 -e NODE_NO_WARNINGS=1 pilot node --input-type=module - <<< "$ENROL"
  docker compose -p "$live" exec -T pilot node -e \
    'fetch("http://127.0.0.1:8787/api/ledger/key").then(r => r.json()).then(k => process.stdout.write(k.pem))' \
    > "$work/pinned.pem"
  docker compose -p "$live" exec -T -e DRILL_SECONDS=15 -e NODE_NO_WARNINGS=1 pilot node --input-type=module - <<< "$ENROL" \
    > "$work/traffic.log" &
  traffic=$!
  sleep 3
  say "$live is up (db and two pilots, no published ports) and being written to"

  clean_env UAIN_COMPOSE_PROJECT="$live" bash ops/backup/backup.sh run
  wait "$traffic" || die 'the writes during the backup failed'
  traffic=''
  say "writes stopped after $(sed -n 's/^wrote //p' "$work/traffic.log") enrolments, during the backup"
  check_checks

  if clean_env UAIN_RESTORE_PROJECT="$live" LEDGER_PUBLIC_KEY_FILE="$work/pinned.pem" \
    bash ops/backup/restore.sh "$work/backups/$(newest)" > "$work/into-live.log" 2>&1; then
    die "a restore into $live, which holds data, was allowed"
  fi
  grep -q 'never writes over data' "$work/into-live.log" || die 'the existing project was not the reason for refusing'
  say "a restore into $live, which holds data, is refused"

  # The restored database gets a password of its own.
  clean_env UAIN_RESTORE_PROJECT="$restored" LEDGER_PUBLIC_KEY_FILE="$work/pinned.pem" \
    UAIN_PG_PASSWORD="$(openssl rand -hex 16)" bash ops/backup/restore.sh "$work/backups/$(newest)" 2>&1 |
    grep -vE '^ (Container|Network|Volume) '
}

case $mode in
  container) drill_container ;;
  compose) drill_compose ;;
  *)
    echo 'usage: ops/backup/drill.sh [container | compose]' >&2
    exit 2
    ;;
esac
