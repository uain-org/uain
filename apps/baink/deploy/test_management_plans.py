import importlib.util,pathlib,tempfile,unittest,json,hashlib
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).with_name('install-management-plans.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Plans(unittest.TestCase):
 def test_atomic_batch_and_digest_guard(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);source=root/'upload';dest=root/'plans.json';raw=json.dumps([{'projectId':'OPP-00001'}]).encode();source.write_bytes(raw);sha=hashlib.sha256(raw).hexdigest();result=module.install(source,dest,sha);self.assertEqual(result['installed'],1);self.assertEqual(dest.read_bytes(),raw);self.assertEqual(dest.stat().st_mode&0o777,0o600)
   source.write_text('[]')
   with self.assertRaises(ValueError):module.install(source,dest,sha)
   self.assertEqual(dest.read_bytes(),raw)
 def test_symlink_source_denied(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);source=root/'upload';target=root/'target';target.write_text('[]');source.symlink_to(target)
   with self.assertRaises(OSError):module.install(source,root/'plans','a'*64)
if __name__=='__main__':unittest.main()
