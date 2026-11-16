"""Installation changes capability bytes, never operational data or SSH keys."""
import importlib.util
import contextlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

# The CI launcher supplies one immutable, fictional UID65534 inode before
# dropping every capability. Move it within /work for real owner-refusal cases;
# never grant CHOWN or replace the ownership check with a mock.
foreign_fixture=os.environ.get('UAIN_TEST_FOREIGN_KEY_FILE')
if foreign_fixture:
 foreign_fixture=Path(foreign_fixture)
 if not foreign_fixture.is_absolute() or foreign_fixture.name!='.ci-foreign-wallet-fixture':raise ValueError('Exact fictional foreign fixture required')

def setUpModule():
 if foreign_fixture:
  # Discovery imports every module before running the first one. Registering
  # a module cleanup at import time lets an earlier module consume it and
  # delete this directory before our tests run. Scope both changes to our run.
  previous=tempfile.tempdir
  fixture_root=tempfile.TemporaryDirectory(prefix='.ci-reset-upgrade-',dir=foreign_fixture.parent)
  def cleanup():
   tempfile.tempdir=previous
   fixture_root.cleanup()
  unittest.addModuleCleanup(cleanup)
  tempfile.tempdir=fixture_root.name

@contextlib.contextmanager
def foreign_owner(file):
 original=file.stat()
 try:os.chown(file,65534,65534)
 except PermissionError:
  if not foreign_fixture:raise
  info=foreign_fixture.lstat()
  if not foreign_fixture.is_file() or foreign_fixture.is_symlink() or info.st_uid!=65534 or info.st_gid!=65534 or info.st_mode&0o777!=0o600 or info.st_nlink!=1 or info.st_size!=32:raise ValueError('Protected fictional foreign fixture differs')
  saved=file.with_name(file.name+'.original-root-inode')
  file.rename(saved)
  try:
   foreign_fixture.rename(file)
   try:yield
   finally:file.rename(foreign_fixture)
  finally:saved.rename(file)
 else:
  try:yield
  finally:os.chown(file,original.st_uid,original.st_gid)

spec=importlib.util.spec_from_file_location('upgrade',Path(__file__).with_name('upgrade.py'))
upgrade=importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)

class UpgradeTests(unittest.TestCase):
 def fixture(self,root):
  layout=upgrade.Layout(root)
  for path in (layout.current,layout.config,layout.epochs,layout.wrapper.parent,layout.authorized.parent):path.mkdir(parents=True,mode=0o700,exist_ok=True)
  (layout.current/'original.py').write_text('old immutable capability\n');(layout.current/'original.py').chmod(0o600)
  layout.wrapper.write_text('#!/bin/sh\nold-wrapper\n');layout.wrapper.chmod(0o700)
  (layout.config/'db_ed25519').write_bytes(b'fictional fixture key, never opened by upgrade');(layout.config/'db_ed25519').chmod(0o600)
  layout.authorized.write_text('from="10.98.0.1",restrict,command="/usr/bin/python3 /opt/uain-reset/node_main.py" ssh-ed25519 AAAAFIXTURE fixture\n');layout.authorized.chmod(0o600)
  (layout.epochs/'retained.json').write_text('original epoch journal\n');(layout.epochs/'retained.json').chmod(0o600)
  source=root/'source';source.mkdir(mode=0o700)
  for name in upgrade.SOURCES:
   (source/name).write_bytes((Path(__file__).parent/name).read_bytes());(source/name).chmod(0o600)
  binaries={}
  for name in ('uain-state','uain-reset-checkpoint','uain-proof'):
   file=root/name;file.write_bytes(b'public fictional '+name.encode());file.chmod(0o700);binaries[name]=file
  return layout,source,binaries
 def approval(self,layout,source,binaries):
  value=upgrade.plan('app',source,binaries,'a'*40,layout)
  value['expires_at']=int(upgrade.time.time())+600
  path=layout.root/'approval.json';path.write_text(json.dumps(value));path.chmod(0o600)
  return path,value
 def test_upgrade_verifier_ignores_forged_valid_bytecode(self):
  import importlib.util,marshal,struct,subprocess,sys
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));file=source/'installed.py';info=file.stat();cache=Path(importlib.util.cache_from_source(str(file)));cache.parent.mkdir(mode=0o700)
   marker=Path(directory)/'forged-cache-executed'
   cache.write_bytes(importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(info.st_mtime),info.st_size)+marshal.dumps(compile('open('+repr(str(marker))+',"w").write("fixture")',str(file),'exec')))
   result=subprocess.run([sys.executable,'-I','-B',str(source/'upgrade.py'),'--help'],capture_output=True)
   self.assertEqual(result.returncode,0,result.stderr.decode());self.assertFalse(marker.exists())
 def test_upgrade_preserves_keys_authorized_scope_epochs_and_exact_legacy(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));key=(layout.config/'db_ed25519').stat();auth=layout.authorized.read_bytes();epochs=(layout.epochs/'retained.json').read_bytes()
   approval,expected=self.approval(layout,source,binaries)
   result=upgrade.install(approval,source,binaries,layout)
   self.assertEqual(result['release_digest'],expected['release_digest']);self.assertTrue(layout.current.is_symlink())
   self.assertEqual((layout.current.resolve()/'archive.py').read_bytes(),(source/'archive.py').read_bytes())
   self.assertEqual((layout.config/'db_ed25519').stat().st_ino,key.st_ino);self.assertEqual(layout.authorized.read_bytes(),auth);self.assertEqual((layout.epochs/'retained.json').read_bytes(),epochs)
   self.assertEqual(list(layout.releases.glob('legacy-*'))[0].joinpath('original.py').read_text(),'old immutable capability\n')
   self.assertEqual(upgrade.install(approval,source,binaries,layout),result)
 def test_approval_refuses_source_prior_config_and_expiry_drift(self):
  for drift in ('source','prior','config','expired','symlink'):
   with self.subTest(drift=drift),tempfile.TemporaryDirectory() as directory:
    layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries)
    if drift=='source':(source/'native.py').write_text('changed')
    elif drift=='prior':(layout.current/'original.py').write_text('changed')
    elif drift=='config':layout.authorized.write_text('changed')
    elif drift=='expired':value['expires_at']=0;approval.write_text(json.dumps(value))
    else:original=approval.with_suffix('.real');approval.rename(original);approval.symlink_to(original)
    with self.assertRaises(ValueError):upgrade.install(approval,source,binaries,layout)
    self.assertFalse(layout.current.is_symlink())
 def test_each_interruption_recovers_forward_to_same_exact_receipt(self):
  for phase in ('staged','retired','switched','wrapper'):
   with self.subTest(phase=phase),tempfile.TemporaryDirectory() as directory:
    layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries)
    def stop(name):
     if name==phase:raise RuntimeError('fixture interruption')
    with self.assertRaisesRegex(RuntimeError,'interruption'):upgrade.install(approval,source,binaries,layout,after=stop)
    result=upgrade.install(approval,source,binaries,layout)
    self.assertEqual(result['release_digest'],value['release_digest']);self.assertEqual(upgrade.install(approval,source,binaries,layout),result)
 def test_versioned_update_retains_previous_release_and_refuses_tamper(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries);upgrade.install(approval,source,binaries,layout);old=layout.current.resolve()
   (source/'native.py').write_text('# new reviewed release\n');approval,value=self.approval(layout,source,binaries);upgrade.install(approval,source,binaries,layout)
   self.assertNotEqual(layout.current.resolve(),old);self.assertTrue(old.is_dir())
   (layout.current/'native.py').write_text('tampered')
   with self.assertRaises(ValueError):upgrade.verify_release(layout.current.resolve())
 def test_interruption_between_atomic_syscall_and_journal_update_recovers(self):
  for point in ('legacy_rename','pointer_replace','wrapper_replace'):
   with self.subTest(point=point),tempfile.TemporaryDirectory() as directory:
    layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries)
    original_rename=Path.rename;original_replace=upgrade.os.replace
    def rename(path,target):
     result=original_rename(path,target)
     if point=='legacy_rename' and path==layout.current:raise OSError('fixture interrupted after atomic rename')
     return result
    def replace(source,target):
     result=original_replace(source,target)
     if (point=='pointer_replace' and Path(target)==layout.current) or (point=='wrapper_replace' and Path(target)==layout.wrapper):raise OSError('fixture interrupted after atomic replace')
     return result
    with patch.object(Path,'rename',rename),patch.object(upgrade.os,'replace',replace),self.assertRaisesRegex(OSError,'fixture interrupted'):upgrade.install(approval,source,binaries,layout)
    result=upgrade.install(approval,source,binaries,layout);self.assertEqual(result['release_digest'],value['release_digest'])
 def test_versioned_upgrade_cannot_change_the_stable_forced_ssh_bootstrap(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries);upgrade.install(approval,source,binaries,layout);previous=layout.current.resolve()
   (source/'node_main.py').write_text('# incompatible bootstrap\n');approval,value=self.approval(layout,source,binaries)
   with self.assertRaisesRegex(ValueError,'bootstrap changed'):upgrade.install(approval,source,binaries,layout)
   self.assertEqual(layout.current.resolve(),previous)
 def test_manifest_refuses_links_foreign_owner_and_writable_files(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries);upgrade.install(approval,source,binaries,layout)
   file=layout.current/'native.py';file.chmod(0o666)
   with self.assertRaises(ValueError):upgrade.verify_release(layout.current.resolve())
   file.chmod(0o600)
   with foreign_owner(file):
    self.assertEqual(file.stat().st_uid,65534)
    with self.assertRaises(ValueError):upgrade.verify_release(layout.current.resolve())
 def test_world_writable_source_ancestor_is_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));parent=layout.root/'untrusted';parent.mkdir(mode=0o777);parent.chmod(0o777);moved=parent/'source';source.rename(moved)
   with self.assertRaises(ValueError):upgrade.plan('app',moved,binaries,'a'*40,layout)
 def test_sticky_system_lock_directory_supported_but_foreign_lock_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));layout.lock.parent.mkdir(parents=True,mode=0o700);layout.lock.parent.chmod(0o1777);approval,value=self.approval(layout,source,binaries)
   self.assertEqual(upgrade.install(approval,source,binaries,layout)['release_digest'],value['release_digest'])
   with foreign_owner(layout.lock):
    self.assertEqual(layout.lock.stat().st_uid,65534)
    # Linux protected_regular may refuse O_CREAT on the foreign sticky-directory
    # file before our descriptor-owner check can run. Both paths fail closed.
    with self.assertRaises((ValueError,PermissionError)):upgrade.install(approval,source,binaries,layout)
 def test_held_lock_refuses_upgrade_before_mutating_installation(self):
  import fcntl
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries)
   layout.lock.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
   with layout.lock.open('a') as held:
    fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
    with self.assertRaisesRegex(ValueError,'busy'):upgrade.install(approval,source,binaries,layout)
   self.assertFalse(layout.current.is_symlink())
 def test_fresh_install_is_versioned_and_cannot_overwrite_any_capability(self):
  import shutil
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));shutil.rmtree(layout.current);layout.wrapper.unlink()
   result=upgrade.bootstrap('app',source,binaries,'a'*40,layout)
   self.assertTrue(layout.current.is_symlink());self.assertEqual(result['release_digest'],layout.current.resolve().name)
   with self.assertRaises(ValueError):upgrade.bootstrap('app',source,binaries,'a'*40,layout)
 def test_runtime_dispatch_checks_current_role_manifest_and_wrapper(self):
  import installed
  with tempfile.TemporaryDirectory() as directory:
   layout,source,binaries=self.fixture(Path(directory));approval,value=self.approval(layout,source,binaries);upgrade.install(approval,source,binaries,layout)
   with patch.object(installed,'CURRENT',layout.current),patch.object(installed,'RELEASES',layout.releases),patch.object(installed,'WRAPPER',layout.wrapper):
    installed.verify_runtime(layout.current/'custody_entry.py','app')
    self.assertEqual(installed.capability(layout.current/'custody_entry.py','app')['release_digest'],value['release_digest'])
    with self.assertRaises(ValueError):installed.verify_runtime(layout.current/'node_main.py','database')
    layout.wrapper.write_text('changed wrapper')
    with self.assertRaises(ValueError):installed.verify_runtime(layout.current/'custody_entry.py','app')

if __name__=='__main__':unittest.main()
