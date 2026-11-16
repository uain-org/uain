"""No real vault or storage credentials are used by these boundary tests."""
import importlib.util,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
spec=importlib.util.spec_from_file_location('evidence',Path(__file__).with_name('evidence.py'));e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
class EvidenceTests(unittest.TestCase):
 def custody(self):return SimpleNamespace(vault=Mock(return_value='vault'),verify_vault=Mock(),attachment=Mock(return_value=b'a'*64),kubernetes_secret=Mock(return_value={'UAIN_STORAGE_ACCESS_KEY_ID':b'fictional-id','UAIN_STORAGE_SECRET_ACCESS_KEY':b'fictional-secret'}))
 def test_unknown_helper_refused_before_vault(self):
  c=self.custody()
  with patch.object(e,'validate',side_effect=ValueError('changed source')):
   with self.assertRaises(ValueError):e.backup(c,'/trusted')
  c.vault.assert_not_called();c.kubernetes_secret.assert_not_called()
 def test_only_backup_key_and_minimal_storage_environment(self):
  c=self.custody()
  with patch.object(e,'validate',return_value=Path('/trusted')),patch.object(e.subprocess,'run') as run,patch.dict(os.environ,{'MEMBER_PRIVATE_KEY':'never','ARBITRARY':'never'}):e.backup(c,'/trusted')
  c.attachment.assert_called_once_with('vault','keys/backup-key.txt');args,kw=run.call_args
  self.assertEqual(args[0][0:2],['/usr/bin/bash','/trusted/ops/evidence/backup.sh']);self.assertEqual(kw['env']['UAIN_BACKUP_KEY'],'a'*64)
  self.assertEqual(set(kw['env']),{'PATH','LANG','UAIN_BACKUP_KEY','UAIN_BACKUP_S3_ENDPOINT','UAIN_BACKUP_S3_BUCKET','UAIN_BACKUP_S3_REGION','UAIN_BACKUP_S3_ACCESS_KEY_ID','UAIN_BACKUP_S3_SECRET_ACCESS_KEY'})
  self.assertIn(e.PLAN_SHA,args[0]);self.assertTrue(kw['check']);self.assertEqual(kw['timeout'],5400)
 def test_invalid_backup_key_never_starts_helper(self):
  c=self.custody();c.attachment.return_value=b'not-a-key'
  with patch.object(e,'validate',return_value=Path('/trusted')),patch.object(e.subprocess,'run') as run:
   with self.assertRaises(ValueError):e.backup(c,'/trusted')
  run.assert_not_called()
 def test_validation_hashes_every_executable_before_plan(self):
  reads=[]
  def read(path,limit=1024*1024):reads.append(str(path));return b'changed'
  with patch.object(e,'protected',side_effect=read):
   with self.assertRaises(ValueError):e.validate('/trusted')
  self.assertEqual(reads,['/trusted/ops/evidence/backup.sh'])
 def test_all_pins_match_repository_bytes(self):
  root=Path(__file__).resolve().parents[2]
  import hashlib
  for name,digest in e.FILES.items():self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),digest)
 def held(self):
  import fcntl
  with open(e.LOCK,'a') as probe:
   try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:return True
   fcntl.flock(probe,fcntl.LOCK_UN);return False
 def test_daily_entry_holds_the_custody_lock_for_the_secret_reads_only(self):
  import tempfile
  with tempfile.TemporaryDirectory() as directory,patch.object(e,'LOCK',directory+'/custody.lock'):
   seen=[];c=self.custody()
   c.vault.side_effect=lambda:(seen.append(('vault',self.held())),'vault')[1]
   c.kubernetes_secret.side_effect=lambda name:(seen.append(('secret',self.held())),{'UAIN_STORAGE_ACCESS_KEY_ID':b'fictional-id','UAIN_STORAGE_SECRET_ACCESS_KEY':b'fictional-secret'})[1]
   with patch.object(e,'validate',side_effect=lambda checkout:(seen.append(('validate',self.held())),Path('/trusted'))[1]),patch.object(e.subprocess,'run',side_effect=lambda *a,**k:seen.append(('helper',self.held()))) as run:e.backup_narrow(c,'/trusted')
   # Pins first and unlocked, both secret reads locked, the long helper unlocked.
   self.assertEqual(seen,[('validate',False),('vault',True),('secret',True),('helper',False)]);self.assertFalse(self.held())
   args,kw=run.call_args;self.assertEqual(kw['env']['UAIN_BACKUP_KEY'],'a'*64);self.assertEqual(kw['timeout'],5400);self.assertEqual(args[0][0:2],['/usr/bin/bash','/trusted/ops/evidence/backup.sh'])
 def test_daily_entry_waits_for_a_busy_custody_lock_then_refuses_before_the_vault(self):
  import fcntl,tempfile
  with tempfile.TemporaryDirectory() as directory,patch.object(e,'LOCK',directory+'/custody.lock'),patch.object(e,'LOCK_WAIT_SECONDS',0.3):
   c=self.custody()
   with open(e.LOCK,'a') as busy,patch.object(e,'validate',return_value=Path('/trusted')),patch.object(e.subprocess,'run') as run:
    fcntl.flock(busy,fcntl.LOCK_EX)
    with self.assertRaises(ValueError):e.backup_narrow(c,'/trusted')
   c.vault.assert_not_called();run.assert_not_called()
 def test_failed_secret_read_releases_the_lock_and_never_starts_the_helper(self):
  import tempfile
  with tempfile.TemporaryDirectory() as directory,patch.object(e,'LOCK',directory+'/custody.lock'):
   c=self.custody();c.attachment.return_value=b'not-a-key'
   with patch.object(e,'validate',return_value=Path('/trusted')),patch.object(e.subprocess,'run') as run:
    with self.assertRaises(ValueError):e.backup_narrow(c,'/trusted')
   run.assert_not_called();self.assertFalse(self.held())
 def test_plan_lives_outside_the_test_folder_and_the_unit_uses_the_narrow_entry(self):
  root=Path(__file__).resolve().parents[2]
  self.assertTrue(e.PLAN.startswith('/etc/uain-evidence/'));self.assertNotIn('/opt/uain-test',Path(__file__).with_name('evidence.py').read_text().split("PLAN='")[1].split("'")[0])
  unit=(root/'ops/evidence/uain-evidence-backup.service').read_text();wrapper=(root/'ops/custody/uain-evidence-backup').read_text()
  self.assertIn('ExecStart=/usr/local/sbin/uain-evidence-backup /opt/uain-evidence-operations/src\n',unit);self.assertNotIn('uain-custody backup-evidence',unit)
  self.assertIn('/opt/uain-evidence-backup/entry.py',wrapper);self.assertNotIn('uain-custody.lock',wrapper)
if __name__=='__main__':unittest.main()
