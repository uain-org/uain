#!/usr/bin/env python3
"""Production release manifest for component-scoped deploys (deploy.yml).

The ConfigMap `uain-release` in namespace `uain` records what is deployed:

  release.json   {"schemaVersion": 1, "source": <git sha>, "recordedAt", "run",
                  "components": {"web"|"pilot"|"waitlist": {"tag", "digest"}},
                  "inputs": {"pilot"|"waitlist": <fingerprint>}}
  previous.json  the release.json before it (the rollback target)
  pending.json   {"tag", "since"} while a deploy is pushing images

Each component keeps the tag (the commit that last built it) and the registry
digest it was deployed with. A deploy rebuilds only changed components; an
unchanged one is re-tagged in the registry under the new commit (same digest,
so verify-registry.py and verify-runtime-images.sh still check all three under
one tag) while its Deployment keeps referencing the old tag, so it is neither
replaced nor restarted. A component that was rebuilt to the image it already
runs (`same`) keeps its recorded tag the same way. prune-images.sh keeps every
tag named here.

`inputs` fingerprints the resourceVersions of the Secrets and ConfigMaps a
component reads at start (no secret values). A changed fingerprint restarts
that component even when its image did not change.

Rollback: restore previous.json's tags. For the web or the waitlist alone:
  kubectl -n uain set image deployment/web web=10.98.0.1:5000/uain/web:<tag>
For the pilot (its sidecar and the two CronJobs run the same image), render the
manifest at those tags and apply it, which is one rollout:
  python3 deploy/k8s/production/render.py render <web> <pilot> <waitlist> | kubectl apply -f -
Business state is not rolled back.

Subcommands (all print to stdout, diagnostics to stderr):
  base REGISTRY                      deployed source sha, or nothing when the
                                     record is missing or differs from the live
                                     Deployments (the caller then deploys in full)
  component NAME                     "<tag> <digest>" of a recorded component
  begin TAG                          mark TAG in flight (kept by prune-images.sh)
  retag REGISTRY NAME FROM TO DIGEST put FROM's manifest under TO, only if FROM
                                     still has DIGEST
  same REGISTRY NAME TAG             "<tag> <digest>" of the recorded component
                                     and exit 0 when NAME:TAG, just built, is
                                     the same image as the recorded one (only
                                     the build attestation differs); exit 1
                                     when it differs or cannot be compared.
                                     The caller then keeps the recorded tag,
                                     so the Deployment is not rolled out
  inputs-changed NAME                exit 0 when NAME's inputs differ from the record
  record REGISTRY SOURCE WEB PILOT WAITLIST
                                     write release.json (moving the old one to
                                     previous.json) and clear pending.json
  kept-tags                          every tag the record names, one per line
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

NAMESPACE = os.environ.get('UAIN_RELEASE_NAMESPACE', 'uain')
CONFIGMAP = 'uain-release'
COMPONENTS = ('web', 'pilot', 'waitlist')
ACCEPT = ', '.join((
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.docker.distribution.manifest.v2+json',
))
# What each Deployment reads when a pod starts (deploy/k8s/production).
INPUTS = {
    'pilot': (('secret', 'uain-env'), ('secret', 'uain-retrieval'), ('secret', 'uain-kalki'),
              ('secret', 'uain-ledger'), ('configmap', 'uain-native-config')),
    'waitlist': (('secret', 'uain-env'),),
}
TAG = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')


def kubectl(*args, check=True):
    result = subprocess.run(['kubectl', '-n', NAMESPACE, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f'kubectl {" ".join(args)}: {result.stderr.strip()}')
    return result


def load(run=kubectl):
    result = run('get', 'configmap', CONFIGMAP, '-o', 'json', '--ignore-not-found', check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'cannot read the release ConfigMap')
    if not result.stdout.strip():
        return None
    return json.loads(result.stdout).get('data') or {}


def valid_release(release):
    if not isinstance(release, dict) or release.get('schemaVersion') != 1:
        return False
    if not TAG.match(str(release.get('source', ''))):
        return False
    components = release.get('components')
    if not isinstance(components, dict):
        return False
    return all(
        isinstance(components.get(c), dict)
        and TAG.match(str(components[c].get('tag', '')))
        and DIGEST.match(str(components[c].get('digest', '')))
        for c in COMPONENTS)


def current(data):
    if not data or 'release.json' not in data:
        return None
    try:
        release = json.loads(data['release.json'])
    except ValueError:
        return None
    return release if valid_release(release) else None


def live_images(run=kubectl):
    out = json.loads(run('get', 'deployment', *COMPONENTS, '-o', 'json').stdout)
    images = {}
    for item in out.get('items', []):
        spec = item['spec']['template']['spec']
        images[item['metadata']['name']] = [c['image'] for c in spec.get('containers', [])]
    return images


def base(registry, data, images):
    """The deployed source, only when every live component image is the recorded one."""
    release = current(data)
    if release is None:
        return None, 'no valid release record'
    for c in COMPONENTS:
        expected = f'{registry}/{c}:{release["components"][c]["tag"]}'
        mine = [i for i in images.get(c, []) if i.startswith(f'{registry}/{c}:')]
        if not mine or any(i != expected for i in mine):
            return None, f'live {c} image {mine or "missing"} differs from the record {expected}'
    return release['source'], 'live images match the record'


def kept_tags(data):
    tags = []
    for key in ('release.json', 'previous.json'):
        try:
            release = json.loads((data or {}).get(key) or 'null')
        except ValueError:
            continue
        if isinstance(release, dict):
            for c in (release.get('components') or {}).values():
                if isinstance(c, dict) and TAG.match(str(c.get('tag', ''))):
                    tags.append(c['tag'])
            if TAG.match(str(release.get('source', ''))):
                tags.append(release['source'])
    try:
        pending = json.loads((data or {}).get('pending.json') or 'null')
    except ValueError:
        pending = None
    if isinstance(pending, dict) and TAG.match(str(pending.get('tag', ''))):
        tags.append(pending['tag'])
    return list(dict.fromkeys(tags))


def api(registry):
    host, namespace = registry.split('/', 1)
    return f'http://{host}/v2/{namespace}'


def get_manifest(registry, repo, ref, opener=urllib.request.urlopen):
    request = urllib.request.Request(f'{api(registry)}/{repo}/manifests/{ref}', headers={'Accept': ACCEPT})
    with opener(request, timeout=60) as response:
        body = response.read()
        return body, response.headers.get('Content-Type'), 'sha256:' + hashlib.sha256(body).hexdigest()


def retag(registry, repo, source, target, expected, opener=urllib.request.urlopen):
    body, content_type, digest = get_manifest(registry, repo, source, opener)
    if digest != expected:
        raise RuntimeError(f'{repo}:{source} is {digest}, the release record says {expected}')
    if not content_type:
        raise RuntimeError(f'{repo}:{source}: registry sent no manifest media type')
    request = urllib.request.Request(f'{api(registry)}/{repo}/manifests/{target}', data=body, method='PUT',
                                     headers={'Content-Type': content_type})
    with opener(request, timeout=60) as response:
        stored = response.headers.get('Docker-Content-Digest')
    if stored and stored != expected:
        raise RuntimeError(f'{repo}:{target} stored as {stored}, expected {expected}')
    _, _, check = get_manifest(registry, repo, target, opener)
    if check != expected:
        raise RuntimeError(f'{repo}:{target} reads back as {check}, expected {expected}')


def image_identity(registry, repo, ref, opener=urllib.request.urlopen):
    """The digest of the image that runs: the one platform image inside an index.

    `docker build` on the runner pushes an index of the image and a build
    attestation. The attestation holds the build's own times, so the index
    digest differs on every build, even when every layer is unchanged: on
    10 November 2026 three deploys in a row pushed the pilot image
    `a228d5619ddf…` under three index digests, and each rolled the pilot out.
    A manifest that is not an index is its own identity.
    """
    body, _, digest = get_manifest(registry, repo, ref, opener)
    manifests = json.loads(body).get('manifests')
    if manifests is None:
        return digest
    images = [m.get('digest') for m in manifests
              if (m.get('annotations') or {}).get('vnd.docker.reference.type') != 'attestation-manifest'
              and (m.get('platform') or {}).get('os') not in (None, 'unknown')]
    if len(images) != 1 or not DIGEST.match(str(images[0])):
        raise RuntimeError(f'{repo}:{ref} does not hold exactly one platform image')
    return images[0]


def same_image(registry, repo, tag, component, opener=urllib.request.urlopen):
    """True when `repo:tag` is the image the record says runs, built again.

    The recorded tag must still carry the recorded digest, so the Deployment
    that keeps naming it keeps running what was compared.
    """
    recorded = image_identity(registry, repo, component['digest'], opener)
    if get_manifest(registry, repo, component['tag'], opener)[2] != component['digest']:
        raise RuntimeError(f'{repo}:{component["tag"]} no longer has the recorded digest')
    return image_identity(registry, repo, tag, opener) == recorded


def fingerprint(name, run=kubectl):
    parts = []
    for kind, resource in INPUTS.get(name, ()):
        result = run('get', kind, resource, '-o', 'jsonpath={.metadata.uid}/{.metadata.resourceVersion}',
                     '--ignore-not-found', check=False)
        if result.returncode != 0:
            raise RuntimeError(f'cannot read {kind}/{resource}: {result.stderr.strip()}')
        parts.append(f'{kind}/{resource}={result.stdout.strip() or "-"}')
    return ','.join(parts)


def patch(data, run=kubectl):
    """Merge-patch the ConfigMap's data (None deletes a key), creating it first if needed."""
    if run('get', 'configmap', CONFIGMAP, '--ignore-not-found', '-o', 'name', check=False).stdout.strip() == '':
        run('create', 'configmap', CONFIGMAP)
    run('patch', 'configmap', CONFIGMAP, '--type', 'merge', '-p', json.dumps({'data': data}))


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def main(argv):
    command, args = (argv[0], argv[1:]) if argv else ('', [])
    if command == 'base':
        (registry,) = args
        data = load()
        source, why = base(registry, data, live_images()) if current(data) else (None, 'no valid release record')
        print(f'release base: {why}', file=sys.stderr)
        if source:
            print(source)
    elif command == 'component':
        (name,) = args
        release = current(load())
        if release is None:
            return 1
        component = release['components'][name]
        print(component['tag'], component['digest'])
    elif command == 'begin':
        (tag,) = args
        assert TAG.match(tag), 'begin needs a 40-hex source revision'
        patch({'pending.json': json.dumps({'tag': tag, 'since': now()})})
    elif command == 'retag':
        registry, repo, source, target, expected = args
        assert repo in COMPONENTS and TAG.match(source) and TAG.match(target) and DIGEST.match(expected)
        retag(registry, repo, source, target, expected)
        print(f'{repo}:{target} -> {expected} (unchanged since {source})', file=sys.stderr)
    elif command == 'same':
        registry, name, tag = args
        assert name in COMPONENTS and TAG.match(tag)
        release = current(load())
        if release is None:
            return 1
        component = release['components'][name]
        if not same_image(registry, name, tag, component):
            print(f'{name}:{tag} is a different image from the recorded {component["tag"]}', file=sys.stderr)
            return 1
        print(f'{name}:{tag} is the image that already runs ({component["tag"]}), built again', file=sys.stderr)
        print(component['tag'], component['digest'])
    elif command == 'inputs-changed':
        (name,) = args
        release = current(load())
        recorded = (release or {}).get('inputs', {}).get(name)
        live = fingerprint(name)
        changed = recorded != live
        print(f'{name} inputs {"changed" if changed else "unchanged"}', file=sys.stderr)
        return 0 if changed else 1
    elif command == 'record':
        registry, source, *tags = args
        assert TAG.match(source) and len(tags) == len(COMPONENTS) and all(TAG.match(t) for t in tags)
        data = load() or {}
        components = {}
        for name, tag in zip(COMPONENTS, tags):
            _, _, digest = get_manifest(registry, name, tag)
            components[name] = {'tag': tag, 'digest': digest}
        release = {'schemaVersion': 1, 'source': source, 'recordedAt': now(),
                   'run': os.environ.get('GITHUB_RUN_ID', ''), 'components': components,
                   'inputs': {name: fingerprint(name) for name in INPUTS}}
        update = {'release.json': json.dumps(release, sort_keys=True), 'pending.json': None}
        old = current(data)
        # A run that changed no image (a rerun, tests or secrets only) keeps
        # the rollback target it had instead of pointing it at itself.
        if old and old['components'] != components:
            update['previous.json'] = data['release.json']
        patch(update)
        print(json.dumps(release, indent=2, sort_keys=True))
    elif command == 'kept-tags':
        for tag in kept_tags(load()):
            print(tag)
    else:
        print(__doc__, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (RuntimeError, AssertionError, ValueError, urllib.error.URLError) as error:
        print(f'release: {error}', file=sys.stderr)
        sys.exit(1)
