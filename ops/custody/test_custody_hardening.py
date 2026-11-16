"""Anchor runner guard (D2 c) and nightly live-file refresh (CU-6). Fictional files only;
never opens a vault, runs systemctl, docker or node."""
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hardening_custody', Path(__file__).with_name('custody.py'))
custody = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'pykeepass': types.SimpleNamespace(PyKeePass=object, create_database=object)}):
    spec.loader.exec_module(custody)

LIVE_RUNNER = 'actions.runner.nuah-org-uain-universa.uain-production.service'


class Done:
    def __init__(self, returncode=0, stdout=''):
        self.returncode, self.stdout = returncode, stdout


class AnchorRunnerGuardTests(unittest.TestCase):
    def guarded(self, systemctl):
        calls = []

        def run(command, *args, **kwargs):
            calls.append(command)
            if command[0] == 'systemctl':
                return systemctl(command)
            raise AssertionError('nothing but systemctl may run before the guard: %r' % (command,))

        def vault(*_):
            raise AssertionError('vault opened')
        with patch.object(custody.subprocess, 'run', run), patch.object(custody, 'vault', vault), \
                patch.object(custody, 'child_env', lambda: {}):
            with self.assertRaises(custody.CustodyError):
                custody.anchor(['catchup', '--send'])
        return calls

    def test_the_renamed_runner_blocks_a_send_before_the_vault_is_opened(self):
        def systemctl(command):
            if 'is-active' in command:
                return Done(3)  # the old fixed unit name is not active
            return Done(0, LIVE_RUNNER + ' loaded active running GitHub Actions Runner\n')
        self.guarded(systemctl)

    def test_ci_workers_also_block_and_recovery_is_guarded_too(self):
        def systemctl(command):
            return Done(3) if 'is-active' in command else Done(0, 'uain-ci-worker-2.service loaded active running w\n')
        self.guarded(systemctl)
        with patch.object(custody.subprocess, 'run', lambda c, *a, **k: systemctl(c) if c[0] == 'systemctl' else self.fail(c)), \
                patch.object(custody, 'child_env', lambda: {}), self.assertRaises(custody.CustodyError):
            custody.anchor(['recover-anchor'])

    def test_an_unanswerable_systemctl_fails_closed(self):
        self.guarded(lambda command: Done(3) if 'is-active' in command else Done(1))

        def missing(command, *args, **kwargs):
            raise FileNotFoundError('systemctl')
        with patch.object(custody.subprocess, 'run', missing), patch.object(custody, 'child_env', lambda: {}), \
                patch.object(custody, 'vault', lambda *_: self.fail('vault opened')), self.assertRaises(custody.CustodyError):
            custody.anchor(['solana-recover'])

    def test_quiet_host_proceeds_to_the_vault(self):
        class Opened(Exception):
            pass

        def vault(*_):
            raise Opened()
        original = tempfile.TemporaryDirectory
        with patch.object(custody.subprocess, 'run', lambda c, *a, **k: Done(0, 'other-unit.service loaded active running x\n')), \
                patch.object(custody, 'vault', vault), patch.object(custody, 'child_env', lambda: {}), \
                patch.object(custody.tempfile, 'TemporaryDirectory', lambda prefix, dir: original(prefix=prefix)), \
                self.assertRaises(Opened):
            custody.anchor(['catchup', '--send'])


class LiveFilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.outside = self.root / 'host-only' / 'secret.txt'
        self.outside.parent.mkdir()
        self.outside.write_text('FICTIONAL host file outside the volume')
        self.volume = self.root / 'volume'
        (self.volume / 'member').mkdir(parents=True)
        self.anchor = self.root / 'anchor'
        self.anchor.mkdir()
        for name in ('operations.json', 'solana.json', 'ledger-public.pem'):
            (self.anchor / name).write_text('{}')

    def live(self):
        stdout = json.dumps([{'Mountpoint': str(self.volume)}])
        with patch.object(custody, 'ANCHOR', self.anchor), patch.object(custody, 'kubernetes_secret', lambda name: {}), \
                patch.object(custody.subprocess, 'run', lambda *a, **k: Done(0, stdout)):
            return {k: v for k, v in custody.live_files({}).items() if k.startswith('volumes/')}

    def test_a_symlinked_state_file_or_directory_is_not_imported(self):
        (self.volume / 'state.json').symlink_to(self.outside)
        (self.volume / 'linked').symlink_to(self.outside.parent, target_is_directory=True)
        (self.outside.parent / 'key.json').write_text('FICTIONAL host key outside the volume')
        (self.volume / 'member' / 'key.json').write_text('{"fictional":"member"}')
        files = self.live()
        for data in files.values():
            self.assertNotIn(b'FICTIONAL host', data)
        self.assertIn('volumes/uain-review-codex_member/member/key.json', files)
        self.assertNotIn('volumes/uain-review-codex_member/state.json', files)

    def test_an_oversized_or_hard_linked_file_is_skipped_and_the_refresh_completes(self):
        (self.volume / 'state.json').write_bytes(b'x' * (1024 * 1024 + 1))
        (self.volume / 'member' / 'auth.json').write_text('{"fictional":"auth"}')
        os.link(self.volume / 'member' / 'auth.json', self.volume / 'worker.json')
        (self.volume / 'member' / 'key.json').write_text('{"fictional":"member"}')
        files = self.live()
        # The fictional docker answer gives both reviewer volumes the same folder.
        self.assertEqual(set(files), {'volumes/uain-review-codex_member/member/key.json',
                                      'volumes/uain-review-codex_codex-auth/member/key.json'})
        self.assertEqual(files['volumes/uain-review-codex_member/member/key.json'], b'{"fictional":"member"}')
        self.assertFalse(any(k.endswith(('state.json', 'auth.json', 'worker.json')) for k in files))

    def test_a_file_of_exactly_one_mebibyte_is_still_read(self):
        (self.volume / 'state.json').write_bytes(b'y' * (1024 * 1024))
        self.assertEqual(len(self.live()['volumes/uain-review-codex_member/state.json']), 1024 * 1024)


if __name__ == '__main__':
    unittest.main()
