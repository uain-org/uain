#!/usr/bin/python3 -I
"""Public runtime filesystem and interrupted-install regression tests."""
import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('install-native-runtime.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class RuntimeTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='uain-runtime-test-',dir=Path.cwd());self.root=Path(self.temp.name);os.chmod(self.root,0o755)
  self.config=self.root/'config';self.config.mkdir(mode=0o700);self.unit=self.root/'unit'
  self.patches=[patch.object(r,'CONFIG',self.config),patch.object(r,'UNIT',self.unit)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in self.patches:p.stop()
  self.temp.cleanup()
 def data(self,label='one'):
  unit=('unit-'+label).encode();runtime=('runtime-'+label).encode()
  return {'source_revision':label,'checkpoint':{'height':'10'},'unit_sha256':r.digest(unit),'runtime_config_sha256':r.digest(runtime)},unit,runtime
 def test_public_directories_override_private_umask_only_in_managed_tree(self):
  managed=self.root/'public';old=os.umask(0o077)
  try:r.public_directory(managed/'state'/'digest',managed)
  finally:os.umask(old)
  for p in [managed,managed/'state',managed/'state'/'digest']:self.assertEqual(p.stat().st_mode&0o777,0o755)
  self.assertEqual(self.config.stat().st_mode&0o777,0o700)
 def test_public_directories_reject_symlink(self):
  managed=self.root/'public';managed.symlink_to(self.config,target_is_directory=True)
  with self.assertRaises(ValueError):r.public_directory(managed,managed)
 def test_public_directories_reject_writable_existing_root(self):
  managed=self.root/'public';managed.mkdir();os.chmod(managed,0o777)
  with self.assertRaises(ValueError):r.public_directory(managed,managed)
 def test_protected_rejects_symlink_and_hardlink(self):
  p=self.root/'source';p.write_bytes(b'public');os.chmod(p,0o600)
  self.assertEqual(r.protected(p),b'public')
  q=self.root/'link';q.symlink_to(p)
  with self.assertRaises(ValueError):r.protected(q)
  q.unlink();os.link(p,q)
  with self.assertRaises(ValueError):r.protected(p)
 def test_immutable_never_replaces_unknown_bytes(self):
  p=self.root/'public';r.immutable(p,b'expected',0o444);r.immutable(p,b'expected',0o444)
  with self.assertRaises(ValueError):r.immutable(p,b'other',0o444)
 def test_first_publish_retains_reconciliation_journal(self):
  record,unit,runtime=self.data();self.assertEqual(r.publish(record,unit,runtime),record)
  self.assertEqual(self.unit.read_bytes(),unit);self.assertTrue((self.config/'pending.json').exists())
  self.assertEqual((self.config/'runtime.conf').stat().st_mode&0o777,0o600)
 def test_unknown_existing_service_refused(self):
  self.unit.write_bytes(b'unknown')
  with self.assertRaises(ValueError):r.publish(*self.data())
 def test_interrupted_pair_completes_exact_approved_bytes(self):
  original=r.atomic;record,unit,runtime=self.data();calls=0
  def fail(path,raw,mode):
   nonlocal calls
   calls+=1
   if calls==3:raise OSError('simulated power loss after config')
   original(path,raw,mode)
  with patch.object(r,'atomic',side_effect=fail):
   with self.assertRaises(OSError):r.publish(record,unit,runtime)
  self.assertFalse(self.unit.exists());self.assertEqual((self.config/'runtime.conf').read_bytes(),runtime)
  retry=dict(record,checkpoint={'height':'11'})
  self.assertEqual(r.publish(retry,unit,runtime),record);self.assertEqual(self.unit.read_bytes(),unit)
 def test_interrupted_pair_refuses_different_approval(self):
  r.publish(*self.data())
  with self.assertRaises(ValueError):r.publish(*self.data('two'))
 def test_interrupted_pair_refuses_unrecognized_mutation(self):
  r.publish(*self.data());self.unit.write_bytes(b'unknown')
  with self.assertRaises(ValueError):r.publish(*self.data())
 def test_completed_install_checks_previous_pair(self):
  r.publish(*self.data());(self.config/'pending.json').unlink();self.unit.write_bytes(b'changed')
  with self.assertRaises(ValueError):r.publish(*self.data('two'))
 def test_service_is_keyless_bounded_and_cleans_stale_socket(self):
  unit=r.service('a'*64).decode()
  for required in ['Group=1000','RuntimeDirectoryMode=0750','RuntimeDirectoryPreserve=yes','ExecStartPre=/usr/bin/rm -f /run/uain-native-rpc/gateway.sock','MemoryMax=256M','NoNewPrivileges=yes','IPAddressAllow=localhost']:self.assertIn(required,unit)
  self.assertNotIn('credential',unit.lower());self.assertNotIn('vault',unit.lower())
if __name__=='__main__':unittest.main()
