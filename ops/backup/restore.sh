#!/usr/bin/env bash
# Restores a backup made by ops/backup/backup.sh into a new, separate stack,
# and proves it: every table counted and hashed against the snapshot sealed
# inside the backup, then the restored server's ledger checked end to end by
# services/pilot/scripts/verify-ledger.mjs against a pinned public key. The
# runbook is in ops/DOCKER.md, "Backups".
#
#   UAIN_BACKUP_KEY=… LEDGER_PUBLIC_KEY_FILE=ledger-public.pem UAIN_PG_PASSWORD=… \
#     ops/backup/restore.sh /var/lib/uain-backups/uain-backup-<time>.uainbk
#
# It never writes over data. The target is the Compose project
# UAIN_RESTORE_PROJECT (default uain-restore), and the restore stops if that
# project already has a database or data volume. Only the db service and one
# pilot are started, neither published on a port, so the restored copy is
# reachable from this host only and signs nothing anyone can see. It is left
# running to inspect; remove it with
#   docker compose -p <project> down -v
# which removes that project's containers and volumes and nothing else.
#
# Settings, from the environment:
#   UAIN_BACKUP_KEY          The key the backup was sealed with.
#   LEDGER_PUBLIC_KEY_FILE   The ledger's public key, from a copy the server does
#                            not control: ledger-public.pem on the ledger-roots
#                            branch, or the LEDGER_PUBLIC_KEY_PEM variable.
#   UAIN_RESTORE_PROJECT     Default uain-restore. uain-universa is allowed only
#                            where it has no volumes, as on a new host.
#   UAIN_PG_PASSWORD         Password of the restored database (compose.yaml
#                            needs it). Use the production secret for a real
#                            recovery, so later deploys can reach it.
#   UAIN_IMAGE_TAG           The pilot image to run (uain-pilot:<tag>), which
#                            must be here already. Default latest.
#
# For a drill against a plain PostgreSQL container (ops/backup/drill.sh):
#   UAIN_BACKUP_DB_CONTAINER The container. pg_restore runs there; the pilot
#                            runs from this checkout's compiled server.
#   UAIN_RESTORE_DB          A database to create there. Must not exist.
#   UAIN_RESTORE_PG_URL      A URL to that server's maintenance database, from
#                            this host (its path is replaced with UAIN_RESTORE_DB).
#   UAIN_RESTORE_DATA_DIR    A new, empty directory for ledger.key and log.salt.
#   UAIN_BACKUP_DB_USER      Default uain.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cd "$repo"

project=${UAIN_RESTORE_PROJECT:-uain-restore}
db_user=${UAIN_BACKUP_DB_USER:-uain}
local_mode=${UAIN_BACKUP_DB_CONTAINER:+yes}

say() { echo "restore: $*"; }
die() {
  echo "restore: $*" >&2
  exit 1
}

usage() {
  echo 'usage: ops/backup/restore.sh <backup file (.uainbk)>' >&2
  exit 2
}

file=${1:-}
[ -n "$file" ] || usage
[ -f "$file" ] || die "$file is not a file"
[ -n "${UAIN_BACKUP_KEY:-}" ] || die 'UAIN_BACKUP_KEY is not set'
[[ $UAIN_BACKUP_KEY =~ ^[0-9a-fA-F]{64}$ ]] || die 'UAIN_BACKUP_KEY must be 64 hexadecimal characters'
[ -n "${LEDGER_PUBLIC_KEY_FILE:-}" ] ||
  die 'LEDGER_PUBLIC_KEY_FILE is not set: pin the ledger key from the ledger-roots branch, not from the backup'
[ -f "$LEDGER_PUBLIC_KEY_FILE" ] || die "$LEDGER_PUBLIC_KEY_FILE is not a file"
grep -q -- '-----BEGIN PUBLIC KEY-----' "$LEDGER_PUBLIC_KEY_FILE" ||
  die "$LEDGER_PUBLIC_KEY_FILE is not a PEM public key (from key.json on the ledger-roots branch, save its pem field)"
name=$(basename "$file")

work=$(mktemp -d "${TMPDIR:-/tmp}/uain-restore.XXXXXX")
server=''
cleanup() {
  local status=$?
  [ -z "$server" ] || kill "$server" 2> /dev/null || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

keyed() {
  printf '%s\n' "$UAIN_BACKUP_KEY"
  cat "$file"
}

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

field() {
  sed -nE "s/^  \"$2\": \"?([^\",]*)\"?,?$/\1/p" "$1" | head -n 1
}

compose() {
  docker compose -p "$project" "$@"
}

if [ -n "$local_mode" ]; then
  db=${UAIN_RESTORE_DB:-}
  [[ $db =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die 'UAIN_RESTORE_DB must be a plain lower-case database name'
  [ -n "${UAIN_RESTORE_PG_URL:-}" ] || die 'UAIN_RESTORE_PG_URL is not set'
  database_url=${UAIN_RESTORE_PG_URL%/*}/$db
  data_dir=${UAIN_RESTORE_DATA_DIR:-}
  [ -n "$data_dir" ] || die 'UAIN_RESTORE_DATA_DIR is not set'
  if [ -e "$data_dir" ] && [ -n "$(ls -A "$data_dir")" ]; then die "$data_dir is not empty"; fi
  mkdir -p "$data_dir"
else
  db=uain
fi

db_exec() {
  if [ -n "$local_mode" ]; then
    docker exec -i "$UAIN_BACKUP_DB_CONTAINER" "$@"
  else
    compose exec -T db "$@"
  fi
}

# The pilot's backup-cli.js, against the restored database and data directory.
cli() {
  if [ -n "$local_mode" ]; then
    DATABASE_URL=$database_url UAIN_DATA_DIR=$data_dir \
      node "$repo/services/pilot/dist/src/operations/backup-cli.js" "$@"
  else
    compose run --rm --no-deps -T pilot node dist/src/operations/backup-cli.js "$@"
  fi
}

# 1. Nothing is touched until the target is known to be new.
if [ -n "$local_mode" ]; then
  exists=$(db_exec psql --username "$db_user" --dbname postgres -Atc \
    "SELECT count(*) FROM pg_database WHERE datname = '$db'" < /dev/null)
  [ "$exists" = 0 ] || die "database $db exists already; restore only into a new one"
  say "target: new database $db in container $UAIN_BACKUP_DB_CONTAINER"
else
  : "${UAIN_PG_PASSWORD:?set UAIN_PG_PASSWORD, the password the restored database will have}"
  for volume in pg-data pilot-data; do
    if docker volume inspect "${project}_$volume" > /dev/null 2>&1; then
      die "the volume ${project}_$volume exists: $project already holds data, and a restore never writes over data. Choose another UAIN_RESTORE_PROJECT."
    fi
  done
  image=uain-pilot:${UAIN_IMAGE_TAG:-latest}
  docker image inspect "$image" > /dev/null 2>&1 ||
    die "no image $image here. Set UAIN_IMAGE_TAG to one that is (docker image ls uain-pilot), or build it: docker compose -p $project build pilot"
  say "target: new Compose project $project, pilot image $image"
fi

# 2. The file: the sha256 its manifest recorded, then a full read with the key.
manifest=${file%.uainbk}.json
if [ -f "$manifest" ]; then
  [ "$(sha256_of "$file")" = "$(field "$manifest" sealed_sha256)" ] ||
    die "$name does not match the sha256 in $(basename "$manifest")"
  say "$name matches the sha256 in its manifest"
else
  say "no manifest next to $name; relying on the encryption's own check"
fi
keyed | cli verify "$name" > "$work/manifest.json" ||
  die "$name does not open with this key, or is not a complete backup"
say "opened: taken $(field "$work/manifest.json" taken_at) from $(field "$work/manifest.json" database), $(field "$work/manifest.json" tables) tables, $(field "$work/manifest.json" rows) rows"

# 3. The database, from the dump, in one transaction: all of it or nothing.
if [ -n "$local_mode" ]; then
  db_exec psql --username "$db_user" --dbname postgres -v ON_ERROR_STOP=1 -qc \
    "CREATE DATABASE $db TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'" < /dev/null
else
  compose up -d --wait db
fi
keyed | cli dump | db_exec pg_restore --username "$db_user" --dbname "$db" \
  --exit-on-error --single-transaction --no-owner --no-privileges ||
  die 'pg_restore failed'
say 'database restored'

# 4. Before the server starts and writes anything: every table against the
# snapshot sealed with the dump.
keyed | cli compare > "$work/compare.json" || {
  cat "$work/compare.json" >&2
  die 'the restored database differs from the backup'
}
say "tables match the backup: $(cat "$work/compare.json")"

# 5. The files that make the server itself, where it will look for them.
keyed | cli files > "$work/files.json" || die 'could not put ledger.key and log.salt back'
say "signing key and salt in place: $(cat "$work/files.json")"

# 6. The server, on the restored store, and its ledger checked from outside
# with the pinned key: the chain, every research record, every signed root.
if [ -n "$local_mode" ]; then
  port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
  [[ $port =~ ^[0-9]+$ ]] || die 'could not find a free port'
  PORT=$port HOST=127.0.0.1 DATABASE_URL=$database_url UAIN_DATA_DIR=$data_dir \
    node services/pilot/dist/src/api/server.js > "$work/server.log" 2>&1 &
  server=$!
  api=http://127.0.0.1:$port
  for _ in $(seq 1 120); do
    curl -fsS "$api/api/ready" > /dev/null 2>&1 && break
    kill -0 "$server" 2> /dev/null || {
      cat "$work/server.log" >&2
      die 'the restored server did not start'
    }
    sleep 0.5
  done
  curl -fsS "$api/api/ready" > /dev/null || die 'the restored server is not ready'
  UAIN_API=$api node services/pilot/scripts/verify-ledger.mjs || die 'the restored ledger did not verify'
else
  compose up -d --wait --scale pilot=1 pilot
  compose exec -T -e UAIN_API=http://127.0.0.1:8787 -e "LEDGER_PUBLIC_KEY_PEM=$(cat "$LEDGER_PUBLIC_KEY_FILE")" \
    pilot node --input-type=module - < services/pilot/scripts/verify-ledger.mjs ||
    die 'the restored ledger did not verify'
fi

say "PASS: $name restored, every table matches its snapshot, and the ledger verifies against the pinned key"
if [ -z "$local_mode" ]; then
  say "the restored stack is running as Compose project $project (db and one pilot, no published ports)"
  say "  a shell on it: docker compose -p $project exec db psql -U uain"
  say "  remove it:     docker compose -p $project down -v"
fi
