#!/usr/bin/env bash
# The "Apply the manifest" step of .github/workflows/deploy.yml (10 November 2026).
#
# One deploy changes each Deployment at most once, so it makes at most one
# ReplicaSet for it. Until this date the pilot was changed two or three times
# within seconds (kubectl apply, the native patch, then a rollout restart), and
# copies of the first ReplicaSets were stopped as they started.
#
# From the environment, as the workflow's earlier steps set them:
#   REGISTRY, TAG                      the image store and this commit
#   TAG_WEB, TAG_PILOT, TAG_WAITLIST   the tag each component runs after this deploy
#   CHANGED_WEB, _PILOT, _WAITLIST     true when that image is new in this deploy
#   SCOPE_MODE                         scoped or full (ops/ci-scope/classify.mjs)
#   BASE                               the deployed source the change was measured
#                                      from; empty for a run by hand, the first
#                                      deploy, or a record that differs from what runs
#   RUNNER_TEMP                        a directory for the rendered manifest
#
# Steps:
#   1. A rollout that is still going finishes first (an earlier deploy that
#      stopped half-way, a restart by hand), so one is never started over
#      another. A stuck one is a warning: this deploy may be its fix.
#   2. The manifest is rendered whole (render.py: every component at its own
#      tag, the native runtime merged in) and applied once, when the mode is
#      full, the pilot image changed, or something the pilot reads changed.
#      Before the apply, the API server (a server-side dry run) and render.py
#      check what it would leave. Otherwise a web or waitlist release only sets
#      that Deployment's image and the pilot is not touched.
#   3. A Deployment is restarted only when a Secret or ConfigMap it reads
#      changed (or there is no record to compare with) AND step 2 left its pod
#      template as it was. One whose template just changed is already rolling
#      out, and its new copies read the current values.
#   4. Each rollout is waited for (ops/ci/rollout-wait.py), and the ReplicaSets
#      this step made are counted: more than one for a Deployment is a warning.
set -euo pipefail
: "${REGISTRY:?}" "${TAG:?}" "${TAG_WEB:?}" "${TAG_PILOT:?}" "${TAG_WAITLIST:?}" "${SCOPE_MODE:?}" "${RUNNER_TEMP:?}"
: "${CHANGED_WEB:?}" "${CHANGED_PILOT:?}" "${CHANGED_WAITLIST:?}"
BASE=${BASE:-}
root=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$root"
deployments=(pilot web waitlist)

# 1.
python3 ops/ci/rollout-wait.py uain pilot 300 --settle
for d in web waitlist; do python3 ops/ci/rollout-wait.py uain "$d" 120 --settle; done

pilot_inputs=false waitlist_inputs=false restart_all=false
if [ -z "$BASE" ]; then
  restart_all=true
else
  if python3 ops/ci-scope/release.py inputs-changed pilot; then pilot_inputs=true; fi
  if python3 ops/ci-scope/release.py inputs-changed waitlist; then waitlist_inputs=true; fi
fi

# The pod template as the API server holds it; empty while the Deployment does not exist.
template() { kubectl -n uain get deployment "$1" --ignore-not-found -o jsonpath='{.spec.template}'; }
before_pilot=$(template pilot); before_web=$(template web); before_waitlist=$(template waitlist)
started=$(date -u +%FT%TZ)

# 2.
if [ "$SCOPE_MODE" = full ] || [ "$CHANGED_PILOT" = true ] || [ "$pilot_inputs" = true ]; then
  rendered="$RUNNER_TEMP/uain.yaml"
  python3 deploy/k8s/production/render.py render "$TAG_WEB" "$TAG_PILOT" "$TAG_WAITLIST" > "$rendered"
  kubectl apply --dry-run=server -f "$rendered" -o json > "$RUNNER_TEMP/uain.applied.json"
  python3 deploy/k8s/production/render.py verify "$TAG_WEB" "$TAG_PILOT" "$TAG_WAITLIST" < "$RUNNER_TEMP/uain.applied.json"
  kubectl apply -f "$rendered"
else
  echo "pilot unchanged: the manifest is not applied again"
  [ "$CHANGED_WEB" != true ] || kubectl -n uain set image deployment/web "web=$REGISTRY/web:$TAG"
  [ "$CHANGED_WAITLIST" != true ] || kubectl -n uain set image deployment/waitlist "waitlist=$REGISTRY/waitlist:$TAG"
fi

# 3.
restart=()
for d in "${deployments[@]}"; do
  want=$restart_all
  if [ "$d" = pilot ] && [ "$pilot_inputs" = true ]; then want=true; fi
  if [ "$d" = waitlist ] && [ "$waitlist_inputs" = true ]; then want=true; fi
  if [ "$want" != true ]; then continue; fi
  was="before_$d"
  if [ "$(template "$d")" = "${!was}" ]; then
    restart+=("$d")
  else
    echo "$d: already rolling out with this deploy's change; not restarted as well"
  fi
done
if [ "${#restart[@]}" -gt 0 ]; then
  echo "restarting: ${restart[*]}"
  kubectl -n uain rollout restart "${restart[@]/#/deployment/}"
fi

# 4.
for d in "${deployments[@]}"; do python3 ops/ci/rollout-wait.py uain "$d" 600 --since "$started"; done
kubectl -n uain get pods -o wide
