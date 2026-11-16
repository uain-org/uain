"""Fictional-key tests for the narrowly authorized two-member bootstrap."""
import base64,copy,datetime,importlib.util,json,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
import native_migration as native
enc=lambda x:base64.urlsafe_b64encode(x).decode().rstrip('=')
# Public snapshots captured 2026-11-04: activation-final-independent.json and
# earning-readonly-inventory.json. Raw compact rows and gateway projections differ.
PRODUCTION_SHAPES=json.loads('''{
  "policies": {
    "storage_activation": {
      "policy": "compact-state-v1",
      "effective_height": "1179279",
      "approved_by": "uain158ac8d0debcf01d43164ef14736597da589d8b54",
      "evidence_digest": "c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4"
    },
    "membership_activation": {
      "policy": "project-membership-v1",
      "effective_height": "1179287",
      "approved_by": "uain158ac8d0debcf01d43164ef14736597da589d8b54",
      "evidence_digest": "c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4"
    },
    "operator_reward_activation": {
      "policy": "pairwise-operator-rewards-v1",
      "effective_height": "1179313",
      "approved_by": "uain158ac8d0debcf01d43164ef14736597da589d8b54",
      "evidence_digest": "c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4"
    },
    "private_activation": {
      "policy": "orchard-v2-reviewed-otc-v1",
      "height": "1179362",
      "evidence_digest": "c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4",
      "relayer": "uain1215c651b70db82b70532a496c26fdf424f3bb369"
    },
    "coin_activation": {
      "policy": "verified-bounties-108t-micro-v1",
      "height": "1179371",
      "evidence_digest": "c8467e4fd7624d7744f6d44a947513b8e4d94becd6f5a7189ff55648384b6fe4"
    }
  },
  "guardian_projection": {
    "id": "uain158ac8d0debcf01d43164ef14736597da589d8b54",
    "public_key": "mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI",
    "name": "UAIN Review",
    "operator": "United AI Network (Rahul Jalan)",
    "family": "Codex",
    "licence": "active",
    "karma": "0",
    "credits": "16",
    "sequence": "471",
    "default_verifier": false,
    "creator": false,
    "active_projects": "0",
    "account_policy": "compact-account-v1",
    "metadata_digest": "97c5b2c5502ef708616f84d1e5b507093a7b20123998f1ec2df2a14f8bd72100"
  },
  "members": {
    "guardian": {
      "id": "uain158ac8d0debcf01d43164ef14736597da589d8b54",
      "public_key": "mDuiMoDUKg66PitMD-j1pztm81wOKlYq7nFFCWLXoRI",
      "name": "",
      "operator": "",
      "family": "",
      "licence": "active",
      "karma": 0,
      "credits": "16",
      "sequence": "471",
      "default_verifier": false,
      "creator": false,
      "active_projects": 0,
      "account_policy": "compact-account-v1",
      "metadata_digest": "97c5b2c5502ef708616f84d1e5b507093a7b20123998f1ec2df2a14f8bd72100"
    },
    "claude": {
      "id": "uain17fae025e2b7492156d438712aab8efcb4113b0fd",
      "public_key": "wpwtSOfm7XkVbHxuo5hXx6VOusc_DVFutMfYi8EiiWw",
      "name": "Claude (UAIN)",
      "operator": "United AI Network (Rahul Jalan)",
      "family": "Claude Code",
      "licence": "active",
      "karma": 132,
      "credits": "134",
      "sequence": "0",
      "default_verifier": false,
      "creator": false,
      "active_projects": 0
    }
  }
}''')
class BootstrapTests(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('bootstrap',Path(__file__).with_name('native_payment_bootstrap.py'));self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
  self.production_targets=copy.deepcopy(self.m.TARGETS)
  self.seeds={name:bytes([i])*32 for name,i in [('guardian',51),('claude',52)]}
  self.targets={name:dict(member='uain1'+native.sha(native.ed25519(seed)[0])[:40],public_key=enc(native.ed25519(seed)[0]),attachment=self.m.TARGETS[name]['attachment']) for name,seed in self.seeds.items()}
  self.p=patch.object(self.m,'TARGETS',self.targets);self.p.start();self.addCleanup(self.p.stop)
 def binding(self,name):
  m=self.m;target=self.targets[name]
  return dict(member=target['member'],did=m.did(target['member']),operator=m.OPERATOR,origin='member-derived',approved_by=target['member'],event_id='2',at='2026-11-04T00:00:00Z')
 def fixture(self,phase='identity'):
  m=self.m;now=int(time.time());records={'guardians':[self.targets['guardian']['member']],'guardian_epoch_current':None}
  actors={}
  for name,t in self.targets.items():
   member=dict(id=t['member'],public_key=t['public_key'],licence='active',sequence='17' if name=='guardian' else '4',karma=0 if name=='guardian' else 132,credits='16' if name=='guardian' else '134',creator=False,default_verifier=False)
   records['member/'+t['member']]=member
   binding=self.binding(name) if phase=='roles' else None
   records['actor_identity/'+t['member']+'/']=binding;records['actor_did/'+m.did(t['member'])]=t['member']+'/' if binding else None
   records['private_reviewer/'+t['member']]=None
   actors[name]={k:member[k] for k in ('sequence','karma','credits','creator','default_verifier')};actors[name].update(identity_sha256=m.record_hash(binding),private_reviewer_sha256=None)
  for key,actual in PRODUCTION_SHAPES['policies'].items():
   records[key]=copy.deepcopy(actual)
   if 'effective_height' in actual:records[key].update(effective_height='90',approved_by=self.targets['guardian']['member'])
   else:records[key]['height']='90'
  records[m.event_key(3)]=dict(id='3',command_digest='f'*64)
  e=dict(schema=m.EVIDENCE_SCHEMA,chain_id=m.CHAIN,genesis_sha256=m.GENESIS,state_sha256='b'*64,daemon_sha256='c'*64,operator=m.OPERATOR,authorization='Actual operator authorized these exact fictional bootstrap roles.',controls=m.CONTROLS,reviewer=dict(member=self.targets['claude']['member'],public_key=self.targets['claude']['public_key'],owned_key_qualified=True,orchard_qualified=True,service_available=False,service_status='Provider unavailable; appointment is not operational service.'),acceptance=[dict(path='/root/wallet-acceptance.json',sha256='d'*64)])
  raw=json.dumps(e).encode();a=dict(schema=m.APPROVAL_SCHEMA,epoch='1'*32,phase=phase,chain_id=m.CHAIN,genesis='/root/genesis.json',genesis_sha256=m.GENESIS,state_binary='/root/uain-state',state_sha256='b'*64,daemon_binary='/root/uaind',daemon_sha256='c'*64,evidence_sha256=m.sha(raw),actors=actors,expected_event_count='3',expected_last_command_digest='f'*64,expires_at=now+300,expires_height='180')
  s=dict(chain_id=m.CHAIN,height='100',event_count='3',header_time=datetime.datetime.fromtimestamp(now,datetime.timezone.utc).isoformat(),app_hash='a'*64,member=records['member/'+self.targets['guardian']['member']],records=records)
  return a,s,raw,now
 def custody(self):
  def attachment(vault,path):
   name=next(name for name,t in self.targets.items() if t['attachment']==path)
   return json.dumps(dict(public_key=self.targets[name]['public_key'],private_key=enc(self.seeds[name]))).encode()
  return SimpleNamespace(vault=Mock(return_value=object()),attachment=Mock(side_effect=attachment))
 def test_identity_exact_self_signers_separate_sequences_same_operator(self):
  a,s,raw,now=self.fixture();commands=self.m.validate(a,s,raw,now)
  self.assertEqual([(c['member'],c['sequence'],c['operation'],c['payload']) for c in commands],[(t['member'],a['actors'][n]['sequence'],'identity_claim',{'operator':self.m.OPERATOR}) for n,t in self.targets.items()])
  batch=self.m.sign_batch(self.custody(),a,s,raw,now)
  for e,c in zip(batch['envelopes'],commands):self.m.verify_envelope(e,c)
  self.assertFalse(batch['broadcast']);self.assertFalse(batch['private_keys_exported'])
  for seed in self.seeds.values():self.assertNotIn(enc(seed),json.dumps(batch))
 def test_roles_only_guardian_two_commands_no_karma_or_claude_default_verifier(self):
  a,s,raw,now=self.fixture('roles');commands=self.m.validate(a,s,raw,now)
  self.assertEqual([c['operation'] for c in commands],['roles','private_reviewer']);self.assertEqual([c['sequence'] for c in commands],['17','18'])
  self.assertTrue(all(c['member']==self.targets['guardian']['member'] for c in commands))
  self.assertEqual(commands[0]['payload'],dict(member=self.targets['guardian']['member'],creator=True,default_verifier=True,evidence_digest=a['evidence_sha256']))
  self.assertEqual(commands[1]['payload'],dict(member=self.targets['claude']['member'],active=True,evidence_digest=a['evidence_sha256']))
 def test_existing_exact_identity_is_skipped_but_wrong_or_imported_binding_fails(self):
  a,s,raw,now=self.fixture();t=self.targets['guardian'];b=self.binding('guardian');s['records']['actor_identity/'+t['member']+'/']=b;s['records']['actor_did/'+self.m.did(t['member'])]=t['member']+'/';a['actors']['guardian']['identity_sha256']=self.m.record_hash(b)
  self.assertEqual([c['member'] for c in self.m.validate(a,s,raw,now)],[self.targets['claude']['member']])
  for field,value in [('operator','Other operator'),('did','did:uain:123'),('origin','legacy-import'),('approved_by',self.targets['claude']['member']),('legacy_account_digest','a'*64),('instance','other')]:
   broken=copy.deepcopy(s);broken['records']['actor_identity/'+t['member']+'/'][field]=value;bad=copy.deepcopy(a);bad['actors']['guardian']['identity_sha256']=self.m.record_hash(broken['records']['actor_identity/'+t['member']+'/'])
   with self.subTest(field=field),self.assertRaises(ValueError):self.m.validate(bad,broken,raw,now)
 def test_role_binding_missing_reverse_collision_or_missing_proof_refused(self):
  for key,replace in [('actor_identity/',None),('actor_did/','wrong')]:
   a,s,raw,now=self.fixture('roles');t=self.targets['claude'];k=key+(t['member']+'/' if key=='actor_identity/' else self.m.did(t['member']));s['records'][k]=replace
   if key=='actor_identity/':a['actors']['claude']['identity_sha256']=None
   with self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
  a,s,raw,now=self.fixture();s['records'].pop('private_reviewer/'+self.targets['claude']['member'])
  with self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
 def test_changed_before_state_expiry_frontier_epoch_licence_and_policy_refused(self):
  changes=[lambda s:s['member'].update(sequence='18'),lambda s:s['member'].update(creator=True),lambda s:s['records']['member/'+self.targets['claude']['member']].update(karma=99),lambda s:s['records']['member/'+self.targets['claude']['member']].update(public_key=self.targets['guardian']['public_key']),lambda s:s['member'].update(licence='revoked'),lambda s:s['records'].update(guardians=[]),lambda s:s['records'].update(guardian_epoch_current='1'),lambda s:s.update(event_count='4'),lambda s:s.update(header_time='2000-01-01T00:00:00Z'),lambda s:s['records']['coin_activation'].update(evidence_digest='0'*64),lambda s:s['records'][self.m.event_key(3)].update(command_digest='0'*64)]
  for change in changes:
   a,s,raw,now=self.fixture('roles');change(s)
   with self.subTest(change=change),self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
  for field,value in [('phase','mint'),('expires_at',0),('expires_height','101'),('epoch','x'),('extra',True)]:
   a,s,raw,now=self.fixture();a[field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
 def test_even_approved_low_karma_or_prior_role_override_refused(self):
  for key,value in [('karma',99),('default_verifier',True)]:
   a,s,raw,now=self.fixture('roles');s['records']['member/'+self.targets['claude']['member']][key]=value;a['actors']['claude'][key]=value
   with self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
 def test_false_independence_or_unqualified_reviewer_evidence_refused(self):
  for change in [lambda e:e.update(operator='Independent Claude'),lambda e:e['controls'].update(independent_operators=True),lambda e:e['reviewer'].update(owned_key_qualified=False),lambda e:e['reviewer'].update(orchard_qualified=False),lambda e:e['reviewer'].update(member=self.targets['guardian']['member']),lambda e:e.update(acceptance=[])]:
   a,s,raw,now=self.fixture();e=json.loads(raw);change(e);raw=json.dumps(e).encode();a['evidence_sha256']=self.m.sha(raw)
   with self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
 def test_both_actual_seeds_required_not_just_public_key_metadata(self):
  a,s,raw,now=self.fixture()
  for name in self.targets:
   custody=self.custody();original=custody.attachment.side_effect
   custody.attachment.side_effect=lambda vault,path:json.dumps(dict(public_key=self.targets[name]['public_key'],private_key=enc(bytes(32)))).encode() if path==self.targets[name]['attachment'] else original(vault,path)
   with self.subTest(name=name),self.assertRaises(ValueError):self.m.sign_batch(custody,a,s,raw,now)
 def memory_store(self):
  store={}
  def load(path):
   if Path(path).name not in store:raise FileNotFoundError(path)
   return copy.deepcopy(store[Path(path).name])
  def write(path,value):store[Path(path).name]=copy.deepcopy(value)
  return store,load,write
 def test_preflight_no_sign_durable_retention_no_resign_even_after_expiry(self):
  a,s,raw,now=self.fixture();store,load,write=self.memory_store();custody=self.custody()
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch',wraps=self.m.sign_batch) as signer:
   self.assertEqual(self.m.process(custody,a,raw,s,Path('/root/test'),load=load,write=write,now=now)['status'],'preflight');signer.assert_not_called();self.assertFalse(store)
   first=self.m.process(custody,a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
   second=self.m.process(custody,a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now+900)
   self.assertEqual(first['public_envelopes_sha256'],second['public_envelopes_sha256']);self.assertEqual(signer.call_count,1)
 def test_marker_failure_or_uncertain_journal_never_signs(self):
  a,s,raw,now=self.fixture();store,load,write=self.memory_store()
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch') as signer:
   with self.assertRaises(OSError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=Mock(side_effect=OSError('fsync')),now=now)
   store['journal.json']=dict(schema=self.m.JOURNAL_SCHEMA,status='signing_started',approval_sha256=self.m.sha(self.m.canonical(a).encode()))
   with self.assertRaises(ValueError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
   signer.assert_not_called()
 def test_orphan_and_tampered_envelopes_fail_closed(self):
  a,s,raw,now=self.fixture();batch=self.m.sign_batch(self.custody(),a,s,raw,now);store,load,write=self.memory_store();store['signed.json']=batch
  with patch.object(self.m,'validate_artifacts'),self.assertRaises(ValueError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
  for mutation in [lambda b:b['envelopes'][0]['command'].update(operation='coin_claim'),lambda b:b['envelopes'][0].update(public_key=self.targets['claude']['public_key']),lambda b:b['envelopes'][0]['command']['payload'].update(operator='Other')]:
   b=copy.deepcopy(batch);mutation(b)
   with self.assertRaises(ValueError):self.m.retained(a,raw,b)
 def test_expiry_during_key_loading_prevents_any_signature(self):
  a,s,raw,now=self.fixture();custody=self.custody();clock=[now]
  original=custody.attachment.side_effect
  def attachment(vault,path):
   result=original(vault,path);clock[0]=now+301;return result
  custody.attachment.side_effect=attachment
  with patch.object(self.m.time,'time',side_effect=lambda:clock[0]),patch.object(self.m,'verify_envelope') as signed:
   with self.assertRaises(ValueError):self.m.sign_batch(custody,a,s,raw)
   signed.assert_not_called()
 def test_retained_exact_bytes_recover_after_final_journal_write_failure(self):
  a,s,raw,now=self.fixture('roles');store,load,write=self.memory_store();count=[0]
  def crashing_write(path,value):
   count[0]+=1
   if count[0]==3:raise OSError('final fsync failed')
   write(path,value)
  with patch.object(self.m,'validate_artifacts'),patch.object(self.m,'sign_batch',wraps=self.m.sign_batch) as signer:
   with self.assertRaises(OSError):self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=crashing_write,now=now)
   before=copy.deepcopy(store['signed.json'])
   result=self.m.process(self.custody(),a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now+900)
   self.assertEqual(result['status'],'retained');self.assertEqual(store['signed.json'],before);self.assertEqual(signer.call_count,1);self.assertEqual(store['journal.json']['status'],'signed')
 def test_selection_is_bounded_and_every_selected_proof_is_required(self):
  a,s,raw,now=self.fixture();selected=self.m.selection(a)
  self.assertLessEqual(len(selected['keys']),32);self.assertEqual(len(selected['keys']),len(set(selected['keys'])))
  for key in selected['keys']:
   broken=copy.deepcopy(s);broken['records'].pop(key)
   with self.subTest(key=key),self.assertRaises(ValueError):self.m.validate(a,broken,raw,now)
 def test_fractional_headers_supported_and_sequence_overflow_refused(self):
  a,s,raw,now=self.fixture()
  for digits in range(1,10):
   s['header_time']=datetime.datetime.fromtimestamp(now,datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')+'.'+'123456789'[:digits]+'Z'
   self.assertEqual(len(self.m.validate(a,s,raw,now)),2)
  a,s,raw,now=self.fixture('roles');a['actors']['guardian']['sequence']=str(2**64-2);s['member']['sequence']=str(2**64-2)
  with self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
 def test_unpinned_artifacts_refused_before_key_access(self):
  a,s,raw,now=self.fixture();custody=self.custody();_,load,write=self.memory_store()
  with patch.object(self.m.financial,'read_public',return_value=b'changed artifact'):
   with self.assertRaises(ValueError):self.m.process(custody,a,raw,s,Path('/root/test'),execute=True,load=load,write=write,now=now)
  custody.vault.assert_not_called()
 def test_exact_production_policy_records_and_gateway_projection(self):
  self.targets=self.production_targets
  with patch.object(self.m,'TARGETS',self.targets):
   a,s,raw,now=self.fixture()
   s['records'].update(copy.deepcopy(PRODUCTION_SHAPES['policies']))
   s['height']='1180555';a['expires_height']='1180635'
   s['member']=copy.deepcopy(PRODUCTION_SHAPES['guardian_projection'])
   for name,member in PRODUCTION_SHAPES['members'].items():
    s['records']['member/'+member['id']]=copy.deepcopy(member)
    for key in ('sequence','karma','credits','creator','default_verifier'):a['actors'][name][key]=member[key]
   self.assertIsInstance(s['member']['karma'],str)
   self.assertIsInstance(s['records']['member/'+self.targets['guardian']['member']]['karma'],int)
   self.assertEqual(len(self.m.validate(a,s,raw,now)),2)
 def test_projection_binding_and_each_native_policy_schema_are_checked(self):
  for field,value in [('id',self.targets['claude']['member']),('public_key',self.targets['claude']['public_key']),('licence','revoked'),('sequence','99')]:
   a,s,raw,now=self.fixture();s['member']=copy.deepcopy(s['member']);s['member'][field]=value
   with self.subTest(field=field),self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
  for key in self.m.POLICIES:
   for change in ['wrong-height','unexpected-field','wrong-digest']:
    a,s,raw,now=self.fixture();marker=s['records'][key]
    if change=='wrong-height':marker['height' if 'height' in marker else 'effective_height']='101'
    elif change=='unexpected-field':marker['unexpected']=True
    else:marker['evidence_digest']='0'*64
    with self.subTest(key=key,change=change),self.assertRaises(ValueError):self.m.validate(a,s,raw,now)
if __name__=='__main__':unittest.main()
