"""Tests for switch-release.py with a fake systemctl: python3 ops/release/test_switch_release.py"""
import importlib.util, io, json, os, pathlib, tempfile, unittest
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location('switch_release', pathlib.Path(__file__).with_name('switch-release.py'))
sr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sr)

A, B, R = 'a' * 64, 'b' * 64, 'f' * 64


class FakeSystemd:
    """Units are 'active' unless the unit file / link points at a bad release."""

    def __init__(self, unit_file=None, link=None, bad=()):
        self.unit_file, self.link, self.bad = unit_file, link, set(bad)
        self.calls, self.restarts, self.timers = [], 0, {'t.timer': 'active'}

    def running(self):
        if self.unit_file:
            text = pathlib.Path(self.unit_file).read_text()
            return not any(b in text for b in self.bad)
        return pathlib.Path(os.path.realpath(self.link)).name not in self.bad

    def __call__(self, *args, check=True):
        self.calls.append(args)
        if args[0] == 'is-active':
            if args[1] in self.timers:
                return self.timers[args[1]]
            if args[1] == 'busy.service':
                return 'inactive'
            return 'active' if self.running() else 'failed'
        if args[0] == 'show' and 'NRestarts' in args:
            return '0'
        if args[0] == 'show' and 'Result' in args:
            return 'success' if self.running() else 'exit-code'
        if args[0] == 'stop' and args[1] in self.timers:
            self.timers[args[1]] = 'inactive'
        if args[0] == 'start' and args[1] in self.timers:
            self.timers[args[1]] = 'active'
        if args[0] == 'start' and args[1] == 'check.service' and not self.running() and check:
            raise RuntimeError('check failed')
        return ''


def run(argv, control):
    out = io.StringIO()
    with redirect_stdout(out):
        code = sr.main(argv, control=control, sleep=lambda s: None)
    return code, json.loads(out.getvalue().strip().splitlines()[-1])


class UnitMode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.root = base / 'releases'
        for rid in (A, B, R):
            (self.root / rid / 'src').mkdir(parents=True)
            (self.root / rid / 'src' / 'main.mjs').write_text('x')
            (self.root / rid / 'bin').mkdir()
            (self.root / rid / 'bin' / 'node').write_text('x')
        self.unit = base / 'svc.service'
        self.unit.write_text('[Service]\nExecStart=%s/%s/bin/node %s/%s/src/main.mjs\nRestart=always\n' % (self.root, R, self.root, A))
        self.backups = base / 'backups'

    def tearDown(self):
        self.tmp.cleanup()

    def argv(self, prior=A, target=B, yes=True):
        return ['unit', '--unit', 'svc.service', '--unit-file', str(self.unit), '--root', str(self.root), '--entry', 'src/',
                '--from', prior, '--to', target, '--lock', str(self.unit) + '.lock', '--backup-dir', str(self.backups), '--settle', '0'] + (['--yes'] if yes else [])

    def test_switches_only_the_entry_path(self):
        code, out = run(self.argv(), FakeSystemd(self.unit))
        self.assertEqual((code, out['state']), (0, 'switched'))
        text = self.unit.read_text()
        self.assertIn('%s/%s/src/main.mjs' % (self.root, B), text)
        self.assertIn('%s/%s/bin/node' % (self.root, R), text)
        self.assertTrue(pathlib.Path(out['backup']).read_text().count(A) == 1)

    def test_dry_run_changes_nothing(self):
        before = self.unit.read_text()
        code, out = run(self.argv(yes=False), FakeSystemd(self.unit))
        self.assertEqual((code, out['state']), (0, 'dry-run'))
        self.assertEqual(self.unit.read_text(), before)

    def test_refuses_when_live_differs(self):
        before = self.unit.read_text()
        code, out = run(self.argv(prior=B, target=A), FakeSystemd(self.unit))
        self.assertEqual((code, out['state']), (2, 'refused'))
        self.assertIn(A, out['detail'])
        self.assertEqual(self.unit.read_text(), before)

    def test_refuses_missing_target(self):
        code, out = run(self.argv(target='c' * 64), FakeSystemd(self.unit))
        self.assertEqual(code, 2)

    def test_failed_activation_restores_prior(self):
        before = self.unit.read_text()
        fake = FakeSystemd(self.unit, bad=['%s/%s/src' % (self.root, B)])
        code, out = run(self.argv(), fake)
        self.assertEqual((code, out['state']), (1, 'restored'))
        self.assertEqual(self.unit.read_text(), before)
        self.assertEqual(sum(1 for c in fake.calls if c[0] == 'restart'), 2)


class SymlinkMode(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self.tmp.name)
        self.root = base / 'releases'
        for rid in (A, B):
            (self.root / rid).mkdir(parents=True)
        self.link = base / 'current'
        os.symlink(str(self.root / A), self.link)

    def tearDown(self):
        self.tmp.cleanup()

    def argv(self, prior=A, target=B, yes=True):
        return ['symlink', '--link', str(self.link), '--root', str(self.root), '--from', prior, '--to', target,
                '--pause-timer', 't.timer', '--idle-unit', 'busy.service', '--check-unit', 'check.service'] + (['--yes'] if yes else [])

    def test_switches_and_restarts_paused_timer(self):
        fake = FakeSystemd(link=self.link)
        code, out = run(self.argv(), fake)
        self.assertEqual((code, out['state']), (0, 'switched'))
        self.assertEqual(pathlib.Path(os.path.realpath(self.link)).name, B)
        self.assertIn(('stop', 't.timer'), fake.calls)
        self.assertEqual(fake.timers['t.timer'], 'active')

    def test_failed_check_switches_back(self):
        fake = FakeSystemd(link=self.link, bad=[B])
        code, out = run(self.argv(), fake)
        self.assertEqual((code, out['state']), (1, 'restored'))
        self.assertEqual(pathlib.Path(os.path.realpath(self.link)).name, A)
        self.assertEqual(fake.timers['t.timer'], 'active')

    def test_refuses_wrong_prior_and_bad_ids(self):
        self.assertEqual(run(self.argv(prior=B, target=A), FakeSystemd(link=self.link))[0], 2)
        self.assertEqual(run(self.argv(target=A), FakeSystemd(link=self.link))[0], 2)
        self.assertEqual(run(self.argv(target='../x'), FakeSystemd(link=self.link))[0], 2)
        self.assertEqual(pathlib.Path(os.path.realpath(self.link)).name, A)


if __name__ == '__main__':
    unittest.main()
