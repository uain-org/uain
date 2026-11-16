"""Narrow custody dispatch contracts; no real vault or service credentials."""
import importlib.util,sys,types,unittest,marshal,struct,tempfile,os
from pathlib import Path
from unittest.mock import patch,Mock
spec=importlib.util.spec_from_file_location('dispatch_custody',Path(__file__).with_name('custody.py'))
module=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,{'pykeepass':types.SimpleNamespace(PyKeePass=object,create_database=object)}):spec.loader.exec_module(module)
sys.modules[spec.name]=module
class DispatchTests(unittest.TestCase):
 def test_payment_bootstrap_has_only_fixed_epoch_preflight_or_explicit_sign(self):
  epoch='b'*32
  for name,execute in [('check-native-payment-bootstrap',False),('sign-native-payment-bootstrap',True)]:
   run=Mock()
   with patch.object(module,'source_module',return_value=types.SimpleNamespace(run=run)) as source:self.invoke([name,epoch])
   source.assert_called_once_with('native_payment_bootstrap');run.assert_called_once_with(module,epoch,execute=execute)
   for args in [[],[epoch,'extra']]:
    with self.subTest(name=name,args=args),self.assertRaises(module.CustodyError):self.invoke([name,*args])
 def test_financial_activation_fixed_epoch_preflight_and_explicit_signing(self):
  epoch='a'*32
  for name,execute in [('check-native-financial-activation',False),('sign-native-financial-activation',True)]:
   run=Mock()
   with patch.object(module,'source_module',return_value=types.SimpleNamespace(run=run)) as source:self.invoke([name,epoch])
   source.assert_called_once_with('native_financial_activation');run.assert_called_once_with(module,epoch,execute=execute)
   for args in [[],[epoch,'extra']]:
    with self.subTest(name=name,args=args),self.assertRaises(module.CustodyError):self.invoke([name,*args])
 def invoke(self,args):
  with patch.object(sys,'argv',['custody',*args]),patch.object(module.os,'geteuid',return_value=0):module.main()
 def test_automatic_admission_accepts_only_fixed_root_policy(self):
  run=Mock()
  with patch.object(module,'source_module',return_value=types.SimpleNamespace(run=run)) as source:self.invoke(['auto-native-admission'])
  source.assert_called_once_with('native_admission');run.assert_called_once_with(module)
  for args in [['auto-native-admission','/untrusted/policy.json'],['auto-native-admission','member']]:
   with self.subTest(args=args),self.assertRaises(module.CustodyError):self.invoke(args)
 def test_admission_preflight_has_no_caller_target_or_key_output(self):
  check=Mock()
  with patch.object(module,'source_module',return_value=types.SimpleNamespace(check_policy=check)) as source:self.invoke(['check-native-admission'])
  source.assert_called_once_with('native_admission');check.assert_called_once_with(module)
  with self.assertRaises(module.CustodyError):self.invoke(['check-native-admission','/untrusted/policy.json'])
 def test_backup_dispatch_passes_only_exact_public_approval(self):
  run=Mock()
  with patch.object(module,'source_module',return_value=types.SimpleNamespace(run_approved=run)):self.invoke(['backup-sql-cutoff','/var/lib/uain-custody/sql-cutoff/approval.json'])
  run.assert_called_once_with(module,'/var/lib/uain-custody/sql-cutoff/approval.json')
 def test_probe_dispatch_has_no_caller_object_or_endpoint(self):
  run=Mock()
  with patch.object(module,'source_module',return_value=types.SimpleNamespace(run=run)):self.invoke(['probe-spaces-conditional'])
  run.assert_called_once_with(module)
 def test_extra_or_missing_arguments_are_refused(self):
  for args in [['backup-sql-cutoff'],['backup-sql-cutoff','a','b'],['probe-spaces-conditional','untrusted-object']]:
   with self.subTest(args=args),self.assertRaises(module.CustodyError):self.invoke(args)
 def test_new_helper_executes_reviewed_source_despite_valid_forged_cache(self):
  with tempfile.TemporaryDirectory(dir=os.environ.get('UAIN_TEST_CUSTODY_FIXTURE_ROOT',str(Path(__file__).parent))) as d:
   directory=Path(d);source=directory/'sql_cutoff.py';source.write_text("def run_approved(custody,path): custody.fixture_result='reviewed-source'\n");source.chmod(0o600);marker=directory/'cache-executed';cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir(mode=0o700);info=source.stat()
   forged="open("+repr(str(marker))+",'w').write('bad')\ndef run_approved(custody,path): custody.fixture_result='cached-code'\n"
   cache.write_bytes(importlib.util.MAGIC_NUMBER+struct.pack('<III',0,int(info.st_mtime),info.st_size)+marshal.dumps(compile(forged,str(source),'exec')))
   with patch.dict(sys.modules),patch.object(sys,'path',[d,*sys.path]),patch.object(module,'__file__',str(directory/'custody.py')):
    sys.modules.pop('sql_cutoff',None);self.invoke(['backup-sql-cutoff','/fictional/approval.json'])
   self.assertFalse(marker.exists());self.assertEqual(module.fixture_result,'reviewed-source')
 def test_new_helper_refuses_unprotected_redirected_or_oversized_source(self):
  with tempfile.TemporaryDirectory(dir=os.environ.get('UAIN_TEST_CUSTODY_FIXTURE_ROOT',str(Path(__file__).parent))) as d:
   directory=Path(d);source=directory/'spaces_probe.py';source.write_text('VALUE=1\n');source.chmod(0o600)
   with patch.object(module,'__file__',str(directory/'custody.py')):
    with self.assertRaises(module.CustodyError):module.source_module('arbitrary')
    source.chmod(0o666)
    with self.assertRaises(module.CustodyError):module.source_module('spaces_probe')
    source.chmod(0o600);saved=source.with_suffix('.retained');source.rename(saved);source.symlink_to(saved)
    with self.assertRaises(module.CustodyError):module.source_module('spaces_probe')
    source.unlink();saved.rename(source);directory.chmod(0o777)
    with self.assertRaises(module.CustodyError):module.source_module('spaces_probe')
    directory.chmod(0o700);source.write_bytes(b'#'*(512*1024+1))
    with self.assertRaises(module.CustodyError):module.source_module('spaces_probe')
 def test_factory_preserves_fixed_provider_and_passes_bounded_config(self):
  factory=Mock();config=object();fake={'UAIN_STORAGE_ACCESS_KEY_ID':b'fictional-id','UAIN_STORAGE_SECRET_ACCESS_KEY':b'fictional-secret'}
  with patch.dict(sys.modules,{'boto3':types.SimpleNamespace(client=factory)}),patch.object(module,'kubernetes_secret',return_value=fake):
   module.s3(config=config);self.assertIs(factory.call_args.kwargs['config'],config);self.assertEqual(factory.call_args.kwargs['endpoint_url'],'https://nyc3.digitaloceanspaces.com');self.assertEqual(factory.call_args.kwargs['region_name'],'nyc3')
   module.s3();self.assertNotIn('config',factory.call_args.kwargs)
if __name__=='__main__':unittest.main()
