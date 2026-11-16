import copy,datetime,hashlib,unittest,contextlib,tempfile,os,json,stat
from pathlib import Path
from unittest.mock import patch
import central_reviewer as r

class CentralReviewerTests(unittest.TestCase):
 def fixture(self):
  now=datetime.datetime.now(datetime.timezone.utc);stamp=now.isoformat();h=lambda s:hashlib.sha256(s.encode()).hexdigest()
  p={'chain_id':r.CHAIN,'reviewer':'uain1'+'a'*40,'public_key':'public-key-fixture'}
  d={'schema':'uain-central-research-decision-v1','domain':'UAIN/central-research-review/v1','submission':'CS-1','task':'CT-1','reviewer':p['reviewer'],'execution_id':'review-1','criteria_digest':h('Check the stated original evidence.'),'evidence_digest':h('Evidence data.'),'verdict':'accept','findings':['Each criterion checked against retained evidence.'],'started_at':stamp,'completed_at':stamp}
  records={'central_earning_activation':{'policy':r.POLICY,'reviewer':p['reviewer'],'height':'2'},'central_submission/CS-1':{'id':'CS-1','task':'CT-1','author':'uain1'+'b'*40,'state':'under_review','evidence':'Evidence data.','evidence_digest':d['evidence_digest']},'central_task/CT-1':{'id':'CT-1','project':'P-1','criteria':'Check the stated original evidence.','acceptance_digest':d['criteria_digest'],'pending':'CS-1','state':'under_review','solver_amount':'100000000','reviewer_amount':'20000000','reserved':'120000000'},'central_project_budget/P-1':{'project':'P-1','policy':r.POLICY,'allocation':'10000000000','lifetime_ceiling':'1000000000000000','round':1,'height':'2','evidence_digest':'a'*64,'paid':'0','reserved':'120000000'}}
  state={'chain_id':r.CHAIN,'height':'100','header_time':stamp,'member':{'id':p['reviewer'],'public_key':p['public_key'],'licence':'active','sequence':'5'},'records':records}
  return p,state,d
 def test_exact_v2_cumulative_rounds_and_old_policy_refusal(self):
  amounts=('10000000000','110000000000','1110000000000','11110000000000','111110000000000','1000000000000000')
  for round,allocation in enumerate(amounts,1):
   p,s,d=self.fixture();b=s['records']['central_project_budget/P-1'];b.update(round=round,allocation=allocation);r.review_command(p,s,d)
   for field,value in [('allocation',str(int(allocation)+1)),('paid',allocation),('round',str(round)),('policy','central-earning-six-round-budget-v1'),('lifetime_ceiling','1111110000000000'),('height','0'),('height','101'),('evidence_digest','invalid')]:
    changed=copy.deepcopy(s);changed['records']['central_project_budget/P-1'][field]=value
    with self.subTest(round=round,field=field),self.assertRaises(ValueError):r.review_command(p,changed,d)
  for round in (0,7,-1,1.5,True,None):
   p,s,d=self.fixture();s['records']['central_project_budget/P-1']['round']=round
   with self.subTest(round=round),self.assertRaises(ValueError):r.review_command(p,s,d)
  p,s,d=self.fixture();s['records']['central_earning_activation']['policy']='central-earning-six-round-budget-v1'
  with self.assertRaises(ValueError):r.review_command(p,s,d)
 def test_opening_provenance_cannot_precede_v2_activation(self):
  p,s,d=self.fixture();s['records']['central_project_budget/P-1']['height']='1'
  with self.assertRaises(ValueError):r.review_command(p,s,d)
 def test_later_round_preserves_central_review_and_carryover(self):
  p,s,d=self.fixture();b=s['records']['central_project_budget/P-1'];b['round']=2;b['allocation']='110000000000';b['paid']='10000000000';self.assertEqual(r.review_command(p,s,d)['operation'],'central_review')
 def test_staged_first_round_budget_and_provenance(self):
  p,s,d=self.fixture();s['records']['central_earning_activation']['policy']='central-earning-five-kpi-fund-v2';b=s['records']['central_project_budget/P-1'];b['policy']='central-earning-five-kpi-fund-v2';r.review_command(p,s,d)
  for field,value in [('allocation','1000000000000000'),('lifetime_ceiling','1111110000000000'),('round',2),('round','1'),('height','101'),('evidence_digest','invalid'),('reserved','119999999')]:
   p,s,d=self.fixture();s['records']['central_project_budget/P-1'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):r.review_command(p,s,d)
 def test_binds_exact_native_task_evidence_and_typed_review(self):
  p,s,d=self.fixture();c=r.review_command(p,s,d);self.assertEqual(c['operation'],'central_review');self.assertEqual(c['sequence'],'5');self.assertEqual(c['payload']['evidence_digest'],d['evidence_digest']);self.assertEqual(c['payload']['verification_digest'],r.decision_digest(d));self.assertEqual(set(c['payload']),{'submission','verdict','criteria_digest','verification_digest','execution_id','evidence_digest'})
 def test_self_review_unknown_fields_and_wrong_criteria_refused(self):
  for mutate in [lambda p,s,d:d.update(private_key='not-allowed'),lambda p,s,d:d.update(criteria_digest='f'*64),lambda p,s,d:s['records']['central_submission/CS-1'].update(author=p['reviewer']),lambda p,s,d:d.update(verdict='paid'),lambda p,s,d:s['records']['central_task/CT-1'].update(pending='CS-other')]:
   p,s,d=self.fixture();mutate(p,s,d)
   with self.assertRaises(ValueError):r.review_command(p,s,d)
 def test_stale_proof_revoked_member_and_unreserved_amount_refused(self):
  for mutate in [lambda p,s,d:s.update(header_time='2020-01-01T00:00:00+00:00'),lambda p,s,d:s['member'].update(licence='revoked'),lambda p,s,d:s['records']['central_task/CT-1'].update(reserved='119999999'),lambda p,s,d:s['records']['central_project_budget/P-1'].update(paid='1000000000000000')]:
   p,s,d=self.fixture();mutate(p,s,d)
   with self.assertRaises(ValueError):r.review_command(p,s,d)
 def test_canonical_decision_digest_matches_json_not_go_html_escaping(self):
  p,s,d=self.fixture();d['findings']=['a < b & é'];raw=r.decision_bytes(d);self.assertIn('a < b & é',raw.decode());self.assertEqual(r.decision_digest(d),hashlib.sha256(b'UAIN/central-research-review/v1\n'+raw).hexdigest());r.review_command(p,s,d)
 def test_inconclusive_is_typed_no_award_not_arbitrary_amount(self):
  p,s,d=self.fixture();d['verdict']='needs_evidence';c=r.review_command(p,s,d);self.assertEqual(c['payload']['verdict'],'needs_evidence');self.assertNotIn('amount',c['payload'])
 def test_exact_receipt_binding_refuses_foreign_operation_subject_or_digest(self):
  p,s,d=self.fixture();c=r.review_command(p,s,d);e={'member':p['reviewer'],'operation':'central_review','subject':'CS-1','command_digest':r.sha(r.native.signing_bytes(c))};self.assertTrue(r.matches_receipt(e,c))
  for field,value in [('member','other'),('operation','coin_claim'),('subject','CS-other'),('command_digest','f'*64)]:
   wrong={**e,field:value};self.assertFalse(r.matches_receipt(wrong,c))

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
  patches=[patch.object(r,'ROOT',root),patch.object(r,'locked',contextlib.nullcontext),patch.object(h,'current',current),patch.object(h,'read',lambda p,limit=0:Path(p).read_bytes()),patch.object(h,'write',write),patch.object(h,'backup_proof',backup),patch.object(r.os,'fsync',sync)]
  for q in patches:q.start();self.addCleanup(q.stop)
  return h,c,root,files,saves,backups,directories,current
 def test_provision_preserves_all_attachments_and_syncs_parent_before_publication(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture();before=current(c)[0];identity=r.provision(c,before);self.assertEqual(len(saves),1);self.assertEqual(files['keys/existing-fixture.json'],b'FICTIONAL existing attachment');self.assertEqual(set(files),{'keys/existing-fixture.json',r.KEY});self.assertEqual(len(backups),1);self.assertIn(root.stat().st_ino,dirs);self.assertEqual(identity['member'],'uain1'+r.sha(__import__('base64').urlsafe_b64decode(identity['public_key']+'='))[:40]);self.assertNotIn('private_key',identity);self.assertEqual((root/'identity.json').stat().st_mode&0o777,0o600)
 def test_failed_backup_never_publishes_identity_and_retry_keeps_original_key(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture()
  with patch.object(h,'backup_proof',side_effect=ValueError('FICTIONAL backup unavailable')):
   with self.assertRaises(ValueError):r.provision(c,current(c)[0])
  self.assertFalse((root/'identity.json').exists());retained=files[r.KEY];r.provision(c,current(c)[0]);self.assertEqual(files[r.KEY],retained);self.assertEqual(len(saves),1)
 def test_existing_mismatched_key_refuses_without_rotation_or_backup(self):
  h,c,root,files,saves,backups,dirs,current=self.fixture();r.provision(c,current(c)[0]);broken=json.loads(files[r.KEY]);broken['public_key']='A'*43;files[r.KEY]=json.dumps(broken).encode();backups.clear()
  with self.assertRaises(ValueError):r.provision(c,current(c)[0])
  self.assertEqual(len(saves),1);self.assertEqual(backups,[])

class SigningTests(unittest.TestCase):
 fixture=CentralReviewerTests.fixture
 def test_fixed_enrol_and_review_sign_only_owned_custody_key(self):
  seed=hashlib.sha256(b'FICTIONAL test-only central reviewer key').digest();pub,_=r.native.ed25519(seed);encoded=r.b64(pub);member='uain1'+r.sha(pub)[:40]
  class FakeCustody:
   def vault(self):return None
   def attachment(self,_vault,name):
    self_name=name
    if self_name!=r.KEY:raise ValueError('Unknown fixture key')
    return json.dumps({'private_key':r.b64(seed),'public_key':encoded}).encode()
  c=FakeCustody();p,state,d=self.fixture();p.update(reviewer=member,public_key=encoded);state['member'].update(id=member,public_key=encoded);state['records']['central_earning_activation']['reviewer']=member;d['reviewer']=member
  with patch.object(r.os,'geteuid',return_value=0):
   envelope=r.sign_review(c,p,state,d);self.assertEqual(envelope['command']['operation'],'central_review');self.assertEqual(envelope['public_key'],encoded)
   with self.assertRaises(ValueError):r._sign(c,{**envelope['command'],'operation':'coin_claim'},member,encoded)
   identity=dict(schema='uain-central-reviewer-identity-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,member=member,public_key=encoded,name='UAIN Central Research Reviewer',operator='United AI Network (Rahul Jalan)',family='Central research reviewer')
   state['records']['member/'+member]=None;joined=r.sign_enrol(c,identity,state);self.assertEqual(joined['command']['sequence'],'0');self.assertEqual(joined['command']['payload']['name'],identity['name'])
   state['records']['member/'+member]={'licence':'active'}
   with self.assertRaises(ValueError):r.sign_enrol(c,identity,state)

class EnrolOnceTests(unittest.TestCase):
 def test_lost_reply_retains_original_envelope_then_reconciles_without_resigning(self):
  import native_admission as a
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);pub=bytes(range(32));member='uain1'+r.sha(pub)[:40];stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
   identity=dict(schema='uain-central-reviewer-identity-v1',chain_id=r.CHAIN,genesis_sha256=r.GENESIS,member=member,public_key=r.b64(pub),name='UAIN Central Research Reviewer',operator='United AI Network (Rahul Jalan)',family='Central research reviewer')
   initial={'chain_id':r.CHAIN,'height':'100','header_time':stamp,'event_count':'0','records':{'member/'+member:None}}
   calls={'sign':0,'send':0};visible=False
   def sign(_c,i,state):calls['sign']+=1;return dict(command=r.enrol_command(i,state),public_key=i['public_key'],signature='FICTIONAL signature')
   class Runtime:
    def broadcast(self,envelope):
     calls['send']+=1;assert json.loads((root/'enrol-journal.json').read_text())['send_started'] is True;raise OSError('FICTIONAL lost reply')
    def read(self,selection):
     if not visible:return copy.deepcopy(initial)
     journal=json.loads((root/'enrol-journal.json').read_text());cmd=journal['envelope']['command'];event=dict(id='1',height='101',member=member,subject=member,operation='enrol',command_digest=r.sha(r.native.signing_bytes(cmd)))
     state={**initial,'height':'102','event_count':'1','records':{'event/00000000000000000001':event}}
     if 'receipt' in selection:state['receipt']={'authority':'native','finalized':True,'event':event}
     return state
   with patch.object(r,'ROOT',root),patch.object(r,'sign_enrol',sign):
    first=r.enrol_once(None,identity,Runtime(),read_journal=lambda p:json.loads(p.read_bytes()));self.assertEqual(first['status'],'pending');visible=True
    second=r.enrol_once(None,identity,Runtime(),read_journal=lambda p:json.loads(p.read_bytes()));self.assertTrue(second['verified']);self.assertEqual(calls,{'sign':1,'send':1});self.assertTrue(r.enrol_once(None,identity,Runtime(),read_journal=lambda p:json.loads(p.read_bytes()))['verified']);self.assertEqual(calls,{'sign':1,'send':1})

if __name__=='__main__':unittest.main()
