import copy,json,os,sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import sql_cutoff as m
class Contracts(unittest.TestCase):
 def approval(self):
  return {'schema':'uain-sql-cutoff-approval-v1','epoch':'20261012_010203','source_revision':'a'*40,'source_root':'/opt/reviewed','source_files':{name:'a'*64 for name in m.SOURCE_FILES},'pilot_image':'10.98.0.1:5000/uain/pilot@sha256:'+'b'*64,'postgres_image':m.POSTGRES,'backup_cli_sha256':'c'*64,'ledger_public_key':'PUBLIC PEM','guardian':'uain1'+'d'*40,'public_policy':{'version':1,'daily_credit_cap':'10000','bootstrap_operators':3},'source_manifest_digest':'e'*64,'records_root':'f'*64,'stopped_units':['uain-owned-reviewer.service'],'expires_at':int(time.time())+300}
 def test_approval_exact_expiring_and_pinned(self):
  v=self.approval();m.validate_approval(v)
  for key,value in [('pilot_image','image:latest'),('postgres_image','postgres:17'),('source_root','/tmp/unreviewed'),('source_revision','a'*39),('expires_at',int(time.time())-1),('expires_at',int(time.time())+4000),('stopped_units',['other.service']),('schema','other')]:
   bad=copy.deepcopy(v);bad[key]=value
   with self.assertRaises(ValueError):m.validate_approval(bad)
  v['extra']=True
  with self.assertRaises(ValueError):m.validate_approval(v)
 def test_full_census_sequence_ahead_and_extra_table_are_refused(self):
  v={'tables':{'events':{'count':1,'sha256':'a'*64}},'sequences':[{'sequencename':'events_id_seq','last_value':'7'}]}
  m.exact_snapshot(v,copy.deepcopy(v))
  for change in [lambda b:b['tables'].update(extra={'count':0,'sha256':'b'*64}),lambda b:b['tables']['events'].update(sha256='c'*64),lambda b:b['sequences'][0].update(last_value='8'),lambda b:b['sequences'].clear()]:
   b=copy.deepcopy(v);change(b)
   with self.assertRaises(ValueError):m.exact_snapshot(v,b)
 def test_physical_unused_sequence_differs_despite_null_catalog(self):
  v={'full':{'tables':{},'sequences':[{'sequencename':'unused','last_value':None}]},'sequence_state':[{'sequencename':'unused','last_value':'1','is_called':False}]}
  m.exact_cutoff(v,copy.deepcopy(v))
  for change in [lambda b:b['sequence_state'][0].update(last_value='73'),lambda b:b['sequence_state'][0].update(is_called=True),lambda b:b['sequence_state'].clear()]:
   b=copy.deepcopy(v);change(b)
   self.assertEqual(v['full'],b['full'])
   with self.assertRaises(ValueError):m.exact_cutoff(v,b)
 def test_standalone_pod_no_server_and_secret_mount_readonly(self):
  pod=m.sealer_pod(self.approval(),'uain-cutoff-abcdef')
  c=pod['spec']['containers'][0]
  self.assertEqual(c['command'],['node','-e','setInterval(()=>{},1000)'])
  self.assertIn({'name':'UAIN_AUTHORITY','value':'native'},c['env'])
  self.assertFalse(pod['spec']['automountServiceAccountToken'])
  self.assertFalse(pod['spec'].get('hostNetwork',False))
  self.assertTrue(all(v['readOnly'] for v in c['volumeMounts']))
  self.assertFalse(c.get('ports'));self.assertEqual(c['resources']['limits']['cpu'],'2')
 def test_restore_container_private_tmpfs_and_bounded(self):
  cmd=m.restore_container(self.approval(),'uain-cutoff-test','uain-cutoff-network')
  self.assertIn('--read-only',cmd);self.assertIn('--internal',m.network_command('uain-cutoff-network'))
  self.assertNotIn('--publish',cmd);self.assertNotIn('-p',cmd)
  self.assertIn('--pids-limit=256',cmd);self.assertIn('--memory=2g',cmd)
  self.assertTrue(any('/var/lib/postgresql/data:' in x and 'size=2g' in x for x in cmd))
 def test_plaintext_cli_commands_are_fixed(self):
  v=self.approval()
  for command in ['seal','verify','dump','compare']:self.assertIn(command,m.cli_command('uain-cutoff-test',command,'x.uainbk' if command=='verify' else None))
  for command in ['files','server','../dump']:
   with self.assertRaises(ValueError):m.cli_command('uain-cutoff-test',command)
 def test_bounded_reader_and_duplicate_json_refused(self):
  import io
  self.assertEqual(m.bounded(io.BytesIO(b'1234'),4),b'1234')
  with self.assertRaises(ValueError):m.bounded(io.BytesIO(b'12345'),4)
  with self.assertRaises(ValueError):m.strict_json(b'{"schema":1,"schema":2}')
 def test_valid_backup_key_requires_verified_vault_inventory_first(self):
  from types import SimpleNamespace
  calls=[];kp=object();key=b'1'*64
  def vault():calls.append('vault');return kp
  def verify(value):self.assertIs(value,kp);calls.append('verify')
  def attachment(value,name):self.assertIs(value,kp);self.assertEqual(name,'keys/backup-key.txt');self.assertEqual(calls,['vault','verify']);calls.append('attachment');return key
  custody=SimpleNamespace(vault=vault,verify_vault=verify,attachment=attachment)
  self.assertEqual(m.backup_key(custody),key);self.assertEqual(calls,['vault','verify','attachment'])
  calls.clear()
  def refuse(value):calls.append('verify');raise ValueError('Fictional inventory mismatch')
  custody.verify_vault=refuse
  with self.assertRaises(ValueError):m.backup_key(custody)
  self.assertEqual(calls,['vault','verify'])
 def test_root_file_rejects_symlink_and_public_permissions(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'approval';p.write_bytes(b'{}');p.chmod(0o600)
   if os.geteuid()==0:self.assertEqual(m.protected_read(p),b'{}')
   p.chmod(0o644)
   with self.assertRaises(ValueError):m.protected_read(p)
   q=Path(t)/'link';q.symlink_to(p)
   with self.assertRaises((ValueError,OSError)):m.protected_read(q)
if __name__=='__main__':unittest.main()
