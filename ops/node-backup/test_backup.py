import datetime
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import coordinator
import entry
import node
import receive

KEY='ab'*32


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.backups=self.root/'backups';self.backups.mkdir(mode=0o700)
        self.base=self.root/'nodes';self.base.mkdir();self.home=self.base/'fixture-chain';self.home.mkdir(mode=0o700)
        (self.home/'config').mkdir(mode=0o700);(self.home/'data').mkdir(mode=0o700)
        (self.home/'config/genesis.json').write_text('{"chain_id":"fixture-chain"}')
        (self.home/'config/priv_validator_key.json').write_text('FICTIONAL TEST SECRET')
        (self.home/'data/priv_validator_state.json').write_text('{"height":"17"}')
        self.binary=self.root/'uaind';self.binary.write_text('fictional daemon');self.binary.chmod(0o755)
        self.unit=self.root/node.UNIT;self.unit.write_text('fixture service')
        self.inventory=dict(host='uain-app-1',home=str(self.home),binary=str(self.binary),
            binary_sha256=node.sha(self.binary),unit_sha256=node.sha(self.unit),
            genesis_sha256=node.sha(self.home/'config/genesis.json'),chain_id='fixture-chain')
        self.running=True;self.actions=[]
        def run(args):
            self.actions.append(args)
            if args[:2]==['systemctl','stop']:self.running=False
            elif args[:2]==['systemctl','start']:self.running=True
            return ''
        self.patches=[patch.object(node,'ROOT',self.backups),patch.object(node,'HOME_BASE',self.base),
            patch.object(node,'MARKER',self.root/'restart.json'),patch.object(node,'UNIT_FILE',self.unit),
            patch.object(node,'CAPTURE_LOCK',self.root/'lock'),patch.object(node,'CAPSULE_TMP',self.root),
            patch.object(node,'inventory',return_value=self.inventory),patch.object(node,'active',side_effect=lambda:self.running),
            patch.object(node,'run',side_effect=run)]
        for p in self.patches:p.start()

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temporary.cleanup()

    def capture(self,stamp='20261009T120000Z'):
        return node.capture(KEY,stamp)

    def test_cold_capture_roundtrip_restarts_without_starting_restored_signer(self):
        receipt=self.capture();path=self.backups/receipt['name']
        self.assertTrue(receipt['full_tree_restore_verified']);self.assertFalse(receipt['restored_signer_started'])
        self.assertTrue(self.running);self.assertFalse(node.MARKER.exists())
        self.assertEqual([a[1] for a in self.actions],['stop','start'])
        self.assertNotIn(b'FICTIONAL TEST SECRET',path.read_bytes())
        self.assertTrue(path.read_bytes().startswith(b'UAINNODE01'))
        self.assertEqual(path.stat().st_mode&0o777,0o600)
        self.assertEqual(receipt['manifest']['tree'],node.tree(self.home))
        with self.assertRaises(ValueError):self.capture()

    def test_failed_source_restarts_original_and_cleans_partial_archive(self):
        with patch.object(node.crypto,'seal',side_effect=RuntimeError('fixture failure')):
            with self.assertRaises(RuntimeError):self.capture()
        self.assertTrue(self.running);self.assertFalse(node.MARKER.exists())
        self.assertEqual(list(self.backups.iterdir()),[])

    def test_changed_unit_is_never_restarted_by_cleanup(self):
        node.atomic_json(node.MARKER,dict(inventory=self.inventory));self.running=False
        with patch.object(node,'inventory',return_value={**self.inventory,'binary_sha256':'c'*64}):
            with self.assertRaises(ValueError):node.recover()
        self.assertFalse(self.running);self.assertTrue(node.MARKER.exists())

    def test_operator_stopped_node_is_not_started_for_backup(self):
        self.running=False
        with self.assertRaises(ValueError):self.capture()
        self.assertEqual(self.actions,[])

    def test_corrupt_or_wrong_key_emits_no_unauthenticated_plaintext(self):
        receipt=self.capture();path=self.backups/receipt['name'];sink=io.BytesIO()
        with self.assertRaises(Exception):node.crypto.open_verified(path,'cd'*32,sink)
        self.assertEqual(sink.getvalue(),b'')
        value=bytearray(path.read_bytes());value[40]^=1;path.write_bytes(value)
        with self.assertRaises(Exception):node.crypto.open_verified(path,KEY,sink)
        self.assertEqual(sink.getvalue(),b'')

    def test_authenticated_tar_traversal_refused_before_extraction(self):
        source=io.BytesIO()
        with tarfile.open(fileobj=source,mode='w:gz') as tar:
            item=tarfile.TarInfo('../escape');item.size=3;tar.addfile(item,io.BytesIO(b'bad'))
        source.seek(0);path=self.backups/'malicious';node.crypto.seal(source,path,KEY)
        with self.assertRaises(ValueError):node.crypto.unpack(path,KEY,self.backups/'out')
        self.assertFalse((self.backups/'out').exists());self.assertFalse((self.root/'escape').exists())

    def test_replica_authentication_immutable_retry_and_truncation(self):
        receipt=self.capture();original=self.backups/receipt['name'];data=original.read_bytes()
        name=receipt['name'];original.unlink()
        value=dict(action='put',name=name,key=KEY,length=len(data),sha256=receipt['ciphertext_sha256'])
        output=io.BytesIO();receive.receive(value,io.BytesIO(data),output)
        self.assertTrue(json.loads(output.getvalue())['replicated'])
        receive.receive(value,io.BytesIO(data),io.BytesIO())
        self.assertEqual((self.backups/name).read_bytes(),data)
        with self.assertRaises(ValueError):receive.receive(value,io.BytesIO(data[:-1]),io.BytesIO())
        with self.assertRaises(Exception):receive.receive({**value,'key':'cd'*32},io.BytesIO(data),io.BytesIO())
        self.assertEqual((self.backups/name).read_bytes(),data)

    def test_endpoint_rejects_shell_paths_unknown_actions_and_extra_fields(self):
        for value in [dict(action='shell'),dict(action='capture',key=KEY,stamp='x',home='/root'),dict(action='put',name='x')]:
            with self.assertRaises(ValueError):receive.request(io.BytesIO((json.dumps(value)+'\n').encode()))
        for name in ['../secret','/etc/passwd','uain-node-other-20261009T120000Z.nodebk']:
            with self.assertRaises(ValueError):node.archive_path(name)
        with self.assertRaises(ValueError):node.filename('uain-app-1','20261340T120000Z')

    def test_retention_keeps_fourteen_per_node_and_unrelated_files(self):
        for host in node.HOSTS:
            for day in range(1,18):
                p=self.backups/node.filename(host,f'202609{day:02}T120000Z');p.write_bytes(b'ciphertext');p.with_suffix('.json').write_text(json.dumps(dict(name=p.name,full_tree_restore_verified=True)))
        unrelated=self.backups/'unrelated';unrelated.write_text('preserve')
        self.assertEqual(len(node.prune()),6)
        self.assertEqual(len(list(self.backups.glob('*.nodebk'))),28);self.assertTrue(unrelated.exists())

    def test_no_retention_or_success_marker_before_all_destinations_verify(self):
        with patch.object(coordinator,'remote') as remote,patch.object(node,'prune') as prune:
            with self.assertRaises(ValueError):coordinator.finalize(dict(offsite_verified=False,cross_host_readback_verified=True,backups=[]))
            remote.assert_not_called();prune.assert_not_called()
        self.assertFalse((self.backups/'last-success.json').exists())

    def test_offsite_readback_substitution_fails(self):
        path=self.backups/'fixture';path.write_bytes(b'ciphertext')
        class Client:
            def put_object(self,**args):pass
            def get_object(self,**args):return {'Body':io.BytesIO(b'wrong-data')}
        with self.assertRaises(ValueError):entry.publish(Client(),path,node.sha(path))

    def test_check_refuses_stale_missing_and_modified_backups(self):
        with self.assertRaises(FileNotFoundError):coordinator.check()
        receipt=self.capture()
        self.inventory['host']='uain-db-1';second=self.capture()
        status=dict(created_at=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=27)).isoformat(),offsite_verified=True,cross_host_readback_verified=True,backups=[receipt,second])
        node.atomic_json(self.backups/'last-success.json',status)
        with self.assertRaises(ValueError):coordinator.check()
        status['created_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();node.atomic_json(self.backups/'last-success.json',status)
        self.assertTrue(coordinator.check()['healthy'])
        (self.backups/receipt['name']).write_bytes(b'corrupt')
        with self.assertRaises(ValueError):coordinator.check()


class EntryLockTest(unittest.TestCase):
    """The run holds the custody lock only for the vault read (FIXTURE)."""
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.profile=self.root/'node.json';self.helper=self.root/'failover-backup.py'
        self.profile.write_text('{}');self.helper.write_text('def custody_quiet(timing):pass\n')
        self.seen=[]
        outer=self
        class Custody:
            def vault(self):outer.seen.append(('vault',outer.held()));return object()
            def verify_vault(self,kp):outer.seen.append(('verify_vault',outer.held()))
            def attachment(self,kp,name):outer.seen.append(('key',outer.held()));return (KEY+'\n').encode()
            def s3(self):outer.seen.append(('s3',outer.held()));return object()
        def child(action,value):
            self.seen.append((action,self.held()));self.assertEqual(value.get('key',KEY),KEY)
            return dict(backups=[]) if action=='run' else value
        self.patches=[patch.object(entry,'CUSTODY_LOCK',self.root/'custody.lock'),patch.object(entry,'ROLE_PROFILE',self.profile),
            patch.object(entry,'ROLE_HELPER',self.helper),patch.object(entry,'load_custody',return_value=Custody()),
            patch.object(entry,'child',side_effect=child),patch.object(entry.os,'geteuid',return_value=0),
            patch.object(entry.sys,'argv',['entry.py','run']),patch.object(entry.sys,'stdout',io.StringIO())]
        for p in self.patches:p.start()

    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temporary.cleanup()

    def held(self):
        import fcntl
        with entry.CUSTODY_LOCK.open('a') as probe:
            try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return True
            fcntl.flock(probe,fcntl.LOCK_UN);return False

    def test_custody_lock_is_released_after_the_key_read_when_the_helper_guards_its_own_stop(self):
        entry.main()
        self.assertEqual(self.seen,[('vault',True),('verify_vault',True),('key',True),('run',False),('s3',False),('finalize',False)])
        self.assertFalse(self.held())

    def test_without_profile_or_with_an_older_helper_the_lock_stays_for_the_whole_run(self):
        for change in ('no profile','old helper','no helper'):
            with self.subTest(change=change):
                self.tearDown();self.setUp()
                if change=='no profile':self.profile.unlink()
                elif change=='old helper':self.helper.write_text('def capture(node,key,stamp):pass\n')
                else:self.helper.unlink()
                entry.main()
                self.assertEqual([held for _,held in self.seen],[True]*6);self.assertFalse(self.held())

    def test_verify_and_a_failed_run_release_the_lock(self):
        with patch.object(entry.sys,'argv',['entry.py','verify','uain-node-uain-app-1-20261110T120000Z.nodebk']):entry.main()
        self.assertEqual(self.seen[-1],('verify',False));self.assertFalse(self.held())
        with patch.object(entry,'child',side_effect=ValueError('Node backup coordinator failed')),self.assertRaises(ValueError):entry.main()
        self.assertFalse(self.held())

    def test_busy_custody_lock_fails_before_the_vault_is_read(self):
        import fcntl
        with entry.CUSTODY_LOCK.open('a') as busy,patch.object(entry,'CUSTODY_WAIT_SECONDS',0.3):
            fcntl.flock(busy,fcntl.LOCK_EX)
            with self.assertRaisesRegex(ValueError,'Custody lock busy'):entry.main()
        self.assertEqual(self.seen,[])

    def test_children_do_not_inherit_the_custody_lock(self):
        lock=entry.CustodyLock();lock.acquire()
        try:self.assertFalse(os.get_inheritable(lock.fd))
        finally:lock.release()
        lock.release();self.assertFalse(self.held())

    def test_wrapper_holds_the_run_lock_and_not_the_custody_lock(self):
        wrapper=(Path(entry.__file__).with_name('uain-node-backup')).read_text()
        self.assertIn('/run/lock/uain-node-backup-run.lock',wrapper);self.assertNotIn('uain-custody.lock',wrapper)


if __name__=='__main__':unittest.main()
