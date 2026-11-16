#!/usr/bin/env python3
"""Read and hash registry content before rollout; Docker's local cache is insufficient."""
import hashlib
import json
import sys
import urllib.request

ACCEPT = ', '.join(('application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'))


def verify_image(base, ref, opener=urllib.request.urlopen):
    seen = set()

    def read(kind, name, expected=None):
        request = urllib.request.Request(f'{base}/{kind}/{name}', headers={'Accept': ACCEPT})
        digest = hashlib.sha256()
        size = 0
        chunks = []
        with opener(request, timeout=120) as response:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                if kind == 'manifests':
                    chunks.append(chunk)
        if expected and (size != expected['size'] or 'sha256:' + digest.hexdigest() != expected['digest']):
            raise ValueError(f'{kind}/{name}: content size or digest mismatch')
        return b''.join(chunks)

    def manifest(name, expected=None):
        if name in seen:
            return
        seen.add(name)
        body = json.loads(read('manifests', name, expected))
        if 'manifests' in body:
            for child in body['manifests']:
                manifest(child['digest'], child)
        else:
            for blob in [body['config'], *body['layers']]:
                if blob['digest'] not in seen:
                    read('blobs', blob['digest'], blob)
                    seen.add(blob['digest'])

    manifest(ref)
    return len(seen)


if __name__ == '__main__':
    registry, tag = sys.argv[1:]
    for repo in ('web', 'pilot', 'waitlist'):
        count = verify_image('http://' + registry.split('/', 1)[0] + '/v2/' + registry.split('/', 1)[1] + '/' + repo, tag)
        print(f'{repo}:{tag}: {count} registry objects verified')
