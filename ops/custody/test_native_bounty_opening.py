"""Fictional, isolated four-command preparation tests. No native RPC or vault."""
import base64,copy,datetime,json,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import native_bounty_opening as b

class BountyTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='fictional-bounty-');self.addCleanup(self.temp.cleanup);self.directory=Path(self.temp.name);self.now=time.time();self.clock=self.now
  seed=bytes(range(32));public,_=b.native.ed25519(seed);self.public=base64.urlsafe_b64encode(public).decode().rstrip('=');self.guardian='uain1'+b.sha(public)[:40]
  self.addCleanup(patch.stopall);patch.object(b,'PUBLIC',self.public).start();patch.object(b,'GUARDIAN',self.guardian).start();patch.object(b.time,'time',lambda:self.clock).start();self.artifacts=patch.object(b.financial,'validate_artifacts').start()
  date=datetime.datetime.fromtimestamp(self.now-1,datetime.timezone.utc).isoformat();source=dict(release='fictional-release-20261104',version='fixture-only',manifest_sha256='a'*64,package_sha256='b'*64,materials_manifest_sha256='c'*64,access_url='https://baink.money/api/native/earning/materials/'+b.TASK)
  criteria=('Fictional post-opening original model only. Prior art and known fixes must be distinguished. Independent checkers verify finite bounds, non-vacuity and any original counterexample against frozen source. No demo, known answer, existing test or pre-opening result earns an award. Release '+source['release']+' manifest '+source['manifest_sha256']+' materials '+source['materials_manifest_sha256'])
  self.e=dict(schema=b.EVIDENCE_SCHEMA,authorization='Explicitly fictional preparation authorization for isolated tests only.',source=source,prior_art=dict(basis='This fictional scoped problem has no known exact model in the isolated test evidence; no production prior-art conclusion.',searches=['fictional exact scoped model search','fictional related primary-source search'],reviewed_at=date,reviewer='Fictional root reviewer',artifact_sha256='d'*64),criteria=criteria,criteria_sha256=b.sha(criteria.encode()),access=dict(available=True,authenticated=True,verified_at=date,receipt_sha256='e'*64),acceptance=[dict(path='/fixture/prior.json',sha256='d'*64),dict(path='/fixture/source-access.json',sha256='e'*64),dict(path='/fixture/release-manifest.json',sha256='a'*64),dict(path='/fixture/review-source.zip',sha256='b'*64),dict(path='/fixture/materials.json',sha256='c'*64)],limitations=copy.deepcopy(b.LIMITATIONS),novelty_scope='exact-new-model-or-original-counterexample-only')
  self.raw=b.canonical(self.e).encode();self.a=dict(schema=b.APPROVAL_SCHEMA,epoch='1'*32,chain_id=b.CHAIN,genesis='/fixture/genesis',genesis_sha256=b.GENESIS,state_binary='/fixture/uain-state',state_sha256='136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860',daemon_binary='/fixture/uaind',daemon_sha256='715a3a6b19c7a844111ba6fe3fd63da97ad8145c386e2b076383fd348a3b5160',guardian_public_key=self.public,evidence_sha256=b.sha(self.raw),starting_sequence='7',expected_event_count='10',expected_last_command_digest='f'*64,expires_at=int(self.now)+1800,expires_height='190',guardian_baseline=dict(karma=0,credits='16',active_projects=0,creator=True,default_verifier=True),supply_baseline=dict(minted='0',reserved='0',transparent='0',shielded='0'))
  self.custody=SimpleNamespace(vault=Mock(return_value='fictional-vault'),attachment=Mock(return_value=json.dumps(dict(public_key=self.public,private_key=base64.urlsafe_b64encode(seed).decode().rstrip('='))).encode()))
 def refresh_evidence(self):self.raw=b.canonical(self.e).encode();self.a['evidence_sha256']=b.sha(self.raw)
 def state(self,done=0):
  records={k:dict(policy=value,evidence_digest='c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4',**(dict(height='10',**(dict(relayer='uain1215c651b70db82b70532a496c26fdf424f3bb369') if k=='private_activation' else {})) if k in ('private_activation','coin_activation') else dict(effective_height='11',approved_by=self.guardian))) for k,value in b.financial.POLICIES.items()}
  member=dict(id=self.guardian,public_key=self.public,licence='active',sequence=str(7+done),**copy.deepcopy(self.a['guardian_baseline']));member['active_projects']+=int(done>=1)
  records.update({'guardians':[self.guardian],'guardian_epoch_current':None,'member/'+self.guardian:member,'coin_supply':dict(self.a['supply_baseline'],reserved=b.AMOUNT if done==4 else '0'),'project/'+b.PROJECT:None,'task/'+b.TASK:None,'coin_quote/'+b.TASK:None,'coin_reservation/'+b.TASK:None,b.admission.event_key(10):dict(id='10',command_digest='f'*64)})
  if done>=1:records['project/'+b.PROJECT]=dict(id=b.PROJECT,lead=self.guardian,state='active',budget='0',storage_policy='compact-state-v1')
  if done>=2:records['task/'+b.TASK]=dict(id=b.TASK,project=b.PROJECT,state='open',karma_reward=1,credit_reward='1',verifiers_required=2,kind='instant',winner='',submissions=[])
  if done>=3:records['coin_quote/'+b.TASK]=dict(task=b.TASK,amount=b.AMOUNT,manager=self.guardian,open_event='00000000000000000012',evidence_digest=self.a['evidence_sha256'])
  if done>=4:records['coin_reservation/'+b.TASK]=dict(task=b.TASK,amount=b.AMOUNT,state='reserved',evidence_digest=self.a['evidence_sha256'])
  for i,c in enumerate(b.commands(self.a,self.e)[:done]):records[b.admission.event_key(11+i)]=dict(id=str(11+i),height='90',member=self.guardian,operation=c['operation'],subject=b.PROJECT if i==0 else b.TASK,command_digest=b.sha(b.native.signing_bytes(c)))
  return dict(chain_id=b.CHAIN,height='100',header_time=datetime.datetime.fromtimestamp(self.clock,datetime.timezone.utc).isoformat(),app_hash='9'*64,event_count=str(10+done),member=copy.deepcopy(member),records=records)
 def load(self,path):return b.native.strict_json(Path(path).read_bytes())
 def write(self,path,value):Path(path).write_text(b.canonical(value))
 def batch(self):return b.sign_batch(self.custody,self.a,self.raw,self.state())
 def runtime(self,lost=False):
  case=self
  class Runtime:
   def __init__(self):self.done=0;self.sends=[]
   def read(self,selection):
    state=case.state(self.done)
    for key in selection['keys']:state['records'].setdefault(key,None)
    if selection.get('receipt'):
     receipt=selection['receipt'];case.assertNotIn(b.admission.event_key(int(receipt['event_id'])),selection['keys'],'The actual gateway appends the receipt event key and rejects duplicates');event=state['records'][b.admission.event_key(int(receipt['event_id']))];state['receipt']=dict(authority='native',finalized=True,chain_id=b.CHAIN,state_height=state['height'],app_hash=state['app_hash'],event=event)
    return state
   def broadcast(self,envelope):
    self.sends.append(envelope);b.admission.verify_envelope(dict(guardian_public_key=case.public),envelope,b.commands(case.a,case.e)[self.done])
    if lost:raise RuntimeError('Fictional lost response; no evidence of inclusion')
    self.done+=1;return 0
  return Runtime()
 def test_fixed_scope_four_payloads_and_no_mint_claim_transfer_or_arbitrary_reward(self):
  b.validate(self.a,self.raw,self.state());commands=b.commands(self.a,self.e);self.assertEqual([c['operation'] for c in commands],['open_project','open_task','coin_quote','coin_reserve']);self.assertEqual(commands[0]['payload']['id'],b.PROJECT);task=commands[1]['payload'];self.assertEqual((task['id'],task['karma_reward'],task['credit_reward'],task['verifiers_required'],task['kind']),(b.TASK,1,'1',2,'instant'));self.assertEqual(commands[2]['payload']['amount'],'1000000');self.assertEqual(commands[2]['payload']['open_event'],'00000000000000000012')
  for field in ('arbitrary_member','amount','task','mint'):
   altered=dict(self.a,**{field:'forbidden'})
   with self.assertRaises(ValueError):b.approval(altered)
 def test_source_access_scope_prior_art_and_frozen_criteria_required(self):
  for alter in [lambda e:e['access'].update(available=False),lambda e:e['access'].update(authenticated=False),lambda e:e['source'].update(access_url='https://baink.money/api/native/earning/materials/other'),lambda e:e['prior_art'].update(searches=['one']),lambda e:e.update(criteria='Known demo'),lambda e:e['limitations'].update(mint=0)]:
   old=copy.deepcopy(self.e);alter(self.e);self.refresh_evidence()
   with self.assertRaises(ValueError):b.validate(self.a,self.raw,self.state())
   self.e=old;self.refresh_evidence()
  self.custody.attachment.assert_not_called()
 def test_prior_art_whitespace_cannot_pass_preflight_then_fail_native_basis_rules(self):
  for change in [dict(basis=' '*40),dict(searches=['query',' query '])]:
   old=copy.deepcopy(self.e['prior_art']);self.e['prior_art'].update(change);self.refresh_evidence()
   with self.assertRaises(ValueError):b.validate(self.a,self.raw,self.state())
   self.e['prior_art']=old;self.refresh_evidence()
 def test_changed_actor_policy_supply_nonce_event_or_existing_targets_refuses_before_key_use(self):
  for alter in [lambda s:s['records']['member/'+self.guardian].update(sequence='8'),lambda s:s.update(event_count='11'),lambda s:s['records']['coin_activation'].update(evidence_digest='0'*64),lambda s:s['records']['coin_supply'].update(minted='1',transparent='1'),lambda s:s['records'].update({'project/'+b.PROJECT:{}}),lambda s:s['records']['member/'+self.guardian].update(credits='17')]:
   state=self.state();alter(state)
   with self.assertRaises(ValueError):b.validate(self.a,self.raw,state)
  self.custody.attachment.assert_not_called()
 def test_preflight_never_reads_secret_and_signing_retains_exact_public_batch(self):
  result=b.sign_once(self.custody,self.a,self.raw,self.state(),self.directory,load=self.load,write=self.write);self.assertEqual(result['commands_signed'],0);self.custody.attachment.assert_not_called()
  signed=b.sign_once(self.custody,self.a,self.raw,self.state(),self.directory,execute=True,load=self.load,write=self.write);self.assertEqual(signed['commands_signed'],4);self.custody.attachment.assert_called_once();batch=self.load(self.directory/'signed.json');b.verify_batch(self.a,self.raw,batch)
  self.assertEqual(b.sign_once(self.custody,self.a,self.raw,self.state(),self.directory,execute=True,load=self.load,write=self.write)['status'],'retained');self.custody.attachment.assert_called_once();self.assertNotIn('\"private_key\":',(self.directory/'signed.json').read_text());self.assertNotIn(base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip('='),(self.directory/'signed.json').read_text())
 def test_signing_uncertainty_retains_marker_and_never_resigns(self):
  self.custody.attachment.side_effect=RuntimeError('Fictional custody interruption')
  with self.assertRaises(RuntimeError):b.sign_once(self.custody,self.a,self.raw,self.state(),self.directory,execute=True,load=self.load,write=self.write)
  with self.assertRaises(FileNotFoundError):b.sign_once(self.custody,self.a,self.raw,self.state(),self.directory,execute=True,load=self.load,write=self.write)
  self.custody.attachment.assert_called_once()
 def test_four_exact_receipts_open_price_and_reserve_only_preserving_supply_and_rewards(self):
  batch=self.batch();runtime=self.runtime();result=b.submit_once(self.a,self.raw,batch,self.directory,runtime,load=self.load,write=self.write);self.assertTrue(result['complete']);self.assertEqual(len(runtime.sends),4);self.assertFalse(result['mint']);self.assertFalse(result['claim']);self.assertFalse(result['independent_operators_established']);self.assertEqual(runtime.read(b.selection(self.a))['records']['coin_supply'],dict(minted='0',reserved='1000000',transparent='0',shielded='0'))
  self.clock=self.a['expires_at']+1;again=b.submit_once(self.a,self.raw,batch,self.directory,runtime,load=self.load,write=self.write);self.assertTrue(again['complete']);self.assertEqual(len(runtime.sends),4)
 def test_unknown_send_never_retries_after_runtime_or_submitter_restart(self):
  batch=self.batch();runtime=self.runtime(lost=True);first=b.submit_once(self.a,self.raw,batch,self.directory,runtime,load=self.load,write=self.write);self.assertFalse(first['complete']);self.assertEqual(len(runtime.sends),1);b.submit_once(self.a,self.raw,batch,self.directory,runtime,load=self.load,write=self.write);self.assertEqual(len(runtime.sends),1)
 def test_expiry_after_durable_marker_prevents_broadcast_and_does_not_retry(self):
  self.a['expires_at']=int(self.now)+1;batch=self.batch();runtime=self.runtime();writes=0
  def write(path,value):
   nonlocal writes
   self.write(path,value);writes+=1
   if writes==2:self.clock=self.now+2
  result=b.submit_once(self.a,self.raw,batch,self.directory,runtime,load=self.load,write=write);self.assertEqual(result['status'],'not-broadcast');self.assertEqual(runtime.sends,[])
 def test_altered_signature_payload_or_materials_evidence_is_not_a_retained_batch(self):
  batch=self.batch();changed=copy.deepcopy(batch);changed['envelopes'][2]['command']['payload']['amount']='1000000000'
  with self.assertRaises(ValueError):b.verify_batch(self.a,self.raw,changed)
  changed=copy.deepcopy(batch);changed['envelopes'][0]['signature']='x'*86
  with self.assertRaises(Exception):b.verify_batch(self.a,self.raw,changed)
  self.e['source']['package_sha256']='0'*64;self.refresh_evidence()
  with self.assertRaises(ValueError):b.verify_batch(self.a,self.raw,batch)
 def test_stale_headers_expired_access_or_approval_are_not_source_readiness(self):
  state=self.state();state['header_time']=(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=121)).isoformat()
  with self.assertRaises(ValueError):b.validate(self.a,self.raw,state)
  self.clock=self.now+3601
  with self.assertRaises(ValueError):b.validate(self.a,self.raw,self.state())

if __name__=='__main__':unittest.main()
