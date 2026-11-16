#!/usr/bin/env bash
# Operator action only: inspect this checkout before installing root-trusted code.
#
#   bash ops/ci/install-runtime.sh [--programs-only]
#
# Installs the reviewed launcher (/usr/local/sbin/uain-ci-run), host guard
# (/usr/local/sbin/uain-host-guard), sudo rule and, unless --programs-only,
# a rebuilt runtime image. It never overwrites installed changes this checkout
# does not know about: verify-installed.sh must report in-sync, recorded or
# pending-install for every file first. Previous files are kept in a
# timestamped backup for rollback (docs/engineering/ci-resources.md).
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root from a reviewed checkout' >&2; exit 1; }
source_dir=$(cd "$(dirname "$0")" && pwd -P)
programs_only=0
case ${1:-} in
  '') ;;
  --programs-only) programs_only=1 ;;
  *) echo 'usage: install-runtime.sh [--programs-only]' >&2; exit 2 ;;
esac

status=0
bash "$source_dir/verify-installed.sh" --local || status=$?
case $status in
  0|3) ;;
  *) echo 'Installed CI files differ from ops/ci/installed-digests.json (drift, owner/mode or missing).' >&2
     echo 'Reconcile them into the tracked sources through a reviewed diff before installing.' >&2
     exit 1 ;;
esac
# A launcher started before this install holds no scratch reservation.
if [[ -n $(docker ps -q --filter label=uain.ci.disposable=true) ]]; then
  echo 'CI runs are active; install between runs' >&2
  exit 1
fi

backup=/var/backups/uain-ci-install-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o root -g root -m 0700 "$backup"
# Each file keeps its full path under the backup: the launcher and the sudo rule
# share the name uain-ci-run, and until 15 November 2026 the rule overwrote the
# launcher's copy in a flat backup.
for file in /usr/local/sbin/uain-ci-run /usr/local/sbin/uain-host-guard /etc/sudoers.d/uain-ci-run /etc/uain-ci/runtime-image; do
  if [[ -e $file ]]; then cp -a --parents "$file" "$backup/"; fi
done
(cd "$backup" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "Previous CI files saved in $backup"

if ((programs_only == 0)); then
  docker build -t uain-ci-runtime:20261012 "$source_dir"
  install -d -m 0755 /etc/uain-ci
  image_file=$(mktemp /etc/uain-ci/.runtime-image.XXXXXX)
  docker image inspect uain-ci-runtime:20261012 --format '{{.Id}}' > "$image_file"
  chown root:root "$image_file"
  chmod 0644 "$image_file"
  mv -f "$image_file" /etc/uain-ci/runtime-image
fi
guard_file=$(mktemp /usr/local/sbin/.uain-host-guard.XXXXXX)
install -o root -g root -m 0755 "$source_dir/host-guard.py" "$guard_file"
mv -f "$guard_file" /usr/local/sbin/uain-host-guard
launcher_file=$(mktemp /usr/local/sbin/.uain-ci-run.XXXXXX)
install -o root -g root -m 0755 "$source_dir/launcher.py" "$launcher_file"
mv -f "$launcher_file" /usr/local/sbin/uain-ci-run
install -d -o root -g root -m 0700 /var/lib/uain-ci
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
printf '%s\n' 'runner ALL=(root) NOPASSWD: /usr/local/sbin/uain-ci-run *' > "$rules"
visudo -cf "$rules"
install -o root -g root -m 0440 "$rules" /etc/sudoers.d/uain-ci-run

# The launcher and guard must now equal the tracked sources. A rebuilt runtime
# image is reported as DRIFT until the record is updated, which is expected.
cmp -s "$source_dir/launcher.py" /usr/local/sbin/uain-ci-run && cmp -s "$source_dir/host-guard.py" /usr/local/sbin/uain-host-guard \
  || { echo "Post-install comparison failed; restore from $backup" >&2; exit 1; }
bash "$source_dir/verify-installed.sh" --local || true
echo "Installed. Record the new digests in ops/ci/installed-digests.json in a reviewed change; rollback source: $backup"
