"""Custody migration authorization tests use generated fictional keys only."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('native_migration',Path(__file__).with_name('native_migration.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class NativeMigrationTests(unittest.TestCase):
 def fixture(self):
  member='uain1'+'1'*40; checkpoint={'event_count':'0','last_command_digest':'','accounts_digest':'a'*64}
  record={'key':'legacy/reconciliation','value':'{"text":"<&é>"}','proof':[]}
  leaf=hashlib.sha256(('uain:legacy-record:v1\n0\n'+record['key']+'\n'+hashlib.sha256(record['value'].encode()).hexdigest()).encode()).hexdigest()
  base={'manifest_digest':'b'*64,'records_root':leaf,'total_records':'1','accounts':'1','ledger_head':'c'*64,'last_event_id':'4'}
  steps=[('legacy_adopt',{**base,'native_checkpoint':checkpoint,'pinned_public_key':'fictional-public-pin-only'}),('legacy_begin',base),('legacy_page',{'start':'0','records':[record]}),('legacy_finish',{}),('legacy_claim_account',{'member':member})]
  commands=[dict(version=1,chain_id=m.CHAIN,member=member,sequence=str(i),expires_height='600',operation=op,payload=p) for i,(op,p) in enumerate(steps)]
  plan={'schema':m.PLAN_SCHEMA,'epoch':'1'*32,'commands':commands}; raw=json.dumps(plan,ensure_ascii=False).encode()
  approval={'schema':m.APPROVAL_SCHEMA,'epoch':plan['epoch'],'plan_sha256':hashlib.sha256(raw).hexdigest(),'guardian':member,'guardian_public_key':'fictional','genesis_sha256':m.GENESIS,'state_binary_sha256':'e'*64,'source_manifest_digest':base['manifest_digest'],'records_root':leaf,'native_checkpoint':checkpoint,'expected_event_count':'0','expected_last_command_digest':'','claim_members':[member],'starting_sequence':'0','expires_at':2000}
  state={'chain_id':m.CHAIN,'height':'100','event_count':'0','member':{'id':member,'public_key':'fictional','sequence':'0','licence':'active'},'records':{'guardians':[member],'guardian_epoch_current':None,'legacy_adoption':None,'legacy_import':None,'legacy_account_claimed/'+member:None}}
  return plan,raw,approval,state
 def test_original_ceremony_requires_proven_epoch_absence(self):
  for missing in (True,False):
   _,raw,a,s=self.fixture()
   if missing:del s['records']['guardian_epoch_current']
   else:s['records']['guardian_epoch_current']='00000000000000000042'
   with self.assertRaises(ValueError):m.validate(raw,a,s,now=1000)
 def test_approved_complete_batch(self):
  p,raw,a,s=self.fixture(); self.assertEqual(len(m.validate(raw,a,s,now=1000)),5)
 def test_opaque_legacy_numeric_bytes_are_preserved(self):
  p,_,a,s=self.fixture();row=p['commands'][2]['payload']['records'][0]
  row['value']='{"probability":0.25,"large_original":9007199254740992}'
  root=m.record_root(row,0,1)
  for c in p['commands'][:2]:c['payload']['records_root']=root
  raw=json.dumps(p).encode();a.update(records_root=root,plan_sha256=hashlib.sha256(raw).hexdigest())
  self.assertEqual(m.validate(raw,a,s,now=1000)[2]['payload']['records'][0]['value'],row['value'])
 def test_approval_exact_bytes_not_reformatted_plan(self):
  p,raw,a,s=self.fixture()
  with self.assertRaises(ValueError):m.validate(json.dumps(p,indent=2).encode(),a,s,now=1000)
 def continuation(self,phase):
  p,_,a,s=self.fixture();adopted=copy.deepcopy(p['commands'][0]['payload']);adopted['prior_legacy_digest']='d'*64
  s['records']['legacy_adoption']=adopted
  cut=1
  if phase in ('pages','finish','claims'):
   cut=2 if phase=='pages' else 3 if phase=='finish' else 4
   s['records']['legacy_import']={'manifest_digest':a['source_manifest_digest'],'records_root':a['records_root'],'total_records':'1','accounts':'1','imported':'0' if phase=='pages' else '1','claimed_accounts':'0','status':'reconciling_accounts' if phase=='claims' else 'importing'}
  p['commands']=p['commands'][cut:]
  s['event_count']=str(cut);s['member']['sequence']=str(cut);s['records']['event/'+str(cut).zfill(20)]={'command_digest':'f'*64}
  a.update(starting_sequence=str(cut),expected_event_count=str(cut),expected_last_command_digest='f'*64)
  return p,a,s
 def test_interrupted_migration_exact_suffix_can_be_approved(self):
  for phase in ('begin','pages','finish','claims'):
   p,a,s=self.continuation(phase);raw=json.dumps(p).encode();a['plan_sha256']=hashlib.sha256(raw).hexdigest()
   with self.subTest(phase=phase):self.assertEqual(m.validate(raw,a,s,now=1000),p['commands'])
 def test_resume_cannot_change_lineage_cursor_claims_or_finalized_event(self):
  for mutate in (lambda x:x['records']['legacy_adoption'].update(records_root='a'*64),lambda x:x['records']['legacy_import'].update(imported='1'),lambda x:x['records'].update({'legacy_account_claimed/'+x['member']['id']:{'claimed':True}}),lambda x:x['records']['event/00000000000000000002'].update(command_digest='a'*64)):
   p,a,s=self.continuation('pages');mutate(s);raw=json.dumps(p).encode();a['plan_sha256']=hashlib.sha256(raw).hexdigest()
   with self.assertRaises(ValueError):m.validate(raw,a,s,now=1000)
 def test_changed_approval_context_and_expiry(self):
  _,raw,a,s=self.fixture()
  for changes in ({'genesis_sha256':'f'*64},{'epoch':'2'*32},{'source_manifest_digest':'d'*64},{'records_root':'d'*64},{'starting_sequence':'1'},{'expires_at':999},{'unexpected':True}):
   with self.subTest(changes=changes),self.assertRaises(ValueError):m.validate(raw,{**a,**changes},s,now=1000)
 def test_live_chain_key_sequence_guardian_and_import_drift(self):
  _,raw,a,s=self.fixture()
  mutations=[lambda x:x.update(chain_id='other'),lambda x:x.update(event_count='1'),lambda x:x['member'].update(sequence='1'),lambda x:x['member'].update(public_key='wrong'),lambda x:x['member'].update(licence='revoked'),lambda x:x['records'].update(guardians=[]),lambda x:x['records'].update(legacy_import={'status':'importing'}),lambda x:x.update(height='601')]
  for mutate in mutations:
   changed=copy.deepcopy(s);mutate(changed)
   with self.subTest(changed=changed),self.assertRaises(ValueError):m.validate(raw,a,changed,now=1000)
 def test_no_alternate_operation_member_instance_sequence_or_expiry(self):
  p,_,a,s=self.fixture()
  for field,value in [('operation','activate_coin'),('member','uain1'+'2'*40),('instance','stolen'),('sequence','12'),('expires_height','10000')]:
   changed=copy.deepcopy(p);changed['commands'][2][field]=value;raw=json.dumps(changed).encode();approved={**a,'plan_sha256':hashlib.sha256(raw).hexdigest()}
   with self.subTest(field=field),self.assertRaises(ValueError):m.validate(raw,approved,s,now=1000)
 def test_page_merkle_content_order_count_and_duplicate_claim(self):
  p,_,a,s=self.fixture()
  mutations=[lambda x:x['commands'][2]['payload'].update(start='1'),lambda x:x['commands'][2]['payload']['records'][0].update(value='tampered'),lambda x:x['commands'][2]['payload']['records'][0].update(proof=['a'*64]),lambda x:x['commands'].pop(3),lambda x:x['commands'].append(copy.deepcopy(x['commands'][-1]))]
  for mutate in mutations:
   changed=copy.deepcopy(p);mutate(changed);raw=json.dumps(changed).encode();approved={**a,'plan_sha256':hashlib.sha256(raw).hexdigest()}
   with self.assertRaises(ValueError):m.validate(raw,approved,s,now=1000)
 def test_duplicate_keys_and_unsafe_numbers_refused(self):
  for raw in [b'{"a":1,"a":2}',b'{"a":9007199254740992}',b'{"a":1.5}',b'{"a":"\\ud800"}']:
   with self.assertRaises(ValueError):m.strict_json(raw)
 def test_signing_bytes_match_node_canonicalization(self):
  # Exact reference output of chain/client/signing.mjs; escaped HTML, Unicode,
  # typed field order, nested-key order and decimal-string sequence are bound.
  command={'version':1,'chain_id':'fixture','member':'uain1'+'1'*40,'sequence':'0','expires_height':'42','operation':'legacy_finish','payload':{'z':'<&é>','a':[True,None,7]}}
  expected='uain:chain-command:v1\n{"version":1,"chain_id":"fixture","member":"uain1'+'1'*40+'","sequence":"0","expires_height":"42","operation":"legacy_finish","payload":{"a":[true,null,7],"z":"\\u003c\\u0026é\\u003e"}}'
  self.assertEqual(m.signing_bytes(command),expected.encode())
 def test_actual_node_signing_bytes_interoperate(self):
  command=self.fixture()[0]['commands'][2]
  module=Path(os.environ.get('UAIN_CUSTODY_SIGNING_MODULE',Path(__file__).resolve().parents[2]/'chain/client/signing.mjs'))
  result=subprocess.check_output(['node','--input-type=module','-e','const m=await import(process.argv[1]);process.stdout.write(m.signingBytes(JSON.parse(process.argv[2])));',module.as_uri(),json.dumps(command,ensure_ascii=False)])
  self.assertEqual(m.signing_bytes(command),result)
 @unittest.skipUnless(os.geteuid()==0,'custody requires root')
 def test_real_signatures_journal_and_private_key_never_exported(self):
  import base64,contextlib,io
  # Deliberately public deterministic fixture seed. Never a real identity.
  seed=bytes([17])*32;public,_=m.ed25519(seed)
  enc=lambda v:base64.urlsafe_b64encode(v).decode().rstrip('=')
  member='uain1'+hashlib.sha256(public).hexdigest()[:40]
  p,_,a,s=self.fixture();old=a['guardian']
  for c in p['commands']:
   c['member']=member
   if c['operation']=='legacy_claim_account':c['payload']['member']=member
  raw=json.dumps(p,ensure_ascii=False).encode();a.update(guardian=member,guardian_public_key=enc(public),plan_sha256=hashlib.sha256(raw).hexdigest(),expires_at=int(m.time.time())+3600)
  s['member'].update(id=member,public_key=enc(public));s['records']['guardians']=[member]
  del s['records']['legacy_account_claimed/'+old];s['records']['legacy_account_claimed/'+member]=None;a['claim_members']=[member]
  key={'public_key':enc(public),'private_key':enc(seed)};calls=[]
  custody=SimpleNamespace(vault=lambda:object(),attachment=lambda _,name:(calls.append(name) or json.dumps(key).encode()))
  with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR','/run')) as tmp:
   root=Path(tmp);directory=root/p['epoch'];directory.mkdir(mode=0o700)
   for name,value in [('approval.json',json.dumps(a).encode()),('plan.json',raw)]:
    (directory/name).write_bytes(value);(directory/name).chmod(0o600)
   with patch.object(m,'ROOT',root),patch.object(m,'GUARDIAN',member),patch.object(m,'live_state',lambda _:s),contextlib.redirect_stdout(io.StringIO()):
    m.sign_approved(custody,p['epoch'])
    with self.assertRaises(ValueError):m.sign_approved(custody,p['epoch'])
   result=json.loads((directory/'signed.json').read_bytes())
   self.assertEqual(calls,['keys/uain-review-key.json'])
   self.assertEqual(json.loads((directory/'journal.json').read_bytes())['status'],'signed')
   module=Path(os.environ.get('UAIN_CUSTODY_SIGNING_MODULE',Path(__file__).resolve().parents[2]/'chain/client/signing.mjs'))
   script="const {verify,createPublicKey}=await import('node:crypto');const {readFile}=await import('node:fs/promises');const m=await import(process.argv[1]);const p=JSON.parse(await readFile(process.argv[2]));for(const e of p.envelopes){const key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(e.public_key,'base64url')])});if(!verify(null,m.signingBytes(e.command),key,Buffer.from(e.signature,'base64url')))throw Error('invalid signature')}"
   subprocess.check_call(['node','--input-type=module','-e',script,module.as_uri(),str(directory/'signed.json')])
   for file in directory.iterdir():self.assertNotIn(enc(seed).encode(),file.read_bytes())
 @unittest.skipUnless(os.geteuid()==0,'custody requires root')
 def test_protected_file_refuses_permissions_symlinks_hardlinks(self):
  with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR','/run')) as tmp:
   p=Path(tmp)/'plan';p.write_bytes(b'public');p.chmod(0o600);self.assertEqual(m.protected_read(p),b'public')
   p.chmod(0o644)
   with self.assertRaises(ValueError):m.protected_read(p)
   p.chmod(0o600);link=Path(tmp)/'symlink';link.symlink_to(p)
   with self.assertRaises(ValueError):m.protected_read(link)
   hard=Path(tmp)/'hardlink';os.link(p,hard)
   with self.assertRaises(ValueError):m.protected_read(p)

 def test_t4_a_stale_identical_pending_file_is_adopted_and_a_different_one_refused(self):
  with tempfile.TemporaryDirectory() as directory:
   target=Path(directory)/'journal.json';pending=Path(directory)/'journal.json.pending';value={'status':'signed','n':1}
   raw=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
   pending.write_bytes(raw);pending.chmod(0o600);m.atomic(target,value)
   self.assertEqual(json.loads(target.read_text()),value);self.assertFalse(pending.exists())
   pending.write_bytes(raw);pending.chmod(0o600)
   with self.assertRaises(ValueError):m.atomic(target,{'status':'broadcast_started'})
   self.assertEqual(json.loads(target.read_text()),value);self.assertEqual(pending.read_bytes(),raw)
   pending.unlink();outside=Path(directory)/'outside';outside.write_bytes(raw);outside.chmod(0o600);pending.symlink_to(outside)
   with self.assertRaises(ValueError):m.atomic(target,value)
   pending.unlink();m.atomic(target,{'status':'next'});self.assertEqual(json.loads(target.read_text()),{'status':'next'})

if __name__=='__main__':unittest.main()
