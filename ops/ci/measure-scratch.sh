#!/usr/bin/env bash
# Read-only sampler of CI scratch use on the app host. It never creates,
# changes or removes Docker resources and reads no file contents.
#
#   ssh uain-app-1 'bash -s -- 30 120' < ops/ci/measure-scratch.sh
#
# Arguments: interval seconds (default 30), sample count (default 1).
# Each sample prints one JSON line per live CI run: suite, run id, bytes in
# each owned volume (including the database container's anonymous data
# volume), container writable-layer bytes, and the Docker filesystem's
# available bytes. Peaks are the maximum of these lines per run; a sample
# interval can miss short spikes, so report them as sampled peaks.
set -euo pipefail
interval=${1:-30}
count=${2:-1}
[[ $interval =~ ^[0-9]+$ && $count =~ ^[0-9]+$ ]] || { echo 'usage: measure-scratch.sh [interval] [count]' >&2; exit 2; }
root=$(docker info --format '{{.DockerRootDir}}')
# du can report and still fail on files removed mid-walk: take its one total.
bytes() { local n; n=$( { du -sb --one-file-system "$1" 2>/dev/null || true; } | cut -f1 | head -1); echo "${n:-0}"; }
for ((i = 0; i < count; i++)); do
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  avail=$(df -B1 --output=avail "$root" | tail -1 | tr -d ' ')
  # Runs are identified by the launcher's unique name prefix, which works for
  # both the current and the labelled (uain.ci.run) launcher.
  for job in $(docker ps -a --filter label=uain.ci.disposable=true --format '{{.Names}}' \
      | sed -nE 's/^(uain-ci-[0-9a-f]{32})-(test|pg)$/\1/p' | sort -u); do
    # Command is: bash /work/ops/ci/container-suite.sh SUITE SHARD
    suite=$(docker inspect --format '{{index .Config.Cmd 2}}' "$job-test" 2>/dev/null || echo unknown)
    shard=$(docker inspect --format '{{index .Config.Cmd 3}}' "$job-test" 2>/dev/null || echo 0)
    work=$(bytes "$(docker volume inspect --format '{{.Mountpoint}}' "$job-work" 2>/dev/null)")
    cache=$(bytes "$(docker volume inspect --format '{{.Mountpoint}}' "$job-cache" 2>/dev/null)")
    pgdata=0
    for volume in $(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$job-pg" 2>/dev/null); do
      pgdata=$((pgdata + $(bytes "$(docker volume inspect --format '{{.Mountpoint}}' "$volume" 2>/dev/null)")))
    done
    layers=0
    for container in "$job-test" "$job-pg"; do
      size=$(docker inspect --size --format '{{.SizeRw}}' "$container" 2>/dev/null || echo 0)
      layers=$((layers + ${size:-0}))
    done
    started=$(docker inspect --format '{{.State.StartedAt}}' "$job-test" 2>/dev/null || echo unknown)
    total=$((${work:-0} + ${cache:-0} + pgdata + layers))
    printf '{"at":"%s","run":"%s","suite":"%s","shard":"%s","started":"%s","work":%s,"cache":%s,"pgdata":%s,"layers":%s,"total":%s,"docker_available":%s}\n' \
      "$now" "$job" "$suite" "$shard" "$started" "${work:-0}" "${cache:-0}" "$pgdata" "$layers" "$total" "$avail"
  done
  printf '{"at":"%s","host_sample":true,"docker_available":%s}\n' "$now" "$avail"
  if ((i + 1 < count)); then sleep "$interval"; fi
done
