"""Local tests; never open production files or run nginx/systemctl."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

HELPER = Path(__file__).with_name('install-proposal-routing.py')
RELEASE = '20261102T120000Z-123456789a'
PRIMARY = b'primary config unchanged\n'
PREVIEW = b'''# AI Dollar root and unrelated byte: \xff
server {
    location = /baink/mcp { proxy_pass http://127.0.0.1:8798/mcp; }
    location ^~ /baink/api/ {
        proxy_pass http://127.0.0.1:8798/api/;
    }
    location /designs/ { root /var/www/aidollar; }
    location /baink/ { alias /var/www/baink-preview/baink/; }
    location / { root /var/www/aidollar; }
}
'''


def load_helper():
    spec = importlib.util.spec_from_file_location('proposal_routing', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(data):
    return hashlib.sha256(data).hexdigest()


class TransformTests(unittest.TestCase):
    def setUp(self):
        self.module = load_helper()

    def test_inserted_locations_proxy_only_preview_proposals_and_preserve_every_other_byte(self):
        result = self.module.transform_preview(PREVIEW)
        marker = b'    location ^~ /baink/api/ {'
        added = result[len(PREVIEW.split(marker)[0]):result.index(marker)]
        self.assertTrue(added.startswith(b'    location = /baink/proposals {\n'))
        self.assertIn(b'    location ^~ /baink/proposals/ {\n', added)
        self.assertIn(b'proxy_pass http://127.0.0.1:8798/proposals;', added)
        self.assertIn(b'proxy_pass http://127.0.0.1:8798/proposals/;', added)
        for directive in [b'limit_req zone=baink_api burst=30 nodelay;',
                          b'limit_req_status 429;', b'proxy_set_header Host $host;',
                          b'proxy_set_header X-Real-IP $remote_addr;',
                          b'client_max_body_size 16k;', b'proxy_connect_timeout 5s;',
                          b'proxy_read_timeout 20s;']:
            self.assertEqual(added.count(directive), 2)
        self.assertEqual(result.replace(added, b'', 1), PREVIEW)

    def test_missing_duplicate_or_existing_proposal_route_fails_closed(self):
        for value in [b'no marker', PREVIEW + PREVIEW,
                      PREVIEW + b'location /baink/proposals { return 404; }',
                      PREVIEW + b'location ^~ /baink/proposals/ { return 404; }']:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.module.transform_preview(value)

    def test_import_does_not_access_production_paths_check_root_or_run_services(self):
        with mock.patch('builtins.open', side_effect=AssertionError('import opened file')), \
             mock.patch('os.geteuid', side_effect=AssertionError('import checked root')), \
             mock.patch('subprocess.run', side_effect=AssertionError('import ran service')):
            load_helper()


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.module = load_helper()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.module.CONFIG_ROOT = self.root / 'config'
        self.module.CONFIG_ROOT.mkdir()
        self.primary = self.module.CONFIG_ROOT / 'baink.money.conf'
        self.preview = self.module.CONFIG_ROOT / 'aidollar.money.conf'
        self.primary.write_bytes(PRIMARY)
        self.preview.write_bytes(PREVIEW)
        self.module.RELEASE_ROOT = self.root / 'releases'
        self.module.RELEASE_ROOT.mkdir()
        (self.module.RELEASE_ROOT / RELEASE).mkdir()
        self.module.CURRENT = self.root / 'current'
        self.module.CURRENT.symlink_to(self.module.RELEASE_ROOT / RELEASE)
        self.module.LOCK_PATH = self.root / 'activation.lock'
        self.module.LOCK_PATH.touch()
        self.module.BACKUP_ROOT = self.root / 'backups'
        (self.module.BACKUP_ROOT / RELEASE).mkdir(parents=True)
        self.root_mock = mock.patch.object(self.module.os, 'geteuid', return_value=0)
        self.root_mock.start()
        self.addCleanup(self.root_mock.stop)
        self.service = mock.patch.object(self.module.subprocess, 'run')
        self.run_service = self.service.start()
        self.addCleanup(self.service.stop)

    def run_install(self, *args):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            self.module.main(list(args or [RELEASE, sha(PRIMARY), sha(PREVIEW)]))
        return json.loads(stream.getvalue())

    def assert_unmodified(self):
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertEqual(self.preview.read_bytes(), PREVIEW)
        self.assertFalse((self.module.BACKUP_ROOT / RELEASE / 'proposal-nginx').exists())
        self.run_service.assert_not_called()

    def test_cli_rejects_nonroot_wrong_arguments_stale_release_and_hashes_before_mutation(self):
        for args in [[], [RELEASE], [RELEASE, 'bad', sha(PREVIEW)],
                     ['../escape', sha(PRIMARY), sha(PREVIEW)]]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.module.main(args)
            self.assert_unmodified()
        with mock.patch.object(self.module.os, 'geteuid', return_value=501):
            with self.assertRaises(PermissionError):
                self.run_install()
        self.assert_unmodified()
        for args in [['20261101T120000Z-123456789a', sha(PRIMARY), sha(PREVIEW)],
                     [RELEASE, 'a' * 64, sha(PREVIEW)],
                     [RELEASE, sha(PRIMARY), 'b' * 64]]:
            with self.subTest(args=args), self.assertRaises((ValueError, FileNotFoundError)):
                self.run_install(*args)
            self.assert_unmodified()

    def test_busy_activation_lock_fails_without_changing_anything(self):
        import fcntl
        with self.module.LOCK_PATH.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.run_install()
        self.assert_unmodified()

    def test_success_changes_only_preview_and_records_exact_restricted_backup(self):
        receipt = self.run_install()
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertEqual(self.preview.read_bytes(), self.module.transform_preview(PREVIEW))
        backup = self.module.BACKUP_ROOT / RELEASE / 'proposal-nginx'
        self.assertEqual(sorted(p.name for p in backup.iterdir()), ['aidollar.money.conf'])
        self.assertEqual((backup / 'aidollar.money.conf').read_bytes(), PREVIEW)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / 'aidollar.money.conf').stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt['backup'], str(backup))
        self.assertEqual(receipt['configs'][0]['before'], sha(PREVIEW))
        self.assertEqual(receipt['configs'][0]['after'], sha(self.preview.read_bytes()))
        self.assertTrue(receipt['primaryUnchanged'])
        self.assertEqual(self.run_service.call_args_list, [
            mock.call(['nginx', '-t'], check=True),
            mock.call(['systemctl', 'reload', 'nginx'], check=True)])
        with self.assertRaises(ValueError):
            self.run_install()

    def test_failed_validation_or_reload_restores_own_preview_bytes_and_rechecks_nginx(self):
        for fail_index in [0, 1]:
            with self.subTest(fail_index=fail_index):
                if fail_index:
                    import shutil
                    shutil.rmtree(self.module.BACKUP_ROOT / RELEASE / 'proposal-nginx')
                calls = 0
                def fail_once(command, check):
                    nonlocal calls
                    current = calls
                    calls += 1
                    if current == fail_index:
                        raise subprocess.CalledProcessError(1, command)
                self.run_service.reset_mock()
                self.run_service.side_effect = fail_once
                with self.assertRaises(subprocess.CalledProcessError):
                    self.run_install()
                self.assertEqual(self.primary.read_bytes(), PRIMARY)
                self.assertEqual(self.preview.read_bytes(), PREVIEW)
                self.assertEqual(self.run_service.call_args_list[-2:], [
                    mock.call(['nginx', '-t'], check=True),
                    mock.call(['systemctl', 'reload', 'nginx'], check=True)])

    def test_rollback_never_overwrites_concurrently_changed_preview(self):
        changed = b'another operator changed the preview\n'
        def changed_during_validation(command, check):
            self.preview.write_bytes(changed)
            raise subprocess.CalledProcessError(1, command)
        self.run_service.side_effect = changed_during_validation
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install()
        self.assertEqual(self.preview.read_bytes(), changed)
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertEqual(self.run_service.call_count, 1)


if __name__ == '__main__':
    unittest.main()
