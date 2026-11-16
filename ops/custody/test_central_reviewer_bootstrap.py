import os,json,tempfile,hashlib,unittest,sys,importlib.util,importlib._bootstrap_external
from pathlib import Path
from unittest.mock import patch
import central_reviewer_server as m
class InterfaceTest(unittest.TestCase):
 def test_source_only_bootstrap_exists(self):self.assertTrue(callable(getattr(m,'bootstrap_sources',None)))
@unittest.skipUnless(os.geteuid()==0,'protected source bootstrap needs disposable root-owned scope')
class BootstrapTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.root=Path(self.tmp.name)
  self.manifest=self.root/'sources.json'
  for name in m.SOURCE_NAMES:(self.root/(name+'.py')).write_text("VALUE='reviewed source'\n")
  self.approve()
 def tearDown(self):self.tmp.cleanup()
 def approve(self):
  self.manifest.write_text(json.dumps(dict(schema='uain-central-reviewer-sources-v1',sha256={n+'.py':hashlib.sha256((self.root/(n+'.py')).read_bytes()).hexdigest() for n in m.SOURCE_NAMES})))
 def test_pinned_sources_ignore_forged_valid_timestamp_bytecode(self):
  source=self.root/'native_migration.py';metadata=source.stat();cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir()
  cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(compile("raise RuntimeError('FORGED BYTECODE EXECUTED')",str(source),'exec'),int(metadata.st_mtime),metadata.st_size))
  with patch.dict(sys.modules):
   m.bootstrap_sources(self.root,self.manifest)
   self.assertEqual(sys.modules['native_migration'].VALUE,'reviewed source')
 def test_wrong_hash_or_redirect_refused_before_any_source_execution(self):
  (self.root/'native_migration.py').write_text("raise RuntimeError('UNREVIEWED SOURCE EXECUTED')\n")
  with patch.dict(sys.modules),self.assertRaisesRegex(ValueError,'Pinned central reviewer source refused'):m.bootstrap_sources(self.root,self.manifest)
  self.approve();source=self.root/'custody.py';source.unlink();source.symlink_to(self.root/'native_migration.py')
  with self.assertRaisesRegex(ValueError,'Pinned central reviewer source refused'):m.bootstrap_sources(self.root,self.manifest)
 def test_missing_extra_and_duplicate_manifest_fields_refused(self):
  for value in (dict(schema='uain-central-reviewer-sources-v1',sha256={}),dict(schema='uain-central-reviewer-sources-v1',sha256={},extra=True)):
   self.manifest.write_text(json.dumps(value))
   with self.assertRaises(ValueError):m.bootstrap_sources(self.root,self.manifest)
  self.manifest.write_text('{"schema":"x","schema":"x","sha256":{}}')
  with self.assertRaises(ValueError):m.bootstrap_sources(self.root,self.manifest)


if __name__=='__main__':unittest.main()
