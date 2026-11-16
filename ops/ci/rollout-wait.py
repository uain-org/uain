#!/usr/bin/env python3
"""Wait for a Deployment rollout in the production deploy (10 November 2026).

Usage: rollout-wait.py <namespace> <deployment> [timeout-seconds] [--settle] [--since <time>]

Three production deploys timed out in "Apply the manifest" while old pilot
pods lingered Terminating, and the log did not say whether the new pods were
ready. This waiter separates the two:

- The rollout is done when the controller has observed the current spec,
  every replica is updated and available, no old pod is still active, and
  every pod of the new ReplicaSet that is not being deleted is Ready. Old pods
  that are only Terminating are listed as a notice and never fail the deploy.
- It fails at once when the Deployment reports ProgressDeadlineExceeded, and
  at the timeout otherwise. Either way it names each new pod that is not ready,
  with its container state and its latest events (such as a readiness probe
  answering 503), so the log says why.

--settle is the wait before a deploy changes anything: a rollout that is still
going (an earlier deploy, a restart by hand) finishes first, so one is never
started over another. It never fails the deploy. A rollout that is stuck, or
not done at the timeout, is reported as a warning and the deploy goes on,
because the new deploy may be its fix; so does a Deployment that cannot be
read (the first deploy has none yet).

--since <time> (RFC 3339, UTC, as `date -u +%FT%TZ` prints) counts the
ReplicaSets made at or after that time once the rollout is done. One deploy
should make at most one for each Deployment; more is reported as a warning
(before 10 November 2026 every deploy made two or three within seconds).

The decision is a pure function (`decide`) over the kubectl JSON, tested in
ops/ci/test_rollout_wait.py.
"""
import json
import subprocess
import sys
import time

REVISION = 'deployment.kubernetes.io/revision'


def ready(pod):
    return any(c.get('type') == 'Ready' and c.get('status') == 'True'
               for c in pod.get('status', {}).get('conditions', []))


def owned_by(pod, uid):
    return any(o.get('uid') == uid for o in pod['metadata'].get('ownerReferences', []))


def decide(deployment, replicasets, pods):
    """Return (state, message, details): state is 'done', 'wait' or 'fail'."""
    meta, spec, status = deployment['metadata'], deployment.get('spec', {}), deployment.get('status', {})
    want = spec.get('replicas', 1)
    revision = meta.get('annotations', {}).get(REVISION)
    new_rs = [rs for rs in replicasets if rs['metadata'].get('annotations', {}).get(REVISION) == revision]
    new_uid = new_rs[0]['metadata']['uid'] if len(new_rs) == 1 else None
    new_pods = [p for p in pods if new_uid and owned_by(p, new_uid)]
    old_pods = [p for p in pods if p not in new_pods]
    terminating = sorted(p['metadata']['name'] for p in old_pods if p['metadata'].get('deletionTimestamp'))
    old_active = sorted(p['metadata']['name'] for p in old_pods if not p['metadata'].get('deletionTimestamp'))
    live_new = [p for p in new_pods if not p['metadata'].get('deletionTimestamp')]
    unready = sorted(p['metadata']['name'] for p in live_new if not ready(p))
    details = dict(revision=revision, want=want, new_ready=len(live_new) - len(unready), new_unready=unready,
                   old_active=old_active, old_terminating=terminating)
    for c in status.get('conditions', []):
        if c.get('type') == 'Progressing' and c.get('reason') == 'ProgressDeadlineExceeded':
            return 'fail', f'progress deadline exceeded: {c.get("message", "")}', details
    if status.get('observedGeneration', 0) < meta.get('generation', 0):
        return 'wait', 'the controller has not observed the new spec yet', details
    if new_uid is None:
        return 'wait', f'no single ReplicaSet at revision {revision} yet', details
    if status.get('updatedReplicas', 0) < want:
        return 'wait', f'{status.get("updatedReplicas", 0)} of {want} replicas updated', details
    if unready or len(live_new) < want or status.get('availableReplicas', 0) < want:
        return 'wait', f'{len(live_new) - len(unready)} of {want} new pods ready', details
    if old_active or status.get('replicas', 0) > want:
        return 'wait', f'old pods still active: {", ".join(old_active) or status.get("replicas")}', details
    return 'done', f'{want} of {want} new pods ready', details


def created_since(replicasets, since):
    """Names of the ReplicaSets made at or after `since` (both RFC 3339 UTC, which sort as text)."""
    return sorted(rs['metadata']['name'] for rs in replicasets
                  if rs['metadata'].get('creationTimestamp', '') >= since)


def kubectl(*args):
    return json.loads(subprocess.run(['kubectl', *args, '-o', 'json'], check=True, capture_output=True, text=True).stdout)


def snapshot(namespace, name):
    deployment = kubectl('-n', namespace, 'get', 'deployment', name)
    labels = deployment['spec']['selector'].get('matchLabels', {})
    selector = ','.join(f'{k}={v}' for k, v in sorted(labels.items()))
    replicasets = kubectl('-n', namespace, 'get', 'replicasets', '-l', selector)['items']
    pods = kubectl('-n', namespace, 'get', 'pods', '-l', selector)['items']
    return deployment, replicasets, pods


def explain(namespace, pods, names):
    """Container state and latest events of each named pod, for the log."""
    for pod in pods:
        name = pod['metadata']['name']
        if name not in names:
            continue
        print(f'--- new pod {name} is not ready (phase {pod.get("status", {}).get("phase")})')
        for c in pod.get('status', {}).get('containerStatuses', []):
            state = next(iter(c.get('state', {}) or {'unknown': {}}))
            reason = (c.get('state', {}).get(state) or {}).get('reason', '')
            print(f'    container {c.get("name")}: {state} {reason} ready={c.get("ready")} restarts={c.get("restartCount")}')
        try:
            events = kubectl('-n', namespace, 'get', 'events', '--field-selector', f'involvedObject.name={name}')['items']
        except subprocess.CalledProcessError:
            events = []
        for e in sorted(events, key=lambda e: e.get('lastTimestamp') or e.get('eventTime') or '')[-5:]:
            print(f'    event {e.get("reason")} x{e.get("count", 1)}: {(e.get("message") or "").strip()[:300]}')


def main(argv):
    args = list(argv[1:])
    settle = '--settle' in args
    if settle:
        args.remove('--settle')
    since = None
    if '--since' in args:
        at = args.index('--since')
        if at + 1 >= len(args):
            sys.exit('--since needs a time')
        since = args[at + 1]
        del args[at:at + 2]
    if len(args) not in (2, 3):
        sys.exit('usage: rollout-wait.py <namespace> <deployment> [timeout-seconds] [--settle] [--since <time>]')
    namespace, name = args[0], args[1]
    timeout = int(args[2]) if len(args) == 3 else 600
    end, last = time.monotonic() + timeout, None
    while True:
        try:
            deployment, replicasets, pods = snapshot(namespace, name)
        except subprocess.CalledProcessError as error:
            if not settle:
                raise
            reason = (error.stderr or '').strip()[:200] or 'it could not be read'
            print(f'::notice::{name}: nothing to wait for before this deploy ({reason})')
            return 0
        state, message, details = decide(deployment, replicasets, pods)
        if message != last:
            print(f'{name}: {message}', flush=True)
            last = message
        if state == 'done':
            if details['old_terminating']:
                print(f'::notice::{name} rolled out; old pods still terminating (not a failure): '
                      + ', '.join(details['old_terminating']))
            if since:
                made = created_since(replicasets, since)
                print(f'{name}: {len(made)} new ReplicaSet(s) since {since}' + (f': {", ".join(made)}' if made else ''))
                if len(made) > 1:
                    print(f'::warning::{name}: this deploy made {len(made)} ReplicaSets ({", ".join(made)}); '
                          'one deploy should be one rollout')
            return 0
        if state == 'fail' or time.monotonic() > end:
            why = message if state == 'fail' else f'not rolled out after {timeout}s: {message}'
            if settle:
                print(f'::warning::{name}: an earlier rollout is unfinished ({why}); this deploy goes on and replaces it')
                return 0
            explain(namespace, pods, set(details['new_unready']))
            print(f'::error::{name} {why}; new pods not ready: {", ".join(details["new_unready"]) or "none"}; '
                  f'old pods still active: {", ".join(details["old_active"]) or "none"}')
            return 1
        time.sleep(5)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
