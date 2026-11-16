#!/usr/bin/env python3
"""Render the whole production manifest, for one `kubectl apply` (10 November 2026).

  render.py render <web-tag> <pilot-tag> <waitlist-tag>   the manifest, on stdout
  render.py verify <web-tag> <pilot-tag> <waitlist-tag>   reads the objects
      `kubectl apply --dry-run=server -o json` printed, on stdin; exits 1 and
      names each problem when they are not what this deploy means to apply

Why. Until 10 November 2026 a deploy changed the pilot Deployment two or three
times within seconds: `kubectl apply` of uain.yaml (new pilot image; it also
took the native ConfigMap out of the pilot's envFrom, because uain.yaml did not
list it), then apply-native.sh's patch (the native sidecar's image, envFrom put
back), then in full mode `rollout restart`. Each change made a ReplicaSet, and
copies of the first ones were stopped seconds after they started. Rendering
the native part into the manifest makes it one change and one ReplicaSet.

What `render` does:

- fills each image placeholder with its component's tag, so an unchanged
  component's Deployment is exactly what already runs;
- when the ConfigMap `uain-native-config` exists (it is made only by the
  reviewed native cutover), checks its pins as apply-native.sh did, merges
  native-pilot.patch.yaml into the pilot Deployment, adds the native-projection
  CronJob, and under native authority suspends research-index. A ConfigMap
  with unknown or changed pins fails here, before anything is applied. A read
  that fails is an error, never "absent";
- keeps the pilot at the number of copies it has now (between the autoscaler's
  bounds). The file says 4, and applying that while the autoscaler holds more
  stopped the extra copies in the middle of a rollout.

The merge is `kubectl kustomize`, a strategic merge: containers by name,
volumes by name, mounts by path, `envFrom` replaced as a whole.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
NAMESPACE = 'uain'
REGISTRY = '10.98.0.1:5000/uain'
TAG = re.compile(r'^[0-9a-f]{40}$')
COMPONENTS = ('web', 'pilot', 'waitlist')
# The autoscaler's bounds in uain.yaml (test_render.py checks they agree).
PILOT_MIN, PILOT_MAX = 4, 14
NATIVE_CONFIG = 'uain-native-config'
NATIVE_KEYS = {
    'UAIN_AUTHORITY', 'UAIN_NATIVE_PROJECTION', 'UAIN_NATIVE_STATE_BINARY', 'UAIN_NATIVE_STATE_SHA256',
    'UAIN_NATIVE_GENESIS', 'UAIN_NATIVE_GENESIS_SHA256', 'UAIN_NATIVE_RPC', 'UAIN_NATIVE_PUBLICATION_DIR',
    'UAIN_NATIVE_CHAIN_ID',
}
NATIVE_VOLUMES = ('native-public', 'native-publications', 'native-rpc-socket')
SUSPEND_RESEARCH_INDEX = """apiVersion: batch/v1
kind: CronJob
metadata:
  name: research-index
  namespace: uain
spec:
  suspend: true
"""


def kubectl(*args):
    return subprocess.run(['kubectl', *args], capture_output=True, text=True)


def native_authority(configmap):
    """'pilot' or 'native' for a ConfigMap with exactly the reviewed pins; raises otherwise."""
    data = (configmap or {}).get('data')
    if not isinstance(data, dict) or set(data) != NATIVE_KEYS:
        raise ValueError('uain-native-config does not hold exactly the reviewed keys')
    if data['UAIN_AUTHORITY'] not in ('pilot', 'native') or data['UAIN_NATIVE_PROJECTION'] != '1':
        raise ValueError('uain-native-config: unknown authority or projection setting')
    for key in ('UAIN_NATIVE_STATE_SHA256', 'UAIN_NATIVE_GENESIS_SHA256'):
        if not re.fullmatch('[a-f0-9]{64}', str(data[key])):
            raise ValueError(f'uain-native-config: {key} is not a SHA-256')
    if data['UAIN_NATIVE_STATE_BINARY'] != f'/opt/uain-native/public/state/{data["UAIN_NATIVE_STATE_SHA256"]}/uain-state':
        raise ValueError('uain-native-config: the state binary is not at its pinned path')
    if data['UAIN_NATIVE_GENESIS'] != f'/opt/uain-native/public/genesis/{data["UAIN_NATIVE_GENESIS_SHA256"]}/genesis.json':
        raise ValueError('uain-native-config: the genesis is not at its pinned path')
    if data['UAIN_NATIVE_RPC'] != 'http://127.0.0.1:26667':
        raise ValueError('uain-native-config: the RPC is not the pod-local bridge')
    if data['UAIN_NATIVE_PUBLICATION_DIR'] != '/var/lib/uain-native/publications':
        raise ValueError('uain-native-config: unknown publication directory')
    if not re.fullmatch('uain-[a-z0-9][a-z0-9_-]{1,63}', str(data['UAIN_NATIVE_CHAIN_ID'])):
        raise ValueError('uain-native-config: unknown chain id')
    return data['UAIN_AUTHORITY']


def read_native(run=kubectl):
    """The authority ('pilot' or 'native'), or None when the ConfigMap does not exist."""
    result = run('-n', NAMESPACE, 'get', 'configmap', NATIVE_CONFIG, '--ignore-not-found', '-o', 'json')
    if result.returncode != 0:
        raise RuntimeError(f'cannot read configmap/{NATIVE_CONFIG}: {result.stderr.strip()}')
    if not result.stdout.strip():
        return None
    return native_authority(json.loads(result.stdout))


def live_pilot_replicas(run=kubectl):
    """How many copies the pilot has now, when that is within the autoscaler's bounds; else None."""
    result = run('-n', NAMESPACE, 'get', 'deployment', 'pilot', '--ignore-not-found', '-o', 'jsonpath={.spec.replicas}')
    if result.returncode != 0:
        raise RuntimeError(f'cannot read deployment/pilot: {result.stderr.strip()}')
    text = result.stdout.strip()
    if not re.fullmatch('[0-9]{1,3}', text):
        return None
    count = int(text)
    return count if PILOT_MIN <= count <= PILOT_MAX else None


def check_tags(tags):
    if set(tags) != set(COMPONENTS) or not all(TAG.match(str(tags[c])) for c in COMPONENTS):
        raise ValueError('each of web, pilot and waitlist needs a 40-hex source revision as its tag')


def fill(text, tags):
    for component in COMPONENTS:
        text = text.replace(f'/uain/{component}:IMAGE_TAG', f'/uain/{component}:{tags[component]}')
    if 'IMAGE_TAG' in text:
        raise ValueError('an image placeholder is left unfilled')
    return text


def build(directory, tags, authority, replicas, source=HERE):
    """Write the kustomization that `kubectl kustomize` turns into the manifest."""
    check_tags(tags)
    if authority not in (None, 'pilot', 'native'):
        raise ValueError('unknown authority')
    directory, source = Path(directory), Path(source)
    (directory / 'uain.yaml').write_text(fill((source / 'uain.yaml').read_text(), tags))
    lines = ['apiVersion: kustomize.config.k8s.io/v1beta1', 'kind: Kustomization', 'resources:', '  - uain.yaml']
    patches = []
    if authority is not None:
        for name in ('native-pilot.patch.yaml', 'native-projection.yaml'):
            (directory / name).write_text(fill((source / name).read_text(), tags))
        lines.append('  - native-projection.yaml')
        patches.append('native-pilot.patch.yaml')
        if authority == 'native':
            (directory / 'research-index-suspend.yaml').write_text(SUSPEND_RESEARCH_INDEX)
            patches.append('research-index-suspend.yaml')
    if patches:
        lines.append('patches:')
        lines += [f'  - path: {name}' for name in patches]
    if replicas is not None:
        if not (isinstance(replicas, int) and PILOT_MIN <= replicas <= PILOT_MAX):
            raise ValueError('pilot copies outside the autoscaler bounds')
        lines += ['replicas:', '  - name: pilot', f'    count: {replicas}']
    (directory / 'kustomization.yaml').write_text('\n'.join(lines) + '\n')


def render(tags, run=kubectl):
    check_tags(tags)  # before the cluster is read
    authority = read_native(run)
    replicas = live_pilot_replicas(run)
    with tempfile.TemporaryDirectory() as directory:
        build(directory, tags, authority, replicas)
        result = run('kustomize', directory)
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f'kubectl kustomize failed: {result.stderr.strip()}')
    if 'IMAGE_TAG' in result.stdout:
        raise RuntimeError('the rendered manifest still holds an image placeholder')
    print(f'render: native runtime {authority or "absent"}; pilot copies {replicas or "as in uain.yaml"}', file=sys.stderr)
    return result.stdout


def pod_specs(item):
    """Each pod template spec an object carries (Deployment, CronJob)."""
    spec = item.get('spec') or {}
    if item.get('kind') == 'Deployment':
        return [(spec.get('template') or {}).get('spec') or {}]
    if item.get('kind') == 'CronJob':
        return [((((spec.get('jobTemplate') or {}).get('spec') or {}).get('template') or {}).get('spec')) or {}]
    return []


def verify(objects, tags, authority):
    """Problems with what the apply would leave, as a list of sentences; empty when it is right."""
    items = objects.get('items', [objects]) if isinstance(objects, dict) else list(objects)
    problems = []
    if 'IMAGE_TAG' in json.dumps(items):
        problems.append('an image placeholder is left unfilled')
    named = {(i.get('kind'), (i.get('metadata') or {}).get('name')): i for i in items}
    for item in items:
        where = f'{item.get("kind")}/{(item.get("metadata") or {}).get("name")}'
        for spec in pod_specs(item):
            # No workload calls the Kubernetes API, and none runs as root or without the
            # runtime's seccomp profile (security review IN-10, 13 and 15 November 2026).
            context = spec.get('securityContext') or {}
            if spec.get('automountServiceAccountToken') is not False:
                problems.append(f'{where}: the pod mounts a service-account token (automountServiceAccountToken is not false)')
            if (context.get('seccompProfile') or {}).get('type') != 'RuntimeDefault':
                problems.append(f'{where}: the pod does not run under the RuntimeDefault seccomp profile')
            if context.get('runAsNonRoot') is not True:
                problems.append(f'{where}: the pod may run as root (runAsNonRoot is not true)')
            for container in (spec.get('containers') or []) + (spec.get('initContainers') or []):
                image = str(container.get('image', ''))
                if not image.startswith(REGISTRY + '/'):
                    problems.append(f'{where}: container {container.get("name")} runs {image}, not an image of {REGISTRY}')
                    continue
                repo, _, tag = image[len(REGISTRY) + 1:].partition(':')
                if tags.get(repo) != tag:
                    problems.append(f'{where}: container {container.get("name")} runs {repo}:{tag}, expected {repo}:{tags.get(repo)}')
    for name in COMPONENTS:
        if ('Deployment', name) not in named:
            problems.append(f'Deployment/{name} is missing')
    pilot = named.get(('Deployment', 'pilot'))
    if pilot:
        spec = pilot.get('spec') or {}
        pod = (spec.get('template') or {}).get('spec') or {}
        names = [c.get('name') for c in pod.get('containers') or []]
        want = ['pilot', 'native-rpc'] if authority else ['pilot']
        if names != want:
            problems.append(f'Deployment/pilot has containers {names}, expected {want}')
        if ((spec.get('strategy') or {}).get('rollingUpdate') or {}).get('maxUnavailable') != 0:
            problems.append('Deployment/pilot may stop a ready copy before its replacement is ready (maxUnavailable is not 0)')
        first = (pod.get('containers') or [{}])[0]
        sources = [(e.get('configMapRef') or {}).get('name') for e in first.get('envFrom') or []]
        volumes = [v.get('name') for v in pod.get('volumes') or []]
        if authority:
            if NATIVE_CONFIG not in sources:
                problems.append('Deployment/pilot: the pilot container does not read uain-native-config')
            missing = [v for v in NATIVE_VOLUMES if v not in volumes]
            if missing:
                problems.append(f'Deployment/pilot lacks the native volumes {missing}')
            if ('CronJob', 'native-projection') not in named:
                problems.append('CronJob/native-projection is missing')
        elif NATIVE_CONFIG in sources or any(v in volumes for v in NATIVE_VOLUMES):
            problems.append('Deployment/pilot carries the native runtime although uain-native-config does not exist')
    if authority == 'native':
        index = named.get(('CronJob', 'research-index'))
        if not index or (index.get('spec') or {}).get('suspend') is not True:
            problems.append('CronJob/research-index is not suspended under native authority')
    return problems


def main(argv, run=kubectl, stdin=sys.stdin, stdout=sys.stdout):
    if len(argv) != 4 or argv[0] not in ('render', 'verify'):
        print(__doc__, file=sys.stderr)
        return 2
    tags = dict(zip(COMPONENTS, argv[1:]))
    if argv[0] == 'render':
        stdout.write(render(tags, run))
        return 0
    check_tags(tags)
    problems = verify(json.load(stdin), tags, read_native(run))
    for problem in problems:
        print(f'::error::rendered manifest: {problem}')
    if not problems:
        print('rendered manifest: the images, the pod security settings, the pilot containers and the rollout strategy are as intended')
    return 1 if problems else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (RuntimeError, ValueError, OSError) as error:
        print(f'::error::render: {error}', file=sys.stderr)
        sys.exit(1)
