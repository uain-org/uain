"""Temporary-file tests; no production paths, nginx or systemctl are touched."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

HELPER = Path(__file__).with_name('install-aidollar-canonical.py')
RELEASE = '20261102T170000Z-123456789a'
PRIMARY = b'primary nginx bytes stay unchanged\n'
PREVIEW = b'''# HTTP, www and arbitrary opaque bytes stay unchanged: \xff
server {
    listen 80;
    listen [::]:80;
    server_name aidollar.money www.aidollar.money;
    location / { return 301 https://aidollar.money$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name www.aidollar.money;
    return 301 https://aidollar.money$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name aidollar.money;

    location = /baink { return 301 /baink/; }
    location = /baink/mcp { proxy_pass http://127.0.0.1:8798/mcp; }
    location ^~ /baink/proposals/ { proxy_pass http://127.0.0.1:8798/proposals/; }
    location ^~ /baink/api/ { proxy_pass http://127.0.0.1:8798/api/; }
    location ^~ /baink/ { root /var/www/baink-preview; }
    location ^~ /designs/ { root /var/www/aidollar-designs/current; }
    location / { try_files $uri $uri/ =404; }
}
'''
ADDED = b'    location = / { return 308 https://baink.money/$is_args$args; }\n\n'


def load_helper():
    spec = importlib.util.spec_from_file_location('aidollar_canonical', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(value):
    return hashlib.sha256(value).hexdigest()


class TransformTests(unittest.TestCase):
    def setUp(self):
        self.module = load_helper()

    def test_exact_https_apex_root_redirect_preserves_all_other_bytes_and_query_variables(self):
        result = self.module.transform_aidollar(PREVIEW)
        self.assertEqual(result.count(ADDED), 1)
        self.assertEqual(result.replace(ADDED, b'', 1), PREVIEW)
        self.assertIn(b'server_name aidollar.money;\n\n' + ADDED +
                      b'    location = /baink { return 301 /baink/; }', result)
        # These are nginx's original query variables, not request_uri: exact
        # root gets a fixed host/path and query bytes only; subpaths are retained.
        self.assertEqual(ADDED.count(b'$is_args$args'), 1)
        self.assertNotIn(b'$host', ADDED)
        self.assertNotIn(b'$request_uri', ADDED)

    def test_malformed_duplicate_wrong_scope_and_already_installed_config_fail_closed(self):
        for original in [b'no expected apex', PREVIEW + PREVIEW,
                         PREVIEW.replace(b'listen 443 ssl http2;', b'listen 80;', 2),
                         PREVIEW.replace(b'server_name aidollar.money;', b'server_name other.money;'),
                         PREVIEW.replace(b'    location = /baink {', b'    # changed\n    location = /baink {'),
                         PREVIEW + b'location = / { return 308 https://example.test; }',
                         self.module.transform_aidollar(PREVIEW)]:
            with self.subTest(original=original), self.assertRaises(ValueError):
                self.module.transform_aidollar(original)

    def test_import_never_checks_root_opens_files_or_runs_commands(self):
        with mock.patch('builtins.open', side_effect=AssertionError('import opened file')), \
             mock.patch('os.geteuid', side_effect=AssertionError('import checked root')), \
             mock.patch('os.open', side_effect=AssertionError('import opened descriptor')), \
             mock.patch('subprocess.run', side_effect=AssertionError('import ran command')):
            load_helper()


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.module = load_helper()
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.module.ROOT_UID = os.getuid()
        self.module.CONFIG_ROOT = self.root / 'config'
        self.module.RELEASE_ROOT = self.root / 'releases'
        self.module.BACKUP_ROOT = self.root / 'backups'
        for directory in [self.module.CONFIG_ROOT, self.module.RELEASE_ROOT, self.module.BACKUP_ROOT]:
            directory.mkdir(mode=0o755)
        (self.module.RELEASE_ROOT / RELEASE).mkdir(mode=0o755)
        (self.module.BACKUP_ROOT / RELEASE).mkdir(mode=0o700)
        self.module.CURRENT = self.root / 'current'
        self.module.CURRENT.symlink_to(self.module.RELEASE_ROOT / RELEASE)
        self.module.LOCK_PATH = self.root / 'activation.lock'
        self.module.LOCK_PATH.touch(mode=0o600)
        self.aidollar = self.module.CONFIG_ROOT / 'aidollar.money.conf'
        self.primary = self.module.CONFIG_ROOT / 'baink.money.conf'
        self.aidollar.write_bytes(PREVIEW)
        self.primary.write_bytes(PRIMARY)
        self.aidollar.chmod(0o644)
        self.primary.chmod(0o644)
        root_mock = mock.patch.object(self.module.os, 'geteuid', return_value=0)
        root_mock.start()
        self.addCleanup(root_mock.stop)
        services = mock.patch.object(self.module.subprocess, 'run')
        self.commands = services.start()
        self.addCleanup(services.stop)

    def install(self, args=None):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            self.module.main(args if args is not None else [RELEASE, sha(PREVIEW), sha(PRIMARY)])
        return json.loads(stream.getvalue())

    def assert_no_mutation(self):
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertFalse((self.module.BACKUP_ROOT / RELEASE / 'aidollar-canonical-nginx').exists())
        self.commands.assert_not_called()

    def test_argument_root_hash_and_release_guards_run_before_backup_or_config_mutation(self):
        for args in [[], [RELEASE], ['../escape', sha(PREVIEW), sha(PRIMARY)],
                     [RELEASE, 'bad', sha(PRIMARY)], [RELEASE, sha(PREVIEW), 'bad'],
                     [RELEASE, 'a' * 64, sha(PRIMARY)], [RELEASE, sha(PREVIEW), 'b' * 64],
                     ['20261101T000000Z-123456789a', sha(PREVIEW), sha(PRIMARY)]]:
            with self.subTest(args=args), self.assertRaises((ValueError, FileNotFoundError)):
                self.install(args)
            self.assert_no_mutation()
        with mock.patch.object(self.module.os, 'geteuid', return_value=501):
            with self.assertRaises(PermissionError):
                self.install()
        self.assert_no_mutation()

    def test_nonblocking_deployment_lock_prevents_concurrent_install(self):
        import fcntl
        with self.module.LOCK_PATH.open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.install()
        self.assert_no_mutation()

    def test_source_and_backup_symlinks_or_writable_ownership_fail_closed(self):
        for target in [self.aidollar, self.primary, self.module.LOCK_PATH]:
            original = target.read_bytes()
            other = target.with_name(target.name + '.other')
            target.rename(other)
            target.symlink_to(other)
            with self.subTest(symlink=target), self.assertRaises((ValueError, OSError)):
                self.install()
            target.unlink()
            other.rename(target)
            self.assertEqual(target.read_bytes(), original)
            self.assert_no_mutation()
        for target in [self.aidollar, self.primary, self.module.BACKUP_ROOT / RELEASE]:
            mode = stat.S_IMODE(target.stat().st_mode)
            target.chmod(mode | 0o022)
            with self.subTest(writable=target), self.assertRaises(PermissionError):
                self.install()
            target.chmod(mode)
            self.assert_no_mutation()
        with mock.patch.object(self.module, 'ROOT_UID', os.getuid() + 100):
            with self.assertRaises(PermissionError):
                self.install()
        self.assert_no_mutation()
        backup_release = self.module.BACKUP_ROOT / RELEASE
        moved = backup_release.with_name(RELEASE + '.real')
        backup_release.rename(moved)
        backup_release.symlink_to(moved)
        with self.assertRaises((ValueError, PermissionError)):
            self.install()
        self.assert_no_mutation()

    def test_success_has_restricted_backup_receipt_and_unchanged_primary(self):
        receipt = self.install()
        self.assertEqual(self.aidollar.read_bytes(), self.module.transform_aidollar(PREVIEW))
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        backup = self.module.BACKUP_ROOT / RELEASE / 'aidollar-canonical-nginx'
        self.assertEqual(sorted(p.name for p in backup.iterdir()), ['aidollar.money.conf'])
        self.assertEqual((backup / self.aidollar.name).read_bytes(), PREVIEW)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((backup / self.aidollar.name).stat().st_mode), 0o600)
        self.assertEqual(receipt['backup'], str(backup))
        self.assertEqual(receipt['before'], sha(PREVIEW))
        self.assertEqual(receipt['after'], sha(self.aidollar.read_bytes()))
        self.assertTrue(receipt['primaryUnchanged'])
        self.assertEqual(self.commands.call_args_list, [
            mock.call(['nginx', '-t'], check=True),
            mock.call(['systemctl', 'reload', 'nginx'], check=True)])
        self.assertEqual(self.aidollar.stat().st_mode & 0o777, 0o644)
        with self.assertRaises(ValueError):
            self.install([RELEASE, sha(self.aidollar.read_bytes()), sha(PRIMARY)])

    def test_existing_backup_is_never_overwritten(self):
        backup = self.module.BACKUP_ROOT / RELEASE / 'aidollar-canonical-nginx'
        backup.mkdir(mode=0o700)
        sentinel = backup / 'sentinel'
        sentinel.write_bytes(b'keep me')
        with self.assertRaises(FileExistsError):
            self.install()
        self.assertEqual(sentinel.read_bytes(), b'keep me')
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.commands.assert_not_called()

    def test_nginx_test_and_reload_failures_restore_only_owned_bytes_and_revalidate(self):
        import shutil
        for fail_index in [0, 1]:
            if fail_index:
                shutil.rmtree(self.module.BACKUP_ROOT / RELEASE / 'aidollar-canonical-nginx')
            calls = 0
            def fail_once(command, check):
                nonlocal calls
                index = calls
                calls += 1
                if index == fail_index:
                    raise subprocess.CalledProcessError(1, command)
            self.commands.reset_mock()
            self.commands.side_effect = fail_once
            with self.subTest(fail_index=fail_index), self.assertRaises(subprocess.CalledProcessError):
                self.install()
            self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
            self.assertEqual(self.primary.read_bytes(), PRIMARY)
            self.assertEqual(self.commands.call_args_list[-2:], [
                mock.call(['nginx', '-t'], check=True),
                mock.call(['systemctl', 'reload', 'nginx'], check=True)])

    def test_concurrent_config_change_is_never_overwritten_during_rollback(self):
        foreign = b'foreign operator configuration\n'
        def changed(command, check):
            self.aidollar.write_bytes(foreign)
            raise subprocess.CalledProcessError(1, command)
        self.commands.side_effect = changed
        with self.assertRaises(subprocess.CalledProcessError):
            self.install()
        self.assertEqual(self.aidollar.read_bytes(), foreign)
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertEqual(self.commands.call_count, 1)

    def test_primary_drift_after_replace_restores_own_preview_without_running_nginx(self):
        original_replace = self.module.replace_owned
        foreign = b'primary changed by another operator\n'
        def drift_after_replace(path, expected, content, release, mode):
            original_replace(path, expected, content, release, mode)
            if content != PREVIEW:
                self.primary.write_bytes(foreign)
        with mock.patch.object(self.module, 'replace_owned', side_effect=drift_after_replace):
            with self.assertRaises((ValueError, RuntimeError)):
                self.install()
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.assertEqual(self.primary.read_bytes(), foreign)
        self.commands.assert_not_called()

    def test_primary_drift_during_forward_nginx_test_never_reloads_foreign_primary(self):
        foreign = b'primary changed during nginx test\n'
        def drift_during_test(command, check):
            if command == ['nginx', '-t']:
                self.primary.write_bytes(foreign)
        self.commands.side_effect = drift_during_test
        with self.assertRaises((ValueError, RuntimeError)):
            self.install()
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.assertEqual(self.primary.read_bytes(), foreign)
        self.assertEqual(self.commands.call_args_list, [mock.call(['nginx', '-t'], check=True)])

    def test_release_drift_after_replace_restores_own_preview_without_running_nginx(self):
        other = self.module.RELEASE_ROOT / '20261102T180000Z-aaaaaaaaaa'
        other.mkdir(mode=0o755)
        original_replace = self.module.replace_owned
        def drift_after_replace(path, expected, content, release, mode):
            original_replace(path, expected, content, release, mode)
            if content != PREVIEW:
                self.module.CURRENT.unlink()
                self.module.CURRENT.symlink_to(other)
        with mock.patch.object(self.module, 'replace_owned', side_effect=drift_after_replace):
            with self.assertRaises((ValueError, RuntimeError)):
                self.install()
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.assertEqual(self.primary.read_bytes(), PRIMARY)
        self.assertEqual(self.module.CURRENT.resolve(), other.resolve())
        self.commands.assert_not_called()

    def test_primary_drift_during_rollback_nginx_test_never_reloads_foreign_primary(self):
        foreign = b'primary changed during rollback nginx test\n'
        calls = 0
        def fail_then_drift(command, check):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise subprocess.CalledProcessError(1, command)
            if command == ['nginx', '-t']:
                self.primary.write_bytes(foreign)
        self.commands.side_effect = fail_then_drift
        with self.assertRaises((ValueError, RuntimeError)):
            self.install()
        self.assertEqual(self.aidollar.read_bytes(), PREVIEW)
        self.assertEqual(self.primary.read_bytes(), foreign)
        self.assertEqual(self.commands.call_args_list, [
            mock.call(['nginx', '-t'], check=True), mock.call(['nginx', '-t'], check=True)])


if __name__ == '__main__':
    unittest.main()
