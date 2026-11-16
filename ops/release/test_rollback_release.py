"""Exercise baink-rollback-release.py against a disposable mapped filesystem."""
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('rollback', HERE / 'baink-rollback-release.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

OLD = '20261106T093354Z-40552e7ba4'
NEW = '20261106T095448Z-3bfb533803'


def make_release(root, release):
    directory = root / 'releases' / release
    (directory / 'dist').mkdir(parents=True)
    (directory / 'preview').mkdir()
    (directory / 'dist' / 'index.html').write_text(release)
    (directory / 'preview' / 'index.html').write_text('preview ' + release)
    sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    manifest = {
        'release': release, 'version': '0.3.31',
        'files': {'dist/index.html': sha(directory / 'dist' / 'index.html')},
        'preview_files': {'index.html': sha(directory / 'preview' / 'index.html')},
    }
    (directory / 'release-manifest.json').write_text(json.dumps(manifest))
    return directory


class RollbackTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.paths = {k: root / k for k in ['staging', 'releases', 'backups', 'state']}
        for p in self.paths.values():
            p.mkdir()
        self.paths['current'] = root / 'current'
        self.paths['preview'] = root / 'preview-link'
        self.paths['env'] = root / 'baink.env'
        self.paths['env'].write_text('X=1\n')
        (self.paths['state'] / 'state.json').write_text('{"live":true}')
        self.old = make_release(root, OLD)
        self.new = make_release(root, NEW)
        os.symlink(self.new, self.paths['current'])
        os.symlink(self.new / 'preview', self.paths['preview'])
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def control(self, *args):
        self.calls.append(args)

    def test_switches_code_and_preview_without_restoring_state(self):
        result = helper.rollback(OLD, NEW, self.paths, self.control, lambda: True, tag='t1')
        self.assertEqual(self.paths['current'].resolve().name, OLD)
        self.assertEqual(self.paths['preview'].resolve(), (self.old / 'preview').resolve())
        self.assertFalse(result['stateRestored'])
        self.assertEqual((self.paths['state'] / 'state.json').read_text(), '{"live":true}')
        self.assertEqual(self.calls, [('stop', 'baink.service'), ('start', 'baink.service')])

    def test_wrong_expected_current_refuses_before_stop(self):
        with self.assertRaises(helper.Refused):
            helper.rollback(OLD, '20261101T000000Z-aaaaaaaaaa', self.paths, self.control, lambda: True, tag='t2')
        self.assertEqual(self.calls, [])
        self.assertEqual(self.paths['current'].resolve().name, NEW)

    def test_tampered_target_refuses_before_stop(self):
        (self.old / 'dist' / 'index.html').write_text('tampered')
        with self.assertRaises(helper.Refused):
            helper.rollback(OLD, NEW, self.paths, self.control, lambda: True, tag='t3')
        self.assertEqual(self.calls, [])

    def test_failed_health_restores_expected_current(self):
        with self.assertRaises(helper.Refused):
            helper.rollback(OLD, NEW, self.paths, self.control, lambda: False, tag='t4')
        self.assertEqual(self.paths['current'].resolve().name, NEW)
        self.assertEqual(self.paths['preview'].resolve(), (self.new / 'preview').resolve())
        self.assertEqual(self.calls[-1], ('start', 'baink.service'))

    def test_main_requires_yes(self):
        self.assertEqual(helper.main([OLD, NEW]), 2)


if __name__ == '__main__':
    unittest.main()
