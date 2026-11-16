import unittest,datetime,copy,tempfile,json,base64,hashlib,contextlib,os,stat,sys,importlib.util,importlib._bootstrap_external
from pathlib import Path
from unittest.mock import patch
try:import central_fund_manager as f
except ModuleNotFoundError:f=None
class FundTests(unittest.TestCase):
 def setUp(self):self.assertIsNotNone(f,'dedicated Fund Manager custody implementation is missing')
 def fixture(self):
  seed=hashlib.sha256(b'FICTIONAL fund manager fixture').digest();pub,_=f.native.ed25519(seed);member='uain1'+hashlib.sha256(pub).hexdigest()[:40]
  i=dict(schema='uain-central-fund-manager-identity-v1',chain_id=f.CHAIN,genesis_sha256=f.GENESIS,member=member,public_key=f.b64(pub),name='UAIN Independent Fund Manager',operator='United AI Network (Rahul Jalan)',family='Independent Fund Manager')
  p=dict(schema='uain-bounded-fund-plan-v1',chain_id=f.CHAIN,genesis_sha256=f.GENESIS,project='P-service-integrity-20261105',manager=f.GUARDIAN,fund_manager=member,main_kpi='Demonstrate independently verified original service integrity research.',stages=[dict(round=n,criteria='Measure and retain independent evidence for stage '+str(n)) for n in range(1,6)],reason='Independent decomposition aligned to the fixed Main KPI.',model_execution=dict(execution_id='fm-fixture',input_sha256='a'*64,output_sha256='b'*64),evidence_digest='c'*64,review_digest='d'*64,expires_at=int(__import__('time').time())+1200)
  r={'guardians':[f.GUARDIAN],'guardian_epoch_current':None,'central_earning_activation':dict(policy=f.POLICY,reviewer=f.RESEARCH_REVIEWER,height='2'),'central_project_budget/'+p['project']:dict(project=p['project'],manager=f.GUARDIAN,policy=f.POLICY,round=1,allocation='10000000000',lifetime_ceiling='1000000000000000',reserved='0',paid='0',height='2',evidence_digest='f'*64),'project/'+p['project']:dict(id=p['project'],lead=f.GUARDIAN,state='active',safety_halted=False),'central_fund_config/'+p['project']:dict(project=p['project'],evaluator=member),'central_fund_state/'+p['project']:None,'central_fund_plan/'+p['project']+'/00000000000000000001':None,'member/'+member:dict(id=member,public_key=i['public_key'],licence='active',sequence='4')}
  s=dict(chain_id=f.CHAIN,height='100',event_count='0',header_time=datetime.datetime.now(datetime.timezone.utc).isoformat(),app_hash='e'*64,member=r['member/'+member],records=r)
  return i,p,s,seed
 def test_plan_exact_main_five_stages_and_no_funding_operations(self):
  i,p,s,_=self.fixture();c=f.command(i,p,s,'plan');self.assertEqual(c['operation'],'central_fund_plan');self.assertEqual(c['payload']['revision'],1);self.assertEqual(c['payload']['main_kpi'],p['main_kpi']);self.assertEqual(len(c['payload']['stages']),5)
  with self.assertRaises(ValueError):f.command(i,p,s,'release')
 def test_plan_review_requires_identical_proposed_native_plan(self):
  i,p,s,_=self.fixture();c=f.command(i,p,s,'plan');s['records']['central_fund_state/'+p['project']]=dict(revision=1,approved_revision=0,pending='',completed=0);s['records']['central_fund_plan/'+p['project']+'/00000000000000000001']={**c['payload'], 'manager':p['manager'],'state':'proposed','reviewer':''}
  a=f.command(i,p,s,'approve');self.assertEqual(a['payload']['verdict'],'accept');self.assertEqual(a['payload']['evidence_digest'],'d'*64)
  s['records']['central_fund_plan/'+p['project']+'/00000000000000000001']['main_kpi']='A replaced goal which is not authorized.'
  with self.assertRaises(ValueError):f.command(i,p,s,'approve')
 def test_wrong_role_stale_proof_old_budget_and_partial_plan_refused(self):
  mutations=[lambda i,p,s:p.update(stages=p['stages'][:4]),lambda i,p,s:p.update(fund_manager=p['manager']),lambda i,p,s:s.update(header_time='2020-01-01T00:00:00+00:00'),lambda i,p,s:s['records']['central_project_budget/'+p['project']].update(policy='old-policy'),lambda i,p,s:s['records']['central_fund_config/'+p['project']].update(evaluator=f.GUARDIAN),lambda i,p,s:p.update(unreviewed='extra'),lambda i,p,s:p['stages'][0].update(round=True),lambda i,p,s:s['member'].update(licence='revoked')]
  for mutate in mutations:
   i,p,s,_=self.fixture();mutate(i,p,s)
   with self.assertRaises(ValueError):f.command(i,p,s,'plan')
 def test_enrol_and_signer_use_only_dedicated_key(self):
  i,p,s,seed=self.fixture();s['records']['member/'+i['member']]=None
  c=f.enrol_command(i,s);self.assertEqual(c['operation'],'enrol');self.assertEqual(c['payload']['name'],'UAIN Independent Fund Manager')
  class Custody:
   def vault(self):return None
   def attachment(self,v,key):
    if key!='keys/central-fund-manager.json':raise AssertionError('wrong identity')
    return json.dumps(dict(schema='uain-central-fund-manager-key-v1',private_key=f.b64(seed),public_key=i['public_key'],created_at=1)).encode()
  with patch.object(f.os,'geteuid',return_value=0):
   e=f.sign(Custody(),c,i);self.assertEqual(e['public_key'],i['public_key'])
   with self.assertRaises(ValueError):f.sign(Custody(),{**c,'operation':'central_fund_decide'},i)
 def test_plan_stage_preserves_real_authority_file_and_existing_stage_journals(self):
  import native_admission as a
  i,p,state,seed=self.fixture();broadcasts=[];signed=[]
  class Runtime:
   def read(self,selection):return copy.deepcopy(state)
   def broadcast(self,envelope):broadcasts.append(envelope);return 0
  def signer(command):
   signed.append(command);pub,sign=f.native.ed25519(seed)
   return dict(command=command,public_key=f.b64(pub),signature=f.b64(sign(f.native.signing_bytes(command))))
  with tempfile.TemporaryDirectory() as folder,patch.object(f,'ROOT',Path(folder)):
   root=Path(folder);a.atomic(root/'plan.json',p)
   for name in ('enrol.json','configure.json'):a.atomic(root/name,dict(schema='FICTIONAL retained existing stage journal',stage=name))
   retained={name:(root/name).read_bytes() for name in ('plan.json','enrol.json','configure.json')}
   load=lambda path:json.loads(path.read_bytes()) if path.exists() else None
   result=f.process(i,p,'plan',Runtime(),load,a.atomic,signer)
   self.assertEqual(result['status'],'pending');self.assertEqual(len(signed),1);self.assertEqual(len(broadcasts),1)
   self.assertEqual(retained,{name:(root/name).read_bytes() for name in retained})
   journals=[path for path in root.iterdir() if path.name not in retained];self.assertEqual(len(journals),1)
   journal=json.loads(journals[0].read_bytes());self.assertEqual(journal['schema'],'uain-central-fund-send-once-v1');self.assertEqual(journal['stage'],'plan');self.assertEqual(journal['envelope']['command']['operation'],'central_fund_plan');self.assertIs(journal['attempted'],True)
   f.process(i,p,'plan',Runtime(),load,a.atomic,lambda command:self.fail('Retained plan command was signed again'))
   self.assertEqual(len(broadcasts),1);self.assertEqual(retained,{name:(root/name).read_bytes() for name in retained})
 def test_lost_send_reconciles_without_resign_or_rebroadcast(self):
  import native_admission as a
  i,p,s,seed=self.fixture();seen=[];visible=False
  class Runtime:
   def read(self,select):
    state=copy.deepcopy(s)
    if visible:
     c=seen[0]['command'];event=dict(id='1',operation='central_fund_plan',member=i['member'],subject=p['project'],command_digest=f.sha(f.native.signing_bytes(c)))
     state.update(height='101',event_count='1');state['member']['sequence']='5';state['records']['event/00000000000000000001']=event
     if 'receipt' in select:state['receipt']=dict(authority='native',finalized=True,chain_id=f.CHAIN,state_height='101',app_hash='e'*64,event=event)
    return state
   def broadcast(self,e):seen.append(e);raise OSError('lost reply')
  def signer(c):
   pub,sign=f.native.ed25519(seed);return dict(command=c,public_key=f.b64(pub),signature=f.b64(sign(f.native.signing_bytes(c))))
  with tempfile.TemporaryDirectory() as d,patch.object(f,'ROOT',Path(d)):
   load=lambda path:json.loads(path.read_bytes()) if path.exists() else None
   result=f.process(i,p,'plan',Runtime(),load,a.atomic,signer);self.assertEqual(result['status'],'pending');visible=True
   result=f.process(i,p,'plan',Runtime(),load,a.atomic,lambda c:self.fail('signed twice'));self.assertEqual(result['status'],'finalized');self.assertEqual(len(seen),1)
   f.process(i,p,'plan',Runtime(),load,a.atomic,lambda c:self.fail('signed thrice'));self.assertEqual(len(seen),1)

class ReportTests(unittest.TestCase):
 fixture=FundTests.fixture
 def test_custody_requires_exact_public_model_report_and_independent_plan_review(self):
  i,p,state,_=self.fixture()
  objective=dict(schema='uain-fund-objective-v1',project=p['project'],main_kpi=p['main_kpi'],context='First bounded original research service project.')
  result=dict(main_kpi=p['main_kpi'],stages=p['stages'],reason=p['reason'])
  report=dict(schema='uain-fund-model-report-v1',execution_id='fm-fixture',input=objective,result=result)
  review=dict(schema='uain-fund-plan-review-v1',execution_id='review-fixture',report_digest=f.sha(f.native.canonical(report).encode()),verdict='accept',findings=['Five independent verifiable milestones retain the fixed goal.'])
  p['model_execution'].update(input_sha256=f.sha(f.native.canonical(objective).encode()),output_sha256=f.sha(f.native.canonical(result).encode()))
  p['evidence_digest']=f.sha(f.native.canonical(report).encode());p['review_digest']=f.sha(f.native.canonical(review).encode())
  f.bind_reports(p,objective,report,review)
  for mutate in [lambda:report['result'].update(main_kpi='Different ultimate objective.'),lambda:review.update(verdict='reject'),lambda:review.update(execution_id='fm-fixture')]:
   old=copy.deepcopy((objective,report,review));mutate()
   with self.assertRaises(ValueError):f.bind_reports(p,objective,report,review)
   objective,report,review=old

class ProvisionTests(unittest.TestCase):
 def fixture(self):
  import holder_release as h
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=Path(temporary.name);vault=root/'fixture.kdbx';vault.write_bytes(b'FICTIONAL encrypted vault original');files={'keys/existing-fixture.json':b'FICTIONAL existing attachment'};saves=[];backups=[];directories=[];real_fsync=os.fsync
  class FakeCustody:
   VAULT=vault
   def save_vault(self,new):files.clear();files.update(new);vault.write_bytes(b'FICTIONAL encrypted replacement'+hashlib.sha256(b''.join(new.values())).digest());saves.append(dict(new))
  c=FakeCustody()
  def current(_):return hashlib.sha256(vault.read_bytes()).hexdigest(),None,dict(files)
  def write(path,raw):Path(path).write_bytes(raw);Path(path).chmod(0o600)
  def backup(_c,digest):backups.append(digest);return 'f'*64
  def sync(fd):
   if stat.S_ISDIR(os.fstat(fd).st_mode):directories.append(os.fstat(fd).st_ino)
   real_fsync(fd)
  patches=[patch.object(f,'ROOT',root),patch.object(f,'locked',contextlib.nullcontext),patch.object(h,'current',current),patch.object(h,'read',lambda p,limit=0:Path(p).read_bytes()),patch.object(h,'write',write),patch.object(h,'backup_proof',backup),patch.object(f.os,'fsync',sync)]
  for q in patches:q.start();self.addCleanup(q.stop)
  return h,c,root,files,saves,backups,directories,current
 def test_provision_preserves_all_attachments_and_syncs_parent_before_publication(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture();before=current(c)[0];identity=f.provision(c,before);self.assertEqual(len(saves),1);self.assertEqual(files['keys/existing-fixture.json'],b'FICTIONAL existing attachment');self.assertEqual(set(files),{'keys/existing-fixture.json',f.KEY});self.assertEqual(len(backups),1);self.assertIn(root.stat().st_ino,dirs);self.assertEqual(identity['member'],'uain1'+f.sha(__import__('base64').urlsafe_b64decode(identity['public_key']+'='))[:40]);self.assertNotIn('private_key',identity);self.assertEqual((root/'identity.json').stat().st_mode&0o777,0o600)
 def test_failed_backup_never_publishes_identity_and_retry_keeps_original_key(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture()
  with patch.object(h,'backup_proof',side_effect=ValueError('FICTIONAL backup unavailable')):
   with self.assertRaises(ValueError):f.provision(c,current(c)[0])
  self.assertFalse((root/'identity.json').exists());retained=files[f.KEY];f.provision(c,current(c)[0]);self.assertEqual(files[f.KEY],retained);self.assertEqual(len(saves),1)
 def test_encrypted_vault_save_failure_cannot_publish_identity_or_lose_existing_attachments(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture();before=current(c)[0];existing=dict(files)
  with patch.object(c,'save_vault',side_effect=OSError('FICTIONAL encrypted save failed')):
   with self.assertRaises(OSError):f.provision(c,before)
  self.assertEqual(files,existing);self.assertEqual(current(c)[0],before);self.assertFalse((root/'identity.json').exists());self.assertEqual(backups,[])
  result=f.provision(c,before);self.assertNotIn('private_key',result);self.assertEqual(len(saves),1)
 def test_existing_mismatched_key_refuses_without_rotation_or_backup(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture();f.provision(c,current(c)[0]);broken=json.loads(files[f.KEY]);broken['public_key']='A'*43;files[f.KEY]=json.dumps(broken).encode();backups.clear()
  with self.assertRaises(ValueError):f.provision(c,current(c)[0])
  self.assertEqual(len(saves),1);self.assertEqual(backups,[])



class NativeContractTests(unittest.TestCase):
 fixture=FundTests.fixture
 def test_inactive_project_and_invalid_budget_provenance_refuse_before_signing(self):
  for change in [('project', 'state','closed'),('project','safety_halted',True),('central_project_budget','evidence_digest','invalid')]:
   i,p,s,_=self.fixture();prefix,field,value=change;s['records'][prefix+'/'+p['project']][field]=value
   with self.assertRaises(ValueError):f.command(i,p,s,'plan')
 def test_after_guardian_handover_plan_continues_and_configure_needs_quorum(self):
  # 2-of-3 handover (DEC-CHAIN-041): this identity is the manager/reviewer, no longer a guardian.
  i,p,s,_=self.fixture();s['records']['guardian_epoch_current']='quorum-1'
  self.assertEqual(f.command(i,p,s,'plan')['operation'],'central_fund_plan')
  s['member']=dict(id=f.GUARDIAN,public_key=f.PUBLIC,licence='active',sequence='9');s['records']['central_fund_config/'+p['project']]=None
  with self.assertRaises(ValueError):f.command(i,p,s,'configure')
  i,p,s,_=self.fixture();s['records']['guardians']=['uain1'+'0'*40]
  with self.assertRaises(ValueError):f.command(i,p,s,'plan')
 def test_guardian_configures_only_dedicated_fund_identity_for_fixed_project(self):
  i,p,s,_=self.fixture();s['member']=dict(id=f.GUARDIAN,public_key=f.PUBLIC,licence='active',sequence='9');s['records']['central_fund_config/'+p['project']]=None
  c=f.command(i,p,s,'configure');self.assertEqual(c['operation'],'central_fund_configure');self.assertEqual(c['member'],f.GUARDIAN);self.assertEqual(c['payload'],dict(project='P-service-integrity-20261105',evaluator=i['member'],expected_evaluator='',evidence_digest='c'*64))
  s['records']['central_fund_config/'+p['project']]=dict(project=p['project'],evaluator=i['member'])
  with self.assertRaises(ValueError):f.command(i,p,s,'configure')


 def handed_over(self,config=None):
  i,p,s,seed=self.fixture();r=s['records'];r['guardian_epoch_current']='1';r['guardians']=['uain1'+'7'*40,'uain1'+'8'*40,'uain1'+'9'*40]
  r['central_fund_config/'+p['project']]=config;return i,p,s
 def test_after_handover_configure_prepares_the_exact_quorum_proposal_and_signs_nothing(self):
  i,p,s=self.handed_over()
  with self.assertRaises(ValueError):f.command(i,p,s,'configure')
  out=f.configure_proposal(i,p,s);self.assertEqual(out['status'],'quorum_proposal_prepared')
  [action]=out['batch']['actions'];self.assertEqual(out['batch']['schema'],'uain-guardian-action-batch-v1')
  self.assertEqual(action,dict(operation='central_fund_configure',payload=dict(project=p['project'],evaluator=i['member'],expected_evaluator='',evidence_digest=p['evidence_digest']),rule='manifest',context={}))
  self.assertEqual(out['decision'],hashlib.sha256(f.native.canonical([action['operation'],action['payload']]).encode()).hexdigest())
  self.assertEqual(out['manifest_entry']['payload_sha256'],out['decision']);self.assertGreaterEqual(len(out['manifest_entry']['reason'].strip()),10)
  try:import guardian_proposer as gp,guardian_approver as ga
  except Exception:gp=None
  if gp is not None:
   self.assertEqual(gp.validate_batch(out['batch']),out['batch']);self.assertEqual(gp.decision(action),out['decision'])
   manifest=dict(schema=ga.MANIFEST_SCHEMA,actions=[out['manifest_entry']])
   self.assertEqual(ga.manifest_rule(manifest,dict(operation=action['operation'],payload=action['payload'])),action['payload'])
 def test_quorum_proposal_replaces_a_different_evaluator_and_is_idempotent_when_configured(self):
  i,p,s=self.handed_over(dict(project='P-service-integrity-20261105',evaluator='uain1'+'5'*40))
  out=f.configure_proposal(i,p,s);self.assertEqual(out['batch']['actions'][0]['payload']['expected_evaluator'],'uain1'+'5'*40)
  i,p,s=self.handed_over(dict(project='P-service-integrity-20261105',evaluator=None))
  s['records']['central_fund_config/'+p['project']]['evaluator']=i['member']
  self.assertEqual(f.configure_proposal(i,p,s),dict(status='already_configured',evaluator=i['member']))
 def test_quorum_proposal_refused_before_handover_or_for_wrong_identity(self):
  i,p,s,_=self.fixture();s['records']['central_fund_config/'+p['project']]=None
  with self.assertRaises(ValueError):f.configure_proposal(i,p,s)
  i,p,s=self.handed_over();s['records']['member/'+i['member']]['licence']='revoked'
  with self.assertRaises(ValueError):f.configure_proposal(i,p,s)
 def test_organization_quorum_items_bind_the_fleet_project(self):
  payload=dict(project='P-OPP-00002',evaluator='uain1'+'2'*40,expected_evaluator='',evidence_digest='a'*64)
  self.assertEqual(f.quorum_configure(payload,'organizations',dict(project='OPP-00002'))['context'],dict(project='OPP-00002'))
  for bad in [(payload,'organizations',dict(project='OPP-00003')),(payload,'organizations',None),(payload,'admission',None),({**payload,'evaluator':f.GUARDIAN},'manifest',None),({**payload,'expected_evaluator':payload['evaluator']},'manifest',None),({**payload,'extra':1},'manifest',None)]:
   with self.assertRaises(ValueError):f.quorum_configure(*bad)
class BootstrapTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve();self.manifest=self.root/'sources.json'
  for name in f.SOURCE_NAMES:(self.root/(name+'.py')).write_text("VALUE='reviewed source'\n")
  self.approve()
 def approve(self):self.manifest.write_text(json.dumps(dict(schema='uain-central-fund-manager-sources-v1',sha256={n+'.py':hashlib.sha256((self.root/(n+'.py')).read_bytes()).hexdigest() for n in f.SOURCE_NAMES})))
 def invoke(self):
  with patch.object(f.os,'geteuid',return_value=0),patch.object(f,'source_read',lambda p:Path(p).read_bytes()),patch.dict(sys.modules):return f.bootstrap_sources(self.root,self.manifest)
 def test_wrong_hash_refuses_before_any_application_source_executes(self):
  (self.root/'native_migration.py').write_text("raise RuntimeError('unreviewed source executed')\n")
  with self.assertRaisesRegex(ValueError,'Pinned Fund Manager source refused'):self.invoke()
 def test_duplicate_missing_and_extra_source_manifest_fields_refused(self):
  for value in (dict(schema='uain-central-fund-manager-sources-v1',sha256={}),dict(schema='uain-central-fund-manager-sources-v1',sha256={},extra=True)):
   self.manifest.write_text(json.dumps(value))
   with self.assertRaises(ValueError):self.invoke()
  self.manifest.write_text('{"schema":"x","schema":"x","sha256":{}}')
  with self.assertRaises(ValueError):self.invoke()
 def test_valid_forged_bytecode_is_never_executed(self):
  source=self.root/'native_migration.py';info=source.stat();cache=Path(importlib.util.cache_from_source(str(source)));cache.parent.mkdir()
  cache.write_bytes(importlib._bootstrap_external._code_to_timestamp_pyc(compile("raise RuntimeError('forged bytecode executed')",str(source),'exec'),int(info.st_mtime),info.st_size))
  with patch.object(f.os,'geteuid',return_value=0),patch.object(f,'source_read',lambda p:Path(p).read_bytes()),patch.dict(sys.modules):
   f.bootstrap_sources(self.root,self.manifest);self.assertEqual(sys.modules['native_migration'].VALUE,'reviewed source')
 def test_public_report_symlink_is_refused_by_actual_protected_loader(self):
  source=self.root/'model-report.json';source.write_text('{}');redirect=self.root/'redirect.json';redirect.symlink_to(source)
  with self.assertRaises(ValueError):f.admission.load(redirect)

if __name__=='__main__':unittest.main()
