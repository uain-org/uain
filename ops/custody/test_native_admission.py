"""Automatic admission uses fictional identities and injected proof/transport only."""
import base64,copy,hashlib,importlib.util,json,tempfile,unittest,contextlib,io,configparser
from unittest.mock import patch,Mock
from types import SimpleNamespace
from pathlib import Path
spec=importlib.util.spec_from_file_location('native_admission',Path(__file__).with_name('native_admission.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
enc=lambda raw:base64.urlsafe_b64encode(raw).decode().rstrip('=')
def identity(n):
 public=enc(bytes([n])*32);return 'uain1'+hashlib.sha256(bytes([n])*32).hexdigest()[:40],public
class AdmissionTests(unittest.TestCase):
 def fixture(self):
  guardian,gpub=identity(3);member,pub=identity(4)
  policy=dict(schema='uain-native-admission-policy-v1',policy='objective-enrol-v1',chain_id='uain-test-admission',genesis='/fictional/genesis',genesis_sha256='a'*64,state_binary='/fictional/reader',state_sha256='b'*64,rpc='http://127.0.0.1:26667',guardian=guardian,guardian_public_key=gpub,guardian_key_attachment='keys/uain-review-key.json',guardian_epoch=None,start_event='0',start_event_digest='',max_events=16,max_approvals=4)
  event=dict(id='1',height='10',member=member,subject=member,operation='enrol',command_digest='c'*64)
  target=dict(id=member,public_key=pub,name='Synthetic member',operator='Synthetic operator',family='Fixture',licence='pending',sequence='1',karma=0,credits='0',active_projects=0,default_verifier=False,creator=False)
  state=dict(chain_id=policy['chain_id'],height='12',event_count='1',member=dict(id=guardian,public_key=gpub,licence='active',sequence='7'),records={'guardians':[guardian],'guardian_epoch_current':None,'member/'+member:target,'event/'+event['id'].zfill(20):event})
  return policy,event,state
 def test_valid_finalized_pending_enrol_creates_only_active_licence(self):
  p,e,s=self.fixture();evidence,command=m.screen(p,e,s)
  self.assertEqual(command['operation'],'licence');self.assertEqual(command['payload']['member'],e['member']);self.assertEqual(command['payload']['status'],'active');self.assertEqual(command['payload']['evidence_digest'],m.digest(m.canonical(evidence)))
  self.assertEqual(command['member'],p['guardian']);self.assertEqual(command['sequence'],'7');self.assertNotIn('terms_accepted',evidence)
 def test_real_reader_canonical_string_zero_standing_is_admitted(self):
  p,e,s=self.fixture();target=s['records']['member/'+e['member']];target.update(karma='0',active_projects='0');self.assertEqual(m.screen(p,e,s)[1]['operation'],'licence')
 def compact_fixture(self):
  p,e,s=self.fixture();target=s['records']['member/'+e['member']]
  metadata={field:target[field] for field in ('id','name','operator','family')}
  raw=json.dumps(metadata,ensure_ascii=False,separators=(',',':')).encode()
  target.update(name='',operator='',family='',account_policy='compact-account-v1',metadata_digest=hashlib.sha256(raw).hexdigest())
  s['records']['member_metadata/'+e['member']]=metadata
  return p,e,s
 def test_standard_compact_account_uses_bound_proved_metadata_without_granting_roles(self):
  p,e,s=self.compact_fixture();before=copy.deepcopy(s);evidence,command=m.screen(p,e,s)
  self.assertEqual(command['operation'],'licence');self.assertEqual(command['payload']['status'],'active')
  self.assertEqual(evidence['member']['name'],'Synthetic member');self.assertFalse(evidence['member']['creator']);self.assertFalse(evidence['member']['default_verifier']);self.assertEqual(s,before)
 def test_compact_selection_requests_target_metadata_for_native_proof(self):
  p,e,_=self.compact_fixture();self.assertIn('member_metadata/'+e['member'],m.selection(p,e)['keys'])
 def test_compact_metadata_mutations_never_pass(self):
  for mutation in [
   lambda t,r,k:r.pop(k),lambda t,r,k:r.update({k:None}),
   lambda t,r,k:r[k].update(id=t['public_key']),lambda t,r,k:r[k].update(name='Forged name'),
   lambda t,r,k:r[k].update(extra='unrecognized'),lambda t,r,k:t.update(metadata_digest='0'*64),
   lambda t,r,k:t.update(metadata_digest='invalid'),lambda t,r,k:t.update(name='Conflicting raw identity'),
   lambda t,r,k:t.update(account_policy='future-unknown-policy'),lambda t,r,k:t.update(creator=True),
   lambda t,r,k:t.update(default_verifier=True),lambda t,r,k:t.update(sequence='2'),
  ]:
   p,e,s=self.compact_fixture();target=s['records']['member/'+e['member']];mutation(target,s['records'],'member_metadata/'+e['member'])
   with self.subTest(state=s),self.assertRaises(ValueError):m.screen(p,e,s)
 def test_captured_live_compact_enrol_481_is_screened_without_signing(self):
  p,_,_=self.fixture();s=json.loads((Path(__file__).parent/'fixtures/native-admission-public-481.json').read_text())
  p.update(chain_id=s['chain_id'],genesis_sha256='54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff',state_sha256='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',guardian=s['member']['id'],guardian_public_key=s['member']['public_key'])
  e=s['records']['event/00000000000000000481'];before=copy.deepcopy(s)
  evidence,command=m.screen(p,e,s)
  self.assertEqual(evidence['member']['name'],'Codex research session');self.assertEqual(evidence['member']['licence'],'pending')
  self.assertEqual(command['payload']['member'],e['member']);self.assertEqual(command['operation'],'licence');self.assertEqual(s,before)
 def test_compact_account_keeps_zero_standing_and_licence_gates(self):
  for field,value in [('licence','active'),('licence','revoked'),('licence','withdrawn'),('karma',1),('credits','1'),('active_projects',1),('karma',False),('sequence','2')]:
   p,e,s=self.compact_fixture();s['records']['member/'+e['member']][field]=value
   with self.subTest(field=field,value=value),self.assertRaises(ValueError):m.screen(p,e,s)
 def test_compact_unknown_policy_is_a_durable_eligibility_refusal(self):
  p,e,s=self.compact_fixture();s['records']['member/'+e['member']]['account_policy']='unrecognized'
  with self.assertRaises(m.EligibilityRefused):m.screen(p,e,s)
 def test_ambiguous_and_noncanonical_zero_standing_is_rejected(self):
  for field in ['karma','active_projects']:
   for value in [False,0.0,'00','-0','0.0',' 0',None]:
    p,e,s=self.fixture();s['records']['member/'+e['member']][field]=value
    with self.subTest(field=field,value=value),self.assertRaises(ValueError):m.screen(p,e,s)
 def test_identity_minimum_and_maximum_match_consensus_utf8_byte_bounds(self):
  p,e,s=self.fixture();target=s['records']['member/'+e['member']];target.update(name='名',operator='器');self.assertEqual(m.screen(p,e,s)[1]['operation'],'licence')
  target['name']='名'*41
  with self.assertRaises(ValueError):m.screen(p,e,s)
 def test_changed_identity_authority_event_or_ended_licence_never_passes(self):
  p,e,s=self.fixture();key='member/'+e['member']
  mutations=[lambda v:v.update(chain_id='wrong'),lambda v:v['member'].update(licence='revoked'),lambda v:v['records'].update(guardians=[]),lambda v:v['records'].update(guardian_epoch_current='changed'),lambda v:v['records'][key].update(licence='active'),lambda v:v['records'][key].update(licence='revoked'),lambda v:v['records'][key].update(licence='withdrawn'),lambda v:v['records'][key].update(sequence='2'),lambda v:v['records'][key].update(karma=-10),lambda v:v['records'][key].update(credits='1'),lambda v:v['records'][key].update(default_verifier=True),lambda v:v['records'][key].update(creator=True),lambda v:v['records'][key].update(account_policy='override'),lambda v:v['records'][key].update(metadata_digest='d'*64),lambda v:v['records'][key].update(public_key=p['guardian_public_key']),lambda v:v['records'][key].update(name=' '),lambda v:v['records'][key].update(operator='x'*201),lambda v:v['records']['event/00000000000000000001'].update(command_digest='d'*64)]
  for change in mutations:
   altered=copy.deepcopy(s);change(altered)
   with self.subTest(altered=altered),self.assertRaises(ValueError):m.screen(p,e,altered)
 def test_forged_or_non_enrol_events_refused(self):
  p,e,s=self.fixture()
  for changes in [dict(operation='roles'),dict(subject=p['guardian']),dict(member=p['guardian']),dict(id='2'),dict(height='13'),dict(command_digest='bad')]:
   with self.subTest(changes=changes),self.assertRaises(ValueError):m.screen(p,{**e,**changes},s)
 def process_fixture(self):
  p,e,s=self.fixture();calls=[]
  class Runtime:
   def read(self,selection):
    value=copy.deepcopy(s)
    if 'receipt' in selection:value['receipt']=dict(finalized=True,event=value['records'][m.event_key(2)])
    return value
   def broadcast(self,envelope):calls.append(copy.deepcopy(envelope));raise TimeoutError('uncertain synthetic network')
  runtime=Runtime()
  def sign(custody,policy,event,state):
   evidence,command=m.screen(policy,event,state);return evidence,dict(command=command,public_key=p['guardian_public_key'],signature='synthetic-signature')
  load=lambda path:json.loads(Path(path).read_text())
  return p,e,s,calls,runtime,sign,load
 def test_uncertain_send_is_never_rebroadcast_or_resigned_on_restart(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture();signer=Mock(side_effect=sign)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',signer),patch.object(m,'verify_envelope'):
   path=Path(root)/'1';self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'uncertain')
   original=(path/'attempt-1.json').read_bytes();self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'pending_finality')
   self.assertEqual(len(calls),1);self.assertEqual(signer.call_count,1);self.assertEqual((path/'attempt-1.json').read_bytes(),original)
 def test_crash_after_signed_artifact_adopts_exact_bytes_before_broadcast(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture();signer=Mock(side_effect=sign)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',signer),patch.object(m,'verify_envelope'):
   path=Path(root)/'1'
   def fail_journal(file,value):
    if file.name=='journal.json':raise OSError('synthetic persistence failure')
    m.atomic(file,value)
   with self.assertRaises(OSError):m.process_enrol(None,p,e,path,runtime,read_journal=load,write=fail_journal)
   self.assertEqual(calls,[]);retained=(path/'attempt-1.json').read_bytes();m.process_enrol(None,p,e,path,runtime,read_journal=load)
   self.assertEqual(signer.call_count,1);self.assertEqual((path/'attempt-1.json').read_bytes(),retained);self.assertEqual(len(calls),1)
 def test_failed_durable_broadcast_marker_never_sends(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture()
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'):
   def fail_marker(file,value):
    if value.get('status')=='broadcast_started':raise OSError('synthetic fsync failure')
    m.atomic(file,value)
   with self.assertRaises(OSError):m.process_enrol(None,p,e,Path(root)/'1',runtime,read_journal=load,write=fail_marker)
   self.assertEqual(calls,[])
 def test_expired_unknown_command_requires_noninclusion_before_fresh_attempt(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture();signer=Mock(side_effect=sign)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',signer),patch.object(m,'verify_envelope'):
   path=Path(root)/'1';m.process_enrol(None,p,e,path,runtime,read_journal=load);original=(path/'attempt-1.json').read_bytes()
   s['height']='200';result=m.process_enrol(None,p,e,path,runtime,read_journal=load);self.assertEqual(result['status'],'retry_required');self.assertEqual(len(calls),1)
   closed=load(path/'journal.json');self.assertEqual(closed['nonincluded_through'],'1');self.assertEqual(closed['status'],'expired_or_superseded_nonincluded')
   result=m.process_enrol(None,p,e,path,runtime,read_journal=load);self.assertEqual(result['status'],'uncertain');self.assertEqual(signer.call_count,2);self.assertEqual(len(calls),2);self.assertEqual((path/'attempt-1.json').read_bytes(),original);self.assertEqual(load(path/'journal.json')['attempt'],2)
 def test_unbroadcast_signed_artifact_expiring_during_restart_recovers_without_sending_old_bytes(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture();signer=Mock(side_effect=sign)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',signer),patch.object(m,'verify_envelope'):
   path=Path(root)/'1'
   def fail_marker(file,value):
    if value.get('status')=='broadcast_started':raise OSError('crash before broadcast')
    m.atomic(file,value)
   with self.assertRaises(OSError):m.process_enrol(None,p,e,path,runtime,read_journal=load,write=fail_marker)
   s['height']='200';self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'retry_required');self.assertEqual(calls,[])
   m.process_enrol(None,p,e,path,runtime,read_journal=load);self.assertEqual(len(calls),1);self.assertEqual(signer.call_count,2)
 def test_other_guardian_activation_does_not_release_an_uncertain_sequence(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture()
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'):
   path=Path(root)/'1';m.process_enrol(None,p,e,path,runtime,read_journal=load);s['records']['member/'+e['member']]['licence']='active'
   self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'pending_finality');self.assertEqual(len(calls),1)
   s['height']='200';self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'already_active');self.assertEqual(len(calls),1)
 def test_exact_proved_finality_is_required_and_retained_idempotently(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture()
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'):
   path=Path(root)/'1';m.process_enrol(None,p,e,path,runtime,read_journal=load);command=load(path/'journal.json')['envelope']['command'];found=dict(id='2',height='13',member=p['guardian'],operation='licence',subject=e['member'],command_digest=m.digest(m.native.signing_bytes(command)))
   s.update(height='14',event_count='2');s['member']['sequence']='8';s['records'][m.event_key(2)]=found;s['records']['member/'+e['member']]['licence']='active'
   result=m.process_enrol(None,p,e,path,runtime,read_journal=load);self.assertEqual(result['status'],'finalized');self.assertEqual(result['event'],found);self.assertEqual(len(calls),1)
   self.assertEqual(m.process_enrol(None,p,e,path,runtime,read_journal=load)['status'],'finalized');self.assertEqual(len(calls),1)
 def test_changed_receipt_is_not_claimed_as_approval(self):
  p,e,s,calls,runtime,sign,load=self.process_fixture()
  with tempfile.TemporaryDirectory() as root,patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'):
   path=Path(root)/'1';m.process_enrol(None,p,e,path,runtime,read_journal=load);s.update(height='14',event_count='2');s['member']['sequence']='8';s['records'][m.event_key(2)]=dict(id='2',height='13',member=p['guardian'],operation='licence',subject=e['member'],command_digest='f'*64)
   result=m.process_enrol(None,p,e,path,runtime,read_journal=load);self.assertNotEqual(result['status'],'finalized');self.assertNotIn('receipt_event',load(path/'journal.json'))
 def test_bootstrap_captured_checkpoint_does_not_skip_racing_enrolment(self):
  p,e,s=self.fixture();p['start_event']='1';p['start_event_digest']=e['command_digest'];s['event_count']='2';s['records'][m.event_key(2)]={**e,'id':'2'}
  class Runtime:
   def __init__(self,policy):pass
   def remaining(self):return 10
   def read(self,selection):return copy.deepcopy(s)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'ROOT',Path(root)),patch.object(m,'TEMP',Path(root)/'runtime'),patch.object(m,'load',side_effect=lambda path:p if path==m.POLICY else json.loads(Path(path).read_text())),patch.object(m,'ensure_directory',side_effect=lambda path:Path(path).mkdir(parents=True,exist_ok=True)),patch.object(m,'Runtime',Runtime),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'process_enrol',return_value=dict(done=True,status='finalized')) as process,contextlib.redirect_stdout(io.StringIO()):
   m.run(None);self.assertEqual(process.call_args.args[2]['id'],'2');self.assertEqual(json.loads((Path(root)/p['genesis_sha256']/'cursor.json').read_text())['cursor'],'2')
 def queue_fixture(self):
  p,e,s=self.fixture();other,pub=identity(5);second={**e,'id':'2','member':other,'subject':other,'command_digest':'d'*64};s['event_count']='2';s['records'][m.event_key(2)]=second;s['records']['member/'+other]={**s['records']['member/'+e['member']],'id':other,'public_key':pub,'name':'Second member'}
  class Runtime:
   def __init__(self,policy):pass
   def remaining(self):return 10
   def read(self,selection):return copy.deepcopy(s)
   def broadcast(self,envelope):sent.append(envelope);raise TimeoutError('fixture uncertain transport')
  sent=[]
  def sign(custody,policy,event,state):
   evidence,command=m.screen(policy,event,state);return evidence,dict(command=command,public_key=p['guardian_public_key'],signature='synthetic')
  return p,e,s,second,Runtime,sent,sign
 def test_refused_pending_candidate_is_durable_and_next_valid_candidate_is_attempted(self):
  p,e,s,second,runtime,sent,sign=self.queue_fixture();s['records']['member/'+e['member']]['karma']=-1
  with tempfile.TemporaryDirectory() as root,patch.object(m,'ROOT',Path(root)),patch.object(m,'TEMP',Path(root)/'runtime'),patch.object(m,'load',side_effect=lambda path:p if path==m.POLICY else json.loads(Path(path).read_text())),patch.object(m,'ensure_directory',side_effect=lambda path:Path(path).mkdir(parents=True,exist_ok=True)),patch.object(m,'Runtime',runtime),patch.object(m.native,'protected_read',side_effect=lambda path,limit=0:Path(path).read_bytes()),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'),contextlib.redirect_stdout(io.StringIO()):
   m.run(None);epoch=Path(root)/p['genesis_sha256'];refused=json.loads((epoch/'1'/'refused.json').read_text());self.assertEqual(refused['reason'],'nonzero-standing');self.assertEqual(refused['proved_context']['member']['id'],e['member']);self.assertEqual(json.loads((epoch/'cursor.json').read_text())['cursor'],'1');self.assertEqual(len(sent),1);self.assertEqual(sent[0]['command']['payload']['member'],second['member'])
 def test_proof_binding_failure_is_fatal_and_does_not_advance_or_skip(self):
  p,e,s,second,runtime,sent,sign=self.queue_fixture();s['records']['member/'+e['member']]['public_key']=p['guardian_public_key']
  with tempfile.TemporaryDirectory() as root,patch.object(m,'ROOT',Path(root)),patch.object(m,'TEMP',Path(root)/'runtime'),patch.object(m,'load',side_effect=lambda path:p if path==m.POLICY else json.loads(Path(path).read_text())),patch.object(m,'ensure_directory',side_effect=lambda path:Path(path).mkdir(parents=True,exist_ok=True)),patch.object(m,'Runtime',runtime),patch.object(m.native,'protected_read',side_effect=lambda path,limit=0:Path(path).read_bytes()),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'sign_guardian',side_effect=sign),patch.object(m,'verify_envelope'),contextlib.redirect_stdout(io.StringIO()):
   with self.assertRaises(ValueError) as caught:m.run(None)
   self.assertNotIsInstance(caught.exception,m.EligibilityRefused);epoch=Path(root)/p['genesis_sha256'];self.assertEqual(json.loads((epoch/'cursor.json').read_text())['cursor'],'0');self.assertFalse((epoch/'1'/'refused.json').exists());self.assertEqual(sent,[])
 def test_refusal_persistence_failure_cannot_advance_to_next_candidate(self):
  p,e,s,second,runtime,sent,sign=self.queue_fixture();s['records']['member/'+e['member']]['karma']=-1;original=m.atomic
  def write(path,value):
   if path.name=='refused.json':raise OSError('fixture denial fsync failure')
   original(path,value)
  with tempfile.TemporaryDirectory() as root,patch.object(m,'ROOT',Path(root)),patch.object(m,'TEMP',Path(root)/'runtime'),patch.object(m,'load',side_effect=lambda path:p if path==m.POLICY else json.loads(Path(path).read_text())),patch.object(m,'ensure_directory',side_effect=lambda path:Path(path).mkdir(parents=True,exist_ok=True)),patch.object(m,'Runtime',runtime),patch.object(m.native,'protected_read',side_effect=lambda path,limit=0:Path(path).read_bytes()),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'atomic',side_effect=write),contextlib.redirect_stdout(io.StringIO()):
   with self.assertRaises(OSError):m.run(None)
   epoch=Path(root)/p['genesis_sha256'];self.assertEqual(json.loads((epoch/'cursor.json').read_text())['cursor'],'0');self.assertEqual(sent,[])
 def test_preflight_checks_vault_binding_without_signing_or_broadcast(self):
  p,e,s=self.fixture();seed=enc(bytes([8])*32);signer=Mock();runtime=SimpleNamespace(read=Mock(return_value=s),broadcast=Mock());custody=SimpleNamespace(vault=Mock(return_value=object()),attachment=Mock(return_value=json.dumps(dict(public_key=p['guardian_public_key'],private_key=seed)).encode()))
  output=io.StringIO()
  with patch.object(m,'load',return_value=p),patch.object(m,'ensure_directory'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'Runtime',return_value=runtime),patch.object(m.native,'ed25519',return_value=(bytes([3])*32,signer)),contextlib.redirect_stdout(output):m.check_policy(custody)
  self.assertFalse(signer.called);self.assertFalse(runtime.broadcast.called);result=json.loads(output.getvalue());self.assertEqual(result['commands_signed'],0);self.assertFalse(result['private_keys_exported']);self.assertNotIn(seed,output.getvalue());custody.attachment.assert_called_once_with(custody.vault.return_value,p['guardian_key_attachment'])
  with patch.object(m,'load',return_value=p),patch.object(m,'ensure_directory'),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'Runtime',return_value=runtime),patch.object(m.native,'ed25519',return_value=(bytes([9])*32,signer)),self.assertRaises(ValueError):m.check_policy(custody)
 def test_policy_refuses_unbounded_work_alternate_authority_and_external_rpc(self):
  p,_,_=self.fixture()
  for field,value in [('max_events',17),('max_events',True),('max_approvals',5),('max_approvals',0),('guardian_epoch','../rotated'),('guardian_epoch',7),('rpc','https://example.org'),('guardian_key_attachment','../key'),('guardian','uain1'+'0'*40),('start_event','01'),('start_event_digest','unexpected')]:
   with self.subTest(field=field,value=value),self.assertRaises(ValueError):m.validate_policy({**p,field:value})
 def test_automation_uses_serialized_custody_and_bounded_local_only_service(self):
  unit=configparser.ConfigParser(interpolation=None);unit.read(Path(__file__).with_name('uain-native-admission.service'));service=unit['Service']
  self.assertEqual(service['ExecStart'],'/usr/local/sbin/uain-custody auto-native-admission');self.assertEqual(service['User'],'root');self.assertEqual(service['UMask'],'0077');self.assertEqual(service['ProtectSystem'],'strict');self.assertEqual(service['IPAddressDeny'],'any');self.assertEqual(service['IPAddressAllow'],'localhost');self.assertEqual(service['CPUQuota'],'100%');self.assertEqual(service['MemoryMax'],'384M');self.assertEqual(service['KillMode'],'control-group');self.assertEqual(service['NoNewPrivileges'],'yes')
  timer=configparser.ConfigParser(interpolation=None);timer.read(Path(__file__).with_name('uain-native-admission.timer'));self.assertEqual(timer['Timer']['OnUnitInactiveSec'],'5s');self.assertEqual(timer['Timer']['Unit'],'uain-native-admission.service');self.assertNotIn('OnCalendar',timer['Timer'])
if __name__=='__main__':unittest.main()
