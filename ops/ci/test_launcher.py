"""Security contract of the trusted launcher; no Docker or host secrets needed."""
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock
from unittest import mock
import subprocess
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class SourceCopyTests(unittest.TestCase):
    def test_foreign_wallet_fixture_has_fixed_public_bytes_and_actual_other_owner(self):
        with launcher.foreign_wallet_fixture() as stream, tarfile.open(fileobj=stream) as archive:
            self.assertEqual(archive.getnames(), ['.ci-foreign-wallet-fixture'])
            entry=archive.getmembers()[0]
            self.assertEqual((entry.uid,entry.gid,entry.mode,entry.size),(65534,65534,0o600,32))
            self.assertEqual(archive.extractfile(entry).read(),bytes([1])*32)
    def test_parallel_runners_have_exact_separate_checkout_roots(self):
        for index in (2, 3, 4, 5):
            self.assertIn(f'/opt/actions-runner-uain-{index}/_work/uain-universa/uain-universa',launcher.CHECKOUTS)
        for slot in range(1,5): self.assertIn(f'/opt/uain-checks/slot-{slot}/uain-universa',launcher.CHECKOUTS)
        self.assertNotIn('/opt/uain-checks/slot-5/uain-universa',launcher.CHECKOUTS)
        with self.assertRaises(ValueError):
            launcher.validate_source('/opt/actions-runner-uain-6/_work/uain-universa/uain-universa',os.getuid())

    def test_copy_never_follows_links_and_omits_private_or_generated_files(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            source = root / 'source'; source.mkdir()
            (root / 'private').write_text('HOST SECRET')
            (source / 'ordinary.txt').write_text('public source')
            (source / 'outside').symlink_to('../private')
            (source / 'absolute').symlink_to(root / 'private')
            (source / '.env').write_text('SECRET')
            (source / '.ci-foreign-wallet-fixture').symlink_to(root / 'private')
            (source / 'member.key').write_text('SECRET')
            for name in ['.git', 'work', 'node_modules', 'dist', 'target', 'keys']:
                (source / name).mkdir(); (source / name / 'private').write_text('SECRET')
            stream = io.BytesIO()
            launcher.archive_source(source, stream, os.getuid())
            stream.seek(0)
            with tarfile.open(fileobj=stream) as archive:
                entries = {entry.name: entry for entry in archive}
                self.assertEqual(set(entries), {'ordinary.txt', 'outside', 'absolute'})
                self.assertTrue(entries['outside'].issym())
                self.assertTrue(entries['absolute'].issym())
                self.assertEqual(entries['outside'].linkname, '../private')
                self.assertEqual(archive.extractfile('ordinary.txt').read(), b'public source')
            self.assertNotIn(b'HOST SECRET', stream.getvalue())
            self.assertNotIn(b'SECRET', stream.getvalue())

    def test_rejects_special_files_and_world_writable_sources(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            os.mkfifo(root / 'pipe')
            with self.assertRaises(ValueError): launcher.archive_source(root, io.BytesIO(), os.getuid())
            (root / 'pipe').unlink()
            (root / 'bad').write_text('x'); (root / 'bad').chmod(0o666)
            with self.assertRaises(ValueError): launcher.archive_source(root, io.BytesIO(), os.getuid())

    def test_checkout_realpath_and_owner_are_required(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory); (root / 'source').mkdir(); (root / 'link').symlink_to(root / 'source')
            launcher.validate_source(str(root / 'source'), os.getuid(), {str(root / 'source')})
            with self.assertRaises(ValueError): launcher.validate_source(str(root / 'link'), os.getuid(), {str(root / 'link')})
            with self.assertRaises(ValueError): launcher.validate_source(str(root / 'source'), os.getuid(), set())
            with self.assertRaises(ValueError): launcher.validate_source(str(root / 'source'), os.getuid()+1, {str(root / 'source')})

    def test_rust_source_bin_is_preserved_and_generated_chain_bin_is_omitted(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            (root/'chain/bin').mkdir(parents=True)
            (root/'chain/bin/uaind').write_text('generated')
            rust = root/'chain/private-exchange/src/bin'; rust.mkdir(parents=True)
            (rust/'wallet.rs').write_text('public Rust source')
            stream=io.BytesIO(); launcher.archive_source(root,stream,os.getuid()); stream.seek(0)
            with tarfile.open(fileobj=stream) as archive:
                self.assertIn('chain/private-exchange/src/bin/wallet.rs',archive.getnames())
                self.assertNotIn('chain/bin',archive.getnames())

    def test_hardlinks_cannot_alias_private_files_under_public_names(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root=Path(directory); (root/'outside').write_text('SECRET')
            source=root/'source'; source.mkdir(); os.link(root/'outside',source/'alias')
            with self.assertRaises(ValueError): launcher.archive_source(source,io.BytesIO(),os.getuid())

    def test_suite_arguments_cannot_inject_docker_flags(self):
        self.assertEqual(launcher.parse_suite(['pilot','1','3']), ('pilot','1','3'))
        for args in [['pilot','2','1'], ['pilot','1','4'], ['site','--privileged'], ['unknown'], ['reset','1','1']]:
            with self.assertRaises(ValueError): launcher.parse_suite(args)

class FakeAdmission:
    def __init__(self): self.reserved, self.released, self.rows = [], [], []
    def reserve(self, job, suite, need, owner, wait): self.reserved.append((job, suite, need, wait))
    def release(self, job): self.released.append(job)
    def record(self, row): self.rows.append(row)

class LaunchContractTests(unittest.TestCase):
    def setUp(self): self.admission = FakeAdmission()

    def execute(self, status='0', suite='isolation', cancel=False, timedout=False):
        calls = []; handlers = {}; first_handler = None
        def docker(*args, **kwargs):
            nonlocal first_handler
            calls.append(args)
            if args[0] == 'start' and timedout:
                raise launcher.subprocess.TimeoutExpired(['docker','start'],5)
            if args[0] == 'start' and cancel:
                first_handler=handlers[launcher.signal.SIGTERM]
                first_handler(launcher.signal.SIGTERM,None)
            if args[:2] == ('rm','-f') and first_handler:
                # Repeated cancellation cannot interrupt forced cleanup.
                first_handler(launcher.signal.SIGTERM,None)
            return SimpleNamespace(returncode=0, stdout=status if args[0] == 'inspect' else '')
        with patch.object(launcher.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001)), \
             patch.object(launcher.os, 'getuid', return_value=0), \
             patch.dict(launcher.os.environ, {'SUDO_UID':'1001', 'HOST_PRIVATE_KEY':'MUST NEVER FORWARD'}), \
             patch.object(launcher.sys, 'argv', ['uain-ci-run','/approved/source',suite]+(['0','1'] if suite == 'pilot' else ['2026-10-11'] if suite == 'ledger-publication' else [])), \
             patch.object(launcher, 'validate_source', return_value=Path('/approved/source')), \
             patch.object(launcher, 'runtime_image', return_value='sha256:'+'a'*64), \
             patch.object(launcher, 'host_admission'), \
             patch.object(launcher, 'process_start', return_value='1'), \
             patch.object(launcher, 'ScratchAdmission', return_value=self.admission), \
             patch.object(launcher, 'scratch_usage', return_value=1024), \
             patch.object(launcher, 'archive_source'), \
             patch.object(launcher, 'export_publication', return_value=b'{}'), \
             patch.object(launcher.sys, 'stdout', SimpleNamespace(buffer=io.BytesIO())), \
             patch.object(launcher, 'docker', side_effect=docker), \
             patch.object(launcher.signal, 'signal', side_effect=lambda sig,fn: handlers.update({sig:fn})), \
             patch('builtins.print'), \
             patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0)):
            if cancel:
                with self.assertRaises(KeyboardInterrupt): launcher.main()
            elif timedout:
                with self.assertRaises(launcher.subprocess.TimeoutExpired): launcher.main()
            elif status == '0': launcher.main()
            else:
                with self.assertRaises(SystemExit) as failed: launcher.main()
                self.assertEqual(failed.exception.code, 17)
        return calls

    def test_container_has_bounded_resources_public_mounts_and_no_host_credentials(self):
        calls = self.execute()
        create = next(call for call in calls if call[0] == 'create')
        for flag, value in [('--cpus','2'),('--memory','3g'),('--memory-swap','3g'),('--pids-limit','256'),('--cap-drop','ALL')]:
            self.assertEqual(create[create.index(flag)+1],value)
        self.assertIn('--read-only', create)
        mounts = [create[i+1] for i,arg in enumerate(create) if arg == '--mount']
        binds = [mount for mount in mounts if mount.startswith('type=bind')]
        self.assertEqual(len(binds), 2)
        self.assertTrue(all('readonly' in mount and '/opt/uain-review-runtime/' in mount for mount in binds))
        all_args = str(calls)
        for private in ['docker.sock','HOST_PRIVATE_KEY','MUST NEVER FORWARD','/approved/source','/home/runner','credentials.toml']:
            self.assertNotIn(private,all_args)
        self.assertTrue(any(call[:2] == ('cp','-') for call in calls))
        self.assertTrue(any(call[:3] == ('cp','-a','-') for call in calls))
        self.assertIn('UAIN_TEST_FOREIGN_KEY_FILE=/work/.ci-foreign-wallet-fixture',create)

    def test_publication_runs_without_tokens_and_has_only_validated_fixed_date(self):
        calls=self.execute(suite='ledger-publication')
        create=next(call for call in calls if call[0]=='create')
        self.assertIn('UAIN_LEDGER_PUBLICATION_DATE=2026-10-11',create)
        self.assertFalse(any(call[:2]==('run','-d') for call in calls))
        for forbidden in ('GITHUB_TOKEN','TOKEN=','--send','LEDGER_PUBLIC_KEY_FILE=/host','docker.sock'):
            self.assertNotIn(forbidden,str(calls))

    def test_postgres_is_loopback_in_its_disposable_network_namespace(self):
        calls=self.execute(suite='pilot')
        create=next(call for call in calls if call[0]=='create')
        self.assertTrue(create[create.index('--network')+1].startswith('container:uain-ci-'))
        self.assertIn('PGHOST=127.0.0.1',create)
        self.assertIn('UAIN_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres',create)
        pg=next(call for call in calls if call[:2]==('run','-d'))
        self.assertNotIn('-p',pg); self.assertNotIn('--publish',pg)

    def test_cancellation_and_deadline_force_remove_resources(self):
        for mode in ('cancel','timedout'):
            calls=self.execute(**{mode:True})
            self.assertEqual(sum(call[:2]==('rm','-f') for call in calls),2)
            self.assertEqual(sum(call[:2]==('volume','rm') for call in calls),2)
            self.assertTrue(any(call[:2]==('network','rm') for call in calls))

    def test_failed_suite_propagates_failure_and_removes_owned_resources(self):
        calls = self.execute('17')
        self.assertEqual(sum(call[:2] == ('volume','rm') for call in calls),2)
        self.assertTrue(any(call[:2] == ('network','rm') for call in calls))
        self.assertEqual(sum(call[:2] == ('rm','-f') for call in calls),2)

    def test_every_resource_carries_run_labels_and_budget_is_reserved_first(self):
        calls = self.execute(suite='pilot')
        job, suite, need, wait = self.admission.reserved[0]
        self.assertEqual((suite, need), ('pilot', launcher.SUITE_SCRATCH['pilot']))
        self.assertLessEqual(wait, 180)
        creators = [call for call in calls if call[0] in ('run', 'create') or call[1:2] == ('create',)]
        self.assertEqual(len(creators), 5)  # network, two volumes, database, test container
        for call in creators:
            for label in ('uain.ci.disposable=true', 'uain.purpose=tests', 'uain.ci.run='+job, 'uain.ci.suite=pilot'):
                self.assertIn(label, call)
        self.assertEqual(self.admission.released, [job])
        self.assertEqual(self.admission.rows[0]['run'], job)
        self.assertEqual(self.admission.rows[0]['budget'], launcher.SUITE_SCRATCH['pilot'])

class PublicationContractTests(unittest.TestCase):
    ROOT={"date":"2026-10-11","root":"e2b4dec3718b95283776d6efdc696ab25fed35ec9b518736a7020d74dec39637","head":"dd1835d7e1b5d76765b24bd0600076f115c8297393bb893698a2922f0bd7d27c","count":4,"first_id":1644,"last_id":1647,"provisional":False,"signature":"q0J+01CJ/UcwT4IHYBIddrJSgnfGT9ehrnY0scHeQsPct9ihNo8NlmtqjHPTS3NYOmWUjw6wd7uT9sO4AUKyAA=="}
    def raw(self,value=None):
        import json
        return (json.dumps(value or self.ROOT,indent=2)+'\n').encode()
    def test_fixed_date_only_suite_never_accepts_path_or_flag_injection(self):
        self.assertEqual(launcher.parse_suite(['ledger-publication','2026-10-11']),('ledger-publication','2026-10-11','0'))
        for args in [['ledger-publication'],['ledger-publication','../../x'],['ledger-publication','2026-02-30'],['ledger-publication','9999-01-01'],['ledger-publication','2026-10-11','--send']]:
            with self.subTest(args=args),self.assertRaises(ValueError):launcher.parse_suite(args)
    def test_export_reverifies_exact_signed_public_root_with_fixed_independent_key(self):
        self.assertEqual(launcher.validate_publication(self.raw(),'2026-10-11'),self.raw())
        for changes in [{'root':'f'*64},{'date':'2026-10-10'},{'signature':'A'*86+'=='},{'provisional':True},{'count':True},{'count':-1},{'first_id':0},{'last_id':1643},{'untrusted':'extra'}]:
            with self.subTest(changes=changes),self.assertRaises(ValueError):launcher.validate_publication(self.raw(dict(self.ROOT,**changes)),'2026-10-11')
        with self.assertRaises(ValueError):launcher.validate_publication(b'x'*4097,'2026-10-11')
        with self.assertRaises(ValueError):launcher.validate_publication(self.raw().replace(b'"count": 4',b'"count": 4, "count": 4'),'2026-10-11')
    def test_stalled_export_is_deadlined_and_child_is_killed(self):
        class Stalled:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def register(self,*args):pass
            def select(self,*args):return []
        process=Mock();process.poll.return_value=None
        with patch.object(launcher.subprocess,'Popen',return_value=process),patch.object(launcher.selectors,'DefaultSelector',return_value=Stalled()):
            with self.assertRaisesRegex(ValueError,'deadline'):launcher.export_publication('fixed-test-container','2026-10-11')
        process.kill.assert_called_once();process.stdout.close.assert_called_once()

    def test_export_tar_accepts_only_one_bounded_regular_exact_date_file(self):
        for kind in ('file','symlink','hardlink','wrong','duplicate','large'):
            stream=io.BytesIO()
            with tarfile.open(fileobj=stream,mode='w') as archive:
                entry=tarfile.TarInfo('other.json' if kind=='wrong' else '2026-10-11.json');data=self.raw()
                if kind=='symlink':entry.type=tarfile.SYMTYPE;entry.linkname='/host/secret'
                elif kind=='hardlink':entry.type=tarfile.LNKTYPE;entry.linkname='/host/secret'
                else:
                    if kind=='large':data=b'x'*4097
                    entry.size=len(data)
                archive.addfile(entry,io.BytesIO(data) if entry.isfile() else None)
                if kind=='duplicate':archive.addfile(entry,io.BytesIO(data))
            if kind=='file':self.assertEqual(launcher.publication_archive(stream.getvalue(),'2026-10-11'),self.raw())
            else:
                with self.subTest(kind=kind),self.assertRaises(ValueError):launcher.publication_archive(stream.getvalue(),'2026-10-11')

if __name__ == '__main__': unittest.main()


class NetworkTests(unittest.TestCase):
    def test_networks_use_the_dedicated_range_and_skip_overlaps(self):
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            subnet = command[command.index('--subnet') + 1]
            busy = len(calls) < 3
            return subprocess.CompletedProcess(command, 1 if busy else 0, '', 'Pool overlaps with other one on this address space' if busy else '')
        job = 'uain-ci-' + '0' * 24 + '000000ff'
        with mock.patch.object(launcher, 'docker', lambda *a, **k: run(['docker', *a], **k)):
            subnet = launcher.create_network(job, job + '-net', ['--label', 'x'])
        self.assertEqual([c[c.index('--subnet') + 1] for c in calls], ['10.213.255.0/24', '10.213.0.0/24', '10.213.1.0/24'])
        self.assertEqual(subnet, '10.213.1.0/24')

    def test_other_network_errors_are_not_retried(self):
        def run(command, **kwargs): return subprocess.CompletedProcess(command, 1, '', 'permission denied')
        with mock.patch.object(launcher, 'docker', lambda *a, **k: run(['docker', *a], **k)):
            with self.assertRaises(ValueError): launcher.create_network('uain-ci-' + 'a' * 32, 'n', [])
