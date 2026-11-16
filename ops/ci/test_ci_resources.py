"""CI resource policy: disk floor, scratch admission, owned cleanup, cache rebuild.

No Docker, root or host secrets are needed; Docker is a labelled in-memory fake."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
GIB = 2**30


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE/filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


launcher = load('launcher_resources', 'launcher.py')
guard = load('host_guard', 'host-guard.py')
OWN = 'uain-ci-' + 'a'*32
OTHER = 'uain-ci-' + 'b'*32


class DiskFloorTests(unittest.TestCase):
    def test_guard_floor_clears_kubelet_eviction_with_scratch_headroom(self):
        self.assertEqual((guard.MIN_FREE_GIB, guard.MIN_FREE_PERCENT), (40, 10))
        guard.check_disk(500*GIB, 50*GIB)
        with self.assertRaisesRegex(ValueError, 'reserve failed'): guard.check_disk(500*GIB, 50*GIB - 1)
        with self.assertRaisesRegex(ValueError, 'reserve failed'): guard.check_disk(100*GIB, 39*GIB)
        # Both floors apply: 10% of a large filesystem, 40 GiB of a small one.
        guard.check_disk(100*1024*GIB, 10*1024*GIB)
        with self.assertRaisesRegex(ValueError, 'reserve failed'): guard.check_disk(100*1024*GIB, 10*1024*GIB - 1)

    def test_guard_rejects_invalid_capacity(self):
        for total, available in ((0, 0), (-1, 10*GIB), (10*GIB, 11*GIB), (500*GIB, -1), (500.0*GIB, 20*GIB), (500*GIB, True)):
            with self.subTest(total=total, available=available), self.assertRaises(ValueError):
                guard.check_disk(total, available)

    def test_snapshot_writer_keeps_ten_gib_after_each_write(self):
        data = b'x'*4096
        def write_with(available_before):
            info = SimpleNamespace(f_blocks=10**15, f_frsize=1, f_bavail=available_before)
            with tempfile.TemporaryFile() as stream, patch.object(launcher.os, 'fstatvfs', return_value=info):
                return launcher.BoundedSnapshot(stream).write(data)
        self.assertEqual(write_with(10*GIB + len(data)), len(data))
        with self.assertRaisesRegex(ValueError, 'reserve'): write_with(10*GIB + len(data) - 1)
        # No percentage floor: a huge filesystem at 0.001% free is accepted.
        self.assertEqual(write_with(20*GIB), len(data))

    def test_snapshot_writer_caps_source_bytes_at_one_gib(self):
        info = SimpleNamespace(f_blocks=10**15, f_frsize=1, f_bavail=10**14)
        with tempfile.TemporaryFile() as stream, patch.object(launcher.os, 'fstatvfs', return_value=info):
            writer = launcher.BoundedSnapshot(stream)
            writer.bytes = GIB - 1
            with self.assertRaisesRegex(ValueError, '1 GiB'): writer.write(b'xx')


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name)/'state'
        self.quiet = patch.object(launcher.sys, 'stderr', io.StringIO()); self.quiet.start()
    def tearDown(self):
        self.quiet.stop(); self.temporary.cleanup()

    def admission(self, budget=10*GIB, alive=lambda owner: True, cleanup=lambda job: [], **extra):
        return launcher.ScratchAdmission(self.state, budget, alive=alive, cleanup=cleanup, **extra)

    def reserved(self):
        return json.loads((self.state/'scratch.json').read_text())

    def test_admission_refuses_once_the_budget_is_reserved(self):
        admission = self.admission()
        admission.reserve(OWN, 'reset', 6*GIB, (1, '1'), wait=0)
        with self.assertRaisesRegex(ValueError, r'resource-blocked.*6\.0 of 10\.0 GiB'):
            admission.reserve(OTHER, 'reset', 6*GIB, (2, '1'), wait=0)
        self.assertEqual(set(self.reserved()), {OWN})
        admission.release(OWN)
        admission.reserve(OTHER, 'reset', 6*GIB, (2, '1'), wait=0)
        self.assertEqual(set(self.reserved()), {OTHER})

    def test_exact_fit_is_admitted_and_oversized_suite_is_refused_without_waiting(self):
        admission = self.admission(sleep=lambda seconds: self.fail('must not wait'))
        admission.reserve(OWN, 'pilot', 4*GIB, (1, '1'), wait=0)
        admission.reserve(OTHER, 'pilot', 6*GIB, (2, '1'), wait=0)
        with self.assertRaisesRegex(ValueError, 'exceeds host budget'):
            admission.reserve('uain-ci-'+'c'*32, 'private-exchange', 11*GIB, (3, '1'), wait=600)

    def test_waiting_run_is_admitted_when_capacity_is_released(self):
        admission = self.admission(poll=0.01)
        admission.reserve(OWN, 'reset', 8*GIB, (1, '1'), wait=0)
        threading.Timer(0.1, admission.release, (OWN,)).start()
        start = time.monotonic()
        admission.reserve(OTHER, 'reset', 8*GIB, (2, '1'), wait=10)
        self.assertLess(time.monotonic()-start, 5)
        self.assertEqual(set(self.reserved()), {OTHER})

    def test_concurrent_threads_never_overbook(self):
        active = peak = 0
        lock, errors = threading.Lock(), []
        def worker(index):
            nonlocal active, peak
            admission = self.admission(poll=0.002)
            job = 'uain-ci-%032x' % index
            try:
                admission.reserve(job, 'pilot', 3*GIB, (index+1, '1'), wait=30)
                with lock:
                    active += 3; peak = max(peak, active)
                    total = sum(row['bytes'] for row in self.reserved().values())
                    if total > 10*GIB: errors.append('state overbooked: %d' % total)
                time.sleep(0.01)
                with lock: active -= 3
                admission.release(job)
            except Exception as error:  # surfaced in the assertion below
                errors.append(repr(error))
        threads = [threading.Thread(target=worker, args=(index,)) for index in range(16)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors, [])
        self.assertLessEqual(peak, 9)
        self.assertEqual(self.reserved(), {})

    def test_concurrent_processes_never_overbook(self):
        # Separate launcher processes contend through the same flocked state.
        child = '''
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location('launcher_child', sys.argv[1])
launcher = importlib.util.module_from_spec(spec); spec.loader.exec_module(launcher)
index = int(sys.argv[3])
admission = launcher.ScratchAdmission(sys.argv[2], 10*2**30, alive=lambda owner: True, cleanup=lambda job: [], poll=0.005)
job = 'uain-ci-%032x' % (index + 100)
admission.reserve(job, 'reset', 4*2**30, (index + 1, '1'), wait=60)
admitted = time.time(); time.sleep(0.15); released = time.time()
admission.release(job)
print(json.dumps([admitted, released]))
'''
        processes = [subprocess.Popen([sys.executable, '-I', '-c', child, str(HERE/'launcher.py'), str(self.state), str(index)],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) for index in range(6)]
        spans = []
        for process in processes:
            output, _ = process.communicate(timeout=120)
            self.assertEqual(process.returncode, 0)
            spans.append(json.loads(output))
        # Two 4 GiB runs fit in 10 GiB; a third must never overlap them.
        for admitted, _ in spans:
            overlapping = sum(start <= admitted < end for start, end in spans)
            self.assertLessEqual(overlapping, 2)
        self.assertEqual(self.reserved(), {})

    def test_dead_owner_is_released_only_after_its_own_resources_are_removed(self):
        cleaned = []
        def cleanup(job):
            cleaned.append(job)
            return ['still-there'] if len(cleaned) == 1 else []
        admission = self.admission(alive=lambda owner: owner != (999999, 'gone'), cleanup=cleanup)
        admission.reserve(OWN, 'reset', 8*GIB, (1, '1'), wait=0)
        admission.reserve(OTHER, 'reset', 2*GIB, (999999, 'gone'), wait=0)
        admission.release(OWN)
        # First sweep: the dead run still holds resources, so its budget stays reserved.
        with self.assertRaises(ValueError): admission.reserve('uain-ci-'+'c'*32, 'native-chain', 9*GIB, (3, '1'), wait=0)
        admission.reserve('uain-ci-'+'c'*32, 'native-chain', 9*GIB, (3, '1'), wait=0)
        self.assertEqual(cleaned, [OTHER, OTHER])
        self.assertEqual(set(self.reserved()), {'uain-ci-'+'c'*32})

    def test_owner_identity_uses_start_time_not_only_pid(self):
        self.assertFalse(launcher.owner_alive((0, '1')))
        self.assertFalse(launcher.owner_alive((os.getpid(), None)))
        with patch.object(launcher, 'process_start', return_value='42'):
            self.assertTrue(launcher.owner_alive((123, '42')))
            self.assertFalse(launcher.owner_alive((123, '41')))  # PID reused by another process

    def test_corrupted_or_unprotected_state_fails_closed(self):
        admission = self.admission()
        admission.reserve(OWN, 'pilot', 1*GIB, (1, '1'), wait=0)
        (self.state/'scratch.json').write_text('{"uain-ci-x": ')
        with self.assertRaisesRegex(ValueError, 'invalid'): admission.reserve(OTHER, 'pilot', 1*GIB, (2, '1'), wait=0)
        (self.state/'scratch.json').write_text(json.dumps({OWN: {'bytes': -5, 'owner': [1, '1']}}))
        with self.assertRaisesRegex(ValueError, 'invalid'): admission.reserve(OTHER, 'pilot', 1*GIB, (2, '1'), wait=0)
        (self.state/'scratch.json').unlink()
        (self.state/'scratch.json').symlink_to(Path(self.temporary.name)/'elsewhere.json')
        with self.assertRaises(OSError): admission.reserve(OTHER, 'pilot', 1*GIB, (2, '1'), wait=0)
        (self.state/'scratch.json').unlink()
        self.state.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'not protected'): admission.reserve(OTHER, 'pilot', 1*GIB, (2, '1'), wait=0)
        self.state.chmod(0o700)

    def test_usage_log_is_bounded_to_two_generations(self):
        admission = self.admission()
        with patch.object(launcher, 'USAGE_LOG_BYTES', 200):
            for index in range(20): admission.record({'run': OWN, 'index': index, 'peak': 1})
        self.assertLessEqual((self.state/'scratch-usage.jsonl').stat().st_size, 400)
        self.assertTrue((self.state/'scratch-usage.jsonl.1').exists())
        self.assertEqual(sorted(path.name for path in self.state.iterdir() if 'usage' in path.name),
                         ['scratch-usage.jsonl', 'scratch-usage.jsonl.1'])


class FakeDocker:
    """In-memory daemon: labelled containers, networks and volumes."""
    KIND = {'ps': 'container', 'rm': 'container', 'network': 'network', 'volume': 'volume'}

    def __init__(self, **resources):
        self.resources = {kind: dict(resources.get(kind, {})) for kind in ('container', 'network', 'volume')}
        self.calls = []

    @staticmethod
    def labels(args):
        return dict(args[i+1].split('=', 1) for i, arg in enumerate(args) if arg == '--label')

    def __call__(self, *args, capture=False, check=True, stdin=None, timeout=120, stderr=False):
        self.calls.append(args)
        out, kind = '', self.KIND.get(args[0])
        if args[0] == 'ps' or args[:2] in (('network', 'ls'), ('volume', 'ls')):
            key, value = args[args.index('--filter')+1][len('label='):].split('=', 1)
            out = '\n'.join(name for name, labels in self.resources[kind].items() if labels.get(key) == value)
        elif args[:2] == ('rm', '-f'):
            for name in args[3:]: self.resources['container'].pop(name, None)
        elif args[:2] in (('network', 'rm'), ('volume', 'rm')):
            for name in args[2:]: self.resources[kind].pop(name, None)
        elif args[:2] in (('network', 'create'), ('volume', 'create')):
            self.resources[kind][args[-1]] = self.labels(args)
        elif args[0] in ('run', 'create'):
            self.resources['container'][args[args.index('--name')+1]] = self.labels(args)
        elif args[0] == 'inspect':
            out = '0'
        return SimpleNamespace(returncode=0, stdout=out)


def foreign_resources():
    """Another live run, a production service, and an impostor using our label."""
    other = {'uain.ci.disposable': 'true', 'uain.purpose': 'tests', 'uain.ci.run': OTHER}
    return dict(
        container={OTHER+'-test': other, OTHER+'-pg': other, 'uain-pilot-production': {},
                   'uain-test-pg': {'uain.purpose': 'tests'}, 'production-db': {'uain.ci.run': OWN}},
        network={OTHER+'-net': other, 'bridge': {}},
        volume={OTHER+'-work': other, OTHER+'-cache': other, 'pilot-data': {}, 'uain-test-npm-cache-v2': {'uain.purpose': 'tests'}})


class OwnedCleanupTests(unittest.TestCase):
    def test_cleanup_removes_only_this_runs_labelled_and_prefixed_resources(self):
        resources = foreign_resources()
        resources['container'][OWN+'-test'] = {'uain.ci.run': OWN}
        resources['volume'][OWN+'-cache'] = {'uain.ci.run': OWN}
        fake = FakeDocker(**resources)
        with patch.object(launcher, 'docker', side_effect=fake), patch('builtins.print'):
            self.assertEqual(launcher.cleanup_run(OWN), [])
        self.assertNotIn(OWN+'-test', fake.resources['container'])
        self.assertNotIn(OWN+'-cache', fake.resources['volume'])
        expected = foreign_resources()
        for kind in ('container', 'network', 'volume'):
            self.assertEqual(fake.resources[kind], expected[kind])
        self.assertFalse(any('prune' in call for call in fake.calls))

    def test_cleanup_refuses_malformed_run_id(self):
        for job in ('uain-ci-', 'uain-ci-'+'a'*31, OWN+' --all', 'label=uain'):
            with self.subTest(job=job), self.assertRaises(ValueError): launcher.cleanup_run(job)

    def launch(self, fake, admission, cancel_on='start'):
        handlers, sent = {}, []
        def docker(*args, **kwargs):
            if args[0] == cancel_on and not sent:
                sent.append(args)
                handlers[launcher.signal.SIGTERM](launcher.signal.SIGTERM, None)
            return fake(*args, **kwargs)
        # These simulated launches patch the signal handler, so an enforced over-budget
        # sample would SIGTERM the test process itself; enforcement is tested separately.
        with patch.object(launcher, 'ENFORCE_SCRATCH', False), \
             patch.object(launcher.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), \
             patch.object(launcher.os, 'getuid', return_value=0), \
             patch.dict(launcher.os.environ, {'SUDO_UID': '1001'}), \
             patch.object(launcher.sys, 'argv', ['uain-ci-run', '/approved/source', 'pilot', '0', '1']), \
             patch.object(launcher, 'validate_source', return_value=Path('/approved/source')), \
             patch.object(launcher, 'runtime_image', return_value='sha256:'+'a'*64), \
             patch.object(launcher, 'host_admission'), \
             patch.object(launcher, 'archive_source'), \
             patch.object(launcher, 'process_start', return_value='1'), \
             patch.object(launcher, 'ScratchAdmission', return_value=admission), \
             patch.object(launcher, 'scratch_usage', return_value=2*GIB), \
             patch.object(launcher.uuid, 'uuid4', return_value=SimpleNamespace(hex='a'*32)), \
             patch.object(launcher, 'docker', side_effect=docker), \
             patch.object(launcher.signal, 'signal', side_effect=lambda sig, fn: handlers.update({sig: fn})), \
             patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
             patch('builtins.print'):
            with self.assertRaises(KeyboardInterrupt): launcher.main()

    def test_cancelled_job_cleans_only_its_own_labelled_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            admission = launcher.ScratchAdmission(Path(directory)/'state', 10*GIB, alive=lambda owner: True)
            fake = FakeDocker(**foreign_resources())
            self.launch(fake, admission)
            # Everything this run created is gone; nothing else was touched.
            expected = foreign_resources()
            for kind in ('container', 'network', 'volume'):
                self.assertEqual(fake.resources[kind], expected[kind])
            created = [call for call in fake.calls if call[0] in ('run', 'create') or call[1:2] == ('create',)]
            self.assertEqual(len(created), 5)
            removed = [name for call in fake.calls if call[:2] in (('rm', '-f'), ('network', 'rm'), ('volume', 'rm'))
                       for name in call[2:] if not name.startswith('-')]
            self.assertTrue(removed)
            self.assertTrue(all(name.startswith(OWN+'-') for name in removed), removed)
            self.assertEqual(json.loads((Path(directory)/'state'/'scratch.json').read_text()), {})
            usage = (Path(directory)/'state'/'scratch-usage.jsonl').read_text().splitlines()
            self.assertEqual(json.loads(usage[0])['run'], OWN)

    def test_cancelled_before_resources_exist_removes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            admission = launcher.ScratchAdmission(Path(directory)/'state', 10*GIB, alive=lambda owner: True)
            fake = FakeDocker(**foreign_resources())
            self.launch(fake, admission, cancel_on='network')
            expected = foreign_resources()
            for kind in ('container', 'network', 'volume'):
                self.assertEqual(fake.resources[kind], expected[kind])

    def test_resource_blocked_run_creates_and_removes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            admission = launcher.ScratchAdmission(Path(directory)/'state', 4*GIB, alive=lambda owner: True,
                                                  sleep=lambda seconds: None, clock=iter(range(0, 10**6, 100)).__next__)
            admission.reserve(OTHER, 'reset', 4*GIB, (5, '1'), wait=0)
            fake = FakeDocker(**foreign_resources())
            with patch.object(launcher, 'ENFORCE_SCRATCH', False), \
                 patch.object(launcher.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), \
                 patch.object(launcher.os, 'getuid', return_value=0), \
                 patch.dict(launcher.os.environ, {'SUDO_UID': '1001'}), \
                 patch.object(launcher.sys, 'argv', ['uain-ci-run', '/approved/source', 'pilot', '0', '1']), \
                 patch.object(launcher, 'validate_source', return_value=Path('/approved/source')), \
                 patch.object(launcher, 'runtime_image', return_value='sha256:'+'a'*64), \
                 patch.object(launcher, 'host_admission') as host, \
                 patch.object(launcher, 'process_start', return_value='1'), \
                 patch.object(launcher, 'ScratchAdmission', return_value=admission), \
                 patch.object(launcher, 'docker', side_effect=fake), \
                 patch.object(launcher.signal, 'signal'), patch('builtins.print'):
                with self.assertRaisesRegex(ValueError, 'resource-blocked'): launcher.main()
            self.assertEqual(fake.calls, [])
            host.assert_not_called()


class DeniedSourceTests(unittest.TestCase):
    def test_denied_source_or_arguments_run_no_host_command(self):
        cases = [
            (['uain-ci-run', '/tmp/attacker-checkout', 'pilot', '0', '1'], 0, '1001'),
            (['uain-ci-run', '/opt/actions-runner/_work/uain-universa/uain-universa/../../../../../tmp', 'site'], 0, '1001'),
            (['uain-ci-run', '/opt/actions-runner-uain-6/_work/uain-universa/uain-universa', 'site'], 0, '1001'),
            (['uain-ci-run', '/opt/actions-runner/_work/uain-universa/uain-universa', 'site'], 1001, '1001'),
            (['uain-ci-run', '/opt/actions-runner/_work/uain-universa/uain-universa', 'site'], 0, '0'),
            (['uain-ci-run', '/opt/actions-runner/_work/uain-universa/uain-universa'], 0, '1001'),
        ]
        for argv, uid, sudo in cases:
            calls = []
            def record(*args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout='')
            with self.subTest(argv=argv, uid=uid, sudo=sudo), \
                 patch.object(launcher.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), \
                 patch.object(launcher.os, 'getuid', return_value=uid), \
                 patch.dict(launcher.os.environ, {'SUDO_UID': sudo}), \
                 patch.object(launcher.sys, 'argv', argv), \
                 patch.object(launcher.subprocess, 'run', side_effect=record), \
                 patch.object(launcher.subprocess, 'Popen', side_effect=record), \
                 patch.object(launcher.os, 'system', side_effect=record), \
                 patch.object(launcher, 'docker', side_effect=record), \
                 patch.object(launcher, 'ScratchAdmission', side_effect=record):
                with self.assertRaises((ValueError, OSError)): launcher.main()
                self.assertEqual(calls, [])

    def test_approved_path_with_bad_suite_runs_no_host_command(self):
        calls = []
        # These simulated launches patch the signal handler, so an enforced over-budget
        # sample would SIGTERM the test process itself; enforcement is tested separately.
        with patch.object(launcher, 'ENFORCE_SCRATCH', False), \
             patch.object(launcher.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), \
             patch.object(launcher.os, 'getuid', return_value=0), \
             patch.dict(launcher.os.environ, {'SUDO_UID': '1001'}), \
             patch.object(launcher, 'validate_source', return_value=Path('/approved/source')), \
             patch.object(launcher.subprocess, 'run', side_effect=lambda *a, **k: calls.append(a)), \
             patch.object(launcher.subprocess, 'Popen', side_effect=lambda *a, **k: calls.append(a)), \
             patch.object(launcher, 'docker', side_effect=lambda *a, **k: calls.append(a)):
            for suite in (['site', '--privileged'], ['pilot', '0', '1;id'], ['bash'], ['isolation', '-v', '/:/host']):
                with self.subTest(suite=suite), patch.object(launcher.sys, 'argv', ['uain-ci-run', '/approved/source', *suite]):
                    with self.assertRaises(ValueError): launcher.main()
        self.assertEqual(calls, [])


class ScratchMeasurementTests(unittest.TestCase):
    def test_monitor_reports_over_budget_and_cancels_only_when_enforced(self):
        for enforce in (False, True):
            monitor = launcher.ScratchMonitor(OWN, 'pilot', 3*GIB, (OWN+'-test',), (OWN+'-work',), enforce=enforce)
            with self.subTest(enforce=enforce), patch.object(launcher, 'scratch_usage', side_effect=[GIB, 4*GIB, 5*GIB]), \
                 patch.object(launcher.os, 'kill') as kill, patch('builtins.print'):
                monitor.sample(); kill.assert_not_called()
                monitor.sample(); monitor.sample()
                self.assertEqual((monitor.peak, monitor.samples, monitor.exceeded), (5*GIB, 3, True))
                if enforce: kill.assert_called_once_with(os.getpid(), launcher.signal.SIGTERM)
                else: kill.assert_not_called()

    def test_tree_bytes_counts_allocated_files_without_following_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'volume'; (root/'nested').mkdir(parents=True)
            (root/'nested'/'data').write_bytes(os.urandom(1024*1024))
            outside = Path(directory)/'outside'; outside.write_bytes(os.urandom(8*1024*1024))
            (root/'link').symlink_to(outside)
            (root/'dirlink').symlink_to(Path(directory))
            measured = launcher.tree_bytes(str(root))
            self.assertGreaterEqual(measured, 1024*1024)
            self.assertLess(measured, 4*1024*1024)

    def test_usage_includes_anonymous_database_volume_and_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            mounts = {}
            for name in ('work', 'anon'):
                mounts[name] = Path(directory)/name; mounts[name].mkdir()
                (mounts[name]/'file').write_bytes(os.urandom(256*1024))
            def docker(*args, **kwargs):
                if args[:2] == ('inspect', '--size'): return SimpleNamespace(returncode=0, stdout='4096 anon ')
                if args[:2] == ('volume', 'inspect'): return SimpleNamespace(returncode=0, stdout=str(mounts.get(args[-1], ''))+'\n')
                return SimpleNamespace(returncode=1, stdout='')
            with patch.object(launcher, 'docker', side_effect=docker):
                total = launcher.scratch_usage((OWN+'-pg',), ('work',))
            self.assertGreaterEqual(total, 4096 + 2*256*1024)

    def test_every_suite_has_a_budget_within_the_host_budget(self):
        suites = {'pilot', 'research', 'reset', 'others', 'site', 'native-chain', 'private-exchange', 'isolation', 'ledger-publication'}
        self.assertEqual(set(launcher.SUITE_SCRATCH), suites)
        self.assertTrue(all(0 < value <= launcher.SCRATCH_BUDGET for value in launcher.SUITE_SCRATCH.values()))
        self.assertTrue(launcher.ENFORCE_SCRATCH)
        self.assertLessEqual(launcher.SCRATCH_BUDGET, 16*2**30)


class CacheRebuildTests(unittest.TestCase):
    def install(self, mode, cache_set=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); bin_dir = root/'bin'; bin_dir.mkdir()
            cache = root/'cache'/'npm'; cache.mkdir(parents=True); (cache/'_cacache-entry').write_text('old')
            count = root/'count'
            (bin_dir/'npm').write_text('#!/bin/bash\necho "$*" >> "%s"\nn=$(($(wc -l < "%s")))\ncase %s in\n'
                                        ' corrupt) if [ "$n" = 1 ]; then echo "npm error code EINTEGRITY"; exit 1; fi; exit 0 ;;\n'
                                        ' failing) echo "npm error code E404"; exit 7 ;;\n'
                                        ' *) exit 0 ;;\nesac\n' % (count, count, mode))
            (bin_dir/'npm').chmod(0o755)
            env = {'PATH': '%s:/usr/bin:/bin' % bin_dir, 'HOME': directory, 'TMPDIR': directory}
            if cache_set: env['npm_config_cache'] = str(cache)
            result = subprocess.run(['bash', '-c', 'set -euo pipefail; source "$1"; npm_ci_rebuild --prefix services/pilot',
                                     'test', str(HERE/'npm-cache.sh')], env=env, capture_output=True, text=True, timeout=60)
            calls = count.read_text().splitlines() if count.exists() else []
            return result.returncode, calls, (cache/'_cacache-entry').exists(), result.stderr

    def test_corrupted_cache_is_discarded_and_install_rebuilt_once(self):
        code, calls, kept, stderr = self.install('corrupt')
        self.assertEqual((code, len(calls), kept), (0, 2, False))
        self.assertEqual(calls, ['ci --prefix services/pilot']*2)
        self.assertIn('rebuilding once from a clean cache', stderr)

    def test_other_install_failures_keep_cache_and_status_and_are_not_retried(self):
        self.assertEqual(self.install('failing')[:3], (7, ['ci --prefix services/pilot'], True))
        self.assertEqual(self.install('ok')[:3], (0, ['ci --prefix services/pilot'], True))

    def test_rebuild_requires_an_explicit_cache_directory(self):
        self.assertEqual(self.install('corrupt', cache_set=False)[:2], (2, []))

    def test_remote_harness_cleans_only_its_run_and_rebuilds_corrupt_cache(self):
        result = subprocess.run(['bash', str(HERE/'test-remote-suite.sh')], capture_output=True, text=True, timeout=300)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in ('Corrupted npm cache rebuilt', 'removed only its own labelled container', 'Unlabelled cache volume was not removed'):
            self.assertIn(line, result.stdout)


class CustodyCoverageTests(unittest.TestCase):
    def test_custody_tests_are_discovered_by_glob_with_justified_exclusions(self):
        suite = (HERE/'container-suite.sh').read_text()
        self.assertIn('for test in ops/custody/test_*.py; do', suite)
        excluded = suite.split("custody_outside_sandbox=' ", 1)[1].split(" '", 1)[0].split()
        self.assertTrue(excluded)
        self.assertIn('from pykeepass import', (HERE.parent/'custody'/'custody.py').read_text())
        for name in excluded:
            # An exclusion must name a real file that needs the operator-only KeePass module.
            source = (HERE.parent/'custody'/name).read_text()
            self.assertTrue('pykeepass' in source or 'import custody\n' in source, name)


class InstalledDigestTests(unittest.TestCase):
    GUARD = hashlib.sha256((HERE/'host-guard.py').read_bytes()).hexdigest()

    def classify(self, files, observed):
        with tempfile.TemporaryDirectory() as directory:
            record, probe = Path(directory)/'record.json', Path(directory)/'observed'
            record.write_text(json.dumps({'files': files})); probe.write_text('\n'.join(observed) + '\n')
            result = subprocess.run(['bash', str(HERE/'verify-installed.sh'), '--record', str(record), '--observed', str(probe)],
                                    capture_output=True, text=True, timeout=60)
            return result.returncode, [line.split()[0] for line in result.stdout.splitlines()]

    @staticmethod
    def row(path, source, digest, mode='755'):
        return {'installed': path, 'source': source, 'sha256': digest, 'owner': 'root:root', 'mode': mode}

    def test_classifies_sync_pending_drift_unsafe_and_missing(self):
        guard = self.row('/usr/local/sbin/uain-host-guard', 'ops/ci/host-guard.py', 'e'*64)
        cases = [
            ([self.GUARD+' root:root 755 /usr/local/sbin/uain-host-guard'], (0, ['in-sync'])),
            (['e'*64+' root:root 755 /usr/local/sbin/uain-host-guard'], (3, ['pending-install'])),
            (['d'*64+' root:root 755 /usr/local/sbin/uain-host-guard'], (1, ['DRIFT'])),
            ([self.GUARD+' runner:runner 777 /usr/local/sbin/uain-host-guard'], (1, ['UNSAFE'])),
            (['missing - - /usr/local/sbin/uain-host-guard'], (1, ['MISSING'])),
        ]
        for observed, expected in cases:
            with self.subTest(observed=observed): self.assertEqual(self.classify([guard], observed), expected)
        sudoers = self.row('/etc/sudoers.d/uain-ci-run', None, 'c'*64, '440')
        self.assertEqual(self.classify([sudoers], ['c'*64+' root:root 440 /etc/sudoers.d/uain-ci-run']), (0, ['recorded']))
        # Drift anywhere wins over a pending install elsewhere.
        self.assertEqual(self.classify([guard, sudoers], ['e'*64+' root:root 755 /usr/local/sbin/uain-host-guard',
                                                           'b'*64+' root:root 440 /etc/sudoers.d/uain-ci-run'])[0], 1)

    def test_unsafe_recorded_path_is_refused_before_probing(self):
        self.assertNotEqual(self.classify([self.row('/etc/x; rm -rf /', None, 'c'*64)], [])[0], 0)

    def test_record_covers_launcher_guard_sudo_rule_and_runtime_image(self):
        record = json.loads((HERE/'installed-digests.json').read_text())
        rows = {row['installed']: row for row in record['files']}
        self.assertEqual(set(rows), {'/usr/local/sbin/uain-ci-run', '/usr/local/sbin/uain-host-guard',
                                     '/etc/sudoers.d/uain-ci-run', '/etc/uain-ci/runtime-image'})
        self.assertEqual(rows['/usr/local/sbin/uain-ci-run']['source'], 'ops/ci/launcher.py')
        self.assertEqual(rows['/usr/local/sbin/uain-host-guard']['source'], 'ops/ci/host-guard.py')
        for row in rows.values():
            self.assertRegex(row['sha256'], r'^[0-9a-f]{64}$')
            if row['source']: self.assertTrue((HERE.parent.parent/row['source']).is_file())


if __name__ == '__main__': unittest.main()
