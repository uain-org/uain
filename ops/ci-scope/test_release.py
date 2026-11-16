import hashlib
import importlib.util
import json
import pathlib
import types
import unittest

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

REG = '10.98.0.1:5000/uain'
A, B, C, S = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40
DIG = 'sha256:' + 'e' * 64


def record(source=S, tags=(A, B, C)):
    return {'schemaVersion': 1, 'source': source, 'components': {
        name: {'tag': tag, 'digest': DIG} for name, tag in zip(release.COMPONENTS, tags)}}


class Base(unittest.TestCase):
    def images(self, web=A, pilot=B, waitlist=C):
        return {'web': [f'{REG}/web:{web}'], 'pilot': [f'{REG}/pilot:{pilot}', f'{REG}/pilot:{pilot}'],
                'waitlist': [f'{REG}/waitlist:{waitlist}']}

    def test_base_is_the_recorded_source_when_live_images_match(self):
        data = {'release.json': json.dumps(record())}
        self.assertEqual(release.base(REG, data, self.images())[0], S)

    def test_drift_from_the_record_forces_a_full_deploy(self):
        data = {'release.json': json.dumps(record())}
        self.assertIsNone(release.base(REG, data, self.images(web=S))[0])
        mixed = self.images()
        mixed['pilot'][1] = f'{REG}/pilot:{S}'  # the native-rpc sidecar on another tag
        self.assertIsNone(release.base(REG, data, mixed)[0])

    def test_missing_or_invalid_records_force_a_full_deploy(self):
        self.assertIsNone(release.base(REG, None, self.images())[0])
        self.assertIsNone(release.base(REG, {'release.json': '{'}, self.images())[0])
        bad = record()
        bad['components']['web']['digest'] = 'latest'
        self.assertIsNone(release.base(REG, {'release.json': json.dumps(bad)}, self.images())[0])


class Kept(unittest.TestCase):
    def test_current_previous_and_in_flight_tags_are_kept(self):
        data = {'release.json': json.dumps(record()),
                'previous.json': json.dumps(record(source=C, tags=(C, C, C))),
                'pending.json': json.dumps({'tag': 'f' * 40})}
        self.assertEqual(release.kept_tags(data), [A, B, C, S, 'f' * 40])

    def test_nothing_recorded_keeps_nothing_extra(self):
        self.assertEqual(release.kept_tags(None), [])
        self.assertEqual(release.kept_tags({'pending.json': 'not json'}), [])


class Response:
    def __init__(self, body=b'', headers=None):
        self.body, self.headers = body, headers or {}

    def read(self, *_):
        body, self.body = self.body, b''
        return body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class Registry:
    def __init__(self, manifests):
        self.manifests, self.puts = dict(manifests), []

    def __call__(self, request, timeout=None):
        ref = request.full_url.rsplit('/', 1)[1]
        if request.get_method() == 'PUT':
            self.puts.append((ref, request.headers.get('Content-type')))
            self.manifests[ref] = request.data
            return Response(headers={'Docker-Content-Digest': 'sha256:' + hashlib.sha256(request.data).hexdigest()})
        return Response(self.manifests[ref], {'Content-Type': 'application/vnd.oci.image.index.v1+json'})


class Retag(unittest.TestCase):
    def test_retag_keeps_the_exact_digest(self):
        body = b'{"manifests": []}'
        digest = 'sha256:' + hashlib.sha256(body).hexdigest()
        registry = Registry({A: body})
        release.retag(REG, 'web', A, B, digest, opener=registry)
        self.assertEqual(registry.manifests[B], body)
        self.assertEqual(registry.puts, [(B, 'application/vnd.oci.image.index.v1+json')])

    def test_retag_refuses_an_image_that_changed_since_the_record(self):
        registry = Registry({A: b'{"other": 1}'})
        with self.assertRaises(RuntimeError):
            release.retag(REG, 'web', A, B, DIG, opener=registry)
        self.assertEqual(registry.puts, [])


def index(image, attestation):
    """What `docker build` pushes: the platform image and a build attestation that differs every build."""
    return json.dumps({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
        {'digest': image, 'platform': {'os': 'linux', 'architecture': 'amd64'}},
        {'digest': attestation, 'platform': {'os': 'unknown', 'architecture': 'unknown'},
         'annotations': {'vnd.docker.reference.type': 'attestation-manifest'}}]}).encode()


def sha(body):
    return 'sha256:' + hashlib.sha256(body).hexdigest()


class SameImage(unittest.TestCase):
    IMAGE, OTHER = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64

    def registry(self, recorded, built, at_recorded_tag=None):
        return Registry({A: at_recorded_tag or recorded, sha(recorded): recorded, B: built})

    def test_a_rebuild_of_the_same_image_is_the_same_whatever_its_attestation(self):
        # The pilot on 10 November 2026: one image, a new index digest on every deploy.
        recorded, built = index(self.IMAGE, 'sha256:' + '8' * 64), index(self.IMAGE, 'sha256:' + '9' * 64)
        self.assertNotEqual(sha(recorded), sha(built))
        component = {'tag': A, 'digest': sha(recorded)}
        self.assertTrue(release.same_image(REG, 'pilot', B, component, opener=self.registry(recorded, built)))
        self.assertEqual(release.image_identity(REG, 'pilot', B, opener=self.registry(recorded, built)), self.IMAGE)

    def test_a_changed_image_is_not_the_same(self):
        recorded, built = index(self.IMAGE, 'sha256:' + '8' * 64), index(self.OTHER, 'sha256:' + '8' * 64)
        component = {'tag': A, 'digest': sha(recorded)}
        self.assertFalse(release.same_image(REG, 'pilot', B, component, opener=self.registry(recorded, built)))

    def test_a_recorded_tag_that_moved_is_never_kept(self):
        recorded, built = index(self.IMAGE, 'sha256:' + '8' * 64), index(self.IMAGE, 'sha256:' + '9' * 64)
        moved = self.registry(recorded, built, at_recorded_tag=index(self.OTHER, 'sha256:' + '7' * 64))
        with self.assertRaises(RuntimeError):
            release.same_image(REG, 'pilot', B, {'tag': A, 'digest': sha(recorded)}, opener=moved)

    def test_a_plain_manifest_is_its_own_identity_and_an_unclear_index_is_refused(self):
        plain = b'{"schemaVersion": 2, "config": {}, "layers": []}'
        self.assertEqual(release.image_identity(REG, 'web', A, opener=Registry({A: plain})), sha(plain))
        two = json.dumps({'manifests': [{'digest': self.IMAGE, 'platform': {'os': 'linux'}},
                                        {'digest': self.OTHER, 'platform': {'os': 'linux'}}]}).encode()
        none = json.dumps({'manifests': [{'digest': self.IMAGE, 'platform': {'os': 'unknown'},
                                          'annotations': {'vnd.docker.reference.type': 'attestation-manifest'}}]}).encode()
        for body in (two, none, b'{"manifests": [{"digest": "latest", "platform": {"os": "linux"}}]}'):
            with self.assertRaises(RuntimeError):
                release.image_identity(REG, 'web', A, opener=Registry({A: body}))


class Fingerprint(unittest.TestCase):
    def test_fingerprint_names_versions_not_values(self):
        seen = []

        def run(*args, check=True):
            seen.append(args)
            out = '' if args[2] == 'uain-kalki' else f'uid-{args[2]}/7'
            return types.SimpleNamespace(returncode=0, stdout=out, stderr='')

        print_ = release.fingerprint('pilot', run=run)
        self.assertIn('secret/uain-env=uid-uain-env/7', print_)
        self.assertIn('secret/uain-kalki=-', print_)
        self.assertIn('configmap/uain-native-config=uid-uain-native-config/7', print_)
        self.assertTrue(all('jsonpath={.metadata.uid}/{.metadata.resourceVersion}' in a for a in seen))
        self.assertEqual(release.fingerprint('web', run=run), '')


if __name__ == '__main__':
    unittest.main()
