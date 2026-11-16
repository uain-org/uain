"""Offline signed-root preparation uses no package download or credentials."""
import importlib.util,json,unittest
from pathlib import Path
class PreparationTests(unittest.TestCase):
 def module(self):
  spec=importlib.util.spec_from_file_location('preparation',Path(__file__).with_name('prepare-ledger-publication.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def root(self):
  return {'date':'2026-10-11','root':'e2b4dec3718b95283776d6efdc696ab25fed35ec9b518736a7020d74dec39637','head':'dd1835d7e1b5d76765b24bd0600076f115c8297393bb893698a2922f0bd7d27c','count':4,'first_id':1644,'last_id':1647,'provisional':False,'signature':'q0J+01CJ/UcwT4IHYBIddrJSgnfGT9ehrnY0scHeQsPct9ihNo8NlmtqjHPTS3NYOmWUjw6wd7uT9sO4AUKyAA=='}
 def test_signed_http_shape_becomes_exact_canonical_export(self):
  m=self.module();v=self.root();self.assertEqual(m.prepare(json.dumps(v).encode(),'2026-10-11'),(json.dumps(v,indent=2)+'\n').encode());self.assertEqual(m.prepare(json.dumps(dict(v,computed_at='2026-10-12T01:44:41.381Z')).encode(),'2026-10-11'),(json.dumps(v,indent=2)+'\n').encode())
 def test_changed_duplicate_oversized_or_extra_data_refused(self):
  m=self.module();v=self.root()
  for raw in [json.dumps(dict(v,root='f'*64)).encode(),json.dumps(dict(v,extra=True)).encode(),json.dumps(v).replace('"count": 4','"count": 4,"count": 4').encode(),b'x'*4097]:
   with self.assertRaises(ValueError):m.prepare(raw,'2026-10-11')
 def test_publication_suite_has_no_npm_or_compiler_dependency(self):
  script=Path(__file__).with_name('container-suite.sh').read_text().split(' ledger-publication)')[1].split(';;')[0]
  self.assertNotIn('npm ',script);self.assertIn('prepare-ledger-publication.py',script)
if __name__=='__main__':unittest.main()
