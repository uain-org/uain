import copy
import datetime
import importlib.util
from pathlib import Path
import unittest
import os,json,tempfile,importlib._bootstrap_external,sys
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('central_launch',Path(__file__).with_name('central_launch.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LaunchTest(unittest.TestCase):
 def setUp(self):
  self.now=1793881200
  self.plan=dict(schema='uain-central-launch-v1',chain_id=m.CHAIN,genesis_sha256=m.GENESIS,reviewer=m.REVIEWER,
   project=m.PROJECT,task=m.TASK,title='Audit earned service integrity',criteria='Establish the stated bounded safety property using retained reproducible evidence.',
   prior_art=dict(basis='The frozen implementation has no published analysis of this precise unresolved obligation.',searches=['Search frozen implementation and existing regression suite','Search maintained research and prior-art records']),
   eligibility='unresolved',solver_amount='1000000',reviewer_amount='100000',evidence_digest='a'*64,expires_at=self.now+600)
  self.state=dict(chain_id=m.CHAIN,height='100',header_time=datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat(),event_count='20',app_hash='b'*64,
   member=dict(id=m.GUARDIAN,public_key=m.PUBLIC,licence='active',sequence='7',creator=True),records={
    'guardians':[m.GUARDIAN],'guardian_epoch_current':None,'member/'+m.REVIEWER:dict(id=m.REVIEWER,licence='active'),
    'coin_activation':dict(policy='verified-bounties-108t-micro-v1',height='2'),
    'coin_supply':dict(minted='0',reserved='0',transparent='0',shielded='0'),
    'central_earning_activation':None,'project/'+m.PROJECT:None,'central_project_budget/'+m.PROJECT:None,'central_task/'+m.TASK:None, 'central_fund_config/'+m.PROJECT:None,'central_fund_state/'+m.PROJECT:None,'central_fund_plan/'+m.PROJECT+'/00000000000000000001':None})
 def test_activation_is_fixed_and_never_mints(self):
  c=m.command(self.plan,self.state,'activate',now=self.now)
  self.assertEqual(c['member'],m.GUARDIAN);self.assertEqual(c['operation'],'central_earning_activate')
  self.assertEqual(c['payload'],dict(policy=m.POLICY,reviewer=m.REVIEWER,evidence_digest='a'*64))
  self.assertEqual(c['sequence'],'7');self.assertEqual(c['expires_height'],'200')
 def test_rejects_expired_stale_or_unlicensed_context(self):
  for change in ('expiry','stale','reviewer','guardian','genesis','extra'):
   p=copy.deepcopy(self.plan);s=copy.deepcopy(self.state)
   if change=='expiry':p['expires_at']=self.now
   if change=='stale':s['header_time']='2020-01-01T00:00:00Z'
   if change=='reviewer':s['records']['member/'+m.REVIEWER]['licence']='revoked'
   if change=='guardian':s['member']['sequence']='-1'
   if change=='genesis':p['genesis_sha256']='f'*64
   if change=='extra':p['mint']=True
   with self.subTest(change=change),self.assertRaises(ValueError):m.command(p,s,'activate',now=self.now)
 def test_refuses_duplicate_activation_and_unactivated_launch(self):
  self.state['records']['central_earning_activation']={'policy':m.POLICY,'reviewer':m.REVIEWER,'height':'2'}
  with self.assertRaises(ValueError):m.command(self.plan,self.state,'activate',now=self.now)
  self.state['records']['central_earning_activation']=None
  for stage in ('project','budget','task'):
   with self.subTest(stage=stage),self.assertRaises(ValueError):m.command(self.plan,self.state,stage,now=self.now)
 def test_requires_owned_project_and_fresh_budget_for_task(self):
  r=self.state['records'];r['central_earning_activation']=dict(policy=m.POLICY,reviewer=m.REVIEWER,height='2')
  p=m.command(self.plan,self.state,'project',now=self.now);self.assertEqual(p['operation'],'open_project')
  r['project/'+m.PROJECT]=dict(id=m.PROJECT,lead=m.GUARDIAN,state='active',safety_halted=False)
  b=m.command(self.plan,self.state,'budget',now=self.now);self.assertEqual(b['operation'],'central_project_start')
  with self.assertRaises(ValueError):m.command(self.plan,self.state,'task',now=self.now)
  r['central_project_budget/'+m.PROJECT]=dict(project=m.PROJECT,manager=m.GUARDIAN,policy=m.POLICY,allocation='10000000000',lifetime_ceiling='1000000000000000',round=1,height='2',evidence_digest='a'*64,reserved='0',paid='0')
  # Opening allowance cannot publish a paid task before independent plan approval.
  with self.assertRaises(ValueError):m.command(self.plan,self.state,'task',now=self.now)
  r['central_fund_config/'+m.PROJECT]=dict(project=m.PROJECT,evaluator=m.REVIEWER)
  r['central_fund_state/'+m.PROJECT]=dict(revision=1,approved_revision=1,pending='',completed=0)
  r['central_fund_plan/'+m.PROJECT+'/00000000000000000001']=dict(project=m.PROJECT,manager=m.GUARDIAN,revision=1,state='accept',reviewer=m.REVIEWER,main_kpi='Independently verify a genuine earned peer service transaction.',stages=[dict(round=n,criteria='Measurable verified evidence for milestone '+str(n)) for n in range(1,6)])
  t=m.command(self.plan,self.state,'task',now=self.now);self.assertEqual(t['operation'],'central_task_open')
  self.assertEqual(t['payload']['solver_amount'],'1000000');self.assertEqual(t['payload']['acceptance_digest'],m.sha(self.plan['criteria'].encode()))
  # Stale, self-approved or malformed plans cannot pass the launch preflight.
  state_key='central_fund_state/'+m.PROJECT;plan_key='central_fund_plan/'+m.PROJECT+'/00000000000000000001';config_key='central_fund_config/'+m.PROJECT
  for key,changes in [(state_key,{'approved_revision':0}),(state_key,{'approved_revision':True}),(state_key,{'revision':2}),(state_key,{'completed':1}),(config_key,{'evaluator':m.GUARDIAN}),(plan_key,{'reviewer':m.GUARDIAN}),(plan_key,{'state':'proposed'}),(plan_key,{'main_kpi':''}),(plan_key,{'stages':[]})]:
   before=copy.deepcopy(r[key]);r[key].update(changes)
   with self.subTest(key=key,changes=changes),self.assertRaises(ValueError):m.command(self.plan,self.state,'task',now=self.now)
   r[key]=before
  r['central_task/'+m.TASK]={'id':m.TASK}
  with self.assertRaises(ValueError):m.command(self.plan,self.state,'task',now=self.now)
 def test_rejects_reward_above_small_launch_cap_or_invalid_terms(self):
  for key,value in [('solver_amount','1000001'),('reviewer_amount','100001'),('solver_amount','0'),('solver_amount',1),('criteria',''),('eligibility','easy'),('task','another-task'),('reviewer',m.GUARDIAN)]:
   p=dict(self.plan,**{key:value})
   with self.subTest(key=key,value=value),self.assertRaises(ValueError):m.command(p,self.state,'activate',now=self.now)
 def test_exact_receipt_only(self):
  c=m.command(self.plan,self.state,'activate',now=self.now)
  e=dict(operation=c['operation'],member=c['member'],subject=m.POLICY,command_digest=m.sha(m.native.signing_bytes(c)))
  self.assertTrue(m.matches(e,c));self.assertFalse(m.matches(dict(e,subject='wrong'),c));self.assertFalse(m.matches(dict(e,instance='borrowed'),c))
 def runtime_fixture(self):
  outer=self
  class Runtime:
   broadcasts=0
   envelope=None
   def read(self,selection):
    s=copy.deepcopy(outer.state)
    if self.envelope:
     c=self.envelope['command'];e=dict(id='21',height='101',member=m.GUARDIAN,operation=c['operation'],subject=m.subject(c),command_digest=m.sha(m.native.signing_bytes(c)))
     s.update(event_count='21',height='102');s['member']['sequence']='8';s['records'][m.admission.event_key(21)]=e
     if 'receipt' in selection:s['receipt']=dict(authority='native',finalized=True,chain_id=m.CHAIN,state_height=s['height'],app_hash=s['app_hash'],event=e)
    return s
   def broadcast(self,envelope):self.broadcasts+=1;self.envelope=envelope;raise TimeoutError('ambiguous after native acceptance')
  return Runtime()
 def test_ambiguous_accepted_send_recovers_receipt_and_never_resends_after_expiry(self):
  runtime=self.runtime_fixture();disk={};signs=[]
  def write(path,v):disk[path]=copy.deepcopy(v)
  def sign(c):signs.append(c);return dict(command=c,public_key=m.PUBLIC,signature='fixture-only')
  with patch.object(m.admission,'verify_envelope'):
   result=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,sign,now=lambda:self.now)
   self.assertEqual(result['status'],'finalized');self.assertEqual(runtime.broadcasts,1)
   result=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,sign,now=lambda:self.now+10000)
   self.assertEqual(result['status'],'finalized');self.assertEqual(runtime.broadcasts,1);self.assertEqual(len(signs),1)
 def test_crash_after_send_marker_keeps_unknown_without_automatic_broadcast(self):
  runtime=self.runtime_fixture();disk={};crashed=False
  def write(path,v):
   nonlocal crashed
   disk[path]=copy.deepcopy(v)
   if v.get('attempted') and not crashed:crashed=True;raise OSError('durable marker succeeded but caller lost acknowledgement')
  def sign(c):return dict(command=c,public_key=m.PUBLIC,signature='fixture-only')
  with patch.object(m.admission,'verify_envelope'):
   with self.assertRaises(OSError):m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,sign,now=lambda:self.now)
   self.assertEqual(runtime.broadcasts,0)
   result=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now+10000)
   self.assertEqual(result['status'],'pending');self.assertEqual(runtime.broadcasts,0)
 def test_changed_scope_cannot_reuse_a_signed_journal(self):
  runtime=self.runtime_fixture();disk={}
  def write(path,v):disk[path]=copy.deepcopy(v)
  with patch.object(m.admission,'verify_envelope'):
   m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:dict(command=c,public_key=m.PUBLIC,signature='fixture-only'),now=lambda:self.now)
   with self.assertRaises(ValueError):m.process(dict(self.plan,criteria=self.plan['criteria']+' changed'),'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now)

 def test_native_runtime_policy_binds_original_reader_and_genesis(self):
  p=dict(chain_id=m.CHAIN,genesis_sha256=m.GENESIS,state_sha256=m.READER_SHA,guardian=m.GUARDIAN,guardian_public_key=m.PUBLIC)
  self.assertEqual(m.proof_policy(p),p)
  for k in ('chain_id','genesis_sha256','state_sha256','guardian','guardian_public_key'):
   with self.subTest(field=k),self.assertRaises(ValueError):m.proof_policy(dict(p,**{k:'wrong'}))
 def test_expired_unknown_send_closes_only_after_all_events_scanned(self):
  runtime=self.runtime_fixture();disk={}
  def write(path,v):disk[path]=copy.deepcopy(v)
  c=m.command(self.plan,self.state,'activate',now=self.now)
  envelope=dict(command=c,public_key=m.PUBLIC,signature='fixture-only')
  path=m.ROOT/'activate.json';disk[path]=dict(schema='uain-central-launch-send-once-v1',stage='activate',plan_digest=m.sha(m.native.canonical({k:v for k,v in self.plan.items() if k!='expires_at'}).encode()),envelope=envelope,after_event='20',cursor='20',attempted=True)
  self.state.update(height='201',event_count='40')
  for n in range(21,41):self.state['records'][m.admission.event_key(n)]=dict(id=str(n),command_digest='c'*64)
  with patch.object(m.admission,'verify_envelope'):
   one=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now+10000)
   self.assertEqual(one['status'],'pending')
   two=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now+10000)
   self.assertEqual(two['status'],'expired_not_included');self.assertEqual(runtime.broadcasts,0)
   self.assertEqual(two['evidence']['through_event'],'40');self.assertEqual(two['evidence']['height'],'201')
   self.assertEqual(two['evidence']['command_digest'],m.sha(m.native.signing_bytes(c)))
   three=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now+10000)
   self.assertEqual(two,three)
 def test_expired_before_send_is_scanned_and_never_broadcast(self):
  runtime=self.runtime_fixture();disk={};crashed=False
  def write(path,v):
   nonlocal crashed
   disk[path]=copy.deepcopy(v)
   if not crashed:crashed=True;raise OSError('lost acknowledgement of signed journal')
  with patch.object(m.admission,'verify_envelope'):
   with self.assertRaises(OSError):m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:dict(command=c,public_key=m.PUBLIC,signature='fixture-only'),now=lambda:self.now)
   self.state['height']='201'
   result=m.process(self.plan,'activate',runtime,lambda p:copy.deepcopy(disk.get(p)),write,lambda c:self.fail('re-sign'),now=lambda:self.now+10000)
   self.assertEqual(result['status'],'expired_not_included');self.assertEqual(runtime.broadcasts,0)
 def test_core_dumps_disabled_before_run(self):
  with patch.object(m.resource,'setrlimit') as limit:
   m.disable_core();limit.assert_called_once_with(m.resource.RLIMIT_CORE,(0,0))

@unittest.skipUnless(os.geteuid()==0,'protected source bootstrap needs disposable root-owned scope')
class BootstrapTest(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.root=Path(self.tmp.name)
  self.manifest=self.root/'sources.json'
  for name in m.SOURCE_NAMES:(self.root/(name+'.py')).write_text("VALUE='reviewed source'\n")
  self.approve()
 def tearDown(self):self.tmp.cleanup()
 def approve(self):
  self.manifest.write_text(json.dumps(dict(schema='uain-central-launch-sources-v1',sha256={n+'.py':m.sha((self.root/(n+'.py')).read_bytes()) for n in m.SOURCE_NAMES})))
 def test_pinned_sources_ignore_forged_valid_timestamp_bytecode(self):
  source=self.root/'native_migration.py';metadata=source.stat();cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir()
  cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(compile("raise RuntimeError('FORGED BYTECODE EXECUTED')",str(source),'exec'),int(metadata.st_mtime),metadata.st_size))
  with patch.dict(sys.modules):
   m.bootstrap_sources(self.root,self.manifest)
   self.assertEqual(sys.modules['native_migration'].VALUE,'reviewed source')
 def test_wrong_hash_or_redirect_refused_before_any_source_execution(self):
  (self.root/'native_migration.py').write_text("raise RuntimeError('UNREVIEWED SOURCE EXECUTED')\n")
  with patch.dict(sys.modules),self.assertRaisesRegex(ValueError,'Pinned central launch source refused'):m.bootstrap_sources(self.root,self.manifest)
  self.approve();source=self.root/'custody.py';source.unlink();source.symlink_to(self.root/'native_migration.py')
  with self.assertRaisesRegex(ValueError,'Pinned central launch source refused'):m.bootstrap_sources(self.root,self.manifest)
 def test_missing_extra_and_duplicate_manifest_fields_refused(self):
  for value in (dict(schema='uain-central-launch-sources-v1',sha256={}),dict(schema='uain-central-launch-sources-v1',sha256={},extra=True)):
   self.manifest.write_text(json.dumps(value))
   with self.assertRaises(ValueError):m.bootstrap_sources(self.root,self.manifest)
  self.manifest.write_text('{"schema":"x","schema":"x","sha256":{}}')
  with self.assertRaises(ValueError):m.bootstrap_sources(self.root,self.manifest)



class LaunchBudgetProvenanceTest(unittest.TestCase):
 setUp=LaunchTest.setUp
 def test_task_requires_exact_native_round_integer_and_opening_proof(self):
  for field,value in [('round',True),('round','1'),('height','101'),('height','0'),('evidence_digest','bad')]:
   s=copy.deepcopy(self.state);r=s['records'];r['central_earning_activation']=dict(policy=m.POLICY,reviewer=m.REVIEWER,height='2');r['project/'+m.PROJECT]=dict(id=m.PROJECT,lead=m.GUARDIAN,state='active',safety_halted=False);b=dict(project=m.PROJECT,manager=m.GUARDIAN,policy=m.POLICY,allocation='10000000000',lifetime_ceiling='1000000000000000',round=1,height='2',evidence_digest='a'*64,reserved='0',paid='0');b[field]=value;r['central_project_budget/'+m.PROJECT]=b
   with self.subTest(field=field,value=value),self.assertRaises(ValueError):m.command(self.plan,s,'task',now=self.now)

if __name__=='__main__':unittest.main()
