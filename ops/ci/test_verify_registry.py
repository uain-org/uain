import hashlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('verify_registry', Path(__file__).with_name('verify-registry.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RegistryTest(unittest.TestCase):
    def fixture(self):
        blob = b'layer bytes'
        descriptor = lambda b: {'digest': 'sha256:' + hashlib.sha256(b).hexdigest(), 'size': len(b)}
        layer = descriptor(blob)
        child = json.dumps({'config': layer, 'layers': [layer]}).encode()
        desc = descriptor(child)
        objects = {'manifests/tag': json.dumps({'manifests': [desc]}).encode(), 'manifests/' + desc['digest']: child, 'blobs/' + layer['digest']: blob}
        def opener(request, **kwargs):
            name = request.full_url.removeprefix('http://registry/v2/web/')
            if name not in objects:
                raise HTTPError(request.full_url, 404, 'missing', {}, io.BytesIO())
            return io.BytesIO(objects[name])
        return objects, opener

    def test_complete_graph(self):
        _, opener = self.fixture()
        self.assertEqual(m.verify_image('http://registry/v2/web', 'tag', opener), 3)

    def test_missing_child_refuses_rollout(self):
        objects, opener = self.fixture()
        del objects[next(k for k in objects if k.startswith('manifests/sha256:'))]
        with self.assertRaises(HTTPError) as error:
            m.verify_image('http://registry/v2/web', 'tag', opener)
        error.exception.close()

    def test_success_status_with_empty_or_corrupt_layer_refuses_rollout(self):
        for data in (b'', b'wrong bytes'):
            objects, opener = self.fixture()
            objects[next(k for k in objects if k.startswith('blobs/'))] = data
            with self.assertRaises(ValueError):
                m.verify_image('http://registry/v2/web', 'tag', opener)


if __name__ == '__main__':
    unittest.main()
