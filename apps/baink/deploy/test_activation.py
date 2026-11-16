"""Run the actual activation helper against a disposable, mapped filesystem."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch


class ActivationTest(unittest.TestCase):
    def test_health_gate_allows_bounded_proof_transport_startup(self):
        import ast
        source = Path(__file__).with_name('activate-release.py').read_text()
        function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'healthy')
        class Health(io.BytesIO):
            status = 200
        attempts = []
        def probe(*args, **kwargs):
            attempts.append(None)
            if len(attempts) <= 50:
                raise ConnectionRefusedError('bounded fixture startup')
            return Health(b'{"ok":true}')
        scope = {'urllib': types.SimpleNamespace(request=types.SimpleNamespace(urlopen=probe)), 'time': types.SimpleNamespace(sleep=lambda seconds: None, monotonic=lambda: 0), 'json': json}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<health-gate>', 'exec'), scope)
        self.assertTrue(scope['healthy']())
        self.assertEqual(len(attempts), 51)
        scope['urllib'].request.urlopen = lambda *a, **k: (_ for _ in ()).throw(ConnectionRefusedError())
        self.assertFalse(scope['healthy']())
        clock = [0]
        hung_attempts = []
        def hung(*args, **kwargs):
            hung_attempts.append(None)
            clock[0] += kwargs['timeout']
            raise TimeoutError('fixture hung endpoint')
        scope['urllib'].request.urlopen = hung
        scope['time'] = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        self.assertFalse(scope['healthy']())
        self.assertLessEqual(len(hung_attempts), 14)
        self.assertLess(clock[0], 33)

    # activate-release.py extracts with tarfile's 'data' filter (Python 3.12, and
    # 3.11.4+), which the BAINK host has; on an older Python it refuses with a
    # TypeError before touching anything. The CI image is Debian's 3.11.2.
    @unittest.skipUnless(hasattr(tarfile, 'data_filter'),
                         "needs tarfile's 'data' extraction filter (Python 3.12 or 3.11.4+), as on the BAINK host")
    def test_activation_preserves_disabled_enrolment_and_other_environment_bytes(self):
        script = Path(__file__).with_name('activate-release.py')
        release, prior = '20261103T160000Z-1234567890', '20261103T150000Z-1234567890'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def mapped(value):
                value = str(value)
                return root / value.lstrip('/') if any(value == p or value.startswith(p + '/') for p in ('/opt', '/var', '/etc')) else Path(value)
            for directory in ['/var/lib/baink-deployments', '/var/lib/baink', '/var/www/baink-preview/baink', '/var/backups/baink', '/etc']:
                mapped(directory).mkdir(parents=True, exist_ok=True, mode=0o700)
            old = mapped('/opt/baink/releases') / prior
            old.mkdir(parents=True)
            mapped('/opt/baink/current').symlink_to(old)
            env = mapped('/etc/baink.env')
            original = b'# Keep operator configuration\nBAINK_NATIVE_ENROL_ENABLED=0\nOTHER_SETTING=fixture\n'
            env.write_bytes(original)
            env.chmod(0o600)
            state = mapped('/var/lib/baink/state.json')
            state.write_text('{"accounts":{}}')
            state.chmod(0o600)
            management = mapped('/var/lib/baink/management.sqlite')
            management.write_bytes(b'fixture-closed-sqlite')
            management.chmod(0o600)
            store = mapped('/var/lib/baink/state.sqlite')
            store.write_bytes(b'fixture-closed-state-sqlite')
            store.chmod(0o600)
            review = mapped('/var/lib/baink/public-review')
            review.mkdir(mode=0o700)
            (review / 'vault.key').write_bytes(b'fixture-private-material')
            (review / 'vault.key').chmod(0o600)
            (review / 'once.json').write_bytes(b'{"completed":true}')
            (review / 'once.json').chmod(0o600)
            worker_key = mapped('/var/lib/baink/public-review-worker.key')
            worker_key.write_bytes(b'fixture-worker-material')
            worker_key.chmod(0o600)
            payload = root / 'payload'
            (payload / 'server').mkdir(parents=True)
            (payload / 'preview').mkdir()
            (payload / 'server/index.mjs').write_text('// fixture')
            (payload / 'preview/index.html').write_text('<p>fixture</p>')
            digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
            manifest = {'release': release, 'version': '0.3.17', 'files': {'server/index.mjs': digest(payload / 'server/index.mjs')}, 'preview_files': {'index.html': digest(payload / 'preview/index.html')}}
            (payload / 'release-manifest.json').write_text(json.dumps(manifest))
            staging = mapped('/var/lib/baink-deployments') / release
            staging.mkdir()
            archive = staging / 'release.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                for name in ['server/index.mjs', 'preview/index.html', 'release-manifest.json']:
                    bundle.add(payload / name, arcname=name)
            class Health(io.BytesIO):
                status = 200
            actual_open = open
            def fixture_open(file, *args, **kwargs):
                if isinstance(file, str) and file.startswith('/var/lib/baink-deployments/'):
                    file = mapped(file)
                return actual_open(file, *args, **kwargs)
            with patch.dict(sys.modules, {'pathlib': types.SimpleNamespace(Path=mapped)}), patch.object(sys, 'argv', [str(script), release, digest(archive), prior]), patch('builtins.open', side_effect=fixture_open), patch('os.geteuid', return_value=0), patch('os.chown'), patch('subprocess.run', return_value=subprocess.CompletedProcess([], 0)), patch('urllib.request.urlopen', side_effect=lambda *a, **k: Health(b'{"ok":true}')), contextlib.redirect_stdout(io.StringIO()):
                namespace = runpy.run_path(str(script), run_name='__main__')
                namespace['lock'].close()
            self.assertEqual((mapped('/var/backups/baink') / release / 'management.sqlite').read_bytes(), b'fixture-closed-sqlite')
            self.assertEqual((mapped('/var/backups/baink') / release / 'state.sqlite').read_bytes(), b'fixture-closed-state-sqlite')
            self.assertEqual(env.read_bytes(), original)
            self.assertEqual((mapped('/var/backups/baink') / release / 'baink.env').read_bytes(), original)
            self.assertEqual(mapped('/opt/baink/current').resolve().name, release)
            recovery = mapped('/var/backups/baink') / release
            self.assertEqual((recovery / 'public-review/vault.key').read_bytes(), b'fixture-private-material')
            self.assertEqual((recovery / 'public-review/once.json').read_bytes(), b'{"completed":true}')
            self.assertEqual((recovery / 'public-review-worker.key').read_bytes(), b'fixture-worker-material')


if __name__ == '__main__':
    unittest.main()
