"""Narrow activation authorization tests: fictional identities, real Ed25519."""
import base64,copy,datetime,hashlib,importlib.util,json,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch,Mock

PATH=Path(__file__).with_name('native_financial_activation.py')
enc=lambda value:base64.urlsafe_b64encode(value).decode().rstrip('=')
class FinancialActivationTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('native_financial_activation',PATH)
  self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.seeds=[bytes([i])*32 for i in (31,32)]
  self.public=[self.m.native.ed25519(seed)[0] for seed in self.seeds]
  self.ids=['uain1'+hashlib.sha256(raw).hexdigest()[:40] for raw in self.public]
  self.keys=[enc(raw) for raw in self.public]
  self.patch=patch.multiple(self.m,GUARDIAN=self.ids[0],RELAY_BINDINGS={'keys/neuroetch-key.json':(self.ids[1],self.keys[1])});self.patch.start();self.addCleanup(self.patch.stop)
 def fixture(self,phase='foundation'):
  m=self.m;now=int(time.time())
  evidence=dict(schema=m.EVIDENCE_SCHEMA,chain_id=m.CHAIN,genesis_sha256=m.GENESIS,state_sha256='b'*64,daemon_sha256='c'*64,relayer=self.ids[1],relayer_public_key=self.keys[1],authorization='Explicit fictional operator authorization',orchard_qualified=True,acceptance=[dict(path='/root/reviewed-acceptance.json',sha256='d'*64)],limitations=m.LIMITATIONS)
  raw=json.dumps(evidence).encode()
  approval=dict(schema=m.APPROVAL_SCHEMA,epoch='1'*32,phase=phase,chain_id=m.CHAIN,genesis='/root/genesis.json',genesis_sha256=m.GENESIS,state_binary='/root/uain-state',state_sha256='b'*64,daemon_binary='/root/uaind',daemon_sha256='c'*64,guardian=self.ids[0],guardian_public_key=self.keys[0],guardian_key_attachment='keys/uain-review-key.json',relayer=self.ids[1],relayer_public_key=self.keys[1],relayer_key_attachment='keys/neuroetch-key.json',evidence_sha256=hashlib.sha256(raw).hexdigest(),predecessor_evidence={},starting_sequence='17',expected_event_count='3',expected_last_command_digest='f'*64,expires_at=now+300,expires_height='180')
  records={k:None for k in m.POLICY_KEYS};records.update(guardians=[self.ids[0]],guardian_epoch_current=None)
  records['member/'+self.ids[1]]=dict(id=self.ids[1],public_key=self.keys[1],licence='active')
  records[m.event_key(3)]=dict(id='3',command_digest='f'*64)
  for key in m.PREDECESSORS[phase]:
   records[key]=dict(policy=m.POLICIES[key],effective_height='90',approved_by=self.ids[0],evidence_digest='e'*64)
   approval['predecessor_evidence'][key]='e'*64
  state=dict(chain_id=m.CHAIN,height='100',event_count='3',header_time=datetime.datetime.now(datetime.timezone.utc).isoformat(),app_hash='a'*64,member=dict(id=self.ids[0],public_key=self.keys[0],licence='active',sequence='17'),records=records)
  return approval,state,raw,now
 def test_exact_each_phase_only_supported_policy_commands_and_no_mint(self):
  for phase,ops in [('foundation',['activate_storage','activate_membership']),('operators',['activate_operator_rewards']),('economy',['activate_private_exchange','activate_coin'])]:
   a,s,raw,now=self.fixture(phase);commands=self.m.validate(a,s,raw,now=now)
   self.assertEqual([c['operation'] for c in commands],ops)
   self.assertEqual([c['sequence'] for c in commands],[str(17+i) for i in range(len(ops))])
   for c in commands:self.assertEqual(c['payload']['evidence_digest'],a['evidence_sha256']);self.assertNotIn('amount',c['payload'])
   if phase=='economy':self.assertEqual(commands[0]['payload']['relayer'],self.ids[1])
 def test_real_native_nanosecond_header_timestamps_remain_usable(self):
  a,s,raw,now=self.fixture()
  for length in range(1,10):
   s['header_time']=datetime.datetime.fromtimestamp(now,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')+'.'+'123456789'[:length]+'Z'
   with self.subTest(fractional_digits=length):self.assertEqual(len(self.m.validate(a,s,raw,now=now)),2)
 def test_changed_root_approval_or_evidence_is_refused(self):
  for field,value in [('phase','mint'),('guardian',self.ids[1]),('guardian_key_attachment','keys/neuroetch-key.json'),('relayer',self.ids[0]),('relayer_key_attachment','keys/new-key.json'),('starting_sequence','18'),('expected_event_count','4'),('expected_last_command_digest','a'*64),('expires_height','201'),('expires_height','100'),('expires_at',1),('genesis_sha256','0'*64),('chain_id','different')]:
   a,s,raw,now=self.fixture();a[field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):self.m.validate(a,s,raw,now=now)
  a,s,raw,now=self.fixture()
  with self.assertRaises(ValueError):self.m.validate(a,s,raw+b' ',now=now)
  a['operation']='coin_claim'
  with self.assertRaises(ValueError):self.m.validate(a,s,raw,now=now)
 def test_stale_future_changed_guardian_relayer_and_missing_proven_absence_fail_closed(self):
  changes=[lambda s:s.update(header_time='2000-01-01T00:00:00Z'),lambda s:s.update(header_time='2100-01-01T00:00:00Z'),lambda s:s['member'].update(licence='revoked'),lambda s:s['records'].update(guardians=[]),lambda s:s['records'].update(guardian_epoch_current='1'),lambda s:s['records']['member/'+self.ids[1]].update(licence='revoked'),lambda s:s['records']['member/'+self.ids[1]].update(public_key=self.keys[0]),lambda s:s['records'].pop('coin_supply'),lambda s:s['records'].update(coin_supply=dict(minted='0')),lambda s:s['records'].update(private_frontier=dict(count=0)),lambda s:s['records'].update(storage_activation={})]
  for change in changes:
   a,s,raw,now=self.fixture();change(s)
   with self.subTest(change=change),self.assertRaises(ValueError):self.m.validate(a,s,raw,now=now)
 def test_predecessors_require_exact_reviewed_policy_digest_and_effective_height(self):
  for mutate in [lambda r:r.update(policy='other'),lambda r:r.update(evidence_digest='0'*64),lambda r:r.update(effective_height='101'),lambda r:r.update(approved_by=self.ids[1])]:
   a,s,raw,now=self.fixture('economy');mutate(s['records']['storage_activation'])
   with self.assertRaises(ValueError):self.m.validate(a,s,raw,now=now)
 def custody(self):
  contents={'keys/uain-review-key.json':dict(private_key=enc(self.seeds[0]),public_key=self.keys[0]),'keys/neuroetch-key.json':dict(private_key=enc(self.seeds[1]),public_key=self.keys[1])}
  return SimpleNamespace(vault=Mock(return_value=object()),attachment=lambda vault,name:json.dumps(contents[name]).encode())
 def test_relayer_missing_or_wrong_seed_cannot_lock_activation_to_unusable_key(self):
  a,s,raw,now=self.fixture('economy')
  for relay in [dict(public_key=self.keys[1]),dict(public_key=self.keys[1],private_key=enc(self.seeds[0]))]:
   custody=self.custody();original=custody.attachment
   custody.attachment=lambda vault,name:json.dumps(relay).encode() if name=='keys/neuroetch-key.json' else original(vault,name)
   with self.assertRaises(ValueError):self.m.sign_batch(custody,a,s,raw,now=now)
 def test_signs_only_validated_batch_in_process_and_returns_public_envelopes(self):
  a,s,raw,now=self.fixture('economy');custody=self.custody();batch=self.m.sign_batch(custody,a,s,raw,now=now)
  self.assertEqual(len(batch['envelopes']),2)
  for envelope,command in zip(batch['envelopes'],self.m.validate(a,s,raw,now=now)):self.m.verify_envelope(a,envelope,command)
  self.assertNotIn(enc(self.seeds[0]),json.dumps(batch));self.assertNotIn(enc(self.seeds[1]),json.dumps(batch))
  self.assertFalse(batch['private_keys_exported']);self.assertFalse(batch['broadcast'])
 def test_preflight_does_not_sign_and_retained_batch_never_resigns(self):
  a,s,raw,now=self.fixture();custody=self.custody();store={}
  def load(path):
   if Path(path).name not in store:raise FileNotFoundError(path)
   return copy.deepcopy(store[Path(path).name])
  def write(path,value):store[Path(path).name]=copy.deepcopy(value)
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch',wraps=self.m.sign_batch) as signer:
   plan=self.m.process(custody,a,raw,s,Path('/root/test'),execute=False,load=load,write=write,now=now)
   self.assertEqual(plan['commands_signed'],0);self.assertEqual(store,{});signer.assert_not_called()
   first=self.m.process(custody,a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
   second=self.m.process(custody,a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
   self.assertEqual(first['public_envelopes_sha256'],second['public_envelopes_sha256']);self.assertEqual(signer.call_count,1)
 def test_crash_after_signing_started_never_silently_resigns(self):
  a,s,raw,now=self.fixture();store={'journal.json':dict(schema=self.m.JOURNAL_SCHEMA,status='signing_started',approval_sha256=self.m.sha(self.m.canonical(a).encode()))}
  def load(path):
   if Path(path).name not in store:raise FileNotFoundError(path)
   return store[Path(path).name]
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch') as signer:
   with self.assertRaises(ValueError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=lambda p,v:None,now=now)
   signer.assert_not_called()
 def test_orphaned_signed_artifact_without_journal_cannot_be_overwritten(self):
  a,s,raw,now=self.fixture();batch=self.m.sign_batch(self.custody(),a,s,raw,now=now)
  def load(path):
   if Path(path).name=='signed.json':return batch
   raise FileNotFoundError(path)
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch') as signer:
   with self.assertRaises(ValueError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=lambda p,v:None,now=now)
   signer.assert_not_called()
 def test_tampered_retained_batch_never_becomes_a_signing_or_transfer_path(self):
  a,s,raw,now=self.fixture();batch=self.m.sign_batch(self.custody(),a,s,raw,now=now)
  for mutate in [lambda b:b['envelopes'][0]['command'].update(operation='coin_claim'),lambda b:b['envelopes'][0]['command']['payload'].update(amount='100'),lambda b:b['envelopes'][0].update(signature='A'*86)]:
   bad=copy.deepcopy(batch);mutate(bad)
   with self.assertRaises(Exception):self.m.retained(a,raw,bad)
 def test_failed_durable_signing_marker_cannot_touch_guardian_signer(self):
  a,s,raw,now=self.fixture()
  def load(path):raise FileNotFoundError(path)
  def write(path,value):raise OSError('fictional fsync failure')
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch') as signer:
   with self.assertRaises(OSError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
   signer.assert_not_called()
 def test_unsafe_json_and_fabricated_acceptance_flags_are_refused(self):
  for change in [lambda e:e.update(orchard_qualified=False),lambda e:e.update(acceptance=[]),lambda e:e['limitations'].update(premint=True),lambda e:e.update(authorization='')]:
   a,s,raw,now=self.fixture();e=json.loads(raw);change(e);raw=json.dumps(e).encode();a['evidence_sha256']=self.m.sha(raw)
   with self.assertRaises(ValueError):self.m.validate(a,s,raw,now=now)
if __name__=='__main__':unittest.main()
