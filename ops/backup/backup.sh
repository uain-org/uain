#!/usr/bin/env bash
# Encrypted backups of the UAIN store, made on the production host by
# .github/workflows/backup.yml. How to turn them on: docs/store.md,
# "Backups". What they hold and how to restore one: ops/DOCKER.md, "Backups".
#
#   ops/backup/backup.sh run     make a backup, read it back, keep the newest
#                                UAIN_BACKUP_KEEP, and copy it off the host
#   ops/backup/backup.sh check   fail unless the newest backup is recent and
#                                matches its manifest
#
# A backup is one file sealed with UAIN_BACKUP_KEY (AES-256-GCM, the UAINBK01
# format of services/pilot/src/operations/backup.ts). Inside: a pg_dump of the
# whole store, the ledger's private signing key (ledger.key), the salt session
# tokens are hashed with (log.salt), and a count and hash of every table taken
# in the same snapshot as the dump. Next to it, a manifest in the clear: sizes,
# the file's sha256, the signing key's public half and the table snapshot.
#
# The plaintext only ever passes through pipes: pg_dump in the db container
# (on k3s, a throwaway container reaching the database server over the
# tunnel) writes into the sealer in a pilot container, which holds the data
# directory and writes back ciphertext. The key reaches the sealer as the first line of
# its input, never as an argument or a file.
#
# Settings, from the environment:
#   UAIN_BACKUP_KEY             64 hexadecimal characters (openssl rand -hex 32).
#                               Needed by run. Without it no backup can be opened.
#   UAIN_BACKUP_DIR             Where backups are kept. Default /var/lib/uain-backups.
#                               Must exist, belong to this user and be mode 0700.
#   UAIN_BACKUP_KEEP            How many to keep there. Default 14.
#   UAIN_BACKUP_MAX_AGE_HOURS   How old the newest may be before check fails. Default 26.
#   UAIN_COMPOSE_PROJECT        Default uain-universa. compose.yaml needs
#                               UAIN_PG_PASSWORD set to be read at all.
#   UAIN_BACKUP_S3_ENDPOINT, UAIN_BACKUP_S3_BUCKET, and optionally
#   UAIN_BACKUP_S3_PREFIX, UAIN_BACKUP_S3_REGION, with
#   UAIN_BACKUP_S3_ACCESS_KEY_ID and UAIN_BACKUP_S3_SECRET_ACCESS_KEY:
#                               copy each backup and its manifest to
#                               S3-compatible storage. Unset: the copy is skipped
#                               with a notice.
#
# For a drill against a plain PostgreSQL container instead of the Compose
# project (ops/backup/drill.sh):
#   UAIN_BACKUP_DB_CONTAINER    pg_dump runs in this container, and the sealer
#                               runs from this checkout's compiled server with
#                               the DATABASE_URL and UAIN_DATA_DIR given here.
#   UAIN_BACKUP_DB_NAME, UAIN_BACKUP_DB_USER   Default uain and uain.
#
# On k3s (deploy/k8s/production), where PostgreSQL has a server of its own:
#   UAIN_BACKUP_K8S_NAMESPACE   The sealer runs in a pilot copy in this
#                               namespace (kubectl exec), and pg_dump in a
#                               throwaway postgres container on this host.
#   UAIN_BACKUP_DB_HOST         The database server. Default 10.98.0.2.
#   UAIN_PG_PASSWORD            The password of UAIN_BACKUP_DB_USER.
set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# docker compose finds compose.yaml in the current directory.
cd "$repo"

# rclone, pinned by digest, runs the off-host copy in a throwaway container:
# nothing to install on a shared host, one static binary that speaks to any
# S3-compatible store, and it checks each upload's size and MD5 itself.
# pg_dump must be at least the server's version (17).
# Pinned by digest (IN-12, 15 November 2026): PostgreSQL 17.11, the copy the host runs.
POSTGRES_IMAGE='postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
RCLONE_IMAGE='rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5'

project=${UAIN_COMPOSE_PROJECT:-uain-universa}
dir=${UAIN_BACKUP_DIR:-/var/lib/uain-backups}
db_name=${UAIN_BACKUP_DB_NAME:-uain}
db_user=${UAIN_BACKUP_DB_USER:-uain}
pattern='^uain-backup-[0-9]{8}T[0-9]{6}Z\.uainbk$'

in_actions() { [ "${GITHUB_ACTIONS:-}" = true ]; }
say() { echo "backup: $*"; }
notice() { if in_actions; then echo "::notice::backup: $*"; else say "$*"; fi; }
warn() { if in_actions; then echo "::warning::backup: $*"; else say "warning: $*" >&2; fi; }
die() {
  if in_actions; then echo "::error::backup: $*"; else echo "backup: $*" >&2; fi
  exit 1
}

# pg_dump and friends, where the database is.
db_exec() {
  if [ -n "${UAIN_BACKUP_K8S_NAMESPACE:-}" ]; then
    # Passed to docker by name only, so the password is in no command line.
    PGHOST=${UAIN_BACKUP_DB_HOST:-10.98.0.2} PGPASSWORD=${UAIN_PG_PASSWORD:?UAIN_PG_PASSWORD is not set} \
      docker run --rm -i --network host -e PGHOST -e PGPASSWORD "$POSTGRES_IMAGE" "$@"
  elif [ -n "${UAIN_BACKUP_DB_CONTAINER:-}" ]; then
    docker exec -i "$UAIN_BACKUP_DB_CONTAINER" "$@"
  else
    docker compose -p "$project" exec -T db "$@"
  fi
}

# The pilot's backup-cli.js, where the data directory is.
cli() {
  if [ -n "${UAIN_BACKUP_K8S_NAMESPACE:-}" ]; then
    kubectl -n "$UAIN_BACKUP_K8S_NAMESPACE" exec -i deploy/pilot -c pilot -- \
      node dist/src/operations/backup-cli.js "$@"
  elif [ -n "${UAIN_BACKUP_DB_CONTAINER:-}" ]; then
    node "$repo/services/pilot/dist/src/operations/backup-cli.js" "$@"
  else
    docker compose -p "$project" exec -T pilot node dist/src/operations/backup-cli.js "$@"
  fi
}

# The key, then a file, on one stream: what every backup-cli command reads.
keyed() {
  printf '%s\n' "$UAIN_BACKUP_KEY"
  cat "$1"
}

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# A top-level field of a manifest (JSON.stringify(…, null, 2), so one per line).
field() {
  sed -nE "s/^  \"$2\": \"?([^\",]*)\"?,?$/\1/p" "$1" | head -n 1
}

need_key() {
  [ -n "${UAIN_BACKUP_KEY:-}" ] || die 'UAIN_BACKUP_KEY is not set'
  [[ $UAIN_BACKUP_KEY =~ ^[0-9a-fA-F]{64}$ ]] ||
    die 'UAIN_BACKUP_KEY must be 64 hexadecimal characters (openssl rand -hex 32)'
}

# Backups hold the ledger's private key, so only this user may read the
# directory, and it must not be inside Docker's storage, where pruning or a
# volume removal could take it along with what it protects.
check_dir() {
  case $dir in /*) ;; *) die "UAIN_BACKUP_DIR must be an absolute path, not $dir" ;; esac
  case $dir/ in /var/lib/docker/*) die "$dir is inside Docker's storage; keep backups outside it" ;; esac
  [ -d "$dir" ] || die "$dir does not exist. Create it once, as root: install -d -o $(id -un) -g $(id -gn) -m 0700 $dir"
  [ -O "$dir" ] || die "$dir must belong to $(id -un)"
  case $(ls -ld "$dir") in
    drwx------*) ;;
    *) die "$dir must be mode 0700 (chmod 700 $dir)" ;;
  esac
}

# Oldest first: the time in the name sorts, and so does a glob.
backups() {
  local path
  for path in "$dir"/uain-backup-*.uainbk; do
    if [[ ${path##*/} =~ $pattern ]]; then echo "${path##*/}"; fi
  done
}

work='' partial='' pending_manifest='' sealer='' reader=''
cleanup() {
  local status=$?
  exec 3>&- 4<&-
  [ -z "$sealer" ] || kill "$sealer" 2> /dev/null || true
  [ -z "$reader" ] || kill "$reader" 2> /dev/null || true
  [ -z "$work" ] || rm -rf "$work"
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$pending_manifest" ] || rm -f "$pending_manifest"
  exit "$status"
}

# Writes the sealed backup to $1. The sealer opens a snapshot and names it;
# pg_dump takes that snapshot, so the dump and the table counts agree even
# while the network keeps writing.
seal() {
  local out=$1 line snapshot dump_status=0 sealer_status=0 reader_status=0
  # Named pipes, not files: nothing written through them touches the disk.
  mkfifo "$work/to-sealer" "$work/from-sealer"
  cli seal < "$work/to-sealer" > "$work/from-sealer" &
  sealer=$!
  exec 3> "$work/to-sealer" 4< "$work/from-sealer"
  printf '%s\n' "$UAIN_BACKUP_KEY" >&3
  IFS= read -r -t 120 line <&4 || die 'the sealer did not start (see its error above)'
  case $line in
    'snapshot '*) snapshot=${line#snapshot } ;;
    *) die 'the sealer answered something other than a snapshot' ;;
  esac
  [[ $snapshot =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || die 'the sealer named an unexpected snapshot'
  cat <&4 > "$out" 3>&- &
  reader=$!
  exec 4<&-
  db_exec pg_dump --username "$db_user" --dbname "$db_name" --format=custom \
    --no-owner --no-privileges --snapshot "$snapshot" < /dev/null >&3 || dump_status=$?
  # Closing our end is what tells the sealer the dump is complete.
  exec 3>&-
  wait "$sealer" || sealer_status=$?
  sealer=''
  wait "$reader" || reader_status=$?
  reader=''
  [ "$dump_status" -eq 0 ] || die "pg_dump failed (exit $dump_status)"
  [ "$sealer_status" -eq 0 ] || die "sealing failed (exit $sealer_status)"
  [ "$reader_status" -eq 0 ] || die "writing the backup failed (exit $reader_status)"
  [ -s "$out" ] || die 'the sealer wrote nothing'
}

prune() {
  local keep=${UAIN_BACKUP_KEEP:-14} old manifest
  [[ $keep =~ ^[1-9][0-9]*$ ]] || die "UAIN_BACKUP_KEEP must be a whole number above 0, not $keep"
  for old in $(backups | sort -r | tail -n "+$((keep + 1))"); do
    rm -f "$dir/$old" "$dir/${old%.uainbk}.json"
    say "removed $old, beyond the newest $keep"
  done
  # A manifest whose backup is gone describes nothing.
  for manifest in "$dir"/uain-backup-*.json; do
    [ -e "$manifest" ] || continue
    [ -e "${manifest%.json}.uainbk" ] || rm -f "$manifest"
  done
}

upload() {
  local name=$1 bucket prefix
  if [ -z "${UAIN_BACKUP_S3_ENDPOINT:-}" ] && [ -z "${UAIN_BACKUP_S3_BUCKET:-}" ]; then
    notice "no off-host copy: UAIN_BACKUP_S3_ENDPOINT and UAIN_BACKUP_S3_BUCKET are not set, so this backup is on this host only"
    return 0
  fi
  [ -n "${UAIN_BACKUP_S3_ENDPOINT:-}" ] && [ -n "${UAIN_BACKUP_S3_BUCKET:-}" ] ||
    die 'set both UAIN_BACKUP_S3_ENDPOINT and UAIN_BACKUP_S3_BUCKET, or neither'
  [ -n "${UAIN_BACKUP_S3_ACCESS_KEY_ID:-}" ] && [ -n "${UAIN_BACKUP_S3_SECRET_ACCESS_KEY:-}" ] ||
    die 'the off-host copy is configured but UAIN_BACKUP_S3_ACCESS_KEY_ID or UAIN_BACKUP_S3_SECRET_ACCESS_KEY is missing'
  bucket=$UAIN_BACKUP_S3_BUCKET
  prefix=${UAIN_BACKUP_S3_PREFIX:-}
  prefix=${prefix#/}
  prefix=${prefix%/}
  [ -z "$prefix" ] || prefix="$prefix/"

  # rclone reads its remote from these. Passed to docker by name only, so no
  # secret appears in a command line.
  export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other
  export RCLONE_CONFIG_OFFSITE_ENDPOINT=$UAIN_BACKUP_S3_ENDPOINT
  export RCLONE_CONFIG_OFFSITE_REGION=${UAIN_BACKUP_S3_REGION:-}
  export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$UAIN_BACKUP_S3_ACCESS_KEY_ID
  export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$UAIN_BACKUP_S3_SECRET_ACCESS_KEY
  # Run as this user, with the backups read-only and nothing else writable.
  # --immutable refuses to overwrite an object that differs; nothing is
  # deleted off the host by this script (see the bucket's lifecycle rule).
  docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e RCLONE_CONFIG_OFFSITE_TYPE -e RCLONE_CONFIG_OFFSITE_PROVIDER -e RCLONE_CONFIG_OFFSITE_ENDPOINT \
    -e RCLONE_CONFIG_OFFSITE_REGION -e RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID -e RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY \
    -v "$dir:/backups:ro" "$RCLONE_IMAGE" --config '' \
    copy /backups "offsite:$bucket/$prefix" --include "/$name.uainbk" --include "/$name.json" \
    --s3-no-check-bucket --no-traverse --immutable --retries 3 ||
    die "the off-host copy of $name failed; the backup itself is kept in $dir"
  say "copied $name.uainbk and $name.json to $bucket/$prefix"
}

run() {
  local stamp name manifest sum plain limit
  need_key
  check_dir
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  # What an interrupted run left: ciphertext and manifests, never plaintext.
  rm -f "$dir"/.uain-backup-*.partial
  work=$(mktemp -d "${TMPDIR:-/tmp}/uain-backup.XXXXXX")

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  name=uain-backup-$stamp
  manifest=$dir/$name.json
  [ ! -e "$dir/$name.uainbk" ] || die "$dir/$name.uainbk exists already"
  partial=$dir/.$name.uainbk.partial
  pending_manifest=$dir/.$name.json.partial

  seal "$partial"
  # Read the file back from disk, as a restore would, and describe it.
  keyed "$partial" | cli verify "$name.uainbk" > "$pending_manifest" ||
    die 'the backup did not read back; it has been discarded'
  sum=$(sha256_of "$partial")
  [ "$sum" = "$(field "$pending_manifest" sealed_sha256)" ] ||
    die 'the file on disk differs from what was read back; it has been discarded'
  # The manifest goes first, so every backup in place has one.
  mv "$pending_manifest" "$manifest"
  pending_manifest=''
  mv "$partial" "$dir/$name.uainbk"
  partial=''

  say "made $name.uainbk: $(field "$manifest" sealed_bytes) bytes, sha256 $sum"
  say "  snapshot at $(field "$manifest" taken_at) of $(field "$manifest" database): $(field "$manifest" tables) tables, $(field "$manifest" rows) rows"
  plain=$(field "$manifest" plaintext_bytes)
  limit=$(field "$manifest" limit_bytes)
  [[ $plain =~ ^[0-9]+$ && $limit =~ ^[0-9]+$ ]] || die 'the manifest has no sizes'
  # The bundle is built in memory and refused past the limit. Say so early.
  if [ "$((plain * 2))" -gt "$limit" ]; then
    warn "the backup is $plain of at most $limit bytes before encryption; move to a streaming format before it reaches the limit"
  fi

  prune
  upload "$name"
}

check() {
  local max=${UAIN_BACKUP_MAX_AGE_HOURS:-26} newest manifest
  [[ $max =~ ^[0-9]+$ ]] || die "UAIN_BACKUP_MAX_AGE_HOURS must be a whole number, not $max"
  check_dir
  newest=$(backups | tail -n 1)
  [ -n "$newest" ] || die "there is no backup in $dir"
  [ -n "$(find "$dir" -maxdepth 1 -name "$newest" -mmin "-$((max * 60))")" ] ||
    die "the newest backup, $newest, is more than $max hours old"
  manifest=$dir/${newest%.uainbk}.json
  [ -f "$manifest" ] || die "$newest has no manifest"
  [ "$(sha256_of "$dir/$newest")" = "$(field "$manifest" sealed_sha256)" ] ||
    die "$newest does not match the sha256 in its manifest"
  say "newest: $newest, $(field "$manifest" sealed_bytes) bytes, taken $(field "$manifest" taken_at), matches its manifest; $(backups | wc -l | tr -d ' ') kept in $dir"
}

case ${1:-} in
  run) run ;;
  check) check ;;
  *)
    echo 'usage: ops/backup/backup.sh run | check' >&2
    exit 2
    ;;
esac
