#!/usr/bin/env bash
# Keep uain-app-1's root disk well clear of the kubelet eviction line (about
# 95% used; the 9 Nov 2026 outage). Runs hourly from uain-disk-hygiene.timer.
#
# Retention rule (10 Nov 2026; an assumption for Rahul's open image-retention
# decision, recorded in CHANGELOG.md#host-disk-retention-20261110):
#   Keep: every image any container uses (running or stopped); every image of
#   the UAIN registry (10.98.0.1:5000/uain/*: the deploy's prune-images.sh
#   keeps the tags of the current and rollback release records); the two
#   newest images of each UAIN-built repository (uain-*, baink-*); anything
#   tagged in the last 7 days; public base images, one per tag; and every
#   other tenant's image (AGA, neo-omni and the rest are never touched).
#   Remove, because they are rebuilt or re-pulled on demand:
#   - older UAIN-built images outside that set;
#   - Docker build cache older than 24 h (6 h when the disk is 80% used);
#   - dangling Docker images (no tag, used by no container);
#   - failed pods in the UAIN namespaces, once a day old;
#   - /opt/uain-test roots with no file changed for 24 h, no process inside
#     (working directory, executable or open file), not mounted into a running
#     container, and no `.keep`, `.in-use`, `.lock` or `*.pid` file at the top
#     (a session marks a root it still needs with `.keep`); caches named
#     `*-cache` are never removed, and a small `logs/` is kept 30 days in
#     /var/lib/uain-test-logs;
#     never a root that production names: an enabled or running systemd unit,
#     a script in /usr/local/sbin or an installed custody or backup helper
#     (on 9 Nov 2026 a cleanup removed the evidence backup's plan this way);
#   - check snapshots in /opt/uain-checks/incoming older than 12 h that no
#     process holds open (an interrupted `npm run check` leaves them behind).
# It never removes volumes, containers, logs, backups or production state.
# Every action is logged to the journal. DRY_RUN=1 prints the plan and
# changes nothing.
#
# Before removing anything under /opt/uain-test by hand, ask who names it:
#   uain-disk-hygiene --who-names /opt/uain-test/<folder>
# It prints each unit, script or helper that names the folder and exits 1 if
# there is one (0 if none, 2 if the path is not under the test root).
set -euo pipefail
run() { if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY: $*"; else "$@"; fi; }
ROOT=${UAIN_TEST_ROOT:-/opt/uain-test}
UNIT_DIR=${UAIN_HYGIENE_UNIT_DIR:-/etc/systemd/system}
# Installed code and configuration that may name a production input. Key,
# token and environment files are never opened.
REFERENCE_DIRS=${UAIN_HYGIENE_REFERENCE_DIRS:-/usr/local/sbin /opt/uain-custody /etc/uain-custody /opt/uain-node-backup /opt/uain-failover /opt/uain-evidence-backup /opt/uain-evidence-operations /opt/uain-proof-age}

# Top-level entries under a directory that production names, one
# "entry<TAB>source" line each. A unit counts while it is enabled (static and
# timer-started units included) or running; a masked or disabled, stopped
# unit does not, so a retired test service cannot pin a folder for ever.
named_under() { # dir
  local unit name dir
  {
    for unit in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer "$UNIT_DIR"/*.socket "$UNIT_DIR"/*.path "$UNIT_DIR"/*.mount; do
      [ -f "$unit" ] || continue
      name=$(basename "$unit")
      systemctl is-enabled --quiet "$name" 2> /dev/null || systemctl is-active --quiet "$name" 2> /dev/null || continue
      grep -HoE "$1/[A-Za-z0-9._@+-]+" "$unit" "$unit.d"/*.conf 2> /dev/null || true
    done
    for dir in $REFERENCE_DIRS; do
      [ -d "$dir" ] || continue
      grep -rIHoE --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=node_modules \
        --exclude='*key*' --exclude='*.pem' --exclude='*ed25519*' --exclude='*.env' \
        --exclude='*token*' --exclude='*secret*' --exclude='*credential*' --exclude='*.kdbx' \
        "$1/[A-Za-z0-9._@+-]+" "$dir" 2> /dev/null || true
    done
  } | sed -n 's#^\(.*\):\('"$1"'/[^/:]*\)$#\2\t\1#p' | sort -u
}

if [ "${1:-}" = --who-names ]; then
  top=$(sed -n "s#^\\($ROOT/[^/]*\\).*#\\1#p" <<< "${2:-}")
  if [ -z "$top" ]; then echo "not a path under $ROOT: ${2:-}" >&2; exit 2; fi
  found=$(named_under "$ROOT" | awk -F'\t' -v d="$top" '$1 == d { print $2 }')
  if [ -z "$found" ]; then echo "nothing production names $top"; exit 0; fi
  echo "$top is named by:"; sed 's/^/  /' <<< "$found"; exit 1
fi
INCOMING=${UAIN_CHECK_INCOMING:-/opt/uain-checks/incoming}
TEST_STALE_MIN=${TEST_STALE_MIN:-1440}     # 24 h
INCOMING_STALE_MIN=${INCOMING_STALE_MIN:-720} # 12 h
LOG_ARCHIVE=${UAIN_TEST_LOG_ARCHIVE:-/var/lib/uain-test-logs} # kept 30 days
export IMAGE_MIN_AGE_DAYS=${IMAGE_MIN_AGE_DAYS:-7} IMAGE_KEEP_PER_REPO=${IMAGE_KEEP_PER_REPO:-2}
used() { df --output=pcent / | tail -1 | tr -dc 0-9; }
avail() { df -BG --output=avail / | tail -1 | tr -dc 0-9; }
before=$(used) before_avail=$(avail)
age=24h
[ "$before" -ge 80 ] && age=6h
echo "disk ${before}% used (${before_avail}G free); pruning build cache older than ${age}"
run docker builder prune -f --filter "until=${age}" | tail -1 || true
run docker image prune -f | tail -1 || true

# Older UAIN-built images (rule above). docker rmi without -f: an image a
# container still uses is refused, never forced.
python3 - <<'PY' || echo "image retention step failed; nothing more removed"
import calendar, json, os, re, subprocess, time
dry = os.environ.get("DRY_RUN") == "1"
cutoff = time.time() - int(os.environ["IMAGE_MIN_AGE_DAYS"]) * 86400
keep_n = int(os.environ["IMAGE_KEEP_PER_REPO"])
scope = re.compile(r"^(uain-[^/]+|baink-[^/]+|baink\.money/.+)$")
def out(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True).stdout
def stamp(value):
    try:
        return calendar.timegm(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return 0
containers = out("docker", "ps", "-aq").split()
# A container may go between the two calls (checks come and go): read what remains.
in_use = set(out("docker", "inspect", "--format", "{{.Image}}", *containers, check=False).split()) if containers else set()
if containers and not in_use:
    raise SystemExit("no container images read; nothing removed")
repos = {}
for line in out("docker", "image", "ls", "--format", "{{json .}}").splitlines():
    row = json.loads(line)
    if row["Tag"] != "<none>" and scope.match(row["Repository"]):
        repos.setdefault(row["Repository"], []).append(row["Tag"])
for repo, tags in sorted(repos.items()):
    images = []
    for tag in tags:
        info = json.loads(out("docker", "image", "inspect", f"{repo}:{tag}"))[0]
        tagged = stamp((info.get("Metadata") or {}).get("LastTagTime", "")) or stamp(info.get("Created", ""))
        if tagged < 86400:  # unset LastTagTime (year 1)
            tagged = stamp(info.get("Created", ""))
        images.append((tagged, tag, info["Id"]))
    images.sort(reverse=True)
    newest = []
    for _, _, image in images:
        if image not in newest and len(newest) < keep_n:
            newest.append(image)
    for tagged, tag, image in images:
        if image in in_use or image in newest or tagged > cutoff:
            continue
        print(f"removing image {repo}:{tag} (tagged {time.strftime('%Y-%m-%d', time.gmtime(tagged))}, unused)", flush=True)
        if dry:
            print(f"DRY: docker rmi {repo}:{tag}")
        else:
            subprocess.run(["docker", "rmi", f"{repo}:{tag}"], capture_output=True)
PY

# Failed (for example evicted) pods in UAIN's namespaces, once a day old, so
# a fresh failure stays readable for diagnosis.
if command -v k3s > /dev/null; then
  day_ago=$(date -u -d '-1 day' +%Y-%m-%dT%H:%M:%SZ)
  for ns in uain uain-staging uain-bench; do
    k3s kubectl -n "$ns" get pods --field-selector=status.phase=Failed \
      -o jsonpath='{range .items[*]}{.metadata.creationTimestamp} {.metadata.name}{"\n"}{end}' 2> /dev/null |
      while read -r created pod; do
        [[ $created < $day_ago ]] || continue
        echo "removing failed pod $ns/$pod (created $created)"
        run k3s kubectl -n "$ns" delete pod "$pod" --wait=false > /dev/null || true
      done
  done
fi

# What processes and running containers are using under a directory, as the
# top-level entries below it (one per line).
busy_under() { # dir
  {
    for p in /proc/[0-9]*; do readlink "$p/cwd" "$p/exe" 2> /dev/null || true; done
    find /proc/[0-9]*/fd -maxdepth 1 -type l -lname "$1/*" -printf '%l\n' 2> /dev/null || true
    docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2> /dev/null || true
  } | sed -n "s#^\($1/[^/]*\).*#\1#p" | sort -u
}

if [ -d "$ROOT" ]; then
  busy=$(busy_under "$ROOT")
  named=$(named_under "$ROOT")
  for dir in "$ROOT"/*/; do
    dir=${dir%/}; name=$(basename "$dir")
    case $name in *-cache | native-go-build-cache) continue ;; esac
    named_by=$(awk -F'\t' -v d="$dir" '$1 == d { print $2; exit }' <<< "$named")
    if [ -n "$named_by" ]; then
      echo "keeping $dir: named by $named_by (move this production input out of $ROOT)"; continue
    fi
    # Anything with a file changed in the last 24 h: a session may be using it.
    [ -n "$(find "$dir" -mmin "-$TEST_STALE_MIN" -print -quit 2> /dev/null)" ] && continue
    if grep -qxF "$dir" <<< "$busy"; then echo "keeping $dir: a process or container is using it"; continue; fi
    if [ -n "$(find "$dir" -maxdepth 1 \( -name .keep -o -name .in-use -o -name .lock -o -name '*.pid' \) -print -quit 2> /dev/null)" ]; then
      echo "keeping $dir: marked in use"; continue
    fi
    echo "removing stale test root $dir ($(du -sh "$dir" 2> /dev/null | cut -f1))"
    # Change notes sometimes cite a root's logs: keep a copy of a small logs/.
    if [ -d "$dir/logs" ] && [ "$(du -sm "$dir/logs" | cut -f1)" -le 100 ]; then
      run install -d -m 0700 "$LOG_ARCHIVE"
      run tar -czf "$LOG_ARCHIVE/$name-logs.tar.gz" -C "$dir" logs
      echo "kept its logs in $LOG_ARCHIVE/$name-logs.tar.gz"
    fi
    run rm -rf --one-file-system -- "$dir"
  done
fi

if [ -d "$INCOMING" ]; then
  busy=$(busy_under "$INCOMING")
  find "$INCOMING" -maxdepth 1 -name '*.tar' -mmin "+$INCOMING_STALE_MIN" -print 2> /dev/null | while read -r tar; do
    grep -qxF "$tar" <<< "$busy" && continue
    echo "removing stale check snapshot $tar ($(du -sh "$tar" | cut -f1))"
    run rm -f -- "$tar"
  done
fi
[ -d "$LOG_ARCHIVE" ] && find "$LOG_ARCHIVE" -maxdepth 1 -name '*-logs.tar.gz' -mtime +30 -print -delete
echo "disk ${before}% -> $(used)% used (${before_avail}G -> $(avail)G free)"
