#!/usr/bin/env bash
# Keeps the images of the newest KEEP deploys (default 3) of production and of
# staging each, and removes older ones from the three places a deploy leaves
# them on uain-app-1: Docker (where they are built), the private registry
# (10.98.0.1:5000) and k3s's own image cache. Run by deploy.yml and
# deploy-staging.yml after a successful rollout, as the runner user. Several
# runner services now share this host, so a production deploy marks its tag in
# flight (release.py begin) before it pushes, and that tag is kept here.
# A rollback to a kept version pulls it from the registry again.
set -euo pipefail

REGISTRY=${REGISTRY:-10.98.0.1:5000/uain}
KEEP=${KEEP:-3}
REPOS=(web pilot waitlist)
API=http://${REGISTRY%%/*}/v2
NS=${REGISTRY#*/}
ACCEPT='application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'

# Newest first in deploy order, from each environment's rollout history (each
# Deployment's ReplicaSets): production in `uain`, staging in `uain-staging` and
# the benchmark in `uain-bench`, the newest KEEP of each component. Build times
# would not do: an unchanged image keeps the time it was first built.
#
# Production deploys are component-scoped (ops/ci-scope): an unchanged
# component keeps running an older tag, so the pilot's history alone no longer
# names every running image. Each component's own history is kept, and so is
# every tag the release record names (ops/ci-scope/release.py kept-tags: the
# current release, the previous one for rollback, and a deploy in flight, whose
# images are pushed before any ReplicaSet references them).
newest() { # namespace app
  kubectl -n "$1" get rs -l app="$2" \
    -o jsonpath='{range .items[*]}{.metadata.creationTimestamp} {.spec.template.spec.containers[0].image}{"\n"}{end}' 2> /dev/null |
    sort -r | sed 's/.*://' | awk '!seen[$0]++' | head -n "$KEEP"
}
history() { # namespace
  local app; for app in "${REPOS[@]}"; do newest "$1" "$app"; done
}
mapfile -t production < <(history uain | awk '!seen[$0]++')
[ "${#production[@]}" -gt 0 ] || { echo "no production rollout history; nothing removed"; exit 0; }
# A missing or unreadable record must stop the cleanup, never shrink what it keeps.
released=$(python3 "$(dirname -- "$0")/../../../ops/ci-scope/release.py" kept-tags) ||
  { echo "release record unreadable; nothing removed"; exit 0; }
mapfile -t others < <(history uain-staging; history uain-bench; [ -z "$released" ] || printf '%s\n' "$released")
keep=("${production[@]}" "${others[@]}")
echo "keeping: ${keep[*]}"
kept() { local t; for t in "${keep[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }

manifest() { # repo ref -> headers and body of the manifest, or nothing
  curl -fsS -D "$work/h" -o "$work/b" -H "Accept: $ACCEPT" "$API/$NS/$1/manifests/$2" 2> /dev/null
}
# The digest of a tag, then the digests inside it: the build makes an index
# that points at the image and its attestation, and each is its own manifest.
digests() { # repo tag
  manifest "$1" "$2" || return 0
  tr -d '\r' < "$work/h" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p'
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [print(m["digest"]) for m in d.get("manifests",[])]' "$work/b"
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

for repo in "${REPOS[@]}"; do
  # Docker on this host.
  for tag in $(docker images "$REGISTRY/$repo" --format '{{.Tag}}'); do
    [ "$tag" = '<none>' ] || kept "$tag" || docker rmi "$REGISTRY/$repo:$tag" > /dev/null 2>&1 ||
      echo "docker: kept $repo:$tag, a container still uses it (docker ps -a)"
  done

  # An unchanged image (the waitlist, say) has the same digests under several
  # tags, so never delete a digest a kept tag still uses.
  keep_digests=" "
  for tag in "${keep[@]}"; do keep_digests+="$(digests "$repo" "$tag" | tr '\n' ' ')"; done
  for tag in $(curl -fsS "$API/$NS/$repo/tags/list" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).get("tags") or []))'); do
    kept "$tag" && continue
    for d in $(digests "$repo" "$tag"); do
      case $keep_digests in *" $d "*) continue ;; esac
      curl -fsS -X DELETE "$API/$NS/$repo/manifests/$d" > /dev/null 2>&1 || true
    done
    echo "registry: removed $repo:$tag"
  done
done

# Frees the layers no remaining manifest uses. Never --delete-untagged: with
# this registry it also deletes the image inside a kept index (2 October 2026,
# repaired by pushing again). Deploys run one at a time, so nothing pushes now.
# Registry cached descriptors pointed at absent content (20 October 2026).
# Defer online GC while investigating; reclaim blobs only in a separate read-only
# maintenance window, with an integrity check before reopening writes.
echo "registry blob garbage collection deferred to offline maintenance"

# k3s keeps every image it pulled; drop the ones no container uses. (Old
# tags of an unchanged image stay listed: same image, no space.) Allowed to
# the runner by /etc/sudoers.d/uain-runner (README.md).
sudo -n /usr/local/bin/k3s crictl rmi --prune > /dev/null

echo "left: $(docker images "$REGISTRY/pilot" -q | wc -l | tr -d ' ') pilot images in Docker"
